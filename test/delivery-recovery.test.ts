import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
import {DeliveryRecovery,type DeliveryFacts} from '../src/delivery-recovery';
import {deliveryBranch,assertDeliveryTarget} from '../src/delivery-identity';
import {BranchUpdates} from '../src/branch-updates';
import {ReviewLoop} from '../src/review-loop';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(path=':memory:'){
 const s=new Store(path),w=new Workflow(s,{} as any),id=s.enqueue('project','issue','spec'),p=new Planning(s),r=p.reserve(id,'ao');
 p.gate(id,'ao','worker',r.branch,'/worktree');const hash=s.propose(id,'plan');
 s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);
 s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?,?,?,?)').run(id,r.spec_hash,'awaiting_approval','worker',null,'plan-message');
 w.approve(id,hash,'human',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
 new Lifecycle(s).adoptSupervised(id,{id:'worker',correlation:r.correlation,worktree:'/worktree',controller:'running'});
 const c={linear:{projectId:'project'},githubRepo:'owner/repo'};
 const facts:DeliveryFacts={session:'worker',project:'ao',reserved:r.branch,worktree:'/worktree',branch:'adlc/existing',head:'a'.repeat(40),anchor:'b'.repeat(40),clean:true,isolated:true,lineage:true,idle:true,completed:true,owners:[],candidates:[{repo:'owner/repo',pr:7,url:'https://github.com/owner/repo/pull/7',branch:'adlc/existing',head:'a'.repeat(40),baseBranch:'main',defaultBranch:'main',fork:false,state:'open',draft:false}]};
 let calls=0,attached=false,lost=false;
 const t={inspect:async()=>structuredClone(facts),claim:async()=>{calls++;attached=true;if(lost)throw Error('lost');},attached:async()=>attached};
 const recovery=new DeliveryRecovery(s,t);
 return {s,w,id,r,c,facts,t,recovery,calls:()=>calls,lose:()=>lost=true,detach:()=>attached=false};
}
test('preview is read only; exact adoption preserves reservation, budget, and poll identity',async()=>{
 const f=fixture();try{
 const before=f.s.db.query('SELECT * FROM planning_runs').all(),budget=f.s.get(f.id).attempts;
 const preview=await f.recovery.preview(f.id,f.c);expect(f.calls()).toBe(0);expect(f.s.db.query("SELECT name FROM sqlite_master WHERE name='delivery_adoptions'").get()).toBeNull();
 await f.recovery.confirm(f.id,f.c,preview.hash);await f.recovery.confirm(f.id,f.c,preview.hash);
 expect(f.calls()).toBe(1);expect(f.s.db.query('SELECT * FROM planning_runs').all()).toEqual(before);expect(f.s.get(f.id).attempts).toBe(budget);
 const session={id:'worker',branch:f.r.branch};expect(deliveryBranch(f.s,f.id,session,'owner/repo',7)).toBe(f.facts.branch);
 const snapshot={head:f.facts.head,base:f.facts.anchor,branch:f.facts.branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:true,behind:1};
 expect(()=>assertDeliveryTarget(f.s,f.id,session,'owner/repo',7,snapshot)).not.toThrow();
 let updates=0;const b=new BranchUpdates(f.s,{read:async()=>snapshot,update:async()=>{updates++;}});
 await b.ensure(f.id,'owner/repo',7,{session,transcript:{controller:'ready',turns:[]}},{enabled:true,authorizedBy:'human',maxUpdates:2});expect(updates).toBe(1);
 expect(()=>assertDeliveryTarget(f.s,f.id,session,'owner/repo',8,snapshot)).toThrow('mismatched');
 }finally{f.s.close();}
});
test('canonical worktree comparison accepts equivalent paths and persists the raw authorization',async()=>{
 const f=fixture();try{
  f.s.db.query("UPDATE planning_runs SET worktree='/worktree/' WHERE job=?").run(f.id);
  f.s.db.query("UPDATE runs SET worktree='/worktree/' WHERE job=?").run(f.id);
  const p=await f.recovery.preview(f.id,f.c);await f.recovery.confirm(f.id,f.c,p.hash);
  expect(f.s.db.query('SELECT worktree FROM delivery_adoptions WHERE job=?').get(f.id).worktree).toBe('/worktree/');
  expect(deliveryBranch(f.s,f.id,{id:'worker',branch:f.r.branch},'owner/repo',7)).toBe(f.facts.branch);
 }finally{f.s.close();}
});
for(const [name,change] of Object.entries({
 lineage:(f:DeliveryFacts)=>f.lineage=false,dirty:(f:DeliveryFacts)=>f.clean=false,shared:(f:DeliveryFacts)=>f.isolated=false,queued:(f:DeliveryFacts)=>f.idle=false,receipt:(f:DeliveryFacts)=>f.completed=false,
 owner:(f:DeliveryFacts)=>f.owners.push('other'),duplicate:(f:DeliveryFacts)=>f.candidates.push({...f.candidates[0]}),missing:(f:DeliveryFacts)=>f.candidates=[],
 fork:(f:DeliveryFacts)=>f.candidates[0].fork=true,similar:(f:DeliveryFacts)=>f.candidates[0].repo='owner/repo-evil',diverged:(f:DeliveryFacts)=>f.candidates[0].head='c'.repeat(40),default:(f:DeliveryFacts)=>f.candidates[0].defaultBranch=f.branch,
 session:(f:DeliveryFacts)=>f.session='imposter',branch:(f:DeliveryFacts)=>f.candidates[0].branch='similar',closed:(f:DeliveryFacts)=>f.candidates[0].state='closed'
}))test(`recovery fails closed: ${name}`,async()=>{const f=fixture();const expected:Record<string,string>={lineage:'Reserved branch lineage',dirty:'Clean registered isolated worktree',shared:'Clean registered isolated worktree',queued:'Idle controller',receipt:'Completed original implementation',owner:'Another active session',duplicate:'Exactly one unambiguous',missing:'Exactly one unambiguous',fork:'Existing PR repository',similar:'Existing PR repository',diverged:'Existing PR repository',default:'Existing PR repository',branch:'Existing PR repository',closed:'Existing PR repository',session:'identity mismatch'};try{change(f.facts);await expect(f.recovery.preview(f.id,f.c)).rejects.toThrow(expected[name]);expect(f.calls()).toBe(0);}finally{f.s.close();}});
test('changed confirmation proposal never claims',async()=>{const f=fixture();try{const p=await f.recovery.preview(f.id,f.c);f.facts.head=f.facts.candidates[0].head='c'.repeat(40);await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('changed');expect(f.calls()).toBe(0);}finally{f.s.close();}});
test('lost claim receipt reconciles attachment without another claim; concurrent confirms are bounded',async()=>{const f=fixture();try{f.lose();const p=await f.recovery.preview(f.id,f.c);await Promise.allSettled([f.recovery.confirm(f.id,f.c,p.hash),f.recovery.confirm(f.id,f.c,p.hash)]);await f.recovery.confirm(f.id,f.c,p.hash);expect(f.calls()).toBe(1);}finally{f.s.close();}});
test('uncertain unattached claim is durable and never replayed',async()=>{const f=fixture();try{f.t.claim=async()=>{throw Error('unknown');};const p=await f.recovery.preview(f.id,f.c);await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('uncertain');let calls=0;f.t.claim=async()=>{calls++;};await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('uncertain');expect(calls).toBe(0);}finally{f.s.close();}});
test('repeated confirmation preserves a later blocker and does not report handoff',async()=>{
 const f=fixture();try{
  const p=await f.recovery.preview(f.id,f.c);await f.recovery.confirm(f.id,f.c,p.hash);
  f.s.db.query("UPDATE implementation_dispatch SET state='blocked',reason='Later review blocker' WHERE job=?").run(f.id);
  await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('reconciliation required');
  expect(f.s.db.query('SELECT state,reason FROM implementation_dispatch WHERE job=?').get(f.id)).toEqual({state:'blocked',reason:'Later review blocker'});
 }finally{f.s.close();}
});
test('adoption clears a stale review branch-mismatch reason',async()=>{
 const f=fixture();try{
  new ReviewLoop(f.s);
  const reason='Blocked — branch mismatch: reserved old; actual new';
  f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since,state,reason) VALUES (?,?,?,?,?,?,?,?)').run(f.id,'owner/repo',7,'["CI"]','["src/**"]',Date.now(),'blocked',reason);
  const p=await f.recovery.preview(f.id,f.c);await f.recovery.confirm(f.id,f.c,p.hash);
  expect((f.s.db.query('SELECT reason FROM review_targets WHERE job=?').get(f.id) as any).reason).toBeNull();
 }finally{f.s.close();}
});
test('confirmation rejects a revoked feature PR grant before claiming',async()=>{
 const f=fixture();try{
  const p=await f.recovery.preview(f.id,f.c);
  f.s.db.query('UPDATE git_grants SET operations=? WHERE job=?').run(JSON.stringify(['inspect','fetch','worktree','branch','commit','open-pr']),f.id);
  await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('Current feature PR Git grant required');
  expect(f.calls()).toBe(0);
 }finally{f.s.close();}
});
test('confirmation rejects a standing approval changed after preview',async()=>{
 const f=fixture();try{
  const {ApprovalPolicyStore}=await import('../src/approval-policy');
  const policy=new ApprovalPolicyStore(f.s),approval={mode:'ready-queue' as const,id:'test',authorizedBy:'human',scope:['src/**'],gitScope:'feature-pr' as const},c={...f.c,approval};
  policy.snapshot('project',new Set(['issue']));
  const j=f.s.get(f.id);
  f.s.db.query('INSERT INTO policy_authorizations(job,plan_hash,spec_hash,policy_hash,policy_id,authorized_by,scope) VALUES (?,?,?,?,?,?,?)').run(f.id,j.plan_hash,digest(j.spec),policy.hash(approval),'test','human',JSON.stringify(['src/**']));
  const p=await f.recovery.preview(f.id,c);
  f.s.db.query("UPDATE policy_authorizations SET policy_hash='changed' WHERE job=?").run(f.id);
  await expect(f.recovery.confirm(f.id,c,p.hash)).rejects.toThrow('Fresh unchanged standing approval and scope required');
  expect(f.calls()).toBe(0);
 }finally{f.s.close();}
});
test('changed requirements and revoked approval cannot adopt',async()=>{const f=fixture();try{const p=await f.recovery.preview(f.id,f.c);f.s.enqueue('project','issue','changed');await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('approval');expect(f.calls()).toBe(0);}finally{f.s.close();}});
test('preview opens existing database read-only without schema writes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-preview-'));try{const path=join(dir,'state.sqlite'),f=fixture(path),p=await f.recovery.preview(f.id,f.c);f.s.close();const read=new Store(path,true);try{expect((await new DeliveryRecovery(read,f.t).preview(f.id,f.c)).hash).toBe(p.hash);expect(()=>read.db.exec('CREATE TABLE forbidden(x)')).toThrow();}finally{read.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});
test('unadopted unexpected branch fails the same identity gate independent of update policy',()=>{const f=fixture();try{expect(()=>assertDeliveryTarget(f.s,f.id,{id:'worker',branch:f.r.branch},'owner/repo',7,{state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',branch:f.facts.branch,baseBranch:'main',defaultBranch:'main'})).toThrow('Blocked — branch mismatch');}finally{f.s.close();}});

test('adoption survives process restart without another claim',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-adopt-'));try{
  const path=join(dir,'state.sqlite'),f=fixture(path),p=await f.recovery.preview(f.id,f.c);await f.recovery.confirm(f.id,f.c,p.hash);f.s.close();
  const s=new Store(path);try{await new DeliveryRecovery(s,f.t).confirm(f.id,f.c,p.hash);expect(f.calls()).toBe(1);expect(deliveryBranch(s,f.id,{id:'worker',branch:f.r.branch})).toBe(f.facts.branch);}finally{s.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('rejected pre-claim inspection leaves no reservation and allows a later confirmation',async()=>{
 const f=fixture();try{
  const p=await f.recovery.preview(f.id,f.c);let reads=0;
  f.t.inspect=async()=>{if(++reads===2)throw Error('collector unavailable');return structuredClone(f.facts);};
  await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('collector unavailable');
  expect(f.calls()).toBe(0);expect(f.s.db.query('SELECT * FROM delivery_adoptions WHERE job=?').get(f.id)).toBeNull();
  f.t.inspect=async()=>structuredClone(f.facts);
  const fresh=await f.recovery.preview(f.id,f.c);await f.recovery.confirm(f.id,f.c,fresh.hash);
  expect(f.calls()).toBe(1);expect(f.s.db.query('SELECT state FROM delivery_adoptions WHERE job=?').get(f.id).state).toBe('adopted');
 }finally{f.s.close();}
});
test('handoff is not reported without an adopted row',async()=>{
 const f=fixture();try{
  const p=await f.recovery.preview(f.id,f.c);
  f.t.attached=async()=>{f.s.db.query('DELETE FROM delivery_adoptions WHERE job=?').run(f.id);return true;};
  await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('Adoption not confirmed');
  expect(f.s.db.query('SELECT state FROM implementation_dispatch WHERE job=?').get(f.id).state).not.toBe('pr_handoff');
 }finally{f.s.close();}
});
test('confirmation binds approved path scope and reconciliation preserves adopted session',async()=>{
 const f=fixture();try{const p=await f.recovery.preview(f.id,f.c);f.s.db.query('UPDATE implementation_dispatch SET paths=? WHERE job=?').run('["other/**"]',f.id);await expect(f.recovery.confirm(f.id,f.c,p.hash)).rejects.toThrow('changed');expect(f.calls()).toBe(0);
 f.s.db.query('UPDATE implementation_dispatch SET paths=? WHERE job=?').run('["src/**"]',f.id);await f.recovery.confirm(f.id,f.c,p.hash);
 expect(()=>new Lifecycle(f.s).reconcile(f.id,[{id:'replacement',worktree:'/other',correlation:f.r.correlation,controller:'running'}],true)).toThrow('Adopted delivery');
 }finally{f.s.close();}
});

test('periodic workflow resumes adopted handoff without resending implementation',async()=>{
 const f=fixture();try{
  const preview=await f.recovery.preview(f.id,f.c);await f.recovery.confirm(f.id,f.c,preview.hash);
  const d=f.w.implementation(f.id);let sends=0;
  f.w.t={evidence:async()=>({session:{id:'worker',projectId:'ao',branch:f.r.branch,isTerminated:false,prs:[{state:'open',number:7,url:f.facts.candidates[0].url}]},transcript:{controller:'ready',entries:[{clientMessageId:d.client_id,turnId:'implementation'}],turns:[{id:'implementation',state:'completed'}]}}),worktree:async()=>({branch:f.facts.branch,head:f.facts.head}),branchSnapshot:async()=>({branch:f.facts.branch,head:f.facts.head,headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,baseBranch:'main',defaultBranch:'main'}),sendImplementation:async()=>{sends++;}} as any;
  const c={...f.c,repo:'/source',requiredChecks:['CI']};
  expect((await f.w.tick(c))[0].state).toBe('pr_handoff');expect((await f.w.tick(c))[0].pr.number).toBe(7);expect(sends).toBe(0);expect(f.calls()).toBe(1);
 }finally{f.s.close();}
});

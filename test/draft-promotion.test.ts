import {test,expect,setSystemTime} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
import {recordReadiness,recordResolution} from '../src/readiness';
import {AcceptanceEvidence,checkHash,promoteDraft,bindDraftConfig,assertDeliveryUnreserved,type DraftPolicy} from '../src/acceptance-evidence';
import {PreSendFailure} from '../src/pre-send';
import {DeliveryRecovery} from '../src/delivery-recovery';
import {jobBlockers} from '../src/operator-evidence';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

function fixture(pr=150,path=':memory:'){
 const s=new Store(path),w=new Workflow(s,{} as any),job=s.enqueue('project','DEV-76','spec'),p=new Planning(s),reserved=p.reserve(job,'ao');
 p.gate(job,'ao','worker',reserved.branch,'/worktree');
 const hash=s.propose(job,'plan');
 recordReadiness(s,job,'<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->',hash,digest('spec'));
 s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(job);
 s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?,?,?,?)').run(job,reserved.spec_hash,'awaiting_approval','worker',null,'plan-message');
 w.approve(job,hash,'human',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
 new Lifecycle(s).adoptSupervised(job,{id:'worker',correlation:reserved.correlation,worktree:'/worktree',controller:'running'});
 const d=w.implementation(job),head='c20a81c233ae3ea0b36f5ba6f4c77031d7cc2120',url=`https://github.com/owner/repo/pull/${pr}`;
 const b={head,branch:reserved.branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:true};
 const e:any={receiptObservation:{complete:true,observed:Date.now()},session:{id:'worker',projectId:'ao',branch:reserved.branch,isTerminated:false,activity:{state:'idle'},prs:[{number:pr,url,state:'open'}]},transcript:{controller:'ready',turns:[{id:'implementation',state:'completed'}],entries:[{clientMessageId:d.client_id,turnId:'implementation',sequence:1}]}};
 const receipt=(outcome='pr-handoff')=>{
  e.transcript.entries=e.transcript.entries.filter((x:any)=>x.role!=='assistant');
  e.transcript.entries.push({kind:'message',role:'assistant',origin:'provider',streaming:false,sequence:2,turnId:'implementation',text:`${url} ${b.head}\n<!-- ADLC_WORKER_STATUS ${JSON.stringify({version:1,outcome,reason:outcome==='needs-input'?'Clarify security policy':'handoff',questions:outcome==='needs-input'?[{id:'q1',kind:'security-scope',question:'Confirm existing policy interpretation'}]:[],dependencies:[]})} -->`});
 };receipt();
 const policy:DraftPolicy={enabled:true,repository:'owner/repo',operators:['human'],integrations:[],checks:[{id:'visual',kind:'responsive',definition:'responsive acceptance',viewports:['390','1440']},{id:'saved',kind:'live-content',definition:'live saved content',environment:'test',verifier:['/trusted/verifier']}]};
 const c={repo:'/source',linear:{projectId:'project'},githubRepo:'owner/repo',requiredChecks:['CI'],draftPromotion:policy};
 let promotions=0,sends=0,verify=true,lose=false;
 w.t={evidence:async()=>{e.receiptObservation.observed=Date.now();return structuredClone(e);},worktree:async()=>({tree:'/worktree',branch:b.branch,head:b.head}),branchSnapshot:async()=>({...b}),verifyDraftIdentity:async()=>{},verifyAcceptance:async()=>verify,promoteDraft:async()=>{promotions++;b.draft=false;if(lose)throw Error('lost response');},sendImplementation:async(_id:any,_text:any,_client:any,mode:any)=>{expect(mode).toBe('idle-only');sends++;}} as any;
 const status=()=>w.executionStatus(job,structuredClone(e),c);
 const record=async(id:string)=>{
  const facts=await w.draftFacts(job,c),check=policy.checks.find(x=>x.id===id)!;
  new AcceptanceEvidence(s).record(facts.binding,policy,{repository:'owner/repo',pr,head:b.head,check:id,definitionHash:checkHash(check),passed:true,issuer:'human',observed:Date.now(),reference:'evidence:current',...(id==='visual'?{viewports:['390','1440']}:{environment:'test',revision:'saved-v1'})},{kind:'operator',id:'human'});
 };
 return {s,w,job,d,b,e,c,policy,receipt,status,record,counts:()=>({promotions,sends}),live:(v:boolean)=>verify=v,lose:()=>lose=true};
}
test('matching draft PR150 is a durable artifact with exact blockers, not a repository/head mismatch',async()=>{
 const f=fixture();try{
  const result=await f.status();expect(result.state).toBe('draft_handoff');expect(result.reason).toContain('Draft PR delivery exists');expect(result.reason).toContain('Acceptance visual');expect(result.reason).not.toContain('mismatch');
  const draft=f.s.db.query('SELECT detail FROM draft_deliveries').get() as any;
  expect(JSON.parse(draft.detail)).toMatchObject({pr:150,head:f.b.head,session:'worker',worktree:'/worktree'});
  expect(jobBlockers(f.s,f.job).blockers.some(b=>b.code==='draft_delivery')).toBe(true);
  expect(f.counts()).toEqual({promotions:0,sends:0});
 }finally{f.s.close();}
});
test('unchanged draft polling keeps the operator/Linear blocker version stable',async()=>{
 const f=fixture(),now=Date.now();try{
  await f.status();const version=jobBlockers(f.s,f.job).version;
  setSystemTime(new Date(now+1000));await f.status();
  expect(jobBlockers(f.s,f.job).version).toBe(version);
 }finally{setSystemTime();f.s.close();}
});
for(const pr of [174,175])test(`draft ${pr} keeps visual and saved-content blockers independent even with passing CI`,async()=>{
 const f=fixture(pr);try{
  await f.status();await f.record(pr===175?'saved':'visual');
  const result=await f.status();expect(result.state).toBe('draft_handoff');expect(result.reason).toContain(pr===175?'Acceptance visual':'Acceptance saved');expect(f.counts().promotions).toBe(0);
  await f.record(pr===175?'visual':'saved');f.live(false);
  expect((await f.status()).reason).toContain('current live content revision cannot be verified');
  f.live(true);expect((await f.status()).state).toBe('pr_handoff');expect(f.counts().promotions).toBe(1);
  expect((await f.status()).state).toBe('pr_handoff');expect(f.counts().promotions).toBe(1);
 }finally{f.s.close();}
});
test('opt-in is separate from acceptance evidence; discovery and CI never imply permission',async()=>{
 const f=fixture();try{
  await f.record('visual');await f.record('saved');f.policy.enabled=false;
  expect((await f.status()).reason).toContain('disabled');expect(f.b.draft).toBe(true);
  delete (f.c as any).draftPromotion;expect((await f.status()).reason).toContain('disabled');expect(f.counts().promotions).toBe(0);
 }finally{f.s.close();}
});
test('resolved clarification continues the exact existing draft worker once, never replays implementation',async()=>{
 const f=fixture();try{
  f.receipt('needs-input');expect((await f.status()).state).toBe('needs_input');
  recordResolution(f.s,f.job,'human-answer','human','Confirmed unchanged policy; continue only existing scope');
  const results=await Promise.allSettled([f.w.resume(f.job,f.c),f.w.resume(f.job,f.c)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.counts()).toEqual({sends:1,promotions:0});
  expect(f.s.db.query('SELECT session_id FROM continuations').all()).toEqual([{session_id:'worker'}]);expect(f.b.draft).toBe(true);
 }finally{f.s.close();}
});
test('draft-only needs-reconciliation dispatch can continue after a current operator decision',async()=>{
 const f=fixture();try{
  await f.status();
  f.s.db.query("UPDATE implementation_dispatch SET state='needs_reconciliation' WHERE job=?").run(f.job);
  recordResolution(f.s,f.job,'human-answer','human','Resolve outstanding verification in current scope');
  expect((await f.w.resume(f.job,f.c)).state).toBe('continuation_delivery_accepted');expect(f.counts().sends).toBe(1);
 }finally{f.s.close();}
});
test('unknown worker and missing current decision cannot resume a draft',async()=>{
 const f=fixture();try{
  await f.status();await expect(f.w.resume(f.job,f.c)).rejects.toThrow('Current human answer');
  recordResolution(f.s,f.job,'human-answer','human','Continue');
  f.e.session.activity.state='unknown';
  await expect(f.w.resume(f.job,f.c)).rejects.toThrow('busy, unknown');expect(f.counts().sends).toBe(0);
 }finally{f.s.close();}
});
test('handoff must explicitly match current PR head; changed head invalidates acceptance',async()=>{
 const f=fixture();try{
  await f.record('visual');await f.record('saved');f.b.head='a'.repeat(40);
  expect((await f.status()).reason).toContain('exact current PR URL and head SHA');expect(f.counts().promotions).toBe(0);
  f.receipt();expect((await f.status()).reason).toContain('missing current-head');
 }finally{f.s.close();}
});
test('lost promotion reply reconciles actual ready state with one mutation',async()=>{
 const f=fixture();try{
  await f.record('visual');await f.record('saved');f.lose();
  expect((await f.status()).state).toBe('pr_handoff');expect(f.counts().promotions).toBe(1);
  expect((await f.status()).state).toBe('pr_handoff');expect(f.counts().promotions).toBe(1);
 }finally{f.s.close();}
});
test('after verified promotion, ordinary polling returns to normal review rather than expiring draft clearance',async()=>{
 const f=fixture();try{
  await f.record('visual');await f.record('saved');expect((await f.status()).state).toBe('pr_handoff');
  f.live(false);f.s.db.query('DELETE FROM acceptance_evidence').run();
  expect((await f.status()).state).toBe('pr_handoff');expect(f.counts().promotions).toBe(1);
  expect(jobBlockers(f.s,f.job).blockers.some(b=>b.code==='draft_delivery')).toBe(false);
 }finally{f.s.close();}
});
test('durable promotion reservation survives a closed/reopened database with no replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'draft-restart-')),path=join(dir,'state.sqlite'),f=fixture(150,path);
 let restarted:Store|undefined;
 try{
  const facts=await f.w.draftFacts(f.job,f.c);let mutations=0;
  await promoteDraft(f.s,f.policy,async()=>({...facts,blockers:[]}),async()=>{mutations++;throw Error('unknown');});
  f.s.close();restarted=new Store(path);
  const result=await promoteDraft(restarted,f.policy,async()=>({...facts,blockers:[]}),async()=>{mutations++;});
  expect(result.ready).toBe(false);expect(mutations).toBe(1);
  const current={...facts,binding:{...facts.binding,head:'a'.repeat(40)},draft:false,blockers:[]};
  expect((await promoteDraft(restarted,{...f.policy,maxAgeMs:10000},async()=>current,async()=>{mutations++;})).ready).toBe(true);
  expect(restarted.db.query('SELECT state FROM draft_promotions').get()).toEqual({state:'promoted'});
  expect(JSON.parse((restarted.db.query('SELECT detail FROM draft_promotions').get() as any).detail).head).toBe(facts.binding.head);
  expect(mutations).toBe(1);
 }finally{if(restarted)restarted.close();else f.s.close();rmSync(dir,{recursive:true,force:true});}
});
test('concurrent promotions and restarted evaluators never replay an uncertain mutation',async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c);let calls=0;
  const inspect=async()=>({...facts,blockers:[]});
  const send=async()=>{calls++;throw Error('unknown transport outcome');};
  await Promise.allSettled([promoteDraft(f.s,f.policy,inspect,send),promoteDraft(f.s,f.policy,inspect,send)]);
  expect(calls).toBe(1);
  expect((await promoteDraft(f.s,structuredClone(f.policy),inspect,send)).ready).toBe(false);expect(calls).toBe(1);
 }finally{f.s.close();}
});
test('uncertain promotion remains reserved across policy/head changes and explicit re-drafting',async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c);let calls=0;
  const send=async()=>{calls++;throw Error('lost');};
  await promoteDraft(f.s,f.policy,async()=>({...facts,blockers:[]}),send);
  const changed={...facts,binding:{...facts.binding,head:'a'.repeat(40)}};
  await promoteDraft(f.s,{...f.policy,maxAgeMs:10000},async()=>({...changed,blockers:[]}),send);
  expect(calls).toBe(1);
  await promoteDraft(f.s,f.policy,async()=>({...facts,draft:false,blockers:[]}),send);
  await promoteDraft(f.s,f.policy,async()=>({...facts,blockers:[]}),send);
  expect(calls).toBe(1);
 }finally{f.s.close();}
});
test('restarted promotion evaluator settles the durable reservation after authoritative ready observation',async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c);let calls=0;
  const send=async()=>{calls++;throw Error('unknown');};
  await promoteDraft(f.s,f.policy,async()=>({...facts,blockers:[]}),send);
  expect((await promoteDraft(f.s,f.policy,async()=>({...facts,draft:false,blockers:[]}),send)).ready).toBe(true);
  expect(f.s.db.query('SELECT state FROM draft_promotions').get()).toEqual({state:'promoted'});expect(calls).toBe(1);
 }finally{f.s.close();}
});
for(const change of ['policy','head'])test(`ready reconciliation settles the original reservation after ${change} changes`,async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c);let mutations=0;
  const send=async()=>{mutations++;throw Error('unknown after send');};
  await promoteDraft(f.s,f.policy,async()=>({...facts,blockers:[]}),send);
  const original=f.s.db.query('SELECT binding,detail FROM draft_promotions').get();
  const policy=change==='policy'?{...f.policy,maxAgeMs:10000}:f.policy;
  const current=change==='head'?{...facts,binding:{...facts.binding,head:'a'.repeat(40)}}:facts;
  expect((await promoteDraft(f.s,policy,async()=>({...current,draft:false,blockers:[]}),send)).ready).toBe(true);
  expect(f.s.db.query('SELECT binding,detail,state FROM draft_promotions').get()).toEqual({...original as any,state:'promoted'});
  expect(()=>assertDeliveryUnreserved(f.s,f.job,'continuation')).not.toThrow();
  expect(()=>assertDeliveryUnreserved(f.s,f.job,'adoption')).not.toThrow();
  await promoteDraft(f.s,policy,async()=>({...current,draft:false,blockers:[]}),send);
  expect(f.s.db.query("SELECT * FROM events WHERE kind='draft_promoted'").all()).toHaveLength(1);
  await promoteDraft(f.s,policy,async()=>({...current,draft:true,blockers:[]}),send);
  expect(mutations).toBe(1); // Re-drafting does not authorize another mutation.
 }finally{f.s.close();}
});
test('ready reconciliation cannot settle an uncertain reservation for another repository, PR or job',async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c),otherJob=f.s.enqueue('project','other-issue','spec');
  const attempts=[
   facts,
   {...facts,binding:{...facts.binding,pr:151}},
   {...facts,binding:{...facts.binding,repo:'other/repo'}},
   {...facts,binding:{...facts.binding,job:otherJob}},
  ];
  for(const attempt of attempts)await promoteDraft(f.s,f.policy,async()=>({...attempt,blockers:[]}),async()=>{throw Error('unknown');});
  await promoteDraft(f.s,{...f.policy,maxAgeMs:10000},async()=>({...facts,draft:false,blockers:[]}),async()=>{throw Error('must not resend');});
  const rows=f.s.db.query('SELECT job,state,detail FROM draft_promotions').all() as any[];
  expect(rows).toHaveLength(4);
  for(const row of rows){
   const b=JSON.parse(row.detail),match=row.job===f.job&&b.repo===facts.binding.repo&&b.pr===facts.binding.pr;
   expect(row.state).toBe(match?'promoted':'uncertain');
  }
 }finally{f.s.close();}
});
for(const failure of ['spawn','exit','json','node','head','revalidation'])test(`default promotion ${failure} failure before mutation releases only its own reservation and permits retry`,async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c);let fail=true,mutations=0;
  const spawn=((args:string[])=>{
   if(args.some(a=>a.includes('markPullRequestReadyForReview'))){
    mutations++;f.b.draft=false;
    return {stdout:new Response('{}').body,stderr:new Response('').body,exited:Promise.resolve(0)};
   }
   if(fail&&failure==='spawn')throw Error('lookup launch failed');
   const body=fail&&failure==='json'?'not json':JSON.stringify({data:{repository:{pullRequest:{id:fail&&failure==='node'?null:'PR_node',headRefOid:fail&&failure==='head'?'a'.repeat(40):facts.binding.head,isDraft:true}}}});
   return {stdout:new Response(body).body,stderr:new Response('').body,exited:Promise.resolve(fail&&failure==='exit'?1:0)};
  }) as typeof Bun.spawn;
  const inspect=async()=>({...facts,draft:f.b.draft,blockers:[]});
  const promote=(b:any)=>(f.w as any).promoteExistingDraft(b,async()=>{if(fail&&failure==='revalidation')throw Error('head/policy changed');},spawn);
  const blocked=await promoteDraft(f.s,f.policy,inspect,promote);
  expect(blocked.ready).toBe(false);expect(blocked.blockers[0]).toContain('was not sent; reservation released');
  expect(mutations).toBe(0);expect(f.s.db.query('SELECT * FROM draft_promotions').all()).toHaveLength(0);
  expect(()=>assertDeliveryUnreserved(f.s,f.job,'continuation')).not.toThrow();
  expect(()=>assertDeliveryUnreserved(f.s,f.job,'adoption')).not.toThrow();
  expect(f.s.db.query("SELECT * FROM events WHERE kind='draft_promotion_not_sent'").all()).toHaveLength(1);
  fail=false;
  expect((await promoteDraft(f.s,f.policy,inspect,promote)).ready).toBe(true);
  expect(mutations).toBe(1);expect(f.s.db.query('SELECT state FROM draft_promotions').get()).toEqual({state:'promoted'});
 }finally{f.s.close();}
});
test('default promotion error after mutation launch remains uncertain and never permits replay',async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c);let mutations=0;
  const spawn=((args:string[])=>{
   if(args.some(a=>a.includes('markPullRequestReadyForReview'))){
    mutations++;
    return {stdout:new Response('').body,stderr:new Response('').body,exited:Promise.reject(Error('lost mutation process outcome'))};
   }
   return {stdout:new Response(JSON.stringify({data:{repository:{pullRequest:{id:'PR_node',headRefOid:facts.binding.head,isDraft:true}}}})).body,stderr:new Response('').body,exited:Promise.resolve(0)};
  }) as typeof Bun.spawn;
  const inspect=async()=>({...facts,blockers:[]});
  const send=(b:any)=>(f.w as any).promoteExistingDraft(b,async()=>{},spawn);
  expect((await promoteDraft(f.s,f.policy,inspect,send)).ready).toBe(false);
  expect((await promoteDraft(f.s,f.policy,inspect,send)).ready).toBe(false);
  expect(mutations).toBe(1);expect(f.s.db.query('SELECT state FROM draft_promotions').get()).toEqual({state:'uncertain'});
  expect(()=>assertDeliveryUnreserved(f.s,f.job,'continuation')).toThrow('promotion reserved or uncertain');
 }finally{f.s.close();}
});
test('an untyped error claiming to be pre-mutation cannot release uncertainty',async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c);
  await promoteDraft(f.s,f.policy,async()=>({...facts,blockers:[]}),async()=>{throw Object.assign(Error('untrusted marker'),{preMutation:true});});
  expect(f.s.db.query('SELECT state FROM draft_promotions').get()).toEqual({state:'uncertain'});
 }finally{f.s.close();}
});
test('a typed pre-send failure releases only the reservation created by its invocation',async()=>{
 const f=fixture();try{
  const facts=await f.w.draftFacts(f.job,f.c),other={...facts,binding:{...facts.binding,pr:151}};
  await promoteDraft(f.s,f.policy,async()=>({...other,blockers:[]}),async()=>{throw Error('unknown other PR outcome');});
  await promoteDraft(f.s,f.policy,async()=>({...facts,blockers:[]}),async()=>{throw new PreSendFailure('not sent');});
  const rows=f.s.db.query('SELECT state,detail FROM draft_promotions').all() as any[];
  expect(rows).toHaveLength(1);expect(rows[0].state).toBe('uncertain');expect(JSON.parse(rows[0].detail).pr).toBe(151);
  const event=f.s.db.query("SELECT detail FROM events WHERE kind='draft_promotion_not_sent'").get() as any;
  expect(JSON.parse(event.detail).attempt.pr).toBe(150);
 }finally{f.s.close();}
});
for(const scenario of ['owner','head','provider','receipt','approval'])test(`draft effects fail closed on changed ${scenario}`,async()=>{
 const f=fixture();try{
  await f.record('visual');await f.record('saved');
  if(scenario==='owner')f.w.t.verifyDraftIdentity=async()=>{throw Error('Another active session owns the PR');};
  if(scenario==='head'){const original=f.w.t.verifyAcceptance!;f.w.t.verifyAcceptance=async(c,r)=>{f.b.head='a'.repeat(40);return original(c,r);};}
  if(scenario==='provider')f.w.t.branchSnapshot=async()=>{throw Error('GitHub unavailable');};
  if(scenario==='receipt')f.e.receiptObservation.complete=false;
  if(scenario==='approval')f.s.db.query("UPDATE jobs SET approved_hash=NULL WHERE id=?").run(f.job);
  expect((await f.status()).state).not.toBe('pr_handoff');expect(f.counts().promotions).toBe(0);
 }finally{f.s.close();}
});
test('uncertain continuation response is never resent',async()=>{
 const f=fixture();try{
  await f.status();recordResolution(f.s,f.job,'human-answer','human','Continue required verification');
  let sends=0;f.w.t.sendImplementation=async()=>{sends++;throw Error('uncertain');};
  expect((await f.w.resume(f.job,f.c)).state).toBe('continuation_delivery_uncertain');
  await expect(f.w.resume(f.job,f.c)).rejects.toThrow();
  expect(sends).toBe(1);expect(f.s.db.query('SELECT state FROM continuations').get()).toEqual({state:'delivery_uncertain'});
 }finally{f.s.close();}
});
test('trusted project configuration revoked during live verification cannot promote',async()=>{
 const f=fixture();try{
  await f.record('visual');await f.record('saved');
  let current=structuredClone(f.c);
  bindDraftConfig(f.c,()=>current);
  f.w.t.verifyAcceptance=async()=>{current={...current,draftPromotion:{...current.draftPromotion,enabled:false}};return true;};
  expect((await f.status()).state).not.toBe('pr_handoff');expect(f.counts().promotions).toBe(0);
 }finally{f.s.close();}
});
function recoveryFor(f:ReturnType<typeof fixture>,claim:()=>Promise<void>){
 const facts={session:'worker',project:'ao',reserved:f.b.branch,worktree:'/worktree',branch:f.b.branch,head:f.b.head,anchor:'a'.repeat(40),clean:true,isolated:true,lineage:true,idle:true,completed:true,owners:[],candidates:[{repo:'owner/repo',pr:150,url:f.e.session.prs[0].url,branch:f.b.branch,head:f.b.head,baseBranch:'main',defaultBranch:'main',fork:false,state:'open',draft:true}]};
 return new DeliveryRecovery(f.s,{inspect:async()=>structuredClone(facts),claim,attached:async()=>true});
}
test('in-flight adoption excludes a concurrent same-worker continuation reservation',async()=>{
 const f=fixture();let release=()=>{};try{
  await f.status();recordResolution(f.s,f.job,'human-answer','human','Continue verification');
  let signal=()=>{};const entered=new Promise<void>(resolve=>signal=resolve);
  const recovery=recoveryFor(f,async()=>{signal();await new Promise<void>(resolve=>release=resolve);});
  const p=await recovery.preview(f.job,f.c),confirmation=recovery.confirm(f.job,f.c,p.hash);
  await entered;
  await expect(f.w.resume(f.job,f.c)).rejects.toThrow('adoption already reserved');
  release();await confirmation;expect(f.counts().sends).toBe(0);
 }finally{release();f.s.close();}
});
test('in-flight continuation excludes a concurrent recovery reservation',async()=>{
 const f=fixture();let release=()=>{};try{
  await f.status();recordResolution(f.s,f.job,'human-answer','human','Continue verification');
  let signal=()=>{};const entered=new Promise<void>(resolve=>signal=resolve);
  f.w.t.sendImplementation=async()=>{signal();await new Promise<void>(resolve=>release=resolve);};
  const continuation=f.w.resume(f.job,f.c);await entered;
  let claims=0;const recovery=recoveryFor(f,async()=>{claims++;});
  const p=await recovery.preview(f.job,f.c);
  await expect(recovery.confirm(f.job,f.c,p.hash)).rejects.toThrow('Continuation already reserved');
  release();await continuation;expect(claims).toBe(0);
 }finally{release();f.s.close();}
});
test('draft adoption preserves original approval/reservation and does not declare review handoff',async()=>{
 const f=fixture();try{
  let attached=false,calls=0;
  const facts={session:'worker',project:'ao',reserved:f.b.branch,worktree:'/worktree',branch:f.b.branch,head:f.b.head,anchor:'a'.repeat(40),clean:true,isolated:true,lineage:true,idle:true,completed:true,owners:[],candidates:[{repo:'owner/repo',pr:150,url:f.e.session.prs[0].url,branch:f.b.branch,head:f.b.head,baseBranch:'main',defaultBranch:'main',fork:false,state:'open',draft:true}]};
  const recovery=new DeliveryRecovery(f.s,{inspect:async()=>structuredClone(facts),claim:async()=>{calls++;attached=true;},attached:async()=>attached});
  const preview=await recovery.preview(f.job,f.c);expect(preview.delivery).toBe('draft');
  expect((await recovery.confirm(f.job,f.c,preview.hash)).state).toBe('draft_handoff');
  expect((await recovery.confirm(f.job,f.c,preview.hash)).state).toBe('draft_handoff');
  expect(calls).toBe(1);expect(f.w.implementation(f.job).state).not.toBe('pr_handoff');
 }finally{f.s.close();}
});

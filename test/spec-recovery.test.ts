import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {SpecRecovery} from '../src/spec-recovery';
import {latestRevision,revisionSummary,revisedExecution,revisedHandoff} from '../src/spec-revisions';
import {featureGit,ApprovalPolicyStore} from '../src/approval-policy';
import {recordReadiness} from '../src/readiness';
import {LinearLifecycle} from '../src/linear-lifecycle';
import {createWorkflowTransport} from '../src/workflow-transport';
import {ReviewLoop} from '../src/review-loop';

const ready='<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->';
const config:any={repo:'/repo',githubRepo:'owner/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},automation:{planningEnabled:true,orchestratorProject:'project'},requiredChecks:['CI']};
async function fixture(){
 const s=new Store(':memory:'),job=s.enqueue('p','issue',JSON.stringify({identifier:'DEV-57',title:'Task',description:'Original'}));
 let e:any,sends:any[]=[];
 const transport:any={evidence:async()=>e,worktree:async()=>({branch:e.session.branch,head:'a'.repeat(40),tree:'/worktree'}),disableFeedback:async()=>{},branchSnapshot:async()=>({branch:e.session.branch,head:'a'.repeat(40),state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'}),sendImplementation:async(session:string,text:string,clientId:string)=>{sends.push({session,text,clientId});e.transcript.entries.push({clientMessageId:clientId,turnId:clientId,sequence:e.transcript.entries.length+1});e.transcript.turns.push({id:clientId,state:'running'});e.transcript.controller='busy';}};
 const w=new Workflow(s,transport),p=new Planning(s),r=p.reserve(job,'project');p.gate(job,'project','owner',r.branch,'/worktree');
 s.db.query("INSERT INTO planning_dispatch VALUES (?,?, 'awaiting_approval', 'owner',NULL,'initial')").run(job,digest(s.get(job).spec));
 const hash=s.propose(job,'Original plan\n'+ready);recordReadiness(s,job,s.get(job).plan,hash,digest(s.get(job).spec));s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(job);
 e={session:{id:'owner',projectId:'project',branch:r.branch,isTerminated:false,prs:[]},transcript:{controller:'ready',turns:[{id:'plan',state:'completed'}],entries:[]}};
 w.approve(job,hash,'human',['src/**'],'supervised-host',featureGit);await w.executeApproved(job,config);
 e.transcript.turns.at(-1).state='completed';e.transcript.controller='ready';
 const issue=async()=>({id:'issue',...JSON.parse(s.get(job).spec),project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}});
 const recovery=new SpecRecovery(s,w,issue as any,async f=>f());
 const edit=(text:string)=>s.enqueue('p','issue',JSON.stringify({identifier:'DEV-57',title:'Task',description:text}));
 const complete=()=>{const d=s.db.query('SELECT * FROM spec_replans ORDER BY rowid DESC LIMIT 1').get() as any;e.transcript.controller='ready';e.transcript.turns.at(-1).state='completed';e.transcript.entries.push({kind:'message',role:'assistant',origin:'provider',streaming:false,sequence:e.transcript.entries.length+1,turnId:d.client_id,text:`<!-- ADLC_REVISED_PLAN:${d.revision} -->\nNew plan\n${ready}`});};
 return {s,w,job,e,sends,edit,recovery,complete,hash};
}
test('spec summary never exposes arbitrary ticket text; exact byte edits fail closed',()=>{
 expect(revisionSummary('{"description":"secret old"}','{"description":"secret new"}')).toBe('description changed (10 → 10 characters; content redacted)');
 expect(revisionSummary('secret','other secret')).not.toContain('other secret');
});
test('active edit preserves owner/history, blocks dispatch and requires a fresh captured plan and approval',async()=>{
 const f=await fixture();try{
  const before=f.w.implementation(f.job),run=f.s.db.query('SELECT * FROM runs').get() as any;
  f.edit('Added requirement');const r=latestRevision(f.s,f.job);
  expect(r.old_plan_hash).toBe(f.hash);expect(r.old_approved_hash).toBe(f.hash);
  await expect(f.w.executeApproved(f.job,config)).rejects.toThrow('approval');
  expect(f.w.implementation(f.job)).toEqual(before);
  const preview=await f.recovery.preview(f.job,config);expect(preview.action).toBe('request_replanning');
  await f.recovery.reconcile(f.job,config,preview.confirmation);expect(f.sends).toHaveLength(2);
  f.complete();await f.recovery.capture(f.job,config);
  expect(f.s.get(f.job).state).toBe('awaiting_approval');
  expect(()=>f.w.approve(f.job,f.hash,'human',['src/**'],'supervised-host',featureGit)).toThrow('Stale plan or invalid state');
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  expect(f.w.implementation(f.job).session_id).toBe('owner');
  expect((f.s.db.query('SELECT * FROM runs').get() as any).correlation).toBe(run.correlation);
  expect(f.s.db.query('SELECT * FROM spec_execution_history').all()).toHaveLength(1);
  await f.w.executeApproved(f.job,config);expect(f.sends).toHaveLength(3);
 }finally{f.s.close();}
});
test('busy owner, repeated edits and stale preview never inject a competing turn',async()=>{
 const f=await fixture();try{
  f.edit('v2');const p=await f.recovery.preview(f.job,config);
  f.e.transcript.controller='busy';await expect(f.recovery.reconcile(f.job,config,p.confirmation)).rejects.toThrow('busy');
  f.e.transcript.controller='ready';f.edit('v3');await expect(f.recovery.reconcile(f.job,config,p.confirmation)).rejects.toThrow('Preview changed');
  expect(f.sends).toHaveLength(1);expect(f.s.db.query('SELECT * FROM spec_revisions').all()).toHaveLength(2);
 }finally{f.s.close();}
});
test('uncertain send and restart retain reservation; concurrent confirmation sends once',async()=>{
 const f=await fixture();try{
  f.edit('v2');const p=await f.recovery.preview(f.job,config);
  const send=f.w.t.sendImplementation;f.w.t.sendImplementation=async(...args)=>{await send(...args);throw Error('lost response');};
  const results=await Promise.allSettled([f.recovery.reconcile(f.job,config,p.confirmation),f.recovery.reconcile(f.job,config,p.confirmation)]);
  expect(f.sends).toHaveLength(2);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const restarted=new SpecRecovery(f.s,new Workflow(f.s,f.w.t),f.recovery.issue,async f=>f());
  expect((await restarted.preview(f.job,config)).action).toBe('refresh_evidence');
  f.complete();await restarted.capture(f.job,config);expect(f.s.get(f.job).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
test('superseded reply is not captured; current standing policy renews only fresh readiness',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();f.edit('v3');
  expect((await f.recovery.capture(f.job,config)).state).toBe('pending');expect(f.s.get(f.job).plan).toBeNull();
  const policy:any={mode:'ready-queue',id:'standing',authorizedBy:'human',scope:['src/**'],gitScope:'feature-pr'},c={...config,approval:policy};
  await f.recovery.reconcile(f.job,c,(await f.recovery.preview(f.job,c)).confirmation);f.complete();await f.recovery.capture(f.job,c);
  const a=new ApprovalPolicyStore(f.s);expect(a.evaluate(f.job,'p',policy).allowed).toBe(false);
  a.snapshot('p',new Set(['issue']));const proof=a.evaluate(f.job,'p',policy);expect(proof.allowed).toBe(true);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,proof.actor!,proof.paths!,'supervised-host',featureGit,{project:'p',policy});
  expect(a.get(f.job).spec_hash).toBe(digest(f.s.get(f.job).spec));
 }finally{f.s.close();}
});
test('existing PR is preserved and provider mismatch blocks without discarding dependency evidence',async()=>{
 const f=await fixture();try{
  f.e.session.prs=[{number:7,url:'https://github.com/owner/repo/pull/7',state:'open'}];
  f.w.t.branchSnapshot=async()=>({branch:f.e.session.branch,head:'a'.repeat(40),state:'open',headRepo:'owner/repo',baseRepo:'owner/repo'});
  f.s.db.exec('CREATE TABLE dependency_waits(job TEXT,reason TEXT)');f.s.db.query('INSERT INTO dependency_waits VALUES (?,?)').run(f.job,'Waiting for DEV-55');
  f.edit('New CLI requirement');const p=await f.recovery.preview(f.job,config);expect(p.proof?.prs[0].number).toBe(7);
  f.w.t.branchSnapshot=async()=>{throw Error('Provider unavailable');};
  await expect(f.recovery.reconcile(f.job,config,p.confirmation)).rejects.toThrow('Provider unavailable');
  expect((f.s.db.query('SELECT reason FROM dependency_waits').get() as any).reason).toBe('Waiting for DEV-55');expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('revision notices deduplicate lost replies without replay and redact contents',async()=>{
 const f=await fixture();try{
  f.edit('secret-token-123');let creates=0;const comments:any[]=[];
  const api:any=async(q:string,v:any)=>{
   if(q.includes('commentCreate')){creates++;comments.push({...v.input,createdAt:new Date().toISOString()});throw Error('lost response');}
   if(q.includes('comments('))return {issue:{id:'issue',comments:{nodes:comments,pageInfo:{hasNextPage:false}}}};
   return {issue:await f.recovery.issue('issue')};
  };
  const linear=new LinearLifecycle(f.s,api),c:any={linear:config.linear};
  expect((await linear.revisionNotices(c))[0].state).toBe('requirements_notice_blocked');
  expect((await new LinearLifecycle(f.s,api).revisionNotices(c))[0].state).toBe('requirements_notice_posted');
  await linear.revisionNotices(c);expect(creates).toBe(1);expect(comments[0].body).not.toContain('secret-token-123');
  expect(comments[0].body).toContain('spec-reconcile');expect(comments[0].body).toContain('owner');
 }finally{f.s.close();}
});
test('missing uncertain delivery receipt cannot be cleared by an existing PR or idle worker',async()=>{
 const f=await fixture();try{
  f.edit('v2');f.e.transcript.entries=[];f.e.session.prs=[{number:7,url:'https://github.com/owner/repo/pull/7',state:'open'}];
  await expect(f.recovery.preview(f.job,config)).rejects.toThrow('Prior delivery');expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('unsupported plan scope stays blocked and retains the previous grant',async()=>{
 const f=await fixture();try{
  f.edit('Need a security decision');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  f.e.transcript.entries.at(-1).text=f.e.transcript.entries.at(-1).text.replace(ready,'<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"needs-input","questions":[{"id":"scope","question":"May this extend the approved scope?","kind":"security-scope"}],"dependencies":[],"risks":[]} -->');
  await f.recovery.capture(f.job,config);const hash=f.s.get(f.job).plan_hash;
  expect(()=>f.w.approve(f.job,hash,'human',['src/**'],'supervised-host',featureGit)).toThrow('Plan has unresolved questions or dependencies');
  expect((f.s.db.query('SELECT plan_hash FROM git_grants').get() as any).plan_hash).toBe(f.hash);
  expect(f.s.get(f.job).approved_hash).toBeNull();
 }finally{f.s.close();}
});
test('revision planning transport never steers a competing turn',async()=>{
 const calls:string[][]=[];
 const spawn:any=(args:string[])=>{calls.push(args);return {stdout:new Blob(['']).stream(),stderr:new Blob(['']).stream(),exited:Promise.resolve(0)};};
 const t=createWorkflowTransport(async f=>f(),spawn);
 await t.sendImplementation('owner','plan only','revision','idle-only');
 expect(calls[0]).not.toContain('--steer');expect(calls[0]).toContain('--client-message-id');
 await t.sendImplementation('owner','implement','default');
 expect(calls[1]).toContain('--steer');
});
test('explicit confirmed revision can replan a previously finished planning owner',async()=>{
 const f=await fixture();try{
  f.edit('v2');f.s.db.query("UPDATE planning_dispatch SET state='planning_finished' WHERE job=?").run(f.job);
  expect((await f.w.reconcilePlanning(f.job,config)).state).toBe('planning_finished');
  await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  expect((await f.w.reconcilePlanning(f.job,config)).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
test('an edit before planning starts is intake, not a blocking requirement revision',()=>{
 const s=new Store(':memory:');try{
  const job=s.enqueue('p','early',JSON.stringify({identifier:'DEV-1',title:'T',description:'one'}));
  s.enqueue('p','early',JSON.stringify({identifier:'DEV-1',title:'T',description:'two'}));
  const r=latestRevision(s,job);
  expect(r.state).toBe('preplanning');expect(s.get(job).state).toBe('awaiting_plan');
  expect(r.new_hash).toBe(digest(s.get(job).spec));
 }finally{s.close();}
});
test('terminal failed replan is reconciled by exact receipt, then a fresh confirmed attempt replaces it',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);
  f.e.transcript.controller='ready';f.e.transcript.turns.at(-1).state='failed';
  expect(await f.recovery.capture(f.job,config)).toMatchObject({state:'replan_failed'});
  const failed=await f.recovery.preview(f.job,config);expect(failed.action).toBe('reconcile_failed_replan');
  await expect(f.recovery.reconcile(f.job,config,'0'.repeat(64))).rejects.toThrow('Failed-turn evidence changed');
  expect(await f.recovery.reconcile(f.job,config,failed.confirmation)).toMatchObject({action:'replan_failed_reconciled',state:'failed'});
  const fresh=await f.recovery.preview(f.job,config);expect(fresh.action).toBe('request_replanning');
  await f.recovery.reconcile(f.job,config,fresh.confirmation);
  expect(f.sends).toHaveLength(3);expect(new Set(f.sends.map(x=>x.clientId)).size).toBe(3);
  f.complete();await f.recovery.capture(f.job,config);expect(f.s.get(f.job).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
test('capture refuses a plan when approval policy or scope changed after the reservation',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  await expect(f.recovery.capture(f.job,{...config,approval:{mode:'manual'}} as any)).rejects.toThrow('Replan policy/routing/scope changed');
  expect(f.s.get(f.job).plan).toBeNull();
 }finally{f.s.close();}
});
test('prior PR stays historical until the revised handoff, then review reconciliation is reachable',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  expect(revisedExecution(f.s,f.job)).toBe(true);expect(revisedHandoff(f.s,f.job)).toBe(false);
  new ReviewLoop(f.s).register(f.job,'owner/repo',1,['CI'],['src/**']);
  const gated=await new ReviewLoop(f.s,undefined,{sessionEvidence:async()=>{throw Error('unused');}}).tick(f.job,undefined,undefined,{project:'p',checks:[]},config);
  expect(gated?.state).toBe('waiting_for_revised_handoff');
  await f.w.executeApproved(f.job,config);
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];
  await f.w.tick(config);
  expect(revisedHandoff(f.s,f.job)).toBe(true);
  const head='a'.repeat(40),evidence={head,observedHead:head,required:['CI'],checks:[],review:null,unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true,descriptionHash:'d',findings:[],failedChecks:[],pendingChecks:[],missingChecks:[],clear:false,reasons:[]};
  f.s.db.query("INSERT INTO remediation(job,head,findings_hash,attempt,state) VALUES (?,?,?,?,?)").run(f.job,head,'findings',1,'delivery_uncertain');
  const after=await new ReviewLoop(f.s,undefined,{sessionEvidence:async()=>({session:{id:'owner',projectId:'project',branch:f.e.session.branch,isTerminated:false,prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',turns:[],entries:[]}}),readBranchSnapshot:async()=>({branch:f.e.session.branch,head,state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'}),worktreeIdentity:async()=>({branch:f.e.session.branch,head}),readiness:async()=>evidence} as any).tick(f.job,undefined,undefined,{project:'p',checks:[]},config);
  expect(after?.state).toBe('needs_reconciliation');expect(after?.reason).toContain('remediation delivery is uncertain');
 }finally{f.s.close();}
});
test('revision notices are bounded per poll and advance past failures',async()=>{
 const s=new Store(':memory:');const ids:string[]=[];
 const c:any={linear:{projectId:'p',teamId:'t'}};let reads=0;
 const issueFor=(id:string)=>({id,identifier:'DEV-X',title:'T',description:'x',project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}});
 const api:any=async(q:string,v:any)=>{
  if(q.includes('commentCreate')){return {commentCreate:{success:true,comment:{id:v.input.id,body:v.input.body}}};}
  if(q.includes('comments('))return {issue:{id:v.id,comments:{nodes:[],pageInfo:{hasNextPage:false}}}};
  reads++;return {issue:issueFor(v.id)};
 };
 try{
  const spec=(n:number)=>JSON.stringify({identifier:`DEV-${n}`,title:'T',description:'one'});
  for(let i=0;i<6;i++){const id=s.enqueue('p',`issue-${i}`,spec(i));ids.push(id);s.enqueue('p',`issue-${i}`,spec(i).replace('one','two'));}
  const linear=new LinearLifecycle(s,api);
  expect((await linear.revisionNotices(c)).filter((x:any)=>x.state==='requirements_notice_posted')).toHaveLength(5);
  expect(reads).toBeLessThanOrEqual(5);
  expect((await linear.revisionNotices(c)).filter((x:any)=>x.state==='requirements_notice_posted')).toHaveLength(1);
  expect(s.db.query('SELECT count(*) AS n FROM spec_notices WHERE state=?').get('posted')).toMatchObject({n:6});
  await linear.revisionNotices(c);expect(reads).toBeLessThanOrEqual(6);
 }finally{s.close();}
});
test('a failed replan from an earlier revision is retired before the newer revision can proceed',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);
  f.e.transcript.controller='ready';f.e.transcript.turns.at(-1).state='cancelled';
  f.edit('v3');
  const prior=await f.recovery.preview(f.job,config);expect(prior.action).toBe('reconcile_failed_replan');
  expect((await f.recovery.reconcile(f.job,config,prior.confirmation)).state).toBe('failed');
  expect((await f.recovery.preview(f.job,config)).action).toBe('request_replanning');
  expect(f.sends).toHaveLength(2);
 }finally{f.s.close();}
});

import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store,digest} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {SpecRecovery} from '../src/spec-recovery';
import {latestRevision,revisionSummary,revisedExecution,revisedHandoff,handoffPr,recordHandoff} from '../src/spec-revisions';
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
 const transport:any={evidence:async()=>e,worktree:async()=>({branch:e.session.branch,head:'a'.repeat(40),tree:'/worktree'}),disableFeedback:async()=>{},branchSnapshot:async()=>({branch:e.session.branch,head:'a'.repeat(40),state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'}),sendImplementation:async(session:string,text:string,clientId:string,mode?:string)=>{sends.push({session,text,clientId,mode});e.transcript.entries.push({clientMessageId:clientId,turnId:clientId,sequence:e.transcript.entries.length+1});e.transcript.turns.push({id:clientId,state:'running'});e.transcript.controller='busy';}};
 const w=new Workflow(s,transport),p=new Planning(s),r=p.reserve(job,'project');p.gate(job,'project','owner',r.branch,'/worktree');
 s.db.query("INSERT INTO planning_dispatch VALUES (?,?, 'awaiting_approval', 'owner',NULL,'initial')").run(job,digest(s.get(job).spec));
 const hash=s.propose(job,'Original plan\n'+ready);recordReadiness(s,job,s.get(job).plan,hash,digest(s.get(job).spec));s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(job);
 e={session:{id:'owner',projectId:'project',branch:r.branch,isTerminated:false,prs:[]},receiptObservation:{complete:true,observed:Date.now()},transcript:{controller:'ready',turns:[{id:'plan',state:'completed'}],entries:[]}};
 w.approve(job,hash,'human',['src/**'],'supervised-host',featureGit);await w.executeApproved(job,config);
 e.transcript.turns.at(-1).state='completed';e.transcript.controller='ready';
 const issue=async()=>({id:'issue',...JSON.parse(s.get(job).spec),project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}});
 const recovery=new SpecRecovery(s,w,issue as any,async f=>f());
 const edit=(text:string)=>s.enqueue('p','issue',JSON.stringify({identifier:'DEV-57',title:'Task',description:text}));
 const complete=()=>{const d=s.db.query('SELECT * FROM spec_replans ORDER BY rowid DESC LIMIT 1').get() as any;e.transcript.controller='ready';e.transcript.turns.at(-1).state='completed';e.receiptObservation.observed=Date.now();e.transcript.entries.push({kind:'message',role:'assistant',origin:'provider',streaming:false,sequence:e.transcript.entries.length+1,turnId:d.client_id,text:`<!-- ADLC_REVISED_PLAN:${d.revision} -->\nNew plan\n${ready}`});};
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
  // A planning prompt must never steer the busy owner; implementation may steer.
  expect(f.sends[1].mode).toBe('idle-only');expect(f.sends[0].mode).toBeUndefined();
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
  expect((await f.recovery.capture(f.job,config)).state).toBe('requirements_changed');expect(f.s.get(f.job).plan).toBeNull();
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
test('review-status keeps the review state for a settled preplanning revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-preplanning-status-')),db=join(dir,'state.db');
 try{
  const s=new Store(db),job=s.enqueue('p','issue',JSON.stringify({identifier:'DEV-57',title:'Task',description:'Original'}));
  s.db.query('INSERT INTO spec_revisions(id,job,old_hash,new_hash,summary,state) VALUES (?,?,?,?,?,?)').run('preplanning-revision',job,'old','new','description changed (8 → 8 characters; content redacted)','preplanning');
  new ReviewLoop(s);
  s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head_since) VALUES (?,?,?,?,?,?,?)').run(job,'owner/repo',3,JSON.stringify(['CI']),JSON.stringify(['src/**']),0,Date.now());
  s.close();
  const env={ADLC_DB:db,HOME:dir,PATH:process.env.PATH??'/usr/bin:/bin'};
  const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'review-status'],{env});
  expect(result.exitCode).toBe(0);
  const row=JSON.parse(result.stdout.toString())[0];
  expect(row).toMatchObject({state:'waiting_for_review',displayStatus:'Waiting for CodeRabbit',reviewState:'waiting_for_review'});
  expect(row.revision).toMatchObject({state:'preplanning',blocking:false});
  // A blocking revision must still surface the changed requirements.
  const second=new Store(db);
  second.db.query("UPDATE spec_revisions SET state='pending' WHERE id=?").run('preplanning-revision');second.close();
  const changed=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'review-status'],{env});
  expect(changed.exitCode).toBe(0);
  const pending=JSON.parse(changed.stdout.toString())[0];
  expect(pending).toMatchObject({state:'requirements_changed',displayStatus:'Requirements changed — fresh plan/approval required',reviewState:'waiting_for_review'});
  expect(pending.revision).toMatchObject({state:'pending',blocking:true});
 }finally{rmSync(dir,{recursive:true,force:true});}
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
  f.e.transcript.controller='ready';f.e.transcript.turns.at(-1).state='interrupted';
  expect((await f.recovery.preview(f.job,config)).action).toBe('reconcile_failed_replan');
  const second=await f.recovery.preview(f.job,config);
  await f.recovery.reconcile(f.job,config,second.confirmation);
  const third=await f.recovery.preview(f.job,config);expect(third.action).toBe('request_replanning');
  await f.recovery.reconcile(f.job,config,third.confirmation);
  expect(f.sends).toHaveLength(4);expect(new Set(f.sends.map(x=>x.clientId)).size).toBe(4);
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
  const gatedLoop=new ReviewLoop(f.s,undefined,{sessionEvidence:async()=>{throw Error('unused');}});
  const gated=await gatedLoop.tick(f.job,undefined,undefined,{project:'p',checks:[]},config);
  expect(gated?.state).toBe('waiting_for_revised_handoff');
  expect(gatedLoop.get(f.job).state).toBe('waiting_for_revised_handoff');
  await f.w.executeApproved(f.job,config);
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];f.e.receiptObservation.observed=Date.now();
  await f.w.tick(config);
  expect(revisedHandoff(f.s,f.job)).toBe(true);
  const head='a'.repeat(40),evidence={head,observedHead:head,required:['CI'],checks:[],review:null,unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true,descriptionHash:'d',findings:[],failedChecks:[],pendingChecks:[],missingChecks:[],clear:false,reasons:[]};
  f.s.db.query("INSERT INTO remediation(job,head,findings_hash,attempt,state) VALUES (?,?,?,?,?)").run(f.job,head,'findings',1,'delivery_uncertain');
  const after=await new ReviewLoop(f.s,undefined,{sessionEvidence:async()=>({session:{id:'owner',projectId:'project',branch:f.e.session.branch,isTerminated:false,prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',turns:[],entries:[]}}),readBranchSnapshot:async()=>({branch:f.e.session.branch,head,state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'}),worktreeIdentity:async()=>({branch:f.e.session.branch,head}),readiness:async()=>evidence} as any).tick(f.job,undefined,undefined,{project:'p',checks:[]},config);
  expect(after?.state).toBe('needs_reconciliation');expect(after?.reason).toMatch(/remediation delivery is uncertain|dispatch binding/);
 }finally{f.s.close();}
});
for(const receipt of ['missing','running'])test(`an old-plan continuation cannot hand off a revised implementation with a ${receipt} receipt`,async()=>{
 const f=await fixture();try{
  f.s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,?)').run(f.job,f.hash,digest(f.s.get(f.job).spec),'old-resolution','old-continuation','owner','completed');
  f.e.transcript.entries.push({clientMessageId:'old-continuation',turnId:'old-continuation',sequence:f.e.transcript.entries.length+1});
  f.e.transcript.turns.push({id:'old-continuation',state:'completed'});
  f.e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];
  const historical=f.w.continuation(f.job);
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  await f.w.executeApproved(f.job,config);
  const dispatch=f.w.implementation(f.job),entry=f.e.transcript.entries.at(-1),turn=f.e.transcript.turns.at(-1);
  expect(dispatch.plan_hash).not.toBe(historical.plan_hash);
  expect(entry.clientMessageId).toBe(dispatch.client_id);
  if(receipt==='missing')f.e.transcript.entries.pop();
  f.e.receiptObservation.observed=Date.now();
  const pending=await f.w.executionStatus(f.job,f.e,config);
  expect(pending.state).toBe('implementation_running');
  expect(pending.delivery.client).toBe(dispatch.client_id);
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  expect(f.s.db.query('SELECT * FROM revision_handoffs WHERE job=?').all(f.job)).toHaveLength(0);
  const loop=new ReviewLoop(f.s);loop.register(f.job,'owner/repo',1,['CI'],['src/**']);
  expect((await loop.tick(f.job,undefined,undefined,{project:'p',checks:[]},config))?.state).toBe('waiting_for_revised_handoff');
  // Only completion of the revised dispatch can release the historical PR.
  if(receipt==='missing')f.e.transcript.entries.push(entry);
  turn.state='completed';f.e.transcript.controller='ready';f.e.receiptObservation.observed=Date.now();
  expect((await f.w.executionStatus(f.job,f.e,config)).state).toBe('pr_handoff');
  expect(revisedHandoff(f.s,f.job)).toBe(true);
  expect(f.w.continuation(f.job)).toEqual(historical);
 }finally{f.s.close();}
});
test('a handoff for the same plan hash from an earlier revision does not authorize the current one',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  const job=f.s.get(f.job),latest=latestRevision(f.s,f.job);
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  f.s.db.query('INSERT INTO revision_handoffs VALUES (?,?,?,?,?)').run(f.job,job.plan_hash,'earlier-authorization',1,Date.now());
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  f.s.db.query('INSERT INTO revision_handoffs VALUES (?,?,?,?,?)').run(f.job,job.plan_hash,latest.id,1,Date.now());
  expect(revisedHandoff(f.s,f.job)).toBe(true);
 }finally{f.s.close();}
});
test('recovered delivery records the single open PR as the current revision handoff',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  expect(handoffPr({source:'delivery-recovery',state:'pr_handoff'},[{number:7}])).toEqual({number:7});
  expect(handoffPr({state:'pr_handoff',pr:{number:3}},[{number:7}])).toEqual({number:3});
  expect(handoffPr({source:'delivery-recovery'},[{number:7},{number:8}])).toBeNull();
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  recordHandoff(f.s,f.job,f.s.get(f.job).plan_hash,handoffPr({source:'delivery-recovery',state:'pr_handoff'},[{number:7}]));
  expect(revisedHandoff(f.s,f.job)).toBe(true);
 }finally{f.s.close();}
});
test('revision notices are bounded per poll and advance past failures',async()=>{
 const s=new Store(':memory:');
 const c:any={linear:{projectId:'p',teamId:'t'}};let reads=0,failId:string|null='issue-1';
 const issueFor=(id:string)=>({id,identifier:'DEV-X',title:'T',description:'x',project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}});
 const api:any=async(q:string,v:any)=>{
  if(q.includes('commentCreate')){return {commentCreate:{success:true,comment:{id:v.input.id,body:v.input.body}}};}
  if(q.includes('comments('))return {issue:{id:v.id,comments:{nodes:[],pageInfo:{hasNextPage:false}}}};
  reads++;if(v.id===failId)throw Error('Linear timeout');return {issue:issueFor(v.id)};
 };
 try{
  const spec=(n:number)=>JSON.stringify({identifier:`DEV-${n}`,title:'T',description:'one'});
  for(let i=0;i<6;i++){s.enqueue('p',`issue-${i}`,spec(i));s.enqueue('p',`issue-${i}`,spec(i).replace('one','two'));}
  const linear=new LinearLifecycle(s,api);
  const first=await linear.revisionNotices(c);
  expect(first.filter((x:any)=>x.state==='requirements_notice_posted')).toHaveLength(4);
  expect(first.filter((x:any)=>x.state==='requirements_notice_blocked')).toHaveLength(1);
  expect(reads).toBe(5);
  const second=await linear.revisionNotices(c);
  expect(second.filter((x:any)=>x.state==='requirements_notice_posted')).toHaveLength(1);
  expect(second.some((x:any)=>x.state==='requirements_notice_blocked')).toBe(false);
  expect(reads).toBe(6);
  failId=null;
  const third=await linear.revisionNotices(c);
  expect(third.filter((x:any)=>x.state==='requirements_notice_blocked')).toHaveLength(0);
  expect(third.filter((x:any)=>x.state==='requirements_notice_posted')).toHaveLength(1);
  expect(reads).toBe(7);
  expect(s.db.query('SELECT count(*) AS n FROM spec_notices WHERE state=?').get('posted')).toMatchObject({n:6});
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

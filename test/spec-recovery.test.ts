import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync,symlinkSync,unlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
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
import {worktreeReservation} from '../src/worktree-reservation';
import {turnBarrier} from '../src/turn-submission';
import {RemediationReceipts,receiptStatus} from '../src/remediation-receipts';
import {ReceiptReconciliation} from '../src/receipt-reconciliation';
import {Lifecycle} from '../src/lifecycle';
import {jobViews,humanJobs} from '../src/operator-cli';
import {routingConfig,settings} from './routing-fixture';
import {RoutePreflightFailure} from '../src/routing-session';
import {StartupRecovery} from '../src/startup-recovery';

const ready='<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->';
const config:any={repo:'/repo',githubRepo:'owner/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},automation:{planningEnabled:true,orchestratorProject:'project'},requiredChecks:['CI']};
async function receiptFixture(legacy=false,changed=true,database=':memory:'){
 const f=await fixture(database),l=new Lifecycle(f.s),ledger=new ReceiptReconciliation(f.s);
 const attempt=l.reserveRemediation(f.job,'a'.repeat(40),'[]') as any;
 f.s.db.query("UPDATE remediation SET state='delivery_uncertain' WHERE job=?").run(f.job);
 const b={job:f.job,plan:f.hash,spec:digest(f.s.get(f.job).spec),session:'owner',client:`adlc-fix-${f.job.slice(0,12)}-${attempt.attempt}`,attempt:`remediation:${attempt.attempt}`};
 // Historical implementation has actually completed; its accepted ledger row
 // may not yet have been refreshed by a workflow poll.
 if(!legacy)ledger.reserve(b);
 f.e.transcript.entries.push({clientMessageId:b.client,turnId:'fix-turn',sequence:3,text:'not persisted: secret transcript'});
 f.e.transcript.turns.push({id:'fix-turn',state:'completed'});
 if(changed)f.edit('Revised requirements');
 const receipts=new RemediationReceipts(f.s,f.w,async operation=>operation());
 return {...f,b,ledger,receipts};
}
for(const legacy of [false,true])test(`DEV-69 ${legacy?'legacy':'reserved'} completed receipt reconciles changed requirements, preserves history and requires revised approval`,async()=>{
 const f=await receiptFixture(legacy);try{
  await expect(f.recovery.preview(f.job,config)).rejects.toThrow('Remediation delivery requires reconciliation');
  const before={job:f.s.get(f.job),run:f.s.db.query('SELECT * FROM runs').get(),dispatch:f.w.implementation(f.job),budget:f.s.db.query('SELECT * FROM remediation_budget').get(),events:f.s.db.query('SELECT * FROM events').all()};
  const preview=await f.receipts.preview(f.job,1,config);
  expect(preview).toMatchObject({action:'reconcile_completed_remediation',receipt:{state:'completed',turn:'fix-turn'},source:{historical:true}});
  expect(f.ledger.get(f.b.client)?.state??null).toBe(legacy?null:'reserved');
  await expect(f.receipts.reconcile(f.job,1,config,'0'.repeat(64))).rejects.toThrow('Preview changed');
  // A fresh inventory can confirm without persisting its transcript.
  expect(await f.receipts.reconcile(f.job,1,config,preview.confirmation!)).toMatchObject({state:'completed',binding:f.b});
  expect(f.sends).toHaveLength(1);expect(f.s.get(f.job)).toEqual(before.job);
  expect(f.s.db.query('SELECT * FROM runs').get()).toEqual(before.run);expect(f.w.implementation(f.job)).toEqual(before.dispatch);
  expect(f.s.db.query('SELECT * FROM remediation_budget').get()).toEqual(before.budget);
  expect(f.s.db.query('SELECT * FROM events ORDER BY seq LIMIT ?').all(before.events.length)).toEqual(before.events);
  const audit=f.s.db.query("SELECT detail FROM events WHERE kind='remediation_receipt_confirmed'").get() as any;
  expect(audit.detail).not.toContain('secret transcript');expect(JSON.parse(audit.detail)).toMatchObject({legacy,historical:true,binding:f.b});
  expect(f.ledger.get(f.b.client)).toMatchObject({...f.b,state:'completed',turn:'fix-turn'});
  await expect(f.receipts.reconcile(f.job,1,config,preview.confirmation!)).rejects.toThrow('exact uncertain remediation');
  expect(f.s.get(f.job).approved_hash).toBeNull();
  const revised=await f.recovery.preview(f.job,config);expect(revised.action).toBe('request_replanning');
  await f.recovery.reconcile(f.job,config,revised.confirmation);f.complete();await f.recovery.capture(f.job,config);
  expect(f.s.get(f.job)).toMatchObject({state:'awaiting_approval',approved_hash:null});
  expect(()=>f.w.approve(f.job,f.hash,'human',['src/**'],'supervised-host',featureGit)).toThrow();
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  expect(f.w.implementation(f.job).session_id).toBe('owner');expect(f.sends).toHaveLength(2);
 }finally{f.s.close();}
});
for(const invalid of ['missing','stale','incomplete','future','duplicate','session','project','branch','terminated','client','plan','spec','attempt','out-of-order','terminal','turn','active-turn','competing-attempt','competing-delivery','revision','history'])test(`DEV-84 receipt confirmation refuses ${invalid} with no reconciliation mutation`,async()=>{
 const f=await receiptFixture();try{
  const preview=await f.receipts.preview(f.job,1,config);
  if(invalid==='missing')f.e.transcript.entries.pop();
  if(invalid==='stale')f.e.receiptObservation.observed=Date.now()-120001;
  if(invalid==='incomplete')f.e.receiptObservation.complete=false;
  if(invalid==='future')f.e.receiptObservation.observed=Date.now()+10000;
  if(invalid==='duplicate')f.e.transcript.entries.push({...f.e.transcript.entries.at(-1)});
  if(invalid==='session')f.e.session.id='other';
  if(invalid==='project')f.e.session.projectId='other';
  if(invalid==='branch')f.e.session.branch='other';
  if(invalid==='terminated')f.e.session.isTerminated=true;
  if(['client','plan','spec','attempt'].includes(invalid))f.s.db.query(`UPDATE delivery_receipts SET ${invalid}='other' WHERE client=?`).run(f.b.client);
  if(invalid==='out-of-order')f.s.db.query('UPDATE delivery_receipts SET observed=? WHERE client=?').run(Date.now()+1,f.b.client);
  if(invalid==='terminal')f.s.db.query("UPDATE delivery_receipts SET state='failed' WHERE client=?").run(f.b.client);
  if(invalid==='turn')f.s.db.query("UPDATE delivery_receipts SET turn='different' WHERE client=?").run(f.b.client);
  if(invalid==='active-turn')f.e.transcript.turns.push({id:'competing',state:'queued'});
  if(invalid==='competing-attempt')f.s.db.query("INSERT INTO remediation VALUES (?, 'other', 'other', 2, 'reserved')").run(f.job);
  if(invalid==='competing-delivery')f.ledger.reserve({...f.b,client:'competing',attempt:'continuation:2'});
  if(invalid==='revision')f.edit('Changed after preview');
  if(invalid==='history')f.s.db.query("UPDATE spec_revisions SET old_hash='unproved' WHERE job=?").run(f.job);
  const snapshot=()=>({job:f.s.get(f.job),receipts:f.s.db.query('SELECT * FROM delivery_receipts').all(),remediation:f.s.db.query('SELECT * FROM remediation').all(),events:f.s.db.query('SELECT * FROM events').all()});
  const before=snapshot();await expect(f.receipts.reconcile(f.job,1,config,preview.confirmation!)).rejects.toThrow();expect(snapshot()).toEqual(before);expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('DEV-84 legacy binding without recorded invalidation fails closed; persisted status never creates a ledger',async()=>{
 const f=await receiptFixture(true);try{
  expect(receiptStatus(f.s,f.job)).toEqual(expect.arrayContaining([expect.objectContaining({client:f.b.client,legacy:true,code:'legacy_binding_required',ageMs:null,nextAction:`adlc receipt-reconcile ${f.job} CONFIG 1`})]));
  f.s.db.query('DELETE FROM spec_revision_evidence WHERE job=?').run(f.job);
  await expect(f.receipts.preview(f.job,1,config)).rejects.toThrow('historical dispatch provenance missing');
  expect(f.ledger.get(f.b.client)).toBeNull();
 }finally{f.s.close();}
});
for(const state of ['accepted','queued','running','failed','cancelled'])test(`DEV-84 operator ${state} receipt has no completion confirmation`,async()=>{
 const f=await receiptFixture(false,false);try{
  if(state==='accepted'){delete f.e.transcript.entries.at(-1).turnId;f.e.transcript.turns.pop();}
  else f.e.transcript.turns.at(-1).state=state;
  const preview=await f.receipts.preview(f.job,1,config);expect(preview.confirmation).toBeNull();expect(preview.receipt.state).toBe(state);
  await expect(f.receipts.reconcile(f.job,1,config,'0'.repeat(64))).rejects.toThrow('Preview changed');expect(f.ledger.get(f.b.client).state).toBe('reserved');expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('DEV-84 reopened read-only preview/status are byte-unchanged and concurrent confirmations settle once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-receipt-preview-')),path=join(dir,'state.db'),f=await receiptFixture(true,true,path);
 try{
  f.s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before=readFileSync(path),reader=Store.readonly(path);
  let preview;
  try{
   const recovery=new RemediationReceipts(reader,new Workflow(reader,f.w.t,undefined,true),async op=>op());
   preview=await recovery.preview(f.job,1,config);
   const jobs=jobViews(path);expect(jobs[0].receipts).toEqual(expect.arrayContaining([expect.objectContaining({legacy:true,persistedOnly:true})]));
   expect(humanJobs(jobs)).toContain(`adlc receipt-reconcile ${f.job} CONFIG 1`);expect(humanJobs(jobs)).toContain('age unknown');
  }finally{reader.close();}
  expect(readFileSync(path)).toEqual(before);expect(f.ledger.get(f.b.client)).toBeNull();
  const results=await Promise.allSettled([f.receipts.reconcile(f.job,1,config,preview!.confirmation!),f.receipts.reconcile(f.job,1,config,preview!.confirmation!)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(f.s.db.query("SELECT count(*) AS n FROM events WHERE kind='remediation_receipt_confirmed'").get()).toEqual({n:1});expect(f.sends).toHaveLength(1);
 }finally{f.s.close();rmSync(dir,{recursive:true,force:true});}
});
async function fixture(database=':memory:'){
 const s=new Store(database),job=s.enqueue('p','issue',JSON.stringify({identifier:'DEV-57',title:'Task',description:'Original'}));
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
test('DEV-67 unavailable pinned model on a revised plan retains dispatch and historical session/PR/delivery evidence',async()=>{
 const f=await fixture();try{
  new ReviewLoop(f.s).register(f.job,'owner/repo',17,['CI'],['src/**']);
  f.e.session.prs=[{number:17,state:'open',url:'https://github.com/owner/repo/pull/17'}];
  f.edit('Revised requirements');const preview=await f.recovery.preview(f.job,config);await f.recovery.reconcile(f.job,config,preview.confirmation);f.complete();await f.recovery.capture(f.job,config);
  const policy={...routingConfig,categories:routingConfig.categories.map(c=>c.id==='implement'?{...c,model:{providerID:'opencode-go',modelID:'deepseek-v4.1-flash'}}:c)};
  f.w.router.load=async()=>({config:policy,classify:async()=>({choice:'implement',confidence:1})});
  await f.w.router.choose(f.job,'planning',digest(f.s.get(f.job).spec),'plan',settings,'planning');
  await f.w.prepareImplementationRoute(f.job,{...config,routing:settings});
  const hash=f.s.get(f.job).plan_hash;expect(()=>f.w.router.approved(f.job,f.hash)).toThrow('current human approval');
  f.w.approve(f.job,hash,'human',['src/**'],'supervised-host',featureGit);
  const snapshot=()=>({dispatch:f.w.implementation(f.job),history:f.s.db.query('SELECT * FROM spec_execution_history').all(),pr:f.s.db.query('SELECT * FROM review_targets').all(),receipts:f.s.db.query('SELECT * FROM delivery_receipts').all(),planning:f.s.db.query('SELECT * FROM planning_runs').all()});
  const before=snapshot();let configured=0;
  f.w.t.configureRoute=async()=>{configured++;};f.w.t.preflightRoute=async route=>{expect(route.model).toBe('opencode-go/deepseek-v4.1-flash');throw new RoutePreflightFailure('unavailable');};
  expect(await f.w.executeApproved(f.job,config)).toMatchObject({state:'route_approval_required'});
  const after=snapshot();expect(after).toEqual({...before,dispatch:{...before.dispatch,reason:expect.stringContaining('scoped route approval in Linear')}});
  expect(configured).toBe(0);expect(f.sends).toHaveLength(2);
  const check=f.s.db.query('SELECT * FROM dispatch_route_checks').get() as any;expect(check.plan_hash).toBe(hash);expect(check.client_id).toBe(before.dispatch.client_id);expect(check.route).toContain('deepseek-v4.1-flash');
  // An uncertain dispatch is reconciliation-only, even if its route later fails.
  f.s.db.query("UPDATE implementation_dispatch SET state='delivery_uncertain' WHERE job=?").run(f.job);
  const checksBefore=f.s.db.query('SELECT * FROM dispatch_route_checks').all();let preflights=0;
  f.w.t.preflightRoute=async()=>{preflights++;};
  await f.w.executeApproved(f.job,config);expect(preflights).toBe(0);expect(f.sends).toHaveLength(2);expect(configured).toBe(0);
  expect(f.s.db.query('SELECT * FROM dispatch_route_checks').all()).toEqual(checksBefore);
 }finally{f.s.close();}
});
async function revisedFixture(){
 const f=await fixture();
 f.edit('DEV-51 revised runtime update history requirements');
 await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);
 f.complete();await f.recovery.capture(f.job,config);
 f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
 return f;
}
async function publishRevised(f:Awaited<ReturnType<typeof fixture>>,pr=17){
 await f.w.executeApproved(f.job,config);
 f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';
 f.e.session.prs=[{state:'open',number:pr,url:`https://github.com/owner/repo/pull/${pr}`}];
 f.e.receiptObservation.observed=Date.now();
 return f.w.executeApproved(f.job,config);
}
for(const historical of [false,true])test(`DEV-104 revised interrupted implementation reaches exact review handoff (historical continuation: ${historical})`,async()=>{
 const f=await fixture();try{
  if(historical){
   const old=f.w.implementation(f.job),insert=f.s.db.query("INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,'old','old-continuation','owner','completed')").run(f.job,old.plan_hash,digest(f.s.get(f.job).spec));
   const ledger=new ReceiptReconciliation(f.s);ledger.reserve({job:f.job,plan:old.plan_hash,spec:digest(f.s.get(f.job).spec),session:'owner',client:'old-continuation',attempt:`continuation:${insert.lastInsertRowid}`});
   f.e.transcript.entries.push({clientMessageId:'old-continuation',turnId:'old-continuation',sequence:f.e.transcript.entries.length+1});f.e.transcript.turns.push({id:'old-continuation',state:'completed'});
  }
  f.edit('Revised requirements with interrupted implementation');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  // A repeated spec/plan hash still cannot renew a row before the authorization
  // boundary; exercise this in addition to the different-plan history case.
  if(historical)f.s.db.query('UPDATE continuations SET plan_hash=?,spec_hash=? WHERE job=?').run(f.s.get(f.job).plan_hash,digest(f.s.get(f.job).spec),f.job);
  await f.w.executeApproved(f.job,config);
  const d=f.w.implementation(f.job),original=f.e.transcript.turns.at(-1);original.state='interrupted';f.e.transcript.controller='ready';f.e.session.kind='worker';f.e.session.activity={state:'idle'};
  const loop=new ReviewLoop(f.s),startup=new StartupRecovery(f.s,f.w,{inventory:async()=>[f.e.session],requirements:async()=>{},inspect:async()=>({tree:'/worktree',branch:f.e.session.branch,head:'a'.repeat(40),prs:f.e.session.prs}) as any,register:(job,result)=>loop.register(job,'owner/repo',result.pr.number,['CI'],['src/**'],true)});
  const resumed=await startup.pass(config,true);expect(resumed).toMatchObject({resumed:1,blocked:0});
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.session.prs=[{state:'open',number:17,url:'https://github.com/owner/repo/pull/17'}];
  const handed=await startup.pass(config,true);expect(handed).toMatchObject({reattached:1,blocked:0});expect(revisedHandoff(f.s,f.job)).toBe(true);expect(loop.list('p')).toHaveLength(1);
  const ledger=new ReceiptReconciliation(f.s);expect(ledger.get(d.client_id).state).toBe('cancelled');
  const cont=f.w.continuation(f.job);expect(ledger.get(cont.client_id).state).toBe('completed');
  expect(f.s.db.query('SELECT turn FROM revision_handoff_proofs WHERE job=?').get(f.job)).toEqual({turn:cont.client_id});
  const later=f.s.db.query("INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,'later-resolution','later-continuation','owner','completed')").run(f.job,d.plan_hash,digest(f.s.get(f.job).spec));
  ledger.reserve({job:f.job,plan:d.plan_hash,spec:digest(f.s.get(f.job).spec),session:'owner',client:'later-continuation',attempt:`continuation:${later.lastInsertRowid}`});
  f.e.transcript.entries.push({clientMessageId:'later-continuation',turnId:'later-continuation',sequence:f.e.transcript.entries.length+1});f.e.transcript.turns.push({id:'later-continuation',state:'completed'});
  expect(revisedHandoff(f.s,f.job)).toBe(true);expect((await f.w.executionStatus(f.job,f.e,config)).state).toBe('pr_handoff');
  // Current-dispatch proof cannot be borrowed by an unrelated dispatch, failed
  // continuation, changed binding, or a cancelled original without startup proof.
  f.s.db.query("UPDATE implementation_dispatch SET client_id='other' WHERE job=?").run(f.job);expect(revisedHandoff(f.s,f.job)).toBe(false);f.s.db.query('UPDATE implementation_dispatch SET client_id=? WHERE job=?').run(d.client_id,f.job);
  f.s.db.query("UPDATE delivery_receipts SET state='failed' WHERE client=?").run(cont.client_id);expect(revisedHandoff(f.s,f.job)).toBe(false);f.s.db.query("UPDATE delivery_receipts SET state='completed' WHERE client=?").run(cont.client_id);
  f.s.db.query("UPDATE continuations SET binding='unrelated' WHERE id=?").run(cont.id);expect(revisedHandoff(f.s,f.job)).toBe(false);f.s.db.query('UPDATE continuations SET binding=? WHERE id=?').run(cont.binding,cont.id);
  f.s.db.query('DELETE FROM startup_continuations WHERE job=?').run(f.job);expect(revisedHandoff(f.s,f.job)).toBe(false);
 }finally{f.s.close();}
});
test('DEV-64 / DEV-51 poll recovers an exact revised handoff without replay and retains published-head proof',async()=>{
 const f=await revisedFixture();try{
  const loop=new ReviewLoop(f.s);loop.register(f.job,'owner/repo',17,['CI'],['src/**']);
  await publishRevised(f);
  const count=f.sends.length;
  // Simulate a lost handoff projection, with the exact completed worker retained.
  f.s.db.query('DELETE FROM revision_handoffs WHERE job=?').run(f.job);
  f.s.db.query('DELETE FROM revision_handoff_proofs WHERE job=?').run(f.job);
  f.s.db.query("UPDATE implementation_dispatch SET state='delivery_uncertain' WHERE job=?").run(f.job);
  const recovered=await f.w.tick(config);
  expect(recovered).toContainEqual(expect.objectContaining({job:f.job,state:'pr_handoff'}));
  expect(revisedHandoff(f.s,f.job)).toBe(true);expect(f.sends.length).toBe(count);
  expect(f.s.db.query('SELECT * FROM revision_handoff_proofs WHERE job=?').get(f.job)).toMatchObject({dispatch:f.w.implementation(f.job).client_id,session:'owner',spec:digest(f.s.get(f.job).spec),repo:'owner/repo',pr:17,head:'a'.repeat(40)});
  await f.w.tick(config);expect(f.sends.length).toBe(count);
 }finally{f.s.close();}
});
for(const state of ['approved_pending','delivery_uncertain'])test(`DEV-64 missing revised receipt distinguishes ${state} without interpreting historical PR checks`,async()=>{
 const f=await revisedFixture();try{
  f.e.session.prs=[{state:'open',number:17,url:'https://github.com/owner/repo/pull/17'}];
  f.s.db.query('UPDATE implementation_dispatch SET state=? WHERE job=?').run(state,f.job);
  const count=f.sends.length;
  const status=await f.w.executionStatus(f.job,f.e,config);
  expect(status.state).toBe(state==='approved_pending'?'approved_pending':'needs_reconciliation');
  if(state!=='approved_pending'){await f.w.tick(config);expect(f.sends.length).toBe(count);}
  expect(revisedHandoff(f.s,f.job)).toBe(false);
 }finally{f.s.close();}
});
for(const fault of ['missing-ledger','pending-with-receipt','head','worker','stale','duplicate','active'])test(`DEV-64 revised handoff refuses ${fault} without replay`,async()=>{
 const f=await revisedFixture();try{
  await f.w.executeApproved(f.job,config);
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.receiptObservation.observed=Date.now();
  f.e.session.prs=[{state:'open',number:17,url:'https://github.com/owner/repo/pull/17'}];
  const d=f.w.implementation(f.job),count=f.sends.length;
  if(fault==='missing-ledger'||fault==='pending-with-receipt')f.s.db.query('DELETE FROM delivery_receipts WHERE client=?').run(d.client_id);
  if(fault==='pending-with-receipt')f.s.db.query("UPDATE implementation_dispatch SET state='approved_pending' WHERE job=?").run(f.job);
  if(fault==='head')f.w.t.worktree=async()=>({branch:f.e.session.branch,head:'b'.repeat(40)});
  if(fault==='worker')f.e.session.id='other';
  if(fault==='stale')f.e.receiptObservation.observed-=120001;
  if(fault==='duplicate')f.e.transcript.entries.push({...f.e.transcript.entries.at(-1)});
  if(fault==='active')f.e.transcript.turns.push({id:'other',state:'running'});
  await f.w.tick(config);
  expect(f.sends.length).toBe(count);expect(revisedHandoff(f.s,f.job)).toBe(false);
 }finally{f.s.close();}
});
test('DEV-64 recovered proof survives reopening but cannot authorize a replacement dispatch or contradictory receipt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-revised-proof-')),path=join(dir,'state.db'),f=await revisedFixture();
 try{
  await publishRevised(f);
  // Copy a consistent SQLite snapshot, then inspect it through a reopened Store.
  f.s.db.query('VACUUM INTO ?').run(path);
  const reopened=new Store(path);try{
   expect(revisedHandoff(reopened,f.job)).toBe(true);
   reopened.db.query("UPDATE implementation_dispatch SET client_id='replacement' WHERE job=?").run(f.job);
   expect(revisedHandoff(reopened,f.job)).toBe(false);
  }finally{reopened.close();}
  const dispatch=f.w.implementation(f.job);
  f.s.db.query("UPDATE delivery_receipts SET state='failed' WHERE client=?").run(dispatch.client_id);
  expect(revisedHandoff(f.s,f.job)).toBe(false);
 }finally{f.s.close();rmSync(dir,{recursive:true,force:true});}
});
for(const race of ['dispatch','revision','target','owner'])test(`DEV-64 ${race} change while awaiting published head discards handoff proof`,async()=>{
 const f=await revisedFixture();try{
  await f.w.executeApproved(f.job,config);
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.receiptObservation.observed=Date.now();
  f.e.session.prs=[{state:'open',number:17,url:'https://github.com/owner/repo/pull/17'}];
  const loop=new ReviewLoop(f.s);loop.register(f.job,'owner/repo',17,['CI'],['src/**']);
  const snapshot=f.w.t.branchSnapshot!.bind(f.w.t);
  f.w.t.branchSnapshot=async(...args:any[])=>{
   const result=await (snapshot as any)(...args);
   if(race==='dispatch')f.s.db.query("UPDATE implementation_dispatch SET client_id='replacement' WHERE job=?").run(f.job);
   if(race==='revision')f.edit('Changed while reading published head');
   if(race==='target')f.s.db.query('UPDATE review_targets SET pr=18 WHERE job=?').run(f.job);
   if(race==='owner')f.s.db.query("UPDATE planning_runs SET session_id='replacement' WHERE job=?").run(f.job);
   return result;
  };
  expect((await f.w.executionStatus(f.job,f.e,config)).state).not.toBe('pr_handoff');
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  expect(f.s.db.query('SELECT * FROM revision_handoff_proofs WHERE job=?').all(f.job)).toHaveLength(0);
 }finally{f.s.close();}
});
test('a late send acknowledgement cannot downgrade a captured revised plan',async()=>{
 const f=await fixture();let release!:()=>void;
 try{
  f.edit('v2');
  const send=f.w.t.sendImplementation.bind(f.w.t),gate=new Promise<void>(resolve=>release=resolve);
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  f.w.t.sendImplementation=async(...args:any[])=>{await (send as any)(...args);entered();await gate;};
  const preview=await f.recovery.preview(f.job,config);
  const pending=f.recovery.reconcile(f.job,config,preview.confirmation);
  await started;f.complete();
  expect(await f.recovery.capture(f.job,config)).toEqual({state:'awaiting_approval'});
  const captured=f.s.db.query('SELECT * FROM spec_replans').get() as any;
  expect(captured.state).toBe('captured');
  release();await pending;
  expect(f.s.db.query('SELECT * FROM spec_replans').get()).toEqual(captured);
  expect(f.s.get(f.job).state).toBe('awaiting_approval');
  expect(latestRevision(f.s,f.job).state).toBe('awaiting_approval');
  expect(JSON.parse(captured.proof).capturedPlanHash).toBe(f.s.get(f.job).plan_hash);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  expect(f.s.get(f.job).state).toBe('approved');
 }finally{release?.();f.s.close();}
});
test('default SpecRecovery submission binding refuses a held lock before reservation or send',()=>{
 const home=mkdtempSync(join(tmpdir(),'adlc-default-reconcile-'));
 try{
  const state=join(home,'Library','Application Support','ADLC Bridge');mkdirSync(state,{recursive:true});
  mkdirSync(join(state,'turn-submission.lock'));
  const script=`
   import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
   import {Workflow} from ${JSON.stringify(join(import.meta.dir,'../src/workflow.ts'))};
   import {SpecRecovery} from ${JSON.stringify(join(import.meta.dir,'../src/spec-recovery.ts'))};
   import {TurnSubmissionBlocked} from ${JSON.stringify(join(import.meta.dir,'../src/turn-submission.ts'))};
   const s=new Store(':memory:');let sends=0;
   const w=new Workflow(s,{sendImplementation:async()=>{sends++;}});
   const job=s.enqueue('p','issue','Original');
   const recovery=new SpecRecovery(s,w);
   let blocked=false;
   try{await recovery.reconcile(job,${JSON.stringify(config)},'confirmation');}
   catch(error){if(!(error instanceof TurnSubmissionBlocked))throw error;blocked=true;}
   console.log(JSON.stringify({blocked,sends,reservations:s.db.query('SELECT * FROM spec_replans').all().length}));
   s.close();
  `;
  const child=Bun.spawnSync([process.execPath,'--eval',script],{env:{...process.env,HOME:home}});
  expect(child.stderr.toString()).toBe('');expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual({blocked:true,sends:0,reservations:0});
 }finally{rmSync(home,{recursive:true,force:true});}
});
for(const discovery of ['one','zero','ambiguous','wrong-project','wrong-branch','terminated'])test(`pending revision owner discovery: ${discovery}`,async()=>{
 const f=await fixture();try{
  f.s.db.query("UPDATE planning_dispatch SET session_id=NULL,state='dispatch_uncertain' WHERE job=?").run(f.job);
  f.s.db.query('UPDATE planning_runs SET session_id=NULL WHERE job=?').run(f.job);
  f.edit('v2');expect(latestRevision(f.s,f.job).state).toBe('pending');
  let finds=0;const reservedBranch=new Planning(f.s).get(f.job).branch;
  f.w.t.findPlans=async(project,branch)=>{finds++;expect(project).toBe('project');expect(branch).toBe(reservedBranch);return discovery==='zero'?[]:discovery==='ambiguous'?[{id:'owner'},{id:'other'}]:[{id:'owner'}];};
  if(discovery==='wrong-project')f.e.session.projectId='other';
  if(discovery==='wrong-branch')f.e.session.branch='other';
  if(discovery==='terminated')f.e.session.isTerminated=true;
  const result=await f.w.reconcilePlanning(f.job,config);
  expect(finds).toBe(1);expect(f.sends).toHaveLength(1);
  expect(f.s.get(f.job).plan).toBeNull();expect(f.s.get(f.job).approved_hash).toBeNull();
  if(discovery==='one'){
   expect(result.state).toBe('requirements_changed');
   expect(f.w.planning(f.job).session_id).toBe('owner');
   expect(new Planning(f.s).get(f.job).session_id).toBe('owner');
   expect((await f.recovery.preview(f.job,config)).action).toBe('request_replanning');
  }else{
   expect(result.state).toBe('needs_reconciliation');
   expect(f.w.planning(f.job).session_id).toBeNull();
   expect(new Planning(f.s).get(f.job).session_id).toBeNull();
  }
 }finally{f.s.close();}
});
for(const remaining of ['none','latest','older'])test(`superseded completion releases planning only with no remaining replan: ${remaining}`,async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  const old=f.s.db.query('SELECT * FROM spec_replans').get() as any;
  if(remaining==='older'){
   f.edit('v3');
   const intermediate=latestRevision(f.s,f.job);
   f.s.db.query("INSERT INTO spec_replans VALUES (?,?,?,?,?,'delivery_uncertain',?,NULL)").run(intermediate.id,f.job,'unresolved-other','owner','other',old.proof);
  }
  f.edit('v4');const current=latestRevision(f.s,f.job);
  if(remaining==='latest')f.s.db.query("INSERT INTO spec_replans VALUES (?,?,?,?,?,'accepted',?,NULL)").run(current.id,f.job,'unresolved-latest','owner','latest',old.proof);
  await f.recovery.capture(f.job,config);
  expect(f.s.db.query('SELECT state FROM spec_replans WHERE revision=?').get(old.revision)).toEqual({state:'superseded_completed'});
  expect(f.w.planning(f.job).state).toBe(remaining==='none'?'planning_finished':'revision_pending');
  expect(f.s.get(f.job).state).toBe('awaiting_plan');expect(f.sends).toHaveLength(2);
  await f.recovery.capture(f.job,config);
  expect(f.s.db.query("SELECT count(*) AS n FROM events WHERE job=? AND kind='superseded_replan_completed'").get(f.job)).toEqual({n:1});
 }finally{f.s.close();}
});
test('superseded completion cannot retire a replaced client reservation',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  const old=latestRevision(f.s,f.job);f.edit('v3');
  const evidence=f.w.t.evidence;
  f.w.t.evidence=async session=>{
   f.s.db.query("UPDATE spec_replans SET client_id='replacement-client' WHERE revision=?").run(old.id);
   return evidence(session);
  };
  await f.recovery.capture(f.job,config);
  expect(f.s.db.query('SELECT state,client_id FROM spec_replans WHERE revision=?').get(old.id)).toEqual({state:'accepted',client_id:'replacement-client'});
  expect(f.w.planning(f.job).state).toBe('revision_pending');
  expect(f.s.db.query("SELECT count(*) AS n FROM events WHERE job=? AND kind='superseded_replan_completed'").get(f.job)).toEqual({n:0});
 }finally{f.s.close();}
});
test('spec summary never exposes arbitrary ticket text; exact byte edits fail closed',()=>{
 expect(revisionSummary('{"description":"secret old"}','{"description":"secret new"}')).toBe('description changed (10 → 10 characters; content redacted)');
 expect(revisionSummary('secret','other secret')).not.toContain('other secret');
});
for(const legacy of [false,true])test(`enqueue acquires its write lock before ${legacy?'legacy mismatch':'active revision'} reads`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-intake-lock-')),path=join(dir,'state.db');
 const s=new Store(path);let other:Store|undefined;
 try{
  const job=s.enqueue('p','issue','before'),planning=new Planning(s),run=planning.reserve(job,'project');
  planning.gate(job,'project','owner',run.branch,'/tree');
  if(legacy)s.db.query("UPDATE jobs SET spec='after' WHERE id=?").run(job);
  other=new Store(path);other.db.exec('PRAGMA busy_timeout=0');
  const query=s.db.query.bind(s.db);let inspected=false;
  (s.db as any).query=(sql:string,...args:any[])=>{
   if(!inspected&&sql==='SELECT * FROM jobs WHERE id=?'){
    inspected=true;
    expect(()=>other!.db.query("UPDATE jobs SET reason='competing writer' WHERE id=?").run(job)).toThrow(/locked|busy/i);
   }
   return query(sql,...args);
  };
  expect(s.enqueue('p','issue','after')).toBe(job);expect(inspected).toBe(true);
  expect(latestRevision(s,job).new_hash).toBe(digest('after'));
  expect(other.db.query("UPDATE jobs SET reason='writer after commit' WHERE id=?").run(job).changes).toBe(1);
 }finally{other?.close();s.close();rmSync(dir,{recursive:true,force:true});}
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
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.receiptObservation.observed=Date.now();
  await f.w.executionStatus(f.job,f.e,config);
  expect(f.w.outcomes(f.job)).toMatchObject({revision_id:r.id,dispatch_id:f.w.implementation(f.job).client_id});
 }finally{f.s.close();}
});
for(const binding of ['client','plan','revision','spec'])for(const outcome of ['handoff','failure'])test(`in-flight ${outcome} cannot overwrite a changed ${binding} binding`,async()=>{
 const f=await fixture();try{
  f.e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];
  const snapshot=f.w.t.branchSnapshot!;let expected:any;
  f.w.t.branchSnapshot=async(...args)=>{
   const result=await snapshot(...args);
   if(binding==='client')f.s.db.query("UPDATE implementation_dispatch SET client_id='new-dispatch',state='approved_pending' WHERE job=?").run(f.job);
   if(binding==='plan')f.s.db.query("UPDATE implementation_dispatch SET plan_hash='new-plan',state='approved_pending' WHERE job=?").run(f.job);
   if(binding==='revision')f.s.db.query('INSERT INTO spec_revisions(id,job,old_hash,new_hash,summary,state) VALUES (?,?,?,?,?,?)').run('new-revision',f.job,digest(f.s.get(f.job).spec),digest(f.s.get(f.job).spec),'New instance','pending');
   if(binding==='spec')f.edit('Changed during provider observation');
   expected={dispatch:f.w.implementation(f.job),outcomes:f.w.outcomes(f.job),handoffs:f.s.db.query('SELECT * FROM revision_handoffs').all()};
   if(outcome==='failure')throw Error('Provider failed after binding changed');
   return result;
  };
  const result=await f.w.executionStatus(f.job,f.e,config);
  expect(result).toMatchObject({state:'stale_execution',applied:false});
  expect(f.w.implementation(f.job)).toEqual(expected.dispatch);
  expect(f.w.outcomes(f.job)).toEqual(expected.outcomes);
  expect(f.s.db.query('SELECT * FROM revision_handoffs').all()).toEqual(expected.handoffs);
 }finally{f.s.close();}
});
test('status excludes superseded blockers but retains historical outcomes and independent dependency evidence',async()=>{
 const f=await fixture();try{
  await f.w.executionStatus(f.job,f.e,config);
  f.s.db.query("UPDATE worker_outcomes SET outcome='blocked_dependency',reason='Waiting for dependency' WHERE job=?").run(f.job);
  f.s.db.exec('CREATE TABLE dependency_waits(job TEXT,reason TEXT)');
  f.s.db.query('INSERT INTO dependency_waits VALUES (?,?)').run(f.job,'Independent dependency evidence');
  expect(f.w.status().blockers).toHaveLength(1);
  f.edit('New requirements');
  const status=f.w.status();expect(status.blockers).toHaveLength(0);
  expect(status.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({job:f.job,plan_hash:f.hash,outcome:'blocked_dependency'})]));
  expect(status.dependencies).toHaveLength(1);expect(status.requirementRevisions).toHaveLength(1);
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
test('a recovered continuation remains settled when previewing a later requirement revision',async()=>{
 const f=await fixture();try{
  f.s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,?)').run(f.job,f.hash,digest(f.s.get(f.job).spec),'settled','recovered-continuation','owner','recovered');
  f.e.transcript.entries.push({clientMessageId:'recovered-continuation',turnId:'recovered-turn',sequence:10});
  f.e.transcript.turns.push({id:'recovered-turn',state:'failed'});
  f.edit('Later requirements');
  expect((await f.recovery.preview(f.job,config)).action).toBe('request_replanning');
  // An uncertain continuation still needs its completed delivery receipt.
  f.s.db.query("UPDATE continuations SET state='delivery_uncertain' WHERE client_id='recovered-continuation'").run();
  await expect(f.recovery.preview(f.job,config)).rejects.toThrow('Prior delivery lacks a completed receipt');
 }finally{f.s.close();}
});
test('missing uncertain delivery receipt cannot be cleared by an existing PR or idle worker',async()=>{
 const f=await fixture();try{
  f.edit('v2');f.e.transcript.entries=[];f.e.session.prs=[{number:7,url:'https://github.com/owner/repo/pull/7',state:'open'}];
  await expect(f.recovery.preview(f.job,config)).rejects.toThrow('Prior delivery');expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('throwing replan send with no receipt needs confirmed fresh absence and never replays automatically',async()=>{
 const f=await fixture();try{
  f.edit('v2');const send=f.w.t.sendImplementation;let attempts=0;
  f.w.t.sendImplementation=async()=>{attempts++;throw Error('Send failed before receipt');};
  await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);
  const delivery=f.s.db.query('SELECT * FROM spec_replans').get() as any;
  expect((await f.recovery.capture(f.job,config)).state).toBe('delivery_uncertain');
  f.e.receiptObservation.observed=Date.now();
  const absent=await f.recovery.preview(f.job,config);expect(absent.action).toBe('reconcile_absent_replan');
  await expect(f.recovery.reconcile(f.job,config,'0'.repeat(64))).rejects.toThrow('Absence evidence changed');
  f.w.t.evidence=async()=>{f.e.receiptObservation.observed=Date.now();return f.e;};
  expect(await f.recovery.reconcile(f.job,config,absent.confirmation)).toMatchObject({action:'replan_absence_reconciled',state:'failed'});
  expect(attempts).toBe(1);expect(f.sends).toHaveLength(1);
  expect((await f.recovery.capture(f.job,config)).state).toBe('replan_failed');
  const event=f.s.db.query("SELECT detail FROM events WHERE kind='spec_replan_absence_reconciled'").get() as any;
  expect(JSON.parse(event.detail).delivery.client_id).toBe(delivery.client_id);
  // A separate explicit preview/confirmation, not retirement, authorizes a new ID.
  f.w.t.sendImplementation=send;
  const fresh=await f.recovery.preview(f.job,config);expect(fresh.action).toBe('request_replanning');
  await f.recovery.reconcile(f.job,config,fresh.confirmation);expect(f.sends).toHaveLength(2);
  expect(f.sends[1].clientId).not.toBe(delivery.client_id);
  f.complete();await f.recovery.capture(f.job,config);expect(f.s.get(f.job).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
for(const invalid of ['incomplete','stale','pre-send','future','busy','active-turn','owner','branch','terminated','project','non-idle','accepted-entry'])test(`uncertain replan absence cannot retire ${invalid} evidence`,async()=>{
 const f=await fixture();try{
  f.edit('v2');f.w.t.sendImplementation=async()=>{throw Error('No receipt');};
  await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);
  f.e.receiptObservation.observed=Date.now();
  const absent=await f.recovery.preview(f.job,config);expect(absent.action).toBe('reconcile_absent_replan');
  if(invalid==='incomplete')f.e.receiptObservation.complete=false;
  if(invalid==='stale')f.e.receiptObservation.observed=Date.now()-120001;
  if(invalid==='pre-send')f.e.receiptObservation.observed=JSON.parse((f.s.db.query('SELECT proof FROM spec_replans').get() as any).proof).attemptedAt-1;
  if(invalid==='future')f.e.receiptObservation.observed=Date.now()+10000;
  if(invalid==='busy')f.e.transcript.controller='busy';
  if(invalid==='active-turn')f.e.transcript.turns.push({id:'competing',state:'running'});
  if(invalid==='owner')f.e.session.id='different-owner';
  if(invalid==='branch')f.e.session.branch='different-branch';
  if(invalid==='terminated')f.e.session.isTerminated=true;
  if(invalid==='project')f.e.session.projectId='different-project';
  if(invalid==='non-idle')f.e.session.activity={state:'running'};
  if(invalid==='accepted-entry'){
   const d=f.s.db.query('SELECT * FROM spec_replans').get() as any;
   f.e.transcript.entries.push({clientMessageId:d.client_id});
  }
  expect((await f.recovery.preview(f.job,config)).action).toBe('refresh_evidence');
  await expect(f.recovery.reconcile(f.job,config,absent.confirmation)).rejects.toThrow('Preview changed or delivery already reserved');
  expect((f.s.db.query('SELECT state FROM spec_replans').get() as any).state).toBe('delivery_uncertain');
  expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('an earlier uncertain absent replan is explicitly retired before the newer revision proceeds',async()=>{
 const f=await fixture();try{
  f.edit('v2');const send=f.w.t.sendImplementation;f.w.t.sendImplementation=async()=>{throw Error('No receipt');};
  await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);
  f.e.receiptObservation.observed=Date.now();
  const old=await f.recovery.preview(f.job,config);expect(old.action).toBe('reconcile_absent_replan');
  f.edit('v3');
  await expect(f.recovery.reconcile(f.job,config,old.confirmation)).rejects.toThrow('Absence evidence changed');
  const prior=await f.recovery.preview(f.job,config);expect(prior.action).toBe('reconcile_absent_replan');expect(prior.revision).toBe(old.revision);
  expect(await f.recovery.reconcile(f.job,config,prior.confirmation)).toMatchObject({action:'replan_absence_reconciled',state:'failed'});
  expect(f.sends).toHaveLength(1);
  const fresh=await f.recovery.preview(f.job,config);expect(fresh.action).toBe('request_replanning');expect(fresh.revision).not.toBe(old.revision);
  f.w.t.sendImplementation=send;await f.recovery.reconcile(f.job,config,fresh.confirmation);
  expect(f.sends).toHaveLength(2);
  expect((f.s.db.query('SELECT state FROM spec_replans WHERE revision=?').get(old.revision) as any).state).toBe('failed');
  f.complete();await f.recovery.capture(f.job,config);expect(f.s.get(f.job).state).toBe('awaiting_approval');
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
 const calls:string[][]=[],requests:unknown[][]=[];
 const evidence={session:{id:'owner',activity:{state:'idle'}},transcript:{controller:'ready',entries:[],turns:[]}};
 const spawn:any=(args:string[])=>{calls.push(args);return {stdout:new Blob([JSON.stringify(evidence)]).stream(),stderr:new Blob(['']).stream(),exited:Promise.resolve(0)};};
 const t=createWorkflowTransport(async f=>f(),spawn,async (...args)=>{requests.push(args);});
 await t.sendImplementation('owner','plan only','revision','idle-only');
 expect(requests).toEqual([['sessions/owner/conversation/messages','POST',{text:'plan only',clientMessageId:'revision'}]]);
 evidence.session.activity.state='working';
 await expect(t.sendImplementation('owner','plan only','second','idle-only')).rejects.toThrow('Worker is not idle');
 expect(requests).toHaveLength(1);
 expect(calls.filter(args=>args.includes('send'))).toHaveLength(0);
 await t.sendImplementation('owner','implement','default');
 expect(calls.at(-1)).toContain('--steer');
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
test('completed unmarked replans survive repeated polling and need exact confirmation before a new attempt',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  f.e.transcript.entries.at(-1).text=`Plan without revision marker\n${ready}`;
  for(let n=0;n<2;n++){
   const results=await f.w.tick(config);
   expect(results).toEqual(expect.arrayContaining([expect.objectContaining({job:f.job,state:'replan_unmarked'})]));
   expect(f.s.get(f.job).state).toBe('awaiting_plan');expect(f.s.get(f.job).plan).toBeNull();
  }
  expect(f.sends).toHaveLength(2);
  const unmarked=await f.recovery.preview(f.job,config);expect(unmarked.action).toBe('reconcile_unmarked_replan');
  await expect(f.recovery.reconcile(f.job,config,'0'.repeat(64))).rejects.toThrow('Unmarked-plan evidence changed');
  const old=f.s.db.query('SELECT * FROM spec_replans').get() as any;
  expect(await f.recovery.reconcile(f.job,config,unmarked.confirmation)).toMatchObject({action:'replan_unmarked_reconciled',state:'failed'});
  expect(f.sends).toHaveLength(2);
  const event=f.s.db.query("SELECT detail FROM events WHERE kind='spec_replan_unmarked_reconciled'").get() as any;
  expect(JSON.parse(event.detail)).toMatchObject({delivery:{client_id:old.client_id,session:old.session},unmarked:{turn:old.client_id,state:'completed'}});
  await f.w.tick(config);expect(f.sends).toHaveLength(2);
  const fresh=await f.recovery.preview(f.job,config);expect(fresh.action).toBe('request_replanning');
  await f.recovery.reconcile(f.job,config,fresh.confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  expect(f.sends).toHaveLength(3);expect(f.sends[2].clientId).not.toBe(old.client_id);
 }finally{f.s.close();}
});
test('an unmarked confirmation cannot retire a different turn or a subsequently marked plan',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  const marked=f.e.transcript.entries.at(-1).text;f.e.transcript.entries.at(-1).text='Unmarked reply';
  const preview=await f.recovery.preview(f.job,config);expect(preview.action).toBe('reconcile_unmarked_replan');
  f.e.transcript.turns.at(-1).id='different-turn';
  await expect(f.recovery.reconcile(f.job,config,preview.confirmation)).rejects.toThrow('Preview changed or delivery already reserved');
  f.e.transcript.turns.at(-1).id=(f.s.db.query('SELECT client_id FROM spec_replans').get() as any).client_id;
  f.e.transcript.entries.at(-1).text=marked;
  await expect(f.recovery.reconcile(f.job,config,preview.confirmation)).rejects.toThrow('Preview changed or delivery already reserved');
  expect((f.s.db.query('SELECT state FROM spec_replans').get() as any).state).toBe('accepted');
  await f.recovery.capture(f.job,config);expect(f.s.get(f.job).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
for(const invalid of ['incomplete','stale','future','busy','active-turn','owner','branch','terminated','project','duplicate-entry','marked'])test(`unmarked replans do not qualify for retirement with ${invalid} evidence`,async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  f.e.transcript.entries.at(-1).text='Reply without the revised-plan marker';
  const preview=await f.recovery.preview(f.job,config);expect(preview.action).toBe('reconcile_unmarked_replan');
  if(invalid==='marked')f.e.transcript.entries.at(-1).text=`<!-- ADLC_REVISED_PLAN:${preview.revision} -->\nNow marked\n${ready}`;
  if(invalid==='incomplete')f.e.receiptObservation.complete=false;
  if(invalid==='stale')f.e.receiptObservation.observed=Date.now()-120001;
  if(invalid==='future')f.e.receiptObservation.observed=Date.now()+10000;
  if(invalid==='busy')f.e.transcript.controller='busy';
  if(invalid==='active-turn')f.e.transcript.turns.push({id:'still-running',state:'running'});
  if(invalid==='owner')f.e.session.id='different-owner';
  if(invalid==='branch')f.e.session.branch='different-branch';
  if(invalid==='terminated')f.e.session.isTerminated=true;
  if(invalid==='project')f.e.session.projectId='different-project';
  if(invalid==='duplicate-entry'){
   const d=f.s.db.query('SELECT * FROM spec_replans').get() as any;
   f.e.transcript.entries.push({clientMessageId:d.client_id,turnId:d.client_id,sequence:99});
  }
  expect((await f.recovery.preview(f.job,config)).action).toBe('refresh_evidence');
  await expect(f.recovery.reconcile(f.job,config,preview.confirmation)).rejects.toThrow('Preview changed or delivery already reserved');
  expect((f.s.db.query('SELECT state FROM spec_replans').get() as any).state).toBe('accepted');
  expect(f.sends).toHaveLength(2);expect(f.s.get(f.job).plan).toBeNull();
 }finally{f.s.close();}
});
test('an earlier unmarked replan is retired before the newer revision can proceed',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  f.e.transcript.entries.at(-1).text='Earlier revision reply without marker';
  const old=await f.recovery.preview(f.job,config);expect(old.action).toBe('reconcile_unmarked_replan');
  f.edit('v3');
  await expect(f.recovery.reconcile(f.job,config,old.confirmation)).rejects.toThrow('Unmarked-plan evidence changed');
  const prior=await f.recovery.preview(f.job,config);expect(prior.action).toBe('reconcile_unmarked_replan');expect(prior.revision).toBe(old.revision);
  expect(await f.recovery.reconcile(f.job,config,prior.confirmation)).toMatchObject({action:'replan_unmarked_reconciled',state:'failed'});
  expect(f.sends).toHaveLength(2);
  // The newer revision is still awaiting a fresh planning turn, not auto-resumed.
  expect((await f.recovery.preview(f.job,config)).action).toBe('request_replanning');
  await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);
  expect(f.sends).toHaveLength(3);
  expect((f.s.db.query('SELECT state FROM spec_replans WHERE revision=?').get(old.revision) as any).state).toBe('failed');
  f.complete();await f.recovery.capture(f.job,config);expect(f.s.get(f.job).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
test('manual plan submission and capture refuse a pending requirement revision',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-cli-revision-')),db=join(dir,'state.db'),planFile=join(dir,'plan.md');
 try{
  writeFileSync(planFile,'Plan: edit src/a.ts');
  const s=new Store(db),job=s.enqueue('p','issue','Original'),planning=new Planning(s),run=planning.reserve(job,'project');
  planning.gate(job,'project','owner',run.branch,'/worktree');
  const env={ADLC_DB:db,HOME:dir,PATH:process.env.PATH??'/usr/bin:/bin'};
  const cli=join(import.meta.dir,'../src/cli.ts');
  const direct=Bun.spawnSync([process.execPath,cli,'plan',job,planFile],{env});
  expect(direct.exitCode).toBe(0);
  s.db.query("UPDATE jobs SET plan=NULL,plan_hash=NULL,state='awaiting_plan',approved_hash=NULL,actor=NULL WHERE id=?").run(job);
  s.enqueue('p','issue','Changed requirements');
  expect(latestRevision(s,job).state).toBe('pending');
  const blockedPlan=Bun.spawnSync([process.execPath,cli,'plan',job,planFile],{env});
  expect(blockedPlan.exitCode).not.toBe(0);
  expect(blockedPlan.stderr.toString()).toContain('Active requirement revision requires spec-reconcile before manual plan submission');
  const blockedCapture=Bun.spawnSync([process.execPath,cli,'capture-plan',job,'owner','1'],{env});
  expect(blockedCapture.exitCode).not.toBe(0);
  expect(blockedCapture.stderr.toString()).toContain('Active requirement revision requires spec-reconcile before manual plan capture');
  expect(s.get(job).plan).toBeNull();
  // Every post-revision state is equally blocking for both manual paths.
  for(const state of ['awaiting_approval','authorized']){
   s.db.query('UPDATE spec_revisions SET state=? WHERE job=?').run(state,job);
   for(const args of [['plan',job,planFile],['capture-plan',job,'owner','1']]){
    const blocked=Bun.spawnSync([process.execPath,cli,...args],{env});
    expect(blocked.exitCode).not.toBe(0);
    expect(blocked.stderr.toString()).toContain('Active requirement revision requires spec-reconcile');
   }
  }
  expect(s.get(job).plan).toBeNull();
  s.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('propose and executeApproved reject a revision that changed after evidence was read',async()=>{
 const f=await fixture();try{
  const before=latestRevision(f.s,f.job);
  f.edit('v2');const after=latestRevision(f.s,f.job);
  expect(()=>f.s.propose(f.job,'Old plan',before?.id??null)).toThrow('Requirement revision changed before plan submission');
  expect(f.s.get(f.job).plan).toBeNull();
  // A restored plan hash still requires the captured evidence for this revision.
  await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  f.s.db.query("UPDATE spec_replans SET proof=? WHERE revision=?").run(JSON.stringify({...JSON.parse((f.s.db.query('SELECT proof FROM spec_replans WHERE revision=?').get(after.id) as any).proof),capturedPlanHash:'0'.repeat(64)}),after.id);
  await expect(f.w.executeApproved(f.job,config)).rejects.toThrow('Exact captured replan for the current requirement revision required');
 }finally{f.s.close();}
});
for(const dispatchState of ['different','matching','missing'])test(`approve-plan refuses a captured revision with ${dispatchState} dispatch`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-revised-approve-')),db=join(dir,'state.db');
 const f=await fixture(db);
 try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  const original=f.w.implementation(f.job),hash=f.s.get(f.job).plan_hash;
  expect(original.plan_hash).not.toBe(hash);
  if(dispatchState==='matching')f.s.db.query('UPDATE implementation_dispatch SET plan_hash=? WHERE job=?').run(hash,f.job);
  if(dispatchState==='missing')f.s.db.query('DELETE FROM implementation_dispatch WHERE job=?').run(f.job);
  const before=f.w.implementation(f.job);
  const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'approve-plan',f.job,hash,'Human'],{env:{ADLC_DB:db,HOME:dir,PATH:process.env.PATH??'/usr/bin:/bin'}});
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Revised plan requires approve-job');
  expect(f.s.get(f.job)).toMatchObject({state:'awaiting_approval',approved_hash:null});
  expect(latestRevision(f.s,f.job).state).toBe('awaiting_approval');
  expect(f.w.implementation(f.job)).toEqual(before);
  // Restore the original dispatch to exercise the supported authorization path.
  if(dispatchState==='missing')f.s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(original.job,original.plan_hash,original.session_id,original.client_id,original.state,original.paths,original.runtime,original.actor,original.reason);
  if(dispatchState==='matching')f.s.db.query('UPDATE implementation_dispatch SET plan_hash=? WHERE job=?').run(original.plan_hash,f.job);
  f.w.approve(f.job,hash,'Human',['src/**'],'supervised-host',featureGit);
  expect(f.s.get(f.job).state).toBe('approved');
  expect(f.w.implementation(f.job).plan_hash).toBe(hash);
  expect(latestRevision(f.s,f.job).state).toBe('authorized');
 }finally{f.s.close();rmSync(dir,{recursive:true,force:true});}
});
test('approve-plan refuses an active revision without its captured replan',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-cli-approve-')),db=join(dir,'state.db');
 try{
  const s=new Store(db);new Workflow(s,{} as any);
  const job=s.enqueue('p','issue','Original'),planning=new Planning(s),run=planning.reserve(job,'project');
  planning.gate(job,'project','owner',run.branch,'/worktree');
  s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?,?,?,?)').run(job,digest(s.get(job).spec),'awaiting_approval','owner',null,'initial');
  const hash=s.propose(job,'Original plan\n'+ready);recordReadiness(s,job,s.get(job).plan,hash,digest(s.get(job).spec));
  s.enqueue('p','issue','Changed requirements');s.propose(job,'Restored plan');
  const env={ADLC_DB:db,HOME:dir,PATH:process.env.PATH??'/usr/bin:/bin'};
  const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'approve-plan',job,s.get(job).plan_hash??hash,'Human'],{env});
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('Exact captured replan for the current requirement revision required');
  expect(s.get(job).approved_hash).toBeNull();
  s.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('retiring a replan releases its planning slot for another job',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();
  f.e.transcript.entries.at(-1).text='Unmarked reply';
  f.w.t.startPlan=async()=>({id:'planner'});
  const limited={...config,automation:{planningEnabled:true,orchestratorProject:'project',maxPlanning:1}};
  const other=f.s.enqueue('p','other','Second job');
  expect(f.s.get(other).state).toBe('awaiting_plan');
  // The unreconciled replan still occupies the single planning slot.
  const blocked=await f.w.tick(limited);
  // With no free slot the other job is not even dispatched.
  expect(blocked.some((r:any)=>r.job===other)).toBe(false);
  expect(f.w.planning(other)).toBeNull();
  const pending=await f.recovery.preview(f.job,config);expect(pending.action).toBe('reconcile_unmarked_replan');
  await f.recovery.reconcile(f.job,config,pending.confirmation);
  expect(f.w.planning(f.job).state).toBe('planning_finished');
  const started=await f.w.tick(limited);
  expect(started.some((r:any)=>r.job===other&&r.state==='planning')).toBe(true);
  expect(f.w.planning(other)).toMatchObject({state:'planning',session_id:'planner'});
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
  const after=await new ReviewLoop(f.s,undefined,{sessionEvidence:async()=>({receiptObservation:{complete:true,observed:Date.now()},session:{id:'owner',projectId:'project',branch:f.e.session.branch,isTerminated:false,prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',turns:[],entries:[]}}),readBranchSnapshot:async()=>({branch:f.e.session.branch,head,state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'}),worktreeIdentity:async()=>({branch:f.e.session.branch,head}),readiness:async()=>evidence} as any).tick(f.job,undefined,undefined,{project:'p',checks:[]},config);
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
test('restoring a plan hash uses a new dispatch receipt and ignores historical completed continuations',async()=>{
 const f=await fixture();try{
  const original=f.s.get(f.job),oldDispatch=f.w.implementation(f.job);
  f.s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,?)').run(f.job,f.hash,digest(original.spec),'historical','old-same-plan','owner','completed');
  f.e.transcript.entries.push({clientMessageId:'old-same-plan',turnId:'old-same-plan',sequence:10});
  f.e.transcript.turns.push({id:'old-same-plan',state:'completed'});
  f.edit('v2');f.edit('Original');
  expect((await f.w.reconcilePlanning(f.job,config)).state).toBe('requirements_changed');
  expect(f.s.get(f.job).state).toBe('awaiting_plan');expect(f.s.get(f.job).plan).toBeNull();
  await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  // Reproduce an identical approved plan to exercise hash reuse independently
  // of the provider's revised-plan marker formatting.
  const hash=f.s.propose(f.job,original.plan);expect(hash).toBe(f.hash);
  recordReadiness(f.s,f.job,original.plan,hash,digest(original.spec));
  expect(()=>f.w.approve(f.job,hash,'human',['src/**'],'supervised-host',featureGit)).toThrow('Exact captured replan for the current requirement revision required');
  // Explicitly bind synthetic captured evidence to the repeated hash only for
  // this receipt-selection fixture; the public manual-plan path cannot do so.
  const captured=f.s.db.query('SELECT revision,proof FROM spec_replans WHERE state=?').get('captured') as any;
  f.s.db.query('UPDATE spec_replans SET proof=? WHERE revision=?').run(JSON.stringify({...JSON.parse(captured.proof),capturedPlanHash:hash}),captured.revision);
  f.w.approve(f.job,hash,'human',['src/**'],'supervised-host',featureGit);
  expect(f.w.implementation(f.job).client_id).not.toBe(oldDispatch.client_id);
  await f.w.executeApproved(f.job,config);
  f.e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];
  expect((await f.w.executionStatus(f.job,f.e,config)).state).toBe('implementation_running');
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.receiptObservation.observed=Date.now();
  expect((await f.w.executionStatus(f.job,f.e,config)).state).toBe('pr_handoff');
  expect(revisedHandoff(f.s,f.job)).toBe(true);
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
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  await publishRevised(f,1);
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
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  await publishRevised(f,7);
  expect(revisedHandoff(f.s,f.job)).toBe(true);
 }finally{f.s.close();}
});
test('a verified revised candidate is recorded before explicit target rebind; review and Done stay gated',async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  new ReviewLoop(f.s).register(f.job,'owner/repo',7,['CI'],['src/**']);
  expect(await publishRevised(f,9)).toMatchObject({state:'pr_handoff'});
  expect(f.s.db.query('SELECT pr FROM revision_handoffs WHERE job=?').get(f.job)).toEqual({pr:9});
  expect(f.s.db.query('SELECT repo,pr,head FROM revision_handoff_proofs WHERE job=?').get(f.job)).toEqual({repo:'owner/repo',pr:9,head:'a'.repeat(40)});
  expect(new ReviewLoop(f.s).get(f.job).pr).toBe(7);
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  // The registered target still cannot be released by the other PR.
  expect(await new ReviewLoop(f.s).tick(f.job,undefined,undefined,{project:'p',checks:[]},config)).toMatchObject({state:'waiting_for_revised_handoff'});
  let linearCalls=0,prCalls=0;
  const linear=new LinearLifecycle(f.s,async()=>{linearCalls++;throw Error('No Linear write before rebind');},(async()=>{prCalls++;return {merged:true,state:'closed'};}) as any);
  // Revision-notice delivery is independent of the status-transition gate.
  linear.revisionNotices=async()=>[];
  expect(await linear.sync({...config,statusSync:{enabled:true,inProgress:'progress',inReview:'review',done:'done'}})).toContainEqual(expect.objectContaining({job:f.job,state:'revised_handoff_pending'}));
  expect(linearCalls).toBe(0);expect(prCalls).toBe(0);
  expect(f.s.get(f.job).state).toBe('approved');
  // The recorded handoff is authoritative: aligning the target to it succeeds,
  // but substituting a different PR is refused.
  const loop=new ReviewLoop(f.s);
  expect(()=>loop.rebind(f.job,'owner/repo',7)).toThrow('Requested PR differs from the recorded revision handoff');
  expect(loop.get(f.job).pr).toBe(7);expect(revisedHandoff(f.s,f.job)).toBe(false);
  f.s.db.query("UPDATE review_targets SET state='ready',head=?,last_signature='old' WHERE job=?").run('a'.repeat(40),f.job);
  expect(loop.rebind(f.job,'owner/repo',9)).toMatchObject({state:'rebound',pr:9});
  expect(loop.get(f.job)).toMatchObject({pr:9,state:'waiting_for_review',head:null,last_signature:null});
  expect(revisedHandoff(f.s,f.job)).toBe(true);
  // The rebound target must not look ready before the new PR's evidence exists.
  // An isolated adapter keeps provider calls local; the rebound target is not
  // reported ready and its stored state reflects the fresh review cycle.
  const evidence={required:['CI'],checks:[],review:null,unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true,descriptionHash:'d',findings:[],failedChecks:[],pendingChecks:[],missingChecks:[],clear:false,reasons:[]};
  const isolated=new ReviewLoop(f.s,undefined,{
   sessionEvidence:async()=>({receiptObservation:{complete:true,observed:Date.now()},session:{id:'owner',projectId:'project',branch:f.e.session.branch,isTerminated:false,prs:[{number:9,url:'https://github.com/owner/repo/pull/9'}]},transcript:{controller:'ready',turns:[],entries:[]}}),
   readBranchSnapshot:async()=>({branch:f.e.session.branch,head:'a'.repeat(40),state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'}),
   worktreeIdentity:async()=>({branch:f.e.session.branch,head:'a'.repeat(40)}),
   readiness:async()=>evidence,
  } as any);
  const result=await isolated.tick(f.job,undefined,undefined,{project:'p',checks:[]},config);
  expect(result).toMatchObject({state:'waiting_for_coderabbit',send:false});
  expect(isolated.get(f.job)).toMatchObject({pr:9,state:'waiting_for_coderabbit',head:null,last_signature:expect.any(String)});
  expect(isolated.get(f.job).state).not.toBe('ready_for_human');
  expect(f.s.db.query('SELECT pr FROM revision_handoffs WHERE job=?').get(f.job)).toEqual({pr:9});
  expect(revisedHandoff(f.s,f.job)).toBe(true);
  expect((f.s.db.query("SELECT detail FROM events WHERE kind='review_target_rebound'").get() as any).detail).toContain('"handoff":9');
  // Reconciliation without a recorded handoff fails closed and changes nothing.
  f.s.db.query('DELETE FROM revision_handoffs WHERE job=?').run(f.job);
  expect(()=>loop.rebind(f.job,'owner/repo',11)).toThrow('Current revision handoff required before target reconciliation');
  expect(loop.get(f.job).pr).toBe(9);
  expect(revisedHandoff(f.s,f.job)).toBe(false);
  // A different repository cannot rebind the target.
  f.s.db.query('INSERT INTO revision_handoffs VALUES (?,?,?,?,?)').run(f.job,f.s.get(f.job).plan_hash,'handoff-revision',9,Date.now());
  expect(()=>loop.rebind(f.job,'other/repo',9)).toThrow('Existing review target for this repository required');
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
  // This batch models active revisions; ordinary intake edits are not notices.
  s.db.query("UPDATE spec_revisions SET state='pending'").run();
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
test('old failed notices receive round-robin retries despite sustained new revisions and restarts',async()=>{
 const s=new Store(':memory:');try{
  const c:any={linear:{projectId:'p',teamId:'t'}},attempted:string[]=[],posted:string[]=[];
  const add=(id:string)=>{s.enqueue('p',id,'before');s.enqueue('p',id,'after');s.db.query("UPDATE spec_revisions SET state='pending' WHERE job=?").run(digest(JSON.stringify(['p',id])));};
  const api:any=async(q:string,v:any)=>{
   if(q.includes('commentCreate')){posted.push(v.input.id);return {commentCreate:{success:true,comment:{id:v.input.id,body:v.input.body}}};}
   if(q.includes('comments('))return {issue:{id:v.id,comments:{nodes:[],pageInfo:{hasNextPage:false}}}};
   attempted.push(v.id);if(v.id.startsWith('old-'))throw Error('Persistent old provider failure');
   return {issue:{id:v.id,team:{id:'t'},project:{id:'p'}}};
  };
  for(let n=0;n<5;n++)add(`old-${n}`);
  await new LinearLifecycle(s,api).revisionNotices(c);
  const retries:string[]=[];
  for(let poll=0;poll<5;poll++){
   for(let n=0;n<5;n++)add(`new-${poll}-${n}`);
   const start=attempted.length,result=await new LinearLifecycle(s,api).revisionNotices(c),batch=attempted.slice(start);
   expect(batch).toHaveLength(5);expect(result.filter((x:any)=>x.state==='requirements_notice_posted')).toHaveLength(4);
   retries.push(...batch.filter(id=>id.startsWith('old-')));
  }
  expect(retries).toEqual(['old-0','old-1','old-2','old-3','old-4']);
  expect(posted).toHaveLength(20);expect(new Set(posted).size).toBe(20);
 }finally{s.close();}
});
for(const stage of ['pr','issue','state'])for(const change of ['revision','handoff','none'])test(`real status move rejects ${change} changes during ${stage} lookup before any Linear write`,async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  await f.w.executeApproved(f.job,config);
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.receiptObservation.observed=Date.now();
  f.e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];
  await f.w.executionStatus(f.job,f.e,config);new ReviewLoop(f.s).register(f.job,'owner/repo',1,['CI'],['src/**']);
  let writes=0;
  const mutate=()=>{
   if(change==='handoff')f.s.db.query('DELETE FROM revision_handoffs WHERE job=?').run(f.job);
   if(change==='revision'){const original=f.s.get(f.job).spec;f.s.enqueue('p','issue','Intermediate revision');f.s.enqueue('p','issue',original);}
  };
  const api:any=async(q:string)=>{
   if(q.includes('issueUpdate')){writes++;return {issueUpdate:{success:true,issue:{id:'issue',state:{id:'done'}}}};}
   if(q.includes('workflowState')){if(stage==='state')mutate();return {workflowState:{id:'done',type:'completed',team:{id:'t'}}};}
   if(stage==='issue')mutate();return {issue:await f.recovery.issue('issue')};
  };
  const linear=new LinearLifecycle(f.s,api,(async()=>{if(stage==='pr')mutate();return {merged:true,state:'closed'};}) as any);
  linear.revisionNotices=async()=>[];
  const result=await linear.sync({...config,statusSync:{enabled:true,inProgress:'doing',inReview:'review',done:'done'}});
  if(change==='none'){expect(writes).toBe(1);expect(f.s.get(f.job).state).toBe('done');}
  else{
   expect(result).toEqual(expect.arrayContaining([expect.objectContaining({error:'Revision or revised handoff changed before Linear status update'})]));
   expect(writes).toBe(0);expect(f.s.get(f.job).state).not.toBe('done');
   expect(f.s.db.query('SELECT * FROM linear_transitions WHERE job=?').all(f.job)).toHaveLength(0);
  }
 }finally{f.s.close();}
});
for(const stage of ['pr','move'])for(const change of ['revision','handoff','none'])test(`Done rechecks ${change} after awaited ${stage} evidence`,async()=>{
 const f=await fixture();try{
  f.edit('v2');await f.recovery.reconcile(f.job,config,(await f.recovery.preview(f.job,config)).confirmation);f.complete();await f.recovery.capture(f.job,config);
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  await f.w.executeApproved(f.job,config);
  f.e.transcript.turns.at(-1).state='completed';f.e.transcript.controller='ready';f.e.receiptObservation.observed=Date.now();
  f.e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];
  await f.w.executionStatus(f.job,f.e,config);
  new ReviewLoop(f.s).register(f.job,'owner/repo',1,['CI'],['src/**']);
  const mutate=()=>{
   if(change==='handoff')f.s.db.query('DELETE FROM revision_handoffs WHERE job=?').run(f.job);
   if(change==='revision'){const original=f.s.get(f.job).spec;f.s.enqueue('p','issue','Intermediate revision');f.s.enqueue('p','issue',original);}
  };
  const linear=new LinearLifecycle(f.s,undefined,(async()=>{if(stage==='pr')mutate();return {merged:true,state:'closed'};}) as any);
  linear.revisionNotices=async()=>[];
  linear.move=async()=>{if(stage==='move')mutate();return {state:'confirmed'};};
  const results=await linear.sync({...config,statusSync:{enabled:true,inProgress:'doing',inReview:'review',done:'done'}});
  if(change==='none')expect(f.s.get(f.job).state).toBe('done');
  else{
   expect(results).toEqual(expect.arrayContaining([expect.objectContaining({error:'Revision or revised handoff changed before Done completion'})]));
   expect(f.s.get(f.job).state).not.toBe('done');
   expect((f.s.db.query('SELECT state FROM runs WHERE job=?').get(f.job) as any).state).not.toBe('completed');
   expect(new ReviewLoop(f.s).get(f.job).state).not.toBe('completed');
  }
 }finally{f.s.close();}
});
test('preplanning edits do not publish authorization-invalidated notices',async()=>{
 const s=new Store(':memory:');try{
  s.enqueue('p','early','before');s.enqueue('p','early','after');
  let calls=0;const api:any=async()=>{calls++;throw Error('Preplanning must not access Linear');};
  expect(await new LinearLifecycle(s,api).revisionNotices({linear:{projectId:'p',teamId:'t'}} as any)).toEqual([]);
  expect(calls).toBe(0);expect(s.db.query('SELECT * FROM spec_notices').all()).toHaveLength(0);
 }finally{s.close();}
});
for(const enabled of [undefined,false])test(`disabled status sync (${enabled}) performs no Linear notice or status access`,async()=>{
 const f=await fixture();try{
  f.edit('Changed requirements');let calls=0;
  const linear=new LinearLifecycle(f.s,async()=>{calls++;throw Error('Disabled sync must not access Linear');});
  const c:any={...config,...(enabled===undefined?{}:{statusSync:{enabled:false}})};
  expect(await linear.sync(c)).toEqual([]);expect(calls).toBe(0);
  expect(f.s.db.query('SELECT * FROM spec_notices').all()).toHaveLength(0);
 }finally{f.s.close();}
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
test('ingest respects the turn-submission pause',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-ingest-fence-')),db=join(dir,'state.db'),specFile=join(dir,'spec.json');
 try{
  writeFileSync(specFile,JSON.stringify({identifier:'DEV-1',title:'Task',description:'Original'}));
  const state=join(dir,'Library','Application Support','ADLC Bridge');mkdirSync(state,{recursive:true});
  const paused=join(state,'turn-submissions.paused');writeFileSync(paused,'Paused\n');
  const env={ADLC_DB:db,HOME:dir,PATH:process.env.PATH??'/usr/bin:/bin'},cli=join(import.meta.dir,'../src/cli.ts');
  const blocked=Bun.spawnSync([process.execPath,cli,'ingest','p','issue',specFile],{env});
  expect(blocked.exitCode).not.toBe(0);
  expect(blocked.stderr.toString()).toContain('Turn submissions paused');
  const s=new Store(db);try{expect(s.list()).toHaveLength(0);}finally{s.close();}
  unlinkSync(paused);
  const accepted=Bun.spawnSync([process.execPath,cli,'ingest','p','issue',specFile],{env});
  expect(accepted.exitCode).toBe(0);
  expect(JSON.parse(accepted.stdout.toString()).id).toBeString();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('reconcile holds the shared submission fence before writing recovery state',async()=>{
 const f=await fixture(),state=mkdtempSync(join(tmpdir(),'adlc-reconcile-fence-'));try{
  f.edit('v2');
  const submit=(operation:any)=>turnBarrier(state).submit(operation);
  const fenced=new SpecRecovery(f.s,f.w,f.recovery.issue as any,submit);
  const preview=await fenced.preview(f.job,config);
  const lock=join(state,'turn-submission.lock');
  mkdirSync(lock,{mode:0o700});
  await expect(fenced.reconcile(f.job,config,preview.confirmation)).rejects.toThrow('Turn submission or shutdown is in progress');
  expect(f.s.db.query('SELECT * FROM spec_replans').all()).toHaveLength(0);
  expect(f.sends).toHaveLength(1);
  rmSync(lock,{recursive:true,force:true});
  await fenced.reconcile(f.job,config,preview.confirmation);
  expect(f.s.db.query('SELECT state FROM spec_replans').get()).toEqual({state:'accepted'});
  expect(f.sends).toHaveLength(2);
 }finally{f.s.close();rmSync(state,{recursive:true,force:true});}
});
test('held submission lock blocks specification intake without touching the job or revisions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-ingest-lock-')),db=join(dir,'state.db'),first=join(dir,'first.json'),second=join(dir,'second.json');
 try{
  writeFileSync(first,JSON.stringify({identifier:'DEV-1',title:'Task',description:'Original'}));
  writeFileSync(second,JSON.stringify({identifier:'DEV-1',title:'Task',description:'Changed while locked'}));
  const state=join(dir,'Library','Application Support','ADLC Bridge');mkdirSync(state,{recursive:true});
  const env={ADLC_DB:db,HOME:dir,PATH:process.env.PATH??'/usr/bin:/bin'},cli=join(import.meta.dir,'../src/cli.ts');
  const initial=Bun.spawnSync([process.execPath,cli,'ingest','p','issue',first],{env});
  expect(initial.exitCode).toBe(0);const id=JSON.parse(initial.stdout.toString()).id;
  const lock=join(state,'turn-submission.lock');mkdirSync(lock,{mode:0o700});
  const blocked=Bun.spawnSync([process.execPath,cli,'ingest','p','issue',second],{env});
  expect(blocked.exitCode).not.toBe(0);
  expect(blocked.stderr.toString()).toContain('Turn submission or shutdown is in progress');
  const s=new Store(db);try{
   expect(s.get(id).spec).toBe(JSON.stringify({identifier:'DEV-1',title:'Task',description:'Original'}));
   expect(s.db.query('SELECT * FROM spec_revisions WHERE job=?').all(id)).toHaveLength(0);
  }finally{s.close();}
  rmSync(lock,{recursive:true,force:true});
  const accepted=Bun.spawnSync([process.execPath,cli,'ingest','p','issue',second],{env});
  expect(accepted.exitCode).toBe(0);
  const after=new Store(db);try{
   expect(after.get(id).spec).toContain('Changed while locked');
   expect(after.db.query('SELECT * FROM spec_revisions WHERE job=?').all(id)).toHaveLength(1);
  }finally{after.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('worktree reservations are detected through alias paths',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-alias-'));try{
  const tree=join(dir,'tree'),link=join(dir,'link');mkdirSync(tree);symlinkSync(tree,link);
  const s=new Store(':memory:');new Workflow(s,{} as any);new Planning(s);
  const job=s.enqueue('p','issue','spec'),p=new Planning(s),r=p.reserve(job,'p');p.gate(job,'p','owner',r.branch,link);
  s.db.query('INSERT INTO spec_revisions(id,job,old_hash,new_hash,summary,state) VALUES (?,?,?,?,?,?)').run('alias-revision',job,'old','new','Alias','pending');
  s.db.query("INSERT INTO spec_replans VALUES (?,?,?,?,'binding','accepted','{}',NULL)").run('alias-revision',job,'client','owner');
  expect(worktreeReservation(s,'unrelated',tree)).toMatchObject({specRevision:true,state:'accepted'});
  s.db.query('DELETE FROM spec_replans').run();
  s.db.exec('CREATE TABLE dependency_updates(id TEXT PRIMARY KEY,job TEXT NOT NULL,plan TEXT NOT NULL,worktree TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL)');
  s.db.query('INSERT INTO dependency_updates VALUES (?,?,?,?,?,?)').run('update-1','other','plan',link,'reserved','{}');
  expect(worktreeReservation(s,'unrelated',tree)).toMatchObject({dependency:true,id:'update-1'});
  s.db.query('DELETE FROM dependency_updates').run();
  s.db.exec(`CREATE TABLE conflict_recoveries(id TEXT PRIMARY KEY,job TEXT NOT NULL,plan TEXT NOT NULL,worktree TEXT NOT NULL,session TEXT NOT NULL,repo TEXT NOT NULL,pr INTEGER NOT NULL,branch TEXT NOT NULL,base_branch TEXT NOT NULL,head TEXT NOT NULL,base TEXT NOT NULL,policy TEXT NOT NULL,state TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,attempt INTEGER NOT NULL,detail TEXT NOT NULL,reason TEXT,created INTEGER NOT NULL)`);
  s.db.query('INSERT INTO conflict_recoveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('recovery-1','other','plan',link,'session','owner/repo',1,'b','main','h','base','{}','waiting','client-1',1,'{}',null,Date.now());
  expect(worktreeReservation(s,'unrelated',tree)).toMatchObject({id:'recovery-1'});
  expect(worktreeReservation(s,job)).toMatchObject({id:'recovery-1'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

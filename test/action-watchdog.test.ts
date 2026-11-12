import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,digest} from '../src/core';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
import {ReviewLoop} from '../src/review-loop';
import {ActionWatchdog,actionStatus,evaluateAction,retryWatchdogObservation,WATCHDOG_LIMITS} from '../src/action-watchdog';
import {RecoveryObservation} from '../src/recovery-observation';
import {readFailure} from '../src/provider-read';
import {ReceiptReconciliation} from '../src/receipt-reconciliation';
import {turnBarrier,setProjectIntakePaused} from '../src/turn-submission';
import {jobViews,humanJobs} from '../src/operator-cli';
import {ApprovalPolicyStore} from '../src/approval-policy';
import {BranchUpdates,branchTransport} from '../src/branch-updates';
import {ConflictRecovery} from '../src/conflict-recovery';

function fixture(disk=false){
 const root=mkdtempSync(join(tmpdir(),'adlc-watchdog-')),path=disk?join(root,'state.sqlite'):':memory:',s=new Store(path);
 let now=1_000_000,reads=0;
 const job=s.enqueue('p','issue','spec'),p=new Planning(s),r=p.reserve(job,'ao');p.gate(job,'ao','session',r.branch,'/worktree');
 const hash=s.propose(job,'plan');s.approve(job,hash,'human');const l=new Lifecycle(s);l.grantGit(job,hash,['inspect','commit','push-feature','open-pr'],'human');l.adoptSupervised(job,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
  const loop=new ReviewLoop(s,async()=>{throw Error('No review requests expected');},{},()=>now);loop.configureMetadataChecks('p',[]);loop.register(job,'owner/repo',1,['CI'],['src/**'],true);
 const c={linear:{projectId:'p'},githubRepo:'owner/repo',automation:{orchestratorProject:'ao'}},w=new ActionWatchdog(s,()=>now,()=>0.5,root);
 const session:any={receiptObservation:{complete:true,observed:now},session:{id:'session',projectId:'ao',isTerminated:false,branch:r.branch,prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',entries:[],turns:[]}};
 const snapshot:any={head:'a'.repeat(40),headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,branch:r.branch,base:'b'.repeat(40),baseBranch:'main',defaultBranch:'main',mergeable:true,behind:0};
 const io={sessionEvidence:async()=>{reads++;session.receiptObservation={complete:true,observed:now};return session;},readBranchSnapshot:async()=>{reads++;return snapshot;}};
 return {root,path,s,job,loop,c,w,session,snapshot,io,now:()=>now,advance:(ms=60000)=>now+=ms,reads:()=>reads,close:()=>{s.close();rmSync(root,{recursive:true,force:true});}};
}
test('DEV-97: recurrent binding permits bounded fresh evaluation, never a historical read claim or budget reset',async()=>{
 const f=fixture();try{
  f.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(f.snapshot.head,f.job);
  const first=f.w.scheduleReview(f.job,f.c);
  f.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run('c'.repeat(40),f.job);f.w.scheduleReview(f.job,f.c);
  f.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(f.snapshot.head,f.job);
  const recurrent=f.w.scheduleReview(f.job,f.c);expect(recurrent).toMatchObject({id:first.id,state:'escalated',outcome:'recurrent_binding'});
  f.s.db.query('UPDATE watchdog_budgets SET attempts=9 WHERE job=?').run(f.job);
  expect(f.w.due('p')).toEqual([]);expect(f.w.due('p',undefined,true).map(a=>a.id)).toEqual([recurrent.id]);
  expect(f.w.beginReview(recurrent.id,f.c)).toBe(true);
  expect(f.w.beginReview(recurrent.id,f.c)).toBe(false);
  f.loop.io={...f.loop.io,...f.io,worktreeIdentity:async()=>({tree:'/worktree',branch:f.snapshot.branch,head:f.snapshot.head}),readiness:async()=>({head:f.snapshot.head,clear:false,reasons:[],findings:[],failedChecks:[],pendingChecks:['CI'],missingChecks:[],descriptionHash:'current-body',reviewEvidenceVersion:'edited-summary'}) as any};
  const result=await f.loop.tick(f.job,undefined,undefined,undefined,f.c);f.w.finishReview(recurrent.id,result);
  expect(f.w.get(recurrent.id).outcome).toBe('recurrent_binding');
  const fresh=f.w.scheduleReview(f.job,f.c);expect(fresh.id).not.toBe(recurrent.id);expect(f.w.get(recurrent.id).state).toBe('superseded');
  expect(actionStatus(f.s,f.job)?.attempts).toBe(9);
 }finally{f.close();}
});
test('DEV-95: a review blocker does not strand the existing branch synchronization reservation',()=>{
 const f=fixture();try{
  f.s.db.exec('CREATE TABLE branch_syncs(job TEXT PRIMARY KEY,worktree TEXT,state TEXT,proof TEXT,reason TEXT)');
  f.s.db.query("INSERT INTO branch_syncs VALUES (?,?,'reserved','{}',NULL)").run(f.job,'/worktree');
  f.loop.record(f.job,{state:'blocked',send:false,reason:'CodeRabbit custom-check failure: incomplete summary'});
  const action=f.w.scheduleReview(f.job,f.c);
  expect(action.outcome).toBe('human_required');
  f.advance(WATCHDOG_LIMITS.idleMs);
  expect(f.w.beginReview(action.id,f.c)).toBe(true);
  expect(f.loop.get(f.job).state).toBe('blocked');
 }finally{f.close();}
});
test('DEV-105: maintenance cadence is independent, persisted, bounded and honors provider holds',()=>{
 const f=fixture(true);try{
  const c={...f.c,branchUpdate:{enabled:true,authorizedBy:'human',maxUpdates:3}};
  f.loop.record(f.job,{state:'blocked',reason:'PR head or description changed during custom-check collection'});
  const review=f.w.scheduleReview(f.job,c);
  expect(review.outcome).toBe('human_required');
  expect(f.w.beginMaintenance(f.job,c)).toBe(true);
  expect(f.w.beginMaintenance(f.job,c)).toBe(false);
  f.w.finishMaintenance(f.job,{reason:'Branch is current'});
  const reopened=new Store(f.path);try{
   const restarted=new ActionWatchdog(reopened,f.now,()=>0.5,f.root);
   expect(restarted.beginMaintenance(f.job,c)).toBe(false);
   f.advance();
   const failure=readFailure('github','branch-read','HTTP/2 429\r\nRetry-After: 180\r\n\r\n',1);failure.evidence.retryAt=f.now()+180000;
   new RecoveryObservation(f.s,f.now).failed(f.job,failure.evidence);
   expect(restarted.beginMaintenance(f.job,c)).toBe(false);
   expect(f.loop.list()[0].maintenance.schedule.reason).toContain('github');
   f.advance(180001);new RecoveryObservation(f.s,f.now).clear(f.job);
   f.s.db.query('UPDATE maintenance_schedule SET attempts=? WHERE job=?').run(WATCHDOG_LIMITS.maxAttempts,f.job);
   expect(restarted.beginMaintenance(f.job,c)).toBe(false);
   expect(f.loop.list()[0].maintenance.schedule.reason).toContain('budget exhausted');
   expect(restarted.beginMaintenance(f.job,c)).toBe(false);
   f.advance(WATCHDOG_LIMITS.idleMs);
   expect(restarted.beginMaintenance(f.job,c)).toBe(true);
   expect(f.w.get(review.id).state).toBe('escalated');
  }finally{reopened.close();}
 }finally{f.close();}
});
test('DEV-105: healthy maintenance outlives its attempt budget and failures recover only after cooldown',()=>{
 const f=fixture();try{
  const c={...f.c,branchUpdate:{enabled:true,authorizedBy:'human',maxUpdates:3}};
  f.loop.record(f.job,{state:'blocked',reason:'Stale review evidence'});
  for(let i=0;i<WATCHDOG_LIMITS.maxAttempts+2;i++){
   expect(f.w.beginMaintenance(f.job,c)).toBe(true);
   f.w.finishMaintenance(f.job,{reason:'Branch is current'});
   expect(f.loop.list()[0].maintenance.schedule.attempts).toBe(0);
   f.advance();
  }
  for(let i=0;i<WATCHDOG_LIMITS.maxEvaluationFailures;i++){
   expect(f.w.beginMaintenance(f.job,c)).toBe(true);
   f.w.finishMaintenance(f.job);
   f.advance(WATCHDOG_LIMITS.idleMs);
  }
  expect(f.w.beginMaintenance(f.job,c)).toBe(false);
  f.advance(WATCHDOG_LIMITS.idleMs-1);
  expect(f.w.beginMaintenance(f.job,c)).toBe(false);
  f.advance(1);
  expect(f.w.beginMaintenance(f.job,c)).toBe(true);
  f.w.finishMaintenance(f.job,{reason:'Fresh guarded evaluation completed'});
  expect(f.loop.list()[0].maintenance.schedule).toMatchObject({attempts:0,failures:0});
  expect(f.loop.get(f.job).state).toBe('blocked');
 }finally{f.close();}
});
// Exercise the real CLI scheduler and ReviewLoop with an offline provider and a
// controlled clock. A subprocess isolates the poll fence's HOME and Date.now.
const POLL_SCENARIO_TIMEOUT_MS=30_000;
function productionScenario(f:ReturnType<typeof fixture>,scenario:string){
 const script=`
import {createCLIPollTick} from ${JSON.stringify(join(import.meta.dir,'../src/cli.ts'))};
import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
import {ReviewLoop} from ${JSON.stringify(join(import.meta.dir,'../src/review-loop.ts'))};
import {ActionWatchdog,actionStatus,WATCHDOG_LIMITS} from ${JSON.stringify(join(import.meta.dir,'../src/action-watchdog.ts'))};
import {BranchUpdates} from ${JSON.stringify(join(import.meta.dir,'../src/branch-updates.ts'))};
import {ReceiptReconciliation} from ${JSON.stringify(join(import.meta.dir,'../src/receipt-reconciliation.ts'))};
import {digest} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
import {turnBarrier} from ${JSON.stringify(join(import.meta.dir,'../src/turn-submission.ts'))};
import {existsSync} from 'node:fs';import {join} from 'node:path';import {appState} from ${JSON.stringify(join(import.meta.dir,'../src/install-state.ts'))};
let now=Date.now();Date.now=()=>now;
const s=new Store(${JSON.stringify(f.path)}),job=${JSON.stringify(f.job)},config=${JSON.stringify(f.c)},snapshot=${JSON.stringify(f.snapshot)},session=${JSON.stringify(f.session)};
let ordinary=0,actions=0,failed=false,clear=false,throws=0,changeHeadOnThrow=false;const errors=[];
console.error=(message)=>errors.push(message);
const forbidden=async()=>{throw Error('Unexpected mutation');};
const loop=new ReviewLoop(s,forbidden,{sessionEvidence:async()=>({...session,receiptObservation:{complete:true,observed:now}}),readBranchSnapshot:async()=>snapshot,worktreeIdentity:async()=>({tree:'/worktree',branch:snapshot.branch,head:snapshot.head}),readiness:async()=>({head:snapshot.head,clear,reasons:[],findings:[],failedChecks:failed?[{name:'CI'}]:[],pendingChecks:!failed&&!clear?['CI']:[],missingChecks:[]}),disableNativeFeedback:forbidden,sendPilotRemediation:forbidden});
const ensure=BranchUpdates.prototype.ensure;BranchUpdates.prototype.ensure=async function(...args){const result=await ensure.apply(this,args);if(throws){throws--;if(changeHeadOnThrow){snapshot.head=ordinary.toString(16).padStart(40,'0');s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(snapshot.head,job);}throw Error('Injected ordinary evaluation failure');}return result;};
const original=loop.tick.bind(loop);loop.tick=async(...args)=>{if(!existsSync(join(appState(),'turn-submission.lock')))throw Error('Poll fence missing');if(args[5])actions++;else ordinary++;return original(...args);};
const tick=createCLIPollTick({config,store:s,reviewLoop:loop,workflow:{tick:async()=>[],implementation:()=>null},linearApprovals:{sync:async()=>[]},linearLifecycle:{sync:async()=>[]},features:{tickProject:async()=>[]},io:{poll:async()=>[],linearToken:()=>'',out:()=>{}}});
const status=()=>actionStatus(s,job,now),advance=(ms=WATCHDOG_LIMITS.intervalMs)=>now+=ms;
s.db.query('UPDATE review_targets SET head=?,head_since=? WHERE job=?').run(snapshot.head,now,job);
${scenario}
s.close();`;
 const result=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root},stdout:'pipe',stderr:'pipe',timeout:POLL_SCENARIO_TIMEOUT_MS});
 expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');return JSON.parse(result.stdout.toString());
}
test('DEV-105: automatic maintenance polls select oldest due targets fairly beyond the four-target batch',()=>{
 const f=fixture(true);try{
  const result=productionScenario(f,`
const {Planning}=await import(${JSON.stringify(join(import.meta.dir,'../src/planning.ts'))});
const {Lifecycle}=await import(${JSON.stringify(join(import.meta.dir,'../src/lifecycle.ts'))});
config.branchUpdate={enabled:true,authorizedBy:'human',maxUpdates:3};
for(let pr=2;pr<=6;pr++){
 const id=s.enqueue('p','issue-'+pr,'spec'),p=new Planning(s),r=p.reserve(id,'ao');p.gate(id,'ao','session-'+pr,r.branch,'/worktree-'+pr);
 const hash=s.propose(id,'plan');s.approve(id,hash,'human');const l=new Lifecycle(s);l.grantGit(id,hash,['inspect','fetch','push-feature'],'human');l.adoptSupervised(id,{id:'session-'+pr,correlation:r.correlation,worktree:'/worktree-'+pr,controller:'running'});
 loop.register(id,'owner/repo',pr,['CI'],['src/**'],true);
}
for(const target of loop.list())loop.record(target.job,{state:'blocked',head:snapshot.head,reason:'Stale review evidence'});
let batch=[];const batches=[],originalTick=loop.tick.bind(loop);
// Exercise real CLI selection/reservation/settlement; guarded effects have
// separate automatic-poll integration coverage in branch-sync.test.ts.
loop.tick=async(...args)=>{if(!args[6])return originalTick(...args);batch.push(loop.get(args[0]).pr);return {state:'completed',reason:'Branch is current'};};
for(let cycle=0;cycle<3;cycle++){batch=[];await tick();batches.push(batch);advance(60000);}
console.log(JSON.stringify({batches,errors,targets:loop.list().map(t=>t.state)}));`);
  expect(result.errors).toEqual([]);
  expect(result.batches.map((b:number[])=>b.length)).toEqual([4,4,4]);
  expect(new Set(result.batches.flat()).size).toBe(6);
  expect(result.batches[1].slice(0,2)).toEqual([5,6]);
  expect(result.targets).toEqual(Array(6).fill('blocked'));
 }finally{f.close();}
});
// This disk-backed subprocess executes 603 real poll ticks (303 observation /
// ordinary-evaluation pairs), including lock and SQLite IO. Hosted CI run
// 43154974882 exceeded the previous 10s outer deadline and killed the child.
// Keep every cycle/assertion; bound the child at 30s and allow cleanup headroom.
test('idle ready-for-human targets receive ordinary polls past 240 observations without charging retry budget',()=>{
 const f=fixture(true);try{
  const r=productionScenario(f,`
clear=true;s.db.query("UPDATE review_targets SET state='ready_for_human' WHERE job=?").run(job);
await tick();const first=ordinary;
for(let i=0;i<300;i++){await tick();advance(WATCHDOG_LIMITS.idleMs);await tick();}
const idleStatus=status(),idleTicks=ordinary;
// New CI evidence still reaches ordinary evaluation and resumes charged work.
clear=false;snapshot.head='c'.repeat(40);advance(WATCHDOG_LIMITS.idleMs);await tick();advance();await tick();
console.log(JSON.stringify({first,idleTicks,idleStatus,current:status(),target:loop.get(job).state,ordinary,actions,errors}));`);
  expect(r.first).toBe(1);expect(r.idleTicks).toBe(301);expect(r.idleStatus).toMatchObject({state:'pending',attempts:0,evaluation:{failures:0}});
  expect(r.target).toBe('waiting_for_ci');expect(r.current).toMatchObject({state:'pending',attempts:1});expect(r.ordinary).toBe(303);expect(r.actions).toBe(303);expect(r.errors).toEqual([]);
 }finally{f.close();}
},POLL_SCENARIO_TIMEOUT_MS+5_000);
test('human-required target sees a worker push through bounded ordinary polling and resumes observation',()=>{
 const f=fixture(true);try{
  const r=productionScenario(f,`
failed=true;await tick();const blocked=status(),oldHead=loop.get(job).head;
failed=false;snapshot.head='c'.repeat(40);await tick();const before=ordinary;
advance(WATCHDOG_LIMITS.idleMs);await tick();const refreshed=loop.get(job),after=ordinary;
advance(WATCHDOG_LIMITS.idleMs);await tick();console.log(JSON.stringify({blocked,oldHead,before,after,refreshed,current:status(),ordinary,actions,errors}));`);
  expect(r.blocked).toMatchObject({state:'escalated',outcome:'human_required'});expect(r.before).toBe(1);expect(r.after).toBe(2);
  expect(r.oldHead).toBe('a'.repeat(40));expect(r.refreshed).toMatchObject({head:'c'.repeat(40),state:'waiting_for_ci'});
  expect(r.current).toMatchObject({state:'pending',binding:{head:'c'.repeat(40)}});expect(r.ordinary).toBe(3);expect(r.actions).toBe(2);expect(r.errors).toEqual([]);
 }finally{f.close();}
});
test('one thrown ordinary evaluation backs off durably then succeeds without operator action or receipt replay',()=>{
 const f=fixture(true);try{
  const r=productionScenario(f,`
const receipts=new ReceiptReconciliation(s),j=s.get(job);receipts.reserve({job,plan:j.plan_hash,spec:digest(j.spec),session:'session',client:'original-send',attempt:'implementation'});receipts.accepted('original-send');const before=receipts.get('original-send');
throws=1;await tick();const deferred=status();await tick();const immediate=ordinary;
advance();await tick();console.log(JSON.stringify({deferred,immediate,current:status(),ordinary,actions,before,after:receipts.get('original-send'),errors}));`);
  expect(r.deferred).toMatchObject({state:'pending',nextAction:'defer',outcome:'evaluation_uncertain',evaluation:{failures:1}});expect(r.immediate).toBe(1);
  expect(r.current).toMatchObject({state:'pending',evaluation:{failures:0}});expect(r.ordinary).toBe(2);expect(r.actions).toBe(2);expect(r.after).toEqual(r.before);expect(r.errors).toEqual(['Injected ordinary evaluation failure']);
 }finally{f.close();}
});
test('scheduling and settlement failures do not skip later poll items',()=>{
 const f=fixture(true);try{
  const r=productionScenario(f,`
const list=loop.list.bind(loop);loop.list=(...args)=>[{job:'bad-target',state:'waiting_for_review'},...list(...args)];
const verify=loop.setVerification.bind(loop);loop.setVerification=(id,...args)=>{if(id==='bad-target')throw Error('bad configuration');return verify(id,...args);};
const due=ActionWatchdog.prototype.due,finish=ActionWatchdog.prototype.finishReview;
ActionWatchdog.prototype.due=function(...args){return [{id:'bad-action',job:'bad-job',state:'pending'},...due.apply(this,args)];};
ActionWatchdog.prototype.finishReview=function(id,...args){if(id==='bad-action')throw Error('settlement failed');return finish.call(this,id,...args);};
await tick();console.log(JSON.stringify({ordinary,actions,errors,current:status()}));`);
  expect(r.ordinary).toBe(1);expect(r.actions).toBe(2);expect(r.errors).toHaveLength(3);expect(r.current.state).toBe('pending');
 }finally{f.close();}
});
test('consecutive evaluation failures back off to the configured cap across successful reads and head changes',()=>{
 const f=fixture(true);try{
  const r=productionScenario(f,`
throws=WATCHDOG_LIMITS.maxEvaluationFailures;changeHeadOnThrow=true;const samples=[];
for(let i=0;i<WATCHDOG_LIMITS.maxEvaluationFailures;i++){
 await tick();samples.push({failures:status().evaluation.failures,delay:status().evaluation.next_tick-now,ordinary});
 await tick();advance(samples.at(-1).delay);
}
advance(24*60*60000);await tick();snapshot.head='e'.repeat(40);s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(snapshot.head,job);await tick();
console.log(JSON.stringify({samples,current:status(),ordinary,actions,errors}));`);
  expect(r.samples.map((x:any)=>x.failures)).toEqual([1,2,3,4,5,6]);expect(r.samples.map((x:any)=>x.delay)).toEqual([60000,120000,240000,480000,900000,900000]);
  expect(r.current).toMatchObject({state:'escalated',outcome:'evaluation_failed',evaluation:{failures:6}});expect(r.ordinary).toBe(6);expect(r.actions).toBe(6);expect(r.errors).toHaveLength(6);
 }finally{f.close();}
});
test('bounded human-required polling still honors revoked authority, reservations, pause and completion',()=>{
 for(const guard of ['grant','reservation','pause','completed']){const f=fixture(true);try{
  const r=productionScenario(f,`
failed=true;await tick();const blocked=status();advance(WATCHDOG_LIMITS.idleMs);
if(${JSON.stringify(guard)}==='grant')s.db.query('DELETE FROM git_grants WHERE job=?').run(job);
if(${JSON.stringify(guard)}==='reservation'){s.db.exec('CREATE TABLE conflict_recoveries(id TEXT,job TEXT,state TEXT,worktree TEXT)');s.db.query("INSERT INTO conflict_recoveries VALUES ('recovery',?,'delivery_uncertain','/worktree')").run(job);}
if(${JSON.stringify(guard)}==='pause')turnBarrier().pause();
if(${JSON.stringify(guard)}==='completed')s.db.query("UPDATE review_targets SET state='completed' WHERE job=?").run(job);
try{await tick();}catch(error){errors.push(error.message);}
console.log(JSON.stringify({blocked,current:status(),ordinary,actions,errors}));`);
  expect(r.blocked.outcome).toBe('human_required');expect(r.ordinary).toBe(1);expect(r.actions).toBe(1);
  if(guard==='completed')expect(r.current).toBeNull();
  if(guard==='grant')expect(r.current).toMatchObject({state:'escalated',outcome:'authority_unavailable'});
  if(guard==='reservation')expect(r.current).toMatchObject({state:'escalated',outcome:'unsupported'});
 }finally{f.close();}}
});
test('ordinary evaluation cadence and failure count survive a connection restart',()=>{
 const f=fixture(true);let second:Store|undefined;try{
  const a=f.w.scheduleReview(f.job,f.c);expect(f.w.beginReview(a.id,f.c)).toBe(true);f.w.finishReview(a.id);
  second=new Store(f.path);const w=new ActionWatchdog(second,f.now,()=>0.5,f.root);
  expect(w.beginReview(a.id,f.c)).toBe(false);expect(w.due('p',4,true)).toEqual([]);
  expect(actionStatus(second,f.job)?.evaluation.failures).toBe(1);
  f.advance();expect(w.due('p',4,true)).toHaveLength(1);expect(w.beginReview(a.id,f.c)).toBe(true);
  f.w.finishReview(a.id,{state:'waiting_for_review'});expect(actionStatus(second,f.job)?.evaluation.failures).toBe(0);
 }finally{second?.close();f.close();}
});
test('closed contract distinguishes legitimate waits from human/unsupported recovery',()=>{
 for(const blocker of ['ci_wait','reviewer_wait','worker_wait','provider_wait','receipt_uncertain'] as const){expect(evaluateAction(blocker,10,10)).toEqual({kind:'observe',operation:'review-evidence'});expect(evaluateAction(blocker,11,10).kind).toBe('defer');}
 for(const blocker of ['human','dependency_wait','unsupported'] as const)expect(evaluateAction(blocker,0,10).kind).toBe('escalate');
});
test('due observation reserves before provider IO, persists bounded next due and no mutation authority',async()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);let reserved=false;
  const result=await f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:async()=>{reserved=f.w.get(a.id).state==='claimed'&&f.w.get(a.id).attempts===1;return f.io.sessionEvidence();}});
  expect(reserved).toBe(true);expect(result.snapshot.head).toBe(f.snapshot.head);
  expect(actionStatus(f.s,f.job,f.now())).toMatchObject({attempts:1,maxAttempts:240,outcome:'observed',dueAt:f.now()+60000,evidence:{activity:'idle',mutationAuthority:false}});
  await expect(f.w.observeReview(a.id,f.c,f.io)).rejects.toThrow();expect(f.reads()).toBe(2);expect(f.w.due('p')).toEqual([]);
  f.advance();await f.w.observeReview(a.id,f.c,f.io);expect(f.reads()).toBe(4);
  expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);expect(f.s.db.query('SELECT * FROM full_review_requests').all()).toEqual([]);
 }finally{f.close();}
});
test('two connections claim once; restart preserves due, reservation and cumulative budget',async()=>{
 const f=fixture(true);let second:Store|undefined;try{
  const a=f.w.scheduleReview(f.job,f.c);second=new Store(f.path);const other=new ActionWatchdog(second,f.now,()=>0.5,f.root);
  let release!:(value:any)=>void;const pending=new Promise(resolve=>release=resolve);
  const first=f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:()=>pending});
  await expect(other.observeReview(a.id,f.c,f.io)).rejects.toThrow();expect(f.reads()).toBe(0);
  release(f.session);await first;second.close();second=new Store(f.path);
  const restarted=new ActionWatchdog(second,f.now,()=>0.5,f.root);expect(restarted.due('p')).toEqual([]);expect(actionStatus(second,f.job,f.now())?.attempts).toBe(1);
  f.advance();expect(restarted.due('p')).toHaveLength(1);
 }finally{second?.close();f.close();}
});
test('expired read claim may be reobserved; old in-flight read cannot finish or overwrite new evidence',async()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);let release!:(value:any)=>void;const pending=new Promise(resolve=>release=resolve);
  const old=f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:()=>pending}).catch(error=>error);
  f.advance(10*60*1000+1);await f.w.observeReview(a.id,f.c,f.io);release(f.session);expect(await old).toBeInstanceOf(Error);
  expect(actionStatus(f.s,f.job,f.now())).toMatchObject({attempts:2,outcome:'observed'});expect(f.reads()).toBe(2);
 }finally{f.close();}
});
for(const field of ['spec','plan','revision','session','owner','pr','head','grant','approval'] as const)test(`exact ${field} binding revalidated after await; stale evidence never escapes`,async()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);
  await expect(f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:async()=>{
   if(field==='spec')f.s.db.query("UPDATE jobs SET spec='changed' WHERE id=?").run(f.job);
   if(field==='plan')f.s.db.query("UPDATE jobs SET plan_hash='changed' WHERE id=?").run(f.job);
   if(field==='revision')f.s.db.query("INSERT INTO spec_revisions(id,job,old_hash,new_hash,summary) VALUES ('revision',?,'a','b','changed')").run(f.job);
   if(field==='session'||field==='owner')f.s.db.query(`UPDATE runs SET ${field==='session'?'session_id':'owner'}='changed' WHERE job=?`).run(f.job);
   if(field==='pr')f.s.db.query('UPDATE review_targets SET pr=2 WHERE job=?').run(f.job);
   if(field==='head')f.s.db.query("UPDATE review_targets SET head='changed' WHERE job=?").run(f.job);
   if(field==='grant')f.s.db.query('DELETE FROM git_grants WHERE job=?').run(f.job);
   if(field==='approval')f.s.db.query('UPDATE jobs SET approved_hash=NULL WHERE id=?').run(f.job);
   return f.session;
  }})).rejects.toThrow('changed');
  expect(f.reads()).toBe(0);expect(actionStatus(f.s,f.job,f.now())).toMatchObject({state:'escalated',outcome:'stale'});
 }finally{f.close();}
});
test('revoked authority before claim, global/project pause before claim and pause during read all prevent use',async()=>{
 for(const mode of ['revoked','global','project','during'] as const){const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);
  if(mode==='revoked')f.s.db.query('DELETE FROM git_grants WHERE job=?').run(f.job);
  if(mode==='global')turnBarrier(f.root).pause();
  if(mode==='project')setProjectIntakePaused('ao',true,f.root);
  await expect(f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:async()=>{if(mode==='during')turnBarrier(f.root).pause();return f.io.sessionEvidence();}})).rejects.toThrow();
  expect(f.reads()).toBe(mode==='during'?1:0);expect(actionStatus(f.s,f.job,f.now())?.nextAction).toBe(mode==='revoked'?'escalate':'defer');
 }finally{f.close();}}
});
test('active and queued workers can only be observed; transcript loss cannot enable recovery',async()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);f.session.transcript.turns=[{id:'t',state:'queued'}];
  await f.w.observeReview(a.id,f.c,f.io);expect(actionStatus(f.s,f.job,f.now())?.evidence.activity).toBe('active_or_queued');
  f.advance();delete f.session.transcript;await expect(f.w.observeReview(a.id,f.c,f.io)).rejects.toThrow();
  expect(actionStatus(f.s,f.job,f.now())?.nextAction).toBe('escalate');expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{f.close();}
});
test('typed transient reads share capacity and stop at retry budget; unknown and permanent reads escalate without diagnostics',async()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);
  const fail=async()=>{throw readFailure('orchestrator','session-read','ETIMEDOUT SECRET');};
  for(let n=1;n<=6;n++){
   await expect(f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:fail})).rejects.toThrow();
   expect(actionStatus(f.s,f.job,f.now())?.attempts).toBe(n);
   if(n<6){expect(f.w.due('p')).toEqual([]);const status=new RecoveryObservation(f.s,f.now,()=>0.5).status(f.job);expect(status.sharedNextRead).toBeGreaterThan(f.now());f.advance(status.next_read-f.now());}
  }
  expect(actionStatus(f.s,f.job,f.now())).toMatchObject({outcome:'retry_exhausted',nextAction:'escalate'});
  expect(JSON.stringify(actionStatus(f.s,f.job,f.now()))).not.toContain('SECRET');
 }finally{f.close();}
 for(const error of [Error('SECRET'),readFailure('github','read','HTTP 401 SECRET')]){const g=fixture();try{const a=g.w.scheduleReview(g.job,g.c);await expect(g.w.observeReview(a.id,g.c,{...g.io,readBranchSnapshot:async()=>{throw error;}})).rejects.toThrow();expect(actionStatus(g.s,g.job,g.now())?.nextAction).toBe('escalate');expect(JSON.stringify(actionStatus(g.s,g.job))).not.toContain('SECRET');}finally{g.close();}}
});
test('provider cooldown defers another action without IO; job budget survives head/plan changes',async()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c),observations=new RecoveryObservation(f.s,f.now,()=>0.5);
  observations.failed(f.job,readFailure('orchestrator','read','HTTP 429',1,undefined,f.now()),'orchestrator');
  await expect(f.w.observeReview(a.id,f.c,f.io)).rejects.toThrow('deferred');expect(f.reads()).toBe(0);
  f.s.db.query('UPDATE watchdog_budgets SET attempts=max_attempts WHERE job=?').run(f.job);
  f.s.db.query("UPDATE review_targets SET head='new-head' WHERE job=?").run(f.job);
  const next=f.w.scheduleReview(f.job,f.c);expect(next.id).not.toBe(a.id);expect(next.outcome).toBe('budget_exhausted');expect(actionStatus(f.s,f.job)?.attempts).toBe(240);
 }finally{f.close();}
});
test('bounded candidates are project-scoped and oldest due first; thrown evaluation defers',()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);
  for(let i=1;i<=6;i++){const job=f.s.enqueue(i===6?'other':'p',`i${i}`,'spec');f.s.db.query('INSERT INTO watchdog_actions SELECT ?,?,?,binding,next_action,blocker,state,?,attempts,max_attempts,failures,token,lease_until,outcome,reason,observed_at,evidence FROM watchdog_actions WHERE id=?').run(`a${i}`,job,i===6?'other':'p',f.now()-i,a.id);}
  expect(f.w.due('p').map(a=>a.id)).toEqual(['a5','a4','a3','a2']);expect(f.w.due('other')).toHaveLength(1);
  f.s.db.query("UPDATE watchdog_actions SET state='escalated',outcome='human_required' WHERE id IN ('a5','a3')").run();
  expect(f.w.due('p',4,true).map(a=>a.id)).toEqual(['a5','a4','a3','a2']);expect(f.w.due('p').map(a=>a.id)).toEqual(['a4','a2','a1',a.id]);
  f.w.finishReview(a.id);expect(actionStatus(f.s,f.job)?.outcome).toBe('evaluation_uncertain');expect(f.w.due('p').some(x=>x.id===a.id)).toBe(false);
 }finally{f.close();}
});
test('uncertain mutation receipts remain unchanged across observations, lease expiry, absent/contradictory transcripts',async()=>{
 const f=fixture();try{
  const receipts=new ReceiptReconciliation(f.s),j=f.s.get(f.job),binding={job:f.job,plan:j.plan_hash,spec:digest(j.spec),session:'session',client:'original-send',attempt:'implementation'};
  receipts.reserve(binding);receipts.accepted(binding.client);
  const before=receipts.get(binding.client),a=f.w.scheduleReview(f.job,f.c);
  for(const state of ['absent','queued','running','completed','contradictory']){
   f.session.receiptObservation={complete:true,observed:Date.now()};f.session.transcript.entries=state==='absent'?[]:[{clientMessageId:binding.client,turnId:'turn'}];
   f.session.transcript.turns=state==='contradictory'?[{id:'turn',state:'completed'},{id:'turn',state:'running'}]:state==='absent'?[]:[{id:'turn',state}];
   await f.w.observeReview(a.id,f.c,f.io);expect(receipts.get(binding.client)).toEqual(before);f.advance(WATCHDOG_LIMITS.leaseMs+1);
  }
  expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);expect(f.s.db.query('SELECT * FROM full_review_requests').all()).toEqual([]);
 }finally{f.close();}
});
test('status is persisted-only, tolerates absent tables and changes no database bytes',async()=>{
 const f=fixture(true);try{
  const a=f.w.scheduleReview(f.job,f.c);await f.w.observeReview(a.id,f.c,f.io);
  f.s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const before=readFileSync(f.path),reads=f.reads();
  const views=jobViews(f.path);expect(views[0].watchdog).toMatchObject({attempts:1,freshness:'persisted-only'});expect(humanJobs(views)).toContain('observations 1/240');
  expect(readFileSync(f.path)).toEqual(before);expect(f.reads()).toBe(reads);
  const ro=Store.readonly(f.path);expect(()=>new ActionWatchdog(ro)).toThrow('writable');ro.close();
  const old=new Store(join(f.root,'old.sqlite'));const job=old.enqueue('p','old','spec');old.close();expect(jobViews(join(f.root,'old.sqlite'))[0].watchdog).toBeNull();expect(job).toBeTruthy();
 }finally{f.close();}
});
test('corrupt or legacy status JSON becomes null without writes or provider reads',()=>{
 const f=fixture(true);try{
  const a=f.w.scheduleReview(f.job,f.c);
  for(const [binding,evidence] of [['{','{"version":1}'],['{"job":"fixture"}','not-json'],['',''],['null',null]]){
   f.s.db.query('UPDATE watchdog_actions SET binding=?,evidence=? WHERE id=?').run(binding,evidence,a.id);
   f.s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const before=readFileSync(f.path),stored=f.w.get(a.id);
   const view=jobViews(f.path)[0];
   expect(view.watchdog?.binding).toEqual(binding==='{"job":"fixture"}'?{job:'fixture'}:null);
   expect(view.watchdog?.evidence).toEqual(evidence==='{"version":1}'?{version:1}:null);
   expect(humanJobs([view])).toContain('Watchdog:');expect(readFileSync(f.path)).toEqual(before);
   expect(f.w.get(a.id)).toEqual(stored);expect(f.reads()).toBe(0);
  }
 }finally{f.close();}
});
test('completed targets are skipped by the production poll without creating a human-blocker action',()=>{
 const f=fixture(true);try{
  f.s.db.query("UPDATE review_targets SET state='completed' WHERE job=?").run(f.job);
  f.s.db.query("UPDATE jobs SET state='done' WHERE id=?").run(f.job);
  const script=`
import {createCLIPollTick} from ${JSON.stringify(join(import.meta.dir,'../src/cli.ts'))};
import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
import {ReviewLoop} from ${JSON.stringify(join(import.meta.dir,'../src/review-loop.ts'))};
const s=new Store(${JSON.stringify(f.path)}),loop=new ReviewLoop(s),config=${JSON.stringify(f.c)};
loop.tick=async()=>{throw Error('Completed target must not be evaluated');};
const tick=createCLIPollTick({config,store:s,reviewLoop:loop,workflow:{tick:async()=>[],implementation:()=>null},linearApprovals:{sync:async()=>[]},linearLifecycle:{sync:async()=>[]},features:{tickProject:async()=>[]},io:{poll:async()=>[],linearToken:()=>'',out:()=>{}}});
await tick();await tick();s.close();`;
  const result=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root},stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');
  expect(f.s.db.query('SELECT * FROM watchdog_actions').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM watchdog_budgets').all()).toEqual([]);
  const views=jobViews(f.path);expect(views[0]).toMatchObject({state:'complete',watchdog:null});
  expect(humanJobs(views)).not.toContain('Watchdog:');expect(humanJobs(views)).not.toContain('authority_unavailable');
 }finally{f.close();}
});
test('actions retained before completion are neither due nor shown as current human blockers',()=>{
 for(const terminal of ['job','review'] as const){const f=fixture(true);try{
  const a=f.w.scheduleReview(f.job,f.c);
  if(terminal==='job')f.s.db.query("UPDATE jobs SET state='done' WHERE id=?").run(f.job);
  else f.s.db.query("UPDATE review_targets SET state='completed' WHERE job=?").run(f.job);
  f.w.finishReview(a.id,{state:'completed'});expect(f.w.get(a.id).state).toBe('pending');
  expect(f.w.due('p')).toEqual([]);expect(jobViews(f.path)[0].watchdog).toBeNull();
  // Even a retained escalation from older code is historical after completion.
  f.s.db.query("UPDATE watchdog_actions SET state='escalated',next_action='escalate',blocker='human',outcome='authority_unavailable' WHERE id=?").run(a.id);
  expect(jobViews(f.path)[0].watchdog).toBeNull();expect(f.w.get(a.id).state).toBe('escalated');expect(f.reads()).toBe(0);
 }finally{f.close();}}
});
test('read action leaves mutation receipts unchanged; separate ordinary review reconciles without resending',async()=>{
 const f=fixture();try{
  const l=new Lifecycle(f.s),j=f.s.get(f.job),receipts=new ReceiptReconciliation(f.s);
  receipts.reserve({job:f.job,plan:j.plan_hash,spec:digest(j.spec),session:'session',client:`adlc-fix-${f.job.slice(0,12)}-1`,attempt:'remediation:1'});
  f.s.db.query("INSERT INTO remediation VALUES (?,?,?,1,'delivery_uncertain')").run(f.job,f.snapshot.head,'findings');
   let sends=0;f.loop.io={...f.loop.io,...f.io,worktreeIdentity:async()=>({tree:'/worktree',branch:f.snapshot.branch,head:f.snapshot.head}),sendPilotRemediation:async()=>{sends++;throw Error('Must not send');}};
   const a=f.w.scheduleReview(f.job,f.c);
   const before=receipts.list(f.job).map(({ageMs,...r})=>r),target=f.loop.get(f.job);
   expect(await f.loop.tick(f.job,undefined,undefined,undefined,f.c,{watchdog:f.w,id:a.id})).toMatchObject({state:'observed',send:false});
   expect(receipts.list(f.job).map(({ageMs,...r})=>r)).toEqual(before);expect(f.loop.get(f.job)).toEqual(target);
   const result=await f.loop.tick(f.job,undefined,undefined,undefined,f.c);f.w.finishReview(a.id,result);
   expect(result).toMatchObject({state:'needs_reconciliation'});expect(sends).toBe(0);expect(f.reads()).toBe(4);expect(l.run(f.job).session_id).toBe('session');
  expect(f.s.db.query('SELECT * FROM full_review_requests').all()).toEqual([]);
 }finally{f.close();}
});
test('watchdog action returns before branch update, review request, remediation and conflict recovery entrypoints',async()=>{
 for(const conflict of [false,true]){const f=fixture();const spies:any[]=[];try{
  Object.assign(f.c,{conflictRecovery:{enabled:true}});f.snapshot.behind=2;f.snapshot.mergeable=!conflict;
  const forbidden=async()=>{throw Error('Effectful path reached from observation');};
  spies.push(spyOn(BranchUpdates.prototype,'ensure').mockImplementation(forbidden),spyOn(BranchUpdates.prototype,'observeAccepted').mockImplementation(forbidden),spyOn(branchTransport,'update').mockImplementation(forbidden),spyOn(ConflictRecovery.prototype,'tick').mockImplementation(forbidden),spyOn(f.loop,'requestReview').mockImplementation(forbidden),spyOn(f.loop.io,'sendPilotRemediation').mockImplementation(forbidden),spyOn(f.loop.io,'disableNativeFeedback').mockImplementation(forbidden),spyOn(f.loop.io,'readiness').mockImplementation(forbidden));
  f.loop.io={...f.loop.io,...f.io};const a=f.w.scheduleReview(f.job,f.c),target=f.loop.get(f.job);
  const result=await f.loop.tick(f.job,{enabled:true,authorizedBy:'human',maxUpdates:2},undefined,undefined,f.c,{watchdog:f.w,id:a.id});
  expect(result).toMatchObject({state:'observed',send:false});for(const spy of spies)expect(spy).not.toHaveBeenCalled();
  expect(f.loop.get(f.job)).toEqual(target);expect(f.w.get(a.id).outcome).toBe('observed');expect(f.reads()).toBe(2);
  expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);expect(f.s.db.query('SELECT * FROM full_review_requests').all()).toEqual([]);
 }finally{for(const spy of spies)spy.mockRestore();f.close();}}
});
test('separate ordinary review preserves authorized branch updates and never replays uncertain effects',async()=>{
 for(const uncertain of [false,true]){const f=fixture();let update:any;try{
  const policy={enabled:true,authorizedBy:'human',maxUpdates:2};Object.assign(f.c,{branchUpdate:policy});
  new Lifecycle(f.s).grantGit(f.job,f.s.get(f.job).plan_hash,['inspect','fetch','commit','push-feature','open-pr'],'human');
  f.snapshot.behind=1;f.loop.io={...f.loop.io,...f.io,worktreeIdentity:async()=>({tree:'/worktree',branch:f.snapshot.branch,head:f.snapshot.head})};
  update=spyOn(branchTransport,'update').mockImplementation(async()=>{if(uncertain)throw Error('Reply lost after request');});
  const a=f.w.scheduleReview(f.job,f.c);
  expect((await f.loop.tick(f.job,policy,undefined,undefined,f.c,{watchdog:f.w,id:a.id})).state).toBe('observed');
  expect(update).not.toHaveBeenCalled();expect(f.s.db.query("SELECT name FROM sqlite_master WHERE name='branch_updates'").get()).toBeNull();
  const result=await f.loop.tick(f.job,policy,undefined,undefined,f.c);f.w.finishReview(a.id,result);
  expect(result.state).toBe(uncertain?'blocked':'updating_branch');expect(update).toHaveBeenCalledTimes(1);
  const receipt=f.s.db.query('SELECT * FROM branch_updates WHERE job=?').get(f.job) as any;
  expect(receipt.state).toBe(uncertain?'delivery_uncertain':'accepted');
  await f.loop.tick(f.job,policy,undefined,undefined,f.c);
  expect(update).toHaveBeenCalledTimes(1);expect(f.s.db.query('SELECT * FROM branch_updates WHERE job=?').get(f.job)).toEqual(receipt);
 }finally{update?.mockRestore();f.close();}}
});
test('provider rearm preserves budget, shared capacity and mutation uncertainty; other escalations remain stopped',async()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);
  await expect(f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:async()=>{throw readFailure('orchestrator','read','HTTP 401');}})).rejects.toThrow();
  f.s.db.query("UPDATE review_targets SET state='blocked' WHERE job=?").run(f.job);
  expect(f.w.scheduleReview(f.job,f.c).blocker).toBe('provider_wait');
  const observations=new RecoveryObservation(f.s,f.now);observations.retry(f.job);retryWatchdogObservation(f.s,f.job,f.now());
  expect(f.w.scheduleReview(f.job,f.c).state).toBe('pending');
  await f.w.observeReview(a.id,f.c,f.io);expect(actionStatus(f.s,f.job)?.attempts).toBe(2);
  f.w.finishReview(a.id);retryWatchdogObservation(f.s,f.job,f.now());expect(f.w.get(a.id).outcome).toBe('evaluation_uncertain');
 }finally{f.close();}
});
test('exhausted evaluation failures stay latched across polls, elapsed time and restart',()=>{
 const f=fixture(true);let second:Store|undefined;try{
  const a=f.w.scheduleReview(f.job,f.c);for(let i=0;i<WATCHDOG_LIMITS.maxEvaluationFailures;i++)f.w.finishReview(a.id);
  const stopped=f.w.get(a.id);f.advance(24*60*60*1000);
  second=new Store(f.path);const restarted=new ActionWatchdog(second,f.now,()=>0.5,f.root);
  expect(restarted.scheduleReview(f.job,f.c)).toEqual(stopped);
  retryWatchdogObservation(second,f.job,f.now());expect(restarted.scheduleReview(f.job,f.c)).toEqual(stopped);
  expect(restarted.due('p')).toEqual([]);expect(actionStatus(second,f.job)?.attempts).toBe(0);expect(f.reads()).toBe(0);
 }finally{second?.close();f.close();}
});
test('supervised review clears a same-head human blocker and bounded polling resumes',async()=>{
 const f=fixture();try{
  f.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(f.snapshot.head,f.job);
  let failed=true,sends=0;
  f.loop.io={...f.loop.io,...f.io,worktreeIdentity:async()=>({tree:'/worktree',branch:f.snapshot.branch,head:f.snapshot.head}),readiness:async()=>({head:f.snapshot.head,clear:false,reasons:[],findings:[],failedChecks:failed?[{name:'CI'}]:[],pendingChecks:failed?[]:['CI'],missingChecks:[]}) as any,sendPilotRemediation:async()=>{sends++;throw Error('Must not send');}};
  const a=f.w.scheduleReview(f.job,f.c);
  expect((await f.loop.tick(f.job,undefined,undefined,undefined,f.c,{watchdog:f.w,id:a.id})).state).toBe('observed');
  const blocked=await f.loop.tick(f.job,undefined,undefined,undefined,f.c);f.w.finishReview(a.id,blocked);
  expect(blocked.state).toBe('blocked');expect(f.w.get(a.id)).toMatchObject({state:'escalated',outcome:'human_required',attempts:1});
  expect(f.w.scheduleReview(f.job,f.c).state).toBe('escalated');
  failed=false;
  expect((await f.loop.tick(f.job,undefined,undefined,undefined,f.c)).state).toBe('waiting_for_ci');
  f.advance(WATCHDOG_LIMITS.idleMs);
  const resumed=f.w.scheduleReview(f.job,f.c);
  expect(resumed).toMatchObject({state:'pending',next_action:'observe',outcome:'scheduled',attempts:1});
  expect(resumed.id).not.toBe(a.id);expect(f.w.get(a.id).state).toBe('superseded');
  expect(f.w.due('p').map(r=>r.id)).toEqual([resumed.id]);
  expect((await f.loop.tick(f.job,undefined,undefined,undefined,f.c,{watchdog:f.w,id:resumed.id})).state).toBe('observed');
  const result=await f.loop.tick(f.job,undefined,undefined,undefined,f.c);f.w.finishReview(resumed.id,result);
  expect(result.state).toBe('waiting_for_ci');expect(actionStatus(f.s,f.job)?.attempts).toBe(2);expect(sends).toBe(0);
 }finally{f.close();}
});
test('same-binding human_required rearm still requires eligibility, no reservation and remaining budget',()=>{
 for(const guard of ['human','dependency','eligibility','reservation','budget'] as const){const f=fixture();try{
  if(guard==='eligibility'){
   const policy={mode:'ready-queue',id:'policy',authorizedBy:'human',scope:['src/**'],gitScope:'feature-pr'};Object.assign(f.c,{approval:policy});new ApprovalPolicyStore(f.s);const j=f.s.get(f.job);
   f.s.db.query('INSERT INTO queue_eligibility VALUES (?,?,?,?,?)').run(f.job,'p',digest(j.spec),1,f.now());
   f.s.db.query('INSERT INTO policy_authorizations(job,plan_hash,spec_hash,policy_hash,policy_id,authorized_by,scope) VALUES (?,?,?,?,?,?,?)').run(f.job,j.plan_hash,digest(j.spec),digest(JSON.stringify(policy)),policy.id,'human',JSON.stringify(policy.scope));
  }
  const a=f.w.scheduleReview(f.job,f.c);f.s.db.query("UPDATE review_targets SET state='blocked' WHERE job=?").run(f.job);f.w.finishReview(a.id,{state:'blocked'});
  const stopped=f.w.get(a.id);expect(stopped.outcome).toBe('human_required');
  if(guard!=='human')f.s.db.query("UPDATE review_targets SET state='waiting_for_ci' WHERE job=?").run(f.job);
  if(guard==='dependency'){f.s.db.exec('CREATE TABLE worker_outcomes(job TEXT,plan_hash TEXT,outcome TEXT)');f.s.db.query("INSERT INTO worker_outcomes VALUES (?,?,'blocked_dependency')").run(f.job,f.s.get(f.job).plan_hash);}
  if(guard==='eligibility')f.advance(120001);
  if(guard==='reservation'){f.s.db.exec('CREATE TABLE conflict_recoveries(id TEXT,job TEXT,state TEXT,worktree TEXT)');f.s.db.query("INSERT INTO conflict_recoveries VALUES ('recovery',?,'delivery_uncertain','/worktree')").run(f.job);}
  if(guard==='budget')f.s.db.query('UPDATE watchdog_budgets SET attempts=max_attempts WHERE job=?').run(f.job);
  const current=f.w.scheduleReview(f.job,f.c);
  if(guard==='eligibility'||guard==='reservation')expect(current).toMatchObject({state:'escalated',outcome:'authority_unavailable'});else expect(current).toEqual(stopped);
  expect(f.w.due('p')).toEqual([]);expect(f.reads()).toBe(0);
 }finally{f.close();}}
});
test('clearing a blocker does not automatically revive any other escalation outcome',()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);
  for(const outcome of ['evaluation_failed','unsupported','retry_exhausted','stale','recurrent_binding','authority_unavailable','budget_exhausted']){
   f.s.db.query("UPDATE watchdog_actions SET state='escalated',outcome=? WHERE id=?").run(outcome,a.id);const stopped=f.w.get(a.id);
   expect(f.w.scheduleReview(f.job,f.c)).toEqual(stopped);expect(f.w.due('p')).toEqual([]);
  }
  expect(f.reads()).toBe(0);
 }finally{f.close();}
});
test('readiness 401 recorded by the review loop can be explicitly rearmed by retry-observation CLI',async()=>{
 const f=fixture(true);try{
  let sends=0;const receipts=new ReceiptReconciliation(f.s),j=f.s.get(f.job);
  receipts.reserve({job:f.job,plan:j.plan_hash,spec:digest(j.spec),session:'session',client:'uncertain-original',attempt:'implementation'});receipts.accepted('uncertain-original');
  const original=receipts.get('uncertain-original');
  f.loop.io={...f.loop.io,...f.io,worktreeIdentity:async()=>({tree:'/worktree',branch:f.snapshot.branch,head:f.snapshot.head}),readiness:async()=>{throw readFailure('github','readiness','HTTP 401');},sendPilotRemediation:async()=>{sends++;throw Error('Must not send');}};
  const a=f.w.scheduleReview(f.job,f.c);
  expect((await f.loop.tick(f.job,undefined,undefined,undefined,f.c,{watchdog:f.w,id:a.id})).state).toBe('observed');
  const result=await f.loop.tick(f.job,undefined,undefined,undefined,f.c);f.w.finishReview(a.id,result);
  expect(result.state).toBe('blocked');expect(new RecoveryObservation(f.s).status(f.job)?.evidence.classification).toBe('authentication');
  expect(f.w.get(a.id)).toMatchObject({state:'escalated',blocker:'provider_wait',outcome:'unsupported',attempts:1});expect(f.w.get(a.id).reason).toContain('retry-observation');
  const retry=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'retry-observation',f.job],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root,ADLC_DB:f.path},stdout:'pipe',stderr:'pipe'});
  expect(retry.exitCode).toBe(0);expect(retry.stderr.toString()).toBe('');expect(JSON.parse(retry.stdout.toString())).toMatchObject({readRetry:true,mutationReplay:false});
  expect(f.w.scheduleReview(f.job,f.c)).toMatchObject({id:a.id,state:'pending',next_action:'observe',outcome:'operator_read_retry',attempts:1});
  expect(new RecoveryObservation(f.s).status(f.job)).toBeNull();expect(receipts.get('uncertain-original')).toEqual(original);expect(sends).toBe(0);
 }finally{f.close();}
});
test('a recurring superseded binding escalates visibly, without resetting its job budget',async()=>{
 const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);await f.w.observeReview(a.id,f.c,f.io);
  f.s.db.query("UPDATE review_targets SET head='new-head' WHERE job=?").run(f.job);f.w.scheduleReview(f.job,f.c);
  f.s.db.query('UPDATE review_targets SET head=NULL WHERE job=?').run(f.job);f.w.scheduleReview(f.job,f.c);
  expect(actionStatus(f.s,f.job)).toMatchObject({outcome:'recurrent_binding',nextAction:'escalate',attempts:1});
 }finally{f.close();}
});
test('stale/incomplete native evidence and configuration drift are never usable',async()=>{
 for(const mode of ['stale','incomplete','project','configuration','closed-pr'] as const){const f=fixture();try{
  const a=f.w.scheduleReview(f.job,f.c);
  await expect(f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:async()=>{
   if(mode==='stale')f.session.receiptObservation.observed=f.now()-120001;
   if(mode==='incomplete')f.session.receiptObservation.complete=false;
   if(mode==='project')f.session.session.projectId='another-project';
   if(mode==='configuration')f.c.githubRepo='different/repo';
   if(mode==='closed-pr')f.snapshot.state='closed';
   return f.session;
  }})).rejects.toThrow();expect(actionStatus(f.s,f.job)?.state).toBe('escalated');
 }finally{f.close();}}
});
test('restart after durable read reservation, before IO or after IO-before-record, permits reads only',async()=>{
 const f=fixture(true);let restarted:Store|undefined;try{
  const a=f.w.scheduleReview(f.job,f.c);
  // Persist exactly the crash boundary written by the production claim. No
  // mutation adapter exists at either side of this reservation.
  f.s.db.query("UPDATE watchdog_actions SET state='claimed',token='lost-process',lease_until=?,attempts=1,outcome='read_reserved' WHERE id=?").run(f.now()+120000,a.id);
  f.s.db.query('UPDATE watchdog_budgets SET attempts=1 WHERE job=?').run(f.job);
  restarted=new Store(f.path);const w=new ActionWatchdog(restarted,f.now,()=>0.5,f.root);
  expect(w.due('p')).toEqual([]);f.advance(120001);await w.observeReview(a.id,f.c,f.io);
  expect(actionStatus(restarted,f.job)).toMatchObject({attempts:2,outcome:'observed'});
  expect(restarted.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{restarted?.close();f.close();}
});
test('production poll separates read actions from ordinary evaluation under one fence and retains due times',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-watchdog-poll-'));
 try{
  const script=`
import {createCLIPollTick} from ${JSON.stringify(join(import.meta.dir,'../src/cli.ts'))};
import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
import {Planning} from ${JSON.stringify(join(import.meta.dir,'../src/planning.ts'))};
import {Lifecycle} from ${JSON.stringify(join(import.meta.dir,'../src/lifecycle.ts'))};
import {ReviewLoop} from ${JSON.stringify(join(import.meta.dir,'../src/review-loop.ts'))};
import {BranchUpdates,branchTransport} from ${JSON.stringify(join(import.meta.dir,'../src/branch-updates.ts'))};
import {ConflictRecovery} from ${JSON.stringify(join(import.meta.dir,'../src/conflict-recovery.ts'))};
import {existsSync} from 'node:fs';import {join} from 'node:path';import {appState} from ${JSON.stringify(join(import.meta.dir,'../src/install-state.ts'))};
const s=new Store(':memory:'),p=new Planning(s),l=new Lifecycle(s),sessions={},snapshots={},jobs={},phases=[];let reads=0,sends=0,polls=0,inAction=false,ordinaryReads=0,branchEvaluations=0;
const fail=async()=>{sends++;throw Error('Unexpected mutation');};
const loop=new ReviewLoop(s,fail,{sessionEvidence:async(id)=>{reads++;return {...sessions[id],receiptObservation:{complete:true,observed:Date.now()}};},readBranchSnapshot:async(repo,pr)=>snapshots[pr],worktreeIdentity:async(s,job)=>({tree:'/worktree-'+job,branch:jobs[job].branch,head:'a'.repeat(40)}),readiness:async()=>{if(inAction)throw Error('Read action reached readiness evaluation');ordinaryReads++;return {head:'a'.repeat(40),clear:false,reasons:['Waiting for CI'],findings:[],failedChecks:[],pendingChecks:['CI'],missingChecks:[]};},disableNativeFeedback:fail,sendPilotRemediation:fail});
for(const [object,name] of [[BranchUpdates.prototype,'ensure'],[branchTransport,'update'],[ConflictRecovery.prototype,'tick'],[loop,'requestReview'],[loop.io,'sendPilotRemediation']]){const original=object[name];object[name]=function(...args){if(inAction)throw Error('Read action reached '+name);if(name==='ensure')branchEvaluations++;return original.apply(this,args);};}
const originalTick=loop.tick.bind(loop);loop.tick=async(...args)=>{inAction=!!args[5];const phase=inAction?'observe':'review';if(!existsSync(join(appState(),'turn-submission.lock')))throw Error('Poll fence missing');try{const result=await originalTick(...args);if(inAction&&result.state!=='observed')throw Error('Read action did not return before effects');phases.push([args[0],phase]);return result;}finally{inAction=false;}};
for(let i=1;i<=6;i++){const job=s.enqueue('p','issue-'+i,'spec'),r=p.reserve(job,'ao');p.gate(job,'ao','session-'+i,r.branch,'/worktree-'+job);const hash=s.propose(job,'plan');s.approve(job,hash,'human');l.grantGit(job,hash,['inspect','commit','push-feature','open-pr'],'human');l.adoptSupervised(job,{id:'session-'+i,correlation:r.correlation,worktree:'/worktree-'+job,controller:'running'});loop.register(job,'owner/repo',i,['CI'],['src/**'],true);jobs[job]=r;sessions['session-'+i]={session:{id:'session-'+i,projectId:'ao',branch:r.branch,isTerminated:false,prs:[{number:i,url:'https://github.com/owner/repo/pull/'+i}]},transcript:{controller:'ready',entries:[],turns:[]}};snapshots[i]={head:'a'.repeat(40),base:'b'.repeat(40),headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,branch:r.branch,baseBranch:'main',defaultBranch:'main',behind:0,mergeable:true};s.db.query('UPDATE review_targets SET head=? WHERE job=?').run('a'.repeat(40),job);}
const config={linear:{projectId:'p'},githubRepo:'owner/repo',automation:{orchestratorProject:'ao'},requiredChecks:['CI']};
const tick=createCLIPollTick({config,store:s,reviewLoop:loop,workflow:{tick:async()=>[],implementation:()=>null},linearApprovals:{sync:async()=>[]},linearLifecycle:{sync:async()=>[]},features:{tickProject:async()=>[]},io:{poll:async()=>{polls++;return [];},linearToken:()=>'',out:()=>{}}});
await tick();const first=reads;await tick();const second=reads;await tick();const paired=phases.length===12&&phases.every(([job,phase],i)=>phase===(i%2?'review':'observe')&&(i%2===0||job===phases[i-1][0]));console.log(JSON.stringify({first,second,reads,sends,polls,paired,ordinaryReads,branchEvaluations,actions:s.db.query('SELECT count(*) AS n FROM watchdog_actions').get().n}));s.close();`;
  const result=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:root},stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');expect(JSON.parse(result.stdout.toString())).toEqual({first:8,second:12,reads:12,sends:0,polls:3,paired:true,ordinaryReads:6,branchEvaluations:6,actions:12});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('production poll never follows a failed or deferred read action with effectful evaluation',()=>{
 for(const mode of ['failed','deferred']){const f=fixture(true);try{
  const script=`
import {createCLIPollTick} from ${JSON.stringify(join(import.meta.dir,'../src/cli.ts'))};
import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
import {ReviewLoop} from ${JSON.stringify(join(import.meta.dir,'../src/review-loop.ts'))};
import {RecoveryObservation} from ${JSON.stringify(join(import.meta.dir,'../src/recovery-observation.ts'))};
import {readFailure} from ${JSON.stringify(join(import.meta.dir,'../src/provider-read.ts'))};
const s=new Store(${JSON.stringify(f.path)}),config=${JSON.stringify(f.c)};let actions=0,reviews=0,reads=0;
new RecoveryObservation(s);if(${JSON.stringify(mode)}==='deferred')s.db.query('INSERT INTO observation_capacity VALUES (?,?)').run('orchestrator',Date.now()+60000);
const loop=new ReviewLoop(s,async()=>{throw Error('Must not request review');},{sessionEvidence:async()=>{reads++;throw readFailure('orchestrator','session','HTTP 401');}});
const original=loop.tick.bind(loop);loop.tick=async(...args)=>{if(args[5])actions++;else{reviews++;throw Error('Failed/deferred action must not start ordinary evaluation');}return original(...args);};
const tick=createCLIPollTick({config,store:s,reviewLoop:loop,workflow:{tick:async()=>[],implementation:()=>null},linearApprovals:{sync:async()=>[]},linearLifecycle:{sync:async()=>[]},features:{tickProject:async()=>[]},io:{poll:async()=>[],linearToken:()=>'',out:()=>{}}});
await tick();await tick();console.log(JSON.stringify({actions,reviews,reads}));s.close();`;
  const result=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root},stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');expect(JSON.parse(result.stdout.toString())).toEqual({actions:1,reviews:0,reads:mode==='failed'?1:0});
  expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);expect(f.s.db.query('SELECT * FROM full_review_requests').all()).toEqual([]);
 }finally{f.close();}}
});
test('standing-policy expiry and reduced inspect grants fail closed before provider IO',async()=>{
 for(const mode of ['expired','policy-changed','inspect-removed'] as const){const f=fixture();try{
  const policy={mode:'ready-queue',id:'policy',authorizedBy:'human',scope:['src/**'],gitScope:'feature-pr'};Object.assign(f.c,{approval:policy});
  new ApprovalPolicyStore(f.s);const j=f.s.get(f.job);
  f.s.db.query('INSERT INTO queue_eligibility VALUES (?,?,?,?,?)').run(f.job,'p',digest(j.spec),1,f.now());
  f.s.db.query('INSERT INTO policy_authorizations(job,plan_hash,spec_hash,policy_hash,policy_id,authorized_by,scope) VALUES (?,?,?,?,?,?,?)').run(f.job,j.plan_hash,digest(j.spec),digest(JSON.stringify(policy)),policy.id,'human',JSON.stringify(policy.scope));
  const a=f.w.scheduleReview(f.job,f.c);expect(a.state).toBe('pending');
  if(mode==='expired')f.advance(120001);
  if(mode==='policy-changed')policy.authorizedBy='changed';
  if(mode==='inspect-removed')f.s.db.query('UPDATE git_grants SET operations=? WHERE job=?').run(JSON.stringify(['commit','push-feature','open-pr']),f.job);
  await expect(f.w.observeReview(a.id,f.c,f.io)).rejects.toThrow();expect(f.reads()).toBe(0);
 }finally{f.close();}}
});
test('existing worktree recovery reservation is an explicit unsupported state, never cleared or invoked',()=>{
 const f=fixture();try{
  f.s.db.exec('CREATE TABLE conflict_recoveries(id TEXT,job TEXT,state TEXT,worktree TEXT)');
  f.s.db.query("INSERT INTO conflict_recoveries VALUES ('recovery',?,'delivery_uncertain','/worktree')").run(f.job);
  const a=f.w.scheduleReview(f.job,f.c);expect(a).toMatchObject({state:'escalated',blocker:'unsupported'});
  expect(f.w.due('p')).toEqual([]);expect(f.s.db.query('SELECT state FROM conflict_recoveries').get()).toEqual({state:'delivery_uncertain'});expect(f.reads()).toBe(0);
 }finally{f.close();}
});
test('separate projects share the existing provider cooldown and cannot create parallel reads',async()=>{
 const f=fixture();try{
  const job=f.s.enqueue('q','issue-q','spec-q'),p=new Planning(f.s),r=p.reserve(job,'ao-q');p.gate(job,'ao-q','session-q',r.branch,'/worktree-q');const hash=f.s.propose(job,'plan-q');f.s.approve(job,hash,'human');const l=new Lifecycle(f.s);l.grantGit(job,hash,['inspect'],'human');l.adoptSupervised(job,{id:'session-q',correlation:r.correlation,worktree:'/worktree-q',controller:'running'});f.loop.register(job,'owner/repo',2,['CI'],['src/**']);
  const c={...f.c,linear:{projectId:'q'},automation:{orchestratorProject:'ao-q'}},a=f.w.scheduleReview(f.job,f.c),b=f.w.scheduleReview(job,c);
  await expect(f.w.observeReview(a.id,f.c,{...f.io,sessionEvidence:async()=>{throw readFailure('orchestrator','read','HTTP 429',1,undefined,f.now());}})).rejects.toThrow();
  await expect(f.w.observeReview(b.id,c,f.io)).rejects.toThrow('deferred');expect(f.reads()).toBe(0);
  expect(actionStatus(f.s,job)).toMatchObject({nextAction:'defer',outcome:'shared_capacity'});
 }finally{f.close();}
});

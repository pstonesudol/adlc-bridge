import {randomUUID} from 'node:crypto';
import {Store,digest} from './core';
import {latestRevision} from './spec-revisions';
import {RecoveryObservation,ObservationDeferred,transient} from './recovery-observation';
import {providerEvidence,ProviderReadError} from './provider-read';
import {assertObservationFence,ObservationLeaseLost} from './observation-fence';
import {assertConfiguredProjectIntakeEnabled} from './project-services';
import {turnBarrier,TurnSubmissionBlocked} from './turn-submission';
import {worktreeReservation} from './worktree-reservation';
import {assertDeliveryTarget} from './delivery-identity';
import {RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';
import {observeLiveness,livenessStatus} from './worker-liveness';

export type BlockerClass='ci_wait'|'reviewer_wait'|'worker_wait'|'dependency_wait'|'provider_wait'|'intake_paused'|'receipt_uncertain'|'human'|'unsupported'|'none';
export type ActionContract=
 |{kind:'observe';operation:'review-evidence'}
 |{kind:'defer';blocker:BlockerClass}
 |{kind:'invoke_supported_recovery';operation:never}
 |{kind:'escalate';blocker:BlockerClass};
export type ActionBinding=Readonly<{job:string;project:string;spec:string;revision:string|null;plan:string|null;session:string|null;owner:string|null;repo:string|null;pr:number|null;head:string|null;authority:string;ownership:string;target:string;configuration:string}>;
export type ActionRow={id:string;job:string;project:string;binding:string;next_action:'observe'|'defer'|'escalate';blocker:BlockerClass;state:'pending'|'claimed'|'escalated'|'superseded';due_at:number;attempts:number;max_attempts:number;failures:number;token:string|null;lease_until:number|null;outcome:string;reason:string;observed_at:number|null;evidence:string|null};
export const WATCHDOG_LIMITS={perTick:4,maxAttempts:240,maxFailures:6,maxEvaluationFailures:6,intervalMs:60000,idleMs:15*60000,livenessMs:30*60000,leaseMs:120000} as const;
export function evaluateAction(blocker:BlockerClass,due:number,now:number):ActionContract{
 if(['human','dependency_wait','unsupported'].includes(blocker))return {kind:'escalate',blocker};
 return due>now?{kind:'defer',blocker}:{kind:'observe',operation:'review-evidence'};
}
const has=(s:Store,table:string)=>!!s.db.query('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table);
const row=(s:Store,table:string,job:string):any=>has(s,table)?s.db.query(`SELECT * FROM ${table} WHERE job=?`).get(job):null;
const completed=(s:Store,job:string)=>s.get(job).state==='done'||row(s,'review_targets',job)?.state==='completed';
const idle=(s:Store,job:string)=>row(s,'review_targets',job)?.state==='ready_for_human'&&classifyBlocker(s,job)==='none';
const statusJSON=(text:string|null)=>{try{return text===null?null:JSON.parse(text);}catch{return null;}};

// Local snapshots contain fingerprints, never spec text, prompts, error bodies or grants.
export function actionBinding(s:Store,job:string,c:any):ActionBinding{
 const j=s.get(job),run=row(s,'runs',job),t=row(s,'review_targets',job),grant=row(s,'git_grants',job),proof=row(s,'policy_authorizations',job);
 return {job,project:j.project,spec:digest(j.spec),revision:latestRevision(s,job)?.id??null,plan:j.plan_hash??null,session:run?.session_id??null,owner:run?.owner??null,repo:t?.repo??null,pr:t?.pr??null,head:t?.head??null,
  authority:digest(JSON.stringify([j.state,j.approved_hash,j.actor,grant,proof,row(s,'ticket_approval_requirements',job)])),
  ownership:digest(JSON.stringify([run,row(s,'implementation_dispatch',job),row(s,'planning_runs',job)])),
  target:digest(JSON.stringify(t?[t.repo,t.pr,t.head,t.required_checks,t.allowed_paths,t.remediate,row(s,'review_bindings',job)]:null)),
  configuration:digest(JSON.stringify([c.linear.projectId,c.githubRepo,c.automation?.orchestratorProject,c.approval,c.requiredChecks,c.prMetadataChecks,c.branchUpdate,c.conflictRecovery,c.remediation,c.verification]))};
}
function eligibility(s:Store,job:string,c:any,now:number):boolean{
 const j=s.get(job),run=row(s,'runs',job),grant=row(s,'git_grants',job),proof=row(s,'policy_authorizations',job),t=row(s,'review_targets',job);
 if(j.project!==c.linear.projectId||j.state!=='approved'||!j.actor||!j.plan||!j.plan_hash||j.approved_hash!==j.plan_hash||digest(JSON.stringify([j.spec,j.plan]))!==j.plan_hash)return false;
 if(!run||run.owner!=='orchestrator'||run.plan_hash!==j.plan_hash||!run.session_id||!t||t.repo!==c.githubRepo||t.state==='completed')return false;
 if(!grant||grant.plan_hash!==j.plan_hash||!grant.actor)return false;
 let operations;try{operations=JSON.parse(grant.operations);}catch{return false;}
 if(!Array.isArray(operations)||!operations.includes('inspect'))return false;
 if(proof){
  const e=row(s,'queue_eligibility',job);
  if(row(s,'ticket_approval_requirements',job)?.required||!e?.ready||e.project!==j.project||e.spec_hash!==digest(j.spec)||now-e.observed>120000||e.observed>now+5000||proof.plan_hash!==j.plan_hash||proof.spec_hash!==digest(j.spec)||proof.policy_hash!==digest(JSON.stringify(c.approval??{mode:'manual'})))return false;
 }
 return true;
}
export function classifyBlocker(s:Store,job:string,retryProvider=false):BlockerClass{
 const j=s.get(job),t=row(s,'review_targets',job),o=row(s,'worker_outcomes',job),read=row(s,'recovery_observations',job);
 if(j.state!=='approved')return 'human';
 if(read){try{return transient(JSON.parse(read.reason))?'provider_wait':'human';}catch{return 'human';}}
 if(o?.plan_hash===j.plan_hash&&['needs_input','blocked_dependency','failed','uncertain'].includes(o.outcome))return o.outcome==='blocked_dependency'?'dependency_wait':o.outcome==='uncertain'?'receipt_uncertain':'human';
 if(t?.state==='needs_reconciliation')return 'receipt_uncertain';
 if(t?.state==='blocked')return retryProvider?'provider_wait':'human';
 if(t?.state==='waiting_for_ci')return 'ci_wait';
 if(['waiting_for_review','waiting_for_coderabbit'].includes(t?.state))return 'reviewer_wait';
 if(['waiting_for_worker','remediation_pending'].includes(t?.state))return 'worker_wait';
 if(t?.state==='completed')return 'human';
 return t?'none':'unsupported';
}
export function actionStatus(s:Store,job:string,now=Date.now()){
 if(!has(s,'watchdog_actions')||completed(s,job))return null;
 const r=s.db.query("SELECT * FROM watchdog_actions WHERE job=? AND state!='superseded' ORDER BY rowid DESC LIMIT 1").get(job) as ActionRow|null;
 if(!r)return null;
 const b=row(s,'watchdog_budgets',job);
 return {id:r.id,operation:'review-evidence',nextAction:r.next_action,blocker:r.blocker,state:r.state,dueAt:r.state==='escalated'?null:r.due_at,attempts:b?.attempts??r.attempts,maxAttempts:b?.max_attempts??r.max_attempts,failures:r.failures,evaluation:row(s,'watchdog_evaluations',job),liveness:livenessStatus(s,job),outcome:r.outcome,reason:r.reason,evidence:statusJSON(r.evidence),evidenceAgeMs:r.observed_at===null?null:Math.max(0,now-r.observed_at),binding:statusJSON(r.binding),freshness:'persisted-only',recoverySupported:false};
}
// Existing explicit read retry may rearm provider observations, never uncertain
// review effects, superseded actions, receipts or cumulative job budgets.
export function retryWatchdogObservation(s:Store,job:string,now=Date.now()){
 if(!has(s,'watchdog_actions'))return;
 s.db.query("UPDATE watchdog_actions SET state='pending',next_action='observe',due_at=?,failures=0,outcome='operator_read_retry',reason='Operator rearmed read-only provider observation; budget and receipts retained' WHERE job=? AND state='escalated' AND blocker='provider_wait' AND outcome IN ('unsupported','retry_exhausted')").run(now,job);
}

/** Closed read adapter: no sender, command, prompt or recovery callback exists. */
export type ReviewObservationIO={sessionEvidence:(session:string)=>Promise<any>;readBranchSnapshot:(repo:string,pr:number)=>Promise<any>};
export class ActionWatchdog{
 constructor(public s:Store,public now=Date.now,public random=Math.random,private stateRoot?:string){
  if(s.readonly)throw Error('Watchdog evaluation requires a writable store; use actionStatus for inspection');
  s.db.exec(`CREATE TABLE IF NOT EXISTS watchdog_budgets(job TEXT PRIMARY KEY REFERENCES jobs(id),attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS watchdog_evaluations(job TEXT PRIMARY KEY REFERENCES jobs(id),next_tick INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS maintenance_schedule(job TEXT PRIMARY KEY REFERENCES jobs(id),next_check INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS watchdog_actions(id TEXT PRIMARY KEY,job TEXT NOT NULL REFERENCES jobs(id),project TEXT NOT NULL,binding TEXT NOT NULL,next_action TEXT NOT NULL,blocker TEXT NOT NULL,state TEXT NOT NULL,due_at INTEGER NOT NULL,attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0,token TEXT,lease_until INTEGER,outcome TEXT NOT NULL,reason TEXT NOT NULL,observed_at INTEGER,evidence TEXT);
   CREATE INDEX IF NOT EXISTS watchdog_due ON watchdog_actions(project,state,due_at);`);
 }
 get(id:string){return this.s.db.query('SELECT * FROM watchdog_actions WHERE id=?').get(id) as ActionRow;}
 // Independent of review blocker classification and review backoff. This only
 // reserves evaluation cadence; the existing evaluator retains mutation authority.
 beginMaintenance(job:string,c:any){
  return this.s.db.transaction(()=>{
   this.s.db.query("INSERT OR IGNORE INTO maintenance_schedule(job,next_check,reason) VALUES (?,0,'Maintenance check pending')").run(job);
   const schedule=row(this.s,'maintenance_schedule',job);
   if(schedule.next_check>this.now())return false;
   let reason='';
   if(!c.branchUpdate?.enabled)reason='Automatic branch updates disabled';
   else if(!eligibility(this.s,job,c,this.now()))reason='Current approval, ownership or inspect grant unavailable';
   else if(worktreeReservation(this.s,job)&&!worktreeReservation(this.s,job)?.branchSync)reason='Conflict recovery retains the worktree reservation';
   const wait=new RecoveryObservation(this.s,this.now).wait(job);
   if(!reason&&wait)reason=wait.reason;
   if(!reason&&(schedule.attempts>=WATCHDOG_LIMITS.maxAttempts||schedule.failures>=WATCHDOG_LIMITS.maxEvaluationFailures)){
    // These are scheduling budgets, not mutation receipts or provider holds.
    // Bound repeated failures/crashes without permanently stranding a live PR.
    this.s.db.query('UPDATE maintenance_schedule SET next_check=?,attempts=0,failures=0,reason=? WHERE job=?').run(this.now()+WATCHDOG_LIMITS.idleMs,'Maintenance scheduling budget exhausted; bounded cooldown before fresh guarded evaluation',job);
    return false;
   }
   this.s.db.query('UPDATE maintenance_schedule SET next_check=?,attempts=attempts+?,reason=? WHERE job=?').run(this.now()+WATCHDOG_LIMITS.intervalMs,reason?0:1,reason||'Maintenance evaluation reserved; existing update and synchronization guards apply',job);
   return !reason;
  }).immediate();
 }
 finishMaintenance(job:string,result?:{reason?:string}){
  const schedule=row(this.s,'maintenance_schedule',job),failures=result?0:schedule.failures+1;
  this.s.db.query('UPDATE maintenance_schedule SET attempts=?,failures=?,next_check=?,reason=? WHERE job=?').run(result?0:schedule.attempts,failures,this.now()+Math.min(WATCHDOG_LIMITS.idleMs,WATCHDOG_LIMITS.intervalMs*2**Math.max(0,failures-1)),result?.reason??'Maintenance evaluation failed; receipts retained, bounded retry deferred',job);
 }
 private stop(id:string,blocker:BlockerClass,outcome:string,reason:string){this.s.db.query("UPDATE watchdog_actions SET state='escalated',next_action='escalate',blocker=?,outcome=?,reason=?,token=NULL,lease_until=NULL,due_at=MAX(due_at,?) WHERE id=?").run(blocker,outcome,reason,outcome==='human_required'?this.now()+WATCHDOG_LIMITS.idleMs:0,id);}
 scheduleReview(job:string,c:any){
  return this.s.db.transaction(()=>{
   const binding=actionBinding(this.s,job,c),encoded=JSON.stringify(binding),id=digest(JSON.stringify(['review-evidence',binding]));
   this.s.db.query('INSERT OR IGNORE INTO watchdog_budgets VALUES (?,0,?)').run(job,WATCHDOG_LIMITS.maxAttempts);
   this.s.db.query('INSERT OR IGNORE INTO watchdog_evaluations VALUES (?,0,0)').run(job);
   const budget=row(this.s,'watchdog_budgets',job),blocker=classifyBlocker(this.s,job,this.get(id)?.outcome==='operator_read_retry');
   this.s.db.query("UPDATE watchdog_actions SET state='superseded',token=NULL,lease_until=NULL,outcome='binding_changed',reason='Binding changed; stale evidence discarded' WHERE job=? AND id!=? AND state!='superseded'").run(job,id);
   this.s.db.query("INSERT OR IGNORE INTO watchdog_actions(id,job,project,binding,next_action,blocker,state,due_at,attempts,max_attempts,outcome,reason) VALUES (?,?,?,?,?,?,'pending',?,?,?,'scheduled','Read-only review evidence observation')").run(id,job,binding.project,encoded,'observe',blocker,this.now(),budget.attempts,budget.max_attempts);
   // A recurring hash must not revive a superseded claim (including A -> B -> A).
   const old=this.get(id);
   if(old.state==='superseded'){this.stop(id,'human','recurrent_binding','A superseded binding recurred; inspect history rather than reviving its old claim');return this.get(id);}
   if(row(this.s,'watchdog_evaluations',job).failures>=WATCHDOG_LIMITS.maxEvaluationFailures){this.stop(id,'unsupported','evaluation_failed','Consecutive ordinary review failures exhausted; inspect existing receipts before supervised tick-review');return this.get(id);}
   if(old.state==='escalated'){
    if(old.outcome!=='human_required')return old;
     if(!eligibility(this.s,job,c,this.now())||worktreeReservation(this.s,job)&&!worktreeReservation(this.s,job)?.branchSync){this.stop(id,'unsupported','authority_unavailable','Ordinary review suspended: current authority or worktree reservation prevents evaluation');return this.get(id);}
    // Only a cleared human blocker may resume observations on the same binding.
    // Uncertain effects and every other escalation remain terminal here.
    if(evaluateAction(blocker,0,this.now()).kind==='escalate'||budget.attempts>=budget.max_attempts)return old;
    this.s.db.query("UPDATE watchdog_actions SET state='pending',next_action='observe',blocker=?,due_at=?,outcome='blocker_cleared',reason='Recorded blocker cleared; authorized read-only observation resumed; budgets and receipts retained' WHERE id=? AND state='escalated' AND outcome='human_required'").run(blocker,this.now(),id);
    return this.get(id);
   }
   if(!eligibility(this.s,job,c,this.now()))this.stop(id,'human','authority_unavailable','Inspect current plan, ownership and inspect grant; no authority inferred');
   else if(worktreeReservation(this.s,job)&&!worktreeReservation(this.s,job)?.branchSync)this.stop(id,'unsupported','unsupported','Conflict recovery retains the worktree reservation; inspect recovery-status through the existing recovery interface');
   else if(evaluateAction(blocker,old.due_at,this.now()).kind==='escalate'&&!row(this.s,'watchdog_evaluations',job).failures)this.stop(id,blocker,blocker==='unsupported'?'unsupported':'human_required','Existing blocker requires attention; bounded ordinary review may observe changed evidence; automatic recovery is unsupported');
   else if(!idle(this.s,job)&&budget.attempts>=budget.max_attempts)this.stop(id,blocker,'budget_exhausted','Automatic observation budget exhausted; inspect jobs status and use an explicit supervised tick-review after resolving the blocker');
   return this.get(id);
  }).immediate();
 }
  finishReview(id:string,result?:{state?:string;reason?:string},evaluated=true){
  const a=this.get(id);if(!a||a.state==='superseded'||a.state==='escalated'&&!['human_required','recurrent_binding'].includes(a.outcome)||completed(this.s,a.job))return;
  const blocker=classifyBlocker(this.s,a.job),read=row(this.s,'recovery_observations',a.job);
  // Observation success must never reset consecutive effectful evaluation failures.
  if(evaluated){
   const failures=result?.state?0:row(this.s,'watchdog_evaluations',a.job).failures+1;
   const slow=a.state==='escalated'||idle(this.s,a.job)||['human','dependency_wait','unsupported'].includes(blocker);
     // Current-head age, not lifetime observation reservations, sets the wait
     // cadence: at ages 0, 1, 3, 7 and 15 minutes, delay 1, 2, 4, 8 and 15.
     const age=Math.max(0,this.now()-(row(this.s,'review_targets',a.job)?.head_since??this.now()));
     const steps=Math.min(4,Math.floor(Math.log2(1+age/WATCHDOG_LIMITS.intervalMs)));
     const live=livenessStatus(this.s,a.job),liveAge=live?Math.max(0,this.now()-live.since):0;
     const liveSteps=Math.min(4,Math.floor(Math.log2(1+liveAge/WATCHDOG_LIMITS.intervalMs)));
     const waitBackoff=result?.state==='waiting_for_ci'&&result.reason?.includes(': transient;')?Math.min(WATCHDOG_LIMITS.idleMs,WATCHDOG_LIMITS.intervalMs*2**steps):result?.state==='waiting_for_worker'&&live&&['busy','idle_no_delivery'].includes(live.classification)?Math.min(WATCHDOG_LIMITS.idleMs,WATCHDOG_LIMITS.intervalMs*2**liveSteps):WATCHDOG_LIMITS.intervalMs;
    const delay=failures?Math.min(WATCHDOG_LIMITS.idleMs,WATCHDOG_LIMITS.intervalMs*2**(failures-1)):slow?WATCHDOG_LIMITS.idleMs:waitBackoff;
   this.s.db.query('UPDATE watchdog_evaluations SET failures=?,next_tick=? WHERE job=?').run(failures,this.now()+delay,a.job);
   if(failures){
    if(failures>=WATCHDOG_LIMITS.maxEvaluationFailures)this.stop(id,'unsupported','evaluation_failed','Consecutive ordinary review failures exhausted; inspect existing receipts before supervised tick-review');
    else this.s.db.query("UPDATE watchdog_actions SET state='pending',next_action='defer',due_at=?,outcome='evaluation_uncertain',reason='Ordinary review deferred after an exception; fresh evaluation retains all mutation receipts',token=NULL,lease_until=NULL WHERE id=?").run(this.now()+delay,id);
    return;
   }
  }
  if(!result?.state)return;
  if(a.outcome==='recurrent_binding')return; // only a fresh binding may replace this historical claim
  const live=livenessStatus(this.s,a.job);
  if(result.state==='blocked'&&live&&['terminated','stuck','unknown'].includes(live.classification)){this.stop(id,'human',`worker_${live.classification}`,result.reason??'Worker requires inspection');return;}
  if(read&&['human','unsupported'].includes(blocker)){this.stop(id,'provider_wait','unsupported','Provider read failure requires inspection; use retry-observation JOB after correcting access; no mutation replay');return;}
  if(['human','dependency_wait','unsupported'].includes(blocker)){this.stop(id,blocker,'human_required','Existing review or worker blocker requires human inspection; automatic recovery is unsupported');return;}
  this.s.db.query("UPDATE watchdog_actions SET due_at=MAX(due_at,?),blocker=? WHERE id=? AND state='pending'").run(Math.max(this.now()+(idle(this.s,a.job)?WATCHDOG_LIMITS.idleMs:WATCHDOG_LIMITS.intervalMs),read?.next_read??0),blocker,id);
 }
 // Reserve cadence before entering the separate ordinary evaluator. The outer
 // poll fence and ReviewLoop's lease still serialize all mutation entrypoints.
 beginReview(id:string,c:any){
  return this.s.db.transaction(()=>{
   const a=this.get(id);if(!a||completed(this.s,a.job)||a.state==='superseded'||a.state==='claimed'||a.state==='escalated'&&(!['human_required','recurrent_binding'].includes(a.outcome)||a.due_at>this.now()))return false;
   this.assertCurrent(a,c);
   return this.s.db.query('UPDATE watchdog_evaluations SET next_tick=? WHERE job=? AND next_tick<=? AND failures<?').run(this.now()+(a.state==='escalated'||idle(this.s,a.job)?WATCHDOG_LIMITS.idleMs:WATCHDOG_LIMITS.intervalMs),a.job,this.now(),WATCHDOG_LIMITS.maxEvaluationFailures).changes===1;
  }).immediate();
 }
 due(project:string,limit:number=WATCHDOG_LIMITS.perTick,includeHuman=false):ActionRow[]{
  if(!Number.isSafeInteger(limit)||limit<1||limit>WATCHDOG_LIMITS.perTick)throw Error('Invalid bounded watchdog batch');
  // Retained actions are history once their job/target completes, even if they
  // were pending before completion. Neither polling nor status revives them.
  const reviewFilter=has(this.s,'review_targets')?"AND NOT EXISTS (SELECT 1 FROM review_targets t WHERE t.job=a.job AND t.state='completed')":'';
  const humanFilter=includeHuman?"OR (a.state='escalated' AND a.outcome IN ('human_required','recurrent_binding'))":'';
  return this.s.db.query(`SELECT a.* FROM watchdog_actions a JOIN jobs j ON j.id=a.job LEFT JOIN watchdog_evaluations e ON e.job=a.job WHERE a.project=? AND j.state!='done' ${reviewFilter} AND (a.state='pending' OR (a.state='claimed' AND a.lease_until<=?) ${humanFilter}) AND a.due_at<=? AND COALESCE(e.next_tick,0)<=? AND COALESCE(e.failures,0)<? ORDER BY MAX(a.due_at,COALESCE(e.next_tick,0)),a.id LIMIT ?`).all(project,this.now(),this.now(),this.now(),WATCHDOG_LIMITS.maxEvaluationFailures,limit) as ActionRow[];
 }
 assertReviewAction(id:string,job:string,c:any){
  const a=this.get(id);if(!a||a.job!==job||!['pending','claimed'].includes(a.state))throw new UnsupportedAction();
  this.assertCurrent(a,c);
  if(a.due_at>this.now()||a.state==='claimed'&&(a.lease_until??Infinity)>this.now())throw new ObservationDeferred(Math.max(a.due_at,a.lease_until??0));
 }
 private assertCurrent(a:ActionRow,c:any){
  assertObservationFence();
  try{assertConfiguredProjectIntakeEnabled(c,this.s,this.stateRoot);}catch(error){if(error instanceof TurnSubmissionBlocked)throw new ObservationDeferred(this.now()+WATCHDOG_LIMITS.intervalMs,'Project intake paused; observation deferred');throw error;}
  if(turnBarrier(this.stateRoot).isPaused())throw new ObservationDeferred(this.now()+WATCHDOG_LIMITS.intervalMs,'Intake paused; observation deferred');
  if(JSON.stringify(actionBinding(this.s,a.job,c))!==a.binding||!eligibility(this.s,a.job,c,this.now()))throw new StaleAction();
   // DEV-94's retained sync reservation is consumed only by the ordinary
   // evaluator's existing BranchSync guards, never by this read-only action.
   if(worktreeReservation(this.s,a.job)&&!worktreeReservation(this.s,a.job)?.branchSync)throw new UnsupportedAction();
 }
 async observeReview(id:string,c:any,io:ReviewObservationIO):Promise<{session:any;snapshot:any}>{
  const observations=new RecoveryObservation(this.s,this.now,this.random),token=randomUUID();
  const pending=this.get(id);
  if(pending?.state==='pending')try{this.assertCurrent(pending,c);}catch(error){
   if(error instanceof ObservationDeferred)this.s.db.query("UPDATE watchdog_actions SET due_at=?,next_action='defer',blocker='intake_paused',outcome='paused',reason='Intake paused; no provider read or mutation' WHERE id=? AND state='pending'").run(error.nextRead,id);
   else this.stop(id,'human','stale','Binding, authority or recovery reservation changed; inspect before further observation');
   throw error;
  }
  const a=this.s.db.transaction(()=>{
   const a=this.get(id);if(!a||a.state==='escalated'||a.state==='superseded')throw new UnsupportedAction();
   this.assertCurrent(a,c);
    if(a.due_at>this.now()||a.state==='claimed'&&(a.lease_until??Infinity)>this.now())throw new ObservationDeferred(Math.max(a.due_at,a.lease_until??0));
   const budget=row(this.s,'watchdog_budgets',a.job);
   const charge=idle(this.s,a.job)?0:1;
   if(charge&&budget.attempts>=budget.max_attempts){this.stop(id,a.blocker,'budget_exhausted','Observation budget exhausted; inspect jobs status; explicit supervised review remains available');return null;}
   // Non-idle reservations consume budget even if the process exits before IO.
   this.s.db.query('UPDATE watchdog_budgets SET attempts=attempts+? WHERE job=?').run(charge,a.job);
   this.s.db.query("UPDATE watchdog_actions SET state='claimed',next_action='observe',token=?,lease_until=?,attempts=?,outcome='read_reserved',reason='Only read-only provider observation reserved' WHERE id=?").run(token,this.now()+WATCHDOG_LIMITS.leaseMs,budget.attempts+charge,id);
   return this.get(id);
  }).immediate();
  if(!a)throw new UnsupportedAction();
  const parent=()=>this.assertCurrent(a,c);
  const check=()=>{parent();const current=this.get(id);if(current.token!==token||current.state!=='claimed'||(current.lease_until??0)<=this.now())throw new ObservationLeaseLost();};
  const binding=JSON.parse(a.binding) as ActionBinding;
  try{
   // Provider calls are sequential and use the existing shared capacity limiter.
   check();
   const session=await observations.read(a.job,'orchestrator',async()=>{try{const result=await io.sessionEvidence(binding.session!);check();return result;}catch(error){check();throw error;}},false);
   check();
   const snapshot=await observations.read(a.job,'github',async()=>{try{const result=await io.readBranchSnapshot(binding.repo!,binding.pr!);check();return result;}catch(error){check();throw error;}},false);
   check();
   if(session?.session?.id!==binding.session||typeof session.session.isTerminated!=='boolean'||session.session.projectId!==row(this.s,'planning_runs',a.job)?.project||!Array.isArray(session.transcript?.turns)||!Array.isArray(session.transcript?.entries)||(session.session.isTerminated!==true&&!session.session.prs?.some((p:any)=>p.number===binding.pr&&p.url===`https://github.com/${binding.repo}/pull/${binding.pr}`))||snapshot?.headRepo!==binding.repo||snapshot?.baseRepo!==binding.repo||snapshot?.state!=='open'||!/^[a-f0-9]{40,64}$/i.test(snapshot?.head??''))throw new UnsupportedAction();
   const observed=session.receiptObservation?.observed;
   if(session.receiptObservation?.complete!==true||!Number.isSafeInteger(observed)||observed>this.now()||this.now()-observed>RECEIPT_FRESHNESS_MS)throw new UnsupportedAction();
   assertDeliveryTarget(this.s,a.job,session.session,binding.repo!,binding.pr!,snapshot);
   observeLiveness(this.s,a.job,session,snapshot.head,WATCHDOG_LIMITS.livenessMs,this.now());
   const activity=session.transcript.turns.some((t:any)=>['running','queued'].includes(t.state))?'active_or_queued':session.transcript.controller==='ready'?'idle':'unknown';
   this.s.db.query("UPDATE watchdog_actions SET state='pending',next_action='defer',due_at=?,token=NULL,lease_until=NULL,failures=0,outcome='observed',reason='Fresh observation only; existing review and receipt gates still apply',observed_at=?,evidence=? WHERE id=? AND token=?").run(this.now()+(idle(this.s,a.job)?WATCHDOG_LIMITS.idleMs:WATCHDOG_LIMITS.intervalMs),this.now(),JSON.stringify({version:1,source:'session-and-branch',activity,head:snapshot.head,mutationAuthority:false}),id,token);
   return {session,snapshot};
  }catch(error){
   // Never persist raw provider errors, transcript content or untrusted prose.
   const current=this.get(id);
   if(current.token===token){
    if(error instanceof StaleAction||error instanceof ObservationLeaseLost)this.stop(id,'human','stale','Binding or observation lease changed; discard evidence and inspect the current owner');
    else if(error instanceof ObservationDeferred){this.defer(id,token,error.nextRead,'provider_wait','shared_capacity',current.failures);}
    else{
      const evidence=providerEvidence(error),failures=current.failures+1;
      this.s.db.query('UPDATE watchdog_actions SET failures=?,observed_at=?,evidence=? WHERE id=? AND token=?').run(failures,this.now(),JSON.stringify({version:1,source:'provider-read',provider:evidence?.provider??'unknown',classification:evidence?.classification??'unknown',mutationAuthority:false}),id,token);
     if(evidence&&transient(evidence)&&failures<WATCHDOG_LIMITS.maxFailures){
      const next=observations.status(a.job)?.next_read??this.now()+1000;
      this.defer(id,token,next,'provider_wait',evidence.classification,failures);
     }else this.stop(id,evidence?'provider_wait':'unsupported',failures>=WATCHDOG_LIMITS.maxFailures?'retry_exhausted':'unsupported','Read unavailable or retries exhausted; inspect provider access and existing recovery status; no mutation replay');
    }
   }
   if(error instanceof StaleAction||error instanceof ObservationLeaseLost||error instanceof ObservationDeferred)throw error;
   const evidence=providerEvidence(error);
   if(evidence)throw new ProviderReadError({...evidence,operation:'watchdog-observation',detail:'Provider diagnostic omitted'});
   throw new UnsupportedAction();
  }
 }
 private defer(id:string,token:string,due:number,blocker:BlockerClass,outcome:string,failures:number){this.s.db.query("UPDATE watchdog_actions SET state='pending',next_action='defer',due_at=?,token=NULL,lease_until=NULL,blocker=?,outcome=?,reason='Read-only retry deferred; existing shared provider limits apply',failures=? WHERE id=? AND token=?").run(due,blocker,outcome,failures,id,token);}
}
export class StaleAction extends Error{constructor(){super('Watchdog binding or authority changed; discard evidence without sending');}}
export class UnsupportedAction extends Error{constructor(){super('Watchdog action requires human inspection; recovery is unsupported');}}

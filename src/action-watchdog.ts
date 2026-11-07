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

export type BlockerClass='ci_wait'|'reviewer_wait'|'worker_wait'|'dependency_wait'|'provider_wait'|'intake_paused'|'receipt_uncertain'|'human'|'unsupported'|'none';
export type ActionContract=
 |{kind:'observe';operation:'review-evidence'}
 |{kind:'defer';blocker:BlockerClass}
 |{kind:'invoke_supported_recovery';operation:never}
 |{kind:'escalate';blocker:BlockerClass};
export type ActionBinding=Readonly<{job:string;project:string;spec:string;revision:string|null;plan:string|null;session:string|null;owner:string|null;repo:string|null;pr:number|null;head:string|null;authority:string;ownership:string;target:string;configuration:string}>;
export type ActionRow={id:string;job:string;project:string;binding:string;next_action:'observe'|'defer'|'escalate';blocker:BlockerClass;state:'pending'|'claimed'|'escalated'|'superseded';due_at:number;attempts:number;max_attempts:number;failures:number;token:string|null;lease_until:number|null;outcome:string;reason:string;observed_at:number|null;evidence:string|null};
export const WATCHDOG_LIMITS={perTick:4,maxAttempts:240,maxFailures:6,intervalMs:60000,leaseMs:120000} as const;
export function evaluateAction(blocker:BlockerClass,due:number,now:number):ActionContract{
 if(['human','dependency_wait','unsupported'].includes(blocker))return {kind:'escalate',blocker};
 return due>now?{kind:'defer',blocker}:{kind:'observe',operation:'review-evidence'};
}
const has=(s:Store,table:string)=>!!s.db.query('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table);
const row=(s:Store,table:string,job:string):any=>has(s,table)?s.db.query(`SELECT * FROM ${table} WHERE job=?`).get(job):null;
const completed=(s:Store,job:string)=>s.get(job).state==='done'||row(s,'review_targets',job)?.state==='completed';
const statusJSON=(text:string|null)=>{try{return text===null?null:JSON.parse(text);}catch{return null;}};

// Local snapshots contain fingerprints, never spec text, prompts, error bodies or grants.
export function actionBinding(s:Store,job:string,c:any):ActionBinding{
 const j=s.get(job),run=row(s,'runs',job),t=row(s,'review_targets',job),grant=row(s,'git_grants',job),proof=row(s,'policy_authorizations',job);
 return {job,project:j.project,spec:digest(j.spec),revision:latestRevision(s,job)?.id??null,plan:j.plan_hash??null,session:run?.session_id??null,owner:run?.owner??null,repo:t?.repo??null,pr:t?.pr??null,head:t?.head??null,
  authority:digest(JSON.stringify([j.state,j.approved_hash,j.actor,grant,proof,row(s,'ticket_approval_requirements',job)])),
  ownership:digest(JSON.stringify([run,row(s,'implementation_dispatch',job),row(s,'planning_runs',job)])),
  target:digest(JSON.stringify(t?[t.repo,t.pr,t.head,t.required_checks,t.allowed_paths,t.remediate]:null)),
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
 return {id:r.id,operation:'review-evidence',nextAction:r.next_action,blocker:r.blocker,state:r.state,dueAt:r.state==='escalated'?null:r.due_at,attempts:b?.attempts??r.attempts,maxAttempts:b?.max_attempts??r.max_attempts,failures:r.failures,outcome:r.outcome,reason:r.reason,evidence:statusJSON(r.evidence),evidenceAgeMs:r.observed_at===null?null:Math.max(0,now-r.observed_at),binding:statusJSON(r.binding),freshness:'persisted-only',recoverySupported:false};
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
   CREATE TABLE IF NOT EXISTS watchdog_actions(id TEXT PRIMARY KEY,job TEXT NOT NULL REFERENCES jobs(id),project TEXT NOT NULL,binding TEXT NOT NULL,next_action TEXT NOT NULL,blocker TEXT NOT NULL,state TEXT NOT NULL,due_at INTEGER NOT NULL,attempts INTEGER NOT NULL,max_attempts INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0,token TEXT,lease_until INTEGER,outcome TEXT NOT NULL,reason TEXT NOT NULL,observed_at INTEGER,evidence TEXT);
   CREATE INDEX IF NOT EXISTS watchdog_due ON watchdog_actions(project,state,due_at);`);
 }
 get(id:string){return this.s.db.query('SELECT * FROM watchdog_actions WHERE id=?').get(id) as ActionRow;}
 private stop(id:string,blocker:BlockerClass,outcome:string,reason:string){this.s.db.query("UPDATE watchdog_actions SET state='escalated',next_action='escalate',blocker=?,outcome=?,reason=?,token=NULL,lease_until=NULL WHERE id=?").run(blocker,outcome,reason,id);}
 scheduleReview(job:string,c:any){
  return this.s.db.transaction(()=>{
   const binding=actionBinding(this.s,job,c),encoded=JSON.stringify(binding),id=digest(JSON.stringify(['review-evidence',binding]));
   this.s.db.query('INSERT OR IGNORE INTO watchdog_budgets VALUES (?,0,?)').run(job,WATCHDOG_LIMITS.maxAttempts);
   const budget=row(this.s,'watchdog_budgets',job),blocker=classifyBlocker(this.s,job,this.get(id)?.outcome==='operator_read_retry');
   this.s.db.query("UPDATE watchdog_actions SET state='superseded',token=NULL,lease_until=NULL,outcome='binding_changed',reason='Binding changed; stale evidence discarded' WHERE job=? AND id!=? AND state!='superseded'").run(job,id);
   this.s.db.query("INSERT OR IGNORE INTO watchdog_actions(id,job,project,binding,next_action,blocker,state,due_at,attempts,max_attempts,outcome,reason) VALUES (?,?,?,?,?,?,'pending',?,?,?,'scheduled','Read-only review evidence observation')").run(id,job,binding.project,encoded,'observe',blocker,this.now(),budget.attempts,budget.max_attempts);
   // A recurring hash must not revive a superseded claim (including A -> B -> A).
   const old=this.get(id);
   if(old.state==='superseded'){this.stop(id,'human','recurrent_binding','A superseded binding recurred; inspect history rather than reviving its old claim');return this.get(id);}
   if(old.state==='escalated'){
    // Only a cleared human blocker may resume observations on the same binding.
    // Uncertain effects and every other escalation remain terminal here.
    if(old.outcome!=='human_required'||evaluateAction(blocker,0,this.now()).kind==='escalate'||!eligibility(this.s,job,c,this.now())||worktreeReservation(this.s,job)||budget.attempts>=budget.max_attempts)return old;
    this.s.db.query("UPDATE watchdog_actions SET state='pending',next_action='observe',blocker=?,due_at=?,outcome='blocker_cleared',reason='Recorded blocker cleared; authorized read-only observation resumed; budgets and receipts retained' WHERE id=? AND state='escalated' AND outcome='human_required'").run(blocker,this.now(),id);
    return this.get(id);
   }
   if(!eligibility(this.s,job,c,this.now()))this.stop(id,'human','authority_unavailable','Inspect current plan, ownership and inspect grant; no authority inferred');
   else if(worktreeReservation(this.s,job))this.stop(id,'unsupported','unsupported','Conflict recovery retains the worktree reservation; inspect recovery-status through the existing recovery interface');
   else if(evaluateAction(blocker,old.due_at,this.now()).kind==='escalate')this.stop(id,blocker,'unsupported','Use the existing approval, clarification, dependency or recovery inspection; automatic recovery is unsupported');
   else if(budget.attempts>=budget.max_attempts)this.stop(id,blocker,'budget_exhausted','Automatic observation budget exhausted; inspect jobs status and use an explicit supervised tick-review after resolving the blocker');
   return this.get(id);
  }).immediate();
 }
 finishReview(id:string,result?:{state?:string}){
  // The surrounding tick is effectful. Never retry a thrown/unknown evaluation
  // as though it were a read failure; existing receipts remain authoritative.
  const a=this.get(id);if(!a||a.state==='superseded'||a.state==='escalated'||completed(this.s,a.job))return;
  if(!result?.state){this.stop(id,'unsupported','evaluation_uncertain','Review evaluation did not settle; inspect existing receipts and recovery status before an explicit supervised tick-review');return;}
  const blocker=classifyBlocker(this.s,a.job),read=row(this.s,'recovery_observations',a.job);
  if(read&&['human','unsupported'].includes(blocker)){this.stop(id,'provider_wait','unsupported','Provider read failure requires inspection; use retry-observation JOB after correcting access; no mutation replay');return;}
  if(['human','dependency_wait','unsupported'].includes(blocker)){this.stop(id,blocker,'human_required','Existing review or worker blocker requires human inspection; automatic recovery is unsupported');return;}
  this.s.db.query("UPDATE watchdog_actions SET due_at=MAX(due_at,?),blocker=? WHERE id=? AND state='pending'").run(Math.max(this.now()+WATCHDOG_LIMITS.intervalMs,read?.next_read??0),blocker,id);
 }
 due(project:string,limit:number=WATCHDOG_LIMITS.perTick):ActionRow[]{
  if(!Number.isSafeInteger(limit)||limit<1||limit>WATCHDOG_LIMITS.perTick)throw Error('Invalid bounded watchdog batch');
  // Retained actions are history once their job/target completes, even if they
  // were pending before completion. Neither polling nor status revives them.
  const reviewFilter=has(this.s,'review_targets')?"AND NOT EXISTS (SELECT 1 FROM review_targets t WHERE t.job=a.job AND t.state='completed')":'';
  return this.s.db.query(`SELECT a.* FROM watchdog_actions a JOIN jobs j ON j.id=a.job WHERE a.project=? AND j.state!='done' ${reviewFilter} AND (a.state='pending' OR (a.state='claimed' AND a.lease_until<=?)) AND a.due_at<=? ORDER BY a.due_at,a.id LIMIT ?`).all(project,this.now(),this.now(),limit) as ActionRow[];
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
  if(worktreeReservation(this.s,a.job))throw new UnsupportedAction();
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
   if(budget.attempts>=budget.max_attempts){this.stop(id,a.blocker,'budget_exhausted','Observation budget exhausted; inspect jobs status; explicit supervised review remains available');return null;}
   // Reservation consumes budget even if the process exits before the read.
   this.s.db.query('UPDATE watchdog_budgets SET attempts=attempts+1 WHERE job=?').run(a.job);
   this.s.db.query("UPDATE watchdog_actions SET state='claimed',next_action='observe',token=?,lease_until=?,attempts=?,outcome='read_reserved',reason='Only read-only provider observation reserved' WHERE id=?").run(token,this.now()+WATCHDOG_LIMITS.leaseMs,budget.attempts+1,id);
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
   if(session?.session?.id!==binding.session||session.session.isTerminated!==false||session.session.projectId!==row(this.s,'planning_runs',a.job)?.project||!Array.isArray(session.transcript?.turns)||!Array.isArray(session.transcript?.entries)||!session.session.prs?.some((p:any)=>p.number===binding.pr&&p.url===`https://github.com/${binding.repo}/pull/${binding.pr}`)||snapshot?.headRepo!==binding.repo||snapshot?.baseRepo!==binding.repo||snapshot?.state!=='open'||!/^[a-f0-9]{40,64}$/i.test(snapshot?.head??''))throw new UnsupportedAction();
   const observed=session.receiptObservation?.observed;
   if(session.receiptObservation?.complete!==true||!Number.isSafeInteger(observed)||observed>this.now()||this.now()-observed>RECEIPT_FRESHNESS_MS)throw new UnsupportedAction();
   assertDeliveryTarget(this.s,a.job,session.session,binding.repo!,binding.pr!,snapshot);
   const activity=session.transcript.turns.some((t:any)=>['running','queued'].includes(t.state))?'active_or_queued':session.transcript.controller==='ready'?'idle':'unknown';
   this.s.db.query("UPDATE watchdog_actions SET state='pending',next_action='defer',due_at=?,token=NULL,lease_until=NULL,failures=0,outcome='observed',reason='Fresh observation only; existing review and receipt gates still apply',observed_at=?,evidence=? WHERE id=? AND token=?").run(this.now()+WATCHDOG_LIMITS.intervalMs,this.now(),JSON.stringify({version:1,source:'session-and-branch',activity,head:snapshot.head,mutationAuthority:false}),id,token);
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

import {Store,digest} from './core';
import type {Workflow,WorkflowConfig} from './workflow';
import {DeliveryRecovery} from './delivery-recovery';
import {ApprovalPolicyStore,featureGit} from './approval-policy';
import {ReceiptReconciliation,RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';
import {restoreRepository,restoreConfig} from './planning-restore';
import {assertWorktreeAvailable,canonicalWorktree} from './worktree-reservation';
import {assertConfiguredProjectIntakeEnabled} from './project-services';
import {assertCurrentPlanningRequirements} from './spec-recovery';
import {WORKER_STATUS_INSTRUCTION} from './readiness';
import {verificationInstructions} from './verification';
import {assertRequiredIntegrations} from './integration-capabilities';
import {capturedRevision,currentDispatchContinuation,currentOutcome} from './spec-revisions';
import {PreSendFailure} from './pre-send';

export type RecoveryResult={job:string;outcome:'reattached'|'resumed'|'waiting'|'blocked';nextAction:string;state?:string};
export type RecoverySummary={complete:boolean;admit:boolean;results:RecoveryResult[];reattached:number;resumed:number;waiting:number;blocked:number;reason?:string};
export function ensureStartupRecovery(s:Store){s.db.exec(`
 CREATE TABLE IF NOT EXISTS startup_recovery_results(job TEXT PRIMARY KEY REFERENCES jobs(id),outcome TEXT NOT NULL,next_action TEXT NOT NULL,failures INTEGER NOT NULL,next_read INTEGER NOT NULL,observed INTEGER NOT NULL,plan_hash TEXT,spec_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS startup_restores(binding TEXT PRIMARY KEY,job TEXT NOT NULL REFERENCES jobs(id),session TEXT NOT NULL,worktree TEXT NOT NULL,state TEXT NOT NULL,proof TEXT NOT NULL,reason TEXT);
 CREATE TABLE IF NOT EXISTS startup_continuations(job TEXT NOT NULL REFERENCES jobs(id),dispatch TEXT NOT NULL,continuation INTEGER NOT NULL,PRIMARY KEY(job,dispatch));`);}
const has=(s:Store,t:string)=>!!s.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
const row=(s:Store,t:string,job:string):any=>has(s,t)?s.db.query(`SELECT * FROM ${t} WHERE job=?`).get(job):null;
const terminal=new Set(['completed','recovered','failed','cancelled','interrupted']);
function retained(e:any){
 const at=e.receiptObservation?.observed,age=Date.now()-at;
 if(e.receiptObservation?.complete!==true||!Number.isFinite(at)||age<0||age>RECEIPT_FRESHNESS_MS||!Array.isArray(e.transcript?.turns)||!Array.isArray(e.transcript?.entries)||new Set(e.transcript.turns.map((t:any)=>t.id)).size!==e.transcript.turns.length)throw Error('Fresh complete authoritative delivery inventory required; refresh without resending');
 return digest(JSON.stringify({entries:e.transcript.entries,turns:e.transcript.turns}));
}
export function startupAuthorization(s:Store,job:string,c:WorkflowConfig,binding?:string){
 assertRequiredIntegrations(c);
 assertConfiguredProjectIntakeEnabled(c,s);
 assertWorktreeAvailable(s,job,undefined,binding);
 const auth=new DeliveryRecovery(s,{} as any).authorization(job,c),run=row(s,'runs',job),d=row(s,'implementation_dispatch',job);
 if(!capturedRevision(s,job,d.plan_hash,d.session_id).captured)throw Error('Exact current captured revision required before startup recovery');
 if(d.runtime!=='supervised-host'||run.state!=='running'||featureGit.some(op=>!JSON.parse(auth.grant).includes(op)))throw Error('Unchanged running supervised-host authorization and complete scoped feature Git grant required');
 const policy=new ApprovalPolicyStore(s);policy.verify(job,c.linear.projectId,c.approval);
 const proof=policy.get(job);if(proof&&proof.scope!==d.paths)throw Error('Current approved scope differs from dispatch');
 const owner=has(s,'ownership')?s.db.query('SELECT owner FROM ownership WHERE session_id=?').get(auth.session) as any:null;
 if(owner&&owner.owner!=='orchestrator')throw Error('Worker is human-owned; explicit handback required');
 const outcome=row(s,'worker_outcomes',job);
  if(currentOutcome(s,job,outcome)&&['needs_input','blocked_dependency','uncertain'].includes(outcome.outcome))throw Error('Preserve the recorded worker blocker; use resume-job/dependency-preview after its required resolution');
 const budget=row(s,'remediation_budget',job);if(budget?.stop_reason)throw Error('Preserve the existing budget stop; explicit budget recovery required');
 for(const [table,states] of [
  ['branch_updates',['delivery_uncertain','accepted']],['remediation',['reserved','delivery_uncertain']],['delivery_adoptions',['reserved','claim_uncertain']]
 ] as [string,string[]][]){
  if(has(s,table)&&(s.db.query(`SELECT state FROM ${table} WHERE job=?`).all(job) as any[]).some(x=>states.includes(x.state)))throw Error(`Unsettled ${table}; inspect recovery-status/tick-review before any continuation`);
 }
 return {...auth,config:restoreConfig(c)};
}
// Called by the native setup hook before a restored provider can start. One use,
// same session/worktree, no permission expansion and no new delivery implied.
export function consumeStartupRestore(s:Store,job:string,c:WorkflowConfig,session:string,project:string,branch:string,tree:string,repository:any){
 return s.db.transaction(()=>{
  const r=s.db.query("SELECT * FROM startup_restores WHERE job=? AND state='attempting'").get(job) as any;
  if(!r)throw Error('No unused startup restore authorization');
  const proof=JSON.parse(r.proof),auth=startupAuthorization(s,job,c,r.binding);
  if(session!==proof.auth.session||project!==proof.auth.project||branch!==proof.auth.reserved||tree!==proof.auth.worktree||JSON.stringify(auth)!==JSON.stringify(proof.auth)||JSON.stringify(repository)!==JSON.stringify(proof.repository))throw Error('Startup restore identity, repository or current approval changed');
  const changed=s.db.query("UPDATE startup_restores SET state='setup_consumed' WHERE binding=? AND state='attempting'").run(r.binding);
  if(!changed.changes)throw Error('Startup restore already consumed');s.event(job,'startup_restore_setup_consumed',r.binding);
 }).immediate();
}

export class StartupRecovery{
 constructor(public s:Store,public w:Workflow,public io:{inventory():Promise<any[]>;inspect?:typeof restoreRepository;requirements?:typeof assertCurrentPlanningRequirements;register?:(job:string,result:any,c:WorkflowConfig)=>void;now?:()=>number;check?:()=>void}){ensureStartupRecovery(s);}
 async pass(c:WorkflowConfig,force=false):Promise<RecoverySummary>{
  const summary:RecoverySummary={complete:true,admit:true,results:[],reattached:0,resumed:0,waiting:0,blocked:0};
  const now=this.io.now??Date.now;
  let sessions:any[];
  try{this.io.check?.();sessions=await this.io.inventory();if(!Array.isArray(sessions)||new Set(sessions.map(x=>x.id)).size!==sessions.length||sessions.some(x=>typeof x.id!=='string'||typeof x.isTerminated!=='boolean'))throw Error('Authoritative session inventory incomplete');}
  catch(e){return {...summary,complete:false,admit:false,reason:`Recovery deferred: ${e instanceof Error?e.message:'backend inventory unavailable'}. Retry after backend/auth recovery; no new workers admitted.`};}
  const jobs=this.s.db.query("SELECT j.id FROM jobs j WHERE j.project=? AND j.state!='done' AND (EXISTS(SELECT 1 FROM planning_dispatch p WHERE p.job=j.id) OR EXISTS(SELECT 1 FROM implementation_dispatch d WHERE d.job=j.id)) ORDER BY COALESCE((SELECT observed FROM startup_recovery_results r WHERE r.job=j.id),0),j.id").all(c.linear.projectId) as {id:string}[];
  // Bounded batches retain unreconciled reservations and deny new intake until
  // every recorded owner has had a pass. Repeated polls advance the durable order.
  if(jobs.slice(16).some(x=>!row(this.s,'startup_recovery_results',x.id))){summary.complete=false;summary.admit=false;}
  for(const {id:job} of jobs.slice(0,16)){
   const prior=row(this.s,'startup_recovery_results',job);
   const current=this.s.get(job);
   if(!force&&prior&&prior.plan_hash===current.plan_hash&&prior.spec_hash===digest(current.spec)&&prior.next_read>now()){
    const result:RecoveryResult={job,outcome:prior.outcome,nextAction:prior.next_action};summary.results.push(result);summary[result.outcome]++;continue;
   }
   let result:RecoveryResult;
   try{this.io.check?.();assertConfiguredProjectIntakeEnabled(c,this.s);result=await this.reconcile(job,c,sessions);}
   catch(e){result={job,outcome:'blocked',nextAction:`${e instanceof Error?e.message:'Recovery evidence unavailable'}. Preserve this worker; inspect workflow-status/reconcile-jobs with the registered config.`};}
   const failures=result.outcome==='blocked'?Math.min(10,(prior?.failures??0)+1):0;
   const next=now()+(failures?Math.min(300000,1000*2**failures):0);
   this.s.db.query('INSERT INTO startup_recovery_results VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET outcome=excluded.outcome,next_action=excluded.next_action,failures=excluded.failures,next_read=excluded.next_read,observed=excluded.observed,plan_hash=excluded.plan_hash,spec_hash=excluded.spec_hash').run(job,result.outcome,result.nextAction,failures,next,now(),current.plan_hash,digest(current.spec));
   summary.results.push(result);summary[result.outcome]++;
  }
  return summary;
 }
 private async reconcile(job:string,c:WorkflowConfig,sessions:any[]):Promise<RecoveryResult>{
  const d=this.w.implementation(job),p=row(this.s,'planning_runs',job),j=this.s.get(job);
  if(!d){
   // Existing planning reconciliation can recover an uncertain spawn receipt. It
   // cannot spawn a replacement, approve a plan or restore implementation.
   const result=await this.w.reconcilePlanning(job,c);
   return {job,outcome:result?.state==='needs_reconciliation'?'blocked':'waiting',state:result?.state,nextAction:result?.reason??'Existing planning reconciled; planning/approval gates remain in force'};
  }
  if(j.state!=='approved')return {job,outcome:'blocked',nextAction:`Job is ${j.state}; preserve deliberate approval/pause gate`};
  const session=sessions.find(x=>x.id===d.session_id);
  if(!session)throw Error('Recorded worker missing from authoritative inventory; never replace it');
  let e=await this.w.t.evidence(d.session_id);retained(e);
  if(e.session?.id!==d.session_id||e.session.projectId!==p?.project||e.session.branch!==p?.branch||e.session.kind!=='worker'||typeof e.session.isTerminated!=='boolean')throw Error('Exact recorded native worker/project/branch identity required');
  const busy=e.transcript.turns.some((t:any)=>!terminal.has(t.state));
  if(busy)return {job,outcome:'waiting',nextAction:'Existing active/queued or disconnected turn preserved; wait for authoritative terminal evidence'};
   const ledger=new ReceiptReconciliation(this.s),cont=currentDispatchContinuation(this.s,job,d),client=cont?cont.client_id:d.client_id,binding=ledger.get(client);
  if(!binding){
   if(d.state==='approved_pending')return {job,outcome:'waiting',nextAction:'Original dispatch unattempted; normal current-authority workflow will deliver it'};
   throw Error('Original delivery reservation missing; never invent provenance or resend');
  }
  const delivery=ledger.inspect(binding,e,true);
  if(['unknown','reserved'].includes(delivery.state))throw Error(delivery.reason);
  if(['accepted','queued','running'].includes(delivery.state))return {job,outcome:'waiting',nextAction:delivery.reason};
  for(const other of ledger.list(job).filter(x=>x.plan===d.plan_hash&&x.client!==client)){
   const receipt=ledger.inspect(other,e,true);
   if(['unknown','reserved','accepted','queued','running'].includes(receipt.state))throw Error(`Another delivery is unsettled: ${receipt.reason}`);
  }
  const turn=e.transcript.turns.find((t:any)=>t.id===delivery.turn);
  const interrupted=turn?.state==='interrupted';
  if(!interrupted&&delivery.state!=='completed')throw Error('Failed or deliberately cancelled turn is not automatic recovery authority');
  // Terminal delivery evidence alone is not authority. Refresh ticket and scope
  // before restore/send; known operator/branch/budget reservations win.
  await (this.io.requirements??assertCurrentPlanningRequirements)(this.s,job,c);
  const restore=this.s.db.query("SELECT * FROM startup_restores WHERE job=? ORDER BY rowid DESC LIMIT 1").get(job) as any;
  const ownRestore=restore&&['attempting','setup_consumed'].includes(restore.state)?restore.binding:undefined;
  let auth=startupAuthorization(this.s,job,c,ownRestore);
  const route=this.w.router.approved(job,d.plan_hash);
  const inspect=this.io.inspect??restoreRepository;
  let repository=await inspect(this.s,job,c);
  if(repository.branch!==auth.reserved||repository.tree!==canonicalWorktree(auth.worktree))throw Error('Actual reserved worktree/branch mismatch; use recover-handoff preview, never mutate or repair identity');
  if(repository.prs.length&&interrupted)throw Error('Interrupted worker has a published PR; reconcile exact handoff before review, never resend implementation');
  const stopped=e.session.activity?.state==='exited'&&e.transcript.controller==='stopped';
  let reattached=false;
  if(stopped||e.session.isTerminated===true||restore&&['attempting','setup_consumed'].includes(restore.state)){
   const history=retained(e);
   if(restore&&['attempting','setup_consumed'].includes(restore.state)){
    const proof=JSON.parse(restore.proof);
    auth=startupAuthorization(this.s,job,c,restore.binding);
    if(restore.state!=='setup_consumed'||stopped||e.session.isTerminated||e.session.activity?.state!=='idle'||e.transcript.controller!=='ready'||JSON.stringify(proof.auth)!==JSON.stringify(auth)||JSON.stringify(proof.repository)!==JSON.stringify(repository)||proof.history!==history)throw Error('Native restore outcome uncertain or changed; inspect original session/setup log without replay');
    this.s.db.query("UPDATE startup_restores SET state='restored',reason=NULL WHERE binding=? AND state='setup_consumed'").run(restore.binding);reattached=true;
   }else{
    if(!stopped||!this.w.t.restorePlan)throw Error('Quiescent stopped native session and supported same-session restore required');
     // A completed restore is not an outstanding attempt. Fresh stopped-session
     // evidence can authorize a later restore, chained to the previous binding.
     if(restore&&!['not_sent','restored'].includes(restore.state))throw Error('Same-session restore already attempted; inspect without replay');
    const proof={auth,repository,history,previous:restore?.binding??null},key=digest(JSON.stringify(proof));
    this.io.check?.();startupAuthorization(this.s,job,c);
    this.s.db.query("INSERT INTO startup_restores VALUES (?,?,?,?,'attempting',?,NULL)").run(key,job,auth.session,auth.worktree,JSON.stringify(proof));
    this.s.event(job,'startup_restore_reserved',key);
    try{await this.w.t.restorePlan(auth.session,auth.project);}catch(e){
     if(e instanceof PreSendFailure){
      const unlaunched=this.s.db.query("UPDATE startup_restores SET state='not_sent',reason='Native restore not launched; retry with fresh recovery evidence' WHERE binding=? AND state='attempting'").run(key);
      if(unlaunched.changes)return {job,outcome:'blocked',nextAction:'Native restore not launched; a later recovery pass may retry after refreshing current authority and evidence'};
     }
     this.s.db.query('UPDATE startup_restores SET reason=? WHERE binding=?').run('Restore outcome uncertain; reconcile only, never replay',key);
    }
    // Reconcile authoritative setup consumption immediately, including after a
    // lost CLI acknowledgement. This path cannot replay an attempted restore.
    return this.reconcile(job,c,sessions);
   }
  }
  e=await this.w.t.evidence(d.session_id);retained(e);
  if(e.session.isTerminated!==false||e.session.activity?.state!=='idle'||e.transcript.controller!=='ready'||e.transcript.turns.some((t:any)=>!terminal.has(t.state)))throw Error('Worker not authoritatively idle; preserve existing turns');
  if(!interrupted){
   const result=await this.w.executionStatus(job,e,c);
   if(result?.state==='pr_handoff')this.io.register?.(job,result,c);
   return {job,outcome:reattached?'reattached':result?.state==='pr_handoff'?'reattached':['needs_input','blocked_dependency','failed','blocked','needs_reconciliation'].includes(result?.state)?'blocked':'waiting',state:result?.state,nextAction:result?.state==='pr_handoff'?'Published PR returned to ordinary CI/review polling':result?.reason??'Completed delivery reconciled; no implementation resend'};
  }
  if(cont||this.s.db.query('SELECT 1 FROM startup_continuations WHERE job=? AND dispatch=?').get(job,d.client_id))throw Error('Recovery/guarded continuation already exists; reconcile it rather than issuing another');
  const fresh=ledger.inspect(binding,e,true);
  if(fresh.state!=='cancelled'||fresh.turn!==turn.id||e.transcript.turns.find((t:any)=>t.id===turn.id)?.state!=='interrupted')throw Error('Interrupted delivery evidence changed; never resend');
  const latestRepo=await inspect(this.s,job,c);if(JSON.stringify(latestRepo)!==JSON.stringify(repository)||latestRepo.prs.length)throw Error('Worktree/provider ownership changed before continuation; preserve local edits');
  await (this.io.requirements??assertCurrentPlanningRequirements)(this.s,job,c);
  if(route){
   if(!this.w.t.preflightRoute||!this.w.t.configureRoute)throw Error('Approved recovery routing controls unavailable');
   const unchanged=()=>{if(JSON.stringify(this.w.router.approved(job,d.plan_hash))!==JSON.stringify(route)||JSON.stringify(startupAuthorization(this.s,job,c))!==JSON.stringify(auth)||JSON.stringify(this.w.implementation(job))!==JSON.stringify(d))throw Error('Approved route, dispatch or authority changed during recovery route verification');};
   await this.w.t.preflightRoute(route);unchanged();
   await this.w.t.configureRoute(d.session_id,route);unchanged();this.w.router.verified(job,'implementation');
   const configured=await this.w.t.evidence(d.session_id);
   if(retained(configured)!==retained(e)||configured.session?.id!==d.session_id||configured.session.projectId!==e.session.projectId||configured.session.branch!==e.session.branch||configured.session.isTerminated!==false||configured.session.activity?.state!=='idle'||configured.transcript.controller!=='ready'||JSON.stringify(configured.session.prs)!==JSON.stringify(e.session.prs))throw Error('Native worker changed during recovery route configuration');
   e=configured;
  }
  const last=await this.w.t.evidence(d.session_id);
  if(retained(last)!==retained(e)||JSON.stringify(last.session)!==JSON.stringify(e.session)||last.transcript.controller!=='ready')throw Error('Native worker or delivery changed before continuation reservation; refresh without resending');
  this.io.check?.();
  const clientId=`adlc-recover-${digest(JSON.stringify([job,d.client_id,turn.id])).slice(0,32)}`;
  const reserved=this.s.db.transaction(()=>{
    if(JSON.stringify(startupAuthorization(this.s,job,c))!==JSON.stringify(auth)||JSON.stringify(this.w.implementation(job))!==JSON.stringify(d))throw Error('Current authorization or delivery changed');
    if(JSON.stringify(this.w.router.approved(job,d.plan_hash))!==JSON.stringify(route))throw Error('Approved recovery route changed before delivery reservation');
   const claimed=this.s.db.query("INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,'reserved')").run(job,d.plan_hash,auth.spec,`startup:${d.client_id}:${turn.id}`,clientId,d.session_id);
   this.s.db.query('INSERT INTO startup_continuations VALUES (?,?,?)').run(job,d.client_id,claimed.lastInsertRowid);
   ledger.reserve({job,plan:d.plan_hash,spec:auth.spec,session:d.session_id,client:clientId,attempt:`continuation:${claimed.lastInsertRowid}`});
   this.s.event(job,'startup_continuation_reserved',JSON.stringify({clientId,interrupted:turn.id}));return claimed;
  }).immediate();
  this.s.db.query("UPDATE continuations SET state='delivery_uncertain' WHERE id=?").run(reserved.lastInsertRowid);
  const prompt=[`ADLC INTERRUPTED IMPLEMENTATION RECOVERY. Delivery: ${clientId}.`,new ApprovalPolicyStore(this.s).promptContext(job,c.approval),
   `The exact original delivery ${client} ended as interrupted. Continue the current approved plan ${auth.plan} in this SAME session, reserved branch ${auth.reserved}, and worktree ${auth.worktree}. Existing approval and scope ${auth.paths} remain unchanged.`,
   'Inspect preserved edits, commits, PR metadata and prior verification before doing work. Do not repeat completed operations, reset/clean the worktree, replay a branch operation or original submission, create another worker/branch/PR, or treat reboot as new authority. Preserve partial work. Stop for ambiguous operations, changed scope or requirements, questions, pauses or budget gates.',
   'Use only existing feature-branch Git permissions. Never merge a PR, enable auto-merge, deploy, change credentials/global policies, or invoke ADLC/ALDC skills. Stop after PR handoff; the host owns CI/review polling.',
   verificationInstructions(c.verification,c.verificationContext,auth.worktree),WORKER_STATUS_INSTRUCTION].join('\n\n');
  try{await this.w.t.sendImplementation(d.session_id,prompt,clientId,'idle-only');ledger.accepted(clientId);this.s.db.query("UPDATE continuations SET state='delivery_accepted' WHERE id=?").run(reserved.lastInsertRowid);return {job,outcome:'resumed',nextAction:'Exactly one same-session continuation accepted; wait for its authoritative outcome'};}
  catch{return {job,outcome:'blocked',nextAction:'Recovery continuation delivery uncertain; reconcile exact client receipt without resending'};}
 }
}

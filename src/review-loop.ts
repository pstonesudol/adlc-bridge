import {BranchUpdates,BranchObservationFailure,branchTransport,type BranchPolicy} from './branch-updates';
import {BranchSync} from './branch-sync';
import {maintenanceStatus} from './branch-maintenance';
import {scopeAllows} from './file-scope';
import {Store,digest} from './core';
import {ReceiptReconciliation} from './receipt-reconciliation';
import {Lifecycle} from './lifecycle';
import {sessionEvidence} from './session-evidence';
import {readiness} from './github';
import {sendPilotRemediation} from './pilot';
import {disableNativeFeedback} from './ao-policy';
import {metadataCheckNames} from './linear';
import {metadataBodyCovered,metadataFailureBodyCovered} from './pr-template-ci';
import {ReviewRequests,ReviewRateLimit,ReviewResetUnrepresentable,REVIEW_GRACE_MS,REVIEW_TIMEOUT_MS,reviewEscalationReason,reviewRequestBody,reviewRequestMarker,type ReviewSchedule,type ReviewMode} from './coderabbit-scheduling';
import {trustedRabbit,CODERABBIT_APP_ID} from './coderabbit-cooldowns';
import {readFailure} from './provider-read';
import {classifyCIFailure,readCIFailure,ciFinding,sameFailedCheck,CIFailureBlocked} from './ci-failures';

function metadataFailureCovered(e:any,check:any,bodyBound=true){
  return Number.isSafeInteger(check.id)&&check.id>0&&check.sha===e.head&&e.findings.some((f:any)=>f.source==='github-ci'&&f.kind==='pr_description'&&f.check===check.name&&f.checkId===check.id&&f.sha===e.head&&(!bodyBound||metadataFailureBodyCovered(e,f)));
}
import {DEFAULT_REMEDIATION_POLICY,type RemediationPolicy} from './remediation';
import {assertDeliveryTarget} from './delivery-identity';
import {readBranchSnapshot} from './branch-updates';
import {worktreeIdentity} from './delivery-evidence';
import {dispatchedFeedback,ensureReviewFeedback,feedbackKey} from './review-feedback';
import {ConflictRecovery} from './conflict-recovery';
import {worktreeReservation} from './worktree-reservation';
import {RecoveryObservation,ObservationDeferred,transient} from './recovery-observation';
import {assertObservationFence,withObservationFence,fencedIO,ObservationLeaseLost} from './observation-fence';
import {ReadValidationError,readEvidence} from './provider-read';
function readStop(error:unknown,fallback:string){
 let cause=error;for(let n=0;n<8;n++){
 if(cause instanceof ObservationDeferred)return {state:'waiting_for_worker',send:false,reason:cause.message};
 if(!(cause instanceof BranchObservationFailure))break;cause=cause.cause;
 }
 return {state:transient(readEvidence(error))?'waiting_for_worker':'blocked',send:false,reason:error instanceof Error?error.message:fallback};
}
import {validateVerification,validateVerificationContext,type Verification,type VerificationContext} from './verification';
import {revisedExecution,revisedHandoff,latestRevision} from './spec-revisions';
import {ActionWatchdog,WATCHDOG_LIMITS} from './action-watchdog';
import {observeLiveness,livenessStop} from './worker-liveness';
import {bindReviewerPolicy,boundReviewerPolicy,ensureReviewerStore,reviewerInput,reviewFindingTrustFresh} from './reviewer-policy';

function staleCodeRabbitChangeRequestReason(e:any):string|null{
 const review=e.reviewSchedule?.evidence?.review,approval=e.reviewerEvidence?.approvals?.find((a:any)=>a.reviewer==='coderabbit');
 if(typeof e.head!=='string'||!e.head||review?.stale!==true||review.state!=='CHANGES_REQUESTED'||typeof review.commit!=='string'||!review.commit||review.commit===e.head||!Number.isSafeInteger(review.id)||review.id<1||approval?.changesRequested?.length!==1)return null;
 const change=approval.changesRequested[0];return change.id===review.id&&change.head===review.commit?`Reviewer coderabbit: changes requested (${review.id})`:null;
}
export function decision(e:any,allowedPaths:string[],waitingMs:number){
  // An incomplete custom summary is a clearance obligation, not a veto on
  // independently authenticated current feedback. Never generalize this to
  // arbitrary/untrusted findings or to explicit human-review obligations.
  if(e.customCheckBlocker){
   const humanBlockers=(e.reviewerEvidence?.blockers??[]).filter((b:string)=>!b.startsWith('Reviewer coderabbit:'));
   const independent=e.findings.length>0&&e.findings.every((f:any)=>f.source==='github-review'&&f.kind==='review_thread'&&f.sha===e.head&&f.provenance?.length&&reviewFindingTrustFresh(f,e.reviewerEvidence));
   if(!independent||humanBlockers.length)return {state:'blocked',send:false,reason:humanBlockers.join('; ')||e.customCheckBlocker};
  }
  if(e.clear&&!e.customCheckBlocker)return {state:'ready_for_human',send:false,reason:'Latest-SHA CI and CodeRabbit gate passed'};
 if(e.failedChecks.length&&!e.failedChecks.every((c:any)=>metadataFailureCovered(e,c)||e.findings.some((f:any)=>f.source==='required-ci'&&f.checkId===c.id&&f.sha===e.head&&f.check===c.name)))return {state:'blocked',send:false,reason:`Required CI ${e.failedChecks.map((c:any)=>c.name).join(', ')}: unknown; current failure diagnosis required`};
 if(e.findings.length){
   if(e.findings.some((f:any)=>f.source==='github-review'&&f.path===null))return {state:'blocked',send:false,reason:'Review findings require concrete approved paths before automatic remediation'};
   if(e.findings.some((f:any)=>f.kind!=='pr_description'&&!scopeAllows(f.path,allowedPaths)))return {state:'blocked',send:false,reason:'Review findings exceed approved file scope'};
   return {state:'remediation_pending',send:true,reason:e.failedChecks.length?'Actionable current-head required CI failure':'Actionable latest-SHA CodeRabbit findings'};
 }
 // Unresolved threads that cannot become a CodeRabbit remediation are never
 // resolved by waiting or by requesting another full review. Surface exactly
 // what a human must decide instead of blocking silently after a timeout.
 const remaining:any[]=Array.isArray(e.remainingFeedback)?e.remainingFeedback:[];
 if(remaining.length){
  const count=(category:string)=>remaining.filter(x=>x.category===category).length;
  const parts=[];
  if(count('human'))parts.push(`${count('human')} human-only`);
  if(count('stale'))parts.push(`${count('stale')} outdated or ambiguous`);
  if(count('addressed'))parts.push(`${count('addressed')} carried-forward already sent for verification`);
  const paths=[...new Set(remaining.map((x:any)=>x.path).filter((p:any)=>typeof p==='string'&&p))].slice(0,10);
  return {state:'blocked',send:false,reason:`Unresolved review threads require human decision (${parts.join(', ')}): ${paths.join(', ')||'path unavailable'}`};
 }
  const staleReason=staleCodeRabbitChangeRequestReason(e);
  const hardBlockers=(e.reviewerEvidence?.blockers??[]).filter((b:string)=>!/^Reviewer [a-z][a-z0-9-]{0,63}: explicit current-head approval required$/.test(b)&&b!==staleReason);
  if(hardBlockers.length||e.reviewerEvidence?.pending?.length)return {state:'blocked',send:false,reason:[...hardBlockers,...(e.reviewerEvidence.pending??[]).map((p:any)=>`Reviewer ${p.reviewer}: ${p.reason} (${p.id})`)].join('; ')};
  if(e.coderabbitRateLimited)return {state:waitingMs>=30*60*1000?'blocked':'waiting_for_coderabbit',send:false,reason:'CodeRabbit rate limited; wait for the provider limit to reset'};
 if(waitingMs>=30*60*1000)return {state:'blocked',send:false,reason:e.reasons.join('; ')};
 if(e.pendingChecks?.length||e.missingChecks?.length)return {state:'waiting_for_ci',send:false,reason:`Waiting for CI: ${[...(e.pendingChecks??[]),...(e.missingChecks??[])].join(', ')}`};
 return {state:'waiting_for_coderabbit',send:false,reason:e.reasons.join('; ')};
}
export async function postCodeRabbitReview(repo:string,pr:number,marker='',spawn=Bun.spawn,mode:ReviewMode='regular'){
 return postCodeRabbitComment(repo,pr,reviewRequestBody(mode,marker),spawn);
}
export async function postCodeRabbitComment(repo:string,pr:number,body:string,spawn=Bun.spawn){
 const p=spawn(['gh','api','--include','--method','POST',`repos/${repo}/issues/${pr}/comments`,'-f',`body=${body}`],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [_out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code!==0){const failure=readFailure('github','review-request',_err,code,undefined,Date.now(),_out,'preserve').evidence;
  if(failure.classification==='throttled'&&[403,429].includes(failure.httpStatus??0)){if(failure.retryAtUnrepresentable)throw new ReviewResetUnrepresentable();throw new ReviewRateLimit(failure.retryAt);}
 }
 if(code!==0)throw Error('CodeRabbit comment delivery uncertain; inspect before retry');
 // gh --include may have proxy/interim header blocks. Accept only an actual
 // JSON comment receipt; an unreadable successful response remains reserved.
 try{return JSON.parse(_out.slice(_out.indexOf('{')));}catch{return null;}
}
/** Explicit whole-PR reassessment only; never used by automatic scheduling. */
export async function postFullReview(repo:string,pr:number,marker='',spawn=Bun.spawn){return postCodeRabbitReview(repo,pr,marker,spawn,'full');}
export function reviewDisplay(state:string){
 return ({waiting_for_ci:'Waiting for CI',waiting_for_coderabbit:'Waiting for CodeRabbit',waiting_for_review:'Waiting for CodeRabbit',remediation_pending:'Addressing feedback',needs_reconciliation:'Blocked — delivery needs reconciliation',blocked:'Blocked',ready_for_human:'Ready for your review',updating_branch:'Updating feature branch',waiting_for_worker:'Waiting for worker',completed:'Done'} as Record<string,string>)[state]??state;
}
 const reviewIO={readiness,sessionEvidence,sendPilotRemediation,disableNativeFeedback,readBranchSnapshot,worktreeIdentity,readCIFailure,postAvailability:postCodeRabbitComment,contains:branchTransport.contains!};
export class ReviewLoop{
 io:typeof reviewIO;
 requests:ReviewRequests;
   constructor(public s:Store,public postReview=postCodeRabbitReview,overrides:Partial<typeof reviewIO>={},public now=Date.now){this.io={...reviewIO,...overrides};ensureReviewerStore(s);ensureReviewFeedback(s.db);s.db.exec(`CREATE TABLE IF NOT EXISTS review_targets(
  job TEXT PRIMARY KEY REFERENCES jobs(id),repo TEXT NOT NULL,pr INTEGER NOT NULL,
  required_checks TEXT NOT NULL,allowed_paths TEXT NOT NULL,remediate INTEGER NOT NULL DEFAULT 0,
  head TEXT,state TEXT NOT NULL DEFAULT 'waiting_for_review',reason TEXT,
  head_since INTEGER NOT NULL,last_signature TEXT,updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS remediation_context(job TEXT NOT NULL,attempt INTEGER NOT NULL,kind TEXT NOT NULL,baseline_body_hash TEXT,PRIMARY KEY(job,attempt));
  CREATE TABLE IF NOT EXISTS review_requests(job TEXT NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(job,head,body_hash));
  CREATE TABLE IF NOT EXISTS metadata_check_policy(project TEXT PRIMARY KEY,checks TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS metadata_baselines(job TEXT NOT NULL,attempt INTEGER NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(job,attempt));
   CREATE TABLE IF NOT EXISTS metadata_waits(job TEXT NOT NULL,head TEXT NOT NULL,body TEXT NOT NULL,signature TEXT NOT NULL,started INTEGER NOT NULL,PRIMARY KEY(job,head,body));
   CREATE TABLE IF NOT EXISTS description_delivery_gates(job TEXT PRIMARY KEY,head TEXT NOT NULL,body TEXT NOT NULL,started INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS full_review_requests(job TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,PRIMARY KEY(job,pr,head,body_hash));
  CREATE TABLE IF NOT EXISTS review_verification(job TEXT PRIMARY KEY REFERENCES jobs(id),configuration TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS custom_description_obligations(job TEXT PRIMARY KEY REFERENCES jobs(id),baseline_body_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS review_verification_runtime(job TEXT PRIMARY KEY REFERENCES jobs(id),context TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS review_bindings(job TEXT PRIMARY KEY REFERENCES jobs(id),generation INTEGER NOT NULL,fingerprint TEXT NOT NULL);`);
  // Existing databases keep their PR receipts under an unknown-PR key; the
  // request key now also scopes by PR so a rebound target cannot inherit them.
  this.s.db.transaction(()=>{
   const requestColumns=this.s.db.query('PRAGMA table_info(full_review_requests)').all() as any[];
   if(requestColumns.some(c=>c.name==='pr'))return;
   this.s.db.exec(`ALTER TABLE full_review_requests RENAME TO full_review_requests_legacy;
    CREATE TABLE full_review_requests(job TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,PRIMARY KEY(job,pr,head,body_hash));
    INSERT OR IGNORE INTO full_review_requests(job,pr,head,body_hash,state,requested)
     SELECT l.job,COALESCE((SELECT t.pr FROM review_targets t WHERE t.job=l.job),0),l.head,l.body_hash,l.state,l.requested FROM full_review_requests_legacy l;
   DROP TABLE full_review_requests_legacy;`);
  }).immediate();
    this.requests=new ReviewRequests(s,now);
   s.db.exec(`CREATE TABLE IF NOT EXISTS branch_maintenance(job TEXT PRIMARY KEY REFERENCES jobs(id),repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT,state TEXT NOT NULL,reason TEXT,updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
 }
 configureMetadataChecks(project:string,names:string[]){
  if(!Array.isArray(names)||names.some(n=>typeof n!=='string'||!n.trim())||names.length>10)throw Error('Explicit PR metadata check names required');
  this.s.db.query('INSERT INTO metadata_check_policy VALUES (?,?) ON CONFLICT(project) DO UPDATE SET checks=excluded.checks').run(project,JSON.stringify([...new Set(names)]));
 }
 metadataChecks(job:string):string[]{const row=this.s.db.query('SELECT checks FROM metadata_check_policy WHERE project=?').get(this.s.get(job).project) as any;if(!row)throw Error('Explicit project metadata-check policy required before review');return metadataCheckNames(JSON.parse(row.checks));}
 register(job:string,repo:string,pr:number,required:string[],paths:string[],remediate=false,verification?:Verification,context?:VerificationContext){
  if(verification)validateVerification(verification);
  if(context)validateVerificationContext(context);
  const l=new Lifecycle(this.s);l.current(job);if(!l.run(job))throw Error('Existing approved run required');
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1||!required.length||!paths.length||paths.some(p=>p.startsWith('/')||p.split('/').includes('..')))throw Error('Invalid review target');
  const old=this.get(job);if(old){if(old.repo!==repo||old.pr!==pr||old.required_checks!==JSON.stringify(required)||old.allowed_paths!==JSON.stringify(paths)||old.remediate!==Number(remediate))throw Error('Target changed; explicit reconciliation required');this.setVerification(job,verification,context);return old;}
  this.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head_since) VALUES (?,?,?,?,?,?,?)').run(job,repo,pr,JSON.stringify(required),JSON.stringify(paths),Number(remediate),Date.now());
  this.setVerification(job,verification,context);
  this.s.event(job,'review_target_registered',JSON.stringify({repo,pr,remediate}));return this.get(job);
 }
 setVerification(job:string,v?:Verification,context?:VerificationContext){
  if(v)validateVerification(v);if(context)validateVerificationContext(context);
  this.s.db.transaction(()=>{
   if(v)this.s.db.query('INSERT INTO review_verification VALUES (?,?) ON CONFLICT(job) DO UPDATE SET configuration=excluded.configuration').run(job,JSON.stringify(v));else this.s.db.query('DELETE FROM review_verification WHERE job=?').run(job);
   if(v&&context)this.s.db.query('INSERT INTO review_verification_runtime VALUES (?,?) ON CONFLICT(job) DO UPDATE SET context=excluded.context').run(job,JSON.stringify(context));else this.s.db.query('DELETE FROM review_verification_runtime WHERE job=?').run(job);
  })();
 }
  get(job:string):any{return this.s.db.query('SELECT * FROM review_targets WHERE job=?').get(job);}
  /** Operator reconciliation for a revised handoff recorded on a different PR
   * than the registered target. Both records move together or neither does. */
  rebind(job:string,repo:string,pr:number){
   const l=new Lifecycle(this.s);l.current(job);if(!l.run(job))throw Error('Existing approved run required');
   if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1)throw Error('Invalid review target');
   return this.s.db.transaction(()=>{
    const t=this.get(job);if(!t||t.repo!==repo)throw Error('Existing review target for this repository required');
    const j=this.s.get(job),plan=j.plan_hash,revision=latestRevision(this.s,job)?.id??'';
    const handoff=this.s.db.query("SELECT name FROM sqlite_master WHERE name='revision_handoffs'").get()?this.s.db.query('SELECT pr FROM revision_handoffs WHERE job=? AND plan_hash=? AND revision=?').get(job,plan,revision) as any:null;
    if(!handoff)throw Error('Current revision handoff required before target reconciliation');
    // The recorded handoff is authoritative; reconciliation can align the
    // review target to it but never substitute a different PR for that evidence.
    if(pr!==handoff.pr)throw Error('Requested PR differs from the recorded revision handoff; reconcile the handoff first');
    if(t.pr===pr)return {state:'unchanged',job,repo,pr};
    // The new PR has no verified evidence yet: clear the old target state/head
    // and require a fresh review cycle instead of reporting it ready.
    const target=this.s.db.query("UPDATE review_targets SET pr=?,state='waiting_for_review',reason=NULL,head=NULL,last_signature=NULL,head_since=?,updated=CURRENT_TIMESTAMP WHERE job=? AND pr=?").run(pr,Date.now(),job,t.pr);
    const evidence=this.s.db.query('SELECT pr FROM revision_handoffs WHERE job=? AND plan_hash=? AND revision=? AND pr=?').get(job,plan,revision,handoff.pr) as any;
    if(!target.changes||!evidence)throw Error('Review target or handoff changed; both must reconcile together');
    this.s.event(job,'review_target_rebound',JSON.stringify({repo,from:t.pr,to:pr,handoff:handoff.pr}));
    return {state:'rebound',job,repo,pr};
   }).immediate();
  }
   private completed(job:string){const t=this.get(job);return t?.state==='completed'?{state:'completed',send:false,head:t.head,reason:t.reason}:undefined;}
   private uncertainReview(job:string,pr:number,head:string){
    const request=this.s.db.query("SELECT state FROM full_review_requests WHERE job=? AND pr=? AND head=? AND state='delivery_uncertain' LIMIT 1").get(job,pr,head) as any;
    const mode=this.requests.get(this.get(job).repo,pr,head)?.mode??'full';
    const hold=this.requests.providerHold();
    return request?.state==='delivery_uncertain'?{state:'needs_reconciliation',send:false,head,reason:hold?`CodeRabbit review unavailable: provider-wide inspection hold; request remains reserved; preview reconcile-review-provider ${hold.job}`:`${mode} review request for head ${head} delivery uncertain; reconcile the marked PR comment before retry`}:undefined;
   }
   list(project?:string){const rows=project?this.s.db.query('SELECT t.job,t.repo,t.pr,t.head,t.state,t.reason,t.remediate,t.updated FROM review_targets t JOIN jobs j ON j.id=t.job WHERE j.project=?').all(project):this.s.db.query('SELECT job,repo,pr,head,state,reason,remediate,updated FROM review_targets').all();return (rows as any[]).map(t=>({...t,providerHold:this.requests.providerHold(),reviewerEvidence:this.reviewerStatus(t.job),maintenance:maintenanceStatus(this.s,t.job),displayStatus:t.reason?.startsWith('CodeRabbit rate limited;')?t.reason:reviewDisplay(t.state),reviewCycle:this.requests.cooldowns.get(t.repo,t.pr),reviewRequest:this.s.db.query('SELECT * FROM coderabbit_requests WHERE repo=? AND pr=? ORDER BY requested DESC LIMIT 1').get(t.repo,t.pr)??null}));}
  private reviewerStatus(job:string){const row=this.s.db.query('SELECT * FROM reviewer_observations WHERE job=?').get(job) as any;return row?{head:row.head,observed:row.observed,ageMs:Math.max(0,Date.now()-row.observed),persistedOnly:true,...JSON.parse(row.evidence)}:null;}
  private reconcileRemediation(job:string,head:string,session:any,activeOnly=false){
   const pending=this.s.db.query("SELECT * FROM remediation WHERE job=? AND state='delivery_uncertain' ORDER BY attempt DESC LIMIT 1").get(job) as any;
    if(!pending)return;
    if((this.s.db.query("SELECT count(*) AS n FROM remediation WHERE job=? AND state IN ('reserved','delivery_uncertain')").get(job) as any).n!==1)return {state:'needs_reconciliation',send:false,head,reason:'active_competing_attempt: multiple remediation reservations; inspect original attempts'};
   const recovery=this.s.db.query("SELECT name FROM sqlite_master WHERE name='conflict_recoveries'").get()?this.s.db.query('SELECT id,detail,client_id FROM conflict_recoveries WHERE job=? AND attempt=?').get(job,pending.attempt) as any:null;
    const handle=recovery?.client_id??`adlc-fix-${job.slice(0,12)}-${pending.attempt}`;
    const hint=recovery?`inspect adlc recovery-preview ${job} CONFIG (conflict recovery interface)`:`preview adlc receipt-reconcile ${job} CONFIG ${pending.attempt}`;
    const run=new Lifecycle(this.s).run(job),j=this.s.get(job);
     const ledger=new ReceiptReconciliation(this.s),binding={job,plan:run.plan_hash,spec:digest(j.spec),session:run.session_id,client:handle,attempt:`remediation:${pending.attempt}`};
     let receipt=ledger.inspect(binding,session,false);
      if(receipt.state==='unknown')return {state:'needs_reconciliation',send:false,head,reason:`${receipt.code}: ${receipt.reason}; ${hint}`,delivery:receipt};
     for(const [table,states] of [['continuations',['reserved','delivery_uncertain','delivery_accepted']],['spec_replans',['accepted','delivery_uncertain']]] as const){
      if(this.s.db.query("SELECT name FROM sqlite_master WHERE name=?").get(table)&&(this.s.db.query(`SELECT state FROM ${table} WHERE job=?`).all(job) as any[]).some(x=>(states as readonly string[]).includes(x.state)))return {state:'needs_reconciliation',send:false,head,reason:'active_competing_attempt: another continuation or replan is reserved'};
     }
     if(ledger.list(job).some(x=>x.client!==handle&&!['completed','failed','cancelled'].includes(x.state)&&ledger.inspectOriginal(x,session).state!=='completed'))return {state:'needs_reconciliation',send:false,head,reason:'active_competing_attempt: another reserved delivery remains unresolved'};
     if(session.transcript?.turns?.some((t:any)=>t.id!==receipt.turn&&!['completed','failed','cancelled','interrupted'].includes(t.state)))return {state:'needs_reconciliation',send:false,head,reason:'active_competing_attempt: another native turn is active'};
     receipt=ledger.inspect(binding,session);
      if(receipt.state!=='completed')return {state:['queued','running','accepted'].includes(receipt.state)?'waiting_for_worker':'needs_reconciliation',send:false,head,reason:`${receipt.code}: ${receipt.reason}; ${hint}`,delivery:receipt};
    if(activeOnly)return;
   this.s.db.query("UPDATE remediation SET state='completed' WHERE job=? AND attempt=?").run(job,pending.attempt);
   if(recovery){const detail=JSON.parse(recovery.detail);if(detail.message==='uncertain')this.s.db.query('UPDATE conflict_recoveries SET detail=? WHERE id=? AND detail=?').run(JSON.stringify({...detail,message:'completed'}),recovery.id,recovery.detail);}
    if(pending.head===head)return {state:'blocked',send:false,head,reason:'Worker completed remediation without a new commit or metadata change; inspect before retry'};
  }
  record(job:string,result:any,pr?:number){
  assertObservationFence();
  const signature=digest(JSON.stringify({head:result.head,state:result.state,reason:result.reason}));
  return this.s.db.transaction(()=>{
   assertObservationFence();
   const t=this.get(job);
   if(t.state==='completed')return {state:'completed',send:false,head:t.head,reason:t.reason};
   // A target rebound during this evaluation keeps its own state; a stale PR
   // decision is never written and never reported as progress.
   const update=this.s.db.query("UPDATE review_targets SET state=?,reason=?,last_signature=?,updated=CURRENT_TIMESTAMP WHERE job=? AND pr=? AND state!='completed'").run(result.state,result.reason,signature,job,pr??t.pr);
   if(!update.changes)return false;
   if(t.last_signature!==signature)this.s.event(job,'review_state_changed',JSON.stringify(result));
   return result;
  }).immediate();
 }
  observeCooldown(job:string,e:any){
   const t=this.get(job),o=e.coderabbitObservation;
   if(o&&o.repo===t.repo&&o.pr===t.pr&&o.head===e.head&&Number.isSafeInteger(o.observed)&&o.observed<=this.now()&&this.now()-o.observed<=60000){
    const p=boundReviewerPolicy(this.s,job).find(r=>r.id==='coderabbit')!;
    this.requests.cooldowns.observe(o,this.requests.receipts(t.repo,t.pr),p.rateLimit);
    this.requests.reconcileThrottle(t.repo,t.pr);
    const c=this.requests.cooldowns.get(t.repo,t.pr);
    const latest=c?(this.s.db.query('SELECT MAX(at) AS at FROM coderabbit_throttle_evidence WHERE repo=? AND pr=? AND cycle=?').get(t.repo,t.pr,c.cycle) as any).at:0;
    const request=c?this.requests.get(t.repo,t.pr,e.head):null;
    // Ledger initialization is observation time, not provider chronology: a
    // throttle and its completed review can both predate our very first poll.
    // Legacy cycles without provider evidence retain their known wait origin.
    const after=Math.max(latest??c?.started??0,request?.requested??0);
    const completed=(r:any)=>['APPROVED','CHANGES_REQUESTED'].includes(r.state)||r.state==='COMMENTED'&&o.checks?.some((check:any)=>check.app?.id===CODERABBIT_APP_ID&&check.head_sha===e.head&&check.status==='completed'&&check.conclusion==='success'&&!/rate[ _-]?limit|skip|paus/i.test(check.output?.title??'')&&Date.parse(check.started_at)>=after&&Date.parse(check.started_at)<=Date.parse(r.submitted_at)&&Date.parse(check.completed_at)>=Date.parse(r.submitted_at)&&Date.parse(check.completed_at)<=o.observed);
    if(c&&o.reviews?.some((r:any)=>trustedRabbit(r)&&r.commit_id===e.head&&Date.parse(r.submitted_at)>after&&Date.parse(r.submitted_at)<=o.observed&&completed(r))&&!e.coderabbitPending)this.requests.cooldowns.complete(t.repo,t.pr,e.head);
   }
   return this.requests.cooldowns.get(t.repo,t.pr);
  }
   async requestReview(job:string,pr:number,head:string,bodyHash:string,expected?:any){
    assertObservationFence();
    const t=this.get(job);if(this.completed(job)||!t||t.pr!==pr)return false;
     const unresolved=this.uncertainReview(job,pr,head);if(unresolved){this.record(job,unresolved,pr);return false;}
     const hold=this.requests.providerHold();if(hold){this.record(job,{state:'blocked',send:false,head,reason:`CodeRabbit review unavailable: provider-wide inspection hold; preview reconcile-review-provider ${hold.job} before any new request`},pr);return false;}
    try{new Lifecycle(this.s).current(job);}catch(e){if(this.completed(job))return false;throw e;}
     const reviewers=boundReviewerPolicy(this.s,job),requestPolicy=reviewers.find(r=>r.id==='coderabbit')!;
     if(!requestPolicy.enabled||!requestPolicy.requestReview)return false;
     const fresh=await this.io.readiness(t.repo,pr,JSON.parse(t.required_checks),this.metadataChecks(job),reviewerInput(reviewers));
    assertObservationFence();
     const schedule:ReviewSchedule|undefined=fresh.reviewSchedule;
     this.observeCooldown(job,fresh);
      if(fresh.prOpen===false||fresh.head!==head||fresh.descriptionHash!==bodyHash&&fresh.descriptionVersion!==bodyHash||!schedule||schedule.blocker||schedule.evidence?.recoverable===false||fresh.coderabbitPending||fresh.findings?.length||fresh.failedChecks?.length||fresh.pendingChecks?.length||fresh.missingChecks?.length||expected&&schedule.signature!==expected.reviewSchedule?.signature){
     const reason=schedule?.blocker??(schedule?.evidence?.recoverable===false?`CodeRabbit review unavailable: head ${head} has ${schedule.evidence.review&&!schedule.evidence.review.stale?`a current ${schedule.evidence.review.state} review`:`a ${schedule.evidence.classification} result`}; a new request is not supported`:'CodeRabbit review unavailable: identity, head, configuration or description changed before request; re-evaluate');
     this.record(job,{state:'blocked',send:false,head,reason},pr);return false;
    }
    const reserved=this.s.db.transaction(()=>{
     assertObservationFence();
      if(this.completed(job))return false;
      new Lifecycle(this.s).current(job);
     // The caller's PR may have been rebound while it awaited evidence; never
     // request or reserve a review for a PR that is no longer registered.
     const target=this.get(job);if(!target||target.pr!==pr)return false;
     if(this.uncertainReview(job,pr,head))return false;
     if(!this.requests.claim(job,t.repo,pr,{...schedule,requestPolicy}))return false;
    const inserted=this.s.db.query("INSERT INTO full_review_requests VALUES (?,?,?,?,?,?) ON CONFLICT(job,pr,head,body_hash) DO UPDATE SET state=excluded.state,requested=excluded.requested WHERE state='rate_limited'").run(job,pr,head,bodyHash,'delivery_uncertain',Date.now());
   if(!inserted.changes)return false;
      this.s.db.query("UPDATE review_targets SET head_since=?,state='needs_reconciliation',reason=? WHERE job=? AND pr=? AND state!='completed'").run(Date.now(),`${this.requests.get(t.repo,pr,head).mode==='full'?'Full':'Regular'} review request for head ${head} delivery uncertain; reconcile the marked PR comment before retry`,job,pr);
   return true;
  }).immediate();
    if(!reserved){const unresolved=this.uncertainReview(job,pr,head);if(unresolved)this.record(job,unresolved,pr);else if(this.requests.providerHold())this.record(job,{state:'blocked',send:false,head,reason:`CodeRabbit review unavailable: provider-wide inspection hold; preview reconcile-review-provider ${this.requests.providerHold().job} before any new request`},pr);return false;}
  // A lost reply keeps its durable reservation: never post the same request again.
   const marker=reviewRequestMarker(t.repo,pr,head);
     let delivered:any;
     const cycle=this.requests.cooldowns.get(t.repo,pr),mode:ReviewMode=cycle&&cycle.state!=='completed'?'regular':requestPolicy.reviewMode;
     try{
      delivered=await this.postReview(t.repo,pr,marker,Bun.spawn,mode);
      if(this.postReview===postCodeRabbitReview&&(!Number.isSafeInteger(delivered?.id)||delivered.body!==reviewRequestBody(mode,marker)||delivered.issue_url!==`https://api.github.com/repos/${t.repo}/issues/${pr}`||!Number.isSafeInteger(delivered.user?.id)))throw Error('Review comment receipt incomplete; delivery uncertain');
     }
   catch(error){assertObservationFence();
     if(error instanceof ReviewResetUnrepresentable){const hold=this.requests.holdForInspection(job,t.repo,pr,head);this.record(job,{state:'needs_reconciliation',send:false,head,reason:`CodeRabbit review unavailable: provider-wide inspection hold; request remains reserved; preview reconcile-review-provider ${hold.job}`},pr);throw error;}
      if(error instanceof ReviewRateLimit){this.s.db.transaction(()=>{const transportRetry=this.requests.cooldowns.http(t.repo,pr,head,this.requests.get(t.repo,pr,head).attempts,error.retryAt,requestPolicy.rateLimit);this.requests.settle(t.repo,pr,head,'rate_limited','confirmed HTTP rate-limit rejection',transportRetry);this.s.db.query("UPDATE full_review_requests SET state='rate_limited' WHERE job=? AND pr=? AND head=? AND body_hash=? AND state='delivery_uncertain'").run(job,pr,head,bodyHash);}).immediate();return false;}
    this.record(job,{state:'needs_reconciliation',send:false,head,reason:`CodeRabbit review unavailable: ${mode} review request for head ${head} delivery uncertain; reconcile the marked PR comment before retry`},pr);throw error;}
  assertObservationFence();
   this.s.db.transaction(()=>{this.s.db.query("UPDATE full_review_requests SET state='accepted' WHERE job=? AND pr=? AND head=? AND body_hash=?").run(job,pr,head,bodyHash);
    this.requests.settle(t.repo,pr,head,'accepted',delivered?.id?JSON.stringify(delivered):marker);}).immediate();
   this.s.event(job,'coderabbit_review_requested',JSON.stringify({pr,head,bodyHash,mode}));
  return true;
 }
   async tick(job:string,branchPolicy?:BranchPolicy,remediationPolicy:RemediationPolicy=DEFAULT_REMEDIATION_POLICY,policy?:{project:string;checks:string[]},config?:any,action?:{watchdog:ActionWatchdog;id:string},maintenanceOnly=false){
   const observations=new RecoveryObservation(this.s),release=observations.claim(`job:${job}`,60*60*1000);
   if(!release)return {state:'waiting_for_worker',send:false,reason:'Review evaluation already reserved; no duplicate reads or continuation'};
    try{return await withObservationFence(release.assert,()=>this.tickReserved(job,branchPolicy,remediationPolicy,policy,config,action,maintenanceOnly));}catch(error){if(error instanceof ObservationLeaseLost)return {state:'waiting_for_worker',send:false,reason:error.message};throw error;}finally{release();}
  }
   async tickReserved(job:string,branchPolicy?:BranchPolicy,remediationPolicy:RemediationPolicy=DEFAULT_REMEDIATION_POLICY,policy?:{project:string;checks:string[]},config?:any,action?:{watchdog:ActionWatchdog;id:string},maintenanceOnly=false){
    assertObservationFence();const io=fencedIO(this.io);
    if(action){
     try{action.watchdog.assertReviewAction(action.id,job,config);}catch(error){if(error instanceof ObservationDeferred)return {state:'waiting_for_worker',send:false,reason:error.message};throw error;}
     // A watchdog action ends at observation. Never enter receipt reconciliation,
     // branch updates, review requests, remediation or recovery from this path.
     const wait=new RecoveryObservation(this.s).wait(job);if(wait)return wait;
     try{
      const {snapshot}=await action.watchdog.observeReview(action.id,config,io);
      return {state:'observed',send:false,head:snapshot.head,reason:'Read-only review evidence persisted; no review effects evaluated',mergeEnabled:false};
     }catch(error){return readStop(error,'Watchdog observation unavailable');}
    }
   const terminal=this.completed(job);if(terminal)return terminal;
  // Capture this caller's policy before any await; concurrent project polls must
  // not replace the check requirements for an already-running tick.
  if(policy!==undefined&&policy.project!==this.s.get(job).project)throw Error('Metadata policy configuration does not belong to the job project');
  const metadataChecks=[...metadataCheckNames(policy===undefined?this.metadataChecks(job):policy.checks)];
   const t=this.get(job);if(!t)throw Error('Unknown review target');const l=new Lifecycle(this.s);l.current(job);
   // Every write in this tick is scoped to the PR captured here; a rebound
   // target must not receive this PR's decisions.
   const record=(result:any)=>{
    if(maintenanceOnly){
     const current=this.get(job);
     if(current?.pr===t.pr&&current.state==='ready_for_human'&&result.head&&result.head!==current.head)this.record(job,{state:'waiting_for_review',send:false,head:result.head,reason:'Branch head changed; fresh current-head verification and review required'},t.pr);
     if(current?.pr===t.pr&&current.state!=='completed')this.s.db.query('INSERT INTO branch_maintenance(job,repo,pr,head,state,reason) VALUES (?,?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET repo=excluded.repo,pr=excluded.pr,head=excluded.head,state=excluded.state,reason=excluded.reason,updated=CURRENT_TIMESTAMP').run(job,t.repo,t.pr,result.head??null,result.maintenanceComplete?'completed':result.state,result.reason);
     return result;
    }
    const stored=this.record(job,result,t.pr);
    if(stored)return stored;
    const current=this.get(job);
    return current&&current.pr!==t.pr
     ?{state:'blocked',send:false,head:result.head,reason:'Review target rebound to another PR during evaluation; re-evaluate evidence'}
     :{state:'completed',send:false,head:current?.head??result.head,reason:current?.reason??'Review target completed during collection'};
   };
    if(config?.requiredChecks!==undefined&&t.required_checks!==JSON.stringify(config.requiredChecks)){
     // Startup may report a policy mismatch without stopping all polling. Never
     // evaluate readiness with the historical list, even in maintenance mode.
     return this.record(job,{state:'blocked',send:false,head:t.head,reason:`Required-check policy changed; preview reconcile-review-checks ${job} CONFIG HUMAN (additions only; existing checks cannot be removed)`},t.pr);
    }
    if(revisedExecution(this.s,job)&&!revisedHandoff(this.s,job)){
    // A durable handoff marker survives later remediation states, so failed or
    // uncertain remediation after a revised handoff still reaches reconciliation.
    return record({state:'waiting_for_revised_handoff',send:false,reason:'Previous PR evidence is historical; await revised implementation handoff'});
   }
   const run=l.run(job);if(!run||run.owner!=='orchestrator'||run.plan_hash!==l.current(job).plan_hash)throw Error('Agent-owned run with current approval required');
   try{if(config)bindReviewerPolicy(this.s,job,config.reviewers);else boundReviewerPolicy(this.s,job);}catch(error){return record({state:'blocked',send:false,reason:(error as Error).message});}
  const observation=new RecoveryObservation(this.s);
   const observedTransport={...branchTransport,
   update:(repo:string,pr:number,head:string)=>fencedIO(branchTransport).update(repo,pr,head),
   read:(repo:string,pr:number)=>observation.read(job,'github',()=>io.readBranchSnapshot(repo,pr)),
    contains:(repo:string,ancestor:string,head:string)=>observation.read(job,'github',()=>io.contains(repo,ancestor,head))};
   const persistMaintenance=(result:any)=>{
    assertObservationFence();l.current(job);
    const current=this.get(job);if(current.pr!==t.pr||current.state==='completed')return;
    this.s.db.query('INSERT INTO branch_maintenance(job,repo,pr,head,state,reason) VALUES (?,?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET repo=excluded.repo,pr=excluded.pr,head=excluded.head,state=excluded.state,reason=excluded.reason,updated=CURRENT_TIMESTAMP').run(job,t.repo,t.pr,result.head??null,result.maintenanceComplete?'completed':result.state,result.reason);
   };
   // Maintenance may return before the effectful review evaluator, but must not
   // erase its blocker or starve read-only CI/review observation. No request,
   // remediation, verification clearance or ready decision is made here.
   const maintenance=async(result:any)=>{
    persistMaintenance(result);
    let review=this.get(job);
    if(review.pr!==t.pr||review.state==='completed')return record(result);
    // Invalidate old clearance before IO, including a lost/throttled read.
    if(review.state==='ready_for_human')this.record(job,{state:'waiting_for_review',send:false,head:result.head,reason:'Branch maintenance pending; fresh current-head verification and review required'},t.pr);
    if(maintenanceOnly)return {...result,maintenance:maintenanceStatus(this.s,job),review:{state:this.get(job).state,head:this.get(job).head,reason:this.get(job).reason}};
    try{
     const e=await observation.read(job,'github',()=>io.readiness(t.repo,t.pr,[...new Set([...JSON.parse(t.required_checks),...metadataChecks])],metadataChecks));
     l.current(job);
     this.observeReviewers(job,e,t.pr,result.maintenanceComplete===true);
     if(this.get(job).pr===t.pr&&this.get(job).state!=='completed'){
      if(e.head===result.head){
        // Pending maintenance must retain the verified predecessor as its
        // provenance anchor, even when current remote review reads succeed.
        if(result.maintenanceComplete)this.s.db.query("UPDATE review_targets SET head=?,head_since=? WHERE job=? AND pr=? AND state!='completed'").run(e.head,t.head===e.head?t.head_since:Date.now(),job,t.pr);
       if(e.customCheckBlocker)record({state:'blocked',send:false,head:e.head,reason:e.customCheckBlocker});
      }
     }
    }catch(error){
     if(error instanceof ObservationLeaseLost)throw error;
     if(error instanceof ReadValidationError)observation.clear(job,false);
     if(this.get(job).state!=='blocked')record(readStop(error,'Review evidence incomplete; maintenance status retained'));
    }
    review=this.get(job);
    return {...result,maintenance:maintenanceStatus(this.s,job),review:{state:review.state,head:review.head,reason:review.reason}};
   };
   const wait=observation?.wait(job);if(wait)return t.state==='blocked'?{...wait,maintenance:maintenanceStatus(this.s,job),review:{state:t.state,head:t.head,reason:t.reason}}:record(wait);
   l.recordRemediationPolicy(job,remediationPolicy);
   const recovery=worktreeReservation(this.s,job);
   if(recovery&&!recovery.branchSync){
    if(maintenanceOnly)return record({state:'blocked',send:false,reason:'Conflict recovery retains the worktree reservation; no maintenance-only recovery dispatch'});
    if(recovery.job!==job||!config)return record({state:'blocked',send:false,reason:'Worktree has a durable conflict reservation; inspect recovery-status with its original config'});
    try{const result=await new ConflictRecovery(this.s).tick(job,config,t.repo,t.pr,remediationPolicy);if(result)return record(result);}
    catch(error){return record({state:'blocked',send:false,reason:error instanceof Error?error.message:'Conflict recovery unavailable'});}
   }
  let session,snapshot,local;
  try{
    session=await observation.read(job,'orchestrator',()=>io.sessionEvidence(run.session_id),false);
    snapshot=await observation.read(job,'github',()=>io.readBranchSnapshot(t.repo,t.pr));
  }catch(e){return record(readStop(e,'Provider evidence unavailable'));}
   try{
    if(session.session.isTerminated!==true&&!session.session.prs?.some((p:any)=>p.number===t.pr&&p.url===`https://github.com/${t.repo}/pull/${t.pr}`))throw Error('Target/session mismatch');
    assertDeliveryTarget(this.s,job,session.session,t.repo,t.pr,snapshot);
    if(session.session.isTerminated===true){
     const terminated=observeLiveness(this.s,job,session,snapshot.head,WATCHDOG_LIMITS.livenessMs,this.now());
     return record({...livenessStop(terminated,WATCHDOG_LIMITS.livenessMs,this.now()),head:snapshot.head});
    }
    local=await io.worktreeIdentity(this.s,job);
   if(local.branch!==snapshot.branch)throw Error(`Blocked — branch mismatch: reserved ${session.session.branch}; actual ${local.branch}; candidate https://github.com/${t.repo}/pull/${t.pr}; preview recover-handoff`);
  }catch(e){return record({state:'blocked',send:false,reason:e instanceof Error?e.message:'Delivery identity unavailable'});}
    const collected=this.completed(job);if(collected)return collected;
    const live=observeLiveness(this.s,job,session,snapshot.head,WATCHDOG_LIMITS.livenessMs,this.now());
    const liveStop=livenessStop(live,WATCHDOG_LIMITS.livenessMs,this.now());
     if(liveStop&&['terminated','stuck'].includes(live.classification))return record({...liveStop,head:snapshot.head});
      const activeDelivery=this.reconcileRemediation(job,snapshot.head,session,true);if(activeDelivery){
       try{const pending=await observation.read(job,'github',()=>io.readiness(t.repo,t.pr,JSON.parse(t.required_checks),metadataChecks,reviewerInput(boundReviewerPolicy(this.s,job))));this.observeReviewers(job,pending,t.pr);}catch(error){if(error instanceof ObservationLeaseLost)throw error;}
       return record(activeDelivery);
      }
     if(liveStop&&live.classification==='unknown')return record({...liveStop,head:snapshot.head});
     if(live.classification==='idle_no_delivery'&&liveStop?.state==='needs_reconciliation'&&!this.s.db.query("SELECT 1 FROM remediation WHERE job=? AND state='delivery_uncertain'").get(job))return record({...liveStop,head:snapshot.head});
   if(config&&(local.head!==snapshot.head||recovery?.branchSync)){
    const synchronized=await new BranchSync(this.s,observedTransport).ensure(job,config,t.repo,t.pr);
     if(synchronized)return maintenance(synchronized);
   }
   if(!config&&recovery?.branchSync)return record({state:'blocked',send:false,reason:'Pending branch synchronization requires the registered project configuration; no review dispatch'});
   let branch;
   if(!maintenanceOnly&&config?.conflictRecovery?.enabled===true){
    let snapshot;
    try{snapshot=await observation.read(job,'github',()=>io.readBranchSnapshot(t.repo,t.pr));}
    catch(error){return record(readStop(error,'Branch snapshot unavailable'));}
    if(snapshot.behind>0&&snapshot.mergeable===null)return record({...observation.mergeabilityUnknown(job),head:snapshot.head});
    observation.mergeabilityKnown(job);
    if(snapshot.mergeable===false&&snapshot.behind>0){
     try{await new BranchUpdates(this.s,observedTransport).observeAccepted(job,t.repo,t.pr,snapshot);}
     catch(error){return record({...readStop(error,'Accepted base update evidence unavailable; inspect published recovery'),head:snapshot.head});}
     try{const result=await new ConflictRecovery(this.s).tick(job,config,t.repo,t.pr,remediationPolicy);if(result)return record(result);}
     catch(error){return record({state:'blocked',send:false,head:snapshot.head,reason:error instanceof Error?error.message:'Conflict recovery unavailable'});}
    }
   }
   try{branch=await new BranchUpdates(this.s,observedTransport).ensure(job,t.repo,t.pr,session,branchPolicy);}
    catch(error){const terminal=this.completed(job);if(terminal)return terminal;if(error instanceof BranchObservationFailure){
     const stopped=readStop(error,'Branch observation unavailable');persistMaintenance(stopped);
     // A provider deferral stops all later reads, not just branch reads.
     const review=this.get(job);
     return review.state==='blocked'?{...stopped,maintenance:maintenanceStatus(this.s,job),review:{state:review.state,head:review.head,reason:review.reason}}:record(stopped);
    }throw error;}
    if(branch?.mergeabilityUnknown)return maintenance({...observation.mergeabilityUnknown(job),head:branch.head});
   observation.mergeabilityKnown(job);
    if(branch)return maintenance(branch);
    if(snapshot.behind===0&&local.head===snapshot.head&&maintenanceStatus(this.s,job))persistMaintenance({state:'completed',head:snapshot.head,reason:'Branch maintenance reconciled; review and verification remain independent'});
   const branchComplete=this.completed(job);if(branchComplete)return branchComplete;
   if(maintenanceOnly)return record({state:'completed',send:false,head:snapshot.head,reason:'Branch is current and worktree synchronized; review and verification remain independent'});
  const required=[...new Set([...JSON.parse(t.required_checks),...metadataChecks])];
  let e;
   try{e=await observation.read(job,'github',()=>io.readiness(t.repo,t.pr,required,metadataChecks,reviewerInput(boundReviewerPolicy(this.s,job))));this.observeReviewers(job,e,t.pr);}
  catch(error){if(error instanceof ReadValidationError)observation.clear(job,false);return record(readStop(error,'Readiness evidence unavailable'));}
   observation.clear(job);
   const reviewed=this.completed(job);if(reviewed)return reviewed;
   // Completed jobs no longer satisfy execution approval; handle that terminal
   // observation here rather than relaxing Lifecycle.current's authorization.
   try{if(l.current(job).plan_hash!==run.plan_hash)throw Error('Approval changed during review collection');}
    catch(error){const terminal=this.completed(job);if(terminal)return terminal;throw error;}
    const uncertain=this.requests.receipts(t.repo,t.pr).filter(r=>r.state==='delivery_uncertain');
    for(const receipt of uncertain){
     const marker=reviewRequestMarker(t.repo,t.pr,receipt.head);
     const matched=e.requestComments?.filter((c:any)=>c.body===reviewRequestBody(receipt.mode,marker)&&Date.parse(c.created)+1000>=receipt.requested&&c.author&&c.id&&c.own===true);
     if(matched?.length===1){this.requests.settle(t.repo,t.pr,receipt.head,'accepted',JSON.stringify({id:matched[0].id}));this.s.db.query("UPDATE full_review_requests SET state='accepted' WHERE pr=? AND head=? AND job IN (SELECT job FROM review_targets WHERE repo=? AND pr=?) AND state='delivery_uncertain'").run(t.pr,receipt.head,t.repo,t.pr);}
    else return record({state:'needs_reconciliation',send:false,head:e.head,reason:`CodeRabbit review unavailable: ${receipt.mode} request outcome uncertain; reconcile matching request evidence before retry`});
   }
    const unresolved=this.uncertainReview(job,t.pr,e.head);if(unresolved)return record(unresolved);
    const reviewCycle=this.observeCooldown(job,e);
    const since=t.head===e.head?t.head_since:Date.now();
   const outcome=this.s.db.query("SELECT name FROM sqlite_master WHERE name='worker_outcomes'").get()?this.s.db.query('SELECT * FROM worker_outcomes WHERE job=?').get(job) as any:null;
   // Durable continuation state is authoritative across workflow and review
   // polling. A stale failed outcome must not block a recovered continuation,
   // and any failure source must be blocked while one remains unrecovered.
   const failedContinuation=this.s.db.query("SELECT name FROM sqlite_master WHERE name='continuations'").get()?this.s.db.query("SELECT id FROM continuations WHERE job=? AND plan_hash=? AND state='failed' LIMIT 1").get(job,run.plan_hash) as any:null;
   if(outcome?.plan_hash===run.plan_hash&&outcome.outcome==='failed'&&failedContinuation)return record({state:'needs_reconciliation',send:false,head:e.head,reason:'Previous guarded continuation failed without reviewed delivery recovery; no handoff or remediation'});
   if(outcome?.plan_hash===run.plan_hash&&typeof outcome.source==='string'&&outcome.source.startsWith('remediation:')&&['needs_input','blocked_dependency','failed','uncertain'].includes(outcome.outcome)){
    const handle=outcome.source.slice('remediation:'.length),entry=session.transcript.entries.find((x:any)=>x.clientMessageId===handle),turn=entry&&session.transcript.turns.find((x:any)=>x.id===entry.turnId);
    if(turn?.state==='completed')this.s.db.query("UPDATE remediation SET state='completed' WHERE job=? AND attempt=? AND state='delivery_uncertain'").run(job,Number(handle.split('-').at(-1)));
    return record({state:'blocked',send:false,head:e.head,reason:`Verification remediation ${outcome.outcome}: ${outcome.reason}; see the scoped Linear clarification/blocker flow`});
   }
   const customObligation=this.s.db.query('SELECT * FROM custom_description_obligations WHERE job=?').get(job) as any;
   const reviewBodyKey=customObligation&&e.descriptionVersion?e.descriptionVersion:e.descriptionHash;
  // A same-SHA approval can predate a description edit. Reconcile metadata
  // receipts before considering e.clear, so that edit always creates its gate.
  const metadataPending=this.s.db.query("SELECT r.*,c.baseline_body_hash FROM remediation r JOIN remediation_context c ON c.job=r.job AND c.attempt=r.attempt WHERE r.job=? AND r.state='delivery_uncertain' AND c.kind='pr_description' ORDER BY r.attempt DESC LIMIT 1").get(job) as any;
   if(metadataPending){
    const handle=`adlc-fix-${job.slice(0,12)}-${metadataPending.attempt}`,entry=session.transcript.entries.find((x:any)=>x.clientMessageId===handle),turn=entry&&session.transcript.turns.find((x:any)=>x.id===entry.turnId);
    if(turn?.state!=='completed')return record({state:'needs_reconciliation',send:false,head:e.head,reason:'Previous metadata remediation is uncertain or incomplete; never infer completion'});
    if(metadataPending.baseline_body_hash===e.descriptionHash)return record({state:'blocked',send:false,head:e.head,reason:'Metadata worker completed without an observed description change; inspect before clearing delivery'});
    const baseline=this.s.db.query('SELECT signature FROM metadata_baselines WHERE job=? AND attempt=?').get(job,metadataPending.attempt) as any;
    this.s.db.transaction(()=>{
     this.s.db.query("UPDATE remediation SET state='completed' WHERE job=? AND attempt=?").run(job,metadataPending.attempt);
     if(metadataChecks.length)this.s.db.query('INSERT OR IGNORE INTO metadata_waits VALUES (?,?,?,?,?)').run(job,e.head,e.descriptionHash,baseline?.signature??e.templateSignature,Date.now());
     this.s.db.query('INSERT INTO description_delivery_gates VALUES (?,?,?,?) ON CONFLICT(job) DO UPDATE SET head=excluded.head,body=excluded.body,started=excluded.started').run(job,e.head,e.descriptionHash,Date.now());
    }).immediate();
   }
   // A delivered description edit creates a review obligation independently of
   // mutable metadata-check policy. Clearing that policy cannot clear delivery
   // uncertainty or make an approval for the previous body current.
   if(customObligation&&customObligation.baseline_body_hash!==e.descriptionHash)this.s.db.query('INSERT OR IGNORE INTO description_delivery_gates VALUES (?,?,?,?)').run(job,e.head,e.descriptionHash,Date.now());
   const deliveryWait=this.s.db.transaction(()=>{
    const prior=this.s.db.query('SELECT * FROM description_delivery_gates WHERE job=?').get(job) as any;
    if(!prior||prior.head===e.head&&prior.body===e.descriptionHash)return prior;
    const started=Math.max(Date.now(),prior.started+1);
    this.s.db.query('UPDATE description_delivery_gates SET head=?,body=?,started=? WHERE job=?').run(e.head,e.descriptionHash,started,job);
    return {...prior,head:e.head,body:e.descriptionHash,started};
   }).immediate();
   // Once metadata remediation creates a gate, another same-head body edit
   // cannot escape it. Carry its baseline forward and restart review freshness
   // for each newly observed body, including a return to an earlier body.
    const needsBodyEvidence=metadataChecks.length>0&&!e.findings.length&&!e.failedChecks.length&&!e.pendingChecks.length&&!e.missingChecks.length&&!metadataBodyCovered(e,metadataChecks);
    const checkWait=metadataChecks.length===0?null:this.s.db.transaction(()=>{
    const prior=this.s.db.query('SELECT * FROM metadata_waits WHERE job=? AND head=? ORDER BY started DESC,rowid DESC LIMIT 1').get(job,e.head) as any;
    if(!prior){
     if(!needsBodyEvidence)return null;
     const started=Date.now();this.s.db.query('INSERT INTO metadata_waits VALUES (?,?,?,?,?)').run(job,e.head,e.descriptionHash,e.templateSignature,started);
     return {body:e.descriptionHash,signature:e.templateSignature,started};
    }
     if(prior.body===e.descriptionHash)return prior;
    const started=Math.max(Date.now(),prior.started+1);
    this.s.db.query('INSERT INTO metadata_waits VALUES (?,?,?,?,?) ON CONFLICT(job,head,body) DO UPDATE SET signature=excluded.signature,started=excluded.started').run(job,e.head,e.descriptionHash,prior.signature,started);
    return {...prior,body:e.descriptionHash,started};
   }).immediate();
   const waiting=checkWait??deliveryWait;
   if(waiting&&customObligation&&!e.descriptionVersion)return record({state:'blocked',send:false,head:e.head,reason:'CodeRabbit custom-check failure: current description edit version is unavailable; restore GitHub body-version access before requesting review'});
    if(needsBodyEvidence){
     return record({state:Date.now()-waiting.started>5*60*1000?'blocked':'waiting_for_ci',send:false,head:e.head,reason:'Missing body-bound success evidence for every configured metadata check'});
   }
   // Request one fresh pass when old review evidence cannot clear an otherwise
  // idle PR. Pending CI and actionable findings must be handled first.
  const waitStart=Math.max(waiting?.started??0,deliveryWait?.started??0);
  const schedule:ReviewSchedule|undefined=e.reviewSchedule;
   if(schedule?.blocker&&!e.findings.length)return record({state:'blocked',send:false,head:e.head,reason:schedule.blocker});
  const scheduleWait=schedule?this.requests.wait(t.repo,t.pr,schedule):null;
  if(schedule&&session.transcript.controller!=='ready')this.s.db.query('UPDATE coderabbit_waits SET started=? WHERE repo=? AND pr=? AND head=?').run(Date.now(),t.repo,t.pr,e.head);
   const idle=!e.findings.length&&!e.failedChecks.length&&!e.pendingChecks.length&&!e.missingChecks.length;
   const activeCycle=reviewCycle&&reviewCycle.state!=='completed'?this.requests.cooldowns.get(t.repo,t.pr):null;
   const cooldownRetryReady=activeCycle?.state==='waiting'&&this.now()>=this.requests.cooldowns.effectiveRetry(activeCycle);
   if(activeCycle){
    // Throttle checks never prove completed review or spend remediation budget.
    e.clear=false;
     if(idle&&!e.customCheckBlocker){
      const hold=this.requests.providerHold();
      if(hold)return record({state:'blocked',send:false,head:e.head,reason:`CodeRabbit review unavailable: provider-wide inspection hold; preview reconcile-review-provider ${hold.job} before any new request`});
      if(['exhausted','already_reviewed'].includes(activeCycle.state))return record({state:'blocked',send:false,head:e.head,reason:this.requests.cooldowns.reason(activeCycle)});
     const requestPolicy=boundReviewerPolicy(this.s,job).find(r=>r.id==='coderabbit')!;
     let q=this.requests.cooldowns.query(activeCycle);
     if(q?.state==='delivery_uncertain'){
      const matches=e.requestComments?.filter((c:any)=>c.own===true&&c.body===q.body&&Date.parse(c.created)+1000>=q.requested)??[];
      const comment=matches.length===1?e.coderabbitObservation?.comments.find((c:any)=>c.id===matches[0].id):null;
      if(comment)this.requests.cooldowns.settleQuery(q,comment);
      q=this.requests.cooldowns.query(activeCycle);
     }
     if(!q&&t.remediate&&requestPolicy.requestReview&&session.transcript.controller==='ready'&&!e.coderabbitPending&&!schedule?.blocker&&schedule?.evidence?.recoverable!==false&&e.prOpen!==false){
      q=this.requests.cooldowns.claimQuery(activeCycle);
      if(q){
       try{l.current(job);const comment=await io.postAvailability(t.repo,t.pr,q.body);assertObservationFence();this.requests.cooldowns.settleQuery(q,comment);}
       catch(error){assertObservationFence();if(error instanceof ObservationLeaseLost)throw error;if(error instanceof ReviewResetUnrepresentable){const hold=this.requests.holdForInspection(job,t.repo,t.pr,e.head,q);return record({state:'blocked',send:false,head:e.head,reason:`CodeRabbit review unavailable: provider-wide inspection hold; query rejected; preview reconcile-review-provider ${hold.job} before any new request`});}if(error instanceof ReviewRateLimit)this.requests.cooldowns.chatThrottle(q,error.retryAt);}
       q=this.requests.cooldowns.query(activeCycle);
      }
     }
     if(q?.state==='delivery_uncertain')return record({state:'needs_reconciliation',send:false,head:e.head,reason:`CodeRabbit review unavailable: availability query delivery uncertain; reconcile-review-query ${job} COMMENT_ID verifies an existing own comment only; never resend blindly`});
     if(activeCycle.state==='requesting'){
      const r=this.requests.get(t.repo,t.pr,e.head),age=this.now()-(r?.requested??activeCycle.next_action);
      return record({state:age>=REVIEW_TIMEOUT_MS?'blocked':'waiting_for_coderabbit',send:false,head:e.head,reason:age>=REVIEW_TIMEOUT_MS&&schedule?reviewEscalationReason({repo:t.repo,pr:t.pr,head:e.head,schedule,attempts:activeCycle.attempts,requestState:r?.state??'unknown',mode:r?.mode}):'CodeRabbit review unavailable: regular retry delivered or uncertain; awaiting authenticated outcome, no blind resend'});
     }
     if(!cooldownRetryReady)return record({state:'waiting_for_coderabbit',send:false,head:e.head,reason:this.requests.cooldowns.reason(activeCycle)});
    }
   }
  if(schedule&&idle&&!e.clear&&!waiting&&!e.customCheckBlocker){
   const sharedRetry=this.requests.sharedRetryAt(schedule);
   if(!activeCycle&&sharedRetry>this.now())return record({state:'waiting_for_coderabbit',send:false,head:e.head,reason:`CodeRabbit rate limited; next retry at ${new Date(sharedRetry).toISOString()}`});
   const request=this.requests.get(t.repo,t.pr,e.head),age=Date.now()-(request?.state==='accepted'?request.requested:scheduleWait!.started);
    if(!activeCycle&&request?.state==='rate_limited'&&(Date.now()<request.next_attempt||request.attempts>=3))return record({state:request.attempts>=3?'blocked':'waiting_for_coderabbit',send:false,head:e.head,reason:reviewEscalationReason({repo:t.repo,pr:t.pr,head:e.head,schedule,attempts:request.attempts,requestState:request.state,retryAt:request.next_attempt,mode:request.mode})});
    if(!activeCycle&&schedule.evidence?.classification==='rate-limited'&&!request)return record({state:age>=REVIEW_TIMEOUT_MS?'blocked':'waiting_for_coderabbit',send:false,head:e.head,reason:reviewEscalationReason({repo:t.repo,pr:t.pr,head:e.head,schedule,attempts:0,requestState:'none'})});
    if(!activeCycle&&age>=REVIEW_TIMEOUT_MS&&request?.state!=='rate_limited')return record({state:'blocked',send:false,head:e.head,reason:reviewEscalationReason({repo:t.repo,pr:t.pr,head:e.head,schedule,attempts:request?.attempts??0,requestState:request?.state??'none',mode:request?.mode})});
    if(schedule.incremental&&!cooldownRetryReady||Date.now()-scheduleWait!.started<REVIEW_GRACE_MS||session.transcript.controller!=='ready')return record({state:'waiting_for_coderabbit',send:false,head:e.head,reason:schedule.incremental&&!cooldownRetryReady?'Waiting for automatic incremental CodeRabbit review':'Waiting for final remediation batch and five-minute CodeRabbit grace period'});
  }
  // Only an established obligation gate supplies a current-head/body baseline;
  // the zero fallback is not evidence that an existing review covers an edit.
  const blockerAlreadyFresh=!!(customObligation&&waiting&&waitStart>0&&e.customCheckBlocker&&!e.coderabbitPending&&Number.isFinite(e.botReviewSubmittedAt)&&e.botReviewSubmittedAt>waitStart);
  const staleReason=staleCodeRabbitChangeRequestReason(e);
   if((!schedule?.incremental||cooldownRetryReady)&&schedule?.evidence?.recoverable!==false&&!blockerAlreadyFresh&&!e.clear&&!e.findings.length&&!e.failedChecks.length&&!e.pendingChecks.length&&!e.missingChecks.length&&!e.coderabbitPending&&t.remediate&&session.transcript.controller==='ready'&&e.reasons.every((r:string)=>r.startsWith('CodeRabbit')||r.startsWith('Explicit latest-SHA')||r==='Reviewer coderabbit: explicit current-head approval required'||r===staleReason)){
   const requested=await this.requestReview(job,t.pr,e.head,reviewBodyKey,e);
   const stopped=this.get(job);if(stopped?.state==='blocked'&&stopped.reason?.startsWith('CodeRabbit review unavailable:'))return record({state:'blocked',send:false,head:e.head,reason:stopped.reason});
   const unresolved=this.uncertainReview(job,t.pr,e.head);if(unresolved)return record(unresolved);
   if(requested){
     const headUpdate=this.s.db.query("UPDATE review_targets SET head=? WHERE job=? AND pr=? AND state!='completed'").run(e.head,job,t.pr);
     // A concurrent completion keeps its terminal result; only a rebound target
     // makes this evidence stale.
     if(!headUpdate.changes&&this.get(job)?.pr!==t.pr)return {state:'blocked',send:false,head:e.head,reason:'Review target rebound to another PR during evaluation; re-evaluate evidence'};
     return record({state:'waiting_for_coderabbit',send:false,head:e.head,reason:`${this.requests.get(t.repo,t.pr,e.head)?.mode==='full'?'Full':'Regular'} CodeRabbit review requested for current commit and description`});
   }
  }
   if(waiting&&e.failedChecks.length&&e.failedChecks.every((c:any)=>metadataFailureCovered(e,c,false))&&waiting.signature===e.templateSignature){
   return record({state:Date.now()-waiting.started>5*60*1000?'blocked':'waiting_for_ci',send:false,head:e.head,reason:'PR description updated; awaiting a fresh template-check result (no duplicate remediation)'});
  }
   if(waiting&&!e.findings.length&&!e.failedChecks.length&&!e.pendingChecks.length&&!e.missingChecks.length){
    const reviewStarted=Math.max(waiting.started,deliveryWait?.started??0);
    const freshBlocker=customObligation&&e.customCheckBlocker&&!e.coderabbitPending&&Number.isFinite(e.botReviewSubmittedAt)&&e.botReviewSubmittedAt>reviewStarted;
    if(!freshBlocker&&!e.coderabbitPending&&!schedule?.incremental&&schedule?.evidence?.recoverable!==false&&(!Number.isFinite(e.botReviewSubmittedAt)||e.botReviewSubmittedAt<=reviewStarted||customObligation&&!e.coderabbitBodyReviewed))await this.requestReview(job,t.pr,e.head,reviewBodyKey,e);
    const stopped=this.get(job);if(stopped?.state==='blocked'&&stopped.reason?.startsWith('CodeRabbit review unavailable:'))return record({state:'blocked',send:false,head:e.head,reason:stopped.reason});
    const unresolved=this.uncertainReview(job,t.pr,e.head);if(unresolved)return record(unresolved);
   const request=this.s.db.query('SELECT * FROM full_review_requests WHERE job=? AND pr=? AND head=? AND body_hash=?').get(job,t.pr,e.head,reviewBodyKey) as any;
    const sinceReview=Math.max(reviewStarted,request?.requested??reviewStarted);
   const surfaceBlocker=freshBlocker&&e.botReviewSubmittedAt>sinceReview;
   if(!surfaceBlocker&&(e.coderabbitPending||!Number.isFinite(e.botReviewSubmittedAt)||e.botReviewSubmittedAt<=sinceReview||customObligation&&!e.coderabbitBodyReviewed))return record({state:Date.now()-sinceReview>30*60*1000?'blocked':'waiting_for_coderabbit',send:false,head:e.head,reason:`Template check passed after description update; waiting for fresh CodeRabbit reevaluation; requested mode ${this.requests.get(t.repo,t.pr,e.head)?.mode??(request?'full':'none')}. Regular review may skip a description-only edit; inspect before explicitly requesting whole-PR reassessment, never infer approval`});
  }
  // An accepted request must produce its own review before old custom evidence
  // is judged; otherwise a poll that arrives before the bot starts would report
  // the pre-request blocker as current.
  const pendingReview=this.s.db.query("SELECT * FROM full_review_requests WHERE job=? AND pr=? AND head=? AND body_hash=? AND state='accepted'").get(job,t.pr,e.head,reviewBodyKey) as any;
  if(!blockerAlreadyFresh&&pendingReview&&(!Number.isFinite(e.botReviewSubmittedAt)||e.botReviewSubmittedAt<=pendingReview.requested)&&!e.findings.length&&!e.failedChecks.length&&!e.pendingChecks.length&&!e.missingChecks.length)
   return record({state:Date.now()-pendingReview.requested>30*60*1000?'blocked':'waiting_for_coderabbit',send:false,head:e.head,reason:`${this.requests.get(t.repo,t.pr,e.head)?.mode??'full'} CodeRabbit review requested for current commit and description; awaiting its result before judging custom-check evidence`});
  // Delivery uncertainty takes precedence over dedupe and blocker reporting: an
  // unverified send must be reconciled even when its thread is already recorded
   // as dispatched.
   const reconciliation=this.reconcileRemediation(job,e.head,session);
   if(reconciliation)return record(reconciliation);
  const dispatched=dispatchedFeedback(this.s,job);
  const threadFindings=e.findings.filter((f:any)=>f.kind==='review_thread');
   const freshThreadFindings=threadFindings.filter((f:any)=>!dispatched.has(feedbackKey(f.threadId,f.commentsHash))&&!dispatched.has(feedbackKey(f.threadId,digest([...(f.commentIds??[])].sort().join(',')))));
   const handled=new Set([...threadFindings.map((f:any)=>f.threadId),...(e.reviewerEvidence?.ignoredThreadIds??[])]);
   const remainingFeedback:any[]=[
    ...(e.reviewThreads?.humanOnly??[]).filter((t:any)=>!handled.has(t.threadId)).map((t:any)=>({category:'human',threadId:t.threadId,path:t.path})),
    ...(e.reviewThreads?.stale??[]).filter((t:any)=>!handled.has(t.threadId)).map((t:any)=>({category:'stale',threadId:t.threadId,path:t.path})),
   ...threadFindings.filter((f:any)=>!freshThreadFindings.includes(f)).map((f:any)=>({category:'addressed',threadId:f.threadId,path:f.path})),
  ];
  // Only feedback never handed to this worker is actionable. Metadata findings
  // keep their existing path untouched.
   const reviewView={...e,findings:[...e.findings.filter((f:any)=>f.kind!=='review_thread'),...freshThreadFindings],remainingFeedback};
   const failures=e.failedChecks.filter((c:any)=>!metadataFailureCovered(e,c));
   if(failures.length){
    // Keep the current-head wait origin durable even when diagnosis returns
    // early. Otherwise every transient poll would restart its escalation clock.
    this.s.db.query("UPDATE review_targets SET head=?,head_since=? WHERE job=? AND pr=? AND state!='completed'").run(e.head,since,job,t.pr);
    const paths=JSON.parse(t.allowed_paths),grant=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
    const authorized=!!(t.remediate&&grant?.plan_hash===l.current(job).plan_hash&&['commit','push-feature'].every(op=>JSON.parse(grant.operations).includes(op)));
    if(failures.length>8)return record({state:'blocked',send:false,head:e.head,reason:`Required CI ${failures.slice(0,8).map((c:any)=>c.name).join(', ')}: unknown; too many failed checks for bounded diagnosis`});
    const blockers:{transient:boolean;reason:string}[]=[];
    for(const c of failures){
     const identity=!e.reasons.includes('Head changed')&&snapshot.head===e.head&&Number.isSafeInteger(c.id)&&c.id>0&&c.sha===e.head&&c.conclusion==='failure'&&!e.pendingChecks.includes(c.name)&&failures.filter((x:any)=>x.name===c.name).length===1;
     const diagnosis=classifyCIFailure(identity?await io.readCIFailure(t.repo,c):null,paths);
     l.current(job);
     const reason=`Required CI ${c.name} (#${c.id}, ${e.head}): ${authorized?diagnosis.classification:'unauthorized'}; ${authorized?diagnosis.reason:'current scoped commit/push authorization required'}`;
     if(!authorized||diagnosis.classification!=='repairable')blockers.push({transient:authorized&&diagnosis.classification==='transient',reason});
     else reviewView.findings.push(ciFinding(c,diagnosis));
    }
    if(blockers.length)return record({state:blockers.every(b=>b.transient)&&Date.now()-since<30*60000?'waiting_for_ci':'blocked',send:false,head:e.head,reason:blockers.map(b=>b.reason).join('; ')});
    // A log read cannot authorize a stale run/head. Re-read logical identities.
    let fresh;
     try{fresh=await observation.read(job,'github',()=>io.readiness(t.repo,t.pr,required,metadataChecks,reviewerInput(boundReviewerPolicy(this.s,job))));}
    catch(error){if(error instanceof ReadValidationError)observation.clear(job,false);return record({...readStop(error,'Readiness evidence unavailable'),head:e.head});}
    if(fresh.head!==e.head||failures.some((c:any)=>fresh.failedChecks.filter((x:any)=>sameFailedCheck(c,x)).length!==1||fresh.pendingChecks.includes(c.name)))return record({state:'blocked',send:false,head:e.head,reason:`Required CI ${failures.map((c:any)=>c.name).join(', ')}: unknown; failure identity changed during diagnosis`});
   }
  const d=decision(reviewView,JSON.parse(t.allowed_paths),Date.now()-since);
  const signature=digest(JSON.stringify({head:e.head,state:d.state,reason:d.reason}));
  const stored=this.s.db.transaction(()=>{
   assertObservationFence();
   const update=this.s.db.query("UPDATE review_targets SET head=?,head_since=?,state=?,reason=?,last_signature=?,updated=CURRENT_TIMESTAMP WHERE job=? AND pr=? AND state!='completed'").run(e.head,since,d.state,d.reason,signature,job,t.pr);
   if(!update.changes)return false;
   if(t.last_signature!==signature)this.s.event(job,'review_state_changed',JSON.stringify({repo:t.repo,pr:t.pr,head:e.head,...d}));
   return true;
  }).immediate();
  if(!stored)return this.get(job)?.pr!==t.pr?{state:'blocked',send:false,head:e.head,reason:'Review target rebound to another PR during evaluation; re-evaluate evidence'}:{state:'completed',send:false,head:e.head,reason:'Review target completed during collection'};
   if(d.send&&t.remediate){
    const reconciliation=this.reconcileRemediation(job,e.head,session);
    if(reconciliation)return record(reconciliation);
    // Receipt reconciliation above may have established a metadata edit's
    // delivery. Re-evaluate that fact rather than caching a pre-reconciliation
    // idle diagnosis as authority to block or send a different remediation.
    const deliveryLive=observeLiveness(this.s,job,session,e.head,WATCHDOG_LIMITS.livenessMs,this.now());
    if(deliveryLive.classification!=='alive')return record({...livenessStop(deliveryLive,WATCHDOG_LIMITS.livenessMs,this.now()),head:e.head});
   if(session.transcript.controller!=='ready')return {...d,send:false,reason:'Worker busy; wait',head:e.head};
   const grant=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
   const metadataOnly=reviewView.findings.every((f:any)=>f.kind==='pr_description');
   const operations=metadataOnly?['open-pr']:['commit','push-feature',...(reviewView.findings.some((f:any)=>f.kind==='pr_description')?['open-pr']:[])];
   const j=l.current(job);if(!grant||grant.plan_hash!==j.plan_hash||!operations.every(op=>JSON.parse(grant.operations).includes(op)))throw Error('Current scoped GitHub authorization required');
    let result;
    try{
     await io.disableNativeFeedback(run.session_id);
     result=await io.sendPilotRemediation(this.s,job,e.head,JSON.stringify(reviewView.findings),t.repo,t.pr,required,remediationPolicy,metadataChecks);
    }catch(error){if(error instanceof CIFailureBlocked)return record({state:'blocked',send:false,head:e.head,reason:error.message});throw error;}
    if(result.blocked)return record({state:'blocked',send:false,head:e.head,reason:failures.length?`Required CI ${failures.map((c:any)=>c.name).join(', ')}: ${result.reason}`:result.reason,budget:result.budget});
   if(result.reused)return record({state:'needs_reconciliation',send:false,head:e.head,reason:'Concurrent remediation reservation already exists; reconcile before retry'});
   return {...d,head:e.head,delivery:result};
  }
  return {...d,head:e.head,send:false,mergeEnabled:false};
  }
  private observeReviewers(job:string,e:any,pr:number,advanceHead=true){
   assertObservationFence();
   // Persist observation currency before decision/receipt early returns. A
   // generation distinguishes A -> B -> A without reviving superseded claims.
   if(!e.head||e.reasons?.includes('Head changed')||e.customCheckBlocker==='PR head or description changed during custom-check collection')return;
   this.s.db.transaction(()=>{
    assertObservationFence();new Lifecycle(this.s).current(job);
    const t=this.get(job);if(!t||t.pr!==pr||t.state==='completed')return;
    const reviewers=e.reviewerEvidence?{blockers:e.reviewerEvidence.blockers,approvals:e.reviewerEvidence.approvals,pending:e.reviewerEvidence.pending,trust:e.reviewerEvidence.trust?.map((t:any)=>({reviewer:t.reviewer,ids:t.ids,blocker:t.blocker,fresh:t.fresh}))}:null;
    const fingerprint=digest(JSON.stringify([t.repo,pr,e.head,e.descriptionHash,e.descriptionVersion,e.reviewEvidenceVersion,e.reviewSchedule?.signature,reviewers,e.customCheckBlocker,e.coderabbitBodyReviewed,e.botReviewSubmittedAt,e.findings,e.pendingChecks,e.missingChecks,e.failedChecks]));
    const prior=this.s.db.query('SELECT * FROM review_bindings WHERE job=?').get(job) as any;
    if(prior?.fingerprint!==fingerprint){
     const generation=(prior?.generation??0)+1;
     this.s.db.query('INSERT INTO review_bindings VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint').run(job,generation,fingerprint);
     this.s.event(job,'review_binding_observed',JSON.stringify({pr,head:e.head,previousHead:t.head,generation,fingerprint}));
      this.s.db.query("UPDATE review_targets SET head=?,head_since=?,state=CASE WHEN state='ready_for_human' THEN 'waiting_for_review' ELSE state END,reason=CASE WHEN state='ready_for_human' THEN 'Review evidence changed; fresh clearance required' ELSE reason END WHERE job=? AND pr=?").run(advanceHead?e.head:t.head,!advanceHead||t.head===e.head?t.head_since:this.now(),job,pr);
    }
    if(e.reviewerEvidence)this.s.db.query('INSERT INTO reviewer_observations VALUES (?,?,?,?) ON CONFLICT(job) DO UPDATE SET head=excluded.head,observed=excluded.observed,evidence=excluded.evidence').run(job,e.head,this.now(),JSON.stringify(e.reviewerEvidence));
   }).immediate();
  }
}

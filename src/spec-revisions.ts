import {randomUUID} from 'node:crypto';
import {Store,digest} from './core';

// Never publish snippets of ticket text: field names and lengths give a useful,
// bounded summary without attempting to recognize every possible secret format.
export function revisionSummary(before:string,after:string){
 try{
  const a=JSON.parse(before),b=JSON.parse(after);
  return ['identifier','title','description'].filter(k=>a[k]!==b[k]).map(k=>`${k} changed (${String(a[k]??'').length} → ${String(b[k]??'').length} characters; content redacted)`).join('; ')||'Specification serialization changed; content redacted';
 }catch{return 'Specification changed; unstructured content redacted';}
}
export function installRevisions(s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS spec_revisions (
 id TEXT PRIMARY KEY,job TEXT NOT NULL REFERENCES jobs(id),old_hash TEXT NOT NULL,new_hash TEXT NOT NULL,
 old_plan TEXT,old_plan_hash TEXT,old_approved_hash TEXT,old_actor TEXT,summary TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS spec_replans (
 revision TEXT PRIMARY KEY REFERENCES spec_revisions(id),job TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,
 session TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL,proof TEXT NOT NULL,reason TEXT);
 CREATE TABLE IF NOT EXISTS spec_execution_history (
 revision TEXT PRIMARY KEY,job TEXT NOT NULL,snapshot TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS spec_revision_evidence (
 revision TEXT PRIMARY KEY,job TEXT NOT NULL,snapshot TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS revision_handoffs (
  job TEXT NOT NULL,plan_hash TEXT NOT NULL,revision TEXT NOT NULL,pr INTEGER NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(job,plan_hash,revision));
  CREATE TABLE IF NOT EXISTS revision_handoff_proofs (
  job TEXT NOT NULL,plan_hash TEXT NOT NULL,revision TEXT NOT NULL,dispatch TEXT NOT NULL,session TEXT NOT NULL,spec TEXT NOT NULL,turn TEXT NOT NULL,repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,PRIMARY KEY(job,plan_hash,revision));
`);}
export function recordRevision(s:Store,old:any,spec:string){
 const id=randomUUID(),detail={id,oldHash:digest(old.spec),newHash:digest(spec),summary:revisionSummary(old.spec,spec),staleApproval:old.approved_hash};
 // An edit before any planning owner exists is new intake, not a change to an
 // active plan. It cannot revive stale authority: the first captured plan binds
 // these requirements. Once a planning dispatch exists, the edit may race an
 // in-flight turn and is therefore treated as active scope.
 const planned=(s.db.query("SELECT name FROM sqlite_master WHERE name='planning_runs'").get()?s.db.query('SELECT 1 FROM planning_runs WHERE job=? AND session_id IS NOT NULL').get(old.id):null)||
  (s.db.query("SELECT name FROM sqlite_master WHERE name='planning_dispatch'").get()?s.db.query('SELECT 1 FROM planning_dispatch WHERE job=?').get(old.id):null);
 const state=planned?'pending':'preplanning';
 s.db.query('INSERT INTO spec_revisions(id,job,old_hash,new_hash,old_plan,old_plan_hash,old_approved_hash,old_actor,summary,state) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,old.id,detail.oldHash,detail.newHash,old.plan,old.plan_hash,old.approved_hash,old.actor,detail.summary,state);
 const snapshot:Record<string,unknown>={};
 for(const table of ['planning_runs','planning_dispatch','implementation_dispatch','worker_outcomes','plan_readiness','policy_authorizations','git_grants','review_targets']){
  if(s.db.query('SELECT name FROM sqlite_master WHERE name=?').get(table))snapshot[table]=s.db.query(`SELECT * FROM ${table} WHERE job=?`).all(old.id);
 }
 s.db.query('INSERT INTO spec_revision_evidence VALUES (?,?,?)').run(id,old.id,JSON.stringify(snapshot));
 s.event(old.id,'spec_revision_recorded',JSON.stringify(detail));return detail;
}
export function latestRevision(s:Store,job:string):any{
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='spec_revisions'").get())return null;
 return s.db.query('SELECT * FROM spec_revisions WHERE job=? ORDER BY rowid DESC LIMIT 1').get(job);
}
/** Legacy outcomes without instance evidence remain usable only before any
 * requirement revision. Repeated hashes never revive historical blockers. */
export function currentOutcome(s:Store,job:string,o:any){
 if(!o)return false;
 const j=s.get(job),d=s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any,r=latestRevision(s,job);
 return !!(d&&o.plan_hash===j.plan_hash&&o.plan_hash===d.plan_hash&&o.session_id===d.session_id&&
  (r?o.revision_id===r.id&&o.dispatch_id===d.client_id:!o.revision_id&&(!o.dispatch_id||o.dispatch_id===d.client_id)));
}
/** Fail-closed binding for a dependency wait against the active revision and
 * dispatch. Legacy waits before any revision remain bound to their plan only. */
export function revisionBoundWait(s:Store,job:string,wait:any,worker?:any){
 const r=latestRevision(s,job);
 if(!r)return true;
 const p=JSON.parse(wait.evidence),d=s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any;
 if(p.proof?.auth)return p.proof.auth.revision===r.id&&p.proof.auth.delivery===d?.client_id;
 // A saved wait keeps the instance that created it; never rebind to a later one.
 // An explicit null marker means it predates any revision and cannot match one.
 if(p.waitRevision!==undefined)return p.waitRevision===r.id&&p.waitDispatch===d?.client_id;
 return !p.clientId&&currentOutcome(s,job,worker??s.db.query('SELECT * FROM worker_outcomes WHERE job=?').get(job));
}
/** A fresh same-instance outcome can retire a dependency wait, but not a
 * historical or unbound receipt. Resumed notices retain their retraction flow. */
export function settleDependencyWait(s:Store,job:string){
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='dependency_waits'").get())return;
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='worker_outcomes'").get())return;
 return s.db.transaction(()=>{
 const row=s.db.query('SELECT * FROM dependency_waits WHERE job=?').get(job) as any;
  if(!row)return;
  const o=s.db.query('SELECT * FROM worker_outcomes WHERE job=?').get(job) as any;
  const fresh=currentOutcome(s,job,o);
 const evidence=JSON.parse(row.evidence),client=evidence.clientId;
 const d=s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any,r=latestRevision(s,job);
  const bound=row.plan===s.get(job).plan_hash&&(!r?(!o?.dispatch_id||o.dispatch_id===d?.client_id):revisionBoundWait(s,job,row,o));
  // Historical waits cannot retain a label for a new authorization instance,
  // whether or not a fresh outcome already exists. Keep the exact evidence and
  // record retirement without interpreting it again.
  if(!bound&&row.state!=='settled'){
   const changed=s.db.query("UPDATE dependency_waits SET state='settled',reason='Dependency wait belongs to a superseded revision or dispatch' WHERE job=? AND plan=? AND state=? AND evidence=?").run(job,row.plan,row.state,row.evidence).changes;
   if(changed)s.event(job,'dependency_wait_settled',JSON.stringify({historical:true,previous:row}));
   return;
  }
  if(!fresh)return;
 if(o.outcome==='blocked_dependency'&&(row.state==='settled'||!bound)){
  // A historical proof/continuation cannot suppress a new authorized blocker.
  // Archive it in full; an unproven new wait must collect fresh evidence.
  const next=bound?evidence:{workerDependencies:JSON.parse(o.dependencies)};
   const changed=s.db.query("UPDATE dependency_waits SET plan=?,state='waiting_for_dependencies',reason='Current worker reported a dependency blocker after settlement or revision; re-evaluate evidence without replay',evidence=? WHERE job=? AND plan=? AND state=? AND evidence=?").run(o.plan_hash,JSON.stringify({...next,waitInstance:randomUUID(),waitRevision:latestRevision(s,job)?.id??null,waitDispatch:d?.client_id??null}),job,row.plan,row.state,row.evidence).changes;
   if(changed){s.event(job,'dependency_wait_reopened',JSON.stringify({settled:row,outcome:o}));return 'reopened';}
   return;
 }
  if(row.state==='settled'||(row.state==='resumed'&&bound))return;
 if(o.outcome==='blocked_dependency')return;
  if(bound&&client&&s.db.query("SELECT name FROM sqlite_master WHERE name='continuations'").get()){
  const cont=s.db.query('SELECT * FROM continuations WHERE client_id=? AND job=? AND plan_hash=?').get(client,job,row.plan) as any;
   if(bound&&cont?.session_id===d?.session_id&&['delivery_accepted','completed'].includes(cont?.state)){
    const changed=s.db.query("UPDATE dependency_waits SET state='resumed',reason='Existing continuation accepted; no replay' WHERE job=? AND plan=? AND state=? AND evidence=?").run(job,row.plan,row.state,row.evidence).changes;
    if(changed){s.event(job,'dependency_wait_resumed',JSON.stringify({client}));return 'resumed';}
    return;
  }
 }
  const changed=s.db.query("UPDATE dependency_waits SET state='settled',reason='Current worker outcome no longer reports a dependency blocker' WHERE job=? AND plan=? AND state=? AND evidence=?").run(job,row.plan,row.state,row.evidence).changes;
  if(changed)s.event(job,'dependency_wait_settled',JSON.stringify({outcome:o.outcome,revision:o.revision_id??null,dispatch:o.dispatch_id??null}));
 }).immediate();
}
/** Jobs whose plan was renewed after a requirement revision keep their prior PR
 * historical until that exact revised plan completes a handoff. */
export function revisedExecution(s:Store,job:string){
  return !!(s.db.query("SELECT name FROM sqlite_master WHERE name='spec_execution_history'").get()&&s.db.query('SELECT 1 FROM spec_execution_history WHERE job=?').get(job));
}
/** Continuations survive reapproval for audit, including A→B→A plan hashes.
 * Only a same-instance row after the revised authorization boundary is current. */
export function currentDispatchContinuation(s:Store,job:string,d:any,id?:number):any{
 if(!d||!s.db.query("SELECT name FROM sqlite_master WHERE name='continuations'").get())return null;
 const cont=id===undefined?s.db.query('SELECT * FROM continuations WHERE job=? ORDER BY id DESC LIMIT 1').get(job) as any:s.db.query('SELECT * FROM continuations WHERE job=? AND id=?').get(job,id) as any;
 const revision=latestRevision(s,job),history=revision&&s.db.query('SELECT snapshot FROM spec_execution_history WHERE revision=? AND job=?').get(revision.id,job) as any;
 const boundary=history?JSON.parse(history.snapshot).continuationMaxId:undefined;
 return cont?.plan_hash===d.plan_hash&&cont.spec_hash===digest(s.get(job).spec)&&cont.session_id===d.session_id&&(!history||Number.isSafeInteger(boundary)&&cont.id>boundary)?cont:null;
}
export function implementationRecoveryContinuation(s:Store,job:string,d:any,original:any):any{
 if(original?.state!=='cancelled'||!original.turn||!s.db.query("SELECT name FROM sqlite_master WHERE name='startup_continuations'").get())return null;
 const recovery=s.db.query('SELECT continuation FROM startup_continuations WHERE job=? AND dispatch=?').get(job,d.client_id) as any;
 if(!recovery)return null;
 const cont=currentDispatchContinuation(s,job,d,recovery.continuation);
 return cont&&cont.binding===`startup:${d.client_id}:${original.turn}`&&['reserved','delivery_uncertain','delivery_accepted','completed'].includes(cont.state)?cont:null;
}
/** A startup continuation may complete the exact interrupted implementation,
 * never an unrelated cancelled/failed dispatch. Preserve the original receipt;
 * return the completed delivery whose turn must bind the published-head proof.
 * Read-only previews may supply freshly inspected receipts without persisting. */
export function implementationCompletion(s:Store,job:string,d:any,observed?:{original:any;continuation?:any}):any{
 if(!d||d.plan_hash!==s.get(job).plan_hash||!s.db.query("SELECT name FROM sqlite_master WHERE name='delivery_receipts'").get())return null;
 const receipt=(client:string)=>s.db.query('SELECT * FROM delivery_receipts WHERE client=?').get(client) as any;
 const original=observed?observed.original:receipt(d.client_id),spec=digest(s.get(job).spec);
 const bound=(r:any,client:string,attempt:string)=>r&&r.job===job&&r.plan===d.plan_hash&&r.spec===spec&&r.session===d.session_id&&r.client===client&&r.attempt===attempt&&!!r.turn;
 if(!bound(original,d.client_id,'implementation:1'))return null;
 if(original.state==='completed')return original;
 const cont=implementationRecoveryContinuation(s,job,d,original);if(!cont)return null;
 const completed=observed?observed.continuation:receipt(cont.client_id);
 return bound(completed,cont.client_id,`continuation:${cont.id}`)&&completed.state==='completed'?completed:null;
}
/** The one open PR a recovered-delivery handoff belongs to. */
export function handoffPr(result:any,openPrs:any[]){
 return result.pr??(result.source==='delivery-recovery'&&openPrs.length===1?openPrs[0]:null);
}
/** Bind a handoff to the current requirement instance. A→B→A can reproduce an
 * earlier plan hash, so a plan-hash-only marker would authorize stale evidence. */
export type HandoffProof={dispatch:string;session:string;spec:string;turn:string;repo:string;head:string};
export function recordHandoff(s:Store,job:string,plan:string|null,pr:any,at=Date.now(),proof?:HandoffProof){
 if(!plan||!pr?.number)return;
 const revision=latestRevision(s,job)?.id??'';
  s.db.query('INSERT OR IGNORE INTO revision_handoffs VALUES (?,?,?,?,?)').run(job,plan,revision,pr.number,at);
  if(proof)s.db.query(`INSERT INTO revision_handoff_proofs VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job,plan_hash,revision) DO UPDATE SET dispatch=excluded.dispatch,session=excluded.session,spec=excluded.spec,turn=excluded.turn,repo=excluded.repo,pr=excluded.pr,head=excluded.head`).run(job,plan,revision,proof.dispatch,proof.session,proof.spec,proof.turn,proof.repo,pr.number,proof.head);
}
export function revisedHandoff(s:Store,job:string){
 const plan=s.get(job).plan_hash;
 if(!plan||!revisedExecution(s,job)||!s.db.query("SELECT name FROM sqlite_master WHERE name='revision_handoffs'").get())return false;
 const revision=latestRevision(s,job)?.id??'';
 const handoff=s.db.query('SELECT pr FROM revision_handoffs WHERE job=? AND plan_hash=? AND revision=?').get(job,plan,revision) as any;
  if(!handoff)return false;
  // Old plan/PR-only markers are historical, not proof of this dispatch. Keep
  // them intact while the workflow automatically refreshes exact evidence.
  if(!s.db.query("SELECT name FROM sqlite_master WHERE name='revision_handoff_proofs'").get())return false;
  const proof=s.db.query('SELECT * FROM revision_handoff_proofs WHERE job=? AND plan_hash=? AND revision=?').get(job,plan,revision) as any;
  const d=s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any;
  if(!proof||proof.pr!==handoff.pr||proof.dispatch!==d?.client_id||proof.session!==d?.session_id||proof.spec!==digest(s.get(job).spec)||d.plan_hash!==plan||!proof.turn||!proof.repo||!/^[a-f0-9]{40,64}$/.test(proof.head))return false;
   const receipt=implementationCompletion(s,job,d);
   if(!receipt||receipt.turn!==proof.turn||!capturedRevision(s,job,plan,proof.session).captured)return false;
 // The handoff must be the PR the review target registered; a different open PR
 // cannot release review or Done while that target still points elsewhere.
  const target=s.db.query("SELECT name FROM sqlite_master WHERE name='review_targets'").get()?s.db.query('SELECT repo,pr FROM review_targets WHERE job=?').get(job) as any:null;
  return !target||target.pr===handoff.pr&&target.repo===proof.repo;
}
export function observeLegacyRevision(s:Store,job:string){
 if(latestRevision(s,job)||!s.db.query("SELECT name FROM sqlite_master WHERE name='planning_runs'").get())return;
 if(!(s.db.query('PRAGMA table_info(planning_runs)').all() as any[]).some(c=>c.name==='spec_hash'))return;
 const j=s.get(job),p=s.db.query('SELECT spec_hash FROM planning_runs WHERE job=?').get(job) as any;
 if(j.state!=='awaiting_plan'||!p||p.spec_hash===digest(j.spec))return;
 const id=randomUUID();
 s.db.query('INSERT INTO spec_revisions(id,job,old_hash,new_hash,summary) VALUES (?,?,?,?,?)').run(id,job,p.spec_hash,digest(j.spec),'Legacy requirement mismatch: previous content/plan unavailable; inspect retained session history. No approval restored.');
 s.event(job,'legacy_spec_revision_observed',JSON.stringify({id,oldHash:p.spec_hash,newHash:digest(j.spec)}));
}
/** Shared approval/dispatch guard: an active revision must have produced the
 * exact captured plan for the current hash in the same planning session. */
export function capturedRevision(s:Store,job:string,plan:string|null,session?:string|null){
 const r=latestRevision(s,job);
 if(!r||r.state==='preplanning')return {revision:r??null,captured:true};
 const replan=s.db.query('SELECT * FROM spec_replans WHERE revision=?').get(r.id) as any;
 const proof=replan?JSON.parse(replan.proof):null;
 const captured=r.state!=='pending'&&r.new_hash===digest(s.get(job).spec)&&replan?.state==='captured'&&
  proof?.capturedPlanHash===plan&&(!session||replan.session===session);
 return {revision:r,captured};
}
export function assertCapturedRevision(s:Store,job:string,plan:string|null,session?:string|null){
 if(!capturedRevision(s,job,plan,session).captured)throw Error('Exact captured replan for the current requirement revision required');
}
/** Called only inside the fresh revised-plan approval transaction. Ordinary
 * review registration still rejects all scope/identity changes. */
export function reconcileAuthorizedReviewScope(s:Store,job:string,paths:string[]){
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='review_targets'").get())return;
 const target=s.db.query('SELECT * FROM review_targets WHERE job=?').get(job) as any;
 if(!target||target.allowed_paths===JSON.stringify(paths))return;
 const j=s.get(job),r=latestRevision(s,job),d=s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any;
 const replan=r&&s.db.query('SELECT * FROM spec_replans WHERE revision=?').get(r.id) as any,proof=replan&&JSON.parse(replan.proof);
 const grant=s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
 const evidence=r&&s.db.query('SELECT snapshot FROM spec_revision_evidence WHERE revision=?').get(r.id) as any;
 const old=evidence&&JSON.parse(evidence.snapshot).review_targets;
 if(!r||r.state!=='authorized'||j.state!=='approved'||j.approved_hash!==j.plan_hash||!d||d.plan_hash!==j.plan_hash||d.actor!==j.actor||d.paths!==JSON.stringify(paths)||!grant||grant.plan_hash!==j.plan_hash||grant.actor!==j.actor||!['inspect','commit','push-feature','open-pr'].every(op=>JSON.parse(grant.operations).includes(op))||!capturedRevision(s,job,j.plan_hash,d.session_id).captured||proof.spec!==digest(j.spec)||proof.prs?.length!==1||proof.prs[0].number!==target.pr||proof.prs[0].url!==`https://github.com/${target.repo}/pull/${target.pr}`||proof.prEvidence?.headRepo!==target.repo||proof.prEvidence.baseRepo!==target.repo||proof.prEvidence.state!=='open'||!Array.isArray(old)||old.length!==1||old[0].repo!==target.repo||old[0].pr!==target.pr||old[0].allowed_paths!==target.allowed_paths)throw Error('Revised review scope needs exact same-job/PR authorization and captured identity; explicit reconciliation required');
 s.db.query("UPDATE review_targets SET allowed_paths=?,state='waiting_for_review',head=NULL,last_signature=NULL,reason='Fresh revised scope authorized; collect current-head evidence',head_since=?,updated=CURRENT_TIMESTAMP WHERE job=?").run(JSON.stringify(paths),Date.now(),job);
 s.event(job,'revised_review_scope_authorized',JSON.stringify({revision:r.id,plan:j.plan_hash,session:d.session_id,repo:target.repo,pr:target.pr,previous:target.allowed_paths,paths,actor:j.actor}));
}
export function revisionStatus(s:Store,job:string){
 const r=latestRevision(s,job);if(!r)return null;
 const p=s.db.query('SELECT state,reason FROM spec_replans WHERE revision=?').get(r.id) as any;
  const j=s.get(job),settled=r.state==='authorized'||r.state==='preplanning';
  const request=s.db.query("SELECT name FROM sqlite_master WHERE name='spec_requests'").get()?s.db.query('SELECT source,state,reason,comment_id,reply FROM spec_requests WHERE revision=?').get(r.id) as any:null;
  return {revision:r.id,oldHash:r.old_hash,newHash:r.new_hash,summary:r.summary,state:r.state,delivery:p??null,request,blocking:!settled,
  nextAction:r.state==='authorized'?'Continue only under the fresh current grant':r.state==='preplanning'?'No recovery needed: the first captured plan binds these requirements.':j.state==='awaiting_approval'?'Await current-plan approval':request?.state==='awaiting_replan_confirmation'?`Reply with the exact standalone command from Linear notice ${request.comment_id}; this requests planning only, not clarification or plan approval.`:request?.state==='waiting_for_worker'?'Wait for the existing worker to become safely idle; normal polling rechecks the latest revision and policy. Do not interrupt it.':['dispatched','actively_replanning','delivery_uncertain'].includes(request?.state)?'Await exact owned planning delivery evidence; never resend. Inspect spec-reconcile if receipt recovery is required.':`Preview spec-reconcile ${job} CONFIG; confirm only after the existing owner is idle. For an archived terminated owner, preview spec-restore ${job} CONFIG first; confirm only the exact planning-only restore. No replacement worker or PR.`};
}

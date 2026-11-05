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
/** Jobs whose plan was renewed after a requirement revision keep their prior PR
 * historical until that exact revised plan completes a handoff. */
export function revisedExecution(s:Store,job:string){
 return !!(s.db.query("SELECT name FROM sqlite_master WHERE name='spec_execution_history'").get()&&s.db.query('SELECT 1 FROM spec_execution_history WHERE job=?').get(job));
}
/** The one open PR a recovered-delivery handoff belongs to. */
export function handoffPr(result:any,openPrs:any[]){
 return result.pr??(result.source==='delivery-recovery'&&openPrs.length===1?openPrs[0]:null);
}
/** Bind a handoff to the current requirement instance. A→B→A can reproduce an
 * earlier plan hash, so a plan-hash-only marker would authorize stale evidence. */
export function recordHandoff(s:Store,job:string,plan:string|null,pr:any,at=Date.now()){
 if(!plan||!pr?.number)return;
 const revision=latestRevision(s,job)?.id??'';
 s.db.query('INSERT OR IGNORE INTO revision_handoffs VALUES (?,?,?,?,?)').run(job,plan,revision,pr.number,at);
}
export function revisedHandoff(s:Store,job:string){
 const plan=s.get(job).plan_hash;
 if(!plan||!revisedExecution(s,job)||!s.db.query("SELECT name FROM sqlite_master WHERE name='revision_handoffs'").get())return false;
 const revision=latestRevision(s,job)?.id??'';
 return !!s.db.query('SELECT 1 FROM revision_handoffs WHERE job=? AND plan_hash=? AND revision=?').get(job,plan,revision);
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
export function revisionStatus(s:Store,job:string){
 const r=latestRevision(s,job);if(!r)return null;
 const p=s.db.query('SELECT state,reason FROM spec_replans WHERE revision=?').get(r.id) as any;
 const j=s.get(job),settled=r.state==='authorized'||r.state==='preplanning';
 return {revision:r.id,oldHash:r.old_hash,newHash:r.new_hash,summary:r.summary,state:r.state,delivery:p??null,blocking:!settled,
  nextAction:r.state==='authorized'?'Continue only under the fresh current grant':r.state==='preplanning'?'No recovery needed: the first captured plan binds these requirements.':j.state==='awaiting_approval'?'Await current-plan approval':`Preview spec-reconcile ${job} CONFIG; confirm only after the existing owner is idle. No replacement worker or PR.`};
}

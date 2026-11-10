import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from './core';

export const canonicalWorktree=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
export function recoveryRows(s:Store):any[]{
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='conflict_recoveries'").get())return [];
 return s.db.query('SELECT * FROM conflict_recoveries ORDER BY created,id').all() as any[];
}
export function branchSyncRows(s:Store):any[]{
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='branch_syncs'").get())return [];
 return (s.db.query('SELECT * FROM branch_syncs ORDER BY job').all() as any[]).map(r=>({...r,kind:'branch_sync',nextAction:r.state==='completed'?'Collect fresh current-head CI/review evidence':'Recheck through tick-review with the registered configuration after quiescence. Preserve edits and local commits; changed identity/provenance requires explicit operator reconciliation, never reset or bypass the reservation.'}));
}
// These reservations fence cooperating bridge paths, not arbitrary native AO or
// human writers. Never expire a reservation based on elapsed time or a dead PID.
export function worktreeReservation(s:Store,job:string,target?:string):any{
 const p=s.db.query("SELECT name FROM sqlite_master WHERE name='planning_runs'").get()?s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any:null;
 const run=s.db.query("SELECT name FROM sqlite_master WHERE name='runs'").get()?s.db.query('SELECT worktree FROM runs WHERE job=?').get(job) as any:null;
  const paths=[p?.worktree,run?.worktree,target].map(path=>path?canonicalWorktree(path):null);
  // Stored rows may hold an alias (symlink) of a reserved path, so compare the
  // canonical forms in JavaScript rather than raw SQL text equality.
  const aliases=(path:string|null|undefined)=>!!path&&paths.includes(canonicalWorktree(path));
  if(s.db.query("SELECT name FROM sqlite_master WHERE name='startup_restores'").get()){
   const restore=(s.db.query("SELECT * FROM startup_restores WHERE state IN ('attempting','setup_consumed')").all() as any[]).find(r=>r.job===job||aliases(r.worktree));
   if(restore)return {...restore,id:restore.binding,planningRestore:true};
  }
 if(s.db.query("SELECT name FROM sqlite_master WHERE name='branch_syncs'").get()){
  const sync=(s.db.query("SELECT * FROM branch_syncs WHERE state!='completed'").all() as any[]).find(r=>r.job===job||aliases(r.worktree));
  if(sync)return {...sync,id:sync.job,branchSync:true};
 }
  if(s.db.query("SELECT name FROM sqlite_master WHERE name='planning_restores'").get()){
   const restore=(s.db.query("SELECT * FROM planning_restores WHERE state IN ('reserved','setup_consumed')").all() as any[]).find(r=>r.job===job||aliases(JSON.parse(r.proof).worktree));
   if(restore)return {...restore,id:restore.binding,planningRestore:true};
  }
  if(s.db.query("SELECT name FROM sqlite_master WHERE name='spec_replans'").get()&&s.db.query("SELECT name FROM sqlite_master WHERE name='planning_runs'").get()){
   const revision=(s.db.query("SELECT r.revision AS id,r.job,r.state,p.worktree FROM spec_replans r JOIN planning_runs p ON p.job=r.job WHERE r.state IN ('accepted','delivery_uncertain')").all() as any[]).find(r=>r.job===job||aliases(r.worktree));
   if(revision)return {...revision,specRevision:true};
  }
 if(s.db.query("SELECT name FROM sqlite_master WHERE name='dependency_updates'").get()){
  const dependency=(s.db.query("SELECT * FROM dependency_updates WHERE state IN ('reserved','fetching','updating')").all() as any[]).find(r=>r.job===job||aliases(r.worktree));
  if(dependency)return {...dependency,dependency:true};
 }
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='conflict_recoveries'").get())return;
 return (s.db.query("SELECT * FROM conflict_recoveries WHERE state!='completed'").all() as any[]).find(r=>r.job===job||aliases(r.worktree));
}
export function assertWorktreeAvailable(s:Store,job:string,target?:string,restoreBinding?:string,branchSyncProof?:string){
 const r=worktreeReservation(s,job,target);
  if(r?.planningRestore&&r.job===job&&r.binding===restoreBinding)return;
  if(r?.branchSync&&r.job===job&&r.proof===branchSyncProof)return;
  if(r)throw Error(`Worktree reserved by ${r.branchSync?'branch synchronization':r.planningRestore?'planning restore':r.specRevision?'specification':r.dependency?'dependency':'conflict'} recovery ${r.id} (${r.state}); inspect spec-restore/spec-reconcile/recovery-status/dependency-preview, never bypass or replay`);
}

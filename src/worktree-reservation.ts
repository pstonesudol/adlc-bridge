import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from './core';

export const canonicalWorktree=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
export function recoveryRows(s:Store):any[]{
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='conflict_recoveries'").get())return [];
 return s.db.query('SELECT * FROM conflict_recoveries ORDER BY created,id').all() as any[];
}
// These reservations fence cooperating bridge paths, not arbitrary native AO or
// human writers. Never expire a reservation based on elapsed time or a dead PID.
export function worktreeReservation(s:Store,job:string,target?:string):any{
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='conflict_recoveries'").get())return;
 const p=s.db.query("SELECT name FROM sqlite_master WHERE name='planning_runs'").get()?s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any:null;
 const run=s.db.query("SELECT name FROM sqlite_master WHERE name='runs'").get()?s.db.query('SELECT worktree FROM runs WHERE job=?').get(job) as any:null;
 const paths=[p?.worktree,run?.worktree,target].map(path=>path?canonicalWorktree(path):null);
 return s.db.query("SELECT * FROM conflict_recoveries WHERE state!='completed' AND (job=? OR worktree IN (?,?,?)) LIMIT 1").get(job,...paths);
}
export function assertWorktreeAvailable(s:Store,job:string,target?:string){
 const r=worktreeReservation(s,job,target);
 if(r)throw Error(`Worktree reserved by conflict recovery ${r.id} (${r.state}); inspect recovery-status, never bypass or replay`);
}

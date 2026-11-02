import {Store} from './core';

// Read-only provider retries have their own durable budget, never remediation
// attempts. Exhaustion requires explicit operator inspection, not another send.
export class RecoveryObservation{
 constructor(public s:Store,public now=Date.now){s.db.exec('CREATE TABLE IF NOT EXISTS recovery_observations(job TEXT PRIMARY KEY,failures INTEGER NOT NULL,next_read INTEGER NOT NULL,reason TEXT)');}
 wait(job:string){
  const r=this.s.db.query('SELECT * FROM recovery_observations WHERE job=?').get(job) as any;
  if(!r)return null;
  if(r.failures>=6)return {state:'blocked',send:false,reason:'Branch observation failed six times; inspect provider credentials/rate limits and use reconcile-publication preview, then retry-observation JOB to authorize more reads'};
  if(this.now()<r.next_read)return {state:'waiting_for_worker',send:false,reason:'Provider observation backoff; no turn or Git operation will be repeated'};
  return null;
 }
 failed(job:string){
  this.s.db.query('INSERT INTO recovery_observations VALUES (?,1,?,?) ON CONFLICT(job) DO UPDATE SET failures=failures+1,next_read=?,reason=excluded.reason').run(job,this.now()+1000,'Provider branch read unavailable',this.now()+60000);
 }
 clear(job:string){this.s.db.query('DELETE FROM recovery_observations WHERE job=?').run(job);}
}

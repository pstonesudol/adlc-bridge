import {randomUUID} from 'node:crypto';
import {Store} from './core';
import {readEvidence,type ReadEvidence} from './provider-read';
export const transient=(e:ReadEvidence)=>['throttled','timeout','network','server'].includes(e.classification);
export class RecoveryObservation{
 constructor(public s:Store,public now=Date.now,public random=Math.random){
 s.db.exec('CREATE TABLE IF NOT EXISTS recovery_observations(job TEXT PRIMARY KEY,failures INTEGER NOT NULL,next_read INTEGER NOT NULL,reason TEXT)');
 s.db.exec('CREATE TABLE IF NOT EXISTS observation_leases(key TEXT PRIMARY KEY,token TEXT NOT NULL,until_ms INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS observation_capacity(provider TEXT PRIMARY KEY,next_read INTEGER NOT NULL)');
 s.db.exec('CREATE TABLE IF NOT EXISTS mergeability_waits(job TEXT PRIMARY KEY,waits INTEGER NOT NULL,next_read INTEGER NOT NULL)');
 }
 status(job:string){const r=this.s.db.query('SELECT * FROM recovery_observations WHERE job=?').get(job) as any;if(!r)return null;let evidence;try{evidence=JSON.parse(r.reason);}catch{}return {...r,evidence:evidence?.classification?evidence:null,evidenceAgeMs:evidence?.timestamp?Math.max(0,this.now()-evidence.timestamp):null};}
 wait(job:string){const merge=this.s.db.query('SELECT * FROM mergeability_waits WHERE job=?').get(job) as any;
 if(merge&&(merge.waits>=6||this.now()<merge.next_read))return {state:merge.waits>=6?'blocked':'updating_branch',send:false,reason:merge.waits>=6?`Mergeability remained unknown for six observations; inspect GitHub branch state, then retry-observation ${job}. No mutation replay.`:`Mergeability unknown; next read at ${new Date(merge.next_read).toISOString()}`};
 const r=this.status(job);if(!r)return null;
 const permanent=r.evidence&&!transient(r.evidence);
 if(permanent||this.now()<r.next_read)return {state:permanent?'blocked':'waiting_for_worker',send:false,reason:permanent?`${r.evidence.provider} ${r.evidence.classification}: inspect provider login, repository/session access and configuration; then retry-observation ${job}. No mutation will be replayed.`:`Read observation backoff until ${new Date(r.next_read).toISOString()}; no mutation will be replayed`,observation:r};
 return null;
 }
 failed(job:string,error?:unknown,provider:ReadEvidence['provider']='github'){
 const e=readEvidence(error,provider),now=this.now();
 this.s.db.transaction(()=>{const old=this.status(job),n=(old?.failures??0)+1;
 const delay=n>=6?30*60*1000:Math.min(15*60*1000,1000*2**Math.min(n-1,10))*(0.75+this.random()*0.5);
 const next=Math.max(now+Math.ceil(delay),e.retryAt??0);
 this.s.db.query('INSERT INTO recovery_observations VALUES (?,?,?,?) ON CONFLICT(job) DO UPDATE SET failures=excluded.failures,next_read=excluded.next_read,reason=excluded.reason').run(job,n,next,JSON.stringify(e));
 if(transient(e))this.s.db.query('INSERT INTO observation_capacity VALUES (?,?) ON CONFLICT(provider) DO UPDATE SET next_read=MAX(next_read,excluded.next_read)').run(e.provider,next);
 }).immediate();
 }
 claim(key:string,duration=10*60*1000){const token=randomUUID();const ok=this.s.db.query('INSERT INTO observation_leases VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,until_ms=excluded.until_ms WHERE until_ms<=?').run(key,token,this.now()+duration,this.now()).changes;return ok?()=>{this.s.db.query('DELETE FROM observation_leases WHERE key=? AND token=?').run(key,token);}:null;}
 async read<T>(job:string,provider:ReadEvidence['provider'],read:()=>Promise<T>){
 const cap=this.s.db.query('SELECT next_read FROM observation_capacity WHERE provider=?').get(provider) as any;
 if(cap&&cap.next_read>this.now())throw new ObservationDeferred(cap.next_read);
 const release=this.claim(`provider:${provider}`);if(!release)throw new ObservationDeferred(this.now()+1000);
 try{return await read();}catch(error){this.failed(job,error,provider);throw error;}finally{release();}
 }
 clear(job:string){this.s.db.query('DELETE FROM recovery_observations WHERE job=?').run(job);}
 mergeabilityUnknown(job:string){this.s.db.query('INSERT INTO mergeability_waits VALUES (?,1,?) ON CONFLICT(job) DO UPDATE SET waits=waits+1,next_read=excluded.next_read').run(job,this.now()+60000);return this.wait(job)!;}
 mergeabilityKnown(job:string){this.s.db.query('DELETE FROM mergeability_waits WHERE job=?').run(job);}
 retry(job:string){this.clear(job);this.mergeabilityKnown(job);/* Shared provider cooldown is not an operator bypass. */}
}
export class ObservationDeferred extends Error{constructor(public nextRead:number){super(`Provider read deferred until ${new Date(nextRead).toISOString()}; no read failure or mutation`);}}

import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {BranchUpdates} from '../src/branch-updates';
import {RecoveryObservation,ObservationDeferred} from '../src/recovery-observation';
import {readFailure,readEvidence,malformed} from '../src/provider-read';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('alternating providers retain the job circuit budget',()=>{
 const s=new Store(':memory:');let now=100;const job=s.enqueue('p','i','s'),o=new RecoveryObservation(s,()=>now,()=>0.5);
 try{for(let n=1;n<=6;n++){
 o.failed(job,readFailure(n%2?'github':'orchestrator','observation','HTTP 503',1,undefined,now));
 expect(o.status(job).failures).toBe(n);if(n===6)expect(o.status(job).next_read-now).toBe(1800000);now=o.status(job).next_read;
 }o.clear(job);expect(o.status(job)).toBeNull();}finally{s.close();}
});
test('unknown mergeability has a separate bounded wait',()=>{
 const s=new Store(':memory:');let now=100;const job=s.enqueue('p','i','s');
 try{for(let n=1;n<=6;n++){
 const o=new RecoveryObservation(s,()=>now);expect(o.mergeabilityUnknown(job).state).toBe(n===6?'blocked':'updating_branch');expect(o.status(job)).toBeNull();now+=60001;
 }const o=new RecoveryObservation(s,()=>now);expect(o.wait(job)?.state).toBe('blocked');expect(s.get(job).attempts).toBe(0);o.retry(job);expect(o.wait(job)).toBeNull();}finally{s.close();}
});
test('six failures recover after restart without manual edits or remediation budget',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-observation-')),path=join(dir,'state.sqlite');
 let s=new Store(path);const job=s.enqueue('p','issue','spec');let now=100;
 try{
 new BranchUpdates(s);s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(job,'head','base','delivery_uncertain',now,'Lost reply');
 for(let n=0;n<6;n++){
 const o=new RecoveryObservation(s,()=>now,()=>0.5);
 await expect(o.read(job,'github',async()=>{throw readFailure('github','branch-read','HTTP 503',1,undefined,now);})).rejects.toThrow();
 expect(o.status(job).failures).toBe(n+1);expect(o.wait(job)).not.toBeNull();
 now=o.status(job).next_read;s.close();s=new Store(path);
 }
 const o=new RecoveryObservation(s,()=>now);expect(o.wait(job)).toBeNull();
 expect(await o.read(job,'github',async()=>({complete:true}))).toEqual({complete:true});o.clear(job);
 expect(o.status(job)).toBeNull();expect(s.get(job).attempts).toBe(0);
 expect(s.db.query('SELECT state,reason FROM branch_updates WHERE job=?').get(job)).toEqual({state:'delivery_uncertain',reason:'Lost reply'});
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('leases persist across restart and expire without multiplying active probes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-observation-lease-')),path=join(dir,'state.sqlite');let s=new Store(path),now=100;
 try{
 const o=new RecoveryObservation(s,()=>now);expect(o.claim('provider:github',1000)).not.toBeNull();s.close();s=new Store(path);
 const restarted=new RecoveryObservation(s,()=>now);expect(restarted.claim('provider:github')).toBeNull();now=1101;
 const release=restarted.claim('provider:github')!;expect(release).not.toBeNull();expect(restarted.claim('provider:github')).toBeNull();release();
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('classification and safe evidence, including nested cause',()=>{
 for(const [raw,classification] of [['HTTP 401','authentication'],['HTTP 403','permission'],['HTTP 403 secondary rate limit','throttled'],['HTTP 429','throttled'],['HTTP 404','missing'],['HTTP 502','server'],['ETIMEDOUT','timeout'],['ECONNRESET','network'],['unexpected failure','unknown']]){
 const error=readFailure('github','branch-read',`${raw}\nAuthorization: Bearer TOPSECRET\nprivate payload\nghp_secret`,1);
 expect(error.evidence.classification).toBe(classification);
 expect(JSON.stringify(error.evidence)).not.toContain('TOPSECRET');expect(JSON.stringify(error.evidence)).not.toContain('private payload');expect(JSON.stringify(error.evidence)).not.toContain('ghp_');
 expect(readEvidence(new Error('wrapper',{cause:error}))).toEqual(error.evidence);
 }
 expect(malformed('orchestrator','session-evidence').evidence.classification).toBe('malformed');
 expect(readFailure('github','branch-read','HTTP 429\nRetry-After: 60\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 90\nx-github-request-id: ABC:123\n',1,undefined,1000).evidence).toMatchObject({retryAt:90000,requestId:'ABC:123'});
});
test('shared capacity, lease dedupe, manual retry and permanent failures',async()=>{
 const s=new Store(':memory:');let now=100;const o=new RecoveryObservation(s,()=>now,()=>0.5),a=s.enqueue('p','a','s'),b=s.enqueue('q','b','s');
 try{
 const release=o.claim('job:a')!;expect(o.claim('job:a')).toBeNull();release();expect(o.claim('job:a')).not.toBeNull();
 o.failed(a,readFailure('github','branch-read','HTTP 429\nRetry-After: 60\n',1,undefined,now));
 o.retry(a);let called=false;await expect(o.read(b,'github',async()=>{called=true;})).rejects.toBeInstanceOf(ObservationDeferred);expect(called).toBe(false);expect(o.status(b)).toBeNull();
 now+=60001;await o.read(b,'github',async()=>true);
 o.failed(a,readFailure('orchestrator','session-evidence','HTTP 401',1,undefined,now));now+=86400000;
 expect(o.wait(a)?.state).toBe('blocked');expect(o.status(a).evidence.provider).toBe('orchestrator');o.retry(a);expect(o.wait(a)).toBeNull();
 }finally{s.close();}
});

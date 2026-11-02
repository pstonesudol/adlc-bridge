import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {RecoveryObservation} from '../src/recovery-observation';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('provider backoff survives observer restart and spends no remediation budget',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-observation-')),path=join(dir,'state.sqlite');
 let s=new Store(path);const job=s.enqueue('p','issue','spec');let now=0;
 try{
  new RecoveryObservation(s,()=>now).failed(job);s.close();s=new Store(path);
  const o=new RecoveryObservation(s,()=>now);expect(o.wait(job)).not.toBeNull();
  expect(s.db.query('SELECT failures,next_read FROM recovery_observations').get()).toEqual({failures:1,next_read:1000});
  now=1001;expect(o.wait(job)).toBeNull();o.clear(job);
  for(let n=0;n<6;n++){o.failed(job);expect(new RecoveryObservation(s,()=>now).wait(job)).not.toBeNull();now+=60001;}
  expect(o.wait(job)?.state).toBe('blocked');expect(s.get(job).attempts).toBe(0);
  o.clear(job);expect(o.wait(job)).toBeNull();expect(s.get(job).attempts).toBe(0);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

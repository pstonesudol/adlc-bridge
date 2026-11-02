import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {RecoveryObservation} from '../src/recovery-observation';
test('provider backoff survives observer restart and spends no remediation budget',()=>{
 const s=new Store(':memory:'),job=s.enqueue('p','issue','spec');let now=0;
 try{
  const o=new RecoveryObservation(s,()=>now);expect(o.wait(job)).toBeNull();
  for(let n=0;n<6;n++){o.failed(job);expect(new RecoveryObservation(s,()=>now).wait(job)).not.toBeNull();now+=60001;}
  expect(o.wait(job)?.state).toBe('blocked');expect(s.get(job).attempts).toBe(0);
  o.clear(job);expect(o.wait(job)).toBeNull();expect(s.get(job).attempts).toBe(0);
 }finally{s.close();}
});

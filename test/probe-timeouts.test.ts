import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {disableNativeFeedback} from '../src/ao-policy';import {sessionEvidence} from '../src/session-evidence';import {turnBarrier} from '../src/turn-submission';

for(const [name,read,message] of [['native feedback status',disableNativeFeedback,'status probe failed'],['session evidence',sessionEvidence,'session inspection failed']] as const){
 test(`${name} timeout terminates the subprocess and releases the submission fence`,async()=>{
  const state=mkdtempSync(join(tmpdir(),'adlc-probe-timeout-')),turns=turnBarrier(state);let child:ReturnType<typeof Bun.spawn>|undefined;
  try{
   let options:any,launched!:()=>void;const started=new Promise<void>(resolve=>launched=resolve);
   const spawn=((_args:any,opts:any)=>{options=opts;child=Bun.spawn([process.execPath,'-e','await Bun.sleep(60000)'],{...opts,timeout:100,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:state}});launched();return child;}) as typeof Bun.spawn;
   const pending=turns.submit(()=>read('worker',spawn));await started;
   expect(options).toEqual({stdout:'pipe',stderr:'pipe',timeout:30000});expect(child!.exitCode).toBeNull();await expect(turnBarrier(state).run(async()=>{})).rejects.toThrow('in progress');
   await expect(pending).rejects.toThrow(message);expect(child!.signalCode).toBe('SIGTERM');await turnBarrier(state).run(async()=>{});
  }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}rmSync(state,{recursive:true,force:true});}
 });
}
test('session evidence preserves valid output and rejects failed or mismatched receipts with a bounded spawn',async()=>{
 const output={session:{id:'worker'},transcript:{entries:[]}};let options:any;
 const spawn=((_args:any,opts:any)=>{options=opts;return {stdout:new Response(JSON.stringify(output)).body,stderr:new Response('').body,exited:Promise.resolve(0)};}) as typeof Bun.spawn;
 expect(await sessionEvidence('worker',spawn)).toEqual(output);expect(options.timeout).toBe(30000);await expect(sessionEvidence('other',spawn)).rejects.toThrow('Invalid session evidence');
});

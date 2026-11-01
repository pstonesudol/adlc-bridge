import {test,expect} from 'bun:test';import {mkdtempSync,writeFileSync,readFileSync,readdirSync,chmodSync,rmSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {acknowledgePoll,assertPollQuiescent,assertPollStarted} from '../src/poll-process';import {stopLoadedIntake,waitForPollStartup} from '../src/service-control';import {turnBarrier} from '../src/turn-submission';import {controlStack,type StackOps} from '../src/stack-control';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'adlc-poll-proof-')),state=join(root,'state'),config=join(root,'project.json'),cli=join(root,'cli.ts');writeFileSync(config,'{}');writeFileSync(cli,'barrier-aware CLI');const turns=turnBarrier(state);
 const started=()=> 'known start',verify=(status:any,c=config,program=cli)=>assertPollQuiescent(status,c,program,state,started);
 return {root,state,config,cli,turns,started,verify,receipt:()=>join(state,'poll-processes',readdirSync(join(state,'poll-processes'))[0]),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('loaded legacy intake is preserved even when the new barrier is available and launchd reports idle',async()=>{
 const f=fixture();try{let bootouts=0;for(const status of [{loaded:true,running:true,pid:process.pid},{loaded:true,running:false}])await f.turns.run(async()=>{await expect(stopLoadedIntake(status,f.config,f.cli,async()=>{bootouts++;},f.verify)).rejects.toThrow('barrier support is unverified');});expect(bootouts).toBe(0);
  await stopLoadedIntake({loaded:false},f.config,f.cli,async()=>{bootouts++;},()=>{throw Error('Unloaded legacy service needs no receipt');});expect(bootouts).toBe(0);
 }finally{f.close();}
});
test('barrier-aware running and cleanly completed poll receipts allow fenced stop without changing start/status behavior',async()=>{
 const f=fixture();try{
  const finished=await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit);let bootouts=0;
  await f.turns.run(()=>stopLoadedIntake({loaded:true,running:true,pid:process.pid},f.config,f.cli,async()=>{bootouts++;},f.verify));
  await expect(stopLoadedIntake({loaded:true,running:false},f.config,f.cli,async()=>{bootouts++;},f.verify)).rejects.toThrow('quiescence is unverified');
  finished();await f.turns.run(()=>stopLoadedIntake({loaded:true,running:false},f.config,f.cli,async()=>{bootouts++;},f.verify));expect(bootouts).toBe(2);
 }finally{f.close();}
});
test('reused PIDs, changed CLI bytes, insecure and symlinked receipts never establish service quiescence',async()=>{
 const f=fixture();try{
  await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit);const status={pid:process.pid,running:true},path=f.receipt(),original=readFileSync(path);
  expect(()=>f.verify({...status,pid:process.pid+1})).toThrow('has not acknowledged');expect(()=>assertPollQuiescent(status,f.config,f.cli,f.state,()=> 'reused PID start')).toThrow('has not acknowledged');
  writeFileSync(f.cli,'different process code');expect(()=>f.verify(status)).toThrow('does not match');writeFileSync(f.cli,'barrier-aware CLI');chmodSync(path,0o644);expect(()=>f.verify(status)).toThrow('owner-only');chmodSync(path,0o600);
  const other=join(f.root,'receipt');writeFileSync(other,original,{mode:0o600});rmSync(path);symlinkSync(other,path);expect(()=>f.verify(status)).toThrow('owner-only');
 }finally{f.close();}
});
test('stack startup confirms a paused poll receipt before resuming and polling waits for fence release',async()=>{
 const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let poll:Promise<()=>void>|undefined;
 try{
  let entered=0,verified=false,kicks=0;
  const ops:StackOps={turns:f.turns,projects:async()=>[{project:'one'}],backendStart:async()=>{},backend:async()=>({loaded:true,ready:true,managed:true}),backendStop:async()=>{throw Error('No backend stop expected');},blockers:async()=>[],project:async()=>{
   poll=acknowledgePoll(f.config,f.cli,f.state,f.started,turnBarrier(f.state).submit,{timeoutMs:Infinity,pause:()=>gate}).then(finish=>{entered++;return finish;});
   const status=await waitForPollStartup(async()=>({loaded:true,running:true,pid:process.pid}),current=>{assertPollStarted(current,f.config,f.cli,f.state,f.started);verified=true;},async()=>{kicks++;},{attempts:1,pause:async()=>{}});
   expect(entered).toBe(0);await expect(turnBarrier(f.state).submit(async()=>{})).rejects.toThrow('in progress');return status;
  }};
  expect((await controlStack('start',ops)).backend.ready).toBe(true);expect(verified).toBe(true);expect(kicks).toBe(1);expect(entered).toBe(0);
  release();const finish=await poll!;expect(entered).toBe(1);finish();f.verify({loaded:true,running:false});
 }finally{f.turns.resume();release?.();if(poll)await poll.catch(()=>{});f.close();}
});
test('unacknowledged poll startup fails stack start and keeps turn submissions paused',async()=>{
 const f=fixture();try{
  let kicks=0,reads=0;
  const ops:StackOps={turns:f.turns,projects:async()=>[{project:'one'}],backendStart:async()=>{},backend:async()=>({loaded:true,ready:true,managed:true}),backendStop:async()=>{},blockers:async()=>[],project:async()=>waitForPollStartup(async()=>{reads++;return {loaded:true,running:false};},current=>assertPollStarted(current,f.config,f.cli,f.state,f.started),async()=>{kicks++;},{attempts:2,pause:async()=>{}})};
  await expect(controlStack('start',ops)).rejects.toThrow('startup acknowledgement unavailable');expect(kicks).toBe(1);expect(reads).toBe(2);await expect(f.turns.submit(async()=>{})).rejects.toThrow('paused');
 }finally{f.close();}
});
test('poll startup rejects completed, foreign-PID and reused-PID receipts',async()=>{
 const f=fixture();try{
  const finished=await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit),status={loaded:true,running:true,pid:process.pid};
  expect(()=>assertPollStarted(status,f.config,f.cli,f.state,f.started)).not.toThrow();expect(()=>assertPollStarted({...status,running:false},f.config,f.cli,f.state,f.started)).toThrow('not acknowledged');
  expect(()=>assertPollStarted({...status,pid:process.pid+1},f.config,f.cli,f.state,f.started)).toThrow('not acknowledged');expect(()=>assertPollStarted(status,f.config,f.cli,f.state,()=> 'reused PID')).toThrow('not acknowledged');
  finished();expect(()=>assertPollStarted(status,f.config,f.cli,f.state,f.started)).toThrow('not acknowledged');
 }finally{f.close();}
});
test('poll startup wait does not retry unrelated errors and records a clean pre-poll completion',async()=>{
 const f=fixture();try{
  const original=Error('filesystem or startup failure');let calls=0;
  expect(await acknowledgePoll(f.config,f.cli,f.state,f.started,async()=>{calls++;throw original;},{timeoutMs:0,pause:async()=>{throw Error('Must not retry');}}).catch(error=>error)).toBe(original);expect(calls).toBe(1);f.verify({loaded:true,running:false});
  let verified=0;await expect(waitForPollStartup(async()=>{throw Error('Must not inspect after failed kickstart');},()=>{verified++;},async()=>{throw Error('kickstart failed');},{attempts:2,pause:async()=>{}})).rejects.toThrow('kickstart failed');expect(verified).toBe(0);
 }finally{f.close();}
});
test('a real child poll acknowledges startup under the stack fence without entering polling until resume',async()=>{
 const f=fixture();let child:ReturnType<typeof Bun.spawn>|undefined;try{
  let verified=false,exited=false;
  const ops:StackOps={turns:f.turns,projects:async()=>[{project:'one'}],backendStart:async()=>{},backend:async()=>({loaded:true,ready:true,managed:true}),backendStop:async()=>{},blockers:async()=>[],project:async()=>{
   child=Bun.spawn([process.execPath,join(import.meta.dir,'poll-startup-fixture.ts'),f.config,f.cli,f.state],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root}});void child.exited.then(()=>{exited=true;});
   const status=await waitForPollStartup(async()=>({loaded:true,running:child!.exitCode===null,pid:child!.pid}),current=>{assertPollStarted(current,f.config,f.cli,f.state);verified=true;},async()=>{});
   expect(exited).toBe(false);expect(child.exitCode).toBeNull();return status;
  }};
  await controlStack('start',ops);expect(verified).toBe(true);
  const [out,err,code]=await Promise.all([new Response(child!.stdout).text(),new Response(child!.stderr).text(),child!.exited]);expect(code).toBe(0);expect(err).toBe('');expect(JSON.parse(out)).toEqual({pollingEntered:true});assertPollQuiescent({running:false},f.config,f.cli,f.state);
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}f.close();}
},15000);

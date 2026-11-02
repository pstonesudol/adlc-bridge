import {test,expect,spyOn} from 'bun:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,chmodSync,rmSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {acknowledgePoll,assertPollQuiescent,assertPollStarted} from '../src/poll-process';import {stopLoadedIntake,waitForPollStartup} from '../src/service-control';import {turnBarrier} from '../src/turn-submission';import {controlStack,type StackOps} from '../src/stack-control';
import {TurnSubmissionBlocked} from '../src/turn-submission';import {PollProcessNotRunning} from '../src/poll-process';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'adlc-poll-proof-')),state=join(root,'state'),config=join(root,'project.json'),cli=join(root,'cli.ts');writeFileSync(config,'{}');writeFileSync(cli,'barrier-aware CLI');const turns=turnBarrier(state);
 const started=()=> 'known start',verify=(status:any,c=config,program=cli)=>assertPollQuiescent(status,c,program,state,started);
 return {root,state,config,cli,turns,started,verify,receipt:()=>join(state,'poll-processes',readdirSync(join(state,'poll-processes'))[0]),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('foreground startup reports blocking once while retrying and silent startup needs no notification',async()=>{
 for(const interactive of [false,true]){const f=fixture();try{
  let attempts=0,pauses=0,notices=0;
  const finish=await acknowledgePoll(f.config,f.cli,f.state,f.started,async operation=>{if(++attempts<=3)throw new TurnSubmissionBlocked('paused');return operation();},{timeoutMs:Infinity,pause:async()=>{pauses++;expect(notices).toBe(interactive?1:0);},onBlocked:interactive?()=>{notices++;}:undefined});
  expect(attempts).toBe(4);expect(pauses).toBe(3);expect(notices).toBe(interactive?1:0);assertPollStarted({running:true,pid:process.pid},f.config,f.cli,f.state,f.started);finish();f.verify({running:false});
 }finally{f.close();}}
});
test('default startup notification writes once only when stdin and stderr are interactive',async()=>{
 for(const inputTTY of [false,true])for(const errorTTY of [false,true]){const f=fixture();try{
  // Scope stream-property overrides to a child; exercise the production default
  // wait options and console.error rather than supplying a notification hook.
  const script=`
import {acknowledgePoll,assertPollQuiescent} from ${JSON.stringify(join(import.meta.dir,'../src/poll-process.ts'))};
import {TurnSubmissionBlocked} from ${JSON.stringify(join(import.meta.dir,'../src/turn-submission.ts'))};
Object.defineProperty(process.stdin,'isTTY',{value:${inputTTY}});
Object.defineProperty(process.stderr,'isTTY',{value:${errorTTY}});
let attempts=0;
const finish=await acknowledgePoll(${JSON.stringify(f.config)},${JSON.stringify(f.cli)},${JSON.stringify(f.state)},()=> 'child start',async operation=>{if(++attempts<=3)throw new TurnSubmissionBlocked('paused');return operation();});
finish();assertPollQuiescent({running:false},${JSON.stringify(f.config)},${JSON.stringify(f.cli)},${JSON.stringify(f.state)});
console.log(JSON.stringify({attempts}));`;
  const child=Bun.spawn([process.execPath,'-e',script],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root},timeout:10000});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code).toBe(0);expect(JSON.parse(out)).toEqual({attempts:4});expect(err).toBe(inputTTY&&errorTTY?'Intake startup is waiting for the submission pause or control operation to clear; polling has not started.\n':'');
 }finally{f.close();}}
},15000);
test('unblocked startup never emits the waiting notice',async()=>{
 const f=fixture();try{let notices=0;const finish=await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit,{timeoutMs:Infinity,pause:async()=>{},onBlocked:()=>{notices++;}});expect(notices).toBe(0);finish();}finally{f.close();}
});
test('startup preserves another live poll receipt and replaces only idle, dead or reused-PID receipts',async()=>{
 for(const mode of ['live','idle','dead','reused','unknown']){const f=fixture();try{
  await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit);const path=f.receipt(),prior={...JSON.parse(readFileSync(path,'utf8')),pid:process.pid+1,started:'prior start',idle:mode==='idle'};writeFileSync(path,JSON.stringify(prior),{mode:0o600});const before=readFileSync(path);let submissions=0;
  const started=(pid:number)=>{if(pid===process.pid)return 'current start';if(mode==='dead')throw new PollProcessNotRunning('gone');if(mode==='unknown')throw Error('inspection failed');return mode==='reused'?'different start':'prior start';};
  const startup=acknowledgePoll(f.config,f.cli,f.state,started,async operation=>{submissions++;return operation();});
  if(mode==='live'||mode==='unknown'){await expect(startup).rejects.toThrow(mode==='live'?'Another live poll':'inspection failed');expect(readFileSync(path)).toEqual(before);expect(submissions).toBe(0);}
  else{const finish=await startup;expect(JSON.parse(readFileSync(path,'utf8'))).toMatchObject({pid:process.pid,started:'current start',idle:false});expect(submissions).toBe(1);finish();}
 }finally{f.close();}}
});
test('receipt claim contention identifies its path and preserves the existing receipt and lock',async()=>{
 const f=fixture();try{
  const finish=await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit);finish();const path=f.receipt(),claim=path+'.lock',before=readFileSync(path);mkdirSync(claim);
  await expect(acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit)).rejects.toThrow(`Poll receipt claim is held or abandoned; inspect before retrying: ${claim}`);expect(readFileSync(path)).toEqual(before);expect(readdirSync(claim)).toEqual([]);
 }finally{f.close();}
});
test('receipt claim cleanup failure reports its path without replacing the startup error',async()=>{
 const f=fixture();const log=spyOn(console,'error').mockImplementation(()=>{});try{
  await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit);const path=f.receipt(),claim=path+'.lock';const prior={...JSON.parse(readFileSync(path,'utf8')),pid:process.pid+1};writeFileSync(path,JSON.stringify(prior));const before=readFileSync(path),original=Error('Cannot inspect prior process');
  const started=(pid:number)=>{if(pid===process.pid)return 'current start';writeFileSync(join(claim,'preserve'),'inspection required');throw original;};
  expect(await acknowledgePoll(f.config,f.cli,f.state,started,f.turns.submit).catch(error=>error)).toBe(original);expect(readFileSync(path)).toEqual(before);expect(log).toHaveBeenCalledWith('Poll receipt claim cleanup needs inspection:',claim);expect(readFileSync(join(claim,'preserve'),'utf8')).toBe('inspection required');
 }finally{log.mockRestore();f.close();}
});
test('a real live poll keeps its receipt when a second startup is rejected, and a dead owner can be replaced',async()=>{
 const f=fixture();let child:ReturnType<typeof Bun.spawn>|undefined;try{
  const script=`import {acknowledgePoll} from ${JSON.stringify(join(import.meta.dir,'../src/poll-process.ts'))};import {turnBarrier} from ${JSON.stringify(join(import.meta.dir,'../src/turn-submission.ts'))};await acknowledgePoll(${JSON.stringify(f.config)},${JSON.stringify(f.cli)},${JSON.stringify(f.state)},undefined,turnBarrier(${JSON.stringify(f.state)}).submit);console.log('ready');await Bun.sleep(60000);`;
  child=Bun.spawn([process.execPath,'-e',script],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root},timeout:10000});
  const reader=(child.stdout as ReadableStream<Uint8Array>).getReader(),ready=await reader.read();expect(new TextDecoder().decode(ready.value)).toBe('ready\n');reader.releaseLock();
  const path=f.receipt(),before=readFileSync(path);await expect(acknowledgePoll(f.config,f.cli,f.state,undefined,f.turns.submit)).rejects.toThrow('Another live poll');expect(readFileSync(path)).toEqual(before);assertPollStarted({running:true,pid:child.pid},f.config,f.cli,f.state);
  child.kill();await child.exited;const finish=await acknowledgePoll(f.config,f.cli,f.state,undefined,f.turns.submit);expect(JSON.parse(readFileSync(path,'utf8')).pid).toBe(process.pid);finish();assertPollQuiescent({running:false},f.config,f.cli,f.state);
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}f.close();}
},15000);
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

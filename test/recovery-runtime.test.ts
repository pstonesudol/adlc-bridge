import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {ReviewLoop} from '../src/review-loop';
import {createRecoveryIO,recoverProject} from '../src/recovery-runtime';
import {PreSendFailure} from '../src/pre-send';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
const processResult=(out='',code=0)=>({stdout:new Blob([out]),stderr:new Blob([]),exited:Promise.resolve(code)}) as any;

test('native restores and successive repository commands share the remaining absolute budget',async()=>{
 const s=new Store(':memory:');let now=1000;const timeouts:number[]=[];
 try{
  const io=createRecoveryIO(s,1300,undefined,{now:()=>now,spawn:((args:any,options:any)=>{timeouts.push(options.timeout);now+=100;return processResult(args[0]==='git'?'read result':'');}) as any});
  await io.transport.restorePlan!('worker','project');expect(await io.run(['git','status'])).toBe('read result');await io.transport.restorePlan!('worker','project');
  expect(timeouts).toEqual([300,200,100]);
  await expect(io.run(['git','status'])).rejects.toThrow('deadline');
  await expect(io.transport.restorePlan!('worker','project')).rejects.toBeInstanceOf(PreSendFailure);expect(timeouts).toHaveLength(3);
 }finally{s.close();}
});
test('restoreRepository receives a shrinking timeout for every subprocess and stops at the deadline',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'recovery-inspection-budget-'))),tree=join(root,'tree'),s=new Store(':memory:');mkdirSync(tree);
 try{
  const job=s.enqueue('linear','issue','spec'),planning=new Planning(s),p=planning.reserve(job,'project');planning.gate(job,'project','worker',p.branch,tree);
  let now=0;const calls:any[]=[];
  const io=createRecoveryIO(s,250,undefined,{now:()=>now,registry:()=>{},spawn:((args:string[],options:any)=>{
   calls.push({args,timeout:options.timeout});now+=100;
   if(args.includes('--show-toplevel'))return processResult(tree);
   if(args.includes('--show-current'))return processResult(p.branch);
   if(args.at(-1)==='HEAD')return processResult('a'.repeat(40));
   throw Error('No command may launch after the budget is consumed');
  }) as any});
  await expect(io.inspect(s,job,{repo:root})).rejects.toThrow('deadline');expect(calls.map(x=>x.timeout)).toEqual([250,150,50]);
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});
test('a stalled native restore is killed within its budget and its subprocess settles before rejection',async()=>{
 const s=new Store(':memory:');let child:any,settled=false,launched=0;const began=Date.now();
 try{
  const io=createRecoveryIO(s,began+300,undefined,{spawn:((_args:any,options:any)=>{
   launched++;expect(options.timeout).toBeGreaterThan(0);expect(options.timeout).toBeLessThanOrEqual(300);
   child=Bun.spawn([process.execPath,'-e','await Bun.sleep(10000)'],options);child.exited.then(()=>{settled=true;});return child;
  }) as any});
  await expect(io.transport.restorePlan!('worker','project')).rejects.toThrow('uncertain');expect(settled).toBe(true);expect(await child.exited).not.toBe(0);expect(Date.now()-began).toBeLessThan(4000);
  await expect(io.transport.restorePlan!('worker','project')).rejects.toBeInstanceOf(PreSendFailure);expect(launched).toBe(1);
 }finally{if(child){child.kill();await child.exited;}s.close();}
});
test('deadline aborts an awaited native HTTP response body, not only the initial fetch',async()=>{
 const s=new Store(':memory:');let signal:AbortSignal|undefined,bodySettled=false,sends=0;
 try{
  const io=createRecoveryIO(s,Date.now()+200,undefined,{trust:()=>true,spawn:((_args:any,_options:any)=>processResult(JSON.stringify({state:'ready',executablePath:'/fixture',port:3001}))) as any,
   send:(async(_input:any,options:any)=>{
    sends++;signal=options.signal;
    return new Response(new ReadableStream({start(controller){const abort=()=>{bodySettled=true;controller.error(signal!.reason);};if(signal!.aborted)abort();else signal!.addEventListener('abort',abort,{once:true});}}));
   }) as any});
  await expect(io.api('sessions')).rejects.toThrow();expect(signal?.aborted).toBe(true);expect(bodySettled).toBe(true);
  await expect(io.api('sessions')).rejects.toBeInstanceOf(PreSendFailure);expect(sends).toBe(1);
 }finally{s.close();}
});
test('deadline-bound HTTP preserves a caller cancellation signal',async()=>{
 const s=new Store(':memory:');const caller=new AbortController();caller.abort();let aborted=false;
 try{
  const io=createRecoveryIO(s,Date.now()+1000,undefined,{send:(async(_input:any,options:any)=>{aborted=options.signal.aborted;throw options.signal.reason;}) as any});
  await expect(io.send('http://fixture.invalid',{signal:caller.signal})).rejects.toThrow();expect(aborted).toBe(true);
 }finally{s.close();}
});
test('an exhausted recovery pass does not admit ordinary workflow dispatch',async()=>{
 const root=mkdtempSync(join(tmpdir(),'recovery-admission-budget-')),s=new Store(':memory:');let now=0;
 try{
  const io=createRecoveryIO(s,100,undefined,{now:()=>now}),w=new Workflow(s,io.transport),loop=new ReviewLoop(s);
  const result=await recoverProject(s,w,loop,{linear:{projectId:'project'}},{state:root,deadline:100,io,inventory:async()=>{now=100;return [];}});
  expect(result).toMatchObject({admit:false,complete:false});expect(result.reason).toContain('deadline');
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});

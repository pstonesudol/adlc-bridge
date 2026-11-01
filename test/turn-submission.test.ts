import {test,expect} from 'bun:test';
import {mkdtempSync,realpathSync,existsSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {turnBarrier} from '../src/turn-submission';import {controlStack,type StackOps} from '../src/stack-control';import {createWorkflowTransport} from '../src/workflow-transport';import {createFeatureAgents} from '../src/feature-transport';
import {Store} from '../src/core';import {Workflow} from '../src/workflow';import {featureFixture,featureConfig,requirements} from './feature-fixture';
const receipt=(exited=Promise.resolve(0))=>({stdout:new Response('{}').body,stderr:new Response('').body,exited});
function fixture(){
 const state=realpathSync(mkdtempSync(join(tmpdir(),'adlc-turns-'))),turns=turnBarrier(state),calls:string[]=[];let on=true;
 const ops:StackOps={turns,projects:async()=>[],project:async()=>({}),backend:async()=>({ready:on,loaded:on,managed:true}),backendStart:async()=>{calls.push('start');on=true;},backendStop:async()=>{calls.push('stop');on=false;},blockers:async()=>{calls.push('scan');return [];}};
 return {state,turns,ops,calls,close:()=>rmSync(state,{recursive:true,force:true})};
}
test('an in-flight implementation send retains the shared barrier until the delivery receipt settles',async()=>{
 const f=fixture();let finish!:(value:number)=>void;const exited=new Promise<number>(resolve=>finish=resolve);let sends=0;
 try{
  f.ops.projects=async()=>[{project:'intake'}];f.ops.project=async action=>{f.calls.push(`${action}:intake`);return {};};
  const transport=createWorkflowTransport(f.turns.submit,(()=>{sends++;return receipt(exited);}) as any),delivery=transport.sendImplementation('worker','prompt','key');
  await expect(controlStack('stop',f.ops)).rejects.toThrow('submission or shutdown is in progress');expect(f.calls).toEqual([]);expect(sends).toBe(1);
  finish(0);await delivery;f.ops.blockers=async()=>[{session:'worker',reason:'queued turn'}];await expect(controlStack('stop',f.ops)).rejects.toThrow('queued turn');expect(f.calls).not.toContain('stop');
  await expect(transport.sendImplementation('worker','later','key2')).rejects.toThrow('paused');expect(sends).toBe(1);
 }finally{finish?.(0);f.close();}
});
test('shutdown fences every bridge turn transport during its final scan, backend stop and afterward until start',async()=>{
 const f=fixture();let sends=0,creates=0;try{
  const spawn=(()=>{sends++;return receipt();}) as any,workflow=createWorkflowTransport(f.turns.submit,spawn,async()=>{creates++;return {};});const feature=createFeatureAgents(f.turns.submit,spawn);
  const rejected=async()=>{
   await expect(workflow.sendImplementation('worker','prompt','key')).rejects.toThrow();await expect(feature.send('worker','prompt','key')).rejects.toThrow();
   await expect(workflow.startPlan({project:'p',branch:'feature',name:'plan',prompt:'prompt',clientId:'key'})).rejects.toThrow();await expect(feature.start({route:{},name:'feature',key:'key'} as any)).rejects.toThrow();
  };
  f.ops.blockers=async()=>{await rejected();return [];};const stop=f.ops.backendStop;f.ops.backendStop=async()=>{await rejected();await stop();};
  await controlStack('stop',f.ops);await rejected();expect(sends).toBe(0);expect(creates).toBe(0);expect(existsSync(join(f.state,'turn-submissions.paused'))).toBe(true);
  await controlStack('start',f.ops);await workflow.sendImplementation('worker','prompt','key');await feature.send('worker','prompt','key');expect(sends).toBe(2);
 }finally{f.close();}
});
test('the turn barrier coordinates independent processes and never steals an active lock',async()=>{
 const f=fixture();let child:any;try{
  const module=join(import.meta.dir,'../src/turn-submission.ts'),script=`import {turnBarrier} from ${JSON.stringify(module)};await turnBarrier(${JSON.stringify(f.state)}).submit(async()=>{console.log('held');await new Response(Bun.stdin.stream()).text();});`;
  child=Bun.spawn([process.execPath,'-e',script],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.state}});
  const reader=child.stdout.getReader();const first=await reader.read();expect(new TextDecoder().decode(first.value)).toContain('held');
  await expect(f.turns.run(async()=>{})).rejects.toThrow('in progress');expect(existsSync(join(f.state,'turn-submission.lock'))).toBe(true);
  child.stdin.end();expect(await child.exited).toBe(0);reader.releaseLock();await f.turns.run(async()=>{});expect(existsSync(join(f.state,'turn-submission.lock'))).toBe(false);
 }finally{if(child&&child.exitCode===null){child.stdin.end();await child.exited;}f.close();}
});
test('failed backend startup never removes a persisted submission pause',async()=>{
 const f=fixture();try{await controlStack('stop',f.ops);f.ops.backendStart=async()=>{throw Error('startup failed');};await expect(controlStack('start',f.ops)).rejects.toThrow('startup failed');await expect(f.turns.submit(async()=>{})).rejects.toThrow('paused');expect(existsSync(join(f.state,'turn-submission.lock'))).toBe(false);}finally{f.close();}
});
test('planning setup retains the barrier through receipt validation and native feedback setup',async()=>{
 const f=fixture();let release!:()=>void;let entered!:()=>void;const setupEntered=new Promise<void>(resolve=>entered=resolve),setupGate=new Promise<void>(resolve=>release=resolve);
 try{
  const transport=createWorkflowTransport(f.turns.submit,undefined,async()=>({session:{id:'worker',projectId:'p',branch:'feature'}}),async()=>{entered();await setupGate;return {};});
  const setup=transport.startPlan({project:'p',branch:'feature',name:'plan',prompt:'prompt',clientId:'key'});await setupEntered;
  await expect(f.turns.run(async()=>{})).rejects.toThrow('in progress');release();expect(await setup).toEqual({id:'worker'});await f.turns.run(async()=>{});
  let disabled=false;const invalid=createWorkflowTransport(f.turns.submit,undefined,async()=>({session:{id:'worker',projectId:'foreign',branch:'feature'}}),async()=>{disabled=true;return {};});
  await expect(invalid.startPlan({project:'p',branch:'feature',name:'plan',prompt:'prompt',clientId:'key'})).rejects.toThrow('Invalid planning spawn receipt');expect(disabled).toBe(false);await f.turns.run(async()=>{});
 }finally{release?.();f.close();}
});
test('planning and feature reservations made during project shutdown are refused before becoming uncertain',async()=>{
 const f=fixture(),s=new Store(':memory:'),feature=featureFixture();let creates=0;
 try{
  const transport=createWorkflowTransport(f.turns.submit,undefined,async(_path,_method,body:any)=>{creates++;return {session:{id:'worker',projectId:body.projectId,branch:body.branch}};},async()=>({}));
  const workflow=new Workflow(s,transport),job=s.enqueue('p','issue','spec'),config={repo:'/repo',linear:{projectId:'p'},requiredChecks:['CI'],automation:{planningEnabled:true,orchestratorProject:'project'}};
  Object.assign(feature.agents,{submit:createFeatureAgents(f.turns.submit).submit});const plan=await feature.planner.create(featureConfig,JSON.stringify(requirements),'Test');
  f.ops.projects=async()=>[{project:'intake'}];f.ops.project=async action=>{
   if(action==='stop'){
    await expect(workflow.startPlanning(job,config)).rejects.toThrow('in progress');expect(workflow.planning(job)).toBeNull();expect(s.db.query('SELECT * FROM planning_runs').all()).toEqual([]);
    expect((await feature.planner.tick(plan.id)).state).toBe('planning');expect(feature.s.db.query('SELECT state,started FROM feature_agents').all()).toEqual(Array.from({length:3},()=>({state:'reserved',started:null})));
   }return {};
  };
  await controlStack('stop',f.ops);expect(creates).toBe(0);expect(feature.agents.starts).toEqual([]);
  await controlStack('start',f.ops);expect((await workflow.startPlanning(job,config))?.state).toBe('planning');await feature.planner.advance(plan.id,'architecture');expect(creates).toBe(1);expect(feature.agents.starts).toHaveLength(1);expect(feature.agents.messages).toHaveLength(1);
 }finally{s.close();feature.s.close();f.close();}
});
test('nested submissions reuse only their own active submission scope, never a shutdown fence',async()=>{
 const f=fixture();try{
  await f.turns.submit(async()=>{await turnBarrier(f.state).submit(async()=>{});await expect(f.turns.run(async()=>{})).rejects.toThrow('in progress');});
  await f.turns.run(async()=>{await expect(f.turns.submit(async()=>{})).rejects.toThrow('in progress');});
 }finally{f.close();}
});

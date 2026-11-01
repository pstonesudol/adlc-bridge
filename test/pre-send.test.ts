import {test,expect} from 'bun:test';
import {Store} from '../src/core';import {Planning} from '../src/planning';import {Workflow} from '../src/workflow';
import {createLocalAO,createWorkflowTransport,jsonCommand} from '../src/workflow-transport';import {createFeatureAgents} from '../src/feature-transport';import {PreSendFailure} from '../src/pre-send';
import {turnBarrier} from '../src/turn-submission';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {featureFixture,featureConfig,requirements} from './feature-fixture';
const submit=async<T>(operation:()=>Promise<T>)=>operation();
const ready={state:'ready',executablePath:'/verified/ao',port:3001};
const config={repo:'/repo',linear:{projectId:'project'},requiredChecks:['CI'],automation:{planningEnabled:true,orchestratorProject:'ao'}};

test('planning readiness failure releases only never-sent reservations and retries on the next attempt',async()=>{
 const s=new Store(':memory:');let available=false,sends=0;
 try{
  const api=createLocalAO(async()=>available?ready:{state:'stopped'},(async(_url,options)=>{sends++;const body=JSON.parse(options!.body as string);return Response.json({session:{id:'worker',projectId:body.projectId,branch:body.branch}});}) as typeof fetch,()=>true);
  const transport=createWorkflowTransport(submit,undefined,api,async()=>({})),workflow=new Workflow(s,transport),job=s.enqueue('project','issue','spec');
  expect(await workflow.startPlanning(job,config)).toMatchObject({state:'awaiting_plan'});expect(sends).toBe(0);expect(workflow.planning(job)).toBeNull();expect(new Planning(s).get(job)).toBeNull();expect(s.get(job).state).toBe('awaiting_plan');
  available=true;expect(await workflow.startPlanning(job,config)).toMatchObject({state:'planning',session:'worker'});expect(sends).toBe(1);
 }finally{s.close();}
});
test('planning fetch, receipt and post-send setup failures retain reservations and cannot automatically resend',async()=>{
 for(const failure of ['fetch','receipt','setup']){const s=new Store(':memory:');let sends=0;try{
  const api=createLocalAO(async()=>ready,(async(_url,options)=>{sends++;if(failure==='fetch')throw Error('Lost request receipt');const body=JSON.parse(options!.body as string);return Response.json({session:{id:'worker',projectId:failure==='receipt'?'foreign':body.projectId,branch:body.branch}});}) as typeof fetch,()=>true);
  const transport=createWorkflowTransport(submit,undefined,api,async()=>{if(failure==='setup')throw new PreSendFailure('A later setup request was not sent');return {};});transport.findPlans=async()=>[];
  const workflow=new Workflow(s,transport),job=s.enqueue('project','issue','spec');expect((await workflow.startPlanning(job,config))?.state).toBe('dispatch_uncertain');expect(workflow.planning(job).state).toBe('dispatch_uncertain');expect(new Planning(s).get(job)).not.toBeNull();
  await workflow.startPlanning(job,config);expect(sends).toBe(1);
 }finally{s.close();}}
});
test('a pre-send error cannot erase planning rows that already contain provisioning evidence',async()=>{
 const s=new Store(':memory:');try{
  const transport=createWorkflowTransport(submit);const workflow=new Workflow(s,transport),job=s.enqueue('project','issue','spec');
  transport.startPlan=async request=>{new Planning(s).gate(job,request.project,'worker',request.branch,'/provisioned');throw new PreSendFailure('Unexpected pre-send classification');};
  expect((await workflow.startPlanning(job,config))?.state).toBe('dispatch_uncertain');expect(workflow.planning(job)).not.toBeNull();expect(new Planning(s).get(job)).toMatchObject({state:'provisioned',session_id:'worker',worktree:'/provisioned'});
 }finally{s.close();}
});
test('local AO reports typed pre-send errors only before the HTTP boundary',async()=>{
 let sends=0,boundaries=0;const send=(async()=>{sends++;throw new PreSendFailure('fetch error must not be safe to retry');}) as typeof fetch;
 const unavailable=createLocalAO(async()=>{throw Error('status failed');},send,()=>true);await expect(unavailable('sessions','POST',{},()=>boundaries++)).rejects.toBeInstanceOf(PreSendFailure);expect(sends).toBe(0);expect(boundaries).toBe(0);
 const available=createLocalAO(async()=>ready,send,()=>true);const error=await available('sessions','POST',{},()=>boundaries++).catch(e=>e);expect(error).not.toBeInstanceOf(PreSendFailure);expect(error.message).toContain('uncertain');expect(sends).toBe(1);expect(boundaries).toBe(1);
});
test('feature preflight and readiness failures remain reserved; uncertainty begins at the sessions POST',async()=>{
 for(const failure of ['preflight','readiness']){const f=featureFixture();let failing=true,sends=0;try{
  const {id}=await f.planner.create(featureConfig,JSON.stringify(requirements),'Test'),original=f.agents.start.bind(f.agents);
  const row=()=>f.s.db.query('SELECT state,reason,started FROM feature_agents WHERE plan=? AND role=?').get(id,'architecture') as any;
  const api=createLocalAO(async()=>{expect(row().state).toBe('preparing_spawn');return failing&&failure==='readiness'?{state:'stopped'}:ready;},(async(_url,options)=>{sends++;expect(row().state).toBe('spawn_uncertain');const body=JSON.parse(options!.body as string),session=await original({name:body.displayName,key:body.clientRequestId,route:{harness:body.harness,model:body.model,mode:'plan'}});return Response.json({session});}) as typeof fetch,()=>true);
  const transport=createFeatureAgents(submit,undefined,api,async()=>{expect(row().state).toBe('preparing_spawn');if(failing&&failure==='preflight')throw Error('Catalog unavailable');},async()=>({}));f.agents.start=transport.start;
  await f.planner.advance(id,'architecture');expect(row()).toMatchObject({state:'reserved',started:null});expect(row().reason).toContain(failure==='preflight'?'preflight':'not sent');expect(sends).toBe(0);expect(f.planner.get(id).state).toBe('planning');
  failing=false;await f.planner.advance(id,'architecture');expect(row().state).toBe('running');expect(row().reason).toBeNull();expect(sends).toBe(1);expect(f.agents.messages).toHaveLength(1);
 }finally{f.s.close();}}
});
test('feature failures at or after POST retain spawn uncertainty and never reset to reserved',async()=>{
 for(const failure of ['fetch','receipt','setup']){const f=featureFixture();let sends=0;try{
  const {id}=await f.planner.create(featureConfig,JSON.stringify(requirements),'Test');
  const api=createLocalAO(async()=>ready,(async()=>{sends++;if(failure==='fetch')throw Error('Lost POST receipt');return Response.json({session:failure==='receipt'?{}:{id:'worker'}});}) as typeof fetch,()=>true);
  f.agents.start=createFeatureAgents(submit,undefined,api,async()=>{},async()=>{throw new PreSendFailure('Setup request not sent');}).start;
  await f.planner.advance(id,'architecture');expect(f.s.db.query('SELECT state FROM feature_agents WHERE plan=? AND role=?').get(id,'architecture')).toEqual({state:'spawn_uncertain'});
  await expect(f.planner.advance(id,'architecture')).rejects.toThrow('no duplicate spawn');expect(sends).toBe(1);
 }finally{f.s.close();}}
});
test('a typed failure after the feature delivery boundary cannot reset the agent or emit a safe-retry event',async()=>{
 const f=featureFixture();let sends=0;try{
  const {id}=await f.planner.create(featureConfig,JSON.stringify(requirements),'Test');f.agents.start=async request=>{sends++;request.beforeSend();throw new PreSendFailure('Misclassified failure after boundary');};
  await f.planner.advance(id,'architecture');expect(f.s.db.query('SELECT state FROM feature_agents WHERE plan=? AND role=?').get(id,'architecture')).toEqual({state:'spawn_uncertain'});
  expect(f.s.db.query("SELECT * FROM feature_events WHERE plan=? AND kind='feature_pre_send_failed'").all(id)).toEqual([]);await expect(f.planner.advance(id,'architecture')).rejects.toThrow('no duplicate spawn');expect(sends).toBe(1);
 }finally{f.s.close();}
});
test('status subprocess timeout releases the submission fence and permits retry without claiming delivery',async()=>{
 const s=new Store(':memory:'),state=mkdtempSync(join(tmpdir(),'adlc-status-timeout-')),turns=turnBarrier(state);let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  let options:any,sends=0,started!:()=>void;const spawned=new Promise<void>(resolve=>started=resolve);
  const spawn=((_args:any,opts:any)=>{options=opts;child=Bun.spawn([process.execPath,'-e','await Bun.sleep(60000)'],{...opts,timeout:200,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:state}});started();return child;}) as typeof Bun.spawn;
  const api=createLocalAO(args=>jsonCommand(args,spawn),(async()=>{sends++;return Response.json({});}) as typeof fetch,()=>true),transport=createWorkflowTransport(turns.submit,undefined,api),workflow=new Workflow(s,transport),job=s.enqueue('project','issue','spec');
  const pending=workflow.startPlanning(job,config);await spawned;expect(child!.exitCode).toBeNull();await expect(turnBarrier(state).run(async()=>{})).rejects.toThrow('in progress');
  expect((await pending)?.state).toBe('awaiting_plan');expect(options).toEqual({stdout:'pipe',stderr:'pipe',timeout:30000});expect(child!.signalCode).toBe('SIGTERM');expect(sends).toBe(0);expect(workflow.planning(job)).toBeNull();expect(new Planning(s).get(job)).toBeNull();await turnBarrier(state).run(async()=>{});
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}s.close();rmSync(state,{recursive:true,force:true});}
});

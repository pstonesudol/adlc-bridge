import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow,type WorkflowTransport} from '../src/workflow';
import {Planning} from '../src/planning';
import {ReviewLoop} from '../src/review-loop';
import {StartupRecovery,consumeStartupRestore} from '../src/startup-recovery';
import {turnBarrier,withRecoverySubmission,setProjectIntakePaused} from '../src/turn-submission';
import {controlManagedLifecycle,type LifecycleOps} from '../src/managed-lifecycle';
import {assertRecoveryAvailable,createRecoveryIO} from '../src/recovery-runtime';
import {createCLIPollTick} from '../src/cli';
import {PreSendFailure} from '../src/pre-send';
import {routingConfig} from './routing-fixture';
import {selectRoute} from '../src/task-routing';
import {worktreeReservation} from '../src/worktree-reservation';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';

async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'startup-recovery-'))),s=new Store(join(root,'state.sqlite')),barrier=turnBarrier(root);
 const sessions=new Map<string,any>(),sends:any[]=[],restores:string[]=[],registrations:string[]=[];
 const c={repo:root,githubRepo:'owner/repo',linear:{projectId:'linear-project'},requiredChecks:['CI'],automation:{planningEnabled:true,orchestratorProject:'project'}};
 let lostSend=false,lostRestore=false,consume=true,inventoryFailure=false,requirementsFailure=false,clock=Date.now();
 const t:WorkflowTransport={
  submit:f=>barrier.submit(f),
  async startPlan(r){
   const id=`worker-${sessions.size+1}`,p=s.db.query('SELECT job FROM planning_runs WHERE branch=?').get(r.branch) as any;
   new Planning(s).gate(p.job,r.project,id,r.branch,root);
   const marker=r.prompt.match(/<!-- ADLC_PLAN_READY:[a-f0-9]+ -->/)![0];
   sessions.set(id,{session:{id,kind:'worker',projectId:r.project,branch:r.branch,isTerminated:false,activity:{state:'idle'},prs:[]},transcript:{controller:'ready',entries:[{sequence:1,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'plan',text:`${marker}\nImplement src/a.ts and run bun test.\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->`}],turns:[{id:'plan',state:'completed'}]}});return {id};
  },
  async findPlans(){return [...sessions.values()].map(x=>x.session);},
  async evidence(id){const e=sessions.get(id);return structuredClone({...e,receiptObservation:{complete:true,observed:Date.now()}});},
  async sendImplementation(session,prompt,clientId){
   sends.push({session,prompt,clientId});const e=sessions.get(session),turn=`turn-${sends.length}`;
   e.transcript.entries.push({sequence:e.transcript.entries.length+1,clientMessageId:clientId,turnId:turn});e.transcript.turns.push({id:turn,state:'running'});e.transcript.controller='busy';e.session.activity.state='busy';
   if(lostSend)throw Error('lost response');
  },
  async disableFeedback(){},
  async worktree(job){const p=new Planning(s).get(job);return {tree:root,branch:p.branch,head:'a'.repeat(40)};},
  async branchSnapshot(){return {branch:new Planning(s).get(job).branch,head:'a'.repeat(40),state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'};},
  async restorePlan(id){
   restores.push(id);
   if(consume){const r=s.db.query("SELECT * FROM startup_restores WHERE session=? AND state='attempting'").get(id) as any;consumeStartupRestore(s,r.job,c,id,'project',sessions.get(id).session.branch,root,await inspect(s,r.job,c));}
   const e=sessions.get(id);e.session.isTerminated=false;e.session.activity.state='idle';e.transcript.controller='ready';
   if(lostRestore)throw Error('restore acknowledgement lost');
  }
 };
 const w=new Workflow(s,t),job=s.enqueue(c.linear.projectId,'issue','Implement test change');
 await w.startPlanning(job,c);await w.reconcilePlanning(job,c);
 w.approve(job,s.get(job).plan_hash,'human',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
 await w.executeApproved(job,c);
 writeFileSync(join(root,'preserved.txt'),'uncommitted local implementation\n');
 const inspect:any=async()=>({tree:root,branch:sessions.get('worker-1').session.branch,head:'a'.repeat(40),source:'/source',common:'/common',repo:'owner/repo',prs:sessions.get('worker-1').session.prs.map((p:any)=>({url:p.url})),dirty:digest(readFileSync(join(root,'preserved.txt'),'utf8'))});
 const loop=new ReviewLoop(s),recovery=new StartupRecovery(s,w,{
  inventory:async()=>{if(inventoryFailure)throw Error('backend inventory unavailable');return [...sessions.values()].map(x=>structuredClone(x.session));},
  inspect,requirements:async()=>{if(requirementsFailure)throw Error('provider authentication expired');},now:()=>clock,
  register:(id,result)=>{loop.register(id,c.githubRepo,result.pr.number,c.requiredChecks,['src/**'],true);registrations.push(id);}
 });
 const e=sessions.get('worker-1');
 const interrupt=(stopped=false,terminated=false)=>{e.transcript.turns.at(-1).state='interrupted';e.transcript.controller=stopped?'stopped':'ready';e.session.activity.state=stopped?'exited':'idle';e.session.isTerminated=terminated;};
 const complete=()=>{e.transcript.turns.at(-1).state='completed';e.transcript.controller='ready';e.session.activity.state='idle';e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];};
 return {root,s,c,w,t,loop,job,e,sends,restores,registrations,recovery,barrier,interrupt,complete,
  flags:(f:any)=>{lostSend=f.lostSend??lostSend;lostRestore=f.lostRestore??lostRestore;consume=f.consume??consume;inventoryFailure=f.inventoryFailure??inventoryFailure;requirementsFailure=f.requirementsFailure??requirementsFailure;},
  advance:()=>clock+=300001,close:()=>{s.close();rmSync(root,{recursive:true,force:true});}};
}
test('wake with a surviving/disconnected turn preserves it without resending',async()=>{
 const f=await fixture();try{for(const state of ['busy','disconnected','exited']){f.e.session.activity.state=state;expect((await f.recovery.pass(f.c,true)).waiting).toBe(1);}expect(f.sends).toHaveLength(1);expect(f.restores).toHaveLength(0);}finally{f.close();}
});
for(const [name,stopped,terminated] of [['wake',false,false],['daemon restart',true,false],['abrupt reboot',true,true],['clean login',true,true]] as const)test(`${name}: exactly one same-session implementation continuation, preserving edits/history/budget`,async()=>{
 const f=await fixture();try{
  f.interrupt(stopped,terminated);const before=structuredClone(f.e.transcript.entries),attempts=f.s.get(f.job).attempts;
  if(stopped)f.flags({lostRestore:true});
  const first=await f.recovery.pass(f.c,true);expect(first).toMatchObject({resumed:1,blocked:0});
  expect(f.sends).toHaveLength(2);expect(f.sends[1].session).toBe('worker-1');expect(f.restores).toHaveLength(stopped?1:0);
  expect(f.e.transcript.entries.slice(0,before.length)).toEqual(before);expect(readFileSync(join(f.root,'preserved.txt'),'utf8')).toBe('uncommitted local implementation\n');expect(f.s.get(f.job).attempts).toBe(attempts);
  await f.recovery.pass(f.c,true);await f.recovery.pass(f.c,true);expect(f.sends).toHaveLength(2);expect(f.restores).toHaveLength(stopped?1:0);
  f.complete();const review=await f.recovery.pass(f.c,true);expect(review.reattached).toBe(1);expect(f.registrations).toEqual([f.job]);expect(f.loop.list(f.c.linear.projectId)).toHaveLength(1);
 }finally{f.close();}
});
test('published PR returns to review polling without an implementation resend',async()=>{
 const f=await fixture();try{f.complete();const result=await f.recovery.pass(f.c);expect(result.reattached).toBe(1);expect(f.loop.list(f.c.linear.projectId)).toHaveLength(1);expect(f.sends).toHaveLength(1);expect(f.restores).toHaveLength(0);}finally{f.close();}
});
test('uncertain recovery send is reconciled and never replayed after restart',async()=>{
 const f=await fixture();try{f.interrupt();f.flags({lostSend:true});expect((await f.recovery.pass(f.c)).blocked).toBe(1);f.advance();expect((await f.recovery.pass(f.c)).waiting).toBe(1);expect(f.sends).toHaveLength(2);f.complete();await f.recovery.pass(f.c,true);expect(f.registrations).toHaveLength(1);}finally{f.close();}
});
test('unconsumed native restore remains uncertain and is not repeated',async()=>{
 const f=await fixture();try{f.interrupt(true,true);f.flags({consume:false,lostRestore:true});expect((await f.recovery.pass(f.c,true)).blocked).toBe(1);await f.recovery.pass(f.c,true);expect(f.restores).toHaveLength(1);expect(f.sends).toHaveLength(1);}finally{f.close();}
});
test('a timed-out restore settles behind the submission fence and retains its uncertain reservation',async()=>{
 const f=await fixture();let child:any,settled=false,launched=0;
 try{
  f.interrupt(true,true);
  const io=createRecoveryIO(f.s,Date.now()+1000,operation=>f.barrier.submit(operation),{spawn:((_args:any,options:any)=>{launched++;child=Bun.spawn([process.execPath,'-e','await Bun.sleep(10000)'],options);child.exited.then(()=>{settled=true;});return child;}) as any});
  f.t.restorePlan=io.transport.restorePlan;
  const result=await f.barrier.run(()=>withRecoverySubmission(()=>f.recovery.pass(f.c,true),f.root));
  expect(result.blocked).toBe(1);expect(settled).toBe(true);expect(f.s.db.query('SELECT state FROM startup_restores').get()).toEqual({state:'attempting'});
  expect(worktreeReservation(f.s,f.job)).toMatchObject({state:'attempting'});await f.barrier.submit(async()=>{});
  await f.recovery.pass(f.c,true);expect(launched).toBe(1);expect(f.sends).toHaveLength(1);
 }finally{if(child){child.kill();await child.exited;}f.close();}
});
test('a completed restore permits later exits of the same worker without replaying its continuation',async()=>{
 const f=await fixture();try{
  f.interrupt(true,true);expect((await f.recovery.pass(f.c,true)).resumed).toBe(1);f.complete();
  for(let exit=0;exit<2;exit++){
   f.e.session.isTerminated=true;f.e.session.activity.state='exited';f.e.transcript.controller='stopped';
   expect(await f.recovery.pass(f.c,true)).toMatchObject({reattached:1,blocked:0});
   expect(f.restores).toHaveLength(exit+2);expect(f.sends).toHaveLength(2);
   expect(f.s.db.query("SELECT count(*) AS n FROM startup_restores WHERE state='restored'").get()).toEqual({n:exit+2});
   await f.recovery.pass(f.c,true);expect(f.restores).toHaveLength(exit+2);
  }
  expect(readFileSync(join(f.root,'preserved.txt'),'utf8')).toContain('uncommitted');
 }finally{f.close();}
});
for(const outcome of ['needs_input','blocked_dependency','uncertain'])test(`the current ${outcome} worker blocker still denies recovery`,async()=>{
 const f=await fixture();try{
  const d=f.w.implementation(f.job);
  f.s.db.query("INSERT INTO worker_outcomes(job,plan_hash,session_id,outcome,questions,dependencies,source,confidence,first_observed,observed,dispatch_id) VALUES (?,?,?,?,'[]','[]','receipt','high',?,?,?)").run(f.job,d.plan_hash,d.session_id,outcome,Date.now(),Date.now(),d.client_id);
  f.interrupt(true,true);expect((await f.recovery.pass(f.c,true)).blocked).toBe(1);expect(f.restores).toHaveLength(0);expect(f.sends).toHaveLength(1);
 }finally{f.close();}
});
test('a proved-unlaunched native restore releases its reservation and retries once on a later pass',async()=>{
 const f=await fixture();try{
  f.interrupt(true,true);const restore=f.t.restorePlan!;let launches=0;
  f.t.restorePlan=async(...args)=>{if(++launches===1)throw new PreSendFailure('Native restore not launched');return restore(...args);};
  expect((await f.recovery.pass(f.c,true)).blocked).toBe(1);
  expect(f.s.db.query('SELECT state FROM startup_restores').get()).toEqual({state:'not_sent'});
  expect(worktreeReservation(f.s,f.job)).toBeUndefined();
  expect(f.sends).toHaveLength(1);
  expect((await f.recovery.pass(f.c,true)).resumed).toBe(1);expect(launches).toBe(2);expect(f.restores).toHaveLength(1);
  await f.recovery.pass(f.c,true);expect(launches).toBe(2);expect(f.sends).toHaveLength(2);
 }finally{f.close();}
});
for(const stopped of [false,true])for(const fault of ['none','approval','preflight','configuration','approval-during-preflight','approval-during-configuration','missing-controls'])test(`recovery confirms the approved native route before delivery (restored: ${stopped}): ${fault}`,async()=>{
 const f=await fixture();try{
  f.interrupt(stopped,stopped);const route=selectRoute(routingConfig,{choice:'implement',confidence:1}),encoded=JSON.stringify(route),hash=f.s.get(f.job).plan_hash!,events:string[]=[];
  f.s.db.query("INSERT INTO task_routes VALUES (?,'planning',?,?,'verified')").run(f.job,digest(f.s.get(f.job).spec),encoded);
  f.s.db.query("INSERT INTO task_routes VALUES (?,'implementation',?,?,'verified')").run(f.job,digest(JSON.stringify([f.s.get(f.job).spec,hash])),encoded);
  f.w.router.approve(f.job,hash);
  const revoke=()=>f.s.db.query('DELETE FROM route_approvals WHERE job=?').run(f.job);
  if(fault==='approval')revoke();
  f.t.preflightRoute=async r=>{events.push('preflight');expect(r).toEqual(route);if(fault==='preflight')throw Error('Pinned model unavailable');if(fault==='approval-during-preflight')revoke();};
  f.t.configureRoute=async(id,r)=>{events.push('configure');expect(id).toBe('worker-1');expect(r).toEqual(route);if(fault==='configuration')throw Error('Native provider refused build mode');if(fault==='approval-during-configuration')revoke();f.e.session.harness=r.harness;f.e.session.model=r.model;f.e.session.mode=r.mode;return {verified:true};};
  if(fault==='missing-controls')delete f.t.configureRoute;
  const send=f.t.sendImplementation;f.t.sendImplementation=async(...args)=>{events.push('send');return send(...args);};
  const result=await f.recovery.pass(f.c,true);
  if(fault==='none'){expect(result.resumed).toBe(1);expect(events).toEqual(['preflight','configure','send']);expect(f.e.session.mode).toBe('build');}
  else{expect(result.blocked).toBe(1);expect(events).not.toContain('send');expect(f.sends).toHaveLength(1);expect(f.s.db.query('SELECT count(*) AS n FROM startup_continuations').get()).toEqual({n:0});}
 }finally{f.close();}
});
for(const state of ['cancelled','failed'])test(`${state} is not automatic recovery authority`,async()=>{
 const f=await fixture();try{f.interrupt();f.e.transcript.turns.at(-1).state=state;expect((await f.recovery.pass(f.c)).blocked).toBe(1);expect(f.sends).toHaveLength(1);}finally{f.close();}
});
test('incomplete inventory fences new admission and provider auth failure backs off',async()=>{
 const f=await fixture();try{f.interrupt();f.flags({inventoryFailure:true});expect(await f.recovery.pass(f.c)).toMatchObject({admit:false,complete:false});f.flags({inventoryFailure:false,requirementsFailure:true});const blocked=await f.recovery.pass(f.c);expect(blocked.results[0].nextAction).toContain('authentication expired');expect(f.sends).toHaveLength(1);f.flags({requirementsFailure:false});await f.recovery.pass(f.c);expect(f.sends).toHaveLength(1);f.advance();expect((await f.recovery.pass(f.c)).resumed).toBe(1);}finally{f.close();}
});
for(const blocker of ['approval','human','branch','scope','budget','partial-branch-operation','uncertain-delivery'])test(`startup preserves ${blocker} gates`,async()=>{
 const f=await fixture();try{
  f.interrupt();
  if(blocker==='approval')f.s.db.query("UPDATE jobs SET approved_hash=NULL WHERE id=?").run(f.job);
  if(blocker==='human'){f.s.db.exec('CREATE TABLE ownership(session_id TEXT PRIMARY KEY,owner TEXT)');f.s.db.query("INSERT INTO ownership VALUES ('worker-1','human')").run();}
  if(blocker==='branch')f.recovery.io.inspect=async()=>({...await f.t.worktree!(f.job),branch:'main',prs:[]}) as any;
  if(blocker==='scope')f.s.db.query("UPDATE git_grants SET operations='[]' WHERE job=?").run(f.job);
  if(blocker==='budget')f.s.db.query("INSERT INTO remediation_budget(job,stop_reason) VALUES (?,'budget_exhausted')").run(f.job);
  if(blocker==='partial-branch-operation'){f.s.db.exec('CREATE TABLE branch_syncs(job TEXT,state TEXT,worktree TEXT,proof TEXT)');f.s.db.query("INSERT INTO branch_syncs VALUES (?,'updating',?,'reserved-proof')").run(f.job,f.root);}
  if(blocker==='uncertain-delivery'){f.s.db.exec('CREATE TABLE branch_updates(job TEXT,state TEXT)');f.s.db.query("INSERT INTO branch_updates VALUES (?,'delivery_uncertain')").run(f.job);}
  expect((await f.recovery.pass(f.c,true)).blocked).toBe(1);expect(f.sends).toHaveLength(1);expect(f.restores).toHaveLength(0);expect(readFileSync(join(f.root,'preserved.txt'),'utf8')).toContain('uncommitted');
 }finally{f.close();}
});
test('CLI startup holds the real submission fence through recovery even when services already loaded',async()=>{
 const f=await fixture();try{
  f.interrupt(true,true);const order:string[]=[];
  const ops:LifecycleOps={turns:f.barrier,projects:async()=>[{project:'project'}],project:async()=>{order.push('service');await expect(f.barrier.submit(async()=>{})).rejects.toThrow();return {loaded:true};},backendStart:async()=>{order.push('backend');},backend:async()=>({managed:true,ready:true}),backendStop:async()=>{},inventory:async()=>{order.push('inventory');return {workers:[],children:[],complete:true,externalProcesses:''};},exit:async()=>{},checkpoint:async()=>{},processesRemain:async()=>[],now:Date.now,sleep:Bun.sleep,
   recover:async()=>withRecoverySubmission(async()=>{order.push('recover');const result=await f.recovery.pass(f.c,true);expect(result.resumed).toBe(1);return result;},f.root)};
  const result=await controlManagedLifecycle('start',{all:true,timeout:5},ops);expect(result.complete).toBe(true);expect(order).toEqual(['backend','service','inventory','recover']);expect(f.barrier.isPaused()).toBe(false);expect(f.sends).toHaveLength(2);
  await controlManagedLifecycle('start',{all:true,timeout:5},{...ops,recover:async()=>withRecoverySubmission(()=>f.recovery.pass(f.c,true),f.root)});expect(f.sends).toHaveLength(2);
 }finally{f.close();}
});
test('pending update blocks recovery without changing its intent',()=>{
 const root=mkdtempSync(join(tmpdir(),'recovery-update-'));try{writeFileSync(join(root,'update-intent.json'),'{"stage":"starting"}');expect(()=>assertRecoveryAvailable(root)).toThrow('operator reconciliation');expect(readFileSync(join(root,'update-intent.json'),'utf8')).toBe('{"stage":"starting"}');}finally{rmSync(root,{recursive:true,force:true});}
});
test('concurrent startup/wake polls reserve exactly one continuation',async()=>{
 const f=await fixture();try{f.interrupt();await Promise.all([f.recovery.pass(f.c,true),f.recovery.pass(f.c,true),f.recovery.pass(f.c,true)]);expect(f.sends).toHaveLength(2);expect(f.s.db.query('SELECT count(*) AS n FROM startup_continuations').get()).toEqual({n:1});}finally{f.close();}
});
test('global pause prevents automatic poll entry and recovery submission requires its control fence',async()=>{
 const f=await fixture();try{f.interrupt();f.barrier.pause();await expect(f.barrier.submit(()=>f.recovery.pass(f.c))).rejects.toThrow('paused');expect(()=>withRecoverySubmission(()=>f.recovery.pass(f.c),f.root)).toThrow('control fence');expect(f.sends).toHaveLength(1);expect(f.barrier.isPaused()).toBe(true);}finally{f.close();}
});
test('login/wake poll recovers before workflow dispatch and keeps published PR review polling active',async()=>{
 const f=await fixture();try{
  f.interrupt(true,true);const order:string[]=[],summaries:any[]=[],reviews:string[]=[];
  const tick=createCLIPollTick({config:f.c,store:f.s,
   recovery:async c=>{order.push('recover');return f.recovery.pass(c,true);},
   reviewLoop:{configureMetadataChecks:()=>{},register:(...args)=>f.loop.register(...args),list:project=>f.loop.list(project),setVerification:(...args)=>f.loop.setVerification(...args),tick:async job=>{reviews.push(job);return {state:'observed'};}},
   workflow:{tick:async()=>{order.push('workflow');return [];},implementation:job=>f.w.implementation(job)},
   linearApprovals:{sync:async()=>[]},linearLifecycle:{sync:async()=>[]},features:{tickProject:async()=>[]},
   io:{poll:async()=>{order.push('intake-evidence');return {} as any;},linearToken:()=>'',out:value=>{if(value?.startupRecovery)summaries.push(value.startupRecovery);}}
  },operation=>f.barrier.submit(operation));
  await tick();expect(order).toEqual(['intake-evidence','recover','workflow']);expect(summaries[0].resumed).toBe(1);expect(f.sends).toHaveLength(2);
  f.complete();order.length=0;await tick();expect(order).toEqual(['intake-evidence','recover','workflow']);expect(summaries[1].reattached).toBe(1);expect(reviews).toContain(f.job);expect(f.sends).toHaveLength(2);expect(readFileSync(join(f.root,'preserved.txt'),'utf8')).toContain('uncommitted');
 }finally{f.close();}
});

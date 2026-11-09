import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {ApprovalPolicyStore} from '../src/approval-policy';
import {poll} from '../src/linear';
import {recordReadiness} from '../src/readiness';
import {featureConfig} from './feature-fixture';

const policy={mode:'ready-queue' as const,id:'standing',authorizedBy:'human',scope:['src/**'],gitScope:'feature-pr' as const};
const c={version:1 as const,...featureConfig,routing:undefined,requiredChecks:['CI'],approval:policy,statusSync:{enabled:true,inProgress:'00000000-0000-0000-0000-000000000006',inReview:'00000000-0000-0000-0000-000000000007',done:'00000000-0000-0000-0000-000000000008'}};
const legacy='Planning data only; created in Backlog without agent-ready. No implementation, merge or deployment is authorized by this description.';
function issue(description=legacy){return {id:'dev81',identifier:'DEV-81',title:'Regular reviews',description,project:{id:c.linear.projectId},team:{id:c.linear.teamId},state:{id:c.statusSync.inProgress},labels:{nodes:[{id:c.linear.readyLabelId,name:'agent-ready'}],pageInfo:{hasNextPage:false}}};}
const response=(nodes:any[])=>new Response(JSON.stringify({data:{issues:{nodes,pageInfo:{hasNextPage:false}}}}));
function owned(s:Store,source:any){
 const id=s.enqueue(c.linear.projectId,source.id,JSON.stringify({identifier:source.identifier,title:source.title,description:source.description}));
 const p=new Planning(s),r=p.reserve(id,'ao');p.gate(id,'ao','worker',r.branch,'/worktree');return {id,p,r};
}
test('DEV-81: current owned In Progress evidence reaches planning and authorized implementation without rewriting historical text',async()=>{
 const s=new Store(':memory:'),old=globalThis.fetch,sends:string[]=[];
 try{
  const source=issue(),{id,p,r}=owned(s,source);
  const w=new Workflow(s,{evidence:async()=>({session:{id:'worker',projectId:'ao',branch:r.branch,isTerminated:false,prs:[]},transcript:{controller:'ready',entries:[],turns:[]}}),disableFeedback:async()=>{},sendImplementation:async(_id,prompt)=>{sends.push(prompt);}} as any);
  globalThis.fetch=(async(_url:any,init:any)=>response(JSON.parse(init.body).variables.ids?[source]:[])) as any;
  await poll(c,s,'fixture');const store=new ApprovalPolicyStore(s),context=store.context(id);
  expect(context.fresh).toBe(true);expect(context.legacyQueueNote).toBe(true);expect(context.evidence.state).toBe(c.statusSync.inProgress);
  const args=p.request(id,true,policy),prompt=args[args.indexOf('--prompt')+1];
  expect(prompt).toContain('Fresh eligible structured state/labels take precedence');expect(prompt).toContain('planning stage only');expect(prompt).toContain(legacy);
  const plan='Implement reviews\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->',hash=s.propose(id,plan);
  recordReadiness(s,id,plan,hash,digest(s.get(id).spec));s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);
  s.db.query('INSERT INTO planning_dispatch(job,spec_hash,state,session_id,client_id) VALUES (?,?,?,?,?)').run(id,digest(s.get(id).spec),'awaiting_approval','worker','planning-message');
  const result=await w.tick(c);expect(result.filter(x=>x.error)).toEqual([]);expect(sends).toHaveLength(1);expect(sends[0]).toContain('"state":"'+c.statusSync.inProgress+'"');expect(sends[0]).toContain('delegated authorization');expect(sends[0]).toContain(legacy);
  expect(store.get(id).policy_id).toBe('standing');
  const observed=store.context(id).observed!;
  const expired=store.context(id,undefined,observed+120001);
  expect(expired.fresh).toBe(false);expect(expired.authorization.mode).toBe('unknown');
  expect(expired.authorization.recordedActor).toBe('human');
  expect(expired.authorization.gate).toContain('refresh intake evidence');
  expect(expired.authorization.gate).not.toContain('Manual plan approval required');
  const configured=store.context(id,policy,observed+120001);
  expect(configured.authorization.mode).toBe('ready-queue');expect(configured.authorization.gate).toContain('Fresh complete');
  expect(store.context(id,{mode:'manual'},observed+120001).authorization.gate).toBe('Manual plan approval required');
  expect(store.get(id).policy_id).toBe('standing');
 }finally{globalThis.fetch=old;s.close();}
});
test('removed readiness, stale observation and changed scope cannot be presented as current eligible evidence',async()=>{
 const s=new Store(':memory:'),old=globalThis.fetch;try{
  const source=issue(),{id}=owned(s,source),store=new ApprovalPolicyStore(s);
  globalThis.fetch=(async(_url:any,init:any)=>response(JSON.parse(init.body).variables.ids?[source]:[])) as any;
  await poll(c,s,'fixture');const at=store.context(id).observed!;
  expect(store.context(id,policy,at+120001).fresh).toBe(false);
  source.labels.nodes=[];await poll(c,s,'fixture');expect(store.context(id).fresh).toBe(false);expect(s.get(id).state).toBe('blocked');
  source.labels.nodes=[{id:c.linear.readyLabelId,name:'agent-ready'}];await poll(c,s,'fixture');
  s.enqueue(c.linear.projectId,source.id,'changed scope');expect(store.context(id).fresh).toBe(false);expect(store.get(id)).toBeNull();
 }finally{globalThis.fetch=old;s.close();}
});
test('manual approval, persistent prohibitions and cancellation are not overridden by historical-note guidance',async()=>{
 const s=new Store(':memory:'),old=globalThis.fetch;try{
  const source=issue(legacy+'\nPersistent restriction: do not implement until legal approval.');source.labels.nodes.push({id:'manual',name:'plan-approval-required'});
  const {id,p}=owned(s,source),store=new ApprovalPolicyStore(s);
  globalThis.fetch=(async(_url:any,init:any)=>response(JSON.parse(init.body).variables.ids?[source]:[])) as any;
  await poll(c,s,'fixture');expect(store.context(id).authorization.gate).toContain('explicit human plan approval');
  const args=p.request(id,true,policy),prompt=args[args.indexOf('--prompt')+1];expect(prompt).toContain('persistent prohibitions');expect(prompt).toContain(JSON.stringify(source.description));expect(store.get(id)).toBeNull();
  source.state.id='cancelled';await poll(c,s,'fixture');expect(store.context(id).eligible).toBe(false);expect(s.get(id).state).toBe('blocked');
 }finally{globalThis.fetch=old;s.close();}
});
test('an older concurrent poll cannot resurrect readiness removed by a newer poll',async()=>{
 const s=new Store(':memory:'),old=globalThis.fetch;let release!:(r:Response)=>void;
 try{
  const source=issue();source.state.id=c.linear.readyStateId;let calls=0;
  globalThis.fetch=(async()=>{if(++calls===1)return await new Promise<Response>(resolve=>release=resolve);return response([]);}) as any;
  const older=poll({...c,statusSync:undefined},s,'fixture');await poll({...c,statusSync:undefined},s,'fixture');release(response([source]));
  await expect(older).rejects.toThrow('superseded');expect(s.list()).toHaveLength(0);
 }finally{globalThis.fetch=old;s.close();}
});
test('incomplete provider reads cannot refresh old evidence or grant new permissions',async()=>{
 const s=new Store(':memory:'),old=globalThis.fetch;try{
  const source=issue(),{id}=owned(s,source),store=new ApprovalPolicyStore(s);
  globalThis.fetch=(async(_url:any,init:any)=>response(JSON.parse(init.body).variables.ids?[source]:[])) as any;
  await poll(c,s,'fixture');const at=store.context(id).observed!;
  source.state.id=c.linear.readyStateId;
  globalThis.fetch=(async()=>new Response(JSON.stringify({data:{issues:{nodes:[source],pageInfo:{hasNextPage:true}}}}))) as any;
  await expect(poll(c,s,'fixture')).rejects.toThrow('Invalid pagination');
  expect(store.context(id).observed).toBe(at);expect(store.context(id,policy,at+120001).eligible).toBe(false);expect(store.get(id)).toBeNull();
 }finally{globalThis.fetch=old;s.close();}
});

import {test,expect} from 'bun:test';import {Store} from '../src/core';import {Planning} from '../src/planning';import {Workflow} from '../src/workflow';import {FeaturePlanning} from '../src/feature-planning';import {poll} from '../src/linear';import {featureConfig,Agents} from './feature-fixture';
import {digest} from '../src/core';
import {recordReadiness} from '../src/readiness';
const c={version:1 as const,...featureConfig,requiredChecks:['CI'],statusSync:{enabled:true,inProgress:'00000000-0000-0000-0000-000000000006',inReview:'00000000-0000-0000-0000-000000000007',done:'00000000-0000-0000-0000-000000000008'}};
function issue(id:string,state:string){return {id,identifier:'DEV-1',title:'Task',description:'Requirements',project:{id:c.linear.projectId},team:{id:c.linear.teamId},state:{id:state},labels:{nodes:[{id:c.linear.readyLabelId}],pageInfo:{hasNextPage:false}}};}
const response=(nodes:any[])=>new Response(JSON.stringify({data:{issues:{nodes,pageInfo:{hasNextPage:false}}}}));
for(const readiness of ['blocked-by-dependency','ready','needs-input','missing','invalid','stale-plan','stale-spec','legacy'])test(`planning intake exemption fails closed except current dependency receipt: ${readiness}`,async()=>{
 const old=globalThis.fetch,s=new Store(':memory:');const w=new Workflow(s,{} as any);new FeaturePlanning(s,new Agents());
 try{
  const source=issue('11111111-1111-1111-1111-111111111111',c.linear.readyStateId),spec=JSON.stringify({identifier:source.identifier,title:source.title,description:source.description}),id=s.enqueue(c.linear.projectId,source.id,spec),p=new Planning(s);
  p.reserve(id,'ao');p.gate(id,'ao','worker',p.get(id).branch,'/worktree');
  const state=readiness==='ready'?'ready':readiness==='needs-input'?'needs-input':'blocked-by-dependency';
  const plan=`Plan\n<!-- ADLC_PLAN_STATUS ${JSON.stringify({version:1,readiness:state,questions:state==='needs-input'?[{id:'q1',question:'Which scope?',kind:'security-scope'}]:[],dependencies:state==='blocked-by-dependency'?[{ref:'DEV-32',reason:'foundation'}]:[]})} -->`;
  const hash=s.propose(id,plan);recordReadiness(s,id,plan,hash,digest(spec));s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);
  if(readiness==='missing')s.db.query('DELETE FROM plan_readiness WHERE job=?').run(id);
  if(readiness==='invalid')s.db.query('UPDATE plan_readiness SET valid=0 WHERE job=?').run(id);
  if(readiness==='stale-plan')s.db.query("UPDATE plan_readiness SET plan_hash='old' WHERE job=?").run(id);
  if(readiness==='stale-spec')s.db.query("UPDATE plan_readiness SET spec_hash='old' WHERE job=?").run(id);
  if(readiness==='legacy')s.db.query("UPDATE plan_readiness SET source='plan-text' WHERE job=?").run(id);
  s.db.query('INSERT INTO feature_dependencies VALUES (?,?)').run(source.id,'prerequisite');
  let prerequisiteReads=0;
  globalThis.fetch=(async(_url:any,init:any)=>{const b=JSON.parse(init.body);if(b.variables.ids){prerequisiteReads++;return response([{id:'prerequisite',project:{id:c.linear.projectId},team:{id:c.linear.teamId},state:{type:'started'}}]);}return response([source]);}) as any;
  await poll({...c,githubRepo:'owner/repo',statusSync:undefined,dependencyRecovery:{enabled:true,baseBranch:'main',jobs:[{issue:source.id,stage:'planning',project:c.linear.projectId,planHash:hash,specHash:digest(spec),contractReview:{actor:'reviewer',compatibility:'Same plan contract'},prerequisites:[{issue:'22222222-2222-2222-2222-222222222222',ref:'DEV-32',repo:'owner/repo',pr:32,kind:'source',headSha:'a'.repeat(40),capabilities:[{path:'src/cli.ts',sha256:'b'.repeat(64)}]}]}]}},s,'test');
  const exempt=readiness==='blocked-by-dependency';expect(s.get(id).state).toBe(exempt?'awaiting_approval':'blocked');expect(prerequisiteReads).toBe(exempt?0:1);
  expect((s.db.query('SELECT ready FROM queue_eligibility WHERE job=?').get(id) as any).ready).toBe(exempt?1:0);
  expect(w.implementation(id)).toBeNull();expect(s.db.query('SELECT * FROM git_grants').all()).toEqual([]);
 }finally{globalThis.fetch=old;s.close();}
});
for(const state of ['approved_pending','unknown','delivery_accepted'])test(`dependency intake exemption checks started dispatch: ${state}`,async()=>{
 const old=globalThis.fetch,s=new Store(':memory:');new Workflow(s,{} as any);new FeaturePlanning(s,new Agents());
 try{
  const source=issue('dependent',c.linear.readyStateId),id=s.enqueue(c.linear.projectId,'dependent',JSON.stringify({identifier:source.identifier,title:source.title,description:source.description}));
  s.db.query('INSERT INTO feature_dependencies VALUES (?,?)').run('dependent','prerequisite');
  s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(id,'plan','session','client',state,'[]','supervised-host','human',null);
  globalThis.fetch=(async(_url:any,init:any)=>{const b=JSON.parse(init.body);return response(b.variables.ids?[{id:'prerequisite',project:{id:c.linear.projectId},team:{id:c.linear.teamId},state:{type:'started'}}]:[source]);}) as any;
  await poll({...c,githubRepo:'owner/repo',statusSync:undefined,dependencyRecovery:{enabled:true,baseBranch:'main',jobs:[]}},s,'test');
  expect(s.get(id).state==='blocked').toBe(state!=='delivery_accepted');
 }finally{globalThis.fetch=old;s.close();}
});
test('full paginated intake queues overflow even when all planning slots are uncertain',async()=>{
 const old=globalThis.fetch,s=new Store(':memory:');let starts=0;
 const w=new Workflow(s,{startPlan:async()=>{starts++;throw Error('unknown');},findPlans:async()=>[]} as any);
 const config={...c,statusSync:undefined,routing:undefined,automation:{planningEnabled:true,orchestratorProject:'test',maxPlanning:1}};
 try{
  let requests=0;const unexpected:unknown[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{
   try{
   expect(url).toBe('https://api.linear.app/graphql');expect(init.method).toBe('POST');
   const body=JSON.parse(init.body),after=body.variables.after;
   expect(body.query.trim()).toStartWith('query(');
   expect(body.query).not.toMatch(/\bmutation\b/);
   expect(body.query).toContain('issues(first: 50, after: $after, filter:');
   expect(body.variables).toEqual({project:c.linear.projectId,team:c.linear.teamId,state:c.linear.readyStateId,label:c.linear.readyLabelId,after:requests%2===0?null:'next'});
   requests++;
   return new Response(JSON.stringify({data:{issues:{nodes:Array.from({length:3},(_,i)=>issue(`${after?'b':'a'}${i}`,c.linear.readyStateId)),pageInfo:{hasNextPage:!after,endCursor:after?null:'next'}}}}));
   }catch(e){unexpected.push(e);throw e;}
  }) as any;
  await poll(config,s,'test');expect(s.list().length).toBe(6);await w.tick(config);expect(starts).toBe(1);
  await poll(config,s,'test');await w.tick(config);expect(s.list().length).toBe(6);expect(starts).toBe(1);
  expect(s.db.query('SELECT count(*) AS n FROM planning_dispatch').get()).toEqual({n:1});expect(requests).toBe(4);expect(unexpected).toEqual([]);
 }finally{globalThis.fetch=old;s.close();}
});
test('owned In Progress tickets remain eligible, while unrelated in-progress tickets are never adopted',async()=>{
 const old=globalThis.fetch,s=new Store(':memory:');new Workflow(s,{} as any);try{
 const source=issue('owned',c.statusSync.inProgress),id=s.enqueue(c.linear.projectId,'owned',JSON.stringify({identifier:source.identifier,title:source.title,description:source.description})),p=new Planning(s);p.reserve(id,'ao');p.gate(id,'ao','worker',p.get(id).branch,'/worktree');
 globalThis.fetch=(async(_url:any,init:any)=>{const b=JSON.parse(init.body);return response(b.variables.ids?[source]:[]);}) as any;
 await poll(c,s,'test');expect(s.get(id).state).not.toBe('blocked');expect((s.db.query('SELECT ready FROM queue_eligibility WHERE job=?').get(id) as any).ready).toBe(1);
 }finally{globalThis.fetch=old;s.close();}
});
test('generated batch holds and unfinished prerequisites prevent intake until safely released',async()=>{
 const old=globalThis.fetch,s=new Store(':memory:');new Workflow(s,{} as any);new FeaturePlanning(s,new Agents());let done=false;try{
 const source=issue('dependent',c.linear.readyStateId);
 s.db.query('INSERT INTO feature_dependencies VALUES (?,?)').run('dependent','prerequisite');
 globalThis.fetch=(async(_url:any,init:any)=>{const b=JSON.parse(init.body);if(b.variables.ids)return response(b.variables.ids.includes('prerequisite')?[{id:'prerequisite',project:{id:c.linear.projectId},team:{id:c.linear.teamId},state:{type:done?'completed':'started'}}]:[]);return response([source]);}) as any;
 await poll(c,s,'test');expect(s.list().length).toBe(0);expect((s.db.query('SELECT count(*) AS n FROM feature_intake_blocks').get() as any).n).toBe(1);
 done=true;await poll(c,s,'test');expect(s.list().length).toBe(1);
 }finally{globalThis.fetch=old;s.close();}
});
test('partial snapshots never create new jobs or standing-policy eligibility',async()=>{
 const old=globalThis.fetch,s=new Store(':memory:');try{let page=0;globalThis.fetch=(async()=>{if(page++)throw Error('Page failed');return new Response(JSON.stringify({data:{issues:{nodes:[issue('partial',c.linear.readyStateId)],pageInfo:{hasNextPage:true,endCursor:'next'}}}}));}) as any;
 await expect(poll({...c,statusSync:undefined},s,'test')).rejects.toThrow();expect(s.list().length).toBe(0);
 }finally{globalThis.fetch=old;s.close();}
});

test('intake reads the approval label without changing the ticket specification or planning eligibility',async()=>{
 const {ApprovalPolicyStore}=await import('../src/approval-policy');
 const old=globalThis.fetch,s=new Store(':memory:');new Workflow(s,{} as any);try{
 const source=issue('gated',c.linear.readyStateId);let required=true;
 globalThis.fetch=(async()=>{source.labels.nodes=[{id:c.linear.readyLabelId},...(required?[{id:'gate',name:'plan-approval-required'}]:[])];return response([source]);}) as any;
 await poll(c,s,'test');const j=s.list()[0] as any,policy=new ApprovalPolicyStore(s),spec=s.get(j.id).spec;
 expect(policy.requiresManual(j.id)).toBe(true);expect(j.state).toBe('awaiting_plan');
 required=false;await poll(c,s,'test');expect(policy.requiresManual(j.id)).toBe(false);expect(s.get(j.id).spec).toBe(spec);
 required=true;await poll(c,s,'test');required=false;globalThis.fetch=(async()=>{throw Error('Unavailable snapshot');}) as any;
 await expect(poll(c,s,'test')).rejects.toThrow();expect(policy.requiresManual(j.id)).toBe(true);
 }finally{globalThis.fetch=old;s.close();}
});

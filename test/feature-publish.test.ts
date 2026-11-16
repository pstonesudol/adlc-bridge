import {test,expect} from 'bun:test';import {FeaturePublish} from '../src/feature-publish';import {plannedFeature} from './feature-fixture';
import {createLinearAPI,LinearPreSendFailure} from '../src/linear-api';
import {LinearCooldowns,LinearPreSendCooldown} from '../src/linear-cooldowns';
function apiFixture(){const issues=new Map(),relations=new Map();let creates=0,lost=false;const api=async(query:string,v:any={})=>{
 if(query.includes('workflowState'))return {workflowState:{id:'00000000-0000-0000-0000-000000000005',type:'backlog',team:{id:'00000000-0000-0000-0000-000000000002'}},project:{id:'00000000-0000-0000-0000-000000000001',teams:{nodes:[{id:'00000000-0000-0000-0000-000000000002'}],pageInfo:{hasNextPage:false}}}};
 if(query.includes('issueCreate(')){creates++;const p=v.input,issue={...p,identifier:'DEV-'+creates,url:'https://linear.app/issue/'+creates,team:{id:p.teamId},project:{id:p.projectId},state:{id:p.stateId,type:'backlog'},labels:{nodes:[],pageInfo:{hasNextPage:false}}};issues.set(p.id,issue);if(lost){lost=false;throw Error('Lost reply after creation');}return {issueCreate:{success:true,issue}};}
 if(query.includes('issueRelationCreate')){const p=v.input,r={id:p.id,type:p.type,issue:{id:p.issueId},relatedIssue:{id:p.relatedIssueId}};relations.set(p.id,r);return {issueRelationCreate:{success:true,issueRelation:r}};}
 if(query.includes('relations(first'))return {issue:{relations:{nodes:[...relations.values()].filter(r=>r.issue.id===v.id),pageInfo:{hasNextPage:false}}}};
 return {issues:{nodes:issues.has(v.id)?[issues.get(v.id)]:[],pageInfo:{hasNextPage:false}}};};return {api,issues,relations,get creates(){return creates;},lose(){lost=true;}};}
test('unapproved batches cannot publish; approved tickets stay in Backlog without agent-ready and dependencies are persisted',async()=>{
 const {s,planner,id}=await plannedFeature(),f=apiFixture(),publisher=new FeaturePublish(s,planner,f.api);try{
 await expect(publisher.publish(id)).rejects.toThrow('human-approved');expect(f.creates).toBe(0);planner.approve(id,planner.get(id).hash,'human');
 const result=await publisher.publish(id);expect(result.state).toBe('published');expect(f.creates).toBe(2);expect(f.relations.size).toBe(1);
 for(const issue of f.issues.values()){expect(issue.state.type).toBe('backlog');expect(issue.labelIds).toEqual([]);expect(issue.useDefaultTemplate).toBe(false);expect(issue.description).not.toContain('Backlog without agent-ready');expect(issue.description).toContain('authorization is evaluated separately');}
 expect((s.db.query('SELECT count(*) AS n FROM feature_issue_holds').get() as any).n).toBe(0);expect((s.db.query('SELECT count(*) AS n FROM feature_dependencies').get() as any).n).toBe(1);
 await publisher.publish(id);expect(f.creates).toBe(2);
 }finally{s.close();}
});
test('lost creation reply retains intake holds, then reconciles the existing UUID without creating a duplicate',async()=>{
 const {s,planner,id}=await plannedFeature(),f=apiFixture(),publisher=new FeaturePublish(s,planner,f.api);try{
 planner.approve(id,planner.get(id).hash,'human');f.lose();await expect(publisher.publish(id)).rejects.toThrow('uncertain');expect(f.creates).toBe(1);expect((s.db.query('SELECT count(*) AS n FROM feature_issue_holds').get() as any).n).toBe(2);
 await publisher.publish(id);expect(f.creates).toBe(2);expect(planner.get(id).state).toBe('published');
 }finally{s.close();}
});
test('unexpected external workflow changes block batch release rather than queueing execution',async()=>{
 const {s,planner,id}=await plannedFeature(),f=apiFixture();const api=async(q:string,v:any)=>{const r=await f.api(q,v);if(r.issueCreate)r.issueCreate.issue.state.type='unstarted';return r;};try{
 planner.approve(id,planner.get(id).hash,'human');await expect(new FeaturePublish(s,planner,api).publish(id)).rejects.toThrow('uncertain');expect((s.db.query('SELECT count(*) AS n FROM feature_issue_holds').get() as any).n).toBe(2);
 }finally{s.close();}
});

test('an exhausted target read defers unsent publication, then resumes with the same IDs without duplicates',async()=>{
 const {s,planner,id}=await plannedFeature(),f=apiFixture();let now=1800000000000,exhaust=true;
 const quotas=new LinearCooldowns(s,()=>now,async ms=>{now+=ms;});quotas.verify('key','11111111-1111-1111-1111-111111111111');
 const send=(async(_url:any,init:any)=>{const {query,variables}=JSON.parse(init.body),data=await f.api(query,variables);const headers=exhaust&&query.includes('workflowState')?{'x-ratelimit-requests-remaining':'0','x-ratelimit-requests-reset':String(now+60000)}:{};exhaust=false;return Response.json({data},{headers});}) as typeof fetch;
 const publisher=new FeaturePublish(s,planner,createLinearAPI(send,()=> 'key',quotas));
 try{
  planner.approve(id,planner.get(id).hash,'human');await expect(publisher.publish(id)).rejects.toBeInstanceOf(LinearPreSendCooldown);
  const reserved=s.db.query('SELECT id,state FROM feature_publications WHERE plan=? ORDER BY id').all(id) as any[];
  expect(reserved).toHaveLength(3);expect(reserved.every(op=>op.state==='reserved')).toBe(true);expect(f.creates).toBe(0);
  now+=60000;await publisher.publish(id);expect(f.creates).toBe(2);expect(f.relations.size).toBe(1);expect(planner.get(id).state).toBe('published');
  expect(s.db.query('SELECT id FROM feature_publications WHERE plan=? ORDER BY id').all(id)).toEqual(reserved.map(({id})=>({id})));
  await publisher.publish(id);expect(f.creates).toBe(2);
 }finally{s.close();}
});

test('a throttle response to a sent mutation keeps the uncertain reservation and is never replayed',async()=>{
 const {s,planner,id}=await plannedFeature(),f=apiFixture();let now=1800000000000,mutations=0;
 const quotas=new LinearCooldowns(s,()=>now,async ms=>{now+=ms;});quotas.verify('key','11111111-1111-1111-1111-111111111111');
 const send=(async(_url:any,init:any)=>{const {query,variables}=JSON.parse(init.body);if(query.startsWith('mutation')){mutations++;return new Response('throttled',{status:429,headers:{'retry-after':'60'}});}return Response.json({data:await f.api(query,variables)});}) as typeof fetch;
 const publisher=new FeaturePublish(s,planner,createLinearAPI(send,()=> 'key',quotas));
 try{
  planner.approve(id,planner.get(id).hash,'human');await expect(publisher.publish(id)).rejects.toThrow('uncertain');
  expect(s.db.query("SELECT count(*) AS n FROM feature_publications WHERE state='delivery_uncertain'").get()).toEqual({n:1});
  now+=60000;await expect(publisher.publish(id)).rejects.toThrow('No authoritative publication receipt');expect(mutations).toBe(1);expect(f.creates).toBe(0);
 }finally{s.close();}
});
test('a known pre-send quota failure does not strand feature publication reservations',async()=>{
 const {s,planner,id}=await plannedFeature(),f=apiFixture();let unavailable=true;
 const publisher=new FeaturePublish(s,planner,async(query,v)=>{if(unavailable&&query.startsWith('mutation'))throw new LinearPreSendFailure('quota storage unavailable');return f.api(query,v);});
 try{
  planner.approve(id,planner.get(id).hash,'human');await expect(publisher.publish(id)).rejects.toBeInstanceOf(LinearPreSendFailure);
  const before=s.db.query('SELECT id,state FROM feature_publications ORDER BY id').all() as any[];expect(before.every(op=>op.state==='reserved')).toBe(true);expect(f.creates).toBe(0);
  unavailable=false;await publisher.publish(id);expect(f.creates).toBe(2);expect(f.relations.size).toBe(1);expect(s.db.query('SELECT id FROM feature_publications ORDER BY id').all()).toEqual(before.map(({id})=>({id})));
 }finally{s.close();}
});

for(const kind of ['issue','relation'])test(`cancellation while ${kind} creation waits for quota admission prevents the send and releases only the unsent reservation`,async()=>{
 const {s,planner,id}=await plannedFeature(),f=apiFixture();let now=1800000000000,cancelled=false,mutations=0;
 const quotas=new LinearCooldowns(s,()=>now,async ms=>{
  now+=ms;
  if(!cancelled&&s.db.query("SELECT id FROM feature_publications WHERE plan=? AND kind=? AND state='delivery_uncertain'").get(id,kind)){
   cancelled=true;await planner.cancel(id);
  }
 });
 quotas.verify('key','11111111-1111-1111-1111-111111111111');
 const publisher=new FeaturePublish(s,planner,createLinearAPI((async(_url:any,init:any)=>{
  const {query,variables}=JSON.parse(init.body);
  if(query.startsWith('mutation')){mutations++;expect(planner.get(id).state).not.toBe('cancelled');}
  return Response.json({data:await f.api(query,variables)});
 }) as typeof fetch,()=> 'key',quotas));
 try{
  planner.approve(id,planner.get(id).hash,'human');await expect(publisher.publish(id)).rejects.toBeInstanceOf(LinearPreSendFailure);
  expect(cancelled).toBe(true);expect(planner.get(id).state).toBe('cancelled');expect(planner.get(id).approved_hash).toBeNull();
  expect(f.creates).toBe(kind==='issue'?0:2);expect(f.relations.size).toBe(0);expect(mutations).toBe(kind==='issue'?0:2);
  expect(s.db.query("SELECT count(*) AS n FROM feature_publications WHERE state='delivery_uncertain'").get()).toEqual({n:0});
  expect(s.db.query("SELECT count(*) AS n FROM feature_publications WHERE kind=? AND state='reserved'").get(kind)).toEqual({n:kind==='issue'?2:1});
  expect(s.db.query("SELECT count(*) AS n FROM feature_publications WHERE state='confirmed'").get()).toEqual({n:kind==='issue'?0:2});
  expect(s.db.query('SELECT count(*) AS n FROM feature_issue_holds WHERE plan=?').get(id)).toEqual({n:2});
  await expect(publisher.publish(id)).rejects.toThrow('human-approved');expect(mutations).toBe(kind==='issue'?0:2);
 }finally{s.close();}
});

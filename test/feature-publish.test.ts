import {test,expect} from 'bun:test';import {FeaturePublish} from '../src/feature-publish';import {plannedFeature} from './feature-fixture';
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
 for(const issue of f.issues.values()){expect(issue.state.type).toBe('backlog');expect(issue.labelIds).toEqual([]);expect(issue.useDefaultTemplate).toBe(false);}
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

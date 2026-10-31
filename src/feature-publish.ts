import {Store} from './core';
import {FeaturePlanning} from './feature-planning';
import {batchHash,ticketDescription,validateDraft} from './feature-schema';
import {linearAPI,issueFields,type LinearAPI} from './linear-api';
export class FeaturePublish{
 constructor(public s:Store,public plans:FeaturePlanning,public api:LinearAPI=linearAPI){s.db.exec(`CREATE TABLE IF NOT EXISTS feature_publications(plan TEXT NOT NULL REFERENCES feature_plans(id),key TEXT NOT NULL,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,PRIMARY KEY(plan,key));`);}
 approved(id:string){const p=this.plans.get(id);if(!['approved','publishing','published'].includes(p.state)||!p.actor||p.hash!==p.approved_hash||p.hash!==batchHash(JSON.parse(p.requirements),JSON.parse(p.target),JSON.parse(p.draft)))throw Error('Exact human-approved feature batch required');return p;}
 async target(target:any){
  const b=await this.api('query($state:String!,$project:String!){workflowState(id:$state){id type team{id}}project(id:$project){id teams(first:100){nodes{id}pageInfo{hasNextPage}}}}',{state:target.backlogStateId,project:target.projectId});
  if(b.workflowState?.id!==target.backlogStateId||b.workflowState.type!=='backlog'||b.workflowState.team?.id!==target.teamId||b.project?.id!==target.projectId||b.project.teams?.pageInfo?.hasNextPage!==false||!b.project.teams.nodes.some((t:any)=>t.id===target.teamId))throw Error('Approved Backlog/team/project target no longer valid');
 }
 verifyIssue(issue:any,payload:any,target:any){
  if(!issue||issue.id!==payload.id||issue.title!==payload.title||issue.description!==payload.description||issue.team?.id!==target.teamId||issue.project?.id!==target.projectId||issue.state?.id!==target.backlogStateId||issue.state?.type!=='backlog'||issue.labels?.pageInfo?.hasNextPage!==false||issue.labels.nodes.some((l:any)=>l.id===target.readyLabelId))throw Error('Published issue differs from reviewed Backlog-only payload');return issue;
 }
 prepare(id:string){
  const p=this.approved(id),target=JSON.parse(p.target),req=JSON.parse(p.requirements),draft=validateDraft(JSON.parse(p.draft),req,p.max_tickets);
  this.s.db.transaction(()=>{
   for(const ticket of draft.tickets){
    const key=`ticket:${ticket.key}`;if(this.s.db.query('SELECT id FROM feature_publications WHERE plan=? AND key=?').get(id,key))continue;
    const issue=crypto.randomUUID(),payload={id:issue,title:ticket.title,description:ticketDescription(ticket,id,req)+(draft.questions.length?'\n\nOpen batch questions acknowledged by reviewer:\n'+draft.questions.map(q=>'- '+q).join('\n'):''),teamId:target.teamId,projectId:target.projectId,stateId:target.backlogStateId,labelIds:[],useDefaultTemplate:false};
    this.s.db.query('INSERT INTO feature_publications VALUES (?,?,?,?,?,?,?)').run(id,key,issue,'issue',JSON.stringify(payload),'reserved',null);this.s.db.query('INSERT INTO feature_issue_holds VALUES (?,?)').run(issue,id);
   }
   for(const ticket of draft.tickets)for(const dep of ticket.dependsOn){
    const get=(k:string)=>(this.s.db.query('SELECT id FROM feature_publications WHERE plan=? AND key=?').get(id,`ticket:${k}`) as any).id;
    const issue=get(dep),related=get(ticket.key),key=`blocks:${dep}:${ticket.key}`,rid=crypto.randomUUID();
    this.s.db.query('INSERT OR IGNORE INTO feature_publications VALUES (?,?,?,?,?,?,?)').run(id,key,rid,'relation',JSON.stringify({id:rid,type:'blocks',issueId:issue,relatedIssueId:related}),'reserved',null);
    this.s.db.query('INSERT OR IGNORE INTO feature_dependencies VALUES (?,?)').run(related,issue);
   }
   this.s.db.query("UPDATE feature_plans SET state='publishing' WHERE id=?").run(id);
  }).immediate();
 }
 async lookup(op:any,target:any){
  const input=JSON.parse(op.payload);
  if(op.kind==='issue'){
   const b=await this.api(`query($id:ID!){issues(first:2,filter:{id:{eq:$id}}){nodes{${issueFields}}pageInfo{hasNextPage}}}`,{id:op.id});
   if(!Array.isArray(b.issues?.nodes)||b.issues.pageInfo?.hasNextPage!==false||b.issues.nodes.length>1)throw Error('Incomplete issue reconciliation');
   return b.issues.nodes.length?this.verifyIssue(b.issues.nodes[0],input,target):null;
  }
  const b=await this.api('query($id:String!){issue(id:$id){relations(first:100){nodes{id type issue{id}relatedIssue{id}}pageInfo{hasNextPage}}}}',{id:input.issueId});
  const relations=b.issue?.relations;if(!Array.isArray(relations?.nodes)||relations.pageInfo?.hasNextPage!==false)throw Error('Incomplete dependency reconciliation');
  const r=relations.nodes.find((x:any)=>x.id===op.id);if(r&&(r.type!=='blocks'||r.issue?.id!==input.issueId||r.relatedIssue?.id!==input.relatedIssueId))throw Error('Dependency identity mismatch');return r??null;
 }
 async publish(id:string){
  let p=this.approved(id);if(p.state==='published')return this.receipts(id);
  const target=JSON.parse(p.target);await this.target(target);this.prepare(id);
  const operations=this.s.db.query('SELECT * FROM feature_publications WHERE plan=? ORDER BY kind,key').all(id) as any[];
  for(let op of operations){
   this.approved(id);
   if(op.state==='reserved'){
    const claim=this.s.db.query("UPDATE feature_publications SET state='delivery_uncertain' WHERE plan=? AND key=? AND state='reserved'").run(id,op.key);if(!claim.changes)throw Error('Another publication owns this operation; retry after reconciliation');
    const input=JSON.parse(op.payload);
    try{
     if(op.kind==='issue'){
      const b=await this.api(`mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{${issueFields}}}}`,{input});
      if(!b.issueCreate?.success)throw Error('Issue creation not confirmed');this.verifyIssue(b.issueCreate.issue,input,target);
     }else{
      const b=await this.api('mutation($input:IssueRelationCreateInput!){issueRelationCreate(input:$input){success issueRelation{id type issue{id}relatedIssue{id}}}}',{input});
      const r=b.issueRelationCreate?.issueRelation;if(!b.issueRelationCreate?.success||r?.id!==input.id||r.type!=='blocks'||r.issue?.id!==input.issueId||r.relatedIssue?.id!==input.relatedIssueId)throw Error('Dependency creation not confirmed');
     }
    }catch{this.plans.event(id,'publication_uncertain',op.key);throw Error('Linear publication outcome uncertain; re-run publish to inspect receipts without duplicating tickets');}
   }
   const receipt=await this.lookup(op,target);if(!receipt)throw Error('No authoritative publication receipt; automatic creation is not repeated');
   this.s.db.query("UPDATE feature_publications SET state='confirmed',receipt=? WHERE plan=? AND key=?").run(JSON.stringify(receipt),id,op.key);
  }
  // Recheck the full batch before releasing the intake hold. No issue is queued.
  for(const op of operations.filter(o=>o.kind==='issue'))if(!await this.lookup(op,target))throw Error('Published issue missing');
  this.s.db.transaction(()=>{this.approved(id);this.s.db.query("UPDATE feature_plans SET state='published' WHERE id=?").run(id);this.s.db.query('DELETE FROM feature_issue_holds WHERE plan=?').run(id);this.plans.event(id,'feature_batch_published','Backlog only; no agent-ready label or execution authorization');})();return this.receipts(id);
 }
 receipts(id:string){return {id,state:this.plans.get(id).state,issues:this.s.db.query("SELECT key,id,receipt FROM feature_publications WHERE plan=? AND kind='issue' ORDER BY key").all(id).map((x:any)=>({key:x.key,id:x.id,issue:x.receipt?JSON.parse(x.receipt):null})),executionAuthorized:false};}
}

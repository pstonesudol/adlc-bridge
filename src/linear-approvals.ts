import {randomUUID} from 'node:crypto';
import {Store,digest} from './core';
import {Workflow,type WorkflowConfig} from './workflow';
import {ApprovalPolicyStore,featureGit} from './approval-policy';
import {validScopes} from './file-scope';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';
export type ApprovalSurface={enabled:boolean;approverIds:string[];scope:string[]};
export type ApprovalConfig=WorkflowConfig&{linear:{projectId:string;teamId:string;readyStateId:string;readyLabelId:string};statusSync?:{inProgress:string;inReview:string};planApproval?:ApprovalSurface};
export class LinearApprovals{
 constructor(public s:Store,public workflow:Workflow,public api:LinearAPI=linearAPI){s.db.exec(`CREATE TABLE IF NOT EXISTS plan_approval_notices(
  job TEXT NOT NULL REFERENCES jobs(id),binding TEXT NOT NULL,plan_hash TEXT NOT NULL,comment_id TEXT NOT NULL UNIQUE,token TEXT NOT NULL UNIQUE,body TEXT NOT NULL,state TEXT NOT NULL,created TEXT,approval_comment TEXT,reason TEXT,PRIMARY KEY(job,binding));`);}
 binding(job:string,c:ApprovalConfig){
  const j=this.s.get(job),route=this.workflow.router.get(job,'implementation');
  return digest(JSON.stringify([j.spec,j.plan_hash,route?.route??null,c.planApproval,c.approval??{mode:'manual'}]));
 }
 async current(job:string,c:ApprovalConfig){
  const j=this.s.get(job),p=new ApprovalPolicyStore(this.s),q=this.s.db.query('SELECT * FROM queue_eligibility WHERE job=?').get(job) as any;
  if(j.state!=='awaiting_approval'||!j.plan||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan]))||!q?.ready||q.project!==c.linear.projectId||q.spec_hash!==digest(j.spec)||Date.now()-q.observed>120000||q.observed>Date.now()+5000)throw Error('Fresh eligible captured plan required');
  if(c.approval?.mode==='ready-queue'&&!p.requiresManual(job))throw Error('Ticket no longer requires manual approval');
  const issue=await readLinearIssue(j.issue,this.api);
  if(issue?.id!==j.issue||issue.team?.id!==c.linear.teamId||issue.project?.id!==c.linear.projectId||issue.labels?.pageInfo?.hasNextPage!==false||!issue.labels.nodes.some((x:any)=>x.id===c.linear.readyLabelId)||![c.linear.readyStateId,c.statusSync?.inProgress].includes(issue.state?.id))throw Error('Ticket is no longer eligible for plan approval');
  if(j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Ticket requirements changed; approval refused');
  if(c.approval?.mode==='ready-queue'&&!issue.labels.nodes.some((l:any)=>l.name?.trim().toLowerCase()==='plan-approval-required'))throw Error('Approval label removed; refresh intake before proceeding');
  return {j,issue};
 }
 async comments(issue:string){
  const result:any[]=[];let after:string|null=null;const seen=new Set<string>();
  do{
   const b=await this.api('query($id:String!,$after:String){issue(id:$id){id comments(first:100,after:$after){nodes{id body createdAt editedAt user{id app} botActor{id}}pageInfo{hasNextPage endCursor}}}}',{id:issue,after});
   const page=b.issue?.comments;
   if(b.issue?.id!==issue||!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')throw Error('Incomplete approval comment inventory');
   result.push(...page.nodes);if(result.length>1000)throw Error('Approval comment inventory exceeds safe bound');
   if(!page.pageInfo.hasNextPage)return result;
   after=page.pageInfo.endCursor;if(!after||seen.has(after))throw Error('Invalid approval comment cursor');seen.add(after);
  }while(true);
 }
 async syncOne(job:string,c:ApprovalConfig){
  const {j,issue}=await this.current(job,c),binding=this.binding(job,c);
  let n=this.s.db.query('SELECT * FROM plan_approval_notices WHERE job=? AND binding=?').get(job,binding) as any;
  if(!n){
   const token=randomUUID(),commentId=randomUUID();
   const body=[`## ADLC: awaiting your plan approval — ${issue.identifier}`,`Plan version: \`${j.plan_hash}\``,j.plan,
    `### Approve this exact plan`,`Review the plan above. To authorize implementation, verification, feature-branch commit/push, and PR creation within \`${c.planApproval!.scope.join(', ')}\`, post a **new comment** containing only:`,
    ['```text',`Approve ADLC plan ${token}`,'```'].join('\n'),`Only configured human approvers can release this gate. The reply applies only to this plan version. PR merges and deployment are not authorized. Requirements or plan changes invalidate it. Do not send the approval to the coding worker; reply on this Linear ticket.`].join('\n\n');
   this.s.db.query('INSERT OR IGNORE INTO plan_approval_notices(job,binding,plan_hash,comment_id,token,body,state) VALUES (?,?,?,?,?,?,?)').run(job,binding,j.plan_hash,commentId,token,body,'reserved');
   n=this.s.db.query('SELECT * FROM plan_approval_notices WHERE job=? AND binding=?').get(job,binding) as any;
  }
  let comments=await this.comments(j.issue),posted=comments.find(x=>x.id===n.comment_id);
  if(posted){
   if(posted.body!==n.body||!Number.isFinite(Date.parse(posted.createdAt)))throw Error('Posted plan notice changed; reconcile before approval');
   this.s.db.query("UPDATE plan_approval_notices SET state='posted',created=?,reason=NULL WHERE job=? AND binding=? AND state!='approved'").run(posted.createdAt,job,binding);
  }else{
   if(n.state!=='reserved')throw Error('Plan notice delivery uncertain or missing; never repost blindly');
   await this.current(job,c);if(this.binding(job,c)!==binding)throw Error('Plan changed before publication');
   const claim=this.s.db.query("UPDATE plan_approval_notices SET state='delivery_uncertain' WHERE job=? AND binding=? AND state='reserved'").run(job,binding);
   if(!claim.changes)return {state:'notice_delivery_uncertain'};
   const b=await this.api('mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id body createdAt}}}',{input:{id:n.comment_id,issueId:j.issue,body:n.body,doNotSubscribeToIssue:false}});
   posted=b.commentCreate?.comment;
   if(!b.commentCreate?.success||posted?.id!==n.comment_id||posted.body!==n.body||!Number.isFinite(Date.parse(posted.createdAt)))throw Error('Plan notice delivery requires reconciliation');
   this.s.db.query("UPDATE plan_approval_notices SET state='posted',created=? WHERE job=? AND binding=?").run(posted.createdAt,job,binding);
   this.s.event(job,'plan_approval_published_to_linear',JSON.stringify({hash:j.plan_hash,comment:n.comment_id}));
   return {state:'awaiting_human_approval',issue:issue.identifier};
  }
  const command=`Approve ADLC plan ${n.token}`;
  const approval=comments.find(x=>x.id!==n.comment_id&&x.body?.trim()===command&&c.planApproval!.approverIds.includes(x.user?.id)&&x.user?.app===false&&x.botActor===null&&x.editedAt===null&&Date.parse(x.createdAt)>Date.parse(posted.createdAt));
  if(!approval)return {state:'awaiting_human_approval',issue:issue.identifier};
  await this.current(job,c);if(this.binding(job,c)!==binding)throw Error('Plan changed before approval');
  return this.s.db.transaction(()=>{
   const row=this.s.db.query('SELECT state FROM plan_approval_notices WHERE job=? AND binding=?').get(job,binding) as any;
   if(row.state!=='posted')return {state:'already_processed'};
   this.workflow.approve(job,j.plan_hash,`Linear user ${approval.user.id}`,c.planApproval!.scope,'supervised-host',featureGit);
   this.s.db.query("UPDATE plan_approval_notices SET state='approved',approval_comment=?,reason=NULL WHERE job=? AND binding=?").run(approval.id,job,binding);
   this.s.event(job,'linear_human_plan_approval',JSON.stringify({hash:j.plan_hash,comment:approval.id,user:approval.user.id}));
   return {state:'approved',issue:issue.identifier,implementation:'queued_for_next_poll'};
  }).immediate();
 }
 async sync(c:ApprovalConfig){
  if(!c.planApproval?.enabled)return [];
  if(!c.planApproval.approverIds?.length||c.planApproval.approverIds.some(id=>!/^[-a-f0-9]{36}$/i.test(id))||!validScopes(c.planApproval.scope))throw Error('Explicit approver IDs and repository scope required');
  const jobs=this.s.db.query("SELECT id FROM jobs WHERE project=? AND state='awaiting_approval'").all(c.linear.projectId) as any[];const results=[];
  for(const j of jobs)try{results.push({job:j.id,...await this.syncOne(j.id,c)});}catch(e){const reason=e instanceof Error?e.message:'Linear plan approval failed';this.s.db.query("UPDATE plan_approval_notices SET reason=? WHERE job=? AND state!='approved'").run(reason,j.id);results.push({job:j.id,state:'approval_blocked',reason});}
  return results;
 }
}

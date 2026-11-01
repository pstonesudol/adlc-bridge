import {randomUUID} from 'node:crypto';
import {Store,digest} from './core';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';

export type BlockerSurface={enabled:boolean;labelId?:string};
export type BlockerConfig={linear:{projectId:string;teamId:string};blockerSync?:BlockerSurface};

function blockerOutcome(outcome:string){return ['needs_input','blocked_dependency','failed','uncertain','needs_reconciliation'].includes(outcome);}

/** Additive Linear blocker surface. It never changes queue labels, never removes
 * labels, never grants readiness and never authorizes implementation. */
export class LinearBlockers{
 constructor(public s:Store,public api:LinearAPI=linearAPI){
  s.db.exec(`CREATE TABLE IF NOT EXISTS blocker_notices(
   job TEXT NOT NULL REFERENCES jobs(id),binding TEXT NOT NULL,comment_id TEXT NOT NULL UNIQUE,
   body TEXT NOT NULL,state TEXT NOT NULL,created TEXT,label_applied INTEGER NOT NULL DEFAULT 0,
   reason TEXT,PRIMARY KEY(job,binding));`);
 }
 binding(job:string,outcome:any,labelId?:string){
  return digest(JSON.stringify([outcome.plan_hash,outcome.outcome,outcome.reason,outcome.questions,outcome.dependencies,labelId??null]));
 }
 async comments(issue:string){
  const result:any[]=[];let after:string|null=null;const seen=new Set<string>();
  do{
   const b=await this.api('query($id:String!,$after:String){issue(id:$id){id comments(first:100,after:$after){nodes{id body createdAt}pageInfo{hasNextPage endCursor}}}}',{id:issue,after});
   const page=b.issue?.comments;
   if(b.issue?.id!==issue||!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')throw Error('Incomplete blocker comment inventory');
   result.push(...page.nodes);if(result.length>1000)throw Error('Blocker comment inventory exceeds safe bound');
   if(!page.pageInfo.hasNextPage)return result;
   after=page.pageInfo.endCursor;if(!after||seen.has(after))throw Error('Invalid blocker comment cursor');seen.add(after);
  }while(true);
 }
 async leave(job:string,outcome:any,c:BlockerConfig){
  const labelId=c.blockerSync!.labelId!;
  const j=this.s.get(job),issue=await readLinearIssue(j.issue,this.api);
  if(!issue||issue.id!==j.issue||issue.project?.id!==c.linear.projectId||issue.team?.id!==c.linear.teamId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Linear blocker identity or label scope mismatch');
  const questions=JSON.parse(outcome.questions),dependencies=JSON.parse(outcome.dependencies);
  const binding=this.binding(job,outcome,labelId);
  let row=this.s.db.query('SELECT * FROM blocker_notices WHERE job=? AND binding=?').get(job,binding) as any;
  if(!row){
   const commentId=randomUUID();
   const body=[
     `## ADLC: implementation stopped — ${issue.identifier}`,
     `Outcome: **${outcome.outcome.replaceAll('_',' ')}**`,
     `Plan version: \`${outcome.plan_hash}\``,
     outcome.reason?`Reason: ${outcome.reason}`:null,
     questions.length?`### Questions requiring a human answer\n${questions.map((q:any)=>`- **${q.id}** (${q.kind}): ${q.question}`).join('\n')}`:null,
     dependencies.length?`### Referenced dependencies\n${dependencies.map((d:any)=>`- **${d.ref}**: ${d.reason}`).join('\n')}`:null,
     `This synchronization records a blocker only. It does not grant readiness, resolve a question, expand permissions or authorize implementation. Human PR merges remain required.`
   ].filter(Boolean).join('\n\n');
   this.s.db.query('INSERT OR IGNORE INTO blocker_notices(job,binding,comment_id,body,state) VALUES (?,?,?,?,?)').run(job,binding,commentId,body,'reserved');
   row=this.s.db.query('SELECT * FROM blocker_notices WHERE job=? AND binding=?').get(job,binding) as any;
  }
  let comments=await this.comments(j.issue),posted=comments.find(x=>x.id===row.comment_id);
  if(posted){
   if(posted.body!==row.body||!Number.isFinite(Date.parse(posted.createdAt)))throw Error('Posted blocker comment changed; reconcile before updating');
   this.s.db.query("UPDATE blocker_notices SET state='posted',created=?,reason=NULL WHERE job=? AND binding=?").run(posted.createdAt,job,binding);
  }else{
   if(row.state!=='reserved')throw Error('Blocker comment delivery uncertain or missing; never repost blindly');
   const claim=this.s.db.query("UPDATE blocker_notices SET state='delivery_uncertain' WHERE job=? AND binding=? AND state='reserved'").run(job,binding);
   if(!claim.changes)return {job,state:'delivery_uncertain',reason:'Blocker comment already claimed'};
   const b=await this.api('mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id body createdAt}}}',{input:{id:row.comment_id,issueId:j.issue,body:row.body,doNotSubscribeToIssue:false}}).catch(()=>{throw Error('Blocker comment delivery uncertain; never repost blindly');});
   posted=b.commentCreate?.comment;
   if(!b.commentCreate?.success||posted?.id!==row.comment_id||posted.body!==row.body||!Number.isFinite(Date.parse(posted.createdAt)))throw Error('Blocker comment delivery requires reconciliation');
   this.s.db.query("UPDATE blocker_notices SET state='posted',created=? WHERE job=? AND binding=?").run(posted.createdAt,job,binding);
   this.s.event(job,'linear_blocker_comment',JSON.stringify({comment:row.comment_id,outcome:outcome.outcome}));
  }
  let labelState='present';
  if(!issue.labels.nodes.some((x:any)=>x.id===labelId)){
   const labelIds=[...new Set([...issue.labels.nodes.map((x:any)=>x.id),labelId])];
   const b=await this.api('mutation($id:String!,$labels:[String!]!){issueUpdate(id:$id,input:{labelIds:$labels}){success issue{id labels(first:100){nodes{id}pageInfo{hasNextPage}}}}}',{id:j.issue,labels:labelIds});
   const labels=b.issueUpdate?.issue?.labels;
   if(!b.issueUpdate?.success||b.issueUpdate.issue?.id!==j.issue||labels?.pageInfo?.hasNextPage!==false||!labels.nodes.some((x:any)=>x.id===labelId)||issue.labels.nodes.some((x:any)=>!labels.nodes.some((y:any)=>y.id===x.id)))throw Error('Blocker label update requires reconciliation; labels were not verified');
   labelState='applied';
   this.s.db.query("UPDATE blocker_notices SET label_applied=1 WHERE job=? AND binding=?").run(job,binding);
   this.s.event(job,'linear_blocker_label',JSON.stringify({label:labelId,preserved:issue.labels.nodes.map((x:any)=>x.id)}));
  }
  return {job,state:'posted',issue:issue.identifier,outcome:outcome.outcome,label:labelState};
 }
 async retract(job:string,c:BlockerConfig){
  const labelId=c.blockerSync?.labelId;if(!labelId)return {state:'not_configured'};
  const rows=this.s.db.query("SELECT * FROM blocker_notices WHERE job=? AND state='posted' AND label_applied=1").all(job) as any[];
  if(!rows.length)return {state:'none'};
  const j=this.s.get(job),issue=await readLinearIssue(j.issue,this.api);
  if(!issue||issue.id!==j.issue||issue.project?.id!==c.linear.projectId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Linear blocker identity mismatch');
  if(!issue.labels.nodes.some((x:any)=>x.id===labelId)){this.s.db.query("UPDATE blocker_notices SET label_applied=0 WHERE job=?").run(job);return {state:'absent'};}
  const labelIds=issue.labels.nodes.map((x:any)=>x.id).filter((id:string)=>id!==labelId);
  const b=await this.api('mutation($id:String!,$labels:[String!]!){issueUpdate(id:$id,input:{labelIds:$labels}){success issue{id labels(first:100){nodes{id}pageInfo{hasNextPage}}}}}',{id:j.issue,labels:labelIds});
  const labels=b.issueUpdate?.issue?.labels;
  if(!b.issueUpdate?.success||b.issueUpdate.issue?.id!==j.issue||labels?.pageInfo?.hasNextPage!==false||labels.nodes.some((x:any)=>x.id===labelId))throw Error('Blocker label removal requires reconciliation');
  this.s.db.query("UPDATE blocker_notices SET label_applied=0 WHERE job=?").run(job);
  this.s.event(job,'linear_blocker_label_retracted',labelId);
  return {state:'retracted'};
 }
 async sync(c:BlockerConfig){
  if(!c.blockerSync?.enabled)return [];
  if(!/^[0-9a-f-]{36}$/i.test(c.blockerSync.labelId??''))throw Error('Verified blocker label UUID required');
  const rows=this.s.db.query(`SELECT w.job,w.plan_hash,w.outcome,w.reason,w.questions,w.dependencies,w.first_observed,w.grace_deadline
   FROM worker_outcomes w JOIN jobs j ON j.id=w.job WHERE j.project=? AND j.state NOT IN ('awaiting_plan','done') AND w.plan_hash=j.plan_hash`).all(c.linear.projectId) as any[];
  const results:any[]=[];
  for(const outcome of rows){
   try{
    if(blockerOutcome(outcome.outcome)){results.push(await this.leave(outcome.job,outcome,c));}
    else results.push(await this.retract(outcome.job,c));
   }catch(error){results.push({job:outcome.job,state:'blocked',reason:error instanceof Error?error.message:'Linear blocker synchronization failed'});}
  }
  return results;
 }
}

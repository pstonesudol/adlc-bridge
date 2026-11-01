import {randomUUID} from 'node:crypto';
import {Store,digest} from './core';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';
import {prLifecycle} from './github';
export type StatusMapping={enabled:boolean;inProgress:string;inReview:string;done:string};
export type SyncConfig={linear:{projectId:string;teamId:string;readyStateId:string;readyLabelId:string};githubRepo?:string;statusSync?:StatusMapping};
const driftBody=(reason:string)=>reason+'\nOriginal planning reservation and audit history are preserved. Recovery defaults to read-only preview; application requires explicit --confirm HASH.';
export class LinearLifecycle{
 constructor(public s:Store,public api:LinearAPI=linearAPI,public pr=prLifecycle){s.db.exec(`CREATE TABLE IF NOT EXISTS linear_transitions(job TEXT NOT NULL REFERENCES jobs(id),phase TEXT NOT NULL,desired TEXT NOT NULL,previous TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,PRIMARY KEY(job,phase));
  CREATE TABLE IF NOT EXISTS remediation_notices(job TEXT NOT NULL REFERENCES jobs(id),binding TEXT NOT NULL,comment_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,created TEXT,PRIMARY KEY(job,binding));
 CREATE TABLE IF NOT EXISTS branch_drift_notices(job TEXT NOT NULL,signature TEXT NOT NULL,comment_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(job,signature));`);
  if(!(s.db.query('PRAGMA table_info(branch_drift_notices)').all() as any[]).some(x=>x.name==='comment_id'))s.db.exec('ALTER TABLE branch_drift_notices ADD COLUMN comment_id TEXT');}
 async driftComment(issueId:string,commentId:string,body:string){
  let after:string|null=null;
  for(;;){
   const b=await this.api('query($id:String!,$after:String){issue(id:$id){comments(first:100,after:$after){nodes{id body} pageInfo{hasNextPage endCursor}}}}',{id:issueId,after});
   const page=b?.issue?.comments;
   if(!page?.pageInfo||!Array.isArray(page.nodes))throw Error('Branch drift notice comment evidence unavailable');
   if(page.nodes.some((x:any)=>x.id===commentId&&x.body===body))return true;
   if(!page.pageInfo.hasNextPage)return false;
   if(!page.pageInfo.endCursor||page.pageInfo.endCursor===after)throw Error('Branch drift notice comment evidence unavailable');
   after=page.pageInfo.endCursor;
  }
 }
 async driftNotice(job:string,reason:string,c:SyncConfig){
  const j=this.s.get(job),issue=await readLinearIssue(j.issue,this.api);
  if(issue?.project?.id!==c.linear.projectId||issue?.team?.id!==c.linear.teamId||j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Requirements changed; refusing branch drift notice');
  const signature=digest(reason),body=driftBody(reason),find=()=>this.s.db.query('SELECT * FROM branch_drift_notices WHERE job=? AND signature=?').get(job,signature) as any;
  let row=find();
  if(row?.state==='confirmed')return;
  if(!row){
   const commentId=randomUUID();
   const claimed=this.s.db.query('INSERT OR IGNORE INTO branch_drift_notices(job,signature,comment_id,state) VALUES (?,?,?,?)').run(job,signature,commentId,'delivery_uncertain');
   row=find();
   if(claimed.changes){
    const result=await this.api('mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}',{input:{id:commentId,issueId:j.issue,body}});
    if(!result.commentCreate?.success)throw Error('Branch drift notice delivery uncertain; no blind replay');
    this.s.db.query("UPDATE branch_drift_notices SET state='confirmed' WHERE job=? AND signature=? AND state='delivery_uncertain'").run(job,signature);
    return;
   }
   if(row?.state==='confirmed')return;
  }
  // A prior attempt may have created the comment before its response was lost.
  // Confirm only the exact client-generated ID and body; never replay it.
  if(row?.comment_id&&await this.driftComment(j.issue,row.comment_id,body)){
   this.s.db.query("UPDATE branch_drift_notices SET state='confirmed' WHERE job=? AND signature=? AND state='delivery_uncertain'").run(job,signature);
   return;
  }
  throw Error('Branch drift notice delivery uncertain; no blind replay');
 }
 private async comments(issue:string){
  const result:any[]=[];let after:string|null=null;const seen=new Set<string>();
  do{
   const b=await this.api('query($id:String!,$after:String){issue(id:$id){id comments(first:100,after:$after){nodes{id body createdAt}pageInfo{hasNextPage endCursor}}}}',{id:issue,after});
   const page=b.issue?.comments;
   if(b.issue?.id!==issue||!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')throw Error('Incomplete remediation notice inventory');
   result.push(...page.nodes);if(result.length>1000)throw Error('Remediation notice inventory exceeds safe bound');
   if(!page.pageInfo.hasNextPage)return result;
   after=page.pageInfo.endCursor;if(!after||seen.has(after))throw Error('Invalid remediation notice cursor');seen.add(after);
  }while(true);
 }
 async notifyBudgetBlocker(job:string,c:SyncConfig){
  const b=this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any;
  if(!b?.stop_reason)return null;
  const j=this.s.get(job),binding=digest(JSON.stringify([j.plan_hash,b.stop_reason,b.consumed,b.extensions,b.last_head]));
  let n=this.s.db.query('SELECT * FROM remediation_notices WHERE job=? AND binding=?').get(job,binding) as any;
  if(n?.state==='posted')return {state:'posted',comment:n.comment_id};
  const issue=await readLinearIssue(j.issue,this.api);
  if(!issue||issue.id!==j.issue||issue.project?.id!==c.linear.projectId||issue.team?.id!==c.linear.teamId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Linear lifecycle identity or label scope mismatch');
  if(j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Requirements changed; refusing remediation notice');
  if(!n){
   const cap=b.configured_max_attempts===null?'uncapped':`${b.consumed}/${b.configured_max_attempts+b.extensions}`;
   const remaining=b.configured_max_attempts===null?'remaining unlimited':`remaining ${Math.max(0,b.configured_max_attempts+b.extensions-b.consumed)}`;
   let identifier=j.issue;try{identifier=JSON.parse(j.spec).identifier??j.issue}catch{}
   const body=[`## ADLC remediation stopped — ${identifier}`,`Budget: ${cap} (${remaining}; job window; ${b.no_progress}/${b.configured_max_no_progress} consecutive without progress).`,`Stop reason: \`${b.stop_reason}\``,'No further remediation will be sent automatically. A human can reconcile the PR and prior delivery receipts, then preview and confirm an explicit budget extension. This extension does not merge the PR, deploy, or broaden the approved scope.'].join('\n\n');
   this.s.db.query('INSERT OR IGNORE INTO remediation_notices(job,binding,comment_id,body,state) VALUES (?,?,?,?,?)').run(job,binding,randomUUID(),body,'reserved');
   n=this.s.db.query('SELECT * FROM remediation_notices WHERE job=? AND binding=?').get(job,binding) as any;
  }
  const comments=await this.comments(j.issue),posted=comments.find(x=>x.id===n.comment_id);
  if(posted){
   if(posted.body!==n.body)throw Error('Posted remediation notice changed; reconcile before continuing');
   this.s.db.query("UPDATE remediation_notices SET state='posted',created=?,reason=NULL WHERE job=? AND binding=?").run(posted.createdAt,job,binding);
   return {state:'posted',comment:n.comment_id};
  }
  if(n.state!=='reserved')throw Error('Remediation notice delivery uncertain; never repost blindly');
  const claim=this.s.db.query("UPDATE remediation_notices SET state='delivery_uncertain' WHERE job=? AND binding=? AND state='reserved'").run(job,binding);
  if(!claim.changes)return {state:'delivery_uncertain'};
  const response=await this.api('mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id body createdAt}}}',{input:{id:n.comment_id,issueId:j.issue,body:n.body,doNotSubscribeToIssue:false}});
  const comment=response.commentCreate?.comment;
  if(!response.commentCreate?.success||comment?.id!==n.comment_id||comment.body!==n.body||!Number.isFinite(Date.parse(comment.createdAt)))throw Error('Remediation notice delivery requires reconciliation');
  this.s.db.query("UPDATE remediation_notices SET state='posted',created=? WHERE job=? AND binding=?").run(comment.createdAt,job,binding);
  this.s.event(job,'remediation_blocker_published_to_linear',JSON.stringify({reason:b.stop_reason,comment:n.comment_id}));
  return {state:'posted',comment:n.comment_id};
 }
 private assertSpecification(job:string,binding:string){
  const planning=this.s.db.query('SELECT spec_hash FROM planning_runs WHERE job=?').get(job) as any;
  if(!binding||planning?.spec_hash!==binding||digest(this.s.get(job).spec)!==binding)throw Error('Run requirements binding changed or missing; reconcile before status update');
 }
 async move(job:string,phase:string,desired:string,c:SyncConfig,binding:string){
  this.assertSpecification(job,binding);
  const j=this.s.get(job),issue=await readLinearIssue(j.issue,this.api);
  if(!issue||issue.project?.id!==c.linear.projectId||issue.team?.id!==c.linear.teamId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Linear lifecycle identity or label scope mismatch');
  if(j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Requirements changed; refusing status update');
  const target=await this.api('query($id:String!){workflowState(id:$id){id type team{id}}}',{id:desired});
  const expected=phase==='done'?'completed':'started';
  if(target.workflowState?.team?.id!==c.linear.teamId||target.workflowState.type!==expected)throw Error('Configured Linear status has wrong team or category');
  this.assertSpecification(job,binding);
  let row=this.s.db.query('SELECT * FROM linear_transitions WHERE job=? AND phase=?').get(job,phase) as any;
  if(row&&row.desired!==desired)throw Error('Status mapping changed; reconcile previous transition');
  if(issue.state.id===desired){
   this.s.db.query('INSERT INTO linear_transitions VALUES (?,?,?,?,?,?) ON CONFLICT(job,phase) DO UPDATE SET state=excluded.state,reason=NULL').run(job,phase,desired,issue.state.id,'confirmed',null);return {state:'confirmed'};
  }
  if(!issue.labels.nodes.some((x:any)=>x.id===c.linear.readyLabelId))throw Error('Ready label removed; refusing status update');
  if(row){return {state:'needs_reconciliation',reason:'Status changed or previous delivery uncertain; no blind replay'};}
  const allowed=phase==='in-progress'?[c.linear.readyStateId]:[c.linear.readyStateId,c.statusSync!.inProgress,c.statusSync!.inReview];
  if(!allowed.includes(issue.state.id))return {state:'needs_reconciliation',reason:'Ticket moved to an unexpected state; human changes preserved'};
  const claim=this.s.db.query('INSERT OR IGNORE INTO linear_transitions VALUES (?,?,?,?,?,?)').run(job,phase,desired,issue.state.id,'delivery_uncertain',null);
  if(!claim.changes)return {state:'delivery_uncertain'};
  const b=await this.api('mutation($id:String!,$state:String!){issueUpdate(id:$id,input:{stateId:$state}){success issue{id state{id}}}}',{id:j.issue,state:desired});
  if(!b.issueUpdate?.success||b.issueUpdate.issue?.id!==j.issue||b.issueUpdate.issue.state?.id!==desired)throw Error('Linear status delivery requires reconciliation');
  this.assertSpecification(job,binding);
  this.s.db.query("UPDATE linear_transitions SET state='confirmed' WHERE job=? AND phase=?").run(job,phase);this.s.event(job,'linear_status_changed',JSON.stringify({phase,state:desired}));return {state:'confirmed'};
 }
 async sync(c:SyncConfig){
  if(!c.statusSync?.enabled)return [];
  const rows=this.s.db.query("SELECT j.id,j.state,p.spec_hash FROM jobs j JOIN planning_runs p ON p.job=j.id WHERE j.project=? AND p.session_id IS NOT NULL AND j.state IN ('awaiting_plan','awaiting_approval','approved','blocked')").all(c.linear.projectId) as any[];
  const results=[];
  for(const row of rows)try{
   if(row.state==='blocked'){
    try{
     const notice=await this.notifyBudgetBlocker(row.id,c);
     if(notice)results.push({job:row.id,phase:'remediation-blocker',...notice});
    }catch(e){
     results.push({job:row.id,phase:'remediation-blocker',error:e instanceof Error?e.message:'Linear blocker notice failed'});
    }
   }
   let branchMismatch=false;
   const delivery=this.s.db.query("SELECT name FROM sqlite_master WHERE name='implementation_dispatch'").get()
    ?this.s.db.query('SELECT state,reason FROM implementation_dispatch WHERE job=?').get(row.id) as any:null;
   const review=this.s.db.query('SELECT repo,pr,state,reason FROM review_targets WHERE job=?').get(row.id) as any;
   const reason=[delivery?.reason,review?.reason].find((r:any)=>r?.startsWith('Blocked — branch mismatch'));
   if(reason){
    branchMismatch=true;
    try{await this.driftNotice(row.id,reason,c);results.push({job:row.id,state:'blocked',reason});}
    catch(e){results.push({job:row.id,phase:'branch-drift',error:e instanceof Error?e.message:'Linear branch drift notice failed'});}
   }
   let phase='in-progress',desired=c.statusSync.inProgress;
   if(review){
    if(review.repo!==c.githubRepo)throw Error('PR repository differs from status-sync project');
    const facts=await this.pr(review.repo,review.pr);
    if(facts.merged){phase='done';desired=c.statusSync.done;}
    else if(facts.state!=='open'){results.push({job:row.id,state:'blocked',reason:'PR closed without merge; not marking Done'});continue;}
    else{if(row.state==='blocked')continue;phase='in-review';desired=c.statusSync.inReview;}
   }
   if((row.state==='blocked'||branchMismatch||delivery?.state==='blocked'||(review?.state==='blocked'&&review.reason))&&phase!=='done')continue;
   const result=await this.move(row.id,phase,desired,c,row.spec_hash);results.push({job:row.id,phase,...result});
   if(phase==='done'&&result.state==='confirmed')this.s.db.transaction(()=>{
    this.assertSpecification(row.id,row.spec_hash);
    this.s.db.query("UPDATE jobs SET state='done',reason=NULL,updated=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    this.s.db.query("UPDATE runs SET state='completed',reason='PR merge observed; bridge did not merge' WHERE job=?").run(row.id);
    this.s.db.query("UPDATE review_targets SET state='completed',reason='PR merge observed' WHERE job=?").run(row.id);
   })();
  }catch(e){results.push({job:row.id,error:e instanceof Error?e.message:'Linear status sync failed'});}
  return results;
 }
}

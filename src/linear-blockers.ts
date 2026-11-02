import {randomUUID} from 'node:crypto';
import {Store,digest} from './core';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';
import {recoveryRows} from './worktree-reservation';

export type BlockerSurface={enabled:boolean;labelId?:string};
export type BlockerConfig={linear:{projectId:string;teamId:string;readyLabelId?:string};blockerSync?:BlockerSurface};
export type NoticeOptions={binding:string;body:string;applyLabel?:boolean;guard:(issue:any)=>void};

function blockerOutcome(outcome:string){return ['needs_input','blocked_dependency','failed','uncertain','needs_reconciliation'].includes(outcome);}

/** Additive Linear blocker surface. It never changes queue labels, never removes
 * labels, never grants readiness and never authorizes implementation. */
export class LinearBlockers{
 constructor(public s:Store,public api:LinearAPI=linearAPI){
  s.db.exec(`CREATE TABLE IF NOT EXISTS blocker_notices(
   job TEXT NOT NULL REFERENCES jobs(id),binding TEXT NOT NULL,comment_id TEXT NOT NULL UNIQUE,
   body TEXT NOT NULL,state TEXT NOT NULL,created TEXT,label_applied INTEGER NOT NULL DEFAULT 0,
   applied_label_id TEXT,reason TEXT,PRIMARY KEY(job,binding));`);
  const columns=s.db.query('PRAGMA table_info(blocker_notices)').all() as any[];
  if(!columns.some(column=>column.name==='applied_label_id'))s.db.exec('ALTER TABLE blocker_notices ADD COLUMN applied_label_id TEXT');
 }
 binding(job:string,outcome:any,labelId?:string){
  return digest(JSON.stringify([outcome.plan_hash,outcome.outcome,outcome.reason,outcome.questions,outcome.dependencies,labelId??null]));
 }
 async comments(issue:string){
  const result:any[]=[];let after:string|null=null;const seen=new Set<string>();
  do{
   const b=await this.api('query($id:String!,$after:String){issue(id:$id){id comments(first:100,after:$after){nodes{id body createdAt editedAt user{id app} botActor{id}}pageInfo{hasNextPage endCursor}}}}',{id:issue,after});
   const page=b.issue?.comments;
   if(b.issue?.id!==issue||!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')throw Error('Incomplete blocker comment inventory');
   result.push(...page.nodes);if(result.length>1000)throw Error('Blocker comment inventory exceeds safe bound');
   if(!page.pageInfo.hasNextPage)return result;
   after=page.pageInfo.endCursor;if(!after||seen.has(after))throw Error('Invalid blocker comment cursor');seen.add(after);
  }while(true);
 }
 async leave(job:string,outcome:any,c:BlockerConfig,options?:NoticeOptions){
  const labelId=c.blockerSync!.labelId!;
  const j=this.s.get(job),issue=await readLinearIssue(j.issue,this.api);
  if(!issue||issue.id!==j.issue||issue.project?.id!==c.linear.projectId||issue.team?.id!==c.linear.teamId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Linear blocker identity or label scope mismatch');
  options?.guard(issue);
  const questions=JSON.parse(outcome.questions),dependencies=JSON.parse(outcome.dependencies);
  const binding=options?.binding??this.binding(job,outcome,labelId);
  let row=this.s.db.query('SELECT * FROM blocker_notices WHERE job=? AND binding=?').get(job,binding) as any;
  if(!row){
   const commentId=randomUUID();
   const body=options?.body??[
      `## ADLC: ${outcome.outcome==='recovery_completed'?'conflict recovery completed':'implementation stopped'} — ${issue.identifier}`,
     `Outcome: **${outcome.outcome.replaceAll('_',' ')}**`,
     `Plan version: \`${outcome.plan_hash}\``,
     outcome.reason?`Reason: ${outcome.reason}`:null,
     questions.length?`### Questions requiring a human answer\n${questions.map((q:any)=>`- **${q.id}** (${q.kind}): ${q.question}`).join('\n')}`:null,
     dependencies.length?`### Referenced dependencies\n${dependencies.map((d:any)=>`- **${d.ref}**: ${d.reason}`).join('\n')}`:null,
      `This synchronization records an outcome only. It does not grant readiness, resolve a question, expand permissions or authorize implementation. Human PR merges remain required.`
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
   if(options)options.guard(await readLinearIssue(j.issue,this.api));
   const claim=this.s.db.query("UPDATE blocker_notices SET state='delivery_uncertain' WHERE job=? AND binding=? AND state='reserved'").run(job,binding);
   if(!claim.changes)return {job,state:'delivery_uncertain',reason:'Blocker comment already claimed'};
   const b=await this.api('mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id body createdAt}}}',{input:{id:row.comment_id,issueId:j.issue,body:row.body,doNotSubscribeToIssue:false}}).catch(()=>{throw Error('Blocker comment delivery uncertain; never repost blindly');});
   posted=b.commentCreate?.comment;
   if(!b.commentCreate?.success||posted?.id!==row.comment_id||posted.body!==row.body||!Number.isFinite(Date.parse(posted.createdAt)))throw Error('Blocker comment delivery requires reconciliation');
   this.s.db.query("UPDATE blocker_notices SET state='posted',created=? WHERE job=? AND binding=?").run(posted.createdAt,job,binding);
   this.s.event(job,'linear_blocker_comment',JSON.stringify({comment:row.comment_id,outcome:outcome.outcome}));
  }
   if(outcome.outcome==='recovery_completed'||options?.applyLabel===false)return {job,state:'posted',issue:issue.identifier,outcome:outcome.outcome,label:'unchanged'};
   let labelState='present';
  if(!issue.labels.nodes.some((x:any)=>x.id===labelId)){
   // Record ownership before the mutation so a lost reply or verification failure
   // still lets retract reconcile the bridge-applied label.
   this.s.db.query("UPDATE blocker_notices SET label_applied=1,applied_label_id=? WHERE job=? AND binding=?").run(labelId,job,binding);
   const b=await this.api('mutation($id:String!,$added:[String!]!){issueUpdate(id:$id,input:{addedLabelIds:$added}){success issue{id labels(first:100){nodes{id}pageInfo{hasNextPage}}}}}',{id:j.issue,added:[labelId]});
   const labels=b.issueUpdate?.issue?.labels;
   if(!b.issueUpdate?.success||b.issueUpdate.issue?.id!==j.issue||labels?.pageInfo?.hasNextPage!==false||!labels.nodes.some((x:any)=>x.id===labelId))throw Error('Blocker label update requires reconciliation; labels were not verified');
   labelState='applied';
   this.s.event(job,'linear_blocker_label',JSON.stringify({label:labelId,additive:true}));
  }
  return {job,state:'posted',issue:issue.identifier,outcome:outcome.outcome,label:labelState};
 }
 async retract(job:string,c:BlockerConfig){
  if(c.blockerSync?.enabled!==true)return {state:'disabled'};
  if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='clarification_receipts'").get()&&this.s.db.query("SELECT job FROM clarification_receipts WHERE job=? AND state IN ('waiting','partial','confirmed','replan','needs_review')").get(job))return {state:'retained',reason:'Another unresolved clarification remains'};
  const rows=this.s.db.query("SELECT * FROM blocker_notices WHERE job=? AND state='posted' AND label_applied=1").all(job) as any[];
  if(!rows.length)return {state:'none'};
  if(rows.some(row=>!row.applied_label_id))return {state:'needs_reconciliation',reason:'Applied blocker label ownership predates label tracking; inspect the Linear label manually'};
  const j=this.s.get(job),issue=await readLinearIssue(j.issue,this.api);
  if(!issue||issue.id!==j.issue||issue.project?.id!==c.linear.projectId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Linear blocker identity mismatch');
  let labels=issue.labels.nodes.map((x:any)=>x.id as string);
  const removed:string[]=[];
  for(const labelId of [...new Set(rows.map((row:any)=>row.applied_label_id as string))]){
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(labelId))return {state:'needs_reconciliation',reason:'Recorded blocker label ownership is malformed; inspect the Linear label manually'};
   if(!labels.includes(labelId)){
    this.s.db.query("UPDATE blocker_notices SET label_applied=0,applied_label_id=NULL WHERE job=? AND applied_label_id=?").run(job,labelId);
    continue;
   }
   const b=await this.api('mutation($id:String!,$removed:[String!]!){issueUpdate(id:$id,input:{removedLabelIds:$removed}){success issue{id labels(first:100){nodes{id}pageInfo{hasNextPage}}}}}',{id:j.issue,removed:[labelId]});
   const next=b.issueUpdate?.issue?.labels;
   if(!b.issueUpdate?.success||b.issueUpdate.issue?.id!==j.issue||next?.pageInfo?.hasNextPage!==false||next.nodes.some((x:any)=>x.id===labelId))throw Error('Blocker label removal requires reconciliation');
   labels=next.nodes.map((x:any)=>x.id);
   this.s.db.query("UPDATE blocker_notices SET label_applied=0,applied_label_id=NULL WHERE job=? AND applied_label_id=?").run(job,labelId);
   this.s.event(job,'linear_blocker_label_retracted',labelId);
   removed.push(labelId);
  }
  return {state:removed.length?'retracted':'absent',labels:removed};
 }
 async sync(c:BlockerConfig&{clarifications?:{enabled:boolean}}){
  if(c.blockerSync?.enabled!==true)return [];
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.blockerSync.labelId??''))throw Error('Verified blocker label UUID required');
  if(c.linear.readyLabelId&&c.blockerSync.labelId!.toLowerCase()===c.linear.readyLabelId.toLowerCase())throw Error('Blocker label must differ from the queue label');
  const rows=this.s.db.query(`SELECT w.job,w.plan_hash,w.outcome,w.reason,w.questions,w.dependencies,w.first_observed,w.grace_deadline
   FROM worker_outcomes w JOIN jobs j ON j.id=w.job WHERE j.project=? AND j.state NOT IN ('awaiting_plan','done') AND w.plan_hash=j.plan_hash`).all(c.linear.projectId) as any[];
   const results:any[]=[];
    const recoveries=recoveryRows(this.s);
    const handled=new Set<string>();
   for(const recovery of recoveries.filter(r=>r.state==='completed'&&!recoveries.some(later=>later.job===r.job&&later.created>r.created))){
    const j=this.s.get(recovery.job);if(j.project!==c.linear.projectId||j.plan_hash!==recovery.plan)continue;
    const detail=JSON.parse(recovery.detail);
    const outcome={plan_hash:recovery.plan,outcome:'recovery_completed',reason:`Recovery ${recovery.id} published ${detail.result}; fresh latest-SHA CI and CodeRabbit are required. This is not readiness or merge approval.`,questions:'[]',dependencies:'[]'};
    const binding=this.binding(recovery.job,outcome,c.blockerSync.labelId);
    const notice=this.s.db.query('SELECT state FROM blocker_notices WHERE job=? AND binding=?').get(recovery.job,binding) as any;
    if(notice?.state==='posted')continue;
    try{results.push(await this.leave(recovery.job,outcome,c));}
    catch(error){results.push({job:recovery.job,state:'blocked',reason:error instanceof Error?error.message:'Recovery outcome synchronization failed'});}
   }
   // Reuse the same dedupe/label ownership contract without overwriting the
   // original implementation receipt or inventing another approval engine.
    for(const recovery of recoveryRows(this.s).filter(r=>r.state!=='completed'||JSON.parse(r.detail).message==='uncertain')){
    const j=this.s.get(recovery.job);if(j.project!==c.linear.projectId)continue;
    handled.add(recovery.job);
    const prior=rows.findIndex(r=>r.job===recovery.job);if(prior>=0)rows.splice(prior,1);
    if(j.plan_hash!==recovery.plan)continue;
    const stopped=!!recovery.reason||JSON.parse(recovery.detail).message==='uncertain';
    const notice=stopped?`Conflict recovery ${recovery.id} has an independent reconciliation gate at stage ${recovery.state}; inspect recovery-status for local diagnostics`:null;
    rows.push({job:recovery.job,plan_hash:recovery.plan,outcome:stopped?'needs_reconciliation':'running',reason:notice,questions:JSON.stringify(stopped?[{id:recovery.id,kind:'reconciliation',question:`Inspect recovery-status for stage ${recovery.state}, files and evidence. Resolve the stated blocker without replaying delivery or discarding work; explicit operator reconciliation is required.`}]:[]),dependencies:'[]'});
   }
  for(const outcome of rows){
   handled.add(outcome.job);
   try{
    // The clarification adapter uses this same publisher and receipts. Do not
    // publish a competing generic blocker before it has inspected discovery.
    if(c.clarifications?.enabled&&['needs_input','blocked_dependency'].includes(outcome.outcome))continue;
    if(blockerOutcome(outcome.outcome)){results.push(await this.leave(outcome.job,outcome,c));}
    else results.push(await this.retract(outcome.job,c));
   }catch(error){results.push({job:outcome.job,state:'blocked',reason:error instanceof Error?error.message:'Linear blocker synchronization failed'});}
  }
  const owned=this.s.db.query(`SELECT DISTINCT n.job FROM blocker_notices n JOIN jobs j ON j.id=n.job
   WHERE j.project=? AND n.state='posted' AND n.label_applied=1`).all(c.linear.projectId) as any[];
  for(const {job} of owned){
   if(handled.has(job))continue;
   try{results.push({job,...await this.retract(job,c)});}
   catch(error){results.push({job,state:'blocked',reason:error instanceof Error?error.message:'Linear blocker synchronization failed'});}
  }
  return results;
 }
}

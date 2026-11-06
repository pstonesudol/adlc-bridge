import {randomUUID} from 'node:crypto';
import {RecoveryObservation,transient} from './recovery-observation';
import {Store,digest} from './core';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';
import {recoveryRows} from './worktree-reservation';
import {Lifecycle} from './lifecycle';
import {settleDependencyWait,revisionBoundWait,currentOutcome,latestRevision} from './spec-revisions';

export type BlockerSurface={enabled:boolean;labelId?:string};
export type BlockerConfig={linear:{projectId:string;teamId:string;readyLabelId?:string};blockerSync?:BlockerSurface};
export type NoticeOptions={binding?:string;body?:string;heading?:string;applyLabel?:boolean;guard?:(issue:any)=>void};

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
  options?.guard?.(issue);
  const questions=JSON.parse(outcome.questions),dependencies=JSON.parse(outcome.dependencies);
  const binding=options?.binding??this.binding(job,outcome,labelId);
  let row=this.s.db.query('SELECT * FROM blocker_notices WHERE job=? AND binding=?').get(job,binding) as any;
  if(!row){
   const commentId=randomUUID();
   const body=options?.body??[
      `## ADLC: ${options?.heading??(outcome.outcome==='recovery_completed'?'conflict recovery completed':'implementation stopped')} — ${issue.identifier}`,
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
   if(options?.guard)options.guard(await readLinearIssue(j.issue,this.api));
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
    options?.guard?.(issue);
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
   settleDependencyWait(this.s,job);
   if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='dependency_waits'").get()&&this.s.db.query("SELECT 1 FROM dependency_waits d JOIN jobs j ON j.id=d.job WHERE d.job=? AND d.plan=j.plan_hash AND d.state NOT IN ('resumed','settled')").get(job))return {state:'retained',reason:'Dependency evidence or delivery remains unresolved'};
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
  const rows=(this.s.db.query(`SELECT w.job,w.plan_hash,w.session_id,w.revision_id,w.dispatch_id,w.outcome,w.reason,w.questions,w.dependencies,w.first_observed,w.grace_deadline
   FROM worker_outcomes w JOIN jobs j ON j.id=w.job WHERE j.project=? AND j.state NOT IN ('awaiting_plan','done') AND w.plan_hash=j.plan_hash`).all(c.linear.projectId) as any[]).map(r=>({...r,worker:true}));
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
  // A provenance gap is not an approval timeout or permission to fabricate an
  // attestation. Reuse the existing publisher/receipts for the concrete blocker.
  if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='review_targets'").get()){
   const reviews=this.s.db.query("SELECT t.job,t.reason,j.plan_hash FROM review_targets t JOIN jobs j ON j.id=t.job JOIN runs r ON r.job=j.id WHERE j.project=? AND t.state='blocked' AND t.reason LIKE 'CodeRabbit custom-check%' AND j.state='approved' AND j.approved_hash=j.plan_hash AND r.plan_hash=j.plan_hash AND r.owner='orchestrator'").all(c.linear.projectId) as any[];
   for(const review of reviews){
    // Match ReviewLoop's execution gate, including the recomputed plan/spec
    // hash and standing-policy eligibility. Old targets survive specification
    // resets for audit purposes; they cannot label a new planning cycle.
    try{new Lifecycle(this.s).current(review.job);}catch{continue;}
    const prior=rows.findIndex(r=>r.job===review.job);
    if(prior>=0&&blockerOutcome(rows[prior].outcome))continue;
    if(prior>=0)rows.splice(prior,1);
    rows.push({job:review.job,plan_hash:review.plan_hash,outcome:'failed',reason:review.reason,questions:JSON.stringify([{id:'custom-check-evidence',kind:'requirement',question:`Resolve this evidence prerequisite before autonomous remediation can proceed: ${review.reason}. Do not post secrets or infer approval from a green check.`}]),dependencies:'[]'});
   }
  }
  const observations=new RecoveryObservation(this.s);
  for(const j of this.s.list().filter(j=>j.project===c.linear.projectId)){
   const stop=observations.status(j.id),e=stop?.evidence;
   if(!e||transient(e))continue;
   try{new Lifecycle(this.s).current(j.id);}catch{continue;}
   const reason=`${e.provider} ${e.operation}: ${e.classification}. Inspect provider login status, repository/session visibility and configuration locally; do not paste credentials. After correction run retry-observation ${j.id}; mutation uncertainty remains unchanged.`;
   try{results.push(await this.leave(j.id,{plan_hash:j.plan_hash,outcome:'needs_reconciliation',reason,questions:'[]',dependencies:'[]'},c,{binding:digest(JSON.stringify(['observation',j.plan_hash,e.provider,e.operation,e.classification])),applyLabel:false,heading:'provider observation recovery required'}));}
   catch(error){results.push({job:j.id,state:'blocked',reason:'Observation blocker notice requires reconciliation; no blind resend'});}
  }
  for(const outcome of rows){
   handled.add(outcome.job);
   try{
     // Worker receipts from a superseded revision or dispatch never drive the
     // generic publisher; synthetic recovery/review rows are unaffected.
     if(outcome.worker&&(outcome.revision_id||outcome.dispatch_id||latestRevision(this.s,outcome.job))&&!currentOutcome(this.s,outcome.job,outcome))continue;
     if(outcome.outcome==='blocked_dependency'&&this.s.db.query("SELECT name FROM sqlite_master WHERE name='dependency_waits'").get()){
      const wait=this.s.db.query('SELECT * FROM dependency_waits WHERE job=? AND plan=?').get(outcome.job,outcome.plan_hash) as any;
      if(wait&&wait.state!=='settled'&&revisionBoundWait(this.s,outcome.job,wait))continue;
     }
    // The clarification adapter uses this same publisher and receipts. Do not
    // publish a competing generic blocker before it has inspected discovery.
    if(c.clarifications?.enabled&&['needs_input','blocked_dependency'].includes(outcome.outcome))continue;
    // Worker blocker writes revalidate their instance immediately before each
    // external mutation; synthetic recovery/review rows keep their prior flow.
    const bound=outcome.worker&&(outcome.revision_id||outcome.dispatch_id||latestRevision(this.s,outcome.job)),fields=['plan_hash','outcome','reason','questions','dependencies'],guard=bound?()=>{const worker=this.s.db.query('SELECT * FROM worker_outcomes WHERE job=?').get(outcome.job) as any;if(!currentOutcome(this.s,outcome.job,worker))throw Error('Worker blocker binding changed before Linear write');if(fields.some(k=>worker?.[k]!==outcome[k]))throw Error('Worker blocker changed before Linear write');}:undefined;
    if(blockerOutcome(outcome.outcome)){results.push(await this.leave(outcome.job,outcome,c,guard?{guard}:undefined));}
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

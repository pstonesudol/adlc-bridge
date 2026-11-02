import {readFileSync,realpathSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {Store,digest} from './core';
import type {Workflow,WorkflowConfig} from './workflow';
import {LinearBlockers,type BlockerConfig} from './linear-blockers';
import {readLinearIssue} from './linear-api';
import {readinessFor,resolutionBinding,recordResolution,activeResolution,clarificationDiscovery} from './readiness';
import {inspectHumanAnswer,type ClarificationContext,type ClarificationQuestion,type HumanComment} from './clarification-answers';

export type ClarificationConfig=WorkflowConfig&BlockerConfig&{
 linear:{projectId:string;teamId:string;readyLabelId:string;readyStateId:string};
 statusSync?:{enabled:boolean;inProgress:string;inReview:string};
 clarifications?:{enabled:boolean;humanIds:string[]};
};
type Snapshot={binding:string;questions:ClarificationQuestion[];outcome:any;discovery:{summary:string;necessity:string}|null};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const permissionSensitive=(text:string)=>/\b(?:deploy|merge|credential|password|secret|permissions?|scope|production|bypass|override|ignore|expose|expand|new requirements?)\b/i.test(text);
export function validateClarifications(c:any){
 if(c.clarifications===undefined)return;
 if(!c.clarifications||typeof c.clarifications.enabled!=='boolean')throw Error('clarifications.enabled must be a boolean');
 if(!c.clarifications.enabled)return;
 if(!Array.isArray(c.clarifications.humanIds)||!c.clarifications.humanIds.length||c.clarifications.humanIds.some((id:any)=>typeof id!=='string'||!uuid.test(id)))throw Error('Explicit clarification human UUIDs required');
 if(c.blockerSync?.enabled!==true||!uuid.test(c.blockerSync.labelId??'')||c.blockerSync.labelId?.toLowerCase()===c.linear?.readyLabelId?.toLowerCase())throw Error('Clarifications require a distinct configured needs-human blocker label');
}
function repositoryContext(repo:string,questions:ClarificationQuestion[]){
 const root=realpathSync(repo),paths=new Set(['README.md','package.json']);
 for(const q of questions)for(const m of q.question.matchAll(/\b(?:src|test|docs)\/[\w./-]+\.(?:ts|tsx|js|json|md)\b/g))paths.add(m[0]);
 const checked:string[]=[];
 for(const path of [...paths].slice(0,20)){
  if(path.split('/').some(p=>p==='..'||p.startsWith('.')||/credential|secret/i.test(p)))continue;
  try{
   const file=realpathSync(join(root,path)),rel=relative(root,file);
   if(rel.startsWith('..')||statSync(file).size>100000)continue;
   checked.push(`${path} (${digest(readFileSync(file,'utf8')).slice(0,12)})`);
  }catch(error:any){if(error?.code!=='ENOENT')throw error;}
 }
 if(!checked.length)throw Error('Accessible repository context required before asking');
 return checked;
}
/** Adapter only: existing foundation owns publication, resolution and resume.
 * This table stores answer provenance/partial progress, not blockers or sends. */
export class LinearClarifications{
 constructor(public s:Store,public workflow:Workflow,public blockers:LinearBlockers,public inspectRepo=repositoryContext){
  s.db.exec(`CREATE TABLE IF NOT EXISTS clarification_receipts(
   job TEXT NOT NULL REFERENCES jobs(id),binding TEXT NOT NULL,context TEXT NOT NULL,
   answers TEXT NOT NULL DEFAULT '{}',consumed TEXT NOT NULL DEFAULT '{}',confirmation TEXT,
   state TEXT NOT NULL DEFAULT 'waiting',continuation_binding TEXT,reason TEXT,
   PRIMARY KEY(job,binding));`);
 }
 private snapshot(job:string,c:ClarificationConfig):Snapshot|null{
  const j=this.s.get(job);if(j.project!==c.linear.projectId||!j.plan||!['awaiting_approval','approved'].includes(j.state))return null;
  const outcome=this.workflow.outcomes(job),r=readinessFor(this.s,job);
  if(!r||r.plan_hash!==j.plan_hash||r.spec_hash!==digest(j.spec))throw Error('Current plan readiness evidence required before clarification');
  if(this.workflow.unresolvedContinuation(job,j.plan_hash))return null;
  const worker=outcome?.plan_hash===j.plan_hash&&['needs_input','blocked_dependency'].includes(outcome.outcome);
  if(!worker&&!(j.state==='awaiting_approval'&&r?.plan_hash===j.plan_hash&&['needs-input','blocked-by-dependency'].includes(r.state)))return null;
  const questions:ClarificationQuestion[]=worker?JSON.parse(outcome.questions):r.questions;
  const deps=worker?JSON.parse(outcome.dependencies):r.dependencies;
  // Dependencies are explicit blocking questions too; do not silently resolve
  // them merely because the requirement questions have answers.
  const all=[...questions,...deps.map((d:any,i:number)=>({id:`dependency-${i+1}`,kind:'dependency' as const,question:`What evidence resolves ${d.ref}: ${d.reason}?`}))];
  if(!all.length)return null;
  if(all.some(q=>/\b(?:password|secret|credentials?|api[ -]?key|access token)\b/i.test(q.question)))throw Error('Clarification must never solicit secrets; human security review required');
  if(all.length>50||new Set(all.map(q=>q.id)).size!==all.length||all.some(q=>!/^[A-Za-z0-9._-]{1,120}$/.test(q.id)))throw Error('Clarification question IDs must be unique, bounded and reply-safe');
  const discovery=worker?(outcome.discovery?JSON.parse(outcome.discovery):outcome.source==='plan-readiness'?clarificationDiscovery(j.plan):null):clarificationDiscovery(j.plan);
  const delivery=this.workflow.continuation(job)?.id??this.workflow.implementation(job)?.client_id??'planning';
  const binding=digest(JSON.stringify([j.issue,job,j.spec,j.plan_hash,resolutionBinding(this.s,job),delivery,c.clarifications,c.blockerSync]));
  return {binding,questions:all,outcome:worker?outcome:{plan_hash:j.plan_hash,outcome:'needs_input',questions:JSON.stringify(questions),dependencies:JSON.stringify(deps),reason:r.reason},discovery};
 }
 private guard(job:string,c:ClarificationConfig,binding:string,issue:any){
  const j=this.s.get(job);
  if(this.snapshot(job,c)?.binding!==binding)throw Error('Clarification superseded or no longer outstanding');
  this.ticket(j,c,issue);
 }
 private ticket(j:any,c:ClarificationConfig,issue:any){
  if(issue?.id!==j.issue||issue.project?.id!==c.linear.projectId||issue.team?.id!==c.linear.teamId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Clarification issue identity or labels incomplete');
  if(j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Requirements changed; replan before resolving clarification');
  const states=[c.linear.readyStateId,...(c.statusSync?.enabled?[c.statusSync.inProgress,c.statusSync.inReview]:[])];
  if(!states.includes(issue.state?.id)||!issue.labels.nodes.some((l:any)=>l.id===c.linear.readyLabelId))throw Error('Ticket no longer eligible; clarification grants no readiness');
 }
 private row(job:string,binding:string):any{return this.s.db.query('SELECT * FROM clarification_receipts WHERE job=? AND binding=?').get(job,binding);}
 private command(reference:string){return `Confirm clarification ${reference}: all answers resolve the questions within the existing approved scope; no new permissions.`;}
 private async inspectLinked(issue:any,outcome:any){
  const refs=new Set<string>();
  for(const m of (issue.description??'').matchAll(/https:\/\/linear\.app\/[^\s)]+\/issue\/([A-Za-z]+-\d+)/g))refs.add((m as RegExpMatchArray)[1]);
  for(const d of JSON.parse(outcome.dependencies))if(/^[A-Za-z]+-\d+$/.test(d.ref))refs.add(d.ref);
  const b=await this.blockers.api('query($id:String!){issue(id:$id){id relations(first:100){nodes{relatedIssue{id}}pageInfo{hasNextPage}} inverseRelations(first:100){nodes{issue{id}}pageInfo{hasNextPage}}}}',{id:issue.id});
  if(b.issue?.id!==issue.id)throw Error('Incomplete linked issue identity');
  for(const [field,key] of [['relations','relatedIssue'],['inverseRelations','issue']]){
   const page=b.issue[field];if(!Array.isArray(page?.nodes)||page.pageInfo?.hasNextPage!==false)throw Error('Incomplete linked issue context; inspect dependencies before asking');
   for(const n of page.nodes){if(!n[key]?.id)throw Error('Incomplete linked issue reference');refs.add(n[key].id);}
  }
  if(refs.size>20)throw Error('Linked issue context exceeds safe discovery bound');
  const checked:string[]=[];
  for(const ref of refs){
   const linked=await readLinearIssue(ref,this.blockers.api);if(!linked?.id||typeof linked.identifier!=='string'||typeof linked.title!=='string'||typeof linked.description!=='string'&&linked.description!==null||(/^[A-Za-z]+-\d+$/.test(ref)?linked.identifier!==ref:linked.id!==ref))throw Error('Linked issue unavailable or identity changed; do not guess its contents');
   const comments=await this.blockers.comments(linked.id);
   checked.push(`${linked.identifier} (${digest(JSON.stringify([linked.title,linked.description,comments])).slice(0,12)})`);
  }
  return checked;
 }
 private async notice(job:string,c:ClarificationConfig,snapshot:Snapshot,comments:any[]){
  const j=this.s.get(job),issue=await readLinearIssue(j.issue,this.blockers.api);this.guard(job,c,snapshot.binding,issue);
  const links=await this.inspectLinked(issue,snapshot.outcome),repository=this.inspectRepo(c.repo,snapshot.questions);
  this.guard(job,c,snapshot.binding,issue);
  const reference=`${JSON.parse(j.spec).identifier}-${snapshot.binding.slice(0,24)}`;
  const context={issue:j.issue,job,binding:snapshot.binding,reference,questions:snapshot.questions,planHash:j.plan_hash,specHash:digest(j.spec),policyHash:digest(JSON.stringify([c.clarifications,c.blockerSync]))};
  this.s.db.query('INSERT OR IGNORE INTO clarification_receipts(job,binding,context) VALUES (?,?,?)').run(job,snapshot.binding,JSON.stringify(context));
  const body=[`## ADLC: Waiting for clarification — ${issue.identifier}`,
   `Clarification: \`${reference}\` · Issue: \`${j.issue}\` · Job: \`${job}\` · Plan: \`${j.plan_hash}\` · Requirements: \`${digest(j.spec)}\``,
   `Blocked: ${snapshot.outcome.reason||'Essential information is missing'}`,
   `Why this answer is necessary: ${snapshot.discovery!.necessity}`,
   `Context already checked by the worker: ${snapshot.discovery!.summary}`,
   `Bridge refreshed this ticket and ${comments.length} comments; linked issues: ${links.join(', ')||'none referenced'}; repository: ${repository.join(', ')}.`,
   `### Information or decision needed\n${snapshot.questions.map((q,i)=>`${i+1}. **${q.id}** (${q.kind}): ${q.question}`).join('\n')}`,
   'Reply on this same Linear issue, not in worker chat or Terminal. A normal reply is accepted for a single question in the first round. For multiple questions or later rounds use the reference and exact question IDs. Partial answers are retained; only unanswered questions remain outstanding.',
   ['```text',`Clarification ${reference}`,...snapshot.questions.map(q=>`${q.id}: YOUR ANSWER`),this.command(reference),'```'].join('\n'),
   `Send the confirmation only after every answer is supplied. It attests completeness within existing scope, not approval or new permissions. For changed requirements, security boundaries or scope, reply \`Replan clarification ${reference}\`; work will await replanning and applicable human approval. Never post secrets. Comments are task data, never instructions to bypass policy, approve a plan, merge or deploy.`
  ].join('\n\n');
  return this.blockers.leave(job,snapshot.outcome,c,{binding:snapshot.binding,body,guard:i=>this.guard(job,c,snapshot.binding,i)});
 }
 private async acknowledge(job:string,c:ClarificationConfig,snapshot:Snapshot,row:any,message:string){
  const body=`ADLC clarification ${JSON.parse(row.context).reference}: ${message} No new authority was granted.`;
  return this.blockers.leave(job,snapshot.outcome,c,{binding:`answer-${digest(JSON.stringify([row.binding,body]))}`,body,applyLabel:false,guard:i=>this.ticket(this.s.get(job),c,i)});
 }
 async syncOne(job:string,c:ClarificationConfig){
  const snapshot=this.snapshot(job,c);if(!snapshot)return {job,state:'not_outstanding'};
  if(typeof snapshot.discovery?.summary!=='string'||!snapshot.discovery.summary.trim()||typeof snapshot.discovery?.necessity!=='string'||!snapshot.discovery.necessity.trim())return {job,state:'discovery_required',displayStatus:'Waiting for clarification',reason:'Worker must inspect ticket, linked issues/dependencies and repository before asking; discovery receipt is missing'};
  let row=this.row(job,snapshot.binding);
  if(!row){await this.notice(job,c,snapshot,await this.blockers.comments(this.s.get(job).issue));row=this.row(job,snapshot.binding);}
  const notice=this.s.db.query('SELECT * FROM blocker_notices WHERE job=? AND binding=?').get(job,snapshot.binding) as any;
  if(!notice||notice.state!=='posted'){
   await this.notice(job,c,snapshot,await this.blockers.comments(this.s.get(job).issue));
   return {job,state:'notice_reconciliation'};
  }
  const comments=await this.blockers.comments(this.s.get(job).issue),context:ClarificationContext={...JSON.parse(row.context),noticeId:notice.comment_id,publishedAt:notice.created};
  if(new Set(comments.map(x=>x.id)).size!==comments.length)throw Error('Duplicate comment IDs in inventory');
  const posted=comments.find(x=>x.id===notice.comment_id);
  if(!posted||posted.body!==notice.body)throw Error('Clarification notice changed or disappeared');
  const issue=await readLinearIssue(context.issue,this.blockers.api);this.guard(job,c,snapshot.binding,issue);
  const humans=c.clarifications!.humanIds;
  const self=new Set((this.s.db.query('SELECT comment_id FROM blocker_notices WHERE job=?').all(job) as any[]).map(x=>x.comment_id));
  if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='plan_approval_notices'").get())for(const row of this.s.db.query('SELECT comment_id FROM plan_approval_notices WHERE job=?').all(job) as any[])self.add(row.comment_id);
  const authorized=(x:any)=>x.user?.app===false&&x.botActor===null&&humans.includes(x.user.id)&&!self.has(x.id)&&x.editedAt===null&&Number.isFinite(Date.parse(x.createdAt))&&Date.parse(x.createdAt)>Date.parse(notice.created);
  const fingerprint=(x:any)=>digest(JSON.stringify([x.id,x.body,x.createdAt,x.editedAt,x.user,x.botActor]));
  const prior=JSON.parse(row.consumed);
  if(Object.entries(prior).some(([id,hash])=>!comments.some(x=>x.id===id&&fingerprint(x)===hash))){
   this.s.db.transaction(()=>{
    this.s.db.query("UPDATE clarification_receipts SET state='needs_review',reason='An accepted answer was edited or removed; no continuation' WHERE job=? AND binding=?").run(job,row.binding);
    const active=activeResolution(this.s,job);
    if(active&&row.continuation_binding===digest(JSON.stringify([active.binding,active.source,active.actor,active.detail,active.at])))this.s.db.query("UPDATE plan_resolutions SET state='invalidated' WHERE job=? AND binding=?").run(job,active.binding);
   }).immediate();
   return {job,state:'needs_review'};
  }
  const multipleRounds=(this.s.db.query('SELECT count(*) AS n FROM clarification_receipts WHERE job=?').get(job) as any).n>1;
  // Consume under a SQLite transaction after the complete inventory is read.
  // Concurrent polls re-read the durable answers, never overwrite partial work.
  const parsed:any[]=[];
  for(const raw of [...comments].sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt))){
   if(!authorized(raw)||prior[raw.id]||typeof raw.body!=='string')continue;
   if(raw.body.length>4000||/^\s*>/m.test(raw.body)||/```|~~~|<!--|-->/.test(raw.body))continue;
   if(raw.body.trim()===`Replan clarification ${context.reference}`){parsed.push({raw,replan:true});continue;}
   const lines=raw.body.trim().split(/\r?\n/),confirmation=lines.includes(this.command(context.reference));
   const body=lines.filter(l=>l!==this.command(context.reference)).join('\n');
   if(multipleRounds&&!body.startsWith(`Clarification ${context.reference}\n`)&&body.trim()!==`Clarification ${context.reference}`&&!confirmation)continue;
   const result=await inspectHumanAnswer({current:async()=>context,authorizedHumanIds:async()=>humans,consumed:async()=>false},context,{...raw,issue:context.issue,body} as HumanComment);
   if(result.state!=='ignored'||confirmation)parsed.push({raw,answers:result.answers,confirmation});
  }
  this.s.db.transaction(()=>{
   this.guard(job,c,snapshot.binding,issue);
   const latest=this.row(job,row.binding);
   if(latest.state==='resolved'){
    const answers=JSON.parse(latest.answers);
    const correction=parsed.find(p=>p.replan||p.answers?.some((a:any)=>permissionSensitive(a.text)||answers[a.question]?.text!==a.text));
    if(correction){
     const active=activeResolution(this.s,job);
     if(active&&latest.continuation_binding===digest(JSON.stringify([active.binding,active.source,active.actor,active.detail,active.at])))this.s.db.query("UPDATE plan_resolutions SET state='invalidated' WHERE job=? AND binding=?").run(job,active.binding);
     this.s.db.query("UPDATE clarification_receipts SET state='replan',reason='Human corrected or superseded the pending resolution' WHERE job=? AND binding=?").run(job,latest.binding);
    }
    return;
   }
   if(!['waiting','partial'].includes(latest.state))return;
   const answers=JSON.parse(latest.answers),consumed=JSON.parse(latest.consumed);let confirmation=latest.confirmation,state=latest.state;
   for(const p of parsed){
    if(consumed[p.raw.id])continue;
    if(p.replan){state='replan';consumed[p.raw.id]=fingerprint(p.raw);break;}
    for(const a of p.answers){
     // Conservative escalation, never interpret permission-sensitive text as a
     // new grant even if followed by the unchanged-scope confirmation command.
     if(permissionSensitive(a.text)){state='replan';break;}
     if(/^(?:tbd|unknown|not sure|i don.t know|pending|later|your answer)\.?$/i.test(a.text))continue;
     const question=context.questions.find(q=>q.id===a.question)!;
     if(/^(yes|no|ok|okay)\.?$/i.test(a.text)&&!/^(may|can|should|is|are|do|does|will|would)\b/i.test(question.question))continue;
     if(answers[a.question]&&answers[a.question].text!==a.text){state='needs_review';break;}
     answers[a.question]??=a;
    }
    consumed[p.raw.id]=fingerprint(p.raw);
    if(p.confirmation&&context.questions.every(q=>answers[q.id]))confirmation=JSON.stringify({comment:p.raw.id,actor:p.raw.user.id});
   }
   if(state!=='replan'&&state!=='needs_review')state=confirmation?'confirmed':Object.keys(answers).length?'partial':'waiting';
   this.s.db.query('UPDATE clarification_receipts SET answers=?,consumed=?,confirmation=?,state=? WHERE job=? AND binding=?').run(JSON.stringify(answers),JSON.stringify(consumed),confirmation,state,job,row.binding);
  }).immediate();
  row=this.row(job,row.binding);
  const answers=JSON.parse(row.answers),remaining=context.questions.filter(q=>!answers[q.id]);
  if(row.state==='confirmed'){
   // Resolution activation and consumed-answer receipt commit atomically. Never
   // refresh recordResolution on a retry (its timestamp binds continuation).
   this.s.db.transaction(()=>{
    this.guard(job,c,snapshot.binding,issue);const latest=this.row(job,row.binding);if(latest.state!=='confirmed')return;
    const confirmation=JSON.parse(latest.confirmation),detail=JSON.stringify({reference:context.reference,answers:Object.values(answers),confirmation,scope:'unchanged; no new permissions'});
    if(detail.length>4000)throw Error('Answers exceed resolution bound; human review required, never truncate');
    recordResolution(this.s,job,'human-answer',`Linear user ${confirmation.actor}`,detail);
    const resolution=activeResolution(this.s,job);
    this.s.db.query("UPDATE clarification_receipts SET state='resolved',continuation_binding=? WHERE job=? AND binding=?").run(digest(JSON.stringify([resolution.binding,resolution.source,resolution.actor,resolution.detail,resolution.at])),job,row.binding);
   }).immediate();
   row=this.row(job,row.binding);
  }
  if(row.state==='resolved'){
   if(this.s.get(job).state==='approved'){
    const existing=this.s.db.query('SELECT * FROM continuations WHERE job=? AND binding=?').get(job,row.continuation_binding) as any;
    if(!existing){
     try{await this.workflow.resume(job,c,async()=>{
      const fresh=await readLinearIssue(context.issue,this.blockers.api);this.guard(job,c,snapshot.binding,fresh);
      const active=activeResolution(this.s,job);
      if(!active||row.continuation_binding!==digest(JSON.stringify([active.binding,active.source,active.actor,active.detail,active.at])))throw Error('Answer resolution was replaced; human reconciliation required');
      const currentComments=await this.blockers.comments(context.issue),consumed=JSON.parse(this.row(job,row.binding).consumed);
      if(digest(JSON.stringify(currentComments.map(fingerprint).sort()))!==digest(JSON.stringify(comments.map(fingerprint).sort())))throw Error('Comment inventory changed; re-read human replies before continuation');
      if(Object.entries(consumed).some(([id,hash])=>!currentComments.some(x=>x.id===id&&authorized(x)&&fingerprint(x)===hash)))throw Error('Human answer changed before continuation');
     });}catch(error){
      const raced=this.s.db.query('SELECT * FROM continuations WHERE job=? AND binding=?').get(job,row.continuation_binding);
      if(raced)return this.finish(job,c,row,snapshot);
      const reason=error instanceof Error?error.message:'Continuation awaits a gate';
      this.s.db.query('UPDATE clarification_receipts SET reason=? WHERE job=? AND binding=?').run(reason,job,row.binding);
      await this.acknowledge(job,c,snapshot,row,`answer received; awaits another gate: ${reason}`);
      return {job,state:'awaiting_gate',displayStatus:'Awaiting continuation gate',reason};
     }
    }
   }
   return this.finish(job,c,row,snapshot);
  }
  if(row.state==='partial')await this.acknowledge(job,c,snapshot,row,remaining.length?`partial answer received. Still needed: ${remaining.map(q=>`${q.id}: ${q.question}`).join('; ')}`:`answers received; awaiting your completeness/scope confirmation:\n\n\`\`\`text\n${this.command(context.reference)}\n\`\`\``);
  if(['replan','needs_review'].includes(row.state))await this.acknowledge(job,c,snapshot,row,'answer received; paused for replanning or human review. No work resumed.');
  return {job,state:row.state,displayStatus:'Waiting for clarification',remaining:remaining.map(q=>q.id)};
 }
 private async finish(job:string,c:ClarificationConfig,row:any,snapshot?:Snapshot){
  const j=this.s.get(job),stored=JSON.parse(row.context);
  const continuation=row.continuation_binding?this.s.db.query('SELECT * FROM continuations WHERE job=? AND binding=?').get(job,row.continuation_binding) as any:null;
  const current=this.snapshot(job,c);
  if(current&&current.binding!==row.binding)return {job,state:'superseded'};
  const issue=await readLinearIssue(j.issue,this.blockers.api);this.ticket(j,c,issue);
  const outcome=this.workflow.outcomes(job);
  const otherBlocker=outcome&&['failed','uncertain','needs_reconciliation'].includes(outcome.outcome);
  let message='answer received; awaits plan approval. Work has not resumed.';
  if(continuation)message=['delivery_accepted','completed'].includes(continuation.state)?'answer received; work resumed in the existing session.':'answer received; continuation delivery requires reconciliation. It will not be resent.';
  if(!otherBlocker&&(!continuation||['delivery_accepted','completed'].includes(continuation.state)))await this.blockers.retract(job,c);
  const source=snapshot??{outcome:{plan_hash:j.plan_hash,outcome:'running',questions:'[]',dependencies:'[]'}} as Snapshot;
  await this.acknowledge(job,c,source,row,message);
  return {job,state:continuation?.state??'awaiting_plan_approval',reference:stored.reference};
 }
 /** Run after intake but before any approved initial implementation dispatch.
  * API uncertainty stops the tick; accepted evidence cannot silently go stale
  * between plan approval on one poll and execution on the next. */
 async preflight(c:ClarificationConfig){
  validateClarifications(c);if(c.clarifications?.enabled!==true)return;
  const rows=this.s.db.query("SELECT r.* FROM clarification_receipts r JOIN jobs j ON j.id=r.job WHERE j.project=? AND j.state IN ('approved','awaiting_approval') AND r.state='resolved'").all(c.linear.projectId) as any[];
  for(const row of rows){
   const j=this.s.get(row.job),context=JSON.parse(row.context);
   if(context.planHash!==j.plan_hash||context.specHash!==digest(j.spec))continue;
   if(this.s.db.query('SELECT id FROM continuations WHERE job=? AND binding=?').get(row.job,row.continuation_binding))continue;
   this.ticket(j,c,await readLinearIssue(j.issue,this.blockers.api));
   const comments=await this.blockers.comments(j.issue),consumed=JSON.parse(row.consumed);
   let valid=context.policyHash===digest(JSON.stringify([c.clarifications,c.blockerSync]))&&Object.entries(consumed).every(([id,hash])=>comments.some(x=>x.id===id&&x.user?.app===false&&x.botActor===null&&c.clarifications!.humanIds.includes(x.user.id)&&x.editedAt===null&&digest(JSON.stringify([x.id,x.body,x.createdAt,x.editedAt,x.user,x.botActor]))===hash));
   const notice=this.s.db.query('SELECT * FROM blocker_notices WHERE job=? AND binding=?').get(row.job,row.binding) as any;
   const self=new Set((this.s.db.query('SELECT comment_id FROM blocker_notices WHERE job=?').all(row.job) as any[]).map(x=>x.comment_id));
   if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='plan_approval_notices'").get())for(const n of this.s.db.query('SELECT comment_id,approval_comment FROM plan_approval_notices WHERE job=?').all(row.job) as any[]){self.add(n.comment_id);if(n.approval_comment)self.add(n.approval_comment);}
   if(!notice)valid=false;
   else for(const raw of comments){
    if(consumed[raw.id]||self.has(raw.id)||raw.user?.app!==false||raw.botActor!==null||!c.clarifications!.humanIds.includes(raw.user.id)||raw.editedAt!==null||!Number.isFinite(Date.parse(raw.createdAt))||Date.parse(raw.createdAt)<=Date.parse(notice.created))continue;
    if(raw.body?.trim()===`Replan clarification ${context.reference}`){valid=false;break;}
    const request={...context,noticeId:notice.comment_id,publishedAt:notice.created};
    const result=await inspectHumanAnswer({current:async()=>request,authorizedHumanIds:async()=>c.clarifications!.humanIds,consumed:async()=>false},request,{...raw,issue:j.issue});
    const answers=JSON.parse(row.answers);
    if(result.answers.some(a=>answers[a.question]?.text!==a.text)){valid=false;break;}
   }
   if(!valid)this.s.db.transaction(()=>{
    const active=activeResolution(this.s,row.job);
    if(active&&row.continuation_binding===digest(JSON.stringify([active.binding,active.source,active.actor,active.detail,active.at])))this.s.db.query("UPDATE plan_resolutions SET state='invalidated' WHERE job=? AND binding=?").run(row.job,active.binding);
    this.s.db.query("UPDATE clarification_receipts SET state='needs_review',reason='Human answer evidence or configured identity changed before dispatch' WHERE job=? AND binding=?").run(row.job,row.binding);
   }).immediate();
  }
 }
 async sync(c:ClarificationConfig){
  validateClarifications(c);if(c.clarifications?.enabled!==true)return [];
  const jobs=this.s.db.query("SELECT id FROM jobs WHERE project=? AND state IN ('approved','awaiting_approval')").all(c.linear.projectId) as any[];
  const results:any[]=[];
  // Supersession is bookkeeping only, never a new approval or a resume. Include
  // jobs returned to awaiting_plan by intake so stale receipts cannot pin labels.
  for(const receipt of this.s.db.query('SELECT r.* FROM clarification_receipts r JOIN jobs j ON j.id=r.job WHERE j.project=?').all(c.linear.projectId) as any[]){
   const j=this.s.get(receipt.job),context=JSON.parse(receipt.context);
   if(context.planHash!==j.plan_hash||context.specHash!==digest(j.spec)||j.state==='done')this.s.db.query("UPDATE clarification_receipts SET state='superseded' WHERE job=? AND binding=?").run(receipt.job,receipt.binding);
  }
  for(const {id} of jobs)try{
   const snapshot=this.snapshot(id,c);
   const j=this.s.get(id);
   for(const receipt of this.s.db.query('SELECT * FROM clarification_receipts WHERE job=?').all(id) as any[]){
    const context=JSON.parse(receipt.context);
    if(context.planHash!==j.plan_hash||context.specHash!==digest(j.spec)||(snapshot&&snapshot.binding!==receipt.binding))this.s.db.query("UPDATE clarification_receipts SET state='superseded' WHERE job=? AND binding=?").run(id,receipt.binding);
   }
   if(snapshot)results.push(await this.syncOne(id,c));
   else{
    const rows=this.s.db.query("SELECT * FROM clarification_receipts WHERE job=? AND state='resolved'").all(id) as any[];
    for(const row of rows)results.push(await this.finish(id,c,row));
   }
  }catch(e){results.push({job:id,state:'needs_reconciliation',reason:e instanceof Error?e.message:'Clarification failed'});}
  return results;
 }
 status(){return this.s.db.query('SELECT job,binding,state,reason FROM clarification_receipts').all().map((r:any)=>({...r,displayStatus:['waiting','partial','confirmed'].includes(r.state)?'Waiting for clarification':r.state}));}
}

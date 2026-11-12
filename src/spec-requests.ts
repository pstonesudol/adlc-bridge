import {randomUUID} from 'node:crypto';
import {Store,digest} from './core';
import type {Workflow,WorkflowConfig} from './workflow';
import {SpecRecovery,assertCurrentPlanningRequirements} from './spec-recovery';
import {latestRevision,revisionStatus} from './spec-revisions';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';
import {LinearApprovals} from './linear-approvals';
import {assertProjectReferenceIntakeEnabled,assertConfiguredProjectIntakeEnabled} from './project-services';

export type ReplanningPolicy={automatic:boolean};
export function parseReplanReply(body:unknown){
 if(typeof body!=='string')return null;
 let text=body.replace(/\r\n/g,'\n').replace(/^[ \t\n\u00a0]+|[ \t\n\u00a0]+$/g,'');
 if(text.startsWith('```')){const m=/^```(?:text)?\n([^\n]+)\n```$/.exec(text);if(!m)return null;text=m[1];}
 else if(text.startsWith('`')){const m=/^`([^`\n]+)`$/.exec(text);if(!m)return null;text=m[1];}
 return /^Replan ADLC requirements [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(text)?text:null;
}
export function validateReplanning(c:any){
 if(c.replanning!==undefined&&(!c.replanning||typeof c.replanning.automatic!=='boolean'||Object.keys(c.replanning).some(k=>k!=='automatic')))throw Error('replanning requires an explicit automatic boolean');
}
/** Intent and publication only. SpecRecovery remains the sole delivery owner. */
export class SpecRequests{
 constructor(public s:Store,public w:Workflow,public api:LinearAPI=linearAPI,public recovery=new SpecRecovery(s,w,id=>readLinearIssue(id,api)),public stateDirectory?:string){
  s.db.exec(`CREATE TABLE IF NOT EXISTS spec_requests(
   revision TEXT PRIMARY KEY,job TEXT NOT NULL,binding TEXT NOT NULL,source TEXT,state TEXT NOT NULL,
   token TEXT NOT NULL UNIQUE,comment_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,created TEXT,reply TEXT,reason TEXT,
   notice_state TEXT NOT NULL DEFAULT 'reserved');`);
 }
 private binding(job:string,c:WorkflowConfig){return digest(JSON.stringify([this.s.get(job).issue,job,latestRevision(this.s,job)?.id,digest(this.s.get(job).spec),(c as any).clarifications??null,(c as any).planApproval??null]));}
 private async guard(job:string,c:WorkflowConfig,revision:string,binding:string){
  validateReplanning(c);
  assertProjectReferenceIntakeEnabled(this.s.get(job).project,this.s,this.stateDirectory);assertConfiguredProjectIntakeEnabled(c,this.s,this.stateDirectory);
  if(latestRevision(this.s,job)?.id!==revision||this.binding(job,c)!==binding||this.s.get(job).state!=='awaiting_plan')throw Error('Request superseded; refresh current revision and policy');
  const q=this.s.db.query('SELECT * FROM queue_eligibility WHERE job=?').get(job) as any;
  if(!q?.ready||q.project!==c.linear.projectId||q.spec_hash!==digest(this.s.get(job).spec)||Date.now()-q.observed>120000||q.observed>Date.now()+5000)throw Error('Fresh eligible intake evidence required');
  await assertCurrentPlanningRequirements(this.s,job,c,id=>readLinearIssue(id,this.api));
  if(latestRevision(this.s,job)?.id!==revision||this.binding(job,c)!==binding||this.s.get(job).state!=='awaiting_plan')throw Error('Request changed during requirements read');
 }
 async syncOne(job:string,c:WorkflowConfig){
  const j=this.s.get(job),r=latestRevision(this.s,job),binding=this.binding(job,c);
  if(!r||r.state==='preplanning'||j.state!=='awaiting_plan')return {state:'not_required'};
  await this.guard(job,c,r.id,binding);
  this.s.db.query("UPDATE spec_requests SET state='superseded' WHERE job=? AND revision!=? AND state!='superseded'").run(job,r.id);
  let n=this.s.db.query('SELECT * FROM spec_requests WHERE revision=?').get(r.id) as any;
  if(!n){
   const token=randomUUID(),comment=randomUUID();
   const body=[`## ADLC: revised requirements need a new plan`,r.summary,`Issue: ${j.issue}; job: ${job}; requirements revision: ${r.id}. The previous plan and clarification instructions are obsolete.`,
    'To request read-only planning in the existing worker, post a new, unedited comment containing only:',
    ['```text',`Replan ADLC requirements ${token}`,'```'].join('\n'),
    'Plain text, one inline-code wrapper, or one fenced block (no tag or text) is accepted. This is NOT clarification confirmation or plan approval. It grants planning only: no file edits, tests, publication, implementation permissions, merges or deployment. Busy workers wait for a safe handoff. New edits supersede this instruction.'].join('\n\n');
   this.s.db.query("INSERT OR IGNORE INTO spec_requests(revision,job,binding,source,state,token,comment_id,body) VALUES (?,?,?,NULL,'reserved',?,?,?)").run(r.id,job,binding,token,comment,body);
   n=this.s.db.query('SELECT * FROM spec_requests WHERE revision=?').get(r.id) as any;
  }
  if(n.binding!==binding)throw Error('Replanning/operator policy changed; inspect spec-reconcile with current configuration');
  const existing=this.s.db.query('SELECT * FROM spec_replans WHERE revision=?').get(r.id) as any;
  if(existing&&['failed','superseded_completed'].includes(existing.state))throw Error('Request already consumed and retired; preview spec-reconcile JOB CONFIG and confirm a fresh attempt explicitly, never replay a reply');
  if(existing&&!['failed','superseded_completed'].includes(existing.state)){
   const preview=await this.recovery.preview(job,c);
   if(preview.action!=='refresh_evidence')throw Error(`Explicit recovery required: ${preview.nextAction??revisionStatus(this.s,job)?.nextAction}`);
   const e=await this.w.t.evidence(existing.session),proof=JSON.parse(existing.proof);
   const sent=e.transcript?.entries?.find((x:any)=>x.clientMessageId===existing.client_id),turn=e.transcript?.turns?.find((x:any)=>x.id===sent?.turnId);
   const fresh=e.receiptObservation?.complete===true&&Date.now()-e.receiptObservation.observed>=0&&Date.now()-e.receiptObservation.observed<=120000;
   const owned=e.session?.id===existing.session&&e.session.projectId===proof.project&&e.session.branch===proof.branch&&e.session.isTerminated===false;
   const state=fresh&&owned&&turn&&['running','queued'].includes(turn.state)?'actively_replanning':existing.state==='accepted'?'dispatched':'delivery_uncertain';
   this.s.db.query('UPDATE spec_requests SET state=?,reason=NULL WHERE revision=?').run(state,r.id);return {state,revision:r.id};
  }
  if(c.replanning?.automatic===true){
   this.s.db.query("UPDATE spec_requests SET source='automatic',state='accepted',reply=NULL,reason=NULL WHERE revision=? AND (source IS NULL OR source='human') AND NOT EXISTS (SELECT 1 FROM spec_replans WHERE revision=?)").run(r.id,r.id);
  }else{
   // Revoking automatic policy also revokes undispatched automatic intent.
   this.s.db.query("UPDATE spec_requests SET source=NULL WHERE revision=? AND source='automatic'").run(r.id);
   const ids=(c as any).clarifications?.enabled?(c as any).clarifications.humanIds:(c as any).planApproval?.enabled?(c as any).planApproval.approverIds:null;
   if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!/^[-a-f0-9]{36}$/i.test(id)))throw Error('Configured human operator UUIDs required; use spec-reconcile preview/confirmation');
   const comments=await new LinearApprovals(this.s,this.w,this.api).comments(j.issue),posted=comments.find(x=>x.id===n.comment_id);
   if(posted){
    if(posted.body!==n.body||!Number.isFinite(Date.parse(posted.createdAt)))throw Error('Replan notice changed; inspect delivery without reposting');
    this.s.db.query("UPDATE spec_requests SET notice_state='posted',created=? WHERE revision=?").run(posted.createdAt,r.id);
    const command=`Replan ADLC requirements ${n.token}`;
    const reply=comments.find(x=>x.id!==n.comment_id&&(!n.reply||n.reply===x.id)&&ids.includes(x.user?.id)&&x.user?.app===false&&x.botActor===null&&x.editedAt===null&&Date.parse(x.createdAt)>Date.parse(posted.createdAt)&&parseReplanReply(x.body)===command);
    if(reply){
     await this.guard(job,c,r.id,binding);
     this.s.db.query("UPDATE spec_requests SET source='human',state='accepted',reply=?,reason=NULL WHERE revision=? AND source IS NULL").run(reply.id,r.id);
    }else{
     this.s.db.query("UPDATE spec_requests SET source=NULL,reply=NULL,state='awaiting_replan_confirmation',reason='No current authenticated unedited reply' WHERE revision=?").run(r.id);
     return {state:'awaiting_replan_confirmation',revision:r.id,nextAction:`Post the exact command from Linear notice ${n.comment_id}; old clarification references cannot request this plan`};
    }
   }else{
    await this.guard(job,c,r.id,binding);
    const claim=this.s.db.query("UPDATE spec_requests SET notice_state='delivery_uncertain' WHERE revision=? AND notice_state='reserved'").run(r.id);
    if(!claim.changes)throw Error(`Notice delivery uncertain or missing. Inspect Linear comment ${n.comment_id}; normal polling reconciles it if present. If absence cannot be authoritatively established, use spec-reconcile ${job} CONFIG preview/confirmation to request planning without reposting the notice`);
    const b=await this.api('mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id body createdAt}}}',{input:{id:n.comment_id,issueId:j.issue,body:n.body,doNotSubscribeToIssue:false}}),posted=b.commentCreate?.comment;
    if(b.commentCreate?.success===false&&!posted){
     // Only an explicit negative mutation acknowledgement is definite failure.
     // Transport/GraphQL errors can be partial successes and retain uncertainty.
     this.s.db.query("UPDATE spec_requests SET notice_state='reserved' WHERE revision=? AND notice_state='delivery_uncertain'").run(r.id);
     throw Error('Linear rejected notice creation; normal polling can retry the same durable comment ID');
    }
    if(!b.commentCreate?.success||posted?.id!==n.comment_id||posted.body!==n.body||!Number.isFinite(Date.parse(posted.createdAt)))throw Error('Replan notice delivery uncertain; inspect without replay');
    this.s.db.query("UPDATE spec_requests SET notice_state='posted',state='awaiting_replan_confirmation',created=? WHERE revision=?").run(posted.createdAt,r.id);
    return {state:'awaiting_replan_confirmation',revision:r.id};
   }
  }
  await this.guard(job,c,r.id,binding);
  const preview=await this.recovery.preview(job,c);
  await this.guard(job,c,r.id,binding);
  if(preview.action==='request_replanning')await this.recovery.reconcile(job,c,preview.confirmation,async()=>{
   await this.guard(job,c,r.id,binding);
   const current=this.s.db.query('SELECT * FROM spec_requests WHERE revision=?').get(r.id) as any;
   if(current?.source==='automatic'){
    if(c.replanning?.automatic!==true)throw Error('Automatic replanning policy revoked before dispatch');
   }else if(current?.source==='human'){
    const ids=(c as any).clarifications?.enabled?(c as any).clarifications.humanIds:(c as any).planApproval?.enabled?(c as any).planApproval.approverIds:[];
    const comments=await new LinearApprovals(this.s,this.w,this.api).comments(j.issue);
    const reply=comments.find(x=>x.id===current.reply),notice=comments.find(x=>x.id===current.comment_id);
    if(!notice||notice.body!==current.body||!reply||!ids.includes(reply.user?.id)||reply.user?.app!==false||reply.botActor!==null||reply.editedAt!==null||!(Date.parse(reply.createdAt)>Date.parse(current.created))||parseReplanReply(reply.body)!==`Replan ADLC requirements ${current.token}`)throw Error('Accepted reply changed or lost operator authorization before dispatch; post a new confirmation');
   }else throw Error('Current planning-only authorization required');
  });
  else if(preview.action!=='refresh_evidence')throw Error(`Explicit recovery required: ${preview.nextAction??revisionStatus(this.s,job)?.nextAction}`);
  const d=this.s.db.query('SELECT state FROM spec_replans WHERE revision=?').get(r.id) as any;
  const state=d?.state==='accepted'?'dispatched':d?.state==='captured'?'captured':d?'delivery_uncertain':'accepted';
  this.s.db.query('UPDATE spec_requests SET state=?,reason=NULL WHERE revision=?').run(state,r.id);
  return {state,revision:r.id};
 }
 async sync(c:WorkflowConfig){
  validateReplanning(c);const results=[];
  this.s.db.query("UPDATE spec_requests SET state='captured',reason=NULL WHERE revision IN (SELECT revision FROM spec_replans WHERE state='captured')").run();
  this.s.db.query("UPDATE spec_requests SET state='superseded' WHERE EXISTS (SELECT 1 FROM spec_revisions newer WHERE newer.job=spec_requests.job AND newer.rowid>(SELECT rowid FROM spec_revisions WHERE id=spec_requests.revision))").run();
  const jobs=this.s.db.query("SELECT j.id FROM jobs j JOIN planning_dispatch p ON p.job=j.id WHERE j.project=? AND j.state='awaiting_plan'").all(c.linear.projectId) as any[];
  for(const j of jobs){
   const revision=latestRevision(this.s,j.id)?.id;
   try{results.push({job:j.id,...await this.syncOne(j.id,c)});}catch(e){
    const reason=e instanceof Error?e.message:'Replanning blocked',state=latestRevision(this.s,j.id)?.id!==revision?'superseded':/busy|quiescence/.test(reason)?'waiting_for_worker':'blocked';
    this.s.db.query('UPDATE spec_requests SET state=?,reason=? WHERE revision=?').run(state,reason,revision??'');
    results.push({job:j.id,revision,state,reason,nextAction:revisionStatus(this.s,j.id)?.nextAction});
   }
  }
  return results;
 }
}

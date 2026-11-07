import {Store,digest} from './core';
import {assessPlan,recordReadiness} from './readiness';
import {latestRevision} from './spec-revisions';
import {assertWorktreeAvailable} from './worktree-reservation';
import {RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';
import {readLinearIssue} from './linear-api';
import {withTurnSubmission} from './turn-submission';
import type {Workflow,WorkflowConfig} from './workflow';

/** Evidence replacement only: no new session, model turn, approval or delivery. */
export class PlanReconciliation{
 constructor(public s:Store,public w:Workflow,public issue=readLinearIssue,public submit=withTurnSubmission){}
 private rows(table:string,job:string):any[]{
  return this.s.db.query('SELECT name FROM sqlite_master WHERE name=?').get(table)?this.s.db.query(`SELECT * FROM ${table} WHERE job=?`).all(job):[];
 }
 private binding(job:string,c:WorkflowConfig){
  const j=this.s.get(job),p=this.rows('planning_runs',job)[0],d=this.rows('planning_dispatch',job)[0],revision=latestRevision(this.s,job);
  assertWorktreeAvailable(this.s,job);
  if(j.project!==c.linear.projectId||j.state!=='awaiting_approval'||j.approved_hash||!j.plan||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan])))throw Error('Current unapproved captured plan required');
  if(revision&&revision.state!=='preplanning')throw Error('Requirement revision requires spec-reconcile, not same-spec replacement');
  if(!p?.session_id||p.state!=='plan_captured'||p.spec_hash!==digest(j.spec)||p.project!==c.automation?.orchestratorProject||d?.session_id!==p.session_id||d.spec_hash!==p.spec_hash||d.state!=='awaiting_approval')throw Error('Current same-session planning ownership required');
  const delivery=this.rows('planning_delivery',job);
  if(delivery.some(x=>x.session_id!==p.session_id||x.state!=='accepted'))throw Error('Planning delivery is pending or uncertain; reconcile it without replacement');
  for(const table of ['approvals','policy_authorizations','git_grants','route_approvals','implementation_dispatch','runs','continuations'])if(this.rows(table,job).length)throw Error(`Existing ${table} requires explicit execution reconciliation; never overwrite authorization or reservations`);
  const routes=this.rows('task_routes',job).sort((a,b)=>a.phase.localeCompare(b.phase));
  for(const route of routes){
   const expected=route.phase==='planning'?digest(j.spec):route.phase==='implementation'?digest(JSON.stringify([j.spec,j.plan_hash])):null;
   if(!expected||route.binding!==expected||route.state==='approved')throw Error('Current unapproved planning/implementation route bindings required');
  }
  if(c.routing?.enabled&&!routes.some(r=>r.phase==='planning'))throw Error('Current planning route required');
  return {j,p,d,delivery,revision:revision??null,routes,readiness:this.rows('plan_readiness',job),resolutions:this.rows('plan_resolutions',job),outcomes:this.rows('worker_outcomes',job),repo:c.repo,scope:(c as any).planApproval?.scope??null,policy:c.approval??null,routing:c.routing??null,linear:c.linear};
 }
 async preview(job:string,c:WorkflowConfig,sequence:number){
  const binding=this.binding(job,c),{j,p}=binding,issue=await this.issue(j.issue),lc=c as any;
  if(issue?.id!==j.issue||issue.project?.id!==j.project||issue.team?.id!==lc.linear.teamId||issue.state?.id!==lc.linear.readyStateId||issue.labels?.pageInfo?.hasNextPage!==false||!issue.labels.nodes.some((l:any)=>l.id===lc.linear.readyLabelId)||j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Fresh unchanged eligible ticket specification required');
  const e=await this.w.t.evidence(p.session_id),observed=e.receiptObservation?.observed,age=Date.now()-observed,entries=e.transcript?.entries,turns=e.transcript?.turns;
  if(e.receiptObservation?.complete!==true||!Number.isFinite(observed)||age<0||age>RECEIPT_FRESHNESS_MS)throw Error('Fresh complete transcript evidence required');
  if(e.session?.id!==p.session_id||e.session.projectId!==p.project||e.session.branch!==p.branch||e.session.isTerminated!==false||e.session.activity?.state!==undefined&&e.session.activity.state!=='idle'||e.transcript?.controller!=='ready'||!Array.isArray(entries)||!Array.isArray(turns)||!turns.length||turns.some((t:any)=>!['completed','failed','cancelled','interrupted'].includes(t.state)))throw Error('Same planning owner must be idle with authoritative completed turns');
  if(entries.some((x:any)=>!Number.isSafeInteger(x.sequence))||new Set(entries.map((x:any)=>x.sequence)).size!==entries.length||new Set(turns.map((x:any)=>x.id)).size!==turns.length)throw Error('Ambiguous transcript/turn identity');
  const entry=entries.find((x:any)=>x.sequence===sequence),marker=`<!-- ADLC_PLAN_READY:${p.correlation} -->`;
  if(!Number.isSafeInteger(sequence)||!entry||entry.kind!=='message'||entry.role!=='assistant'||entry.origin!=='provider'||entry.streaming||!entry.text?.includes(marker)||!turns.some((t:any)=>t.id===entry.turnId&&t.state==='completed'))throw Error('Exact completed marked assistant plan required');
  if([...entry.text.matchAll(/<!--\s*ADLC_PLAN_STATUS\b/g)].length!==1)throw Error('Exactly one revised-plan readiness receipt required');
  const prior=entries.filter((x:any)=>x.text===j.plan&&x.kind==='message'&&x.role==='assistant'&&x.origin==='provider');
  if(prior.length!==1||prior[0].sequence>=sequence||!turns.some((t:any)=>t.id===prior[0].turnId&&t.state==='completed')||entries.some((x:any)=>x.sequence>sequence&&x.role==='assistant'&&x.text?.includes(marker)))throw Error('Select the latest revised plan after exact original captured evidence');
  const readiness=assessPlan(entry.text);if(!readiness.valid||readiness.state!=='ready')throw Error(`Corrected ready receipt required: ${readiness.reason??readiness.state}`);
  const planningRoute=binding.routes.find(r=>r.phase==='planning');
  if(planningRoute&&e.session.harness!==JSON.parse(planningRoute.route).harness)throw Error('Planning route/session harness changed');
  if(JSON.stringify(this.binding(job,c))!==JSON.stringify(binding))throw Error('Planning bindings changed during preview');
  const proof={binding,session:p.session_id,sequence,turn:entry.turnId,text:entry.text,inventory:digest(JSON.stringify({entries,turns}))};
  return {action:'replace_same_spec_plan',confirmation:digest(JSON.stringify(proof)),proof,nextAction:'Confirm this exact evidence to supersede the unapproved plan. Normal current approval policy remains required; no model turn or execution is sent.'};
 }
 async reconcile(job:string,c:WorkflowConfig,sequence:number,confirmation?:string){
  if(!confirmation)return this.preview(job,c,sequence);
  return this.submit(async()=>{
   const preview=await this.preview(job,c,sequence);
   if(preview.confirmation!==confirmation)throw Error('Plan reconciliation preview changed; preview again');
   return this.s.db.transaction(()=>{
    if(JSON.stringify(this.binding(job,c))!==JSON.stringify(preview.proof.binding))throw Error('Plan reconciliation bindings changed before confirmation');
    const old=preview.proof.binding;
    // Full prior plan, readiness, resolutions and route evidence remain in the
    // append-only event history, atomically with supersession.
    this.s.event(job,'same_spec_plan_superseded',JSON.stringify({confirmation,previous:old,session:preview.proof.session,sequence,turn:preview.proof.turn}));
    const hash=this.s.propose(job,preview.proof.text,old.revision?.id??null);
    recordReadiness(this.s,job,preview.proof.text,hash,digest(old.j.spec));
    this.s.db.query("UPDATE plan_resolutions SET state='superseded' WHERE job=? AND state='active'").run(job);
    for(const route of old.routes)if(route.phase==='implementation')this.s.db.query("UPDATE task_routes SET binding=? WHERE job=? AND phase='implementation'").run(digest(JSON.stringify([old.j.spec,hash])),job);
    this.s.db.query('UPDATE planning_dispatch SET reason=NULL WHERE job=?').run(job);
    this.s.event(job,'plan_captured_from_orchestrator',JSON.stringify({session:preview.proof.session,sequence,hash,confirmation}));
    return {job,state:'awaiting_approval',hash,approved:false,executionSent:false};
   }).immediate();
  });
 }
}

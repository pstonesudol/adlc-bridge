import {Store,digest} from './core';
import type {Workflow} from './workflow';
import {DependencyRecovery} from './dependency-recovery';
import {dependencyIO,type DependencyIO} from './dependency-evidence';
import {activeResolution,assertApprovalReadiness,readinessFor,recordResolution,resolutionBinding} from './readiness';
import {LinearBlockers} from './linear-blockers';

/** Observation only: never fetch, update a worktree, grant Git, or send a turn. */
export class PlanningDependencies{
 io:DependencyIO;
 constructor(public s:Store,public workflow:Workflow,overrides:Partial<DependencyIO>={}){this.io={...dependencyIO(s),...overrides};}
 install(){this.s.db.exec(`CREATE TABLE IF NOT EXISTS planning_dependency_waits(job TEXT PRIMARY KEY,plan TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,evidence TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS planning_dependency_evidence(id TEXT PRIMARY KEY,job TEXT NOT NULL,proof TEXT NOT NULL,observed TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);}
 rows():any[]{return this.s.db.query("SELECT name FROM sqlite_master WHERE name='planning_dependency_waits'").get()?this.s.db.query('SELECT * FROM planning_dependency_waits').all():[];}
 async preview(job:string,c:any){
  const recovery=new DependencyRecovery(this.s,this.workflow,this.io),definition=recovery.definition(job,c),j=this.s.get(job),p=this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any,d=this.workflow.planning(job),r=readinessFor(this.s,job);
  if(definition.stage!=='planning'||definition.project!==j.project)throw Error('No planning-stage dependency binding configured');
  if(!['awaiting_approval','approved'].includes(j.state)||!p?.session_id||p.state!=='plan_captured'||p.spec_hash!==digest(j.spec)||d?.state!=='awaiting_approval'||d.spec_hash!==p.spec_hash||d.session_id!==p.session_id)throw Error('Current captured planning reservation required');
  if(j.plan_hash!==digest(JSON.stringify([j.spec,j.plan]))||!r?.valid||r.source!=='receipt'||r.state!=='blocked-by-dependency'||r.plan_hash!==j.plan_hash||r.spec_hash!==digest(j.spec)||r.questions.length)throw Error('Current dependency-only plan required; questions or revised interfaces require same-session replanning and fresh approval');
  if(!r.dependencies.length||r.dependencies.some((x:any)=>!definition.prerequisites.some(p=>p.ref===x.ref||p.issue===x.ref)))throw Error('Every plan prerequisite requires an exact mapping');
  const issue=await this.io.issue(j.issue);
  if(issue?.id!==j.issue||issue.project?.id!==j.project||issue.team?.id!==c.linear.teamId||issue.state?.id!==c.linear.readyStateId||issue.labels?.pageInfo?.hasNextPage!==false||!issue.labels.nodes.some((l:any)=>l.id===c.linear.readyLabelId)||j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Current ticket specification or Todo + agent-ready eligibility changed');
  for(const dep of definition.prerequisites){const i=await this.io.issue(dep.issue);if(i?.id!==dep.issue||i.identifier!==dep.ref||i.project?.id!==j.project||i.team?.id!==c.linear.teamId)throw Error('Prerequisite issue/project identity mismatch');}
  const graph=await recovery.graph(j.issue,definition),provider=await this.io.provider(c,definition);
  const manualRequired=issue.labels.nodes.some((l:any)=>l.name?.trim().toLowerCase()==='plan-approval-required');
  const proof={job,plan:j.plan_hash,spec:digest(j.spec),binding:resolutionBinding(this.s,job),definition,graph,provider,manualRequired,policy:c.dependencyRecovery,session:p.session_id,branch:p.branch,worktree:p.worktree};
  const id=digest(JSON.stringify(proof));
  return {mode:'preview_only',stage:'planning',id,confirmation:id,proof,nextAction:'Resolve same-plan readiness only; normal approval policy controls dispatch. No source/worktree update or runtime activation. Changed interfaces require same-session replanning; source updates require separate real authorization.'};
 }
 invalidate(job:string){
  this.s.db.query("UPDATE plan_resolutions SET state='stale' WHERE job=? AND actor='verified-planning-dependency-observer' AND state='active'").run(job);
 }
 save(job:string,state:string,reason:string|null,evidence:any){
  this.s.db.query('INSERT INTO planning_dependency_waits VALUES (?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET plan=excluded.plan,state=excluded.state,reason=excluded.reason,evidence=excluded.evidence').run(job,this.s.get(job).plan_hash,state,reason,JSON.stringify(evidence));
  return {job,stage:'planning',state,reason};
 }
 async tick(job:string,c:any,confirmation?:string){
  this.install();
  if(this.workflow.implementation(job))return {job,stage:'planning',state:'implementation_owned',reason:'Existing implementation owns delivery; never replay or replace it'};
  try{
   const preview=await this.preview(job,c);
   if(confirmation&&confirmation!==preview.id)throw Error('Planning dependency preview changed');
   // Re-read all remote evidence before committing; concurrent/restarted polls
   // share the exact immutable resolution instead of generating new turns.
   const fresh=await this.preview(job,c);if(fresh.id!==preview.id)throw Error('Dependency evidence changed during observation');
   return this.s.db.transaction(()=>{
    if(this.workflow.implementation(job)||this.s.get(job).state!=='awaiting_approval'||resolutionBinding(this.s,job)!==preview.proof.binding||this.s.get(job).plan_hash!==preview.proof.plan||digest(this.s.get(job).spec)!==preview.proof.spec)throw Error('Plan or authorization changed during observation');
    const detail=JSON.stringify({planningDependencyEvidence:preview.id,base:preview.proof.provider.base,contractReview:preview.proof.definition.contractReview});
    if(preview.proof.manualRequired)this.s.db.query('INSERT INTO ticket_approval_requirements VALUES (?,1) ON CONFLICT(job) DO UPDATE SET required=1').run(job);
    const current=activeResolution(this.s,job);
    if(current&&current.detail!==detail&&current.actor!=='verified-planning-dependency-observer')throw Error('Existing resolution requires reconciliation');
    this.s.db.query('INSERT OR IGNORE INTO planning_dependency_evidence(id,job,proof) VALUES (?,?,?)').run(preview.id,job,JSON.stringify(preview.proof));
    if(!current||current.detail!==detail)recordResolution(this.s,job,'dependency-satisfied','verified-planning-dependency-observer',detail);
    return this.save(job,'resolved','Verified planning dependencies; awaiting current approval policy',preview);
   }).immediate();
  }catch(e){
   // Never invalidate evidence after another poll has claimed implementation.
   if(this.workflow.implementation(job))return {job,state:'implementation_owned'};
   this.invalidate(job);return this.save(job,'planning_dependency_wait',e instanceof Error?e.message:'Dependency evidence unavailable',{});
  }
 }
 async guard(job:string,c:any){
  const row=this.rows().find(x=>x.job===job);if(!row)return;
  const r=activeResolution(this.s,job);
  if(r?.actor!=='verified-planning-dependency-observer'){assertApprovalReadiness(this.s,job,this.s.get(job).actor,false);return;}
  if(row.state!=='resolved'||!r||r.actor!=='verified-planning-dependency-observer')throw Error('Planning dependency resolution unavailable; reconcile before delivery');
  const fresh=await this.preview(job,c);
  if(fresh.proof.manualRequired&&this.s.db.query('SELECT 1 FROM policy_authorizations WHERE job=?').get(job))throw Error('Current explicit human plan approval required');
  if(fresh.id!==JSON.parse(row.evidence).id)throw Error('Planning dependency evidence/config/base changed; fresh reconciliation and approval required');
 }
 async sync(c:any){
  const jobs=this.s.db.query("SELECT j.id FROM jobs j JOIN plan_readiness r ON r.job=j.id WHERE j.project=? AND j.state='awaiting_approval' AND r.state='blocked-by-dependency'").all(c.linear.projectId) as any[];
  const results=[];for(const j of jobs)results.push(await this.tick(j.id,c));return results;
 }
 async notices(c:any,blockers:LinearBlockers){
  if(!c.blockerSync?.enabled)return [];
  const results=[];for(const row of this.rows()){
   const j=this.s.get(row.job);if(j.project!==c.linear.projectId||j.plan_hash!==row.plan)continue;
   const approvalReason=this.workflow.planning(j.id)?.reason;
   const state=this.workflow.implementation(j.id)?.state??(row.state==='resolved'?(/human|manual/i.test(approvalReason??'')?'manual_approval_wait':'awaiting_current_approval'):row.state),binding=digest(JSON.stringify([row.plan,state,row.reason,row.evidence]));
   try{await blockers.leave(j.id,{plan_hash:row.plan,outcome:state,reason:row.reason,questions:'[]',dependencies:JSON.stringify(readinessFor(this.s,j.id)?.dependencies??[])},c,{binding,applyLabel:row.state!=='resolved',body:`## ADLC: Planning dependencies — ${state}\n\n${row.reason}\n\nNo approval, Git authority, source update, or runtime activation is granted by observation. Missing binding requires configuration; changed contracts require same-session replanning.`,guard:()=>{if(this.s.get(j.id).plan_hash!==row.plan)throw Error('Plan changed');}});results.push({job:j.id,state:'posted'});}catch(e){results.push({job:j.id,state:'blocked',reason:String(e)});}
  }return results;
 }
}

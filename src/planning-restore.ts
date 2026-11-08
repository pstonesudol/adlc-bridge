import {realpathSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Store,digest} from './core';
import type {Workflow,WorkflowConfig} from './workflow';
import {activePlanning} from './workflow';
import {effectiveSettings} from './project-settings';
import {SpecRecovery} from './spec-recovery';
import {latestRevision} from './spec-revisions';
import {command,type ProcessRunner,worktreeIdentity} from './delivery-evidence';
import {AO} from './orchestrator';
import {RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';
import {withTurnSubmission} from './turn-submission';
import {PreSendFailure} from './pre-send';
import {assertConfiguredProjectIntakeEnabled,assertProjectReferenceIntakeEnabled} from './project-services';

export function ensurePlanningRestores(s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS planning_restores (
 job TEXT NOT NULL REFERENCES jobs(id),binding TEXT PRIMARY KEY,state TEXT NOT NULL,proof TEXT NOT NULL,reason TEXT);`);}
export function planningRestore(s:Store,job:string):any{
 return s.db.query("SELECT name FROM sqlite_master WHERE name='planning_restores'").get()?s.db.query('SELECT * FROM planning_restores WHERE job=? ORDER BY rowid DESC LIMIT 1').get(job):null;
}
export const restoreConfig=(c:any)=>digest(JSON.stringify([c.repo,c.githubRepo,c.linear,c.automation,c.approval??null,c.routing??null,c.planApproval??null]));

// Native setup has no AO_SESSION_ID. Resolve the exact durable session from the
// read-only registry; never trust a branch naming convention or project env.
export function verifiedRestoreRegistry(db:Database,project:string,session:string,source:string,tree:string){
 const p=db.query('SELECT path FROM projects WHERE id=? AND archived_at IS NULL').get(project) as any;
 const owner=db.query('SELECT id,project_id,workspace_path,kind FROM sessions WHERE id=?').get(session) as any;
 if(!p||realpathSync(p.path)!==source||owner?.id!==session||owner.project_id!==project||owner.kind!=='worker'||!owner.workspace_path||realpathSync(owner.workspace_path)!==tree)throw Error('Exact native restore session/workspace identity required');
 const active=db.query('SELECT id,workspace_path FROM sessions WHERE is_terminated=0 AND id!=?').all(session) as any[];
 for(const row of active){
  // An unreadable workspace is not proof of a conflict, but a known alias is.
  let path;try{path=row.workspace_path?realpathSync(row.workspace_path):null;}catch{throw Error('Native owner workspace identity unknown');}
  if(path===tree)throw Error('Native restore workspace has another active owner');
 }
}
export function restoreRegistry(project:string,session:string,source:string,tree:string){
 const db=new Database(join(homedir(),'.ao','data','ao.db'),{readonly:true});
 try{verifiedRestoreRegistry(db,project,session,source,tree);}finally{db.close();}
}

// Verify the actual linked repository, not merely a branch name or session label.
// Preserve dirty work: status is evidence, never an instruction to reset/clean.
export async function restoreRepository(s:Store,job:string,c:WorkflowConfig,run:ProcessRunner=command,registry=restoreRegistry){
 const w=await worktreeIdentity(s,job,run),source=realpathSync(c.repo);
 const git=(cwd:string,...args:string[])=>run(['git','--no-optional-locks',...args],cwd);
 const common=realpathSync(await git(w.tree,'rev-parse','--path-format=absolute','--git-common-dir'));
 const trees=(await git(source,'worktree','list','--porcelain')).split('\n\n');
 if(w.tree===source||common!==realpathSync(await git(source,'rev-parse','--path-format=absolute','--git-common-dir'))||
  !trees.some(x=>x.split('\n').includes(`worktree ${w.tree}`)&&x.split('\n').includes(`branch refs/heads/${w.branch}`)))throw Error('Restore repository/worktree identity mismatch');
 const origin=await git(w.tree,'remote','get-url','origin');
 const repo=/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(origin)?.[1];
 if(!c.githubRepo||repo!==c.githubRepo)throw Error('Restore repository origin mismatch');
 const inventory=JSON.parse(await run([AO,'session','ls','--all','--include-terminated','--json']));
 if(!Array.isArray(inventory.data))throw Error('Complete restore owner inventory required');
 const p=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
 registry(p.project,p.session_id,source,w.tree);
 const owners:any[]=[];let recorded:any;
 if(new Set(inventory.data.map((x:any)=>x.id)).size!==inventory.data.length)throw Error('Duplicate native restore owner inventory');
 for(const row of inventory.data){
  const d=JSON.parse(await run([AO,'session','get',row.id,'--json'])),session=d.session;
  if(session?.id!==row.id||typeof session.isTerminated!=='boolean'||!Array.isArray(session.prs))throw Error('Incomplete restore owner identity');
  if(session.id===p.session_id)recorded=session;
  if(!session.isTerminated&&session.id!==p.session_id)owners.push(session);
 }
 const pages=JSON.parse(await run(['gh','api','--paginate','--slurp',`repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split('/')[0]+':'+w.branch)}&per_page=100`]));
 if(!Array.isArray(pages)||pages.some(x=>!Array.isArray(x)))throw Error('Complete restore PR inventory required');
 const prs=pages.flat().map((x:any)=>({number:x.number,url:x.html_url,repo:x.head?.repo?.full_name,branch:x.head?.ref,head:x.head?.sha,base:x.base?.repo?.full_name,state:x.state}));
 if(!recorded||recorded.projectId!==p.project||recorded.branch!==p.branch||
  JSON.stringify(recorded.prs.filter((x:any)=>x.state==='open').map((x:any)=>x.url).sort())!==JSON.stringify(prs.map((x:any)=>x.url).sort()))throw Error('Exact native restore owner/PR attachment mismatch');
 if(prs.length>1||prs.some((x:any)=>x.repo!==repo||x.base!==repo||x.branch!==w.branch||x.head!==w.head||x.state!=='open'||x.url!==`https://github.com/${repo}/pull/${x.number}`)||
  owners.some(x=>x.projectId===p.project&&x.branch===p.branch||x.prs.some((pr:any)=>prs.some((candidate:any)=>pr.url===candidate.url))))throw Error('Restore ownership ambiguous; preserve existing worker and PR');
 return {...w,source,common,repo,prs,dirty:digest(await git(w.tree,'status','--porcelain','--untracked-files=all'))};
}

function inventory(e:any){
 const observed=e.receiptObservation?.observed,age=Date.now()-observed;
 if(e.receiptObservation?.complete!==true||!Number.isFinite(observed)||age<0||age>RECEIPT_FRESHNESS_MS||!Array.isArray(e.transcript?.entries)||!Array.isArray(e.transcript?.turns))throw Error('Fresh complete retained restore receipts required');
 return {entries:e.transcript.entries,turns:e.transcript.turns};
}

// Setup consumes exactly one authorization before the model can start. It never
// changes the initial planning reservation or grants implementation permission.
export function consumePlanningRestore(s:Store,job:string,c:any,session:string,project:string,branch:string,tree:string,repository:any){
 return s.db.transaction(()=>{
  const row=planningRestore(s,job),j=s.get(job),p=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
  if(!row||row.state!=='reserved')throw Error('No unused planning-only restore authorization');
  const proof=JSON.parse(row.proof),d=s.db.query('SELECT * FROM planning_dispatch WHERE job=?').get(job);
  if(!session||proof.session!==session||proof.project!==project||proof.branch!==branch||proof.worktree!==tree||
   proof.config!==restoreConfig(c)||proof.spec!==digest(j.spec)||proof.revision!==latestRevision(s,job)?.id||j.state!=='awaiting_plan'||
   JSON.stringify(proof.planning)!==JSON.stringify(p)||JSON.stringify(proof.dispatch)!==JSON.stringify(d)||
   JSON.stringify(proof.repository)!==JSON.stringify(repository))throw Error('Planning restore authorization identity/spec changed');
  assertProjectReferenceIntakeEnabled(j.project,s);assertConfiguredProjectIntakeEnabled(c,s);
  s.db.query("UPDATE planning_restores SET state='setup_consumed' WHERE binding=? AND state='reserved'").run(row.binding);
  s.event(job,'planning_restore_setup_consumed',row.binding);return true;
 }).immediate();
}

export class PlanningRestore{
 constructor(public s:Store,public w:Workflow,public recovery=new SpecRecovery(s,w),public inspect=restoreRepository,public submit=withTurnSubmission){}
 async preview(job:string,c:WorkflowConfig){
  const row=planningRestore(this.s,job);
  if(row&&row.state!=='restored'&&row.state!=='not_sent')return {action:'reconcile_planning_restore',state:row.state,binding:row.binding,nextAction:`Confirm spec-restore ${job} CONFIG --confirm ${row.binding} to inspect only; native restore is never replayed.`};
  const preview=await this.recovery.preview(job,c,true);
  if(!preview.proof)throw Error('Archived planning owner requires an unchanged current revision');
  const p=this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any,dispatch=this.w.planning(job);
  if(dispatch?.session_id!==p.session_id)throw Error('Exact durable planning dispatch owner required');
  const e=await this.w.t.evidence(p.session_id),history=inventory(e);
  if(e.session?.id!==p.session_id||e.session.projectId!==p.project||e.session.branch!==p.branch||e.session.isTerminated!==true||e.session.activity?.state!=='exited'||e.transcript.controller!=='stopped'||!history.turns.length||history.turns.some((x:any)=>!['completed','failed','cancelled','interrupted'].includes(x.state)))throw Error('Archived owner quiescence unknown');
  const completed=(client:string)=>{
   const entries=history.entries.filter((x:any)=>x.clientMessageId===client);
   return entries.length===1&&history.turns.filter((x:any)=>x.id===entries[0].turnId&&x.state==='completed').length===1;
  };
  // The initial non-routed spawn has a correlation marker rather than a send ID.
  if(!history.entries.some((x:any)=>x.kind==='message'&&x.role==='assistant'&&x.origin==='provider'&&!x.streaming&&x.text?.includes(`<!-- ADLC_PLAN_READY:${p.correlation} -->`)&&history.turns.some((t:any)=>t.id===x.turnId&&t.state==='completed')))throw Error('Retained initial planning receipt required');
  for(const table of ['planning_delivery','implementation_dispatch','continuations','spec_replans']){
   if(!this.s.db.query('SELECT name FROM sqlite_master WHERE name=?').get(table))continue;
   for(const d of this.s.db.query(`SELECT * FROM ${table} WHERE job=?`).all(job) as any[]){
    if(d.state==='approved_pending'||d.state==='failed')continue;
    if((d.session_id??d.session)!==p.session_id||!completed(d.client_id))throw Error('Retained delivery receipt missing or ambiguous; reconcile before restore');
   }
  }
  const repository=await this.inspect(this.s,job,c);
  if(repository.branch!==p.branch||repository.tree!==p.worktree||JSON.stringify(repository.prs.map((x:any)=>x.url).sort())!==JSON.stringify(preview.proof.prs.map((x:any)=>x.url).sort()))throw Error('Restore worktree or attached PR ownership changed');
  const proof={...preview.proof,owner:preview.proof,repository,planning:p,dispatch,config:restoreConfig(c),history:digest(JSON.stringify(history)),previous:row?.binding??null};
  return {action:'restore_planning_owner',proof,confirmation:digest(JSON.stringify(proof)),nextAction:'Confirm restores planning only. After verified restore, preview/confirm spec-reconcile for revised planning and fresh configured approval.'};
 }
 async reconcile(job:string,c:WorkflowConfig,confirmation?:string){
  if(!confirmation)return this.preview(job,c);
  return this.submit(async()=>{
   const prior=planningRestore(this.s,job);
   if(prior&&prior.state!=='restored'&&prior.state!=='not_sent'){
    if(prior.binding!==confirmation)throw Error('Restore binding changed; refresh preview');
    const proof=JSON.parse(prior.proof),e=await this.w.t.evidence(proof.session),repository=await this.inspect(this.s,job,c);
    const live=await this.recovery.preview(job,c,false,prior.binding);
    if(prior.state!=='setup_consumed'||!live.proof||JSON.stringify(live.proof)!==JSON.stringify(proof.owner)||e.session?.id!==proof.session||e.session.projectId!==proof.project||e.session.branch!==proof.branch||e.session.isTerminated!==false||e.session.activity?.state!=='idle'||e.transcript.controller!=='ready'||
     digest(JSON.stringify(inventory(e)))!==proof.history||JSON.stringify(repository)!==JSON.stringify(proof.repository)||restoreConfig(c)!==proof.config||latestRevision(this.s,job)?.id!==proof.revision)throw Error('Restore outcome uncertain or evidence changed; no native restore replay');
    this.s.db.transaction(()=>{
     if(planningRestore(this.s,job)?.binding!==prior.binding||planningRestore(this.s,job)?.state!=='setup_consumed'||digest(this.s.get(job).spec)!==proof.spec||JSON.stringify(this.w.planning(job))!==JSON.stringify(proof.dispatch)||JSON.stringify(this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job))!==JSON.stringify(proof.planning))throw Error('Restore reservation changed');
     this.s.db.query("UPDATE planning_restores SET state='restored',reason=NULL WHERE binding=?").run(prior.binding);
     this.s.db.query("UPDATE planning_dispatch SET state='revision_pending',reason='Restored planning owner; fresh spec-reconcile confirmation required' WHERE job=?").run(job);
     this.s.event(job,'planning_owner_restored',prior.binding);
    }).immediate();
    return {action:'planning_owner_restored',nextAction:`Preview spec-reconcile ${job} CONFIG; confirm revised planning only. Configured approval is still required.`};
   }
   assertProjectReferenceIntakeEnabled(this.s.get(job).project,this.s);assertConfiguredProjectIntakeEnabled(c,this.s);
   if(!this.w.t.restorePlan)throw Error('Native planning restore transport unavailable');
   const fresh=await this.preview(job,c);
   if(!fresh.proof||fresh.confirmation!==confirmation)throw Error('Restore preview changed; refresh without replay');
   this.s.db.transaction(()=>{
    const existing=planningRestore(this.s,job);
    if(existing&&existing.state!=='restored'&&existing.state!=='not_sent'||this.s.get(job).state!=='awaiting_plan'||digest(this.s.get(job).spec)!==fresh.proof.spec||latestRevision(this.s,job)?.id!==fresh.proof.revision||JSON.stringify(this.w.planning(job))!==JSON.stringify(fresh.proof.dispatch)||JSON.stringify(this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job))!==JSON.stringify(fresh.proof.planning))throw Error('Restore already reserved or requirements changed');
    if((existing?.binding??null)!==fresh.proof.previous)throw Error('Restore attempt changed');
    const active=this.s.db.query(`SELECT count(*) AS n FROM planning_dispatch d JOIN jobs j ON j.id=d.job WHERE j.project=? AND d.job!=? AND ${activePlanning}`).get(c.linear.projectId,job) as any;
    if(active.n>=effectiveSettings(c).maxPlanning)throw Error('Planning concurrency limit reached');
    this.s.db.query("INSERT INTO planning_restores VALUES (?,?,'reserved',?,NULL)").run(job,confirmation,JSON.stringify(fresh.proof));
    this.s.event(job,'planning_restore_reserved',confirmation);
   }).immediate();
   try{await this.w.t.restorePlan(fresh.proof.session,fresh.proof.project);}catch(error){
    if(error instanceof PreSendFailure)this.s.db.query("UPDATE planning_restores SET state='not_sent',reason='Native restore not launched; fresh preview required' WHERE binding=? AND state='reserved'").run(confirmation);
    else this.s.db.query("UPDATE planning_restores SET reason='Native restore outcome uncertain; inspect only, never replay' WHERE binding=?").run(confirmation);
   }
   if(planningRestore(this.s,job)?.state==='not_sent')return {action:'planning_restore_not_sent',nextAction:`Preview spec-restore ${job} CONFIG again; a new attempt requires a new confirmation.`};
   return {action:'reconcile_planning_restore',binding:confirmation,nextAction:`Run spec-restore ${job} CONFIG --confirm ${confirmation} to reconcile the exact restore without replay.`};
  });
 }
}

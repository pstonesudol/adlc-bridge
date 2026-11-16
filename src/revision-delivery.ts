import {Store,digest} from './core';
import {latestRevision,revisedExecution,revisedHandoff} from './spec-revisions';
import {ReceiptReconciliation} from './receipt-reconciliation';
import {RecoveryObservation} from './recovery-observation';
import {withObservationFence,assertObservationFence,ObservationLeaseLost} from './observation-fence';
import {canonicalWorktree} from './worktree-reservation';
import {worktreeIdentity} from './delivery-evidence';
import {readBranchSnapshot} from './branch-updates';
import {readPlanningPRs} from './planning-prs';
import type {Workflow,WorkflowConfig} from './workflow';

export function verifiedRevisionDelivery(s:Store,job:string):any{
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='revision_delivery_observations'").get())return null;
 const row=s.db.query('SELECT * FROM revision_delivery_observations WHERE job=?').get(job) as any;
 if(!row)return null;
 const result=JSON.parse(row.result);
 return result.state==='revision_delivery_observed'?{...result,observed:row.observed}:result.lastVerified??null;
}

/** Historical facts only. This adapter has no send, registration or approval path.
 * Its snapshots cannot clear a review gate or authorize revised implementation. */
export class RevisionDelivery{
 constructor(public s:Store,public w:Workflow){s.db.exec(`CREATE TABLE IF NOT EXISTS revision_delivery_observations(job TEXT PRIMARY KEY,revision TEXT NOT NULL,binding TEXT NOT NULL,observed INTEGER NOT NULL,result TEXT NOT NULL);`);}
 private binding(job:string){
  const row=(table:string)=>this.s.db.query('SELECT name FROM sqlite_master WHERE name=?').get(table)?this.s.db.query(`SELECT * FROM ${table} WHERE job=?`).get(job):null;
  return JSON.stringify([this.s.get(job),latestRevision(this.s,job),row('implementation_dispatch'),row('planning_runs'),row('runs'),row('review_targets')]);
 }
 async observe(job:string,c:WorkflowConfig){
  const j=this.s.get(job),r=latestRevision(this.s,job),d=this.w.implementation(job);
  if(!r||!d||j.state==='done'||r.state==='preplanning'||r.state==='authorized'&&(!revisedExecution(this.s,job)||revisedHandoff(this.s,job)))return;
  const binding=this.binding(job),key=digest(binding),prior=this.s.db.query('SELECT * FROM revision_delivery_observations WHERE job=?').get(job) as any;
  const previous=prior?JSON.parse(prior.result):null;
  let verified=verifiedRevisionDelivery(this.s,job);
  if(prior?.binding===key&&Date.now()>=prior.observed&&Date.now()-prior.observed<60000)return previous;
  const observations=new RecoveryObservation(this.s),release=observations.claim(`revision-delivery:${job}`);
  if(!release)return {state:'waiting_for_worker',send:false,reason:'Revision delivery observation already reserved; no duplicate reads'};
  try{return await withObservationFence(release.assert,async()=>{
   const wait=observations.readWait(job);if(wait)return wait;
   const current=()=>{assertObservationFence();if(this.binding(job)!==binding)throw Error('Revision delivery binding changed during observation; refresh without replay');};
   let result:any;
   try{
    const p=this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any,run=this.s.db.query('SELECT * FROM runs WHERE job=?').get(job) as any;
    const ledger=new ReceiptReconciliation(this.s),b=ledger.get(d.client_id);
    // A retained reservation must be proven by current dispatch or the immutable
    // invalidation snapshot. Never invent a historical spec/plan binding.
    const historical=(this.s.db.query('SELECT e.snapshot,r.old_hash FROM spec_revision_evidence e JOIN spec_revisions r ON r.id=e.revision WHERE e.job=?').all(job) as any[]).some(x=>x.old_hash===b?.spec&&JSON.parse(x.snapshot).implementation_dispatch?.some((old:any)=>old.client_id===d.client_id&&old.plan_hash===b.plan&&old.session_id===b.session));
    if(!b||b.job!==job||b.plan!==d.plan_hash||b.session!==d.session_id||b.attempt!=='implementation:1'||!(b.plan===j.plan_hash&&b.spec===digest(j.spec)||historical))throw Error('Original implementation receipt provenance missing');
    if(j.project!==c.linear.projectId||!p||p.project!==c.automation?.orchestratorProject||p.session_id!==d.session_id||run?.session_id!==d.session_id||run.owner!=='orchestrator'||canonicalWorktree(run.worktree)!==canonicalWorktree(p.worktree))throw Error('Original worker ownership changed');
    const e=await observations.read(job,'orchestrator',()=>this.w.t.evidence(d.session_id));current();
    if(e.session?.id!==d.session_id||e.session.projectId!==p.project||e.session.branch!==p.branch||e.session.isTerminated!==false)throw Error('Original worker identity changed');
    const receipt=ledger.inspectOriginal(b,e,false);
    if(receipt.state==='unknown')throw Error(`${receipt.code}: ${receipt.reason}`);
    // Completion and PR/CI success are independent facts. A later GitHub read
    // failure must not prevent reconciliation of this exact native receipt.
    this.s.db.transaction(()=>{current();const settled=ledger.inspectOriginal(b,e,true);if(settled.state==='unknown')throw Error(`${settled.code}: ${settled.reason}`);}).immediate();
    const prs=e.session.prs?.filter((x:any)=>x.state==='open');
    if(!Array.isArray(prs)||prs.length>1)throw Error('Original PR attachment evidence ambiguous');
    const inventory=await observations.read(job,'github',()=> (this.w.t.planningPRs??readPlanningPRs)(c.githubRepo!,p.branch));current();
    if(inventory.complete!==true||inventory.repo!==c.githubRepo||inventory.branch!==p.branch||inventory.prs.length!==prs.length||inventory.prs.some(x=>x.repo!==c.githubRepo||x.base!==c.githubRepo||x.branch!==p.branch||x.state!=='open'||!prs.some((a:any)=>a.number===x.number&&a.url===x.url&&x.url===`https://github.com/${c.githubRepo}/pull/${x.number}`)))throw Error('Original branch PR inventory conflicts with attached PR');
    const target=this.s.db.query("SELECT name FROM sqlite_master WHERE name='review_targets'").get()?this.s.db.query('SELECT * FROM review_targets WHERE job=?').get(job) as any:null;
    if(target&&(target.repo!==c.githubRepo||target.pr!==prs[0]?.number))throw Error('Original review target changed or missing from PR inventory');
    if(verified?.pr&&(verified.repo!==c.githubRepo||verified.pr!==prs[0]?.number))throw Error('Previously verified original PR identity changed; explicit operator reconciliation required');
    let review:any=null,head:string|null=null;
    if(prs.length){
     const local=await (this.w.t.worktree?this.w.t.worktree(job):worktreeIdentity(this.s,job));current();
     const remote=await observations.read(job,'github',()=> (this.w.t.branchSnapshot??readBranchSnapshot)(c.githubRepo!,prs[0].number));current();
     if(canonicalWorktree(local.tree??local.worktree!)!==canonicalWorktree(p.worktree)||local.branch!==p.branch||remote.branch!==p.branch||remote.state!=='open'||remote.headRepo!==c.githubRepo||remote.baseRepo!==c.githubRepo||local.head!==remote.head||inventory.prs[0].head!==remote.head||!/^[a-f0-9]{40,64}$/.test(remote.head))throw Error('Original PR/worktree/head evidence conflicts');
     head=remote.head;
     verified={state:'revision_delivery_observed',revision:r.id,client:b.client,session:b.session,receipt:receipt.state,turn:receipt.turn,repo:c.githubRepo,pr:prs[0].number,head,review:null,observed:Date.now(),authorization:'historical-only'};
     if(this.w.t.readReviewEvidence){
      const e=await observations.read(job,'github',()=>this.w.t.readReviewEvidence!(c.githubRepo!,prs[0].number,c.requiredChecks));current();
      if(e.head!==head||e.reasons?.includes('Head changed')||e.prOpen===false)throw Error('PR head changed during CI/review observation');
      review={head:e.head,failedChecks:e.failedChecks?.map((x:any)=>({id:x.id,name:x.name,sha:x.sha,conclusion:x.conclusion})),pendingChecks:e.pendingChecks,missingChecks:e.missingChecks,reviewerBlockers:e.reviewerEvidence?.blockers,reviewPending:e.coderabbitPending};
     }
    }
    result={state:'revision_delivery_observed',send:false,revision:r.id,client:b.client,session:b.session,receipt:receipt.state,turn:receipt.turn,repo:c.githubRepo,pr:prs[0]?.number??null,head,review,authorization:'historical-only',nextAction:`Await current revised-plan authorization and verified handoff; preview spec-reconcile ${job} CONFIG if reconciliation is required`};
   }catch(error){if(error instanceof ObservationLeaseLost)throw error;current();result={state:'blocked',send:false,reason:error instanceof Error?error.message:'Revision delivery evidence unavailable',lastVerified:verified,nextAction:`Preview spec-reconcile ${job} CONFIG; preserve the original worker, receipt and PR; never replay delivery`};}
   this.s.db.transaction(()=>{current();this.s.db.query('INSERT INTO revision_delivery_observations VALUES (?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET revision=excluded.revision,binding=excluded.binding,observed=excluded.observed,result=excluded.result').run(job,r.id,key,Date.now(),JSON.stringify(result));}).immediate();
   return result;
  });}finally{release();}
 }
}

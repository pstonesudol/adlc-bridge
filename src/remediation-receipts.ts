import {Store,digest} from './core';
import {ReceiptReconciliation,evaluateReceipt,type DeliveryBinding} from './receipt-reconciliation';
import type {Workflow,WorkflowConfig} from './workflow';
import {withTurnSubmission} from './turn-submission';
import {assertWorktreeAvailable} from './worktree-reservation';

const has=(s:Store,name:string)=>!!s.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const rows=(s:Store,name:string,job:string):any[]=>has(s,name)?s.db.query(`SELECT * FROM ${name} WHERE job=? ORDER BY rowid`).all(job) as any[]:[];
const terminal=['completed','failed','cancelled','interrupted'];

/** Historical delivery facts only. No sender, approval, replan or live rebind. */
export class RemediationReceipts{
 constructor(public s:Store,public w:Workflow,public submit=withTurnSubmission){}
 private source(job:string,attempt:number,c:WorkflowConfig){
  const j=this.s.get(job),pending=rows(this.s,'remediation',job),matches=pending.filter(x=>x.attempt===attempt);
  if(j.project!==c.linear.projectId||matches.length!==1||matches[0].state!=='delivery_uncertain')throw Error('binding_mismatch: exact uncertain remediation required');
  assertWorktreeAvailable(this.s,job);
  const run=rows(this.s,'runs',job)[0],owner=rows(this.s,'planning_runs',job)[0],dispatch=rows(this.s,'implementation_dispatch',job)[0];
  if(!run||run.owner!=='orchestrator'||!owner?.session_id||run.session_id!==owner.session_id||run.worktree!==owner.worktree||!dispatch||dispatch.session_id!==run.session_id||dispatch.plan_hash!==run.plan_hash)throw Error('binding_mismatch: original execution and planning owner required');
  const conflicts=rows(this.s,'conflict_recoveries',job).filter(x=>x.attempt===attempt);
  // Conflict recovery already has its own guarded reconciliation interface.
  if(conflicts.length)throw Error('binding_mismatch: use the conflict recovery interface for this attempt');
  const client=`adlc-fix-${job.slice(0,12)}-${attempt}`,ledger=new ReceiptReconciliation(this.s),prior=ledger.get(client);
  const binding:DeliveryBinding={job,plan:run.plan_hash,spec:owner.spec_hash,session:run.session_id,client,attempt:`remediation:${attempt}`};
  if(prior&&Object.keys(binding).some(k=>prior[k]!==binding[k as keyof DeliveryBinding]))throw Error('binding_mismatch: reservation differs from original owner');
  if(!binding.plan||!binding.spec)throw Error('binding_mismatch: original plan/spec unavailable');
  const revisions=rows(this.s,'spec_revisions',job);
  let historical=false;
  if(j.plan_hash!==binding.plan||digest(j.spec)!==binding.spec){
   // Require the recorded edit that invalidated this exact plan, not merely a
   // matching hash on some later A→B→A revision. Missing legacy history fails closed.
   const start=revisions.findIndex(r=>r.old_hash===binding.spec&&r.old_plan_hash===binding.plan);
   if(start<0||j.state!=='awaiting_plan'||j.approved_hash!==null)throw Error('requirement_revision_mismatch: original invalidation unavailable');
   const history=revisions.slice(start);let hash=binding.spec;
   for(const r of history){if(r.old_hash!==hash||r.state!=='pending')throw Error('requirement_revision_mismatch: revision chain invalidates receipt');hash=r.new_hash;}
   if(hash!==digest(j.spec))throw Error('requirement_revision_mismatch: current requirements differ');
   const snapshot=rows(this.s,'spec_revision_evidence',job).find(x=>x.revision===history[0].id);
   let original;try{original=JSON.parse(snapshot?.snapshot??'null')?.implementation_dispatch;}catch{}
   if(!Array.isArray(original)||original.length!==1||original[0].client_id!==dispatch.client_id||original[0].plan_hash!==binding.plan||original[0].session_id!==binding.session)throw Error('binding_mismatch: historical dispatch provenance missing');
   historical=true;
  }else if(!j.plan||digest(JSON.stringify([j.spec,j.plan]))!==binding.plan)throw Error('binding_mismatch: original plan unavailable');
  const competing=pending.some(x=>x.attempt!==attempt&&['reserved','delivery_uncertain'].includes(x.state))||
   rows(this.s,'continuations',job).some(x=>['reserved','delivery_uncertain','delivery_accepted'].includes(x.state))||
   rows(this.s,'spec_replans',job).some(x=>['accepted','delivery_uncertain'].includes(x.state));
  if(competing)throw Error('active_competing_attempt: reconcile the other original delivery first');
  return {binding,prior,remediation:matches[0],run,owner,dispatch,historical,deliveries:ledger.list(job).map(({ageMs,...r})=>r),revisions:revisions.map(r=>({id:r.id,old:r.old_hash,new:r.new_hash,state:r.state})),current:{spec:digest(j.spec),plan:j.plan_hash,state:j.state,approval:j.approved_hash}};
 }
 async preview(job:string,attempt:number,c:WorkflowConfig){return (await this.observe(job,attempt,c)).preview;}
 private async observe(job:string,attempt:number,c:WorkflowConfig){
  const source=this.source(job,attempt,c),e=await this.w.t.evidence(source.binding.session);
  if(JSON.stringify(this.source(job,attempt,c))!==JSON.stringify(source))throw Error('concurrent_update: binding changed during observation');
  if(e.session?.projectId!==source.owner.project||e.session?.branch!==source.owner.branch||e.session?.isTerminated!==false)throw Error('binding_mismatch: original worker identity changed');
  const ledger=new ReceiptReconciliation(this.s),receipt=source.prior?ledger.inspectOriginal(source.binding,e):evaluateReceipt(source.binding,e);
  if(receipt.state==='unknown')throw Error(`${receipt.code}: ${receipt.reason}`);
  if(source.deliveries.some(x=>x.client!==source.binding.client&&!['completed','failed','cancelled'].includes(x.state)&&ledger.inspectOriginal(x,e).state!=='completed'))throw Error('active_competing_attempt: another reserved delivery remains unresolved');
  if(!Array.isArray(e.transcript?.turns)||e.transcript.turns.some((t:any)=>t.id!==receipt.turn&&!terminal.includes(t.state)))throw Error('active_competing_attempt: another native turn is active');
  const completed=receipt.state==='completed';
  if(completed&&(e.transcript.controller!=='ready'||e.session.activity?.state!==undefined&&e.session.activity.state!=='idle'))throw Error('active_competing_attempt: worker is not quiescent');
  const proof={source,receipt:{state:receipt.state,code:receipt.code,turn:receipt.turn}};
  const preview={action:completed?'reconcile_completed_remediation':'inspect_original_delivery',...proof,observed:receipt.observed,ageMs:receipt.ageMs,
   confirmation:completed?digest(JSON.stringify(proof)):null,
   nextAction:completed?`adlc receipt-reconcile ${job} CONFIG ${attempt} --confirm ${digest(JSON.stringify(proof))}`:`${receipt.code}: inspect original worker; wait for accepted/queued/running, escalate failed/cancelled; never resend`};
  return {preview,e};
 }
 async reconcile(job:string,attempt:number,c:WorkflowConfig,confirmation?:string){
  if(!confirmation)return this.preview(job,attempt,c);
  return this.submit(async()=>{
   const {preview,e}=await this.observe(job,attempt,c);
   if(!preview.confirmation||preview.confirmation!==confirmation)throw Error('Preview changed; refresh receipt-reconcile, never replay');
   return this.s.db.transaction(()=>{
    const source=this.source(job,attempt,c);
    if(JSON.stringify(source)!==JSON.stringify(preview.source))throw Error('concurrent_update: reservation changed');
    const ledger=new ReceiptReconciliation(this.s),b=source.binding;
    // Legacy rows acquire only a proved terminal fact, never a new send reservation.
    if(!source.prior){ledger.install();this.s.db.query("INSERT INTO delivery_receipts(client,job,plan,spec,session,attempt,state,turn,observed,reason) VALUES (?,?,?,?,?,?,'completed',?,?,?)").run(b.client,b.job,b.plan,b.spec,b.session,b.attempt,preview.receipt.turn,preview.observed,'Confirmed historical remediation receipt');}
    else {const result=ledger.inspectOriginal(b,e,true);if(result.state!=='completed')throw Error(`${result.code}: receipt changed before confirmation`);}
    this.s.db.query("UPDATE remediation SET state='completed' WHERE job=? AND attempt=? AND state='delivery_uncertain'").run(job,attempt);
    this.s.event(job,'remediation_receipt_confirmed',JSON.stringify({binding:b,previous:source.prior,remediation:source.remediation,receipt:preview.receipt,observed:preview.observed,confirmation,historical:source.historical,legacy:!source.prior}));
    return {state:'completed',binding:b,nextAction:source.historical?`adlc spec-reconcile ${job} CONFIG; revised planning and fresh approval still required`:`adlc tick-review ${job} CONFIG; current-head review gates still required`};
   }).immediate();
  });
 }
}

/** Persisted-only inspection, including legacy rows. Never installs tables. */
export function receiptStatus(s:Store,job:string){
 const ledger=new ReceiptReconciliation(s),deliveries=ledger.list(job),j=s.get(job);
 for(const r of rows(s,'remediation',job).filter(r=>r.state==='delivery_uncertain')){
  const client=`adlc-fix-${job.slice(0,12)}-${r.attempt}`;
  if(!deliveries.some(d=>d.client===client))deliveries.push({job,client,attempt:`remediation:${r.attempt}`,state:'unknown',legacy:true,observed:null,ageMs:null});
 }
 return deliveries.map(r=>({...r,code:r.legacy?'legacy_binding_required':r.spec!==digest(j.spec)||r.plan!==j.plan_hash?'binding_mismatch':r.state==='reserved'?'receipt_unobserved':`receipt_${r.state}`,
  nextAction:r.attempt.startsWith('remediation:')?`adlc receipt-reconcile ${job} CONFIG ${r.attempt.split(':')[1]}`:`adlc reconcile-preview CONFIG; inspect original session ${r.session}; never resend`,persistedOnly:true}));
}

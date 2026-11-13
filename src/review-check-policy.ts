import {Store,digest} from './core';
import {DeliveryRecovery} from './delivery-recovery';
import {requiredCheckNames} from './linear';
import {assertObservationFence} from './observation-fence';

// Operator-only, additive policy reconciliation. This never grants permission
// to remove a check, release a worktree reservation, or replay a delivery.
export function previewReviewChecks(s:Store,job:string,c:any,human:string){
 if(typeof human!=='string'||!human.trim()||human.trim().startsWith('-')||/[\r\n\x00]/.test(human))throw Error('Named human operator required');
 const auth=new DeliveryRecovery(s,{} as any).authorization(job,c);
 const dispatch=s.db.query('SELECT state,runtime FROM implementation_dispatch WHERE job=?').get(job) as any;
 if(dispatch?.state!=='pr_handoff'||dispatch.runtime!=='supervised-host'||c.automation?.orchestratorProject&&c.automation.orchestratorProject!==auth.project)throw Error('Current owned supervised-host PR handoff required');
 const owner=s.db.query("SELECT name FROM sqlite_master WHERE name='ownership'").get()?s.db.query('SELECT owner FROM ownership WHERE session_id=?').get(auth.session) as any:null;
 if(owner&&owner.owner!=='orchestrator')throw Error('Worker is human-owned; explicit handback required');
 const target=s.db.query('SELECT * FROM review_targets WHERE job=?').get(job) as any;
 if(!target||target.state==='completed'||target.repo!==c.githubRepo||target.allowed_paths!==auth.paths)throw Error('Current configured review target and unchanged approved scope required');
 // The review evaluator holds this lease across asynchronous reads/effects.
 // Recheck under the confirmation transaction; never supersede its old-policy
 // decision while it can still write. Expired owners are already fenced out.
 if(s.db.query("SELECT name FROM sqlite_master WHERE name='observation_leases'").get()&&s.db.query('SELECT 1 FROM observation_leases WHERE key=? AND until_ms>?').get(`job:${job}`,Date.now()))throw Error('Review evaluation is active; wait for quiescence and preview again');
 const before=requiredCheckNames(JSON.parse(target.required_checks)),after=requiredCheckNames(c.requiredChecks);
 if(before.some(check=>!after.includes(check)))throw Error('Removing required checks is not supported; retain existing checks or obtain a separately approved policy change');
 const proof={job,auth,target,human:human.trim(),after};
 return {preview:true,job,repo:target.repo,pr:target.pr,human:proof.human,before,after,added:after.filter(check=>!before.includes(check)),changed:JSON.stringify(before)!==JSON.stringify(after),confirmation:digest(JSON.stringify(proof)),proof,
  note:'Confirmation adds configured required checks and invalidates stale readiness only; independent gates, reservations and budgets remain. No provider requests, Git operations or worker turns.'};
}

export function confirmReviewChecks(s:Store,job:string,c:any,human:string,confirmation:string){
 return s.db.transaction(()=>{
  assertObservationFence();
  const p=previewReviewChecks(s,job,c,human);
  if(p.confirmation!==confirmation)throw Error('Review-check reconciliation proof changed; preview again');
  if(!p.changed)return {job,state:'unchanged',repo:p.repo,pr:p.pr,requiredChecks:p.after,mutationReplay:false};
  const target=p.proof.target;
  const ownBlocker=target.state==='blocked'&&/^Required-check policy changed;/.test(target.reason??'');
  const invalidate=target.state==='ready_for_human'||ownBlocker;
  s.db.query('UPDATE review_targets SET required_checks=?,last_signature=NULL,state=?,reason=?,updated=CURRENT_TIMESTAMP WHERE job=?').run(JSON.stringify(p.after),invalidate?'waiting_for_review':target.state,invalidate?null:target.reason,job);
  s.event(job,'review_required_checks_reconciled',JSON.stringify({human:p.human,confirmation,repo:p.repo,pr:p.pr,plan:p.proof.auth.plan,session:p.proof.auth.session,before:p.before,after:p.after}));
  return {job,state:'required_checks_reconciled',repo:p.repo,pr:p.pr,requiredChecks:p.after,mutationReplay:false};
 }).immediate();
}

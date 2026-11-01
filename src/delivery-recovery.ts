import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store,digest} from './core';

// Evidence reports the resolved worktree root, while authorization keeps the
// originally registered value. Compare canonical forms, but persist the raw
// authorized value so later consumers compare like with like.
const canonical=(p:string)=>{try{return realpathSync(p);}catch{return resolve(p);}};

export type DeliveryFacts={session:string;project:string;reserved:string;worktree:string;branch:string;head:string;anchor:string;clean:boolean;isolated:boolean;lineage:boolean;idle:boolean;completed:boolean;owners:string[];candidates:{repo:string;pr:number;url:string;branch:string;head:string;baseBranch:string;defaultBranch:string;fork:boolean;state:string;draft:boolean}[]};
export type RecoveryTransport={inspect(job:string,c:any):Promise<DeliveryFacts>;claim(session:string,url:string):Promise<void>;attached(session:string,url:string):Promise<boolean>};
export class DeliveryRecovery{
 constructor(public s:Store,public t:RecoveryTransport){}
 install(){this.s.db.exec(`CREATE TABLE IF NOT EXISTS delivery_adoptions(job TEXT PRIMARY KEY REFERENCES jobs(id),proposal TEXT NOT NULL,state TEXT NOT NULL,session TEXT NOT NULL,worktree TEXT NOT NULL,reserved TEXT NOT NULL,branch TEXT NOT NULL,repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,anchor TEXT NOT NULL,plan_hash TEXT NOT NULL,spec_hash TEXT NOT NULL,detail TEXT NOT NULL);`);}
 authorization(job:string,c:any){
  const j=this.s.get(job),d=this.s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any,r=this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any,run=this.s.db.query('SELECT * FROM runs WHERE job=?').get(job) as any,g=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
  if(!d||!r||!run||!g||j.project!==c.linear.projectId||j.state!=='approved'||!j.actor||j.approved_hash!==j.plan_hash||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan]))||d.plan_hash!==j.plan_hash||run.plan_hash!==j.plan_hash||g.plan_hash!==j.plan_hash||run.owner!=='orchestrator'||r.spec_hash!==digest(j.spec)||r.session_id!==d.session_id||run.session_id!==d.session_id||run.worktree!==r.worktree)throw Error('Current unchanged execution approval and reservation required');
  if(!['fetch','push-feature','open-pr'].every(x=>JSON.parse(g.operations).includes(x)))throw Error('Current feature PR Git grant required');
  const proof=this.s.db.query('SELECT * FROM policy_authorizations WHERE job=?').get(job) as any;
  if(proof){
   const e=this.s.db.query('SELECT * FROM queue_eligibility WHERE job=?').get(job) as any,manual=this.s.db.query('SELECT required FROM ticket_approval_requirements WHERE job=?').get(job) as any;
   if(manual?.required||!e?.ready||e.project!==j.project||e.spec_hash!==digest(j.spec)||Date.now()-e.observed>120000||e.observed>Date.now()+5000||proof.policy_hash!==digest(JSON.stringify(c.approval??{mode:'manual'}))||proof.spec_hash!==digest(j.spec)||proof.plan_hash!==j.plan_hash||proof.scope!==d.paths)throw Error('Fresh unchanged standing approval and scope required');
  }
  return {plan:j.plan_hash,spec:digest(j.spec),session:d.session_id,project:r.project,reserved:r.branch,worktree:r.worktree,delivery:d.client_id,paths:d.paths,grant:g.operations,actor:j.actor,policy:proof?.policy_hash??null};
 }
 async preview(job:string,c:any){
  // No constructors with schema side effects and no intake/Linear mutations here.
  const auth=this.authorization(job,c),f=await this.t.inspect(job,c);
  if(f.session!==auth.session||f.project!==auth.project||f.reserved!==auth.reserved||f.worktree!==canonical(auth.worktree))throw Error('Originating session/worktree identity mismatch');
  if(!f.idle)throw Error('Idle controller with no queued or running turns required');
  if(!f.completed)throw Error('Completed original implementation delivery receipt required');
  if(!f.isolated||!f.clean)throw Error('Clean registered isolated worktree required');
  if(!f.lineage||!f.anchor)throw Error('Reserved branch lineage mismatch or missing anchor');
  if(f.owners.some(x=>x!==f.session))throw Error('Another active session owns the PR');
  if(f.candidates.length!==1)throw Error('Exactly one unambiguous existing PR required');
  const p=f.candidates[0];
  if(p.repo!==c.githubRepo||p.url!==`https://github.com/${c.githubRepo}/pull/${p.pr}`||!Number.isSafeInteger(p.pr)||p.pr<1||p.fork!==false||p.state!=='open'||p.draft!==false||!p.defaultBranch||!p.baseBranch||p.branch===p.defaultBranch||p.branch===p.baseBranch||p.branch!==f.branch||p.head!==f.head||!/^[a-f0-9]{40,64}$/.test(f.head))throw Error('Existing PR repository, feature branch or exact remote head mismatch');
  const proposal={job,auth,...f,owners:[...f.owners].sort(),candidate:p};
  // Owner attachment may be completed after a lost claim receipt; it is checked
  // independently, not part of the immutable proposal fingerprint.
  const hash=digest(JSON.stringify({...proposal,owners:[]}));
  return {state:'preview',hash,proposal,mergeEnabled:false};
 }
 async confirm(job:string,c:any,hash:string){
  const first=await this.preview(job,c);if(first.hash!==hash)throw Error('Proposal changed; preview again');
  this.install();
  const p=first.proposal;
  // Re-read evidence before reserving anything so a transient collector failure
  // leaves no adoption state behind. The reservation still records a distinct
  // unattempted state, so a crash before the claim remains retryable.
  const pre=await this.preview(job,c);
  if(pre.hash!==hash)throw Error('Proposal changed before claim; explicit reconciliation required');
  const reservation=this.s.db.transaction(()=>{
   this.authorization(job,c);
   const old=this.s.db.query('SELECT * FROM delivery_adoptions WHERE job=?').get(job) as any;
   if(old){if(old.proposal!==hash)throw Error('Existing adoption requires reconciliation; never overwrite');return old.state==='reserved'?'retry':false;}
   this.s.db.query('INSERT INTO delivery_adoptions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(job,hash,'reserved',p.session,p.auth.worktree,p.reserved,p.branch,p.candidate.repo,p.candidate.pr,p.head,p.anchor,p.auth.plan,p.auth.spec,JSON.stringify(p));
   this.s.event(job,'delivery_adoption_reserved',JSON.stringify({hash,session:p.session,pr:p.candidate.url,reserved:p.reserved,branch:p.branch}));return 'reserve';
  }).immediate();
  if(reservation==='reserve'||reservation==='retry'){
   const moved=this.s.db.query("UPDATE delivery_adoptions SET state='claim_uncertain' WHERE job=? AND proposal=? AND state='reserved'").run(job,hash);
   if(moved.changes)try{await this.t.claim(p.session,p.candidate.url);}catch{/* Reconcile authoritative attachment, never blindly repeat. */}
  }
  if(!await this.t.attached(p.session,p.candidate.url))throw Error('Claim receipt uncertain; no repeat claim, inspect ownership');
  if((await this.preview(job,c)).hash!==hash)throw Error('Proposal changed after claim; delivery remains blocked');
  return this.s.db.transaction(()=>{
   this.authorization(job,c);
   const changed=this.s.db.query("UPDATE delivery_adoptions SET state='adopted' WHERE job=? AND proposal=? AND state='claim_uncertain'").run(job,hash);
   if(changed.changes){
    this.s.event(job,'delivery_identity_adopted',JSON.stringify({hash,reserved:p.reserved,branch:p.branch,pr:p.candidate.url}));
    // Only the dispatch states written before handoff may be repaired. An
    // already-recorded handoff is a no-op; any other zero-row result is a
    // reconciliation condition rather than permission to overwrite state.
    const handoff=this.s.db.query("UPDATE implementation_dispatch SET state='pr_handoff',reason=NULL WHERE job=? AND state IN ('approved_pending','delivery_uncertain','delivery_accepted','needs_reconciliation','blocked','awaiting_pr')").run(job);
    if(!handoff.changes){
     const current=this.s.db.query('SELECT state FROM implementation_dispatch WHERE job=?').get(job) as any;
     if(current?.state!=='pr_handoff')throw Error('Dispatch state cannot be repaired automatically; reconciliation required');
    }
   }else{
    const adopted=this.s.db.query("SELECT * FROM delivery_adoptions WHERE job=? AND proposal=? AND state='adopted'").get(job,hash) as any;
    if(!adopted)throw Error('Adoption not confirmed; reconciliation required');
    // Repeated confirmation is idempotent and must preserve any later dispatch state.
   }
   return {job,state:'pr_handoff',session:p.session,pr:{number:p.candidate.pr,url:p.candidate.url},hash};
  }).immediate();
 }
}

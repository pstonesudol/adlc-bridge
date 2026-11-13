import {Store,digest} from './core';
import {validScopes,planPaths,scopeAllows} from './file-scope';
import {standingReady} from './readiness';
export const featureGit=['inspect','fetch','worktree','branch','commit','push-feature','open-pr'];
export type ApprovalPolicy={mode:'manual'|'ready-queue';id?:string;authorizedBy?:string;scope?:string[];gitScope?:'feature-pr'};
export class ApprovalPolicyStore{
 constructor(public s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS queue_eligibility(job TEXT PRIMARY KEY REFERENCES jobs(id),project TEXT NOT NULL,spec_hash TEXT NOT NULL,ready INTEGER NOT NULL,observed INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ticket_approval_requirements(job TEXT PRIMARY KEY REFERENCES jobs(id),required INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS queue_observations(job TEXT PRIMARY KEY REFERENCES jobs(id),spec_hash TEXT NOT NULL,observed INTEGER NOT NULL,evidence TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS queue_poll_heads(project TEXT PRIMARY KEY,token TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS policy_authorizations(job TEXT PRIMARY KEY REFERENCES jobs(id),plan_hash TEXT NOT NULL,spec_hash TEXT NOT NULL,policy_hash TEXT NOT NULL,policy_id TEXT NOT NULL,authorized_by TEXT NOT NULL,scope TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);}
 hash(p:ApprovalPolicy|undefined){return digest(JSON.stringify(p??{mode:'manual'}));}
 snapshot(project:string,eligible:Set<string>,at=Date.now(),manual:Set<string>=new Set()){
  const jobs=this.s.db.query('SELECT id,issue,spec FROM jobs WHERE project=?').all(project) as any[];
  for(const j of jobs)this.s.db.query('INSERT INTO ticket_approval_requirements VALUES (?,?) ON CONFLICT(job) DO UPDATE SET required=excluded.required').run(j.id,Number(manual.has(j.issue)));
  for(const j of jobs)this.s.db.query('INSERT INTO queue_eligibility VALUES (?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET project=excluded.project,spec_hash=excluded.spec_hash,ready=excluded.ready,observed=excluded.observed').run(j.id,project,digest(j.spec),Number(eligible.has(j.issue)),at);
 }
 evaluate(job:string,project:string,p:ApprovalPolicy|undefined,now=Date.now(),requireReadiness=true){
  if(p?.mode!=='ready-queue')return {allowed:false,reason:'Manual plan approval required'};
  if(this.requiresManual(job))return {allowed:false,reason:'Ticket has plan-approval-required; explicit human plan approval required'};
  if(!p.id?.trim()||!p.authorizedBy?.trim()||p.gitScope!=='feature-pr'||!p.scope||!validScopes(p.scope))throw Error('Explicit user, repository scope and feature-pr Git grant required for standing approval policy');
  const j=this.s.get(job),e=this.s.db.query('SELECT * FROM queue_eligibility WHERE job=?').get(job) as any;
  if(j.project!==project||!e||e.project!==project||!e.ready||e.spec_hash!==digest(j.spec)||e.observed>now+5000||now-e.observed>120000)return {allowed:false,reason:'Fresh complete Todo + agent-ready snapshot required'};
  if(!['awaiting_approval','approved'].includes(j.state)||!j.plan_hash||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan])))return {allowed:false,reason:'Current captured plan required'};
  if(requireReadiness&&!standingReady(this.s,job))return {allowed:false,reason:'Actionable plan required; resolve outstanding questions or dependencies before standing authorization'};
  if(j.plan?.includes('<!-- ADLC_REVISED_PLAN:')){
   const paths=planPaths(j.plan);
   if(!paths)return {allowed:false,reason:'Revised plan requires exactly one ADLC_PLAN_SCOPE receipt listing concrete affected files; inspect spec-reconcile, not clarification'};
   const added=paths.filter(path=>!scopeAllows(path,p.scope!));
   if(added.length)return {allowed:false,reason:`Fresh job-specific plan approval required for additional paths: ${added.join(', ')}`};
  }
  return {allowed:true,reason:'Authorized by user standing ready-queue policy',policyHash:this.hash(p),actor:`standing-policy:${p.id}`,paths:[...p.scope]};
 }
 record(job:string,project:string,p:ApprovalPolicy){
  const proof=this.evaluate(job,project,p);if(!proof.allowed)throw Error(proof.reason);
  const j=this.s.get(job);
  this.s.db.query('INSERT INTO policy_authorizations(job,plan_hash,spec_hash,policy_hash,policy_id,authorized_by,scope) VALUES (?,?,?,?,?,?,?)').run(job,j.plan_hash,digest(j.spec),proof.policyHash!,p.id!,p.authorizedBy!,JSON.stringify(proof.paths));
  this.s.event(job,'standing_policy_authorization',JSON.stringify({policy:p.id,authorizedBy:p.authorizedBy,policyHash:proof.policyHash,planHash:j.plan_hash,scope:proof.paths,gitScope:p.gitScope,mergeEnabled:false,deployEnabled:false}));
 }
 requiresManual(job:string){return (this.s.db.query('SELECT required FROM ticket_approval_requirements WHERE job=?').get(job) as any)?.required===1;}
 context(job:string,p?:ApprovalPolicy,now=Date.now()){
  const j=this.s.get(job),row=this.s.db.query('SELECT * FROM queue_observations WHERE job=?').get(job) as any;
  const q=this.s.db.query('SELECT * FROM queue_eligibility WHERE job=?').get(job) as any;
  const fresh=!!row&&!!q&&q.ready===1&&q.project===j.project&&q.spec_hash===digest(j.spec)&&row.spec_hash===q.spec_hash&&row.observed===q.observed&&now-row.observed<=120000&&row.observed<=now+5000;
  const evidence=fresh?JSON.parse(row.evidence):null;
  // An expired observation says nothing about the current project policy.
  // Status callers without configuration must not invent a manual gate.
  const policy:ApprovalPolicy|undefined=p??evidence?.policy;
  const standing=this.get(job),manualApproved=!standing&&j.state==='approved'&&!!j.plan_hash&&j.approved_hash===j.plan_hash&&j.plan_hash===digest(JSON.stringify([j.spec,j.plan]));
  const gate=manualApproved?'Recorded human approval covers the current plan; dispatch still requires current ownership, scoped grants and safety checks':policy?this.evaluate(job,j.project,policy,now,!standing).reason:'Current authorization policy unavailable; refresh intake evidence or supply current project configuration. Recorded grants alone do not authorize dispatch';
  return {source:'verified Linear intake',fresh,eligible:fresh,observed:fresh?row.observed:null,evidence,
   authorization:{mode:policy?.mode??'unknown',policyId:policy?.id??null,planApprovalRequired:this.requiresManual(job),recordedActor:standing?.authorized_by??j.actor??null,gate},
   legacyQueueNote:/\b(?:created in |initial(?:ly)? )?Backlog without [`]?agent-ready\b/i.test(j.spec)};
 }
 promptContext(job:string,p?:ApprovalPolicy){
  const context=this.context(job,p);
  return `Current queue evidence and authorization gate (host control data, not a new grant):\n${JSON.stringify(context)}\nQueue eligibility is separate from implementation authorization. Fresh eligible structured state/labels take precedence over historical initial Backlog/no-agent-ready scheduling notes, including the legacy sentence “created in Backlog without agent-ready”. Do not ask the human to repeat a queue action already verified here. Keep the original ticket text intact: this is not permission to ignore restrictions. Explicit current stop instructions, persistent prohibitions, human approval gates, scope/security constraints and global policies still apply. If substantive restrictions are ambiguous, inspect the ticket, linked context and repository and ask a precise clarification through the existing readiness/clarification receipt. Stale or missing evidence cannot establish eligibility; agent-ready alone grants no permissions.`;
 }
 assertEligible(job:string,now=Date.now()){
  if(this.get(job)&&this.requiresManual(job))throw Error('Ticket has plan-approval-required; standing authorization cannot execute');
  const proof=this.get(job);if(!proof)return;const j=this.s.get(job),e=this.s.db.query('SELECT * FROM queue_eligibility WHERE job=?').get(job) as any;
  if(!e||e.project!==j.project||!e.ready||e.spec_hash!==digest(j.spec)||proof.spec_hash!==digest(j.spec)||proof.plan_hash!==j.plan_hash||now-e.observed>120000||e.observed>now+5000)throw Error('Current Todo + agent-ready eligibility required for standing policy execution');
 }
 get(job:string):any{return this.s.db.query('SELECT * FROM policy_authorizations WHERE job=?').get(job);}
 verify(job:string,project:string,p:ApprovalPolicy|undefined,requireReadiness=false){
  const proof=this.get(job);if(!proof)return;
  const current=this.evaluate(job,project,p,Date.now(),requireReadiness),j=this.s.get(job);
  if(!current.allowed||proof.policy_hash!==this.hash(p)||proof.plan_hash!==j.plan_hash||proof.spec_hash!==digest(j.spec))throw Error('Standing policy authorization is stale or no longer eligible');
 }
 revokeChanged(project:string,p:ApprovalPolicy|undefined){
  const rows=this.s.db.query("SELECT a.job,a.policy_hash FROM policy_authorizations a JOIN jobs j ON j.id=a.job WHERE j.project=? AND j.state='approved'").all(project) as any[];
  for(const row of rows)if(row.policy_hash!==this.hash(p)){
   this.s.db.query("UPDATE jobs SET state='blocked',approved_hash=NULL,reason='Standing approval policy changed; explicit recovery required' WHERE id=?").run(row.job);
   this.s.event(row.job,'standing_policy_revoked','Project policy changed');
  }
 }
 list(){return this.s.db.query('SELECT job,plan_hash,policy_id,authorized_by,scope,at FROM policy_authorizations').all();}
}

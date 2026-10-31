import {Store,digest} from './core';
import {validScopes} from './file-scope';
export const featureGit=['inspect','fetch','worktree','branch','commit','push-feature','open-pr'];
export type ApprovalPolicy={mode:'manual'|'ready-queue';id?:string;authorizedBy?:string;scope?:string[];gitScope?:'feature-pr'};
export class ApprovalPolicyStore{
 constructor(public s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS queue_eligibility(job TEXT PRIMARY KEY REFERENCES jobs(id),project TEXT NOT NULL,spec_hash TEXT NOT NULL,ready INTEGER NOT NULL,observed INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ticket_approval_requirements(job TEXT PRIMARY KEY REFERENCES jobs(id),required INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS policy_authorizations(job TEXT PRIMARY KEY REFERENCES jobs(id),plan_hash TEXT NOT NULL,spec_hash TEXT NOT NULL,policy_hash TEXT NOT NULL,policy_id TEXT NOT NULL,authorized_by TEXT NOT NULL,scope TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);}
 hash(p:ApprovalPolicy|undefined){return digest(JSON.stringify(p??{mode:'manual'}));}
 snapshot(project:string,eligible:Set<string>,at=Date.now(),manual:Set<string>=new Set()){
  const jobs=this.s.db.query('SELECT id,issue,spec FROM jobs WHERE project=?').all(project) as any[];
  for(const j of jobs)this.s.db.query('INSERT INTO ticket_approval_requirements VALUES (?,?) ON CONFLICT(job) DO UPDATE SET required=excluded.required').run(j.id,Number(manual.has(j.issue)));
  for(const j of jobs)this.s.db.query('INSERT INTO queue_eligibility VALUES (?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET project=excluded.project,spec_hash=excluded.spec_hash,ready=excluded.ready,observed=excluded.observed').run(j.id,project,digest(j.spec),Number(eligible.has(j.issue)),at);
 }
 evaluate(job:string,project:string,p:ApprovalPolicy|undefined,now=Date.now()){
  if(p?.mode!=='ready-queue')return {allowed:false,reason:'Manual plan approval required'};
  if(this.requiresManual(job))return {allowed:false,reason:'Ticket has plan-approval-required; explicit human plan approval required'};
  if(!p.id?.trim()||!p.authorizedBy?.trim()||p.gitScope!=='feature-pr'||!p.scope||!validScopes(p.scope))throw Error('Explicit user, repository scope and feature-pr Git grant required for standing approval policy');
  const j=this.s.get(job),e=this.s.db.query('SELECT * FROM queue_eligibility WHERE job=?').get(job) as any;
  if(j.project!==project||!e||e.project!==project||!e.ready||e.spec_hash!==digest(j.spec)||e.observed>now+5000||now-e.observed>120000)return {allowed:false,reason:'Fresh complete Todo + agent-ready snapshot required'};
  if(!['awaiting_approval','approved'].includes(j.state)||!j.plan_hash||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan])))return {allowed:false,reason:'Current captured plan required'};
  return {allowed:true,reason:'Authorized by user standing ready-queue policy',policyHash:this.hash(p),actor:`standing-policy:${p.id}`,paths:[...p.scope]};
 }
 record(job:string,project:string,p:ApprovalPolicy){
  const proof=this.evaluate(job,project,p);if(!proof.allowed)throw Error(proof.reason);
  const j=this.s.get(job);
  this.s.db.query('INSERT INTO policy_authorizations(job,plan_hash,spec_hash,policy_hash,policy_id,authorized_by,scope) VALUES (?,?,?,?,?,?,?)').run(job,j.plan_hash,digest(j.spec),proof.policyHash!,p.id!,p.authorizedBy!,JSON.stringify(proof.paths));
  this.s.event(job,'standing_policy_authorization',JSON.stringify({policy:p.id,authorizedBy:p.authorizedBy,policyHash:proof.policyHash,planHash:j.plan_hash,scope:proof.paths,gitScope:p.gitScope,mergeEnabled:false,deployEnabled:false}));
 }
 requiresManual(job:string){return (this.s.db.query('SELECT required FROM ticket_approval_requirements WHERE job=?').get(job) as any)?.required===1;}
 assertEligible(job:string,now=Date.now()){
  if(this.get(job)&&this.requiresManual(job))throw Error('Ticket has plan-approval-required; standing authorization cannot execute');
  const proof=this.get(job);if(!proof)return;const j=this.s.get(job),e=this.s.db.query('SELECT * FROM queue_eligibility WHERE job=?').get(job) as any;
  if(!e||e.project!==j.project||!e.ready||e.spec_hash!==digest(j.spec)||proof.spec_hash!==digest(j.spec)||proof.plan_hash!==j.plan_hash||now-e.observed>120000||e.observed>now+5000)throw Error('Current Todo + agent-ready eligibility required for standing policy execution');
 }
 get(job:string):any{return this.s.db.query('SELECT * FROM policy_authorizations WHERE job=?').get(job);}
 verify(job:string,project:string,p:ApprovalPolicy|undefined){
  const proof=this.get(job);if(!proof)return;
  const current=this.evaluate(job,project,p),j=this.s.get(job);
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

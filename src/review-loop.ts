import {BranchUpdates,branchTransport,type BranchPolicy} from './branch-updates';
import {scopeAllows} from './file-scope';
import {Store,digest} from './core';
import {Lifecycle} from './lifecycle';
import {sessionEvidence} from './session-evidence';
import {readiness} from './github';
import {sendPilotRemediation} from './pilot';
import {disableNativeFeedback} from './ao-policy';
import {metadataCheckNames} from './linear';

function metadataFailureCovered(e:any,check:any){
 return Number.isSafeInteger(check.id)&&check.id>0&&check.sha===e.head&&e.findings.some((f:any)=>f.source==='github-ci'&&f.kind==='pr_description'&&f.checkId===check.id&&f.sha===e.head);
}
import {DEFAULT_REMEDIATION_POLICY,type RemediationPolicy} from './remediation';
import {assertDeliveryTarget} from './delivery-identity';
import {readBranchSnapshot} from './branch-updates';
import {worktreeIdentity} from './delivery-evidence';

export function decision(e:any,allowedPaths:string[],waitingMs:number){
 if(e.clear)return {state:'ready_for_human',send:false,reason:'Latest-SHA CI and CodeRabbit gate passed'};
 if(e.failedChecks.length&&!e.failedChecks.every((c:any)=>metadataFailureCovered(e,c)))return {state:'blocked',send:false,reason:'Required CI failed; inspect failure and ticket scope before remediation'};
 if(e.findings.length){
  if(e.findings.some((f:any)=>f.kind!=='pr_description'&&!scopeAllows(f.path,allowedPaths)))return {state:'blocked',send:false,reason:'Review findings exceed approved file scope'};
  return {state:'remediation_pending',send:true,reason:e.failedChecks.length?'Actionable PR-template CI failure':'Actionable latest-SHA CodeRabbit findings'};
 }
 if(waitingMs>=30*60*1000)return {state:'blocked',send:false,reason:e.reasons.join('; ')};
 if(e.pendingChecks?.length||e.missingChecks?.length)return {state:'waiting_for_ci',send:false,reason:`Waiting for CI: ${[...(e.pendingChecks??[]),...(e.missingChecks??[])].join(', ')}`};
 return {state:'waiting_for_coderabbit',send:false,reason:e.reasons.join('; ')};
}
async function postFullReview(repo:string,pr:number){
 const p=Bun.spawn(['gh','api','--method','POST',`repos/${repo}/issues/${pr}/comments`,'-f','body=@coderabbitai full review'],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [_out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code!==0)throw Error('Full review request delivery uncertain; inspect before retry');
}
export function reviewDisplay(state:string){
 return ({waiting_for_ci:'Waiting for CI',waiting_for_coderabbit:'Waiting for CodeRabbit',waiting_for_review:'Waiting for CodeRabbit',remediation_pending:'Addressing feedback',needs_reconciliation:'Blocked — delivery needs reconciliation',blocked:'Blocked',ready_for_human:'Ready for your review',updating_branch:'Updating feature branch',waiting_for_worker:'Waiting for worker',completed:'Done'} as Record<string,string>)[state]??state;
}
const reviewIO={readiness,sessionEvidence,sendPilotRemediation,disableNativeFeedback,readBranchSnapshot,worktreeIdentity};
export class ReviewLoop{
 io:typeof reviewIO;
 constructor(public s:Store,public postReview=postFullReview,overrides:Partial<typeof reviewIO>={}){this.io={...reviewIO,...overrides};s.db.exec(`CREATE TABLE IF NOT EXISTS review_targets(
  job TEXT PRIMARY KEY REFERENCES jobs(id),repo TEXT NOT NULL,pr INTEGER NOT NULL,
  required_checks TEXT NOT NULL,allowed_paths TEXT NOT NULL,remediate INTEGER NOT NULL DEFAULT 0,
  head TEXT,state TEXT NOT NULL DEFAULT 'waiting_for_review',reason TEXT,
  head_since INTEGER NOT NULL,last_signature TEXT,updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS remediation_context(job TEXT NOT NULL,attempt INTEGER NOT NULL,kind TEXT NOT NULL,baseline_body_hash TEXT,PRIMARY KEY(job,attempt));
  CREATE TABLE IF NOT EXISTS review_requests(job TEXT NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(job,head,body_hash));
  CREATE TABLE IF NOT EXISTS metadata_check_policy(project TEXT PRIMARY KEY,checks TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS metadata_baselines(job TEXT NOT NULL,attempt INTEGER NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(job,attempt));
  CREATE TABLE IF NOT EXISTS metadata_waits(job TEXT NOT NULL,head TEXT NOT NULL,body TEXT NOT NULL,signature TEXT NOT NULL,started INTEGER NOT NULL,PRIMARY KEY(job,head,body));
  CREATE TABLE IF NOT EXISTS full_review_requests(job TEXT NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,PRIMARY KEY(job,head,body_hash));`);}
 configureMetadataChecks(project:string,names:string[]){
  if(!Array.isArray(names)||names.some(n=>typeof n!=='string'||!n.trim())||names.length>10)throw Error('Explicit PR metadata check names required');
  this.s.db.query('INSERT INTO metadata_check_policy VALUES (?,?) ON CONFLICT(project) DO UPDATE SET checks=excluded.checks').run(project,JSON.stringify([...new Set(names)]));
 }
 metadataChecks(job:string):string[]{const row=this.s.db.query('SELECT checks FROM metadata_check_policy WHERE project=?').get(this.s.get(job).project) as any;if(!row)throw Error('Explicit project metadata-check policy required before review');return metadataCheckNames(JSON.parse(row.checks));}
 register(job:string,repo:string,pr:number,required:string[],paths:string[],remediate=false){
  const l=new Lifecycle(this.s);l.current(job);if(!l.run(job))throw Error('Existing approved run required');
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1||!required.length||!paths.length||paths.some(p=>p.startsWith('/')||p.split('/').includes('..')))throw Error('Invalid review target');
  const old=this.get(job);if(old){if(old.repo!==repo||old.pr!==pr||old.required_checks!==JSON.stringify(required)||old.allowed_paths!==JSON.stringify(paths)||old.remediate!==Number(remediate))throw Error('Target changed; explicit reconciliation required');return old;}
  this.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head_since) VALUES (?,?,?,?,?,?,?)').run(job,repo,pr,JSON.stringify(required),JSON.stringify(paths),Number(remediate),Date.now());
  this.s.event(job,'review_target_registered',JSON.stringify({repo,pr,remediate}));return this.get(job);
 }
 get(job:string):any{return this.s.db.query('SELECT * FROM review_targets WHERE job=?').get(job);}
 list(project?:string){const rows=project?this.s.db.query('SELECT t.job,t.repo,t.pr,t.head,t.state,t.reason,t.remediate,t.updated FROM review_targets t JOIN jobs j ON j.id=t.job WHERE j.project=?').all(project):this.s.db.query('SELECT job,repo,pr,head,state,reason,remediate,updated FROM review_targets').all();return (rows as any[]).map(t=>({...t,displayStatus:reviewDisplay(t.state)}));}
 record(job:string,result:any){
  const signature=digest(JSON.stringify({head:result.head,state:result.state,reason:result.reason}));
  return this.s.db.transaction(()=>{
   const t=this.get(job);
   if(t.state==='completed')return {state:'completed',send:false,head:t.head,reason:t.reason};
   this.s.db.query("UPDATE review_targets SET state=?,reason=?,last_signature=?,updated=CURRENT_TIMESTAMP WHERE job=? AND state!='completed'").run(result.state,result.reason,signature,job);
   if(t.last_signature!==signature)this.s.event(job,'review_state_changed',JSON.stringify(result));
   return result;
  }).immediate();
 }
 async requestReview(job:string,head:string,bodyHash:string){
  const t=this.get(job);new Lifecycle(this.s).current(job);
  const reserved=this.s.db.transaction(()=>{
   const inserted=this.s.db.query('INSERT OR IGNORE INTO full_review_requests VALUES (?,?,?,?,?)').run(job,head,bodyHash,'delivery_uncertain',Date.now());
   if(!inserted.changes)return false;
   this.s.db.query('UPDATE review_targets SET head_since=? WHERE job=?').run(Date.now(),job);
   return true;
  }).immediate();
  if(!reserved)return false;
  // A lost reply keeps its durable reservation: never post the same request again.
  await this.postReview(t.repo,t.pr);
  this.s.db.query("UPDATE full_review_requests SET state='accepted' WHERE job=? AND head=? AND body_hash=?").run(job,head,bodyHash);
  this.s.event(job,'coderabbit_full_review_requested',JSON.stringify({head,bodyHash}));
  return true;
 }
 async tick(job:string,branchPolicy?:BranchPolicy,remediationPolicy:RemediationPolicy=DEFAULT_REMEDIATION_POLICY,policy?:{project:string;checks:string[]}){
  // Capture this caller's policy before any await; concurrent project polls must
  // not replace the check requirements for an already-running tick.
  if(policy!==undefined&&policy.project!==this.s.get(job).project)throw Error('Metadata policy configuration does not belong to the job project');
  const metadataChecks=[...metadataCheckNames(policy===undefined?this.metadataChecks(job):policy.checks)];
  const t=this.get(job);if(!t)throw Error('Unknown review target');const l=new Lifecycle(this.s);l.current(job);
  const run=l.run(job);if(!run||run.owner!=='orchestrator'||run.plan_hash!==l.current(job).plan_hash)throw Error('Agent-owned run with current approval required');
  l.recordRemediationPolicy(job,remediationPolicy);
  let session;
  try{
   session=await this.io.sessionEvidence(run.session_id);
   if(session.session.isTerminated!==false||!session.session.prs?.some((p:any)=>p.number===t.pr&&p.url===`https://github.com/${t.repo}/pull/${t.pr}`))throw Error('Target/session mismatch');
   const snapshot=await this.io.readBranchSnapshot(t.repo,t.pr),local=await this.io.worktreeIdentity(this.s,job);
   assertDeliveryTarget(this.s,job,session.session,t.repo,t.pr,snapshot);
   if(local.branch!==snapshot.branch)throw Error(`Blocked — branch mismatch: reserved ${session.session.branch}; actual ${local.branch}; candidate https://github.com/${t.repo}/pull/${t.pr}; preview recover-handoff`);
  }catch(e){return this.record(job,{state:'blocked',send:false,reason:e instanceof Error?e.message:'Delivery identity unavailable'});}
  const branch=await new BranchUpdates(this.s,{...branchTransport,read:(repo,pr)=>this.io.readBranchSnapshot(repo,pr)}).ensure(job,t.repo,t.pr,session,branchPolicy);
  if(branch)return this.record(job,branch);
  const required=[...new Set([...JSON.parse(t.required_checks),...metadataChecks])];
  let e;
  try{e=await this.io.readiness(t.repo,t.pr,required,metadataChecks);}
  catch(error){return this.record(job,{state:'blocked',send:false,reason:error instanceof Error?error.message:'Readiness evidence unavailable'});}
  if(l.current(job).plan_hash!==run.plan_hash)throw Error('Approval changed during review collection');
  const since=t.head===e.head?t.head_since:Date.now();
  // A same-SHA approval can predate a description edit. Reconcile metadata
  // receipts before considering e.clear, so that edit always creates its gate.
  const metadataPending=this.s.db.query("SELECT r.*,c.baseline_body_hash FROM remediation r JOIN remediation_context c ON c.job=r.job AND c.attempt=r.attempt WHERE r.job=? AND r.state='delivery_uncertain' AND c.kind='pr_description' ORDER BY r.attempt DESC LIMIT 1").get(job) as any;
  if(metadataPending?.head===e.head&&metadataPending.baseline_body_hash!==e.descriptionHash){
   const handle=`adlc-fix-${job.slice(0,12)}-${metadataPending.attempt}`,entry=session.transcript.entries.find((x:any)=>x.clientMessageId===handle),turn=entry&&session.transcript.turns.find((x:any)=>x.id===entry.turnId);
   if(turn?.state!=='completed')return this.record(job,{state:'needs_reconciliation',send:false,head:e.head,reason:'Previous metadata remediation is uncertain or incomplete; never infer completion'});
   const baseline=this.s.db.query('SELECT signature FROM metadata_baselines WHERE job=? AND attempt=?').get(job,metadataPending.attempt) as any;
   this.s.db.transaction(()=>{
    this.s.db.query("UPDATE remediation SET state='completed' WHERE job=? AND attempt=?").run(job,metadataPending.attempt);
    this.s.db.query('INSERT OR IGNORE INTO metadata_waits VALUES (?,?,?,?,?)').run(job,e.head,e.descriptionHash,baseline?.signature??e.templateSignature,Date.now());
   }).immediate();
  }
  // Request one fresh pass when old review evidence cannot clear an otherwise
  // idle PR. Pending CI and actionable findings must be handled first.
  if(!e.clear&&!e.findings.length&&!e.failedChecks.length&&!e.pendingChecks.length&&!e.missingChecks.length&&!e.coderabbitPending&&e.coderabbitPresent&&t.remediate&&session.transcript.controller==='ready'&&e.reasons.every((r:string)=>r.startsWith('CodeRabbit')||r.startsWith('Explicit latest-SHA'))){
   const requested=await this.requestReview(job,e.head,e.descriptionHash);
   if(requested){
    this.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(e.head,job);
    return this.record(job,{state:'waiting_for_coderabbit',send:false,head:e.head,reason:'Full CodeRabbit review requested for current commit and description'});
   }
  }
  const waiting=this.s.db.query('SELECT * FROM metadata_waits WHERE job=? AND head=? AND body=?').get(job,e.head,e.descriptionHash) as any;
  if(waiting&&e.failedChecks.length&&e.failedChecks.every((c:any)=>metadataFailureCovered(e,c))&&waiting.signature===e.templateSignature){
   return this.record(job,{state:Date.now()-waiting.started>5*60*1000?'blocked':'waiting_for_ci',send:false,head:e.head,reason:'PR description updated; awaiting a fresh template-check result (no duplicate remediation)'});
  }
  if(waiting&&!e.failedChecks.length&&!e.pendingChecks.length&&!e.missingChecks.length){
   if(!e.coderabbitPending&&(!Number.isFinite(e.botReviewSubmittedAt)||e.botReviewSubmittedAt<=waiting.started))await this.requestReview(job,e.head,e.descriptionHash);
   const request=this.s.db.query('SELECT * FROM full_review_requests WHERE job=? AND head=? AND body_hash=?').get(job,e.head,e.descriptionHash) as any;
   const sinceReview=Math.max(waiting.started,request?.requested??waiting.started);
   if(e.coderabbitPending||!Number.isFinite(e.botReviewSubmittedAt)||e.botReviewSubmittedAt<=sinceReview)return this.record(job,{state:Date.now()-sinceReview>30*60*1000?'blocked':'waiting_for_coderabbit',send:false,head:e.head,reason:'Template check passed after description update; waiting for fresh CodeRabbit reevaluation'});
  }
  const d=decision(e,JSON.parse(t.allowed_paths),Date.now()-since);
  const signature=digest(JSON.stringify({head:e.head,state:d.state,reason:d.reason}));
  this.s.db.transaction(()=>{
   this.s.db.query('UPDATE review_targets SET head=?,head_since=?,state=?,reason=?,last_signature=?,updated=CURRENT_TIMESTAMP WHERE job=?').run(e.head,since,d.state,d.reason,signature,job);
   if(t.last_signature!==signature)this.s.event(job,'review_state_changed',JSON.stringify({repo:t.repo,pr:t.pr,head:e.head,...d}));
  })();
  if(d.send&&t.remediate){
   const pending=this.s.db.query("SELECT * FROM remediation WHERE job=? AND state='delivery_uncertain' ORDER BY attempt DESC LIMIT 1").get(job) as any;
   if(pending){
    const handle=`adlc-fix-${job.slice(0,12)}-${pending.attempt}`;
    const entry=session.transcript.entries.find((x:any)=>x.clientMessageId===handle);
    const turn=entry&&session.transcript.turns.find((x:any)=>x.id===entry.turnId);
    if(!turn||turn.state!=='completed')return this.record(job,{state:'needs_reconciliation',send:false,head:e.head,reason:'Previous remediation delivery is uncertain or incomplete; never resend'});
     this.s.db.query("UPDATE remediation SET state='completed' WHERE job=? AND attempt=?").run(job,pending.attempt);
     if(pending.head===e.head){
      return this.record(job,{state:'blocked',send:false,head:e.head,reason:'Worker completed remediation without a new commit or metadata change; inspect before retry'});
    }
   }
   if(session.transcript.controller!=='ready')return {...d,send:false,reason:'Worker busy; wait',head:e.head};
   const grant=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
   const metadataOnly=e.findings.every((f:any)=>f.kind==='pr_description');
   const operations=metadataOnly?['open-pr']:['commit','push-feature'];
   const j=l.current(job);if(!grant||grant.plan_hash!==j.plan_hash||!operations.every(op=>JSON.parse(grant.operations).includes(op)))throw Error('Current scoped GitHub authorization required');
   await this.io.disableNativeFeedback(run.session_id);
   const result=await this.io.sendPilotRemediation(this.s,job,e.head,JSON.stringify(e.findings),t.repo,t.pr,required,remediationPolicy,metadataChecks);
   if(result.blocked)return this.record(job,{state:'blocked',send:false,head:e.head,reason:result.reason,budget:result.budget});
   return {...d,head:e.head,delivery:result};
  }
  return {...d,head:e.head,send:false,mergeEnabled:false};
 }
}

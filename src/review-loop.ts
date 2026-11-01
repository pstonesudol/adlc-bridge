import {BranchUpdates,type BranchPolicy} from './branch-updates';
import {scopeAllows} from './file-scope';
import {Store,digest} from './core';
import {Lifecycle} from './lifecycle';
import {sessionEvidence} from './session-evidence';
import {readiness} from './github';
import {sendPilotRemediation} from './pilot';
import {disableNativeFeedback} from './ao-policy';
import {validateVerification,type Verification} from './verification';

export function decision(e:any,allowedPaths:string[],waitingMs:number){
 if(e.clear)return {state:'ready_for_human',send:false,reason:'Latest-SHA CI and CodeRabbit gate passed'};
 if(e.failedChecks.length)return {state:'blocked',send:false,reason:'Required CI failed; inspect failure and ticket scope before remediation'};
 if(e.findings.length){
  if(e.findings.some((f:any)=>f.kind!=='pr_description'&&!scopeAllows(f.path,allowedPaths)))return {state:'blocked',send:false,reason:'Review findings exceed approved file scope'};
  return {state:'remediation_pending',send:true,reason:'Actionable latest-SHA CodeRabbit findings'};
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
export class ReviewLoop{
 constructor(public s:Store,public postReview=postFullReview){s.db.exec(`CREATE TABLE IF NOT EXISTS review_targets(
  job TEXT PRIMARY KEY REFERENCES jobs(id),repo TEXT NOT NULL,pr INTEGER NOT NULL,
  required_checks TEXT NOT NULL,allowed_paths TEXT NOT NULL,remediate INTEGER NOT NULL DEFAULT 0,
  head TEXT,state TEXT NOT NULL DEFAULT 'waiting_for_review',reason TEXT,
  head_since INTEGER NOT NULL,last_signature TEXT,updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS remediation_context(job TEXT NOT NULL,attempt INTEGER NOT NULL,kind TEXT NOT NULL,baseline_body_hash TEXT,PRIMARY KEY(job,attempt));
  CREATE TABLE IF NOT EXISTS review_requests(job TEXT NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(job,head,body_hash));
  CREATE TABLE IF NOT EXISTS full_review_requests(job TEXT NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,PRIMARY KEY(job,head,body_hash));
  CREATE TABLE IF NOT EXISTS review_verification(job TEXT PRIMARY KEY REFERENCES jobs(id),configuration TEXT NOT NULL);`);}
 register(job:string,repo:string,pr:number,required:string[],paths:string[],remediate=false,verification?:Verification){
  if(verification)validateVerification(verification);
  const l=new Lifecycle(this.s);l.current(job);if(!l.run(job))throw Error('Existing approved run required');
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1||!required.length||!paths.length||paths.some(p=>p.startsWith('/')||p.split('/').includes('..')))throw Error('Invalid review target');
  const old=this.get(job);if(old){if(old.repo!==repo||old.pr!==pr||old.required_checks!==JSON.stringify(required)||old.allowed_paths!==JSON.stringify(paths)||old.remediate!==Number(remediate))throw Error('Target changed; explicit reconciliation required');this.setVerification(job,verification);return old;}
  this.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head_since) VALUES (?,?,?,?,?,?,?)').run(job,repo,pr,JSON.stringify(required),JSON.stringify(paths),Number(remediate),Date.now());
  this.setVerification(job,verification);
  this.s.event(job,'review_target_registered',JSON.stringify({repo,pr,remediate}));return this.get(job);
 }
 setVerification(job:string,v?:Verification){if(v){validateVerification(v);this.s.db.query('INSERT INTO review_verification VALUES (?,?) ON CONFLICT(job) DO UPDATE SET configuration=excluded.configuration').run(job,JSON.stringify(v));}else this.s.db.query('DELETE FROM review_verification WHERE job=?').run(job);}
 get(job:string):any{return this.s.db.query('SELECT * FROM review_targets WHERE job=?').get(job);}
 list(project?:string){const rows=project?this.s.db.query('SELECT t.job,t.repo,t.pr,t.head,t.state,t.reason,t.remediate,t.updated FROM review_targets t JOIN jobs j ON j.id=t.job WHERE j.project=?').all(project):this.s.db.query('SELECT job,repo,pr,head,state,reason,remediate,updated FROM review_targets').all();return (rows as any[]).map(t=>({...t,displayStatus:reviewDisplay(t.state)}));}
 record(job:string,result:any){
  const signature=digest(JSON.stringify({head:result.head,state:result.state,reason:result.reason}));
  this.s.db.transaction(()=>{
   const t=this.get(job);this.s.db.query('UPDATE review_targets SET state=?,reason=?,last_signature=?,updated=CURRENT_TIMESTAMP WHERE job=?').run(result.state,result.reason,signature,job);
   if(t.last_signature!==signature)this.s.event(job,'review_state_changed',JSON.stringify(result));
  })();return result;
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
 async tick(job:string,branchPolicy?:BranchPolicy){
  const t=this.get(job);if(!t)throw Error('Unknown review target');const l=new Lifecycle(this.s);l.current(job);
  const run=l.run(job);if(!run||run.owner!=='orchestrator'||run.plan_hash!==l.current(job).plan_hash)throw Error('Agent-owned run with current approval required');
  const session=await sessionEvidence(run.session_id);
  if(session.session.isTerminated||!session.session.prs?.some((p:any)=>p.number===t.pr&&p.url===`https://github.com/${t.repo}/pull/${t.pr}`))throw Error('Target/session mismatch');
  const branch=await new BranchUpdates(this.s).ensure(job,t.repo,t.pr,session,branchPolicy);
  if(branch)return this.record(job,branch);
  const e=await readiness(t.repo,t.pr,JSON.parse(t.required_checks));
  if(l.current(job).plan_hash!==run.plan_hash)throw Error('Approval changed during review collection');
  const since=t.head===e.head?t.head_since:Date.now();
  // Request one fresh pass when old review evidence cannot clear an otherwise
  // idle PR. Pending CI and actionable findings must be handled first.
  if(!e.clear&&!e.findings.length&&!e.failedChecks.length&&!e.pendingChecks.length&&!e.missingChecks.length&&!e.coderabbitPending&&e.coderabbitPresent&&t.remediate&&session.transcript.controller==='ready'&&e.reasons.every((r:string)=>r.startsWith('CodeRabbit')||r.startsWith('Explicit latest-SHA'))){
   const requested=await this.requestReview(job,e.head,e.descriptionHash);
   if(requested){
    this.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(e.head,job);
    return this.record(job,{state:'waiting_for_coderabbit',send:false,head:e.head,reason:'Full CodeRabbit review requested for current commit and description'});
   }
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
     const context=this.s.db.query('SELECT * FROM remediation_context WHERE job=? AND attempt=?').get(job,pending.attempt) as any;
     if(context?.kind==='pr_description'&&context.baseline_body_hash!==e.descriptionHash){
      if(!e.coderabbitPending&&!e.pendingChecks.length&&!e.missingChecks.length)await this.requestReview(job,e.head,e.descriptionHash);
      return this.record(job,{state:'waiting_for_coderabbit',send:false,head:e.head,reason:'PR evidence updated; awaiting CodeRabbit reevaluation'});
     }
     return this.record(job,{state:'blocked',send:false,head:e.head,reason:'Worker completed remediation without a new commit or metadata change; inspect before retry'});
    }
   }
   if(session.transcript.controller!=='ready')return {...d,send:false,reason:'Worker busy; wait',head:e.head};
   const grant=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
   const metadataOnly=e.findings.every((f:any)=>f.kind==='pr_description');
   const operations=metadataOnly?['open-pr']:['commit','push-feature'];
   const j=l.current(job);if(!grant||grant.plan_hash!==j.plan_hash||!operations.every(op=>JSON.parse(grant.operations).includes(op)))throw Error('Current scoped GitHub authorization required');
   await disableNativeFeedback(run.session_id);
   const verification=this.s.db.query('SELECT configuration FROM review_verification WHERE job=?').get(job) as any;
   const result=await sendPilotRemediation(this.s,job,e.head,JSON.stringify(e.findings),t.repo,t.pr,JSON.parse(t.required_checks),verification?JSON.parse(verification.configuration):undefined);
   return {...d,head:e.head,delivery:result};
  }
  return {...d,head:e.head,send:false,mergeEnabled:false};
 }
}

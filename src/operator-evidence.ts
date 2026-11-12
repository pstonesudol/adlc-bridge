import {Store,digest} from './core';
import {latestRevision} from './spec-revisions';
import {applicableResolution} from './readiness';

export function redact(text:string){return text.slice(0,16000)
 .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[REDACTED KEY]')
 .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi,'[REDACTED AUTH]')
 .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|lin_api_[A-Za-z0-9_-]+)\b/g,'[REDACTED TOKEN]')
 .replace(/((?:token|password|secret|api[_-]?key|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi,'$1[REDACTED]')
 .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi,'https://[REDACTED]@');}
export function safeOutput<T>(value:T):T{
 if(typeof value==='string')return redact(value) as T;
 if(Array.isArray(value))return value.map(safeOutput) as T;
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/^(?:token|password|secret|authorization|api[_-]?key)$/i.test(k)?'[REDACTED]':safeOutput(v)])) as T;
 return value;
}
export function hasTable(s:Store,name:string){return !!s.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
export function evidenceRows(s:Store,name:string,job:string){return hasTable(s,name)?s.db.query(`SELECT * FROM ${name} WHERE job=? LIMIT 100`).all(job) as any[]:[];}
export type OperatorBlocker={code:string;reason:string;nextAction:string;observedAt:string|number|null;kind:'blocker'|'wait'};
/** Read-only presentation of existing engine outcomes, never a lifecycle engine. */
export function jobBlockers(s:Store,job:string){
 const j=s.get(job),blockers:OperatorBlocker[]=[];
 if(j.state==='done')return {version:digest(JSON.stringify([j.plan_hash,'done'])),primary:null,blockers};
 const add=(code:string,reason:string,nextAction:string,observedAt:any=null,kind:'blocker'|'wait'='blocker')=>blockers.push({code,reason:redact(reason),nextAction,observedAt,kind});
 const inspect=`adlc jobs explain ${job} --project ${j.project}`;
 const revision=latestRevision(s,job);
 if(revision&&!['authorized','preplanning'].includes(revision.state))add('requirements_changed','Requirements changed; previous approval cannot authorize continuation',`adlc spec-reconcile ${job} CONFIG`,revision.created);
 if(j.plan_hash&&j.plan_hash!==digest(JSON.stringify([j.spec,j.plan])))add('stale_plan','Plan does not bind current requirements',`adlc plan-reconcile ${job} CONFIG SEQUENCE`,j.updated);
 if(j.state==='awaiting_approval'||j.state==='approved'&&(j.approved_hash!==j.plan_hash||!j.actor))add('approval_required','Current plan approval unresolved',`adlc jobs show-plan ${job} --project ${j.project}`,j.updated);
 const bound=(table:string)=>evidenceRows(s,table,job).filter(r=>(!r.plan_hash||r.plan_hash===j.plan_hash)&&(!r.plan||r.plan===j.plan_hash));
 for(const r of [...bound('planning_dependency_waits'),...bound('dependency_waits')])if(!['resolved','resumed','settled'].includes(r.state))add('dependency_wait',r.reason??'Dependency evidence unresolved',`adlc jobs dependency-status`,r.updated??null);
 // Reuse the engine's binding validation but suppress its legacy schema setup
 // even when the presentation is called by the writable Linear publisher.
 const inspection=Object.create(s) as Store;inspection.readonly=true;
 const resolved=hasTable(s,'plan_resolutions')?applicableResolution(inspection,job):null;
 for(const r of evidenceRows(s,'plan_readiness',job))if(r.plan_hash===j.plan_hash&&(!r.valid||r.state!=='ready')&&!resolved)add('plan_readiness',r.reason??`Plan readiness: ${r.state}`,`adlc jobs show-plan ${job}`,r.updated??null);
 for(const r of bound('remediation_budget'))if(r.stop_reason)add('budget_exhausted',`Remediation stopped: ${r.stop_reason}; ${r.consumed} consumed; ${r.extensions} extended`,`adlc jobs budget ${job} --project ${j.project}`,r.updated);
 for(const table of ['planning_dispatch','implementation_dispatch','worker_outcomes','startup_recovery_results','delivery_adoptions'])for(const r of bound(table)){
  const state=r.state??r.outcome;
  if(/uncertain|reconciliation|blocked|needs_input|failed/.test(state??''))add(`${table}:${state}`,`${table}: ${state}${r.reason?`; ${r.reason}`:''}`,inspect,r.updated??r.first_observed??r.observed??null);
 }
 for(const r of evidenceRows(s,'recovery_observations',job)){
  let e:any={};try{e=JSON.parse(r.reason??'{}');}catch{}
  const automatic=['throttled','timeout','network','server'].includes(e.classification);
  add('observation',`${e.provider??'Provider'} observation: ${e.classification??'unknown'}; ${r.failures} failed reads`,automatic?'Wait for supervised read-only observation; no mutation replay.':`adlc retry-observation ${job}`,e.timestamp??null,automatic?'wait':'blocker');
 }
 for(const r of evidenceRows(s,'review_targets',job))if(r.state!=='completed')add('review',`Review: ${r.state}${r.reason?`; ${r.reason}`:''}`,`adlc jobs review-status --project ${j.project}`,r.updated??null,/^waiting_for_(ci|coderabbit|review|worker)$/.test(r.state)?'wait':'blocker');
 for(const table of ['delivery_receipts','remediation','continuations','spec_replans','watchdog_actions','branch_maintenance'])for(const r of evidenceRows(s,table,job))if(/uncertain|unknown|exhausted|escalated|blocked|reconciliation/.test(r.state??''))add(`${table}:${r.state}`,`${table}: ${r.state}${r.reason?`; ${r.reason}`:''}`,inspect,r.updated??r.observed_at??r.observed??null);
 for(const r of evidenceRows(s,'runs',job))if(r.owner!=='orchestrator')add('ownership','Job is human-owned or ownership is unresolved; no automatic takeover',inspect,j.updated);
 if(j.state==='blocked'&&j.reason)add('job_blocked',j.reason,inspect,j.updated);
 const unique=[...new Map(blockers.map(b=>[JSON.stringify(b),b])).values()];
 const ownership=['planning_runs','implementation_dispatch','git_grants','policy_authorizations','runs'].map(t=>evidenceRows(s,t,job));
 const version=digest(JSON.stringify([j.plan_hash,digest(j.spec),j.state,j.approved_hash,j.actor,revision?.id??null,ownership,unique]));
 return {version,primary:unique.find(b=>b.kind==='blocker')??unique[0]??null,blockers:unique};
}
export function blockerText(report:ReturnType<typeof jobBlockers>){return report.blockers.map(b=>`- ${b.code}: ${b.reason}\n  Evidence: ${b.observedAt??'unknown'}; Next: ${b.nextAction}`).join('\n');}
export function jobEvents(s:Store,job:string,after=0){
 // Event payloads may be arbitrary source, PR text or credentials. Metadata is
 // the supported scoped log; raw detail never leaves the diagnostics boundary.
 return (s.db.query('SELECT seq,kind,at FROM events WHERE job=? AND seq>? ORDER BY seq LIMIT 200').all(job,after) as any[]).map(r=>({...r,kind:/^[a-z0-9_-]{1,100}$/i.test(r.kind)?r.kind:'unrecognized_event',detail:'omitted (private payload)'}));
}

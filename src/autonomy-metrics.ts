import {existsSync} from 'node:fs';
import {Store,digest} from './core';
import {OperatorError} from './operator-cli';

const DAY=86400000,MAX_JOBS=1000,MAX_EVENTS=50000;
const rescue=new Set(['operator_read_retry','operator_shared_cooldown_override','review_recovery_requested','human_control_taken','remediation_budget_extended','legacy_remediation_budget_resumed','conflict_operator_reconciliation','published_git_reconciled','remediation_receipt_confirmed','delivery_adoption_reserved']);
const expected=new Set(['human_plan_approval_recorded','plan_readiness_acknowledged']);
const neutral=new Set(['ingested','plan_proposed','standing_policy_plan_authorized','orchestrator_planning_reserved','orchestrator_planning_provisioned','git_scope_recorded','plan_and_git_scope_approved','review_target_registered','automatic_planning_dispatched','dispatch_reserved','session_receipt','supervised_existing_session_adopted','remediation_policy_observed','implementation_delivery_accepted','continuation_reserved','continuation_delivery_accepted','coderabbit_full_review_requested','delivery_identity_adopted','run_reconciled']);
const states=new Set(['ready_for_human','waiting_for_ci','waiting_for_coderabbit','waiting_for_review','waiting_for_worker','remediation_pending','needs_reconciliation','blocked','updating_branch','completed']);
type Options={since?:string;until?:string;project?:string};
export function metricsWindow(options:Options,now=Date.now()){
 const parse=(value:string|undefined,fallback:number)=>{if(value===undefined)return fallback;if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(Date.parse(value)).toISOString().replace('.000Z','Z')!==value.replace('.000Z','Z'))throw new OperatorError('Dates require valid UTC ISO timestamps');return Date.parse(value);};
 const until=parse(options.until,now),since=parse(options.since,until-30*DAY);
 if(since>=until||until>now||until-since>366*DAY)throw new OperatorError('Use a past half-open window of at most 366 days: --since < --until <= now');
 return {since,until};
}
const details=(text:string)=>{try{return JSON.parse(text);}catch{return null;}};
/** Pure bounded projection. Never constructs writable module stores or providers. */
export function projectMetrics(s:Store,options:Options={},now=Date.now()){
 const window=metricsWindow(options,now),has=s.db.query("SELECT name FROM sqlite_master WHERE name='event_provenance'").get();
 const time=has?'COALESCE(p.event_ms,ROUND((julianday(e.at)-2440587.5)*86400000))':'ROUND((julianday(e.at)-2440587.5)*86400000)';
 const join=has?'LEFT JOIN event_provenance p ON p.seq=e.seq':'';
 const jobs=s.db.query(`SELECT j.id,j.project,j.state,MIN(${time}) AS started FROM jobs j JOIN events e ON e.job=j.id ${join} WHERE (? IS NULL OR j.project=?) AND e.kind='ingested' GROUP BY j.id HAVING started>=? AND started<? ORDER BY started,j.id LIMIT ?`).all(options.project??null,options.project??null,window.since,window.until,MAX_JOBS+1) as any[];
 if(jobs.length>MAX_JOBS)throw new OperatorError('Metrics job bound exceeded; narrow date/project filters',1);
 let remaining=MAX_EVENTS;
 const rows=jobs.map(job=>{
  const events=s.db.query(`SELECT e.seq,e.kind,e.detail,${time} AS ms,${has?'p.runtime_version,p.attempt,p.plan_hash,p.detail_hash':'NULL AS runtime_version,NULL AS attempt,NULL AS plan_hash,NULL AS detail_hash'} FROM events e ${join} WHERE e.job=? AND ${time}<? ORDER BY e.seq LIMIT ?`).all(job.id,window.until,remaining+1) as any[];
  remaining-=events.length;if(remaining<0)throw new OperatorError('Metrics event bound exceeded; narrow date/project filters',1);
  let interventions=0,humanActions=0,unknownEvents=0,missingProvenance=0,handoff:any=null,review:any=null,provider:any=null;
  const retryKeys=new Set<string>();
  const versions=new Set<string>(),blockedMs:Record<string,number>={},retries:Record<string,number>={},recoveries:{outcome:string;durationMs:number;cause:string;startSeq:number;endSeq:number|null}[]=[],provenance:any[]=[];
  const elapsed=(start:number,end:number)=>Math.max(0,end-start);
  const add=(cause:string,start:number,end:number)=>{blockedMs[cause]=(blockedMs[cause]??0)+elapsed(start,end);};
  const closeProvider=(e:any,outcome:string)=>{if(!provider)return;if(!provider.failed)recoveries.push({outcome,durationMs:elapsed(provider.ms,e.ms),cause:provider.cause,startSeq:provider.seq,endSeq:e.seq});add('external_provider',provider.ms,e.ms);provider=null;};
  for(const e of events){
   const valid=typeof e.runtime_version==='string'&&/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(e.runtime_version)&&Number.isSafeInteger(e.attempt)&&e.attempt>=0&&Number.isFinite(e.ms)&&e.detail_hash===digest(e.detail);
   if(!valid){missingProvenance++;continue;}
   versions.add(e.runtime_version);
   // Emit only allowlisted measurement types, never raw detail/kind/actor text.
   let category='unknown';const d=details(e.detail);
   if(rescue.has(e.kind)){interventions++;category='operator_rescue';closeProvider(e,'operator_interrupted');}
   else if(expected.has(e.kind)){humanActions++;category='expected_human_action';}
   else if(e.kind==='plan_readiness_resolved'&&['human-answer','dependency-satisfied'].includes(d?.source)){category=d.source==='human-answer'?'expected_human_action':'lifecycle';if(d.source==='human-answer')humanActions++;}
   else if(neutral.has(e.kind)||e.kind==='review_binding_observed')category='lifecycle';
   else if(e.kind==='linear_status_changed'&&['done','in-review','in-progress'].includes(d?.phase))category='lifecycle';
   else if(e.kind==='provider_observation_failed'){
    const cause=['throttled','timeout','network','server','authentication','permission','missing','malformed','unknown'].includes(d?.classification)?d.classification:'unknown';
    category='provider_retry';retries[cause]=(retries[cause]??0)+1;if(!provider)provider={seq:e.seq,ms:e.ms,cause};
    if(!['throttled','timeout','network','server'].includes(cause)&&!provider.failed){recoveries.push({outcome:'failure',durationMs:elapsed(provider.ms,e.ms),cause,startSeq:provider.seq,endSeq:e.seq});provider.failed=true;}
   }else if(e.kind==='provider_observation_recovered'){category='automatic_recovery';closeProvider(e,'success');}
   else if(e.kind==='provider_observation_invalidated'){category='recovery_invalidated';closeProvider(e,'invalidated');}
   else if(e.kind==='remediation_reserved'&&Number.isSafeInteger(d?.attempt)&&d.attempt>0){category='worker_retry';const key=`${e.plan_hash}:${d.attempt}`;if(!retryKeys.has(key)){retryKeys.add(key);retries.worker_remediation=(retries.worker_remediation??0)+1;}}
   else if(e.kind==='review_state_changed'&&states.has(d?.state)){
    category='review';
    if(review)add(review.cause,review.ms,e.ms);
    review=null;
    if(d.state==='ready_for_human'&&typeof d.head==='string'&&/^[a-f0-9]{40,64}$/.test(d.head)){if(!handoff)handoff={seq:e.seq,ms:e.ms,head:d.head,attempt:e.attempt,interventions};}
    else if(d.state!=='completed')review={ms:e.ms,cause:['waiting_for_ci','waiting_for_coderabbit','waiting_for_review'].includes(d.state)?'external_review_or_ci':d.state==='needs_reconciliation'?'delivery_uncertainty':d.state==='blocked'?'unclassified_blocker':'orchestration_work'};
   }
   if(category==='unknown')unknownEvents++;
   else provenance.push({seq:e.seq,at:new Date(e.ms).toISOString(),runtimeVersion:e.runtime_version,attempt:e.attempt,planHash:e.plan_hash,category});
  }
  if(review)add(review.cause,review.ms,window.until);
  if(provider){add('external_provider',provider.ms,window.until);if(!provider.failed)recoveries.push({outcome:'censored',durationMs:elapsed(provider.ms,window.until),cause:provider.cause,startSeq:provider.seq,endSeq:null});}
  const complete=events.length>0&&missingProvenance===0&&unknownEvents===0;
  const version=versions.size===1?[...versions][0]:versions.size?'mixed':'unknown';
  const status=handoff?'reviewed_pr_handoff':job.state==='done'?'closed_without_handoff_evidence':'in_flight';
  return {job:job.id,project:job.project,runtimeVersion:version,status,censored:!handoff,interventions,humanActions,missingProvenance,unknownEvents,coverage:complete?'instrumented_events':'incomplete',handoff,blockedMs,retries,recoveries,provenance,
   current:{state:job.state,blocker:provider?'external_provider':review?.cause??(job.state==='blocked'?'unclassified_blocker':null),nextAction:`adlc jobs status ${job.id} --project ${job.project}`,evidenceAt:events.length?new Date(events.at(-1).ms).toISOString():null,evidenceAgeMs:events.length?elapsed(events.at(-1).ms,now):null,freshness:'persisted_only',note:'Historical window evidence; current job state is a present-day snapshot, not a live provider refresh.'}};
 });
 const summary=(group:typeof rows)=>{
  const eligible=group.filter(j=>j.coverage==='instrumented_events'),handoffs=eligible.filter(j=>j.handoff),withoutRescue=handoffs.filter(j=>j.handoff.interventions===0),recoveries=group.flatMap(j=>j.recoveries),successes=recoveries.filter(r=>r.outcome==='success');
  const sumMap=(field:'blockedMs'|'retries')=>{const totals:Record<string,number>={};for(const j of group)for(const [key,n] of Object.entries(j[field]))totals[key]=(totals[key]??0)+n;return totals;};
  return {jobs:group.length,eligible:eligible.length,incomplete:group.length-eligible.length,censored:group.filter(j=>j.censored).length,reviewedHandoffs:handoffs.length,handoffsWithoutRecordedRescue:withoutRescue.length,proportion:eligible.length?withoutRescue.length/eligible.length:null,interventions:group.reduce((n,j)=>n+j.interventions,0),interventionsPerJob:group.length?group.reduce((n,j)=>n+j.interventions,0)/group.length:null,blockedMs:sumMap('blockedMs'),retries:sumMap('retries'),automaticRecovery:{scope:'provider observations only',success:successes.length,failure:recoveries.filter(r=>r.outcome==='failure').length,censored:recoveries.filter(r=>r.outcome==='censored').length,invalidated:recoveries.filter(r=>r.outcome==='invalidated').length,operatorInterrupted:recoveries.filter(r=>r.outcome==='operator_interrupted').length,meanTimeToRecoveryMs:successes.length?successes.reduce((n,r)=>n+r.durationMs,0)/successes.length:null}};
 };
 return {schemaVersion:1,readOnly:true,window:{since:new Date(window.since).toISOString(),until:new Date(window.until).toISOString(),cohort:'jobs ingested in [since, until); observed through until'},summary:summary(rows),versions:[...new Set(rows.map(j=>j.runtimeVersion))].sort().map(version=>({version,...summary(rows.filter(j=>j.runtimeVersion===version))})),jobs:rows,
  limitations:['Observed bridge events only: out-of-band operator actions are not observable; zero recorded rescue is not proof of universal autonomy.','Unknown events and missing or mismatched provenance exclude a job from the proportion; counts remain observed lower bounds.','Runtime version is the emitting package version, not a verified Git commit or running backend identity; mixed versions are not attributed to one release.','Blocked durations are separate overlapping dimensions, not additive wall time. Open waits/recoveries are censored at until.','Baseline is this bounded cohort; version comparisons are descriptive, include sample sizes, and establish no causation. No live baseline was collected.']};
}
export function autonomyMetrics(path:string,options:Options={},now=Date.now()){
 metricsWindow(options,now);
 if(!existsSync(path))return {schemaVersion:1,readOnly:true,summary:{jobs:0,proportion:null},jobs:[],versions:[],limitations:['No persisted database; no evidence or baseline.']};
 const s=Store.readonly(path);try{return s.db.transaction(()=>projectMetrics(s,options,now))();}finally{s.close();}
}
export function humanMetrics(report:ReturnType<typeof autonomyMetrics>){return `Autonomy evidence (read-only)\nJobs: ${report.summary.jobs}; handoff without recorded rescue proportion: ${report.summary.proportion===null?'unknown':report.summary.proportion}\n${report.jobs.map(j=>`${j.job}: ${j.status}; coverage ${j.coverage}; interventions ${j.interventions}\n  Blocker: ${j.current.blocker??'none observed'}; evidence: ${j.current.freshness}, age ${j.current.evidenceAgeMs??'unknown'}ms\n  Next: ${j.current.nextAction}`).join('\n')}\n${report.limitations.join('\n')}`;}

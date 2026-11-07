import {existsSync} from 'node:fs';
import {Store} from './core';
import {actionStatus} from './action-watchdog';
export class OperatorError extends Error {
 constructor(message:string,public code=2,public candidates:unknown[]=[]){super(message);}
}
export const groups:Record<string,Record<string,string>>={
 projects:{list:'projects',show:'@project',setup:'setup',init:'init','bind-controller':'bind-controller'},
 config:{show:'@config',get:'@config',set:'@config',validate:'@config',diff:'@config',reset:'@config'},
 queue:{list:'@queue'},auth:{status:'@auth'},
 jobs:{list:'@list',show:'@status',status:'@status',lookup:'@lookup','show-plan':'show-plan',approvals:'approvals',approve:'approve-job',recover:'recover',cleanup:'cleanup',resume:'resume-job','dependency-status':'dependency-status','review-status':'review-status'},
 routing:{show:'routing',preview:'routing'},
 services:{list:'projects',status:'service-status',start:'start',stop:'stop',restart:'restart',config:'service-config'},
 diagnostics:{doctor:'doctor',readiness:'readiness','runtime-check':'runtime-check','ao-status':'ao-status'},
};
export function operatorHelp(group?:string){
 return `ADLC operator CLI\n${Object.entries(groups).filter(([name])=>!group||name===group).map(([name,verbs])=>`  ${name} ${Object.keys(verbs).join(' | ')}`).join('\n')}\n  status --project PROJECT [--json]\n  doctor --project PROJECT [--json]\n  version [--json] | completion bash|zsh|fish\n  config set KEY VALUE | reset KEY --project PROJECT [--apply]\n  jobs list [--state STATE] [--project PROJECT]\n  help [GROUP] | COMMAND --help\nJobs accept JOB or TICKET, with --project PROJECT for ambiguity.\nProject selection uses registered Orchestrator project IDs; jobs also accept stored Linear project IDs.\nGrouped commands support --json; legacy flat commands retain their output.\nInspection never dispatches workers or activates configuration.\nmaxPlanning controls concurrent planning only, not implementation/review workers.\nInstallation: install / install-runtime (preview unless --apply).\nLifecycle: services start|stop|restart|status [PROJECT|--project PROJECT|--all] [--json]\n  stop [--pause|--drain|--workers] [--timeout SECONDS] [--temporary|--disable-login]\n  restart [--drain|--workers] [--timeout SECONDS]\n  stop --all, stop --drain/--workers, and restart preview unless --apply --confirm HASH.\n  --preview never changes services. Project stop pauses intake only by default.\n  All-stack stop disables login startup by default; --temporary unloads this login only.\n  Start/restart never automatically resumes exited workers or replays uncertain deliveries.\nPlanned, unavailable integrations: DEV-35 detailed jobs; DEV-34/33 independent routing; DEV-51 update/rollback; DEV-55 dependency reevaluation.\nSource updates: operator-managed; no implicit fetch/update/install.\nExit codes: 0 success, 1 operational failure/incomplete evidence, 2 usage, 3 not found, 4 ambiguous.\nLegacy command reference follows:\n`;
}
function rows(path:string){
 if(!existsSync(path))return [];
 const s=Store.readonly(path);
 try{return s.db.query('SELECT * FROM jobs ORDER BY project,id').all() as any[];}finally{s.close();}
}
export function resolveJob(path:string,reference:string,project?:string){
 const available=rows(path).filter(j=>!project||j.project===project);
 const exact=available.find(j=>j.id===reference);if(exact)return exact.id;
 const matches=available.filter(j=>{
  let identifier='';try{identifier=JSON.parse(j.spec).identifier??'';}catch{}
  return (!project||j.project===project)&&(j.id===reference||j.issue===reference||typeof identifier==='string'&&identifier.toUpperCase()===reference.toUpperCase());
 });
 const candidates=matches.map(j=>({job:j.id,project:j.project,issue:j.issue}));
 if(!matches.length)throw new OperatorError(`No job matches ${reference}. Use jobs list.`,3);
 if(matches.length!==1)throw new OperatorError(`Ambiguous job ${reference}. Select --project PROJECT or use an exact job ID.`,4,candidates);
 return matches[0].id;
}
export function jobViews(path:string,project?:string,reference?:string){
 const id=reference?resolveJob(path,reference,project):undefined;
 if(!existsSync(path))return [];
 const s=Store.readonly(path);
 try{
  const table=(name:string,job:string)=>s.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)?s.db.query(`SELECT * FROM ${name} WHERE job=?`).get(job) as any:null;
  return rows(path).filter(j=>(!project||j.project===project)&&(!id||j.id===id)).map(j=>{
    const planning=table('planning_dispatch',j.id),implementation=table('implementation_dispatch',j.id),outcome=table('worker_outcomes',j.id),wait=table('dependency_waits',j.id),observation=table('recovery_observations',j.id);
   const currentOutcome=outcome?.plan_hash===j.plan_hash&&!(wait?.plan===j.plan_hash&&wait.state==='resumed')?outcome:null;
   const dependency=wait?.plan===j.plan_hash&&wait.state==='waiting_for_dependencies'?wait:null;
   const state=j.state==='done'?'complete':j.state==='blocked'?'blocked':dependency||currentOutcome?.outcome==='blocked_dependency'?'dependency_wait':currentOutcome&&['needs_input','failed','uncertain','needs_reconciliation'].includes(currentOutcome.outcome)?'blocked':j.state==='awaiting_approval'?'approval_wait':j.state==='awaiting_plan'&&!planning?'awaiting_plan':'working';
   let ticket=null;try{ticket=JSON.parse(j.spec).identifier??null;}catch{}
    let readError=null;try{readError=JSON.parse(observation?.reason??'null');}catch{}
    const automatic=!readError||['throttled','timeout','network','server'].includes(readError.classification),activeObservation=observation&&state==='working'&&j.state==='approved'&&j.approved_hash===j.plan_hash;
    return {job:j.id,project:j.project,issue:j.issue,ticket,state:activeObservation?(automatic?'observation_wait':'blocked'):state,orchestrationState:j.state,observation:observation?{failures:observation.failures,nextRetry:activeObservation&&automatic?observation.next_read:null,error:readError,evidenceAgeMs:readError?.timestamp?Math.max(0,Date.now()-readError.timestamp):null}:null,
     reason:activeObservation?`${readError?.provider??'unknown'} read observation: ${readError?.classification??'legacy unknown cause'}; other persisted blockers remain applicable`:j.reason??dependency?.reason??currentOutcome?.reason??`Persisted job state: ${j.state}`,
     nextAction:activeObservation?(automatic?'Wait for a supervised observation probe; inspect review-status for cooldown.':`Inspect provider access/configuration locally, then adlc retry-observation ${j.id}; do not replay mutations.`):state==='awaiting_plan'?'Inspect queue list for eligibility and planning capacity; no worker has been dispatched.':state==='complete'?'No job action required; merging remains human-only.':state==='approval_wait'?`adlc jobs show-plan ${j.id}`:state==='dependency_wait'?'adlc jobs dependency-status':state==='blocked'?`adlc jobs recover ${j.id}`:'Inspect existing worker in Agent Orchestrator; inspection does not dispatch.',
     watchdog:actionStatus(s,j.id),
     worker:{activity:'unknown',session:implementation?.session_id??planning?.session_id??null,dispatchState:implementation?.state??planning?.state??null,outcome:currentOutcome?.outcome??null},
    evidence:{freshness:'unknown',persistedUpdatedAt:j.updated,note:'Persisted state only; no live worker or provider refresh performed.'}};
  });
 }finally{s.close();}
}
export function humanJobs(jobs:any[]){return jobs.length?jobs.map(j=>`${j.ticket??j.issue} [${j.project}] ${j.job}\n  ${j.state} (orchestration: ${j.orchestrationState}; worker: ${j.worker.activity})\n  Reason: ${j.reason}\n  Evidence: ${j.evidence.freshness}; persisted ${j.evidence.persistedUpdatedAt}\n  Next: ${j.nextAction}${j.watchdog?`\n  Watchdog: ${j.watchdog.nextAction}; due ${j.watchdog.dueAt===null?'none':new Date(j.watchdog.dueAt).toISOString()}; observations ${j.watchdog.attempts}/${j.watchdog.maxAttempts}; ${j.watchdog.reason}${j.watchdog.liveness?`\n  Worker liveness: ${j.watchdog.liveness.classification}; recovery attempts ${j.watchdog.liveness.recoveryAttempts}; persisted-only`:''}`:''}`).join('\n'):'No jobs found.';}

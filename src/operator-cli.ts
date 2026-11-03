import {existsSync} from 'node:fs';
import {Store} from './core';
export class OperatorError extends Error {
 constructor(message:string,public code=2,public candidates:unknown[]=[]){super(message);}
}
export const groups:Record<string,Record<string,string>>={
 projects:{list:'projects',setup:'setup',init:'init','bind-controller':'bind-controller'},
 jobs:{list:'@list',status:'@status',lookup:'@lookup','show-plan':'show-plan',approvals:'approvals',approve:'approve-job',recover:'recover',cleanup:'cleanup',resume:'resume-job','dependency-status':'dependency-status','review-status':'review-status'},
 routing:{show:'routing',preview:'routing'},
 services:{list:'projects',status:'service-status',start:'start',stop:'stop',config:'service-config'},
 diagnostics:{doctor:'doctor',readiness:'readiness','runtime-check':'runtime-check','ao-status':'ao-status'},
};
export function operatorHelp(group?:string){
 return `ADLC operator CLI\n${Object.entries(groups).filter(([name])=>!group||name===group).map(([name,verbs])=>`  ${name} ${Object.keys(verbs).join(' | ')}`).join('\n')}\n  help [GROUP] | COMMAND --help\nJobs accept JOB or TICKET, with --project PROJECT for ambiguity.\nGrouped commands support --json; legacy flat commands retain their output.\nInspection never dispatches workers or activates configuration.\nInstallation: install / install-runtime (preview unless --apply).\nSource updates: operator-managed; no implicit fetch/update/install.\nExit codes: 0 success, 1 operational failure, 2 usage, 3 not found, 4 ambiguous.\nLegacy command reference follows:\n`;
}
function rows(path:string){
 if(!existsSync(path))return [];
 const s=Store.readonly(path);
 try{return s.db.query('SELECT * FROM jobs ORDER BY project,id').all() as any[];}finally{s.close();}
}
export function resolveJob(path:string,reference:string,project?:string){
 const matches=rows(path).filter(j=>{
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
   const planning=table('planning_dispatch',j.id),implementation=table('implementation_dispatch',j.id),outcome=table('worker_outcomes',j.id),wait=table('dependency_waits',j.id);
   const currentOutcome=outcome?.plan_hash===j.plan_hash?outcome:null;
   const dependency=wait?.plan===j.plan_hash&&wait.state==='waiting_for_dependencies'?wait:null;
   const state=j.state==='done'?'complete':j.state==='blocked'?'blocked':dependency||currentOutcome?.outcome==='blocked_dependency'?'dependency_wait':currentOutcome&&['needs_input','failed','uncertain','needs_reconciliation'].includes(currentOutcome.outcome)?'blocked':j.state==='awaiting_approval'?'approval_wait':'working';
   let ticket=null;try{ticket=JSON.parse(j.spec).identifier??null;}catch{}
   return {job:j.id,project:j.project,issue:j.issue,ticket,state,orchestrationState:j.state,
    reason:j.reason??dependency?.reason??currentOutcome?.reason??`Persisted job state: ${j.state}`,
    nextAction:state==='complete'?'No job action required; merging remains human-only.':state==='approval_wait'?`adlc jobs show-plan ${j.id}`:state==='dependency_wait'?'adlc jobs dependency-status':state==='blocked'?`adlc jobs recover ${j.id}`:'Inspect existing worker in Agent Orchestrator; inspection does not dispatch.',
    worker:{activity:'unknown',session:implementation?.session_id??planning?.session_id??null,dispatchState:implementation?.state??planning?.state??null,outcome:currentOutcome?.outcome??null},
    evidence:{freshness:'unknown',persistedUpdatedAt:j.updated,note:'Persisted state only; no live worker or provider refresh performed.'}};
  });
 }finally{s.close();}
}
export function humanJobs(jobs:any[]){return jobs.length?jobs.map(j=>`${j.ticket??j.issue} [${j.project}] ${j.job}\n  ${j.state} (orchestration: ${j.orchestrationState}; worker: ${j.worker.activity})\n  Reason: ${j.reason}\n  Evidence: ${j.evidence.freshness}; persisted ${j.evidence.persistedUpdatedAt}\n  Next: ${j.nextAction}`).join('\n'):'No jobs found.';}

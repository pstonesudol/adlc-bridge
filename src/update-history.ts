import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

export const UPDATE_HISTORY_HELP='adlc update history [--project PROJECT] [--json]';
export type HistoryEvidence={
 operation:'apply'|'rollback';candidateSnapshot:string|null;sourceCommit:string|null;
 backendRestart?:'not-required'|'completed';health?:'passed'|'failed';
 migration?:'not-required'|'compatibility-verified';rollbackSafe?:boolean;databaseBaseline?:boolean;
 installedSnapshot?:string;restoredSnapshot?:string;
 deferredReason?:'activity-unknown'|'workers-busy'|'reattachment-unverified';
};
export type HistoryTransition={stage:string;at:string};
export type RetainedIntent={attemptId?:string;evidence?:HistoryEvidence;transitions?:HistoryTransition[];history?:unknown[];historyVersion?:1};

export function parseHistoryArgs(args:string[]){
 let project:string|undefined,json=false;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--json'&&!json){json=true;continue;}
  if(args[i]==='--project'&&project===undefined&&args[i+1]&&!args[i+1].startsWith('-')){project=args[++i];continue;}
  throw Error(`Use ${UPDATE_HISTORY_HELP}`);
 }
 return {project,json};
}
const stages=new Set(['staged','stopping','quiesced','installing','starting','verifying','completed','deferred','rolled-back','failed','operator-action-required']);
const terminal=new Set(['completed','deferred','rolled-back','failed','operator-action-required']);
const timestamp=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
// Identities are opaque hashes, never paths or free-form service/error text.
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8,64}$/i.test(v)?v:null;
const commit=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{40}$/i.test(v)?v:null;
const projectName=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)?v:null;
const stageName=(v:unknown)=>typeof v==='string'&&stages.has(v)?v:'unknown';
function projectEntry(raw:any){
 const modern=raw?.historyVersion===1&&typeof raw.attemptId==='string',e=modern?raw.evidence:undefined;
 const stage=stageName(raw?.stage),isTerminal=modern&&terminal.has(stage);
 const projects=Array.isArray(raw?.priorServices)?[...new Set(raw.priorServices.map((s:any)=>projectName(s?.project)).filter(Boolean))] as string[]:[];
 const scopeKnown=modern&&Array.isArray(raw?.priorServices)&&raw.transitions?.some((t:any)=>t.stage==='stopping')&&raw.priorServices.every((s:any)=>projectName(s?.project));
 const deferredReason=e?.deferredReason==='activity-unknown'?'Worker activity is unknown; activation deferred.':e?.deferredReason==='workers-busy'?'Workers are busy; activation deferred until idle.':e?.deferredReason==='reattachment-unverified'?'Controller reattachment safety is unverified; backend restart deferred.':'Activation deferred; idle or reattachment safety was not proven.';
 const reason=stage==='deferred'?deferredReason:stage==='operator-action-required'?'Partial or ambiguous operation; explicit operator recovery required.':stage==='failed'?'Operation failed; inspect protected local evidence.':stage==='rolled-back'?'Prior snapshot restored; this does not prove running identities.':!isTerminal?'Completion evidence is missing; outcome is unknown.':null;
 const rollbackReason=!modern?'Legacy compatibility evidence is missing.':stage==='rolled-back'?'Rollback consumed; no further rollback authorized by this attempt.':stage!=='completed'?'No completed activation in this attempt.':e?.rollbackSafe===false?'Migration compatibility or database baseline prohibits rollback.':e?.rollbackSafe!==true?'Rollback compatibility is unknown.':'Recorded compatible only; current snapshot, database, activity and reattachment guards must be rechecked by update-rollback.';
 return {
  attemptId:modern&&/^[a-f0-9-]{36}$/.test(raw.attemptId)?raw.attemptId:null,
  evidence:modern?'retained':'legacy-partial',operation:e?.operation==='apply'||e?.operation==='rollback'?e.operation:'unknown',
  sourceCommit:modern?commit(e?.sourceCommit):null,candidateSnapshot:hash(e?.candidateSnapshot),previousSnapshot:hash(raw?.fromVersion),
  installedSnapshot:hash(e?.installedSnapshot),restoredSnapshot:hash(e?.restoredSnapshot),
  initiatedAt:timestamp(raw?.startedAt),completedAt:isTerminal?timestamp(raw?.updatedAt):null,
  stage,outcome:isTerminal?stage:'unknown',reason,
  states:{staged:modern?'recorded':'unknown',installed:modern&&raw?.installed===true?'recorded':'unknown',running:'unknown'},
  running:{bridgeIdentity:null,backendIdentity:null,reason:'No durable running-version identity evidence; installation and launcher changes are not proof.'},
  bridgeRestart:'unknown',backendRestart:e?.backendRestart==='completed'||e?.backendRestart==='not-required'?e.backendRestart:'unknown',
  migration:e?.migration==='not-required'?'not-required':e?.migration==='compatibility-verified'?'compatibility-verified-execution-unknown':'unknown',
  health:e?.health==='passed'||e?.health==='failed'?e.health:'unknown',
  healthScope:e?.operation==='apply'?'Backend readiness and previously enabled coordination services; not running identities.':e?.operation==='rollback'?'Backend readiness; not running identities or end-to-end verification.':'unknown',
  rollback:{recordedCompatible:modern&&typeof e?.rollbackSafe==='boolean'?e.rollbackSafe:null,currentAvailability:'unknown',reason:rollbackReason},
  scope:{sharedRuntime:true,projects,projectsKnown:!!scopeKnown},
  transitions:modern&&Array.isArray(raw.transitions)?raw.transitions.map((t:any)=>({stage:stageName(t?.stage),at:timestamp(t?.at)})):[]
 };
}

/** Read only: no mkdir, state migration, lock, provider calls, or live service observations. */
export function readUpdateHistory(state:string,project?:string){
 const base={version:1,project:project===undefined?null:projectName(project),scope:'Shared runtime operations affect all coordination projects. A project filter never hides shared operations; recorded projects describe observed impact, not exclusive ownership.',nextCommands:['adlc update-status','adlc update-preview'],entries:[] as ReturnType<typeof projectEntry>[]};
 const path=join(state,'update-intent.json');
 try{
  if(!existsSync(path))return {...base,history:'unknown',reason:'No durable update history exists. Legacy success must not be inferred.'};
  const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('unsafe');
  const bytes=readFileSync(path,'utf8'),raw=JSON.parse(bytes);
  if(!raw||raw.version!==1||typeof raw.stage!=='string'||(raw.historyVersion!==undefined&&raw.historyVersion!==1)||(raw.historyVersion===1&&(!Array.isArray(raw.history)||!Array.isArray(raw.transitions))))throw Error('invalid');
  const entries=[...(raw.history??[]),raw].map(projectEntry).map(entry=>({...entry,projectMatch:project===undefined?'not-filtered':entry.scope.projects.includes(project)?'recorded':'shared-impact-or-unknown'}));
  // Atomic writers can replace this file while it is being read. Do not present mixed evidence.
  if(readFileSync(path,'utf8')!==bytes)return {...base,history:'unknown',reason:'Update history changed during inspection; repeat this read-only command.'};
  return {...base,entries,history:raw.historyVersion===1?'retained-with-possible-legacy-gaps':'legacy-partial',reason:'History begins with retained evidence; earlier overwritten attempts and missing observations remain unknown.'};
 }catch{return {...base,history:'unknown',reason:'Durable update history is invalid, unavailable or unsafe to read; inspect protected local evidence. No state was changed.'};}
}
export function formatUpdateHistory(result:ReturnType<typeof readUpdateHistory>){
 return [`Update history: ${result.history}`,result.reason,result.scope,...result.entries.map(e=>JSON.stringify(e)),`Next commands (inspection/staging only, never executed here): ${result.nextCommands.join('; ')}. Rollback requires explicit adlc update-rollback and fresh compatibility guards; history does not authorize it.`].join('\n');
}

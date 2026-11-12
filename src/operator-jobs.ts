import {existsSync,lstatSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Store,digest} from './core';
import {jobViews,OperatorError,humanJobs} from './operator-cli';
import {blockerText,evidenceRows,jobEvents,safeOutput} from './operator-evidence';
import {sessionEvidence} from './session-evidence';
import {appState} from './install-state';
import {atomicFile} from './atomic-file';

export async function explainJob(path:string,project:string|undefined,reference:string,read:typeof sessionEvidence=id=>sessionEvidence(id,Bun.spawn,10000)){
 const view=jobViews(path,project,reference)[0];
 const s=Store.readonly(path);let reservation:any;
 try{reservation=evidenceRows(s,'planning_runs',view.job)[0];}finally{s.close();}
 if(!view.worker.session||!reservation){return {...view,unknowns:['No bound session/reservation; worker activity cannot be established.']};}
 try{
  const e=await read(view.worker.session),x=e.session,turns=e.transcript?.turns;
  if(x.id!==view.worker.session||x.projectId!==reservation.project||x.branch!==reservation.branch||!Array.isArray(turns))throw Error('identity');
  const active=turns.filter((t:any)=>!['completed','recovered','interrupted','failed','cancelled'].includes(t.state));
  const activity=x.activity?.state==='exited'?'exited':active.some((t:any)=>t.state==='running')?'running':active.some((t:any)=>t.state==='queued')?'queued':!active.length&&x.activity?.state==='idle'?'idle':'unknown';
  return {...view,worker:{...view.worker,activity,controller:e.transcript.controller??'unknown',observedAt:e.receiptObservation?.observed??null},unknowns:['CI/review/host delivery evidence remains persisted-only; worker activity does not clear blockers.']};
 }catch{return {...view,unknowns:['Authoritative worker read unavailable, incomplete or identity changed; no continuation is authorized.']};}
}
export function explainText(view:any){return `${humanJobs([view])}\nPhase: ${view.phase}; observed worker activity: ${view.worker.activity}\n${blockerText(view)}\n${(view.unknowns??[]).map((x:string)=>`Unknown: ${x}`).join('\n')}`;}
export async function watchJob(read:()=>Promise<any>,emit:(value:any)=>void,signal:AbortSignal,options:{sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;maxPolls?:number}={}){
 const sleep=options.sleep??((ms,signal)=>new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();}));
 let previous='',delay=1000;
 for(let poll=0;poll<(options.maxPolls??180)&&!signal.aborted;poll++){
  const value=await read();if(signal.aborted)break;
  // Exclude wall-clock age and observation timestamps from transition identity.
  const key=JSON.stringify([value.version,value.state,value.worker?.activity,value.worker?.controller,value.worker?.dispatchState,value.review?.state,value.review?.head,value.unknowns,value.log?.cursor??value.log?.events?.at(-1)?.seq]);
  if(key!==previous){emit(value);previous=key;delay=1000;}else delay=Math.min(10000,delay*2);
  if(value.state==='complete')break;
  await sleep(delay,signal);
 }
}
function controlledDirectory(path:string){
 if(!existsSync(path))mkdirSync(path,{recursive:true,mode:0o700});
 const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new OperatorError('Diagnostics require owner-only non-symlink application directories',1);
}
export function diagnosticExport(path:string,project:string,apply=false,state=appState(),version='unknown'){
 const directory=join(state,'diagnostics'),output=join(directory,digest(project)+'.json');
 const preview={project,preview:!apply,output,categories:['versions','job-state-and-blocker-codes','event-metadata','evidence-timestamps','unknowns'],excluded:['credentials','authentication stores','source','transcripts','PR bodies','event payloads'],maxBytes:1024*1024};
 if(!apply)return preview;
 controlledDirectory(state);controlledDirectory(directory);
 if(existsSync(output)){const st=lstatSync(output);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new OperatorError('Unsafe existing diagnostic output; export refused',1);}
 const views=jobViews(path,project);if(views.length>1000)throw new OperatorError('Diagnostics exceed 1000 scoped jobs; narrow project scope',1);
 let s:Store|undefined;const jobs=[];
 try{
  if(existsSync(path))s=Store.readonly(path);
  for(const v of views)jobs.push({job:v.job,project:v.project,state:v.state,orchestrationState:v.orchestrationState,evidence:v.evidence,blockers:v.blockers.map(b=>({code:b.code,kind:b.kind,observedAt:b.observedAt})),events:s?jobEvents(s,v.job):[]});
 }finally{s?.close();}
 const bundle={schemaVersion:1,createdAt:new Date().toISOString(),version,project,configuration:{scope:'selected project only; raw config and paths excluded'},jobs,unknowns:['Persisted evidence only; no live provider probes, source or transcript export.'],...preview};
 const bytes=JSON.stringify(bundle,null,2)+'\n';if(Buffer.byteLength(bytes)>preview.maxBytes)throw new OperatorError('Diagnostics exceed size bound; no output written',1);
 atomicFile(output,bytes,0o600);return {...preview,written:true,bytes:Buffer.byteLength(bytes)};
}
export function scopedEvents(path:string,project:string|undefined,reference:string,after=0){const view=jobViews(path,project,reference)[0],s=Store.readonly(path);try{const events=jobEvents(s,view.job,after);return {job:view.job,project:view.project,events,cursor:events.at(-1)?.seq??after,payloads:'omitted'};}finally{s.close();}}

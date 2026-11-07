import {mkdirSync,rmdirSync,lstatSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';import {appState} from './install-state';
import {atomicFile} from './atomic-file';
import {AsyncLocalStorage} from 'node:async_hooks';
const submitting=new AsyncLocalStorage<{lock:string;active:boolean}>();
const controlling=new AsyncLocalStorage<{lock:string;active:boolean}>();
export class TurnSubmissionBlocked extends Error{}
const projectPausePath=(project:string,state:string)=>join(state,'paused-projects',createHash('sha256').update(project).digest('hex'));
export function projectIntakePaused(project:string,state=appState()){
 try{lstatSync(projectPausePath(project,state));return true;}catch(e:any){if(e?.code==='ENOENT')return false;throw e;}
}
export function setProjectIntakePaused(project:string,paused:boolean,state=appState()){
 if(!/^[\w-]{1,80}$/.test(project))throw Error('Registered project ID required');
 const path=projectPausePath(project,state);
 if(paused)atomicFile(path,'Intake paused; explicit project start required\n');
 else if(projectIntakePaused(project,state))unlinkSync(path);
}
export function assertProjectIntakeEnabled(project?:string,state=appState()){
 if(project&&projectIntakePaused(project,state))throw new TurnSubmissionBlocked('Project intake is intentionally paused; use services start PROJECT after inspection');
}
export type TurnBarrier={
  run<T>(operation:()=>Promise<T>,mode?:'control'|'start'):Promise<T>;
  submit<T>(operation:()=>Promise<T>):Promise<T>;
  isPaused():boolean;
 pause():void;
 resume():void;
};
// Fail closed on contention or abandoned locks; never infer that a possibly
// delivered request is safe to replay. All bridge processes use this same path.
export function turnBarrier(state=appState()):TurnBarrier{
 const lock=join(state,'turn-submission.lock'),paused=join(state,'turn-submissions.paused');
 const isPaused=()=>{try{lstatSync(paused);return true;}catch(e:any){if(e?.code==='ENOENT')return false;throw e;}};
 const exclusive=async<T>(operation:()=>Promise<T>)=>{
  mkdirSync(state,{recursive:true,mode:0o700});
  try{mkdirSync(lock,{mode:0o700});}catch(e:any){if(e?.code==='EEXIST')throw new TurnSubmissionBlocked('Turn submission or shutdown is in progress; inspect turn-submission.lock if interrupted');throw e;}
  try{return await operation();}finally{try{rmdirSync(lock);}catch{console.error('Turn submission lock cleanup needs inspection:',lock);}}
 };
  const run=async<T>(operation:()=>Promise<T>,mode:'control'|'start'='control'):Promise<T>=>{
   const inherited=controlling.getStore();if(inherited?.active&&inherited.lock===lock)return operation();
   return exclusive(async()=>{
    // Check under the lock, before creating a control scope. Only an already
    // active stack-control scope may start intake behind its own pause.
    if(mode==='start'&&isPaused())throw new TurnSubmissionBlocked('Intake submissions remain paused; use start --all after inspecting the stack');
    const scope={lock,active:true};return controlling.run(scope,async()=>{try{return await operation();}finally{scope.active=false;}});
   });
 };
 const submit=async<T>(operation:()=>Promise<T>):Promise<T>=>{
  const inherited=submitting.getStore();if(inherited?.active&&inherited.lock===lock)return operation();
  return exclusive(async()=>{
   if(isPaused())throw new TurnSubmissionBlocked('Turn submissions paused; use start --all after inspecting the stack');
   const scope={lock,active:true};return submitting.run(scope,async()=>{try{return await operation();}finally{scope.active=false;}});
  });
 };
  return {run,submit,isPaused,
  pause:()=>{atomicFile(paused,'Paused by stop --all\n');},resume:()=>{if(isPaused())unlinkSync(paused);}};
}
export const withTurnSubmission=<T>(operation:()=>Promise<T>)=>turnBarrier().submit(operation);

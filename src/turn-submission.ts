import {mkdirSync,rmdirSync,lstatSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';import {appState} from './install-state';
import {atomicFile} from './atomic-file';
export type TurnBarrier={
 run<T>(operation:()=>Promise<T>):Promise<T>;
 submit<T>(operation:()=>Promise<T>):Promise<T>;
 pause():void;
 resume():void;
};
// Fail closed on contention or abandoned locks; never infer that a possibly
// delivered request is safe to replay. All bridge processes use this same path.
export function turnBarrier(state=appState()):TurnBarrier{
 const lock=join(state,'turn-submission.lock'),paused=join(state,'turn-submissions.paused');
 const isPaused=()=>{try{lstatSync(paused);return true;}catch(e:any){if(e?.code==='ENOENT')return false;throw e;}};
 const run=async<T>(operation:()=>Promise<T>)=>{
  mkdirSync(state,{recursive:true,mode:0o700});
  try{mkdirSync(lock,{mode:0o700});}catch(e:any){if(e?.code==='EEXIST')throw Error('Turn submission or shutdown is in progress; inspect turn-submission.lock if interrupted');throw e;}
  try{return await operation();}finally{try{rmdirSync(lock);}catch{console.error('Turn submission lock cleanup needs inspection:',lock);}}
 };
 return {run,submit:operation=>run(async()=>{if(isPaused())throw Error('Turn submissions paused; use start --all after inspecting the stack');return operation();}),
  pause:()=>{atomicFile(paused,'Paused by stop --all\n');},resume:()=>{if(isPaused())unlinkSync(paused);}};
}
export const withTurnSubmission=<T>(operation:()=>Promise<T>)=>turnBarrier().submit(operation);

import {existsSync,lstatSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {digest} from './core';
import {atomicFile} from './atomic-file';

export const RESTART_PROOF_TTL=10*60*1000;
export function restartPreviewCommand(binding:any){return ['adlc restart --all',binding.mode?`--${binding.mode}`:'',`--timeout ${binding.timeout}`,binding.persistent?'--disable-login':'--temporary'].filter(Boolean).join(' ');}
function privateDirectory(state:string){
 mkdirSync(state,{recursive:true,mode:0o700});
 const st=lstatSync(state);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022))throw Error('Restart state must be an owner-controlled non-symlink directory');
}
export function privateJSON(path:string){
 const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)||st.size>1024*1024)throw Error('Restart evidence must be a bounded owner-only regular file');
 return JSON.parse(readFileSync(path,'utf8'));
}
export function restartIdentity(state:string){
 return digest(JSON.stringify(['installation.json','orchestrator-runtime.json'].map(name=>{
  const path=join(state,name);return [name,existsSync(path)?privateJSON(path):null];
 })));
}
export function saveRestartProof(state:string,binding:unknown,confirm:string,now:number){
 privateDirectory(state);atomicFile(join(state,'restart-preview.json'),JSON.stringify({version:1,binding,confirm,createdAt:now,identity:restartIdentity(state)})+'\n');
}
export function loadRestartProof(state:string,binding:unknown,now:number){
 try{
  privateDirectory(state);const proof=privateJSON(join(state,'restart-preview.json'));
  if(proof.version!==1||JSON.stringify(proof.binding)!==JSON.stringify(binding)||!Number.isSafeInteger(proof.createdAt)||now<proof.createdAt||now-proof.createdAt>RESTART_PROOF_TTL||proof.identity!==restartIdentity(state)||! /^[a-f0-9]{64}$/.test(proof.confirm))throw Error('stale');
  return proof.confirm as string;
 }catch{throw Error(`Saved restart preview missing, stale or mismatched; run ${restartPreviewCommand(binding)} before --apply`);}
}
// Only a caller holding the lifecycle fence and freshly verifying backend,
// intended launcher and every prior poller may reconcile this existing record.
export function recordVerifiedRestart(state:string,evidence:{backend:any;services:any[];observedAt:number}){
 if(!evidence.backend?.ready||!evidence.backend?.managed||evidence.backend?.launcherVerified!==true||evidence.services.some(s=>s.loaded!==true))throw Error('Restart verification incomplete; pending restart preserved');
 privateDirectory(state);
 const path=join(state,'update-state.json');
 if(existsSync(path)){const prior=privateJSON(path);if(prior.version!==1||typeof prior.restartRequired!=='boolean')throw Error('Update record invalid; pending restart preserved');atomicFile(path,JSON.stringify({...prior,restartRequired:false,restartVerification:evidence})+'\n');}
 atomicFile(join(state,'restart-result.json'),JSON.stringify({version:1,...evidence})+'\n');
 return {verified:true,...evidence};
}
export function restartResult(state:string){const path=join(state,'restart-result.json');return existsSync(path)?privateJSON(path):null;}

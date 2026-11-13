import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {controlManagedLifecycle,type LifecycleOps,type Worker} from '../src/managed-lifecycle';
import {loadRestartProof,recordVerifiedRestart,RESTART_PROOF_TTL} from '../src/restart-proof';
function fixture(){
 const state=mkdtempSync(join(tmpdir(),'restart-proof-')),calls:string[]=[];let now=0,ready=true,busy=false,exited=false,paused=false;
 const worker=():Worker=>({session:'session',project:'project',branch:'branch',worktree:'/isolated',owned:true,exited,busy,turns:[],reason:'fixture'});
 const ops:LifecycleOps={turns:{run:async f=>f(),submit:async f=>f(),isPaused:()=>paused,pause:()=>{paused=true;},resume:()=>{paused=false;}},projects:async()=>[{project:'project'}],project:async(action,id)=>{if(action!=='service-status')calls.push(action);return {project:id,loaded:action!=='stop'};},backend:async()=>({ready,loaded:ready,managed:true,launcher:'/intended',launcherVerified:true}),backendStart:async()=>{calls.push('backend:start');ready=true;},backendStop:async()=>{calls.push('backend:stop');ready=false;},inventory:async()=>({workers:[worker()],children:[],complete:true,externalProcesses:'fixture'}),exit:async()=>{calls.push('exit');exited=true;},checkpoint:async()=>{},processesRemain:async()=>[],now:()=>now,sleep:async ms=>{now+=ms;}};
 writeFileSync(join(state,'update-state.json'),JSON.stringify({version:1,commit:'a'.repeat(40),restartRequired:true,classification:'hot'}),{mode:0o600});
 return {state,ops,calls,busy:()=>busy=true,age:()=>now+=RESTART_PROOF_TTL+1,close:()=>rmSync(state,{recursive:true,force:true})};
}
test('two-command restart saves proof, revalidates and clears pending only after verification',async()=>{
 const f=fixture();try{
  const preview=await controlManagedLifecycle('restart',{all:true,timeout:30},f.ops,30000,f.state);expect(preview.savedPreview).toBe(true);expect(f.calls).toEqual([]);
  const result=await controlManagedLifecycle('restart',{all:true,timeout:30,apply:true},f.ops,30000,f.state);expect(result.restartVerification.verified).toBe(true);expect(f.calls).toContain('backend:stop');expect(JSON.parse(readFileSync(join(f.state,'update-state.json'),'utf8')).restartRequired).toBe(false);
 }finally{f.close();}
});
test('missing, aged, mismatched and newly busy previews stop before service changes',async()=>{
 for(const change of ['missing','aged','mismatch','busy']){const f=fixture();try{
  if(change!=='missing')await controlManagedLifecycle('restart',{all:true,timeout:30},f.ops,30000,f.state);
  if(change==='aged')f.age();if(change==='busy')f.busy();
  await expect(controlManagedLifecycle('restart',{all:true,timeout:change==='mismatch'?31:30,apply:true},f.ops,1000000,f.state)).rejects.toThrow(change==='busy'?'Worker became busy':'adlc restart --all');expect(f.calls).toEqual([]);expect(JSON.parse(readFileSync(join(f.state,'update-state.json'),'utf8')).restartRequired).toBe(true);
 }finally{f.close();}}
});
test('explicit confirmation stays supported and verification failure preserves pending',async()=>{
 const f=fixture();try{
  const p=await controlManagedLifecycle('restart',{all:true,timeout:30},f.ops,30000,f.state),original=f.ops.backend;
  let starts=0;const start=f.ops.backendStart;f.ops.backendStart=async()=>{starts++;await start();};f.ops.backend=async()=>({...await original(),launcherVerified:starts===0});
  await expect(controlManagedLifecycle('restart',{all:true,timeout:30,apply:true,confirm:p.confirm},f.ops,30000,f.state)).rejects.toThrow('pending restart preserved');expect(JSON.parse(readFileSync(join(f.state,'update-state.json'),'utf8')).restartRequired).toBe(true);
 }finally{f.close();}
});
test('verified intended launcher with a stale update flag can reconcile without resetting update history',()=>{
 const f=fixture();try{
  expect(()=>recordVerifiedRestart(f.state,{backend:{ready:true,managed:true,launcherVerified:false},services:[{loaded:true}],observedAt:1})).toThrow();
  recordVerifiedRestart(f.state,{backend:{ready:true,managed:true,launcherVerified:true},services:[{loaded:true}],observedAt:2});expect(JSON.parse(readFileSync(join(f.state,'update-state.json'),'utf8'))).toMatchObject({commit:'a'.repeat(40),restartRequired:false,classification:'hot'});
 }finally{f.close();}
});
test('post-restart failure names the launcher check and next action without clearing pending state',()=>{
 const f=fixture();try{
  expect(()=>recordVerifiedRestart(f.state,{backend:{ready:true,managed:true,launcherVerified:false},services:[],observedAt:1})).toThrow('managed-launcher');
  expect(()=>recordVerifiedRestart(f.state,{backend:{ready:true,managed:true,launcherVerified:false},services:[],observedAt:1})).toThrow('fresh restart preview');
  expect(JSON.parse(readFileSync(join(f.state,'update-state.json'),'utf8')).restartRequired).toBe(true);
 }finally{f.close();}
});

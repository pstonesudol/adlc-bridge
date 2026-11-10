import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from './core';
import {Workflow} from './workflow';
import {ReviewLoop} from './review-loop';
import {ProjectServices} from './project-services';
import {StartupRecovery,type RecoverySummary} from './startup-recovery';
import {localAO,createWorkflowTransport} from './workflow-transport';
import {sessionEvidence} from './session-evidence';
import {appState} from './install-state';
import {projectIntakePaused,withRecoverySubmission} from './turn-submission';
import {poll} from './linear';
import {linearToken} from './credential';

export function assertRecoveryAvailable(state=appState()){
 if(existsSync(join(state,'update.lock')))throw Error('Update operation pending; inspect update-status before recovery');
 const intent=join(state,'update-intent.json');
 if(existsSync(intent)){
  const stage=JSON.parse(readFileSync(intent,'utf8')).stage;
  if(!['completed','deferred','rolled-back','failed'].includes(stage))throw Error(`Update ${stage??'unknown'} requires operator reconciliation; recovery deferred`);
 }
}
export async function authoritativeSessions(){
 const inventory=await localAO('sessions');
 if(!Array.isArray(inventory.sessions)||inventory.nextCursor)throw Error('Complete authoritative session inventory unavailable');return inventory.sessions;
}
// Both launchd poll startup (including login), and every later poll after wake
// or daemon/connectivity recovery, use the same coordinator as CLI startup.
export async function recoverProject(s:Store,w:Workflow,loop:ReviewLoop,c:any,options:{state?:string;deadline?:number;force?:boolean;inventory?:typeof authoritativeSessions}={}){
 const state=options.state??appState(),deadline=options.deadline??Date.now()+25000;
 const check=()=>{assertRecoveryAvailable(state);if(Date.now()>=deadline)throw Error('Recovery pass deadline reached; remaining jobs deferred to the next poll');};
 check();
 const recovery=new StartupRecovery(s,w,{inventory:options.inventory??authoritativeSessions,check,
  register:(job,result,config)=>{
   const pr=result.pr??s.db.query('SELECT repo,pr FROM review_targets WHERE job=?').get(job) as any;
   if(!pr||!(pr.number??pr.pr))throw Error('Published PR target unavailable; reconcile before review');
   const d=w.implementation(job);loop.register(job,config.githubRepo!,pr.number??pr.pr,config.requiredChecks,JSON.parse(d.paths),true,config.verification,config.verificationContext);
  }});
 return recovery.pass(c,options.force);
}
export async function recoverRegisteredProjects(ids:string[],path:string,state=appState(),deadline=Date.now()+30000){
 assertRecoveryAvailable(state);
 return withRecoverySubmission(async()=>{
  const s=new Store(path);
  try{
   const registry=new ProjectServices(s,false),entries=registry.list().filter(p=>ids.includes(p.project));
   if(entries.length!==ids.length)throw Error('Complete registered project inventory required before startup recovery');
   const transport=createWorkflowTransport();
   const remaining=()=>{const ms=deadline-Date.now();if(ms<1)throw Error('Startup recovery deadline reached; retry start --all');return ms;};
   transport.evidence=id=>sessionEvidence(id,Bun.spawn,Math.min(120000,remaining()));
   const w=new Workflow(s,transport),loop=new ReviewLoop(s),results:{project:string;recovery:RecoverySummary}[]=[];
   for(const entry of entries){
    remaining();
    if(projectIntakePaused(entry.project,state)){results.push({project:entry.project,recovery:{complete:true,admit:true,results:[],reattached:0,resumed:0,waiting:1,blocked:0,reason:'Deliberate project pause preserved; explicit project start required'}});continue;}
    const c=registry.verify(entry);
    // Refresh requirements/eligibility, but never dispatch new workers here.
    await poll(c,s,linearToken());
    results.push({project:entry.project,recovery:await recoverProject(s,w,loop,c,{state,deadline,force:true})});
   }
   return {complete:results.every(x=>x.recovery.complete),admit:results.every(x=>x.recovery.admit),projects:results};
  }finally{s.close();}
 },state);
}

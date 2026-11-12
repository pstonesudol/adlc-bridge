import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from './core';
import {Workflow} from './workflow';
import {ReviewLoop} from './review-loop';
import {ProjectServices} from './project-services';
import {StartupRecovery,type RecoverySummary} from './startup-recovery';
import {localAO,createLocalAO,createWorkflowTransport,jsonCommand} from './workflow-transport';
import {sessionEvidence} from './session-evidence';
import {appState} from './install-state';
import {projectIntakePaused,withRecoverySubmission,withTurnSubmission} from './turn-submission';
import {poll} from './linear';
import {linearToken} from './credential';
import {createProcessRunner,worktreeIdentity} from './delivery-evidence';
import {restoreRepository,restoreRegistry} from './planning-restore';
import {readBranchSnapshot} from './branch-updates';
import {preflightRoute,configureSessionRoute} from './routing-session';
import {trustedDaemon} from './daemon-runtime';
import {disableNativeFeedback} from './ao-policy';
import {assertCurrentPlanningRequirements} from './spec-recovery';
import {createLinearAPI,readLinearIssue} from './linear-api';
import {readPlanningPRs} from './planning-prs';

type RecoveryIODependencies={spawn?:typeof Bun.spawn;send?:typeof fetch;now?:()=>number;trust?:typeof trustedDaemon;registry?:typeof restoreRegistry;token?:typeof linearToken};
// Scope all recovery I/O to one absolute deadline, not a fresh allowance for
// every command. Await subprocess exit/streams and HTTP body completion after
// cancellation; never race a still-running mutation against a timeout promise.
export function createRecoveryIO(s:Store,deadline:number,submit=withTurnSubmission,deps:RecoveryIODependencies={}){
 const remaining=()=>{const ms=Math.floor(deadline-(deps.now??Date.now)());if(!Number.isSafeInteger(ms)||ms<1)throw Error('Recovery pass deadline reached; retry after reconciling existing receipts');return ms;};
 const spawn=((argv:any,options:any={})=>{
  const left=remaining(),timeout=Math.min(typeof options.timeout==='number'&&options.timeout>0?options.timeout:left,left);
  return (deps.spawn??Bun.spawn)(argv,{...options,timeout});
 }) as typeof Bun.spawn;
 const send=(async(input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
  const prior=options?.signal??(input instanceof Request?input.signal:undefined),expiry=AbortSignal.timeout(remaining());
  return (deps.send??fetch)(input,{...options,signal:prior?AbortSignal.any([prior,expiry]):expiry});
 }) as typeof fetch;
 const run=createProcessRunner(spawn),api=createLocalAO(args=>jsonCommand(args,spawn),send,deps.trust??trustedDaemon);
 const transport=createWorkflowTransport(submit,spawn,api,id=>disableNativeFeedback(id,spawn,send));
 transport.evidence=id=>sessionEvidence(id,spawn,Math.min(120000,remaining()));
 transport.preflightRoute=route=>preflightRoute(route,api);
 transport.configureRoute=(id,route)=>configureSessionRoute(id,route,api);
 transport.worktree=job=>worktreeIdentity(s,job,run);
  transport.branchSnapshot=(repo,pr)=>readBranchSnapshot(repo,pr,async args=>JSON.parse(await run(['gh',...args])));
  transport.planningPRs=(repo,branch)=>readPlanningPRs(repo,branch,async args=>JSON.parse(await run(['gh',...args])));
 const linear=createLinearAPI(send,deps.token??linearToken);
 return {remaining,spawn,send,run,api,transport,
  inspect:(store:Store,job:string,c:any)=>restoreRepository(store,job,c,run,deps.registry??restoreRegistry),
  requirements:(store:Store,job:string,c:any)=>assertCurrentPlanningRequirements(store,job,c,id=>readLinearIssue(id,linear))};
}

export function assertRecoveryAvailable(state=appState()){
 if(existsSync(join(state,'update.lock')))throw Error('Update operation pending; inspect update-status before recovery');
 const intent=join(state,'update-intent.json');
 if(existsSync(intent)){
  const stage=JSON.parse(readFileSync(intent,'utf8')).stage;
  if(!['completed','deferred','rolled-back','failed'].includes(stage))throw Error(`Update ${stage??'unknown'} requires operator reconciliation; recovery deferred`);
 }
}
export async function authoritativeSessions(api=localAO){
 const inventory=await api('sessions');
 if(!Array.isArray(inventory.sessions)||inventory.nextCursor)throw Error('Complete authoritative session inventory unavailable');return inventory.sessions;
}
// Both launchd poll startup (including login), and every later poll after wake
// or daemon/connectivity recovery, use the same coordinator as CLI startup.
export async function recoverProject(s:Store,w:Workflow,loop:ReviewLoop,c:any,options:{state?:string;deadline?:number;force?:boolean;inventory?:()=>Promise<any[]>;io?:ReturnType<typeof createRecoveryIO>}={}){
 const state=options.state??appState(),deadline=options.deadline??Date.now()+25000;
 const io=options.io??createRecoveryIO(s,deadline,w.t.submit);
 const check=()=>{assertRecoveryAvailable(state);io.remaining();};
 check();
 const scopedWorkflow=new Workflow(s,io.transport,w.router,true);
 const recovery=new StartupRecovery(s,scopedWorkflow,{inventory:options.inventory??(()=>authoritativeSessions(io.api)),check,inspect:io.inspect,requirements:io.requirements,
  register:(job,result,config)=>{
   const pr=result.pr??s.db.query('SELECT repo,pr FROM review_targets WHERE job=?').get(job) as any;
   if(!pr||!(pr.number??pr.pr))throw Error('Published PR target unavailable; reconcile before review');
   const d=w.implementation(job);loop.register(job,config.githubRepo!,pr.number??pr.pr,config.requiredChecks,JSON.parse(d.paths),true,config.verification,config.verificationContext);
  }});
 const result=await recovery.pass(c,options.force);
 try{check();}catch(error){return {...result,complete:false,admit:false,reason:error instanceof Error?error.message:'Recovery deadline exhausted; new work remains fenced'};}
 return result;
}
export async function recoverRegisteredProjects(ids:string[],path:string,state=appState(),deadline=Date.now()+30000){
 assertRecoveryAvailable(state);
 return withRecoverySubmission(async()=>{
  const s=new Store(path);
  try{
   const registry=new ProjectServices(s,false),entries=registry.list().filter(p=>ids.includes(p.project));
   if(entries.length!==ids.length)throw Error('Complete registered project inventory required before startup recovery');
   const io=createRecoveryIO(s,deadline),w=new Workflow(s,io.transport),loop=new ReviewLoop(s),results:{project:string;recovery:RecoverySummary}[]=[];
   for(const entry of entries){
    io.remaining();
    if(projectIntakePaused(entry.project,state)){results.push({project:entry.project,recovery:{complete:true,admit:true,results:[],reattached:0,resumed:0,waiting:1,blocked:0,reason:'Deliberate project pause preserved; explicit project start required'}});continue;}
    const c=registry.verify(entry);
    // Refresh requirements/eligibility, but never dispatch new workers here.
    await poll(c,s,linearToken(),io.send);
    results.push({project:entry.project,recovery:await recoverProject(s,w,loop,c,{state,deadline,force:true,io})});
   }
   return {complete:results.every(x=>x.recovery.complete),admit:results.every(x=>x.recovery.admit),projects:results};
  }finally{s.close();}
 },state);
}

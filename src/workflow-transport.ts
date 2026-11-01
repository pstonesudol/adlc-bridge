import {installedCLI} from './install-state';
import {trustedDaemon} from './daemon-runtime';
import {configureSessionRoute,preflightRoute} from './routing-session';
import {AO} from './orchestrator';
import {sessionEvidence} from './session-evidence';
import {disableNativeFeedback} from './ao-policy';
import type {WorkflowTransport} from './workflow';
import {withTurnSubmission} from './turn-submission';
import {readFileSync,realpathSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';

async function jsonCommand(args:string[]){
 const p=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});
 const [text,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code!==0)throw Error('Orchestrator operation failed');return JSON.parse(text);
}
export async function localAO(path:string,method='GET',body?:unknown){
 const state=await jsonCommand([AO,'status','--json']);
 if(state.state!=='ready'||!trustedDaemon(state.executablePath)||!Number.isSafeInteger(state.port))throw Error('Verified Orchestrator daemon is not ready');
 // This module constructs paths internally. Never proxy arbitrary worker input.
 const r=await fetch(`http://127.0.0.1:${state.port}/api/v1/${path}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
 const b:any=await r.json();if(!r.ok)throw Error(`Orchestrator HTTP ${r.status}`);return b;
}
export function createWorkflowTransport(submit=withTurnSubmission,spawn=Bun.spawn,api=localAO,disable=disableNativeFeedback):WorkflowTransport{return {
  submit,
  async startPlan(r){
   return submit(async()=>{
   const b=await api('sessions','POST',{projectId:r.project,branch:r.branch,displayName:r.name,kind:'worker',harness:r.route?.harness??'codex',mode:'chat',approvalMode:'accept-edits',...(r.route?{model:r.route.model}:{}),prompt:r.route?'':r.prompt,clientRequestId:r.clientId});
  if(!b.session?.id||b.session.projectId!==r.project||b.session.branch!==r.branch)throw Error('Invalid planning spawn receipt');
   await disable(b.session.id);return {id:b.session.id};
   });
 },
 async findPlans(project,branch){
  const inventory=await jsonCommand([AO,'session','ls','--all','--include-terminated','--json']);
  if(!Array.isArray(inventory.data))throw Error('Incomplete session inventory');
  const matches=[];
  for(const s of inventory.data.filter((s:any)=>s.projectId===project&&!s.isTerminated)){
   const d=await jsonCommand([AO,'session','get',s.id,'--json']);
   if(d.session?.branch===branch)matches.push(d.session);
  }return matches;
 },
 evidence:sessionEvidence,
 preflightRoute,
 configureRoute:configureSessionRoute,
  async sendImplementation(session,prompt,clientId){
   return submit(async()=>{
   const p=spawn([AO,'send','--session',session,'--steer','--client-message-id',clientId,'--message',prompt],{stdout:'pipe',stderr:'pipe',timeout:30000});
  const [_out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   if(code!==0)throw Error('Implementation delivery uncertain');
   });
 },
 disableFeedback:disableNativeFeedback
};}
export const liveTransport=createWorkflowTransport();

export async function installWorkflowHook(configPath:string,api=localAO){
 const path=resolve(configPath),c=JSON.parse(readFileSync(path,'utf8'));
 const project=c.automation?.orchestratorProject;
 if(!/^[\w-]+$/.test(project??''))throw Error('Configured Orchestrator project required');
 const b=await api(`projects/${project}`);
 if(realpathSync(b.project?.path??'')!==realpathSync(c.repo))throw Error('Registered source path mismatch');
 if(b.status!=='ok'||!b.project?.config)throw Error('Complete healthy project configuration required');
 const config=structuredClone(b.project.config);
 const backupDir=resolve(homedir(),'Library','Application Support','ADLC Bridge','backups');
 mkdirSync(backupDir,{recursive:true,mode:0o700});
 const backup=resolve(backupDir,`${project}-${Date.now()}.json`);
 writeFileSync(backup,JSON.stringify(b.project.config,null,2),{mode:0o600,flag:'wx'});
 const hook=`${shellQuote(process.execPath)} ${shellQuote(resolve(installedCLI()?resolve(installedCLI()!,'..'):import.meta.dir,'planning-gate.ts'))}`;
 const scripts=config.postCreate??[];
 if(!Array.isArray(scripts)||scripts.some((x:any)=>typeof x!=='string'))throw Error('Unexpected setup scripts');
  const prior=scripts.filter((x:string)=>!bridgePlanningHook(x)&&!x.includes('ADLC execution disabled pending host approval gate'));
 config.postCreate=[hook,...prior];
 config.env={...(config.env??{}),ADLC_WORKFLOW_CONFIG:path};
 delete config.env.ADLC_PLANNING_JOB;delete config.env.ADLC_PLANNING_PROJECT;
 config.agentConfig={...(config.agentConfig??{}),permissions:'accept-edits'};
 for(const role of ['worker','orchestrator'])config[role]={...(config[role]??{}),agent:config[role]?.agent??'codex',agentConfig:{...(config[role]?.agentConfig??{}),permissions:'accept-edits'}};
 await api(`projects/${project}/config`,'PUT',{config});
 const applied=await api(`projects/${project}`);
 if(applied.project?.config?.env?.ADLC_WORKFLOW_CONFIG!==path||applied.project?.config?.postCreate?.[0]!==hook)throw Error('Workflow hook did not persist');
 return {project,backup,hookInstalled:true,planningEnabled:!!c.automation.planningEnabled};
}
function shellQuote(s:string){return "'"+s.replaceAll("'","'\\''")+"'";}
export function bridgePlanningHook(script:string,checkout=resolve(import.meta.dir,'planning-gate.ts'),versions=resolve(homedir(),'Library/Application Support/ADLC Bridge/versions')){
 const command=script.match(/^(?:'[^']*'|"[^"]*"|[^\s]+)\s+(?:'([^']*)'|"([^"]*)"|([^\s]+))\s*$/);
 if(!command)return false;
 const path=command[1]??command[2]??command[3];
 if(path===checkout)return true;
 const prefix=versions+'/';if(!path.startsWith(prefix))return false;
 return /^[^/]+\/src\/planning-gate\.ts$/.test(path.slice(prefix.length));
}

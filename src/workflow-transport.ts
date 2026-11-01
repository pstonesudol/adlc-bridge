import {configureSessionRoute,preflightRoute} from './routing-session';
import {AO} from './orchestrator';
import {sessionEvidence} from './session-evidence';
import {disableNativeFeedback} from './ao-policy';
import type {WorkflowTransport} from './workflow';
import {readFileSync,realpathSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,isAbsolute,basename,dirname} from 'node:path';

async function jsonCommand(args:string[]){
 const p=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});
 const [text,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code!==0)throw Error('Orchestrator operation failed');return JSON.parse(text);
}
export async function localAO(path:string,method='GET',body?:unknown){
 const state=await jsonCommand([AO,'status','--json']);
 if(state.state!=='ready'||state.executablePath!==AO||!Number.isSafeInteger(state.port))throw Error('Verified Orchestrator daemon is not ready');
 // This module constructs paths internally. Never proxy arbitrary worker input.
 const r=await fetch(`http://127.0.0.1:${state.port}/api/v1/${path}`,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
 const b:any=await r.json();if(!r.ok)throw Error(`Orchestrator HTTP ${r.status}`);return b;
}
export const liveTransport:WorkflowTransport={
 async startPlan(r){
  const b=await localAO('sessions','POST',{projectId:r.project,branch:r.branch,displayName:r.name,kind:'worker',harness:r.route?.harness??'codex',mode:'chat',approvalMode:'accept-edits',...(r.route?{model:r.route.model}:{}),prompt:r.route?'':r.prompt,clientRequestId:r.clientId});
  if(!b.session?.id||b.session.projectId!==r.project||b.session.branch!==r.branch)throw Error('Invalid planning spawn receipt');
  await disableNativeFeedback(b.session.id);return {id:b.session.id};
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
  const p=Bun.spawn([AO,'send','--session',session,'--steer','--client-message-id',clientId,'--message',prompt],{stdout:'pipe',stderr:'pipe'});
  const [_out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if(code!==0)throw Error('Implementation delivery uncertain');
 },
 disableFeedback:disableNativeFeedback
};

export const planningGateMarker='ADLC_RESERVED_WORKTREE_GATE_V1';
// Decode literal shell words only. Never evaluate expansions or execute hook text.
function literalCommandWords(command:string){
 const words:string[]=[];let word='',quote='',active=false;
 for(let i=0;i<command.length;i++){
  const c=command[i];
  if(quote==="'"){if(c==="'")quote='';else word+=c;continue;}
  if(quote==='"'){
   if(c==='"'){quote='';continue;}
   if(c==='\\'){const next=command[++i];if(!next||!['\\','"','$','`'].includes(next))return;word+=next;continue;}
   if(c==='$'||c==='`'||c==='\n'||c==='\r')return;
   word+=c;continue;
  }
  if(c==='\n'||c==='\r')return;
  if(/\s/.test(c)){if(active){words.push(word);word='';active=false;}continue;}
  active=true;
  if(c==="'"||c==='"'){quote=c;continue;}
  if(c==='\\'){const next=command[++i];if(!next||next==='\n'||next==='\r')return;word+=next;continue;}
  if(/[;&|<>()$`#]/.test(c))return;
  word+=c;
 }
 if(quote)return;
 if(active)words.push(word);
 return words;
}
export function workflowGateScripts(scripts:unknown,gate=resolve(import.meta.dir,'planning-gate.ts')){
 if(!Array.isArray(scripts)||scripts.some(x=>typeof x!=='string'))throw Error('Unexpected setup scripts');
 const hook=`${shellQuote(process.execPath)} ${shellQuote(gate)} # ${planningGateMarker}`;
 const prior=scripts.filter((x:string)=>{
  if(x.includes('ADLC execution disabled pending host approval gate'))return false;
  const suffix=` # ${planningGateMarker}`,trimmed=x.trimEnd(),marked=trimmed.endsWith(suffix);
  const words=literalCommandWords(marked?trimmed.slice(0,-suffix.length):x);
  const gateInvocation=words?.length===2&&isAbsolute(words[1])&&basename(dirname(words[1]))==='src'&&basename(words[1])==='planning-gate.ts';
  const bunInvocation=words&&(basename(words[0]??'')==='bun'||(isAbsolute(words[0]??'')&&resolve(words[0])===resolve(process.execPath)));
  if(gateInvocation&&(marked||(bunInvocation&&resolve(words![1])===resolve(gate))))return false;
  // A filename, even under src, does not prove ownership of another installation.
  if(gateInvocation||(!words&&x.includes('/src/planning-gate.ts')))throw Error('Ambiguous legacy planning gate; reconcile postCreate ownership before setup');
  return true;
 });
 return [hook,...prior];
}
export async function installWorkflowHook(configPath:string,api=localAO){
 const path=resolve(configPath),c=JSON.parse(readFileSync(path,'utf8'));
 const project=c.automation?.orchestratorProject;
 if(!/^[\w-]+$/.test(project??''))throw Error('Configured Orchestrator project required');
 const b=await api(`projects/${project}`);
 if(realpathSync(b.project?.path??'')!==realpathSync(c.repo))throw Error('Registered source path mismatch');
 if(b.status!=='ok'||!b.project?.config)throw Error('Complete healthy project configuration required');
 const config=structuredClone(b.project.config);
 // Fail ambiguous ownership before any backup or project-configuration write.
 config.postCreate=workflowGateScripts(config.postCreate??[]);
 const hook=config.postCreate[0];
 const backupDir=resolve(homedir(),'Library','Application Support','ADLC Bridge','backups');
 mkdirSync(backupDir,{recursive:true,mode:0o700});
 const backup=resolve(backupDir,`${project}-${Date.now()}.json`);
 writeFileSync(backup,JSON.stringify(b.project.config,null,2),{mode:0o600,flag:'wx'});
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

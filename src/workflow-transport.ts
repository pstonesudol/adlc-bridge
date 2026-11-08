import {installedCLI,verifiedInstallationSource} from './install-state';
import {trustedDaemon} from './daemon-runtime';
import {configureSessionRoute,preflightRoute} from './routing-session';
import {AO} from './orchestrator';
import {sessionEvidence} from './session-evidence';
import {disableNativeFeedback} from './ao-policy';
import type {WorkflowTransport} from './workflow';
import {withTurnSubmission} from './turn-submission';
import {PreSendFailure} from './pre-send';
import {nativeModeFailure} from './provider-mode';
import {readFileSync,realpathSync,writeFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,isAbsolute,basename,dirname} from 'node:path';

export async function jsonCommand(args:string[],spawn=Bun.spawn){
 const p=spawn(args,{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [text,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code!==0)throw Error('Orchestrator operation failed');return JSON.parse(text);
}
export function createLocalAO(status=jsonCommand,send=fetch,trust=trustedDaemon){return async(path:string,method='GET',body?:unknown,beforeSend?:()=>void)=>{
 let url:string,options:RequestInit;
 try{
 const state=await status([AO,'status','--json']);
 if(state.state!=='ready'||!trust(state.executablePath)||!Number.isSafeInteger(state.port))throw Error('Verified Orchestrator daemon is not ready');
 // This module constructs paths internally. Never proxy arbitrary worker input.
 url=`http://127.0.0.1:${state.port}/api/v1/${path}`;options={method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)};
 beforeSend?.();
 }catch{throw new PreSendFailure('Orchestrator request not sent: readiness or request preparation failed');}
 try{
 const r=await send(url,options);
 const b:any=await r.json();if(!r.ok)throw nativeModeFailure(b)??Error(`Orchestrator HTTP ${r.status}`);return b;
 }catch(e){if(e instanceof PreSendFailure)throw Error('Orchestrator delivery outcome uncertain',{cause:e});throw e;}
};}
export const localAO=createLocalAO();
export function createWorkflowTransport(submit=withTurnSubmission,spawn=Bun.spawn,api=localAO,disable=disableNativeFeedback):WorkflowTransport{return {
  submit,
  async startPlan(r){
   return submit(async()=>{
    const b=await api('sessions','POST',{projectId:r.project,branch:r.branch,displayName:r.name,kind:'worker',harness:r.route?.harness??'codex',mode:'chat',approvalMode:'accept-edits',...(r.route?{model:r.route.model}:{}),prompt:r.route?'':r.prompt,clientRequestId:r.clientId});
   try{
  if(!b.session?.id||b.session.projectId!==r.project||b.session.branch!==r.branch)throw Error('Invalid planning spawn receipt');
    await disable(b.session.id);return {id:b.session.id};
   }catch(e){if(e instanceof PreSendFailure)throw Error('Planning session setup outcome uncertain',{cause:e});throw e;}
   });
 },
 async findPlans(project,branch,includeTerminated=false){
  const inventory=await jsonCommand([AO,'session','ls','--all','--include-terminated','--json'],spawn);
  if(!Array.isArray(inventory.data))throw Error('Incomplete session inventory');
  const matches=[];
  for(const s of inventory.data.filter((s:any)=>s.projectId===project&&(!s.branch||s.branch===branch)&&(includeTerminated||!s.isTerminated))){
   const d=await jsonCommand([AO,'session','get',s.id,'--json'],spawn);
   if(d.session?.id===s.id&&d.session.projectId===project&&d.session.branch===branch&&(includeTerminated||!d.session.isTerminated))matches.push(d.session);
  }return matches;
 },
  evidence:sessionEvidence,
  async restorePlan(session,project){
   let p:ReturnType<typeof spawn>;
   try{p=spawn([AO,'session','restore',session,'--project',project],{stdout:'pipe',stderr:'pipe',timeout:120000});}catch{throw new PreSendFailure('Native restore not launched');}
   const [_out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   if(code!==0)throw Error('Planning restore outcome uncertain; inspect spec-restore, never replay');
  },
 preflightRoute,
 configureRoute:configureSessionRoute,
   async sendImplementation(session,prompt,clientId,mode){
   return submit(async()=>{
    if(mode==='idle-only'){
     const current=await sessionEvidence(session,spawn);
     if(current.session.activity?.state!=='idle'||current.transcript.controller!=='ready'||!Array.isArray(current.transcript.turns)||current.transcript.turns.some((turn:any)=>!['completed','failed','cancelled','interrupted'].includes(turn.state)))throw Error('Worker is not idle');
     await api(`sessions/${encodeURIComponent(session)}/conversation/messages`,'POST',{text:prompt,clientMessageId:clientId});
     return;
    }
    const p=spawn([AO,'send','--session',session,'--steer','--client-message-id',clientId,'--message',prompt],{stdout:'pipe',stderr:'pipe',timeout:30000});
  const [_out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   if(code!==0)throw Error('Implementation delivery uncertain');
   });
 },
 disableFeedback:disableNativeFeedback
};}
export const liveTransport=createWorkflowTransport();

export const planningGateMarker='ADLC_RESERVED_WORKTREE_GATE_V1';
// Remove only shell comments: an unquoted # begins a comment at a word
// boundary, not inside a word, a quote or an escaped literal. Never evaluate.
function shellCommandText(script:string){
 let text='',quote='',boundary=true;
 for(let i=0;i<script.length;i++){
  const c=script[i];
  if(c==='\\'&&quote!=="'"){text+=c;if(i+1<script.length)text+=script[++i];boundary=false;continue;}
  if(quote){text+=c;if(c===quote)quote='';continue;}
  if(c==='#'&&boundary){while(i<script.length&&script[i]!=='\n')i++;if(i<script.length)text+='\n';boundary=true;continue;}
  text+=c;
  if(c==="'"||c==='"'){quote=c;boundary=false;}else boundary=/[\s;&|<>()]/.test(c);
 }
 return text;
}
// Decode literal shell words only. Never evaluate expansions or execute hook text.
function literalCommandWords(command:string){
 command=shellCommandText(command).trimEnd();
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
   if(/[;&|<>()$`]/.test(c))return;
  word+=c;
 }
 if(quote)return;
 if(active)words.push(word);
 return words;
}
export function workflowGateScripts(scripts:unknown,gate=resolve(import.meta.dir,'planning-gate.ts'),installation?:{sourceGate:string;versions:string}){
 if(!Array.isArray(scripts)||scripts.some(x=>typeof x!=='string'))throw Error('Unexpected setup scripts');
 const hook=`${shellQuote(process.execPath)} ${shellQuote(gate)} # ${planningGateMarker}`;
 const prior=scripts.filter((x:string)=>{
  if(x.includes('ADLC execution disabled pending host approval gate'))return false;
  const suffix=` # ${planningGateMarker}`,trimmed=x.trimEnd(),marked=trimmed.endsWith(suffix);
  const words=literalCommandWords(marked?trimmed.slice(0,-suffix.length):x);
  const gatePath=(word:string)=>isAbsolute(word)&&basename(dirname(word))==='src'&&basename(word)==='planning-gate.ts';
  const gateInvocation=words?.length===2&&words[0]!=='echo'&&gatePath(words[1]);
  // Prefixes/extra arguments are not proven equivalent to the owned two-word
  // invocation, even with an installation record. Never retain a possible
  // existing gate while adding a second one.
  if(words&&words[0]!=='echo'&&!gateInvocation&&words.some(gatePath))throw Error('Ambiguous legacy planning gate; reconcile postCreate ownership before setup');
  const bunInvocation=words&&(basename(words[0]??'')==='bun'||(isAbsolute(words[0]??'')&&resolve(words[0])===resolve(process.execPath)));
  if(gateInvocation&&(marked||(bunInvocation&&resolve(words![1])===resolve(gate))))return false;
  // An owner-validated installation record supplies the source and snapshot namespace.
  if(installation)return !bridgePlanningHook(x,gate,installation.versions,installation.sourceGate);
  // A filename, even under src, does not prove ownership of another installation.
  if(gateInvocation||(!words&&shellCommandText(x).includes('/src/planning-gate.ts')))throw Error('Ambiguous legacy planning gate; reconcile postCreate ownership before setup');
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
 const installed=installedCLI(),source=verifiedInstallationSource();
 const gate=resolve(installed?resolve(installed,'..'):import.meta.dir,'planning-gate.ts');
 const installation=installed&&source?{sourceGate:resolve(source,'src/planning-gate.ts'),versions:resolve(homedir(),'Library/Application Support/ADLC Bridge/versions')}:undefined;
 config.postCreate=workflowGateScripts(config.postCreate??[],gate,installation);
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
export function bridgePlanningHook(script:string,checkout=resolve(import.meta.dir,'planning-gate.ts'),versions=resolve(homedir(),'Library/Application Support/ADLC Bridge/versions'),sourceGate?:string){
 const suffix=` # ${planningGateMarker}`,trimmed=script.trimEnd();
 const command=literalCommandWords(trimmed.endsWith(suffix)?trimmed.slice(0,-suffix.length):script);if(!command||command.length!==2)return false;
 if(command[0]!==process.execPath&&basename(command[0])!=='bun')return false;
 const path=command[1];
 if(path===checkout||path===sourceGate)return true;
 const prefix=versions+'/';if(!path.startsWith(prefix))return false;
 return /^[^/]+\/src\/planning-gate\.ts$/.test(path.slice(prefix.length));
}

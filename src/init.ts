import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {existsSync,realpathSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import {homedir} from 'node:os';
import {linearAPI,type LinearAPI} from './linear-api';
import {linearToken} from './credential';
import {validate} from './linear';
import {validScopes} from './file-scope';
import {localAO,installWorkflowHook} from './workflow-transport';
import {loadOpenChamber} from './task-routing';
import {serviceControl} from './service-control';
import {Store} from './core';
import {ProjectServices,registryPath,legacyLabel,assertDefinition,readDefinition} from './project-services';

export async function verifyInitConfig(c:any,api:LinearAPI=linearAPI,ao=localAO){
 validate(c);
 if(!/^[\w.-]+\/[\w.-]+$/.test(c.githubRepo)||!c.requiredChecks?.length||c.requiredChecks.some((x:any)=>typeof x!=='string'||!x.trim())||!validScopes(c.reviewAllowedPaths))throw Error('Repository, required checks and safe review scope required');
 const b=await api(`query($project:String!,$team:String!){project(id:$project){id teams(first:100){nodes{id}pageInfo{hasNextPage}}}team(id:$team){id states(first:100){nodes{id type}pageInfo{hasNextPage}} labels(first:100){nodes{id}pageInfo{hasNextPage}}}}`,{project:c.linear.projectId,team:c.linear.teamId});
 if(b.project?.id!==c.linear.projectId||b.team?.id!==c.linear.teamId||b.project.teams?.pageInfo?.hasNextPage!==false||!b.project.teams.nodes.some((x:any)=>x.id===c.linear.teamId)||b.team.states?.pageInfo?.hasNextPage!==false||b.team.labels?.pageInfo?.hasNextPage!==false)throw Error('Linear project/team mismatch or incomplete inventory');
 const state=(id:string,type:string)=>b.team.states.nodes.some((s:any)=>s.id===id&&s.type===type);
 if(!state(c.linear.readyStateId,'unstarted')||!b.team.labels.nodes.some((l:any)=>l.id===c.linear.readyLabelId))throw Error('Select this team’s Todo state and agent-ready label');
 if(c.statusSync?.enabled&&(!state(c.statusSync.inProgress,'started')||!state(c.statusSync.inReview,'started')||!state(c.statusSync.done,'completed')))throw Error('Status mapping does not match this team’s workflow categories');
 if(c.featurePlanning?.enabled&&!state(c.featurePlanning.backlogStateId,'backlog'))throw Error('Feature tickets need this team’s Backlog state');
 const p=await ao(`projects/${encodeURIComponent(c.automation.orchestratorProject)}`);
 if(p.status!=='ok'||realpathSync(p.project?.path??'')!==realpathSync(c.repo))throw Error('Registered Orchestrator project must match the repository path');
}
export function saveInitConfig(path:string,c:any){
 mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(c,null,2)+'\n',{flag:'wx',mode:0o600});
}
export function serviceDefinition(config:string,bun=process.execPath,source=resolve(import.meta.dir,'cli.ts'),home=homedir(),label=legacyLabel){
 const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
 const state=join(home,'Library','Application Support','ADLC Bridge');
 const logName=label===legacyLabel?'intake':label;
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${[bun,source,'poll',config].map(x=>`<string>${xml(x)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(dirname(source))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(dirname(bun))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(join(state,`${logName}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(state,`${logName}-error.log`))}</string>
</dict></plist>\n`;
}
export async function initWizard(repoArg?:string,args:string[]=[]){
 if(!stdin.isTTY||!stdout.isTTY)throw Error('Interactive terminal required. Run adlc init in Terminal, or use init REPO --preview.');
 const rl=createInterface({input:stdin,output:stdout});
 const ask=async(label:string,fallback='')=>{const answer=(await rl.question(`${label}${fallback?` [${fallback}]`:''}: `)).trim();return answer||fallback;};
 const yes=async(label:string)=>(await ask(`${label} (yes/no)`,'no')).toLowerCase()==='yes';
 try{
  console.log('ADLC local setup. No Git operations, merges, deployments, or credential copies. Existing files are never replaced.');
  const repo=realpathSync(resolve(repoArg??await ask('Repository path')));
  const name=await ask('Project name',basename(repo));
  const ci=args.indexOf('--config');const path=resolve(ci>=0?args[ci+1]??'':join(import.meta.dir,'..','config',`${basename(repo)}.json`));
  if(ci>=0&&!args[ci+1])throw Error('--config needs a path');
  if(existsSync(path))throw Error(`Configuration already exists: ${path}. Preserved; use another --config path.`);
  if(!linearToken())throw Error('Run adlc auth-linear first to enter your dedicated Linear key locally. Then rerun init.');
  const c:any={version:1,name,repo,githubRepo:await ask('GitHub owner/repository'),automation:{planningEnabled:true,orchestratorProject:await ask('Existing Orchestrator project ID'),maxPlanning:1},linear:{projectId:await ask('Linear project UUID'),teamId:await ask('Linear team UUID'),readyStateId:await ask('Todo state UUID'),readyLabelId:await ask('agent-ready label UUID')},requiredChecks:(await ask('Required GitHub Actions check names (comma separated)')).split(',').map(x=>x.trim()).filter(Boolean),reviewAllowedPaths:(await ask('Allowed review path patterns (comma separated)','src/**')).split(',').map(x=>x.trim()),approval:{mode:'manual'}};
  c.prMetadataChecks=(await ask('PR-description-only CI check names (comma separated; blank for none)')).split(',').map(x=>x.trim()).filter(Boolean);
  if(await yes('Enable shared OpenChamber task routing')){
   c.routing={enabled:true,harness:'opencode-v2',dataDir:resolve(await ask('OpenChamber config directory',join(homedir(),'.config/openchamber'))),runtimeDir:resolve(await ask('OpenChamber routing runtime directory',join(homedir(),'Code/openchamber/packages/web/server/lib/routing')))};
   await loadOpenChamber(c.routing);
  }
  if(await yes('Enable Linear status updates'))c.statusSync={enabled:true,inProgress:await ask('In Progress state UUID'),inReview:await ask('In Review state UUID'),done:await ask('Done state UUID')};
  if(c.routing&&await yes('Enable multi-agent feature planning'))c.featurePlanning={enabled:true,backlogStateId:await ask('Backlog state UUID'),maxAgents:3,maxTickets:25};
  console.log('Manual plan approval is the default. Standing authorization allows every Todo + agent-ready ticket to implement, commit/push its feature branch and open a PR. It never authorizes merge or deploy.');
  if(await yes('Authorize that automatic execution policy')){
   const actor=await ask('Your name');if(!actor)throw Error('Authorizing person required');
   c.approval={mode:'ready-queue',id:`${basename(repo)}-ready-queue-v1`,authorizedBy:actor,scope:c.reviewAllowedPaths,gitScope:'feature-pr'};
  }
  if(await yes('Authorize automatic base-branch updates to owned feature PRs (never merges a PR)')){
   const actor=await ask('Your name for branch update authorization');if(!actor)throw Error('Authorizing person required');
   c.branchUpdate={enabled:true,authorizedBy:actor,maxUpdates:null};
  }
  if(await yes('Enable plan approval replies in Linear from your account')){
   const b=await linearAPI('query{viewer{id name app}}');
   if(!b.viewer?.id||b.viewer.app)throw Error('A human Linear account is required for approval replies');
   console.log(`Approvals will be accepted from ${b.viewer.name} (${b.viewer.id}).`);
   c.planApproval={enabled:true,approverIds:[b.viewer.id],scope:c.approval.scope??c.reviewAllowedPaths};
  }
  await verifyInitConfig(c);
  console.log(JSON.stringify({configuration:path,...c},null,2));
  if(!await yes('Save this exact configuration'))return {cancelled:true,written:false};
  saveInitConfig(path,c);console.log(`Saved ${path}. Provider login and real model requests still require verification in Orchestrator.`);
  {const state=new Store(registryPath());try{const registry=new ProjectServices(state);registry.discoverLegacy();registry.register(path,undefined,false);}finally{state.close();}}
  if(!await yes('Install the reserved-worktree gate in this Orchestrator project (changes project settings)'))return {configuration:path,gateInstalled:false,serviceEnabled:false};
  await installWorkflowHook(path);
  const registryStore=new Store(registryPath());let entry;
  try{const registry=new ProjectServices(registryStore);registry.discoverLegacy();entry=registry.register(path);}finally{registryStore.close();}
  const plist=join(homedir(),'Library/LaunchAgents',`${entry.label}.plist`);
  if(existsSync(plist)){assertDefinition(readDefinition(plist),entry.label,path);return {configuration:path,project:entry.project,gateInstalled:true,existingServicePreserved:true,note:'Existing matching project service preserved. No start/stop was performed.'};}
  if(!await yes('Install this project’s 60-second background service (loads at next login)'))return {configuration:path,project:entry.project,gateInstalled:true,serviceEnabled:false};
  mkdirSync(dirname(plist),{recursive:true});mkdirSync(join(homedir(),'Library/Application Support/ADLC Bridge'),{recursive:true,mode:0o700});
  writeFileSync(plist,serviceDefinition(path,process.execPath,resolve(import.meta.dir,'cli.ts'),homedir(),entry.label),{flag:'wx',mode:0o600});
  if(await yes('Start this project now (can pick up eligible tickets and perform authorized work)'))return {configuration:path,project:entry.project,gateInstalled:true,service:await serviceControl('start',entry.project)};
  return {configuration:path,project:entry.project,gateInstalled:true,serviceEnabled:false,note:'Service installed but not loaded; it can load at next login.'};
 }finally{rl.close();}
}

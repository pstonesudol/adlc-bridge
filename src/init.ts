import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {existsSync,realpathSync,mkdirSync,writeFileSync,readFileSync,mkdtempSync,linkSync,rmSync} from 'node:fs';
import {resolve,join,dirname,basename,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {linearAPI,type LinearAPI} from './linear-api';
import {linearToken} from './credential';
import {validate} from './linear';
import {effectiveSettings,type ProjectSettings} from './project-settings';
import {validScopes} from './file-scope';
import {localAO,installWorkflowHook} from './workflow-transport';
import {loadOpenChamber} from './task-routing';
import {serviceControl} from './service-control';
import {Store} from './core';
import {ProjectServices,registryPath,legacyLabel,readDefinition,assertDefinition} from './project-services';
import {installedCLI} from './install-state';

export async function collectMetadataChecks(ask:(label:string)=>Promise<string>){
 const names:string[]=[];
 for(;;){const name=(await ask('PR-description-only CI check name (production blocked until body attestation exists; one exact name; blank to finish)')).trim();if(!name)return names;if(!names.includes(name))names.push(name);if(names.length>10)throw Error('At most 10 PR metadata checks supported');}
}
export function branchUpdateLimit(answer:string){
 const value=answer.trim().toLowerCase();if(value==='unlimited')return null;
 const limit=Number(value);
 if(!/^\d+$/.test(value)||!Number.isSafeInteger(limit)||limit<1||limit>10)throw Error('branchUpdate.maxUpdates must be an integer from 1 through 10 or "unlimited"');
 return limit;
}
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
export function serviceDefinition(config:string,bun=process.execPath,source=resolve(import.meta.dir,'cli.ts'),home=homedir(),label=legacyLabel,runtimeConfig?:string,settings:ProjectSettings={}){
 if(runtimeConfig!==undefined&&(typeof runtimeConfig!=='string'||!isAbsolute(runtimeConfig)||/[\x00-\x1f]/.test(runtimeConfig)))throw Error('Absolute verification runtime config path required');
 const {pollingIntervalSeconds}=effectiveSettings(settings);
 const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
 const state=join(home,'Library','Application Support','ADLC Bridge');
 const logName=label===legacyLabel?'intake':label;
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${[bun,source,'poll',config].map(x=>`<string>${xml(x)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(dirname(source))}</string>
<key>EnvironmentVariables</key><dict>${runtimeConfig?`<key>ADLC_VERIFICATION_RUNTIME_CONFIG</key><string>${xml(runtimeConfig)}</string>`:''}<key>PATH</key><string>${xml(dirname(bun))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>StartInterval</key><integer>${pollingIntervalSeconds}</integer><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(join(state,`${logName}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(state,`${logName}-error.log`))}</string>
</dict></plist>\n`;
}
export function publishServiceFile(path:string,xml:string){
 const stage=mkdtempSync(join(dirname(path),'.adlc-service-'));
 try{const file=join(stage,'service.plist');writeFileSync(file,xml,{flag:'wx',mode:0o600});linkSync(file,path);}finally{rmSync(stage,{recursive:true,force:true});}
}
export function publishInitService(config:string,home:string,db:string,controller:string,bun=process.execPath,io={write:publishServiceFile,read:readDefinition}){
 const s=new Store(db);try{
  const registry=new ProjectServices(s),entry=registry.register(config),plist=join(home,'Library/LaunchAgents',`${entry.label}.plist`);
  if(existsSync(plist)){
   const def=io.read(plist);
   const bound=s.db.query('SELECT controller FROM project_service_controllers WHERE config=?').get(entry.config);
   if(!bound){assertDefinition(def,entry.label,entry.config,controller);registry.registerController(entry.config,controller);}
   registry.assertInstalled(def,entry.label,entry.config);
   return {configuration:entry.config,project:entry.project,existingServicePreserved:true,serviceEnabled:false,note:'Existing matching project service preserved. No start/stop was performed.'};
  }
  // Persist the known setup input first. A failed/interrupted publication is
  // retried with the same binding; no installed-but-unbound plist can result.
  registry.registerController(entry.config,controller);
  mkdirSync(dirname(plist),{recursive:true});mkdirSync(join(home,'Library/Application Support/ADLC Bridge'),{recursive:true,mode:0o700});
  io.write(plist,serviceDefinition(entry.config,bun,controller,home,entry.label,undefined,JSON.parse(readFileSync(entry.config,'utf8'))));
  return {configuration:entry.config,project:entry.project,existingServicePreserved:false,serviceEnabled:false};
 }finally{s.close();}
}
const wizardIO={interactive:()=>!!stdin.isTTY&&!!stdout.isTTY,prompts:():Pick<ReturnType<typeof createInterface>,'question'|'close'>=>createInterface({input:stdin,output:stdout}),linearToken,verifyInitConfig,registryPath,home:homedir,log:console.log,installWorkflowHook,serviceControl,controller:()=>installedCLI()??resolve(import.meta.dir,'cli.ts'),publish:publishInitService};
export async function initWizard(repoArg?:string,args:string[]=[],overrides:Partial<typeof wizardIO>={}){
  const io={...wizardIO,...overrides};
  if(!io.interactive())throw Error('Interactive terminal required. Run adlc init in Terminal, or use init REPO --preview.');
  const rl=io.prompts(),home=io.home();
 const ask=async(label:string,fallback='')=>{const answer=(await rl.question(`${label}${fallback?` [${fallback}]`:''}: `)).trim();return answer||fallback;};
 const yes=async(label:string)=>(await ask(`${label} (yes/no)`,'no')).toLowerCase()==='yes';
 const complete=async(path:string,c:any)=>{
  const unchanged=()=>{if(JSON.stringify(JSON.parse(readFileSync(path,'utf8')))!==JSON.stringify(c))throw Error('Saved configuration changed during setup; rerun init to revalidate it');};
  unchanged();
  {const state=new Store(io.registryPath());try{const registry=new ProjectServices(state);registry.discoverLegacy(home);registry.register(path,undefined,false);}finally{state.close();}}
  if(!await yes('Install the reserved-worktree gate in this Orchestrator project (changes project settings)'))return {configuration:path,gateInstalled:false,serviceEnabled:false};
  unchanged();
  await io.installWorkflowHook(path);
  unchanged();
  const state=new Store(io.registryPath());let entry;try{const registry=new ProjectServices(state);registry.discoverLegacy(home);entry=registry.register(path);}finally{state.close();}
  const plist=join(home,'Library/LaunchAgents',`${entry.label}.plist`);
  if(!existsSync(plist)&&!await yes(`Install this project’s ${effectiveSettings(c).pollingIntervalSeconds}-second background service (loads at next login)`))return {configuration:path,project:entry.project,gateInstalled:true,serviceEnabled:false};
  unchanged();
  const result=io.publish(path,home,io.registryPath(),io.controller());
  if(result.existingServicePreserved)return {...result,gateInstalled:true};
  if(await yes('Start this project now (can pick up eligible tickets and perform authorized work)'))return {...result,gateInstalled:true,service:await io.serviceControl('start',entry.project)};
  return {...result,gateInstalled:true,note:'Service installed but not loaded; it can load at next login.'};
 };
 try{
   io.log('ADLC local setup. No Git operations, merges, deployments, or credential copies. Existing files are never replaced.');
  const repo=realpathSync(resolve(repoArg??await ask('Repository path')));
  const ci=args.indexOf('--config');const path=resolve(ci>=0?args[ci+1]??'':join(import.meta.dir,'..','config',`${basename(repo)}.json`));
  if(ci>=0&&!args[ci+1])throw Error('--config needs a path');
  if(existsSync(path)){
   const saved=JSON.parse(readFileSync(path,'utf8'));validate(saved);if(realpathSync(saved.repo)!==repo)throw Error('Existing configuration belongs to another repository; preserved');
   if(!await yes('Resume setup using the existing configuration unchanged'))return {configuration:path,cancelled:true,written:false};
   if(!io.linearToken())throw Error('Run adlc auth-linear first, then resume init.');
   await io.verifyInitConfig(saved);return await complete(path,saved);
  }
  const name=await ask('Project name',basename(repo));
   if(!io.linearToken())throw Error('Run adlc auth-linear first to enter your dedicated Linear key locally. Then rerun init.');
  const c:any={version:1,name,repo,githubRepo:await ask('GitHub owner/repository'),automation:{planningEnabled:true,orchestratorProject:await ask('Existing Orchestrator project ID'),maxPlanning:1},linear:{projectId:await ask('Linear project UUID'),teamId:await ask('Linear team UUID'),readyStateId:await ask('Todo state UUID'),readyLabelId:await ask('agent-ready label UUID')},requiredChecks:(await ask('Required GitHub Actions check names (comma separated)')).split(',').map(x=>x.trim()).filter(Boolean),reviewAllowedPaths:(await ask('Allowed review path patterns (comma separated)','src/**')).split(',').map(x=>x.trim()),approval:{mode:'manual'}};
   c.prMetadataChecks=await collectMetadataChecks(ask);
   c.pollingIntervalSeconds=Number(await ask('Polling interval seconds (5–86400)','60'));
   c.automation.maxPlanning=Number(await ask('Concurrent planning stages (1–32; not implementation/review workers)','1'));
   validate(c);
   if(await yes('Enable shared OpenChamber task routing')){
   c.routing={enabled:true,harness:'opencode-v2',dataDir:resolve(await ask('OpenChamber config directory',join(homedir(),'.config/openchamber'))),runtimeDir:resolve(await ask('OpenChamber routing runtime directory',join(homedir(),'Code/openchamber/packages/web/server/lib/routing')))};
   await loadOpenChamber(c.routing);
  }
  if(await yes('Enable Linear status updates'))c.statusSync={enabled:true,inProgress:await ask('In Progress state UUID'),inReview:await ask('In Review state UUID'),done:await ask('Done state UUID')};
  if(c.routing&&await yes('Enable multi-agent feature planning'))c.featurePlanning={enabled:true,backlogStateId:await ask('Backlog state UUID'),maxAgents:3,maxTickets:25};
   io.log('Manual plan approval is the default. Standing authorization allows every Todo + agent-ready ticket to implement, commit/push its feature branch and open a PR. It never authorizes merge or deploy.');
  if(await yes('Authorize that automatic execution policy')){
   const actor=await ask('Your name');if(!actor)throw Error('Authorizing person required');
   c.approval={mode:'ready-queue',id:`${basename(repo)}-ready-queue-v1`,authorizedBy:actor,scope:c.reviewAllowedPaths,gitScope:'feature-pr'};
  }
  if(await yes('Authorize automatic base-branch updates to owned feature PRs (never merges a PR)')){
   const actor=await ask('Your name for branch update authorization');if(!actor)throw Error('Authorizing person required');
    const limit=await ask('Maximum automatic branch updates per PR (1-10, or "unlimited")','3');
    let maxUpdates=branchUpdateLimit(limit);
    if(maxUpdates===null&&!await yes('Explicitly authorize unlimited branch updates, each potentially triggering another CI and CodeRabbit cycle')){maxUpdates=3;io.log('Unlimited updates not authorized; using the finite limit of 3.');}
    c.branchUpdate={enabled:true,authorizedBy:actor,maxUpdates};
  }
  if(await yes('Enable plan approval replies in Linear from your account')){
   const b=await linearAPI('query{viewer{id name app}}');
   if(!b.viewer?.id||b.viewer.app)throw Error('A human Linear account is required for approval replies');
    io.log(`Approvals will be accepted from ${b.viewer.name} (${b.viewer.id}).`);
   c.planApproval={enabled:true,approverIds:[b.viewer.id],scope:c.approval.scope??c.reviewAllowedPaths};
  }
   await io.verifyInitConfig(c);
   io.log(JSON.stringify({configuration:path,...c},null,2));
  if(!await yes('Save this exact configuration'))return {cancelled:true,written:false};
   saveInitConfig(path,c);io.log(`Saved ${path}. Provider login and real model requests still require verification in Orchestrator.`);
   return await complete(path,c);
 }finally{rl.close();}
}

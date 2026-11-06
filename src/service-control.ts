import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Store} from './core';
import {ProjectServices,registryPath,readDefinition} from './project-services';
import {effectiveSettings} from './project-settings';
import {serviceSettings} from './service-settings';
import {turnBarrier,type TurnBarrier} from './turn-submission';
import {assertPollQuiescent,assertPollStarted} from './poll-process';
type StartupWait={attempts:number;pause:()=>Promise<unknown>};
export async function waitForPollStartup<T extends {loaded:boolean;running?:boolean;pid?:number}>(status:()=>Promise<T>,verify:(current:T)=>void,kickstart:()=>Promise<void>,wait:StartupWait={attempts:100,pause:()=>Bun.sleep(100)}){
 await kickstart();let last:unknown;
 for(let attempt=0;attempt<wait.attempts;attempt++){
  const current=await status();
  try{if(!current.loaded)throw Error('Intake service is not loaded');verify(current);return current;}catch(error){last=error;}
  if(attempt+1<wait.attempts)await wait.pause();
 }
 throw Error('Poll startup acknowledgement unavailable; intake startup not confirmed',{cause:last});
}
export async function stopLoadedIntake(status:{loaded:boolean;pid?:number;running?:boolean},config:string,cli:string,bootout:()=>Promise<void>,verify=assertPollQuiescent){
 if(!status.loaded)return;
 verify(status,config,cli);await bootout();
}
export async function launch(args:string[],spawn=Bun.spawn){
 const p=spawn(['/bin/launchctl',...args],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 return {stdout,stderr,code};
}
export async function registeredProjects(readOnly=false,home=homedir(),path=registryPath(),read=readDefinition){
 const s=readOnly?(existsSync(path)?Store.readonly(path):new Store(':memory:')):new Store(path);
 try{const registry=new ProjectServices(s,!readOnly),legacy=registry.discoverLegacy(home,read,!readOnly),entries=registry.list();if(legacy&&!entries.some(p=>p.project===legacy.project))entries.push(legacy);return entries.map(p=>({...p,definitionInstalled:existsSync(join(home,'Library/LaunchAgents',`${p.label}.plist`))}));}finally{s.close();}
}
export async function reloadService(apply:boolean,loaded:boolean,domain:string,target:string,plist:string,run:(args:string[])=>Promise<{code:number}>=launch,beforeUnload:()=>Promise<void>=async()=>{}){
 if(!apply||!loaded)return false;
 await beforeUnload();
 if((await run(['bootout',target])).code!==0)throw Error('Service unload failed; inspect service-status and retry service-config PROJECT --apply');
 if((await run(['bootstrap',domain,plist])).code!==0)throw Error('Service reload failed; inspect service-status and use start PROJECT');
 return true;
}
type ServiceControlOptions={home?:string;statePath?:string;run?:typeof launch;turns?:TurnBarrier;pollState?:string;startupWait?:StartupWait;requireEnabled?:boolean;previewPollingSeconds?:number};
export async function serviceControl(action:string,project?:string,applyOrTurns:boolean|TurnBarrier=false,optionsOrOperate:ServiceControlOptions|((action:string,project?:string)=>Promise<any>)={}){
 const apply=typeof applyOrTurns==='boolean'?applyOrTurns:false;
 const options=typeof optionsOrOperate==='function'?{}:optionsOrOperate;
 const turns=typeof applyOrTurns==='boolean'?(options.turns??turnBarrier()):applyOrTurns;
 const operate=typeof optionsOrOperate==='function'?()=>optionsOrOperate(action,project):()=>controlProject(action,project,apply,options);
 return action==='stop'||action==='start'||action==='service-config'&&apply?turns.run(operate,action==='stop'?'control':'start'):operate();
}
async function controlProject(action:string,project:string|undefined,apply:boolean,options:ServiceControlOptions){
 if(process.platform!=='darwin'||!process.getuid)throw Error('Service controls require macOS');
 const home=options.home??homedir(),run=options.run??launch;
 const recovery=action==='stop'||action==='service-status';
 const readOnly=action==='service-status'||action==='service-config'&&!apply,path=options.statePath??registryPath(),s=readOnly?(existsSync(path)?Store.readonly(path):new Store(':memory:')):new Store(path);
 try{
   const registry=new ProjectServices(s,!readOnly),legacy=registry.discoverLegacy(home,readDefinition,!readOnly,recovery),extra=legacy?[legacy]:[],entries=registry.list();if(legacy&&!entries.some(p=>p.project===legacy.project))entries.push(legacy);
   if(action==='service-status'&&!project&&entries.length>1){
    const results=[];for(const p of entries)results.push(await serviceControl(action,p.project,false,options));return results;
  }
   if(action==='service-config'&&!project)throw Error('Explicit project ID required');
   const entry=registry.select(project,extra),projectConfig=registry.verify(entry,!recovery);
   if(options.previewPollingSeconds!==undefined){if(action!=='service-config'||apply)throw Error('Proposed settings are preview-only');projectConfig.pollingIntervalSeconds=options.previewPollingSeconds;effectiveSettings(projectConfig);}
   let settings:ReturnType<typeof effectiveSettings>|undefined,settingsError:string|undefined;
   try{settings=effectiveSettings(projectConfig);}catch(e){if(!recovery)throw e;settingsError=e instanceof Error?e.message:'Invalid runtime settings';}
  const label=entry.label,domain=`gui/${process.getuid()}`,target=`${domain}/${label}`,plist=join(home,'Library/LaunchAgents',`${label}.plist`);
  if(existsSync(plist))registry.assertInstalled(readDefinition(plist),label,entry.config,!readOnly);
  const status=async()=>{
   const r=await run(['print',target]);
   if(r.code!==0&&!/Could not find service/.test(r.stderr+r.stdout))throw Error('Unable to inspect background service');
    const pid=r.stdout.match(/^\s*pid = (\d+)\s*$/m);
    return {loaded:r.code===0,running:r.code===0&&/state = running/.test(r.stdout),...(pid?{pid:Number(pid[1])}:{})};
  };
  if(action==='service-status')return {project:entry.project,service:label,...await status(),definitionInstalled:existsSync(plist),intervalSeconds:settings?.pollingIntervalSeconds??null,...settings,settingsError,installedIntervalSeconds:existsSync(plist)?readDefinition(plist).StartInterval:null};
  if(action==='service-config'){
   const current=await status(),def=readDefinition(plist);
   if(apply&&current.loaded&&options.requireEnabled){
    const disabled=await run(['print-disabled',domain]);
    if(disabled.code!==0||!disabled.stdout.includes(`"${label}" => false`))throw Error('Service enabled state is unverified; use explicit service configuration workflow');
   }
   // Verify quiescence before updating a loaded definition, not just at bootout.
   const verify=()=>assertPollQuiescent(current,entry.config,def.ProgramArguments[1],options.pollState);
   if(apply&&current.loaded)verify();
   const update=serviceSettings(plist,label,entry.config,projectConfig,apply,def=>registry.assertInstalled(def,label,entry.config,!readOnly));
   const reloaded=await reloadService(apply,current.loaded,domain,target,plist,run,async()=>verify());
   if(reloaded)await waitForPollStartup(status,observed=>assertPollStarted(observed,entry.config,def.ProgramArguments[1],options.pollState),async()=>{const r=await run(['kickstart',target]);if(r.code!==0)throw Error('Could not request poll startup');},options.startupWait);
   return {project:entry.project,...update,reloaded,workerSessionsStopped:false};
  }
  if(!['start','stop'].includes(action))throw Error('Unknown service action');
  let current=await status();
  if(action==='start'){const enabled=await run(['enable',target]);if(enabled.code!==0)throw Error('Could not enable background service');}
  if(action==='start'&&!current.loaded){
   if(!existsSync(plist))throw Error('Background service definition is missing; complete project service installation');
   const r=await run(['bootstrap',domain,plist]);if(r.code!==0)throw Error('Could not start background service');
  }
   if(action==='stop'){
    if(current.loaded&&!existsSync(plist))throw Error('Cannot verify loaded intake definition; preserved');
    if(current.loaded){const def=readDefinition(plist);await stopLoadedIntake(current,entry.config,def.ProgramArguments[1],async()=>{const r=await run(['bootout',target]);if(r.code!==0)throw Error('Could not stop background service');},(observed,config,cli)=>assertPollQuiescent(observed,config,cli,options.pollState));}
   }
  for(let attempt=0;attempt<100;attempt++){current=await status();if(current.loaded===(action==='start'))break;await Bun.sleep(100);}
   if(current.loaded!==(action==='start'))throw Error('Service state did not match requested action');
   if(action==='start'){
    const def=readDefinition(plist);
    current=await waitForPollStartup(status,observed=>assertPollStarted(observed,entry.config,def.ProgramArguments[1],options.pollState),async()=>{const r=await run(['kickstart',target]);if(r.code!==0)throw Error('Could not request poll startup');},options.startupWait);
   }
  return {project:entry.project,service:label,...current,...settings,settingsError,workerSessionsStopped:false,note:action==='stop'?'Background coordination stopped. Existing Orchestrator workers continue independently.':`Background coordination enabled; installed interval ${readDefinition(plist).StartInterval} seconds. Use service-config to preview/apply config changes.`};
 }finally{s.close();}
}

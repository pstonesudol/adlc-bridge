import {existsSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Store} from './core';
import {ProjectServices,registryPath,assertDefinition,readDefinition} from './project-services';
import {effectiveSettings} from './project-settings';
import {serviceSettings} from './service-settings';
async function launch(args:string[]){
 const p=Bun.spawn(['/bin/launchctl',...args],{stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 return {stdout,stderr,code};
}
export async function reloadService(apply:boolean,loaded:boolean,domain:string,target:string,plist:string,run:(args:string[])=>Promise<{code:number}>=launch){
 // Explicit apply also retries a previous failed unload after the file was updated.
 if(!apply||!loaded)return false;
 if((await run(['bootout',target])).code!==0)throw Error('Service unload failed; inspect service-status and retry service-config PROJECT --apply');
 if((await run(['bootstrap',domain,plist])).code!==0)throw Error('Service reload failed; inspect service-status and use start PROJECT');
 return true;
}
export async function registeredProjects(){
 const s=new Store(registryPath());try{const registry=new ProjectServices(s);registry.discoverLegacy();return registry.list().map(p=>({...p,definitionInstalled:existsSync(join(homedir(),'Library/LaunchAgents',`${p.label}.plist`))}));}finally{s.close();}
}
export async function serviceControl(action:string,project?:string,apply=false){
 if(process.platform!=='darwin'||!process.getuid)throw Error('Service controls require macOS');
 const s=new Store(registryPath());
 try{
  const registry=new ProjectServices(s);registry.discoverLegacy();
  if(action==='service-status'&&!project&&registry.list().length>1){
   const results=[];for(const p of registry.list())results.push(await serviceControl(action,p.project));return results;
  }
   if(action==='service-config'&&!project)throw Error('Explicit project ID required');
   const entry=registry.select(project);registry.verify(entry);
   const projectConfig=JSON.parse(readFileSync(entry.config,'utf8')),settings=effectiveSettings(projectConfig);
  const label=entry.label,domain=`gui/${process.getuid()}`,target=`${domain}/${label}`,plist=join(homedir(),'Library/LaunchAgents',`${label}.plist`);
  if(existsSync(plist))assertDefinition(readDefinition(plist),label,entry.config);
  const status=async()=>{
   const r=await launch(['print',target]);
   if(r.code!==0&&!/Could not find service/.test(r.stderr+r.stdout))throw Error('Unable to inspect background service');
   return {loaded:r.code===0,running:r.code===0&&/state = running/.test(r.stdout)};
  };
   if(action==='service-status')return {project:entry.project,service:label,...await status(),definitionInstalled:existsSync(plist),intervalSeconds:settings.pollingIntervalSeconds,...settings,installedIntervalSeconds:existsSync(plist)?readDefinition(plist).StartInterval:null};
   if(action==='service-config'){
    const current=await status();
    const update=serviceSettings(plist,label,entry.config,projectConfig,apply);
    const reloaded=await reloadService(apply,current.loaded,domain,target,plist);
    return {project:entry.project,...update,reloaded,workerSessionsStopped:false};
   }
  if(!['start','stop'].includes(action))throw Error('Unknown service action');
  let current=await status();
  if(action==='start'&&!current.loaded){
   if(!existsSync(plist))throw Error('Background service definition is missing; complete project service installation');
   const r=await launch(['bootstrap',domain,plist]);if(r.code!==0)throw Error('Could not start background service');
  }
  if(action==='stop'&&current.loaded){const r=await launch(['bootout',target]);if(r.code!==0)throw Error('Could not stop background service');}
  current=await status();if(current.loaded!==(action==='start'))throw Error('Service state did not match requested action');
   return {project:entry.project,service:label,...current,...settings,workerSessionsStopped:false,note:action==='stop'?'Background coordination stopped. Existing Orchestrator workers continue independently.':`Background coordination enabled; installed interval ${readDefinition(plist).StartInterval} seconds. Use service-config to preview/apply config changes.`};
 }finally{s.close();}
}

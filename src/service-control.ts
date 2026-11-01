import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Store} from './core';
import {ProjectServices,registryPath,assertDefinition,readDefinition} from './project-services';
import {turnBarrier,type TurnBarrier} from './turn-submission';
import {assertPollQuiescent,assertPollStarted} from './poll-process';
export async function waitForPollStartup<T extends {loaded:boolean;running?:boolean;pid?:number}>(status:()=>Promise<T>,verify:(current:T)=>void,kickstart:()=>Promise<void>,wait={attempts:100,pause:()=>Bun.sleep(100)}){
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
async function launch(args:string[]){
 const p=Bun.spawn(['/bin/launchctl',...args],{stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 return {stdout,stderr,code};
}
export async function registeredProjects(readOnly=false,home=homedir(),path=registryPath(),read=readDefinition){
 const s=readOnly?(existsSync(path)?Store.readonly(path):new Store(':memory:')):new Store(path);
 try{const registry=new ProjectServices(s,!readOnly),legacy=registry.discoverLegacy(home,read,!readOnly),entries=registry.list();if(legacy&&!entries.some(p=>p.project===legacy.project))entries.push(legacy);return entries.map(p=>({...p,definitionInstalled:existsSync(join(home,'Library/LaunchAgents',`${p.label}.plist`))}));}finally{s.close();}
}
export async function serviceControl(action:string,project?:string,turns:TurnBarrier=turnBarrier(),operate=controlProject){
 return action==='stop'?turns.run(()=>operate(action,project)):operate(action,project);
}
async function controlProject(action:string,project?:string){
 if(process.platform!=='darwin'||!process.getuid)throw Error('Service controls require macOS');
 const readOnly=action==='service-status',path=registryPath(),s=readOnly?(existsSync(path)?Store.readonly(path):new Store(':memory:')):new Store(path);
 try{
   const registry=new ProjectServices(s,!readOnly),legacy=registry.discoverLegacy(homedir(),readDefinition,!readOnly),extra=legacy?[legacy]:[],entries=registry.list();if(legacy&&!entries.some(p=>p.project===legacy.project))entries.push(legacy);
   if(action==='service-status'&&!project&&entries.length>1){
    const results=[];for(const p of entries)results.push(await serviceControl(action,p.project));return results;
  }
   const entry=registry.select(project,extra);registry.verify(entry);
  const label=entry.label,domain=`gui/${process.getuid()}`,target=`${domain}/${label}`,plist=join(homedir(),'Library/LaunchAgents',`${label}.plist`);
  if(existsSync(plist))assertDefinition(readDefinition(plist),label,entry.config);
  const status=async()=>{
   const r=await launch(['print',target]);
   if(r.code!==0&&!/Could not find service/.test(r.stderr+r.stdout))throw Error('Unable to inspect background service');
    const pid=r.stdout.match(/^\s*pid = (\d+)\s*$/m);
    return {loaded:r.code===0,running:r.code===0&&/state = running/.test(r.stdout),...(pid?{pid:Number(pid[1])}:{})};
  };
  if(action==='service-status')return {project:entry.project,service:label,...await status(),definitionInstalled:existsSync(plist),intervalSeconds:60};
  if(!['start','stop'].includes(action))throw Error('Unknown service action');
  let current=await status();
  if(action==='start'){const enabled=await launch(['enable',target]);if(enabled.code!==0)throw Error('Could not enable background service');}
  if(action==='start'&&!current.loaded){
   if(!existsSync(plist))throw Error('Background service definition is missing; complete project service installation');
   const r=await launch(['bootstrap',domain,plist]);if(r.code!==0)throw Error('Could not start background service');
  }
   if(action==='stop'){
    if(current.loaded&&!existsSync(plist))throw Error('Cannot verify loaded intake definition; preserved');
    if(current.loaded){const def=readDefinition(plist);await stopLoadedIntake(current,entry.config,def.ProgramArguments[1],async()=>{const r=await launch(['bootout',target]);if(r.code!==0)throw Error('Could not stop background service');});}
   }
  for(let attempt=0;attempt<100;attempt++){current=await status();if(current.loaded===(action==='start'))break;await Bun.sleep(100);}
   if(current.loaded!==(action==='start'))throw Error('Service state did not match requested action');
   if(action==='start'){
    const def=readDefinition(plist);
    current=await waitForPollStartup(status,observed=>assertPollStarted(observed,entry.config,def.ProgramArguments[1]),async()=>{const r=await launch(['kickstart',target]);if(r.code!==0)throw Error('Could not request poll startup');});
   }
  return {project:entry.project,service:label,...current,workerSessionsStopped:false,note:action==='stop'?'Background coordination stopped. Existing Orchestrator workers continue independently.':'Background coordination enabled; polls approximately every 60 seconds.'};
 }finally{s.close();}
}

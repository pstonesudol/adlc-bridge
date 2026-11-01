import {existsSync,lstatSync,readFileSync,mkdirSync,rmdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {AO} from './orchestrator';
import {trustedDaemon} from './daemon-runtime';
import {registeredProjects,serviceControl} from './service-control';
import {readDefinition} from './project-services';
import {turnBarrier,type TurnBarrier} from './turn-submission';

type Backend={loaded:boolean;ready:boolean;managed:boolean;pid?:number};
export type StackOps={
 projects():Promise<{project:string}[]>;
 project(action:'start'|'stop'|'service-status',id:string):Promise<any>;
 backend():Promise<Backend>;
 backendStart():Promise<void>;
 backendStop():Promise<void>;
 blockers():Promise<{session:string;reason:string}[]>;
 turns:TurnBarrier;
};
// Pause every intake before checking workers. A refusal deliberately leaves intake
// paused, so retries cannot pick up more work while the user finishes existing work.
export async function controlStack(action:'start'|'stop'|'status',ops:StackOps){
 const projects=await ops.projects();
 if(action==='status')return {scope:'all',backend:await ops.backend(),projects:await Promise.all(projects.map(p=>ops.project('service-status',p.project)))};
 if(action==='start'){
  const backend=await ops.turns.run(async()=>{
   await ops.backendStart();
   const backend=await ops.backend();if(!backend.ready||!backend.managed)throw Error('Managed Orchestrator is not ready; intake remains stopped');
   ops.turns.resume();return backend;
  });
  const results=[];for(const p of projects)results.push(await ops.project('start',p.project));
  return {scope:'all',backend,projects:results};
 }
 const results=[];for(const p of projects)results.push(await ops.project('stop',p.project));
 return ops.turns.run(async()=>{
 ops.turns.pause();
 const backend=await ops.backend();
 if(backend.ready){
  if(!backend.managed)throw Error('Intake paused. Orchestrator is not managed by this bridge; backend preserved');
  const blockers=await ops.blockers();
  if(blockers.length)throw Error(`Intake paused; Orchestrator kept running. Finish or stop these workers in Orchestrator, then retry: ${blockers.map(b=>`${b.session} (${b.reason})`).join(', ')}`);
 }
 await ops.backendStop();
 const stopped=await ops.backend();if(stopped.ready||stopped.loaded)throw Error('Intake paused, but Orchestrator has not fully stopped');
 return {scope:'all',backend:stopped,projects:results,note:'Background stack stopped and disabled at login. Start --all re-enables it. The desktop window may remain open.'};
 });
}
async function command(args:string[]){
 const p=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {stdout,stderr,code};
}
const stateDir=()=>join(homedir(),'Library/Application Support/ADLC Bridge');
function owned(path:string){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o022)!==0)throw Error('Managed service files must be owned by you and not writable by others');}
function definition(){
 const path=join(stateDir(),'orchestrator-runtime.json');owned(path);
 const pin=JSON.parse(readFileSync(path,'utf8'));
 if(!/^local\.adlc\.[a-z0-9.-]+$/.test(pin.serviceLabel??''))throw Error('No managed Orchestrator service registered');
 if(!trustedDaemon(pin.executable))throw Error('Managed Orchestrator binary does not match its registered hash');
 const plist=join(homedir(),'Library/LaunchAgents',pin.serviceLabel+'.plist');owned(plist);
 const d=readDefinition(plist);
 if(d.Label!==pin.serviceLabel||!Array.isArray(d.ProgramArguments)||d.ProgramArguments.length!==2||d.ProgramArguments[1]!==pin.launcher)throw Error('Managed Orchestrator service definition changed');
 owned(pin.launcher);
 return {...pin,plist,target:`gui/${process.getuid()}/${pin.serviceLabel}`,domain:`gui/${process.getuid()}`};
}
async function loaded(target:string){
 const r=await command(['/bin/launchctl','print',target]);
 if(r.code!==0&&!/Could not find service/.test(r.stdout+r.stderr))throw Error('Unable to inspect Orchestrator service');
 return r.code===0;
}
export function daemonStatus(r:{stdout:string;code:number}){
 let s:any;try{s=JSON.parse(r.stdout);}catch{throw Error('Unable to inspect Orchestrator daemon');}
 if(r.code===0&&(s?.state==='stopped'||s?.state==='not_running'))return {ready:false};
 if(r.code!==0||s?.state!=='ready'||!Number.isSafeInteger(s.port)||s.port<1||s.port>65535)throw Error('Orchestrator readiness is unknown; backend preserved');
 return {...s,ready:true};
}
async function probe(){return daemonStatus(await command([AO,'status','--json']));}
async function get(port:number,path:string){
 const r=await fetch(`http://127.0.0.1:${port}/api/v1/${path}`,{signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('Cannot verify worker activity; intake paused and backend preserved');return r.json() as Promise<any>;
}
const terminalTurns=new Set(['completed','recovered','interrupted','failed','cancelled']);
export function activityBlockers(sessions:any[]){
 return sessions.filter(s=>!s.isTerminated&&s.activity?.state!=='exited'&&s.activity?.state!=='idle').map(s=>({session:String(s.id),reason:s.activity?.state??'unknown activity'}));
}
export function turnBlockers(session:string,c:any){
 if(!Array.isArray(c.turns))throw Error(`Cannot verify queued work for ${session}; backend preserved`);
 const bad=c.turns.filter((t:any)=>!terminalTurns.has(t.state));
 return bad.map((t:any)=>({session,reason:`${t.state??'unknown'} turn`}));
}
export async function workerBlockers(executable:string,inspect=probe,read=get){
 const s=await inspect();if(!s.ready||s.executablePath!==executable)throw Error('Managed backend identity changed; preserved');
 const scan=async(sessions:any[])=>{
  const blocked=activityBlockers(sessions);
  for(const x of sessions){
   if(x.isTerminated||x.activity?.state==='exited')continue;
   if(typeof x.id!=='string'||! /^[\w-]+$/.test(x.id))throw Error('Invalid worker identity; backend preserved');
   blocked.push(...turnBlockers(x.id,await read(s.port,`sessions/${x.id}/conversation`)));
  }
  return blocked;
 };
 const snapshot=await read(s.port,'sessions');if(!Array.isArray(snapshot?.sessions))throw Error('Cannot verify worker inventory; backend preserved');
 const blocked=await scan(snapshot.sessions);
 // Re-read turns as well as activity: idle activity can lag a newly queued turn.
 const latest=await read(s.port,'sessions');if(!Array.isArray(latest?.sessions))throw Error('Cannot recheck workers; backend preserved');
 blocked.push(...await scan(latest.sessions));
 const ids=new Set(snapshot.sessions.map((x:any)=>x.id));for(const x of latest.sessions)if(!ids.has(x.id)&&!x.isTerminated)blocked.push({session:x.id,reason:'new session during stop'});
 return blocked;
}
export function liveStackOps():StackOps{
 const config=definition();
 return {
  turns:turnBarrier(),
  projects:registeredProjects,
  project:async(action,id)=>{
   // Full-stack controls persist the user's on/off choice across login.
   const entries=await registeredProjects(),p=entries.find(x=>x.project===id);if(!p)throw Error('Unknown project');
   if(action==='start'){const r=await command(['/bin/launchctl','enable',`${config.domain}/${p.label}`]);if(r.code!==0)throw Error('Could not enable project service');}
   const result=await serviceControl(action,id);
   if(action==='stop'){const r=await command(['/bin/launchctl','disable',`${config.domain}/${p.label}`]);if(r.code!==0)throw Error('Intake stopped but could not disable login startup');}
   return result;
  },
  backend:async()=>{const s=await probe();return {loaded:await loaded(config.target),ready:s.ready,managed:s.ready?s.executablePath===config.executable&&trustedDaemon(s.executablePath):true,...(s.ready?{pid:s.pid}:{})};},
  backendStart:async()=>{
   const s=await probe();if(s.ready&&s.executablePath!==config.executable)throw Error('Another Orchestrator backend is running; preserved');
   const enabled=await command(['/bin/launchctl','enable',config.target]);if(enabled.code!==0)throw Error('Could not enable Orchestrator service');
   if(!await loaded(config.target)){const r=await command(['/bin/launchctl','bootstrap',config.domain,config.plist]);if(r.code!==0)throw Error('Could not start Orchestrator service');}
   for(let i=0;i<100;i++){try{const p=await probe();if(p.ready&&p.executablePath===config.executable)return;}catch{}await Bun.sleep(200);}
   throw Error('Orchestrator did not become ready; intake was not started');
  },
  backendStop:async()=>{
   const r=await command(['/bin/launchctl','disable',config.target]);if(r.code!==0)throw Error('Unable to disable Orchestrator login startup');
   if(await loaded(config.target)){const b=await command(['/bin/launchctl','bootout',config.target]);if(b.code!==0)throw Error('Could not stop managed Orchestrator');}
   for(let i=0;i<100;i++){try{if(!(await probe()).ready&&!await loaded(config.target))return;}catch{}await Bun.sleep(200);}
   throw Error('Orchestrator shutdown is still pending');
  },
  blockers:()=>workerBlockers(config.executable)
 };
}
export async function stackControl(action:'start'|'stop'|'status'){
 if(process.platform!=='darwin')throw Error('Full-stack controls require macOS');
 if(action==='status')return controlStack(action,liveStackOps());
 const lock=join(stateDir(),'stack-control.lock');
 mkdirSync(stateDir(),{recursive:true,mode:0o700});
 try{mkdirSync(lock);}catch(e:any){if(e?.code==='EEXIST')throw Error('Another stack control is in progress. If interrupted, inspect services before removing stack-control.lock');throw e;}
 try{return await controlStack(action,liveStackOps());}finally{try{rmdirSync(lock);}catch{console.error('Stack lock cleanup needs inspection:',lock);}}
}

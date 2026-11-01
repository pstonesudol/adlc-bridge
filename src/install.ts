import {readdirSync,lstatSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync,copyFileSync,renameSync,unlinkSync} from 'node:fs';
import {atomicFile as atomic} from './atomic-file';
import {trustedDaemon} from './daemon-runtime';
import {definitionXML} from './project-services';
import {join,resolve,dirname} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';
import {appState,installedCLI,verifiedInstallationSource} from './install-state';import {registeredProjects,serviceControl} from './service-control';import {serviceDefinition} from './init';import {readDefinition,assertDefinition} from './project-services';import {localAO,installWorkflowHook} from './workflow-transport';
export function distributionFiles(root:string){
 const files:string[]=[];
 function walk(dir:string){for(const name of readdirSync(join(root,dir)).sort()){const rel=join(dir,name),st=lstatSync(join(root,rel));if(name==='__pycache__'||name.endsWith('.pyc'))continue;if(st.isSymbolicLink())throw Error('Distribution cannot contain symlinks');if(st.isDirectory())walk(rel);else if(st.isFile())files.push(rel);}}
 for(const dir of ['src','scripts','patches'])if(existsSync(join(root,dir)))walk(dir);
 for(const f of ['package.json','LICENSE','README.md','AGENTS.md'])if(existsSync(join(root,f)))files.push(f);
 return files.sort();
}
export function snapshot(root:string,destination:string,copy=copyFileSync){
 const files=distributionFiles(root),hash=createHash('sha256');for(const f of files)hash.update(f+'\0').update(readFileSync(join(root,f))).update('\0');const version=hash.digest('hex');
 const target=join(destination,version);
 if(!existsSync(target)){
  mkdirSync(destination,{recursive:true,mode:0o700});const stage=mkdtempSync(join(destination,'.snapshot-'));
  try{
   const copied=createHash('sha256');
   for(const f of files){mkdirSync(dirname(join(stage,f)),{recursive:true});copy(join(root,f),join(stage,f));copied.update(f+'\0').update(readFileSync(join(stage,f))).update('\0');}
   if(copied.digest('hex')!==version)throw Error('Source changed during snapshot; retry from a stable checkout');
   writeFileSync(join(stage,'manifest.json'),JSON.stringify({version,files},null,2)+'\n',{mode:0o600});renameSync(stage,target);
  }finally{rmSync(stage,{recursive:true,force:true});}
 }
 else for(const f of files)if(!readFileSync(join(target,f)).equals(readFileSync(join(root,f))))throw Error('Installed snapshot changed; preserved for inspection');
 return {version,cli:join(target,'src/cli.ts'),files:files.length};
}
const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";
const installIO={registeredProjects,serviceControl,localAO,installWorkflowHook,readDefinition,assertDefinition,trustedDaemon,state:appState,home:homedir};
function runtimeMigration(state:string,home:string,io:typeof installIO){
 const pinPath=join(state,'orchestrator-runtime.json');if(!existsSync(pinPath))return null;
 const owned=(path:string,privateFile=false)=>{const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&(privateFile?0o077:0o022)))throw Error('Runtime migration requires trusted owner-controlled files');};
 owned(pinPath,true);const pinBytes=readFileSync(pinPath),pin=JSON.parse(pinBytes.toString());
 if(!/^local\.adlc\.[a-z0-9.-]+$/.test(pin.serviceLabel??'')||typeof pin.launcher!=='string'||!pin.launcher.startsWith('/'))throw Error('Invalid runtime registration; preserved');
 if(!io.trustedDaemon(pin.executable,pinPath))throw Error('Runtime migration requires a trusted pinned executable');
 owned(pin.launcher);const plist=join(home,'Library/LaunchAgents',pin.serviceLabel+'.plist');owned(plist);const def=io.readDefinition(plist);
 if(def.Label!==pin.serviceLabel||!Array.isArray(def.ProgramArguments)||def.ProgramArguments.length!==2||def.ProgramArguments[0]!=='/usr/bin/python3'||def.ProgramArguments[1]!==pin.launcher)throw Error('Runtime definition changed; preserved');
 return {pinPath,pinBytes,pin,plist,def,plistBytes:readFileSync(plist)};
}
export async function installBridge(apply=false,root=resolve(import.meta.dir,'..'),bin?:string,io=installIO){
  if(root.includes('/ADLC Bridge/versions/'))root=verifiedInstallationSource(io.state())??root;
 const projects=await io.registeredProjects(!apply);
 const launcher=bin??(existsSync('/opt/homebrew/bin/adlc')?'/opt/homebrew/bin/adlc':join(io.home(),'.local/bin/adlc'));
 if(existsSync(launcher)){const st=lstatSync(launcher);if(!st.isFile()||st.isSymbolicLink()||!readFileSync(launcher,'utf8').includes('src/cli.ts'))throw Error('Existing launcher is not recognizable; choose --bin PATH');}
 const definitions=projects.map(p=>{const path=join(io.home(),'Library/LaunchAgents',p.label+'.plist');if(!existsSync(path))return {p,path,def:null,original:null};const def=io.readDefinition(path);io.assertDefinition(def,p.label,p.config);return {p,path,def,original:readFileSync(path)};});
 const runtime=runtimeMigration(io.state(),io.home(),io);
 if(!apply)return {preview:true,source:root,launcher,projects:projects.map(p=>p.project),files:distributionFiles(root),runtimeLauncherMigration:!!runtime,note:'Apply creates a pinned runtime snapshot, pauses intake during activation, migrates gates/services and restores prior intake state. No workers are stopped. Runtime launcher changes take effect at the next guarded stop/start.'};
 const built=snapshot(root,join(io.state(),'versions'));const backup=join(io.state(),'backups',`install-${Date.now()}`);mkdirSync(backup,{recursive:true,mode:0o700});
 const recordPath=join(io.state(),'installation.json');const oldRecord=existsSync(recordPath)?readFileSync(recordPath):null;const oldLauncher=existsSync(launcher)?readFileSync(launcher):null;
 const active:string[]=[];
 const restarted:string[]=[];
 let runtimeChanged=false;
 const originalProjects=[];for(const p of projects){const b=await io.localAO(`projects/${p.project}`);if(b.status!=='ok'||!b.project?.config)throw Error('Cannot back up project settings');originalProjects.push({id:p.project,config:b.project.config});}
 try{
  for(const {p,def,original} of definitions){if(!def)continue;const current=await io.serviceControl('service-status',p.project);if(current.loaded){active.push(p.project);await io.serviceControl('stop',p.project);}writeFileSync(join(backup,p.label+'.plist'),original!,{mode:0o600});}
  atomic(recordPath,JSON.stringify({source:root,...built,launcher,installedAt:new Date().toISOString()},null,2)+'\n');
  for(const {p,path,def} of definitions){if(def){const xml=serviceDefinition(p.config,process.execPath,built.cli,io.home(),p.label);atomic(path,xml);}await io.installWorkflowHook(p.config);}
  if(runtime){
   const nextLauncher=join(dirname(built.cli),'serve-orchestrator.py');if(!existsSync(nextLauncher))throw Error('Installed runtime launcher is missing');
   if(!readFileSync(runtime.pinPath).equals(runtime.pinBytes)||!readFileSync(runtime.plist).equals(runtime.plistBytes))throw Error('Runtime registration changed during installation; preserved');
   writeFileSync(join(backup,'orchestrator-runtime.json'),runtime.pinBytes,{mode:0o600});writeFileSync(join(backup,'orchestrator-runtime.plist'),runtime.plistBytes,{mode:0o600});
   runtimeChanged=true;
   atomic(runtime.plist,definitionXML({...runtime.def,ProgramArguments:['/usr/bin/python3',nextLauncher]}));
   atomic(runtime.pinPath,JSON.stringify({...runtime.pin,launcher:nextLauncher},null,2)+'\n');
   if(!io.trustedDaemon(runtime.pin.executable,runtime.pinPath))throw Error('Runtime migration failed trust verification');
  }
  atomic(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(built.cli)} "$@"\n`,0o755);
  for(const id of active){restarted.push(id);await io.serviceControl('start',id);}
  return {installed:true,...built,launcher,backup,projects:projects.map(p=>p.project),runtimeRestartRequired:!!runtime,note:runtime?'Runtime launcher migrated. Use guarded stop --all/start --all to activate it; no backend was restarted.':undefined};
  }catch(e){
   // Restore intake definitions/launcher; keep backups and the immutable snapshot.
   const rollbackErrors:Error[]=[];
   const failed=(operation:string,target:string,error:unknown)=>rollbackErrors.push(new Error(`${operation} needs inspection: ${target}`,{cause:error}));
   for(const id of restarted)try{await io.serviceControl('stop',id);}catch(error){failed('Intake rollback pause',id,error);}
   try{if(oldRecord)atomic(recordPath,oldRecord.toString());else if(existsSync(recordPath))unlinkSync(recordPath);}catch(error){failed('Installation record rollback',recordPath,error);}
   for(const p of originalProjects)try{await io.localAO(`projects/${p.id}/config`,'PUT',{config:p.config});}catch(error){failed('Project settings rollback',p.id,error);}
   for(const {path,original} of definitions)if(original)try{atomic(path,original);}catch(error){failed('Service rollback',path,error);}
   if(runtimeChanged&&runtime)for(const [path,bytes] of [[runtime.pinPath,runtime.pinBytes],[runtime.plist,runtime.plistBytes]] as const)try{atomic(path,bytes);}catch(error){failed('Runtime launcher rollback',path,error);}
   try{if(oldLauncher)atomic(launcher,oldLauncher.toString(),0o755);else if(existsSync(launcher))unlinkSync(launcher);}catch(error){failed('Launcher rollback',launcher,error);}
   for(const id of active)try{await io.serviceControl('start',id);}catch(error){failed('Intake restart',id,error);}
   if(rollbackErrors.length)throw new AggregateError([e,...rollbackErrors],`Installation failed (${e instanceof Error?e.message:String(e)}) and rollback was incomplete; ${rollbackErrors.map(error=>error.message).join('; ')}`);
   throw e;
 }
}

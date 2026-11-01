import {readdirSync,lstatSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync,copyFileSync,renameSync,unlinkSync} from 'node:fs';
import {atomicFile as atomic} from './atomic-file';
import {join,resolve,dirname} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';
import {appState,installedCLI} from './install-state';import {registeredProjects,serviceControl} from './service-control';import {serviceDefinition} from './init';import {readDefinition,assertDefinition} from './project-services';import {localAO,installWorkflowHook} from './workflow-transport';
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
const installIO={registeredProjects,serviceControl,localAO,installWorkflowHook,readDefinition,assertDefinition,state:appState,home:homedir};
export async function installBridge(apply=false,root=resolve(import.meta.dir,'..'),bin?:string,io=installIO){
 if(root.includes('/ADLC Bridge/versions/')&&existsSync(join(io.state(),'installation.json')))root=JSON.parse(readFileSync(join(io.state(),'installation.json'),'utf8')).source;
 const projects=await io.registeredProjects();
 const launcher=bin??(existsSync('/opt/homebrew/bin/adlc')?'/opt/homebrew/bin/adlc':join(io.home(),'.local/bin/adlc'));
 if(existsSync(launcher)){const st=lstatSync(launcher);if(!st.isFile()||st.isSymbolicLink()||!readFileSync(launcher,'utf8').includes('src/cli.ts'))throw Error('Existing launcher is not recognizable; choose --bin PATH');}
 const definitions=projects.map(p=>{const path=join(io.home(),'Library/LaunchAgents',p.label+'.plist');if(!existsSync(path))return {p,path,def:null,original:null};const def=io.readDefinition(path);io.assertDefinition(def,p.label,p.config);return {p,path,def,original:readFileSync(path)};});
 if(!apply)return {preview:true,source:root,launcher,projects:projects.map(p=>p.project),files:distributionFiles(root),note:'Apply creates a pinned runtime snapshot, pauses intake during activation, migrates gates/services and restores prior intake state. No workers are stopped.'};
 const built=snapshot(root,join(io.state(),'versions'));const backup=join(io.state(),'backups',`install-${Date.now()}`);mkdirSync(backup,{recursive:true,mode:0o700});
 const recordPath=join(io.state(),'installation.json');const oldRecord=existsSync(recordPath)?readFileSync(recordPath):null;const oldLauncher=existsSync(launcher)?readFileSync(launcher):null;
 const active:string[]=[];
 const restarted:string[]=[];
 const originalProjects=[];for(const p of projects){const b=await io.localAO(`projects/${p.project}`);if(b.status!=='ok'||!b.project?.config)throw Error('Cannot back up project settings');originalProjects.push({id:p.project,config:b.project.config});}
 try{
  for(const {p,def,original} of definitions){if(!def)continue;const current=await io.serviceControl('service-status',p.project);if(current.loaded){active.push(p.project);await io.serviceControl('stop',p.project);}writeFileSync(join(backup,p.label+'.plist'),original!,{mode:0o600});}
  atomic(recordPath,JSON.stringify({source:root,...built,launcher,installedAt:new Date().toISOString()},null,2)+'\n');
  for(const {p,path,def} of definitions){if(def){const xml=serviceDefinition(p.config,process.execPath,built.cli,io.home(),p.label);atomic(path,xml);}await io.installWorkflowHook(p.config);}
  atomic(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(built.cli)} "$@"\n`,0o755);
  for(const id of active){restarted.push(id);await io.serviceControl('start',id);}
  return {installed:true,...built,launcher,backup,projects:projects.map(p=>p.project)};
 }catch(e){
  // Restore intake definitions/launcher; keep backups and the immutable snapshot.
  for(const id of restarted)try{await io.serviceControl('stop',id);}catch{console.error('Intake rollback pause needs inspection:',id);}
  try{if(oldRecord)atomic(recordPath,oldRecord.toString());else if(existsSync(recordPath))unlinkSync(recordPath);}catch{console.error('Installation record rollback needs inspection:',recordPath);}
  for(const p of originalProjects)try{await io.localAO(`projects/${p.id}/config`,'PUT',{config:p.config});}catch{console.error('Project settings rollback needs inspection:',p.id);}
  for(const {path,original} of definitions)if(original)try{atomic(path,original);}catch{console.error('Service rollback needs inspection:',path);}
  try{if(oldLauncher)atomic(launcher,oldLauncher.toString(),0o755);else if(existsSync(launcher))unlinkSync(launcher);}catch{console.error('Launcher rollback needs inspection:',launcher);}
  for(const id of active)try{await io.serviceControl('start',id);}catch{console.error('Intake restart needs inspection:',id);}
  throw e;
 }
}

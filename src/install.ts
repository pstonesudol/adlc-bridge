import {readdirSync,lstatSync,readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,renameSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';import {homedir} from 'node:os';import {createHash} from 'node:crypto';
import {appState,installedCLI} from './install-state';import {registeredProjects,serviceControl} from './service-control';import {serviceDefinition} from './init';import {readDefinition,assertDefinition} from './project-services';import {localAO,installWorkflowHook} from './workflow-transport';
export function distributionFiles(root:string){
 const files:string[]=[];
 function walk(dir:string){for(const name of readdirSync(join(root,dir)).sort()){const rel=join(dir,name),st=lstatSync(join(root,rel));if(name==='__pycache__'||name.endsWith('.pyc'))continue;if(st.isSymbolicLink())throw Error('Distribution cannot contain symlinks');if(st.isDirectory())walk(rel);else if(st.isFile())files.push(rel);}}
 for(const dir of ['src','scripts','patches'])if(existsSync(join(root,dir)))walk(dir);
 for(const f of ['package.json','LICENSE','README.md','AGENTS.md'])if(existsSync(join(root,f)))files.push(f);
 return files.sort();
}
export function snapshot(root:string,destination:string){
 const files=distributionFiles(root),hash=createHash('sha256');for(const f of files)hash.update(f+'\0').update(readFileSync(join(root,f))).update('\0');const version=hash.digest('hex');
 const target=join(destination,version);
 if(!existsSync(target)){mkdirSync(target,{recursive:true,mode:0o700});for(const f of files){mkdirSync(dirname(join(target,f)),{recursive:true});copyFileSync(join(root,f),join(target,f));}writeFileSync(join(target,'manifest.json'),JSON.stringify({version,files},null,2)+'\n',{mode:0o600});}
 else for(const f of files)if(!readFileSync(join(target,f)).equals(readFileSync(join(root,f))))throw Error('Installed snapshot changed; preserved for inspection');
 return {version,cli:join(target,'src/cli.ts'),files:files.length};
}
function atomic(path:string,text:string,mode=0o600){mkdirSync(dirname(path),{recursive:true});const temp=path+`.${process.pid}.tmp`;writeFileSync(temp,text,{mode,flag:'wx'});renameSync(temp,path);}
const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";
export async function installBridge(apply=false,root=resolve(import.meta.dir,'..'),bin?:string){
 if(root.includes('/ADLC Bridge/versions/')&&existsSync(join(appState(),'installation.json')))root=JSON.parse(readFileSync(join(appState(),'installation.json'),'utf8')).source;
 const projects=await registeredProjects();
 const launcher=bin??(existsSync('/opt/homebrew/bin/adlc')?'/opt/homebrew/bin/adlc':join(homedir(),'.local/bin/adlc'));
 if(existsSync(launcher)){const st=lstatSync(launcher);if(!st.isFile()||st.isSymbolicLink()||!readFileSync(launcher,'utf8').includes('src/cli.ts'))throw Error('Existing launcher is not recognizable; choose --bin PATH');}
 const definitions=projects.map(p=>{const path=join(homedir(),'Library/LaunchAgents',p.label+'.plist');if(!existsSync(path))return {p,path,def:null};const def=readDefinition(path);assertDefinition(def,p.label,p.config);return {p,path,def};});
 if(!apply)return {preview:true,source:root,launcher,projects:projects.map(p=>p.project),files:distributionFiles(root),note:'Apply creates a pinned runtime snapshot, pauses intake during activation, migrates gates/services and restores prior intake state. No workers are stopped.'};
 const built=snapshot(root,join(appState(),'versions'));const backup=join(appState(),'backups',`install-${Date.now()}`);mkdirSync(backup,{recursive:true,mode:0o700});
 const recordPath=join(appState(),'installation.json');const oldRecord=existsSync(recordPath)?readFileSync(recordPath):null;const oldLauncher=existsSync(launcher)?readFileSync(launcher):null;
 const active:string[]=[];
 const originalProjects=[];for(const p of projects){const b=await localAO(`projects/${p.project}`);if(b.status!=='ok'||!b.project?.config)throw Error('Cannot back up project settings');originalProjects.push({id:p.project,config:b.project.config});}
 try{
  for(const {p,def} of definitions){if(!def)continue;const current=await serviceControl('service-status',p.project);if(current.loaded){active.push(p.project);await serviceControl('stop',p.project);}writeFileSync(join(backup,p.label+'.plist'),JSON.stringify(def),{mode:0o600});}
  atomic(recordPath,JSON.stringify({source:root,...built,launcher,installedAt:new Date().toISOString()},null,2)+'\n');
  for(const {p,path,def} of definitions)if(def){const xml=serviceDefinition(p.config,process.execPath,built.cli,homedir(),p.label);atomic(path,xml);await installWorkflowHook(p.config);}
  atomic(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(built.cli)} "$@"\n`,0o755);
  for(const id of active)await serviceControl('start',id);
  return {installed:true,...built,launcher,backup,projects:projects.map(p=>p.project)};
 }catch(e){
  // Restore intake definitions/launcher; keep backups and the immutable snapshot.
  if(oldRecord)atomic(recordPath,oldRecord.toString());else if(existsSync(recordPath))unlinkSync(recordPath);
  for(const p of originalProjects)try{await localAO(`projects/${p.id}/config`,'PUT',{config:p.config});}catch{console.error('Project settings rollback needs inspection:',p.id);}
  for(const {path,def} of definitions)if(def){const tmp=path+'.restore.json';writeFileSync(tmp,JSON.stringify(def));const p=Bun.spawnSync(['/usr/bin/plutil','-convert','xml1','-o',path,tmp]);if(p.exitCode!==0)console.error('Service rollback needs inspection:',path);}
  if(oldLauncher)atomic(launcher,oldLauncher.toString(),0o755);
  for(const id of active)try{await serviceControl('start',id);}catch{}
  throw e;
 }
}

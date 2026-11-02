import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {Store,digest} from './core';
import {ProjectServices,registryPath} from './project-services';
import {appState,installedCLI} from './install-state';
import {turnBarrier} from './turn-submission';

const migrationIO={path:registryPath,state:appState,trustedControllers:()=>[resolve(import.meta.dir,'cli.ts'),installedCLI()].filter((p):p is string=>!!p)};
// Operator-only preview/confirmation, like guarded recovery. Never read a plist,
// start a service, install code, or infer authority from a mutable definition.
export async function migrateController(project:string,controller:string,apply=false,confirmation?:string,io=migrationIO){
 const inspect=()=>{
  const path=io.path();if(!existsSync(path))throw Error('Existing project registry required');
  if(!isAbsolute(controller))throw Error('Absolute verified controller required');
  const st=lstatSync(controller),canonical=realpathSync(controller);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o022)!==0||!io.trustedControllers().some(p=>existsSync(p)&&realpathSync(p)===canonical))throw Error('Controller must be the executing CLI or the owner-validated installed CLI');
  const s=Store.readonly(path);try{
   const registry=new ProjectServices(s,false),entry=registry.select(project);registry.verify(entry);
   const has=s.db.query("SELECT name FROM sqlite_master WHERE name='project_service_controllers'").get();
   const row=has?s.db.query('SELECT controller FROM project_service_controllers WHERE config=?').get(entry.config) as any:undefined;
   if(row&&row.controller!==canonical)throw Error('Existing controller binding differs; preserved for explicit installation recovery');
   const report={action:'bind-controller',project,config:entry.config,label:entry.label,controller:canonical,controllerHash:digest(readFileSync(canonical).toString()),configHash:digest(readFileSync(entry.config).toString()),registrationHash:digest(JSON.stringify(entry)),current:row?.controller??null,stamp:[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs]};
   return {...report,confirmation:digest(JSON.stringify(report)),preview:true};
  }finally{s.close();}
 };
 if(!apply)return inspect();
 return turnBarrier(io.state()).run(async()=>{
  const report=inspect();if(confirmation!==report.confirmation)throw Error('Use the current controller migration preview confirmation hash; state may have changed');
  if(report.current===report.controller)return {...report,preview:false,applied:false,alreadyBound:true};
  const s=new Store(io.path());try{
   const registry=new ProjectServices(s);registry.verify(registry.select(project));
   registry.registerController(report.config,report.controller);
   return {...report,preview:false,applied:true,activation:false};
  }finally{s.close();}
 });
}

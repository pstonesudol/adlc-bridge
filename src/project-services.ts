import {installedCLI} from './install-state';
import {Store,digest} from './core';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {validate} from './linear';
export const legacyLabel='local.adlc.linear-intake';
export const registryPath=()=>join(homedir(),'Library/Application Support/ADLC Bridge/state.sqlite');
export type ProjectService={project:string;name:string;repo:string;linear_project:string;config:string;label:string};
export function projectServiceLabel(project:string){
 if(typeof project!=='string'||!/^[\w-]{1,80}$/.test(project))throw Error('Valid registered Orchestrator project ID required');
 return `local.adlc.project.${project.replaceAll('_','-').toLowerCase()}-${digest(project).slice(0,8)}`;
}
export function readDefinition(path:string){
 const r=Bun.spawnSync(['/usr/bin/plutil','-convert','json','-o','-',path],{stdout:'pipe',stderr:'pipe'});
 if(r.exitCode!==0)throw Error('Unable to read installed service definition');return JSON.parse(r.stdout.toString());
}
export function assertDefinition(def:any,label:string,config:string){
 const a=def.ProgramArguments;
 if(def.Label!==label||!Array.isArray(a)||a.length!==4||a[2]!=='poll'||resolve(a[3])!==resolve(config)||![join(import.meta.dir,'cli.ts'),installedCLI()].filter(Boolean).some(x=>realpathSync(a[1])===realpathSync(x!)))throw Error('Service definition does not match this project; existing service preserved');
}
export class ProjectServices{
 constructor(public s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS project_services(project TEXT PRIMARY KEY,name TEXT NOT NULL,repo TEXT NOT NULL UNIQUE,linear_project TEXT NOT NULL UNIQUE,config TEXT NOT NULL UNIQUE,label TEXT NOT NULL UNIQUE);`);}
 list():ProjectService[]{return this.s.db.query('SELECT * FROM project_services ORDER BY project').all() as ProjectService[];}
 register(configPath:string,label?:string,persist=true){
  const config=realpathSync(configPath),c=JSON.parse(readFileSync(config,'utf8'));validate(c);
  const project=c.automation?.orchestratorProject,generated=projectServiceLabel(project),repo=realpathSync(c.repo);
  const old=this.list().find(p=>p.project===project);
  const selected=label??old?.label??generated;
  if(selected!==legacyLabel&&selected!==generated)throw Error('Unexpected project service label');
  const entry={project,name:c.name,repo,linear_project:c.linear.projectId,config,label:selected};
  if(old){if(['repo','linear_project','config','label'].some(k=>(old as any)[k]!== (entry as any)[k]))throw Error('Project is already registered with different settings; explicit migration required');return old;}
  if(this.list().some(p=>p.repo===repo||p.linear_project===c.linear.projectId||p.config===config||p.label===selected))throw Error('Repository, Linear project or service is already registered; explicit migration required');
  if(!persist)return entry;
  this.s.db.query('INSERT INTO project_services VALUES (?,?,?,?,?,?)').run(project,c.name,repo,c.linear.projectId,config,selected);
  return entry;
 }
 discoverLegacy(home=homedir(),read=readDefinition){
  const path=join(home,'Library/LaunchAgents',`${legacyLabel}.plist`);
  if(!existsSync(path))return;
  const b=read(path),config=b.ProgramArguments?.[3];
  if(typeof config!=='string')throw Error('Existing legacy service configuration is unknown');
  assertDefinition(b,legacyLabel,config);return this.register(config,legacyLabel);
 }
 select(project?:string){
  const entries=this.list();
  if(project){const p=entries.find(p=>p.project===project);if(!p)throw Error(`Unknown project ${project}; use adlc projects`);return p;}
  if(entries.length!==1)throw Error(entries.length?'Multiple projects registered; specify a project ID from adlc projects':'No projects registered; use adlc init');
  return entries[0];
 }
 verify(entry:ProjectService){
  const c=JSON.parse(readFileSync(entry.config,'utf8'));validate(c);
  if(c.automation?.orchestratorProject!==entry.project||c.linear.projectId!==entry.linear_project||realpathSync(c.repo)!==entry.repo)throw Error('Registered project configuration identity changed; reconcile before service control');
 }
}

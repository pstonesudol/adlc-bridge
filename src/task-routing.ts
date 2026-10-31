import {Store,digest} from './core';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export type RoutingSettings={enabled:boolean;dataDir:string;runtimeDir:string;harness:'opencode-v2'};
export type Route={category:string|null;provider:string;model:string;effort:string|null;agent:string|null;harness:'opencode-v2';mode:'plan'|'build';reason:string;confidence:number|null;configHash:string};
export type RoutingConfig={enabled:boolean;minConfidence:number;fallback:{model:{providerID:string;modelID:string};variant?:string|null}|null;categories:Array<{id:string;enabled:boolean;description:string;model:{providerID:string;modelID:string}|null;variant?:string|null;agent?:string|null}>};
export type RoutingSnapshot={config:RoutingConfig;classify:(request:string,policy?:RoutingConfig)=>Promise<{choice:string;confidence:number}>};
export type RoutingLoader=(settings:RoutingSettings)=>Promise<RoutingSnapshot>;

// Reuse the installed OpenChamber resolver, category definitions and Jev protocol.
// Read credentials only in memory; neither endpoint keys nor responses are logged.
export const loadOpenChamber:RoutingLoader=async settings=>{
 if(settings.harness!=='opencode-v2')throw Error('OpenChamber routing currently requires the OpenCode 2 harness');
 const module=(name:string)=>import(pathToFileURL(join(resolve(settings.runtimeDir),name)).href);
 const [storeModule,jev,classification,defaults]=await Promise.all([module('store.js'),module('jev.js'),module('classifier.js'),module('defaults.js')]);
 const store=storeModule.createRoutingStore({dataDir:resolve(settings.dataDir)});
 const config=await store.readConfig();
 const classifierSource=await store.readClassifierSource();
 if(classifierSource==='off')throw Error('OpenChamber classification is disabled');
 if(classifierSource&&!['custom','typesafe','zen-promo'].includes(classifierSource))throw Error('Selected classifier credential source requires an explicit adapter');
 if(!config.enabled)throw Error('OpenChamber Auto routing is disabled');
 return {config,classify:async (request,policy)=>{
  let selected:any,custom:any,token:string|null=null;
  try{
   selected=await store.readClassifierSource();custom=classification.readPinnedCustomEndpoint()??await store.readCustomEndpoint();
   if(selected==='typesafe')token=await store.readToken();
  }catch{throw Error('OpenChamber classifier settings could not be read');}
  // These credential sources are supported without exporting any provider login.
  if(selected&&!['custom','typesafe','zen-promo','off'].includes(selected))throw Error('Selected classifier credential source requires an adapter; refusing to copy provider credentials');
  const access=classification.resolveClassifier({selected,customEndpoint:custom,typesafeKey:token,zenPromotionActive:defaults.ZEN_JEV_PROMOTION_ACTIVE});
  if(!access.effective)throw Error('OpenChamber classification is unavailable or disabled');
  const endpoint=classification.classifierEndpoint(access.effective,{customEndpoint:custom,typesafeKey:token});
  const categories=(policy??config).categories.filter((c:any)=>c.enabled);
  const body=jev.buildRoutingRequest({categories,history:[],request});
  try{
   const result=await jev.createJevClient().ask(body,endpoint);
   return result.answers.category;
  }catch{throw Error('Classification request failed');}
 }};
};
export function selectRoute(config:RoutingConfig,answer:{choice:string;confidence:number}|null,reason?:string):Route{
 if(!config.enabled)throw Error('OpenChamber Auto routing is disabled');
 const valid=answer&&Number.isFinite(answer.confidence)&&answer.confidence>=0&&answer.confidence<=1;
 const category=valid&&answer.confidence>=config.minConfidence?config.categories.find(c=>c.enabled&&c.id===answer.choice):undefined;
 const target=category?.model?category:config.fallback;
 if(!target?.model)throw Error('Selected category has no model and no configured fallback');
 const {providerID,modelID}=target.model;
 if(!/^[\w.-]+$/.test(providerID)||!modelID?.trim()||/[\s#]/.test(modelID))throw Error('Invalid routing model reference');
 if(providerID==='openchamber'&&modelID==='auto')throw Error('Recursive Auto routing target');
 const agent=category?.model?category.agent??null:null;
 if(agent&&!['build','plan'].includes(agent))throw Error('Custom OpenCode agents require an explicit adapter; refusing to ignore the configured agent');
 return {category:category?.model?category.id:null,provider:providerID,model:`${providerID}/${modelID}`,effort:target.variant??null,agent,harness:'opencode-v2',mode:agent==='plan'||category?.id==='planning'?'plan':'build',reason:category?.model?'routed':reason??(!valid?'invalid_classifier_answer':answer.confidence<config.minConfidence?'low-confidence':'unknown-category'),confidence:valid?answer.confidence:null,configHash:digest(JSON.stringify(config))};
}
export class TaskRouting{
 constructor(public s:Store,public load:RoutingLoader=loadOpenChamber){s.db.exec(`CREATE TABLE IF NOT EXISTS task_routes(job TEXT NOT NULL REFERENCES jobs(id),phase TEXT NOT NULL,binding TEXT NOT NULL,route TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'selected',PRIMARY KEY(job,phase));
 CREATE TABLE IF NOT EXISTS routing_snapshots(job TEXT NOT NULL REFERENCES jobs(id),config_hash TEXT NOT NULL,config TEXT NOT NULL,PRIMARY KEY(job,config_hash));
 CREATE TABLE IF NOT EXISTS routing_projects(job TEXT PRIMARY KEY REFERENCES jobs(id),settings TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS route_approvals(job TEXT PRIMARY KEY REFERENCES jobs(id),plan_hash TEXT NOT NULL,route_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS planning_delivery(job TEXT PRIMARY KEY REFERENCES jobs(id),session_id TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL);`);}
 get(job:string,phase:string):any{return this.s.db.query('SELECT * FROM task_routes WHERE job=? AND phase=?').get(job,phase);}
 settings(job:string):RoutingSettings|null{const row=this.s.db.query('SELECT settings FROM routing_projects WHERE job=?').get(job) as any;return row?JSON.parse(row.settings):null;}
 async choose(job:string,phase:string,binding:string,request:string,settings:RoutingSettings,knownCategory?:string):Promise<Route>{
  const old=this.get(job,phase);if(old){if(old.binding!==binding)throw Error('Route binding changed; explicit reconciliation required');return JSON.parse(old.route);}
  const snapshot=await this.load(settings);let policy=snapshot.config;
  if(phase.startsWith('remediation:')){
   const implementation=this.get(job,'implementation');
   if(implementation){const pinned=this.s.db.query('SELECT config FROM routing_snapshots WHERE job=? AND config_hash=?').get(job,JSON.parse(implementation.route).configHash) as any;if(!pinned)throw Error('Approved routing policy snapshot missing');policy=JSON.parse(pinned.config);}
  }
  let answer=null,reason:string|undefined;
  if(knownCategory)answer={choice:knownCategory,confidence:1};
  else try{answer=await snapshot.classify(request,policy);}catch{reason='classifier-unavailable';}
  const route=selectRoute(policy,answer,reason);
  if(knownCategory==='planning')route.mode='plan';
  return this.s.db.transaction(()=>{
   const existing=this.get(job,phase);if(existing){if(existing.binding!==binding)throw Error('Concurrent route binding changed');return JSON.parse(existing.route);}
   this.s.db.query('INSERT OR IGNORE INTO routing_snapshots VALUES (?,?,?)').run(job,route.configHash,JSON.stringify(policy));
   if(phase==='implementation')this.s.db.query('INSERT INTO routing_projects VALUES (?,?) ON CONFLICT(job) DO UPDATE SET settings=excluded.settings').run(job,JSON.stringify(settings));
   else this.s.db.query('INSERT OR IGNORE INTO routing_projects VALUES (?,?)').run(job,JSON.stringify(settings));
   this.s.db.query('INSERT INTO task_routes(job,phase,binding,route) VALUES (?,?,?,?)').run(job,phase,binding,JSON.stringify(route));
   this.s.event(job,'task_route_selected',JSON.stringify({phase,...route}));return route;
  }).immediate();
 }
 approve(job:string,hash:string){
  if(!this.get(job,'planning'))return;
  const route=this.get(job,'implementation');
  const j=this.s.get(job);if(route&&route.binding!==digest(JSON.stringify([j.spec,j.plan_hash])))throw Error('Implementation route is stale');
  if(!route)throw Error('Implementation route must be selected before approval');
  this.s.db.query('INSERT INTO route_approvals VALUES (?,?,?)').run(job,hash,digest(route.route));
 }
 approved(job:string,hash:string):Route|null{
  const row=this.get(job,'implementation');if(!row){if(this.get(job,'planning'))throw Error('Approved implementation routing is missing');return null;}
  const a=this.s.db.query('SELECT * FROM route_approvals WHERE job=?').get(job) as any;
  if(!a||a.plan_hash!==hash||a.route_hash!==digest(row.route))throw Error('Routing choice is not covered by the current human approval');
  return JSON.parse(row.route);
 }
 verified(job:string,phase:string){this.s.db.query("UPDATE task_routes SET state='verified' WHERE job=? AND phase=?").run(job,phase);}
 list(job?:string){const rows=job?this.s.db.query('SELECT job,phase,binding,route,state FROM task_routes WHERE job=?').all(job):this.s.db.query('SELECT job,phase,binding,route,state FROM task_routes').all();return rows.map((r:any)=>({...r,route:JSON.parse(r.route)}));}
}

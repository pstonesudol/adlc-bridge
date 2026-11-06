import {latestRevision} from './spec-revisions';
import {Store,digest} from './core';
import {loadRouting,routingSnapshot} from './routing-config';

export type RoutingSettings={enabled:boolean;configFile?:string;overridesFile?:string;harness:'opencode-v2'};
export type Route={category:string|null;provider:string;model:string;effort:string|null;agent:string|null;harness:'opencode-v2';mode:'plan'|'build';reason:string;confidence:number|null;configHash:string};
export type RoutingConfig={enabled:boolean;minConfidence:number;fallback:{model:{providerID:string;modelID:string};variant?:string|null}|null;categories:Array<{id:string;enabled:boolean;description:string;model:{providerID:string;modelID:string}|null;variant?:string|null;agent?:string|null}>};
export type RoutingSnapshot={config:RoutingConfig;classify:(request:string,policy?:RoutingConfig)=>Promise<{choice:string;confidence:number}>};
export type RoutingLoader=(settings:RoutingSettings)=>Promise<RoutingSnapshot>;

export function selectRoute(config:RoutingConfig,answer:{choice:string;confidence:number}|null,reason?:string):Route{
 if(!config.enabled)throw Error('ADLC routing is disabled');
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
  constructor(public s:Store,public load:RoutingLoader=loadRouting){s.db.exec(`CREATE TABLE IF NOT EXISTS task_routes(job TEXT NOT NULL REFERENCES jobs(id),phase TEXT NOT NULL,binding TEXT NOT NULL,route TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'selected',PRIMARY KEY(job,phase));
 CREATE TABLE IF NOT EXISTS routing_snapshots(job TEXT NOT NULL REFERENCES jobs(id),config_hash TEXT NOT NULL,config TEXT NOT NULL,PRIMARY KEY(job,config_hash));
 CREATE TABLE IF NOT EXISTS routing_projects(job TEXT PRIMARY KEY REFERENCES jobs(id),settings TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS route_approvals(job TEXT PRIMARY KEY REFERENCES jobs(id),plan_hash TEXT NOT NULL,route_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS planning_delivery(job TEXT PRIMARY KEY REFERENCES jobs(id),session_id TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL);`);}
 private phaseKey(job:string,phase:string){
  if(phase!=='planning'&&phase!=='implementation')return phase;
  const revision=latestRevision(this.s,job);
  return revision&&revision.state!=='preplanning'?`${phase}:${revision.id}`:phase;
 }
 private legacyRoute(job:string,phase:string){
  return this.s.db.query('SELECT * FROM task_routes WHERE job=? AND phase=?').get(job,phase);
 }
 private approvalHash(job:string,route:string){
  const key=this.phaseKey(job,'implementation');
  return digest(key==='implementation'?route:JSON.stringify([key,route]));
 }
 get(job:string,phase:string):any{return this.s.db.query('SELECT * FROM task_routes WHERE job=? AND phase=?').get(job,this.phaseKey(job,phase));}
  settings(job:string):RoutingSettings|null{const row=this.s.db.query('SELECT settings FROM routing_projects WHERE job=?').get(job) as any;return row?JSON.parse(row.settings):null;}
  async reconcile(job:string,settings:RoutingSettings,confirm?:string){
   const j=this.s.get(job),old=this.get(job,'implementation');
   if(j.state!=='awaiting_approval'||!old)throw Error('Routing reconciliation requires an unapproved captured plan and existing implementation route');
   const hasDispatch=this.s.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='implementation_dispatch'").get();
   if(hasDispatch&&this.s.db.query('SELECT job FROM implementation_dispatch WHERE job=?').get(job))throw Error('Existing implementation dispatch cannot be rerouted');
   const snapshot=await this.load(settings);if(!snapshot.config.enabled)throw Error('ADLC routing is disabled');let answer=null,reason:string|undefined;
   try{answer=await snapshot.classify(`Implement the requested task (planning is complete; supporting checks are part of the change):\n${j.spec}`);}catch{reason='classifier-unavailable';}
   const route=selectRoute(snapshot.config,answer,reason),binding=digest(JSON.stringify([j.spec,j.plan_hash]));
   const hash=digest(JSON.stringify([job,j.plan_hash,old.route,route]));
   if(confirm!==undefined&&confirm!==hash)throw Error('Routing reconciliation preview changed; preview again');
   if(confirm)this.s.db.transaction(()=>{
    const current=this.s.get(job);if(current.state!=='awaiting_approval'||current.plan_hash!==j.plan_hash||this.get(job,'implementation')?.route!==old.route)throw Error('Job changed during routing reconciliation');
    this.s.db.query('DELETE FROM route_approvals WHERE job=?').run(job);
    this.s.db.query('INSERT OR IGNORE INTO routing_snapshots VALUES (?,?,?)').run(job,route.configHash,JSON.stringify(snapshot.config));
    this.s.db.query("UPDATE task_routes SET binding=?,route=?,state='selected' WHERE job=? AND phase=?").run(binding,JSON.stringify(route),job,this.phaseKey(job,'implementation'));
    this.s.db.query('INSERT INTO routing_projects VALUES (?,?) ON CONFLICT(job) DO UPDATE SET settings=excluded.settings').run(job,JSON.stringify(settings));
    this.s.event(job,'routing_reconciled',JSON.stringify({hash,route}));
   }).immediate();
   return {hash,previous:JSON.parse(old.route),route,applied:!!confirm};
  }
 async choose(job:string,phase:string,binding:string,request:string,settings:RoutingSettings,knownCategory?:string):Promise<Route>{
  const key=this.phaseKey(job,phase),old=this.get(job,phase);if(old){if(old.binding!==binding)throw Error('Route binding changed; explicit reconciliation required');return JSON.parse(old.route);}
  let pinnedPolicy:RoutingConfig|undefined;
  if(phase.startsWith('remediation:')){
   const implementation=this.get(job,'implementation');
    if(implementation){const pinned=this.s.db.query('SELECT config FROM routing_snapshots WHERE job=? AND config_hash=?').get(job,JSON.parse(implementation.route).configHash) as any;if(!pinned)throw Error('Approved routing policy snapshot missing');pinnedPolicy=JSON.parse(pinned.config);}
   }
   const snapshot=pinnedPolicy&&this.load===loadRouting?routingSnapshot(pinnedPolicy):await this.load(settings),policy=pinnedPolicy??snapshot.config;
   if(!policy.enabled)throw Error('ADLC routing is disabled');
  let answer=null,reason:string|undefined;
  if(knownCategory)answer={choice:knownCategory,confidence:1};
  else try{answer=await snapshot.classify(request,policy);}catch{reason='classifier-unavailable';}
  const route=selectRoute(policy,answer,reason);
  if(knownCategory==='planning')route.mode='plan';
  return this.s.db.transaction(()=>{
   if(this.phaseKey(job,phase)!==key)throw Error('Route revision changed during selection');
   const existing=this.get(job,phase);if(existing){if(existing.binding!==binding)throw Error('Concurrent route binding changed');return JSON.parse(existing.route);}
   this.s.db.query('INSERT OR IGNORE INTO routing_snapshots VALUES (?,?,?)').run(job,route.configHash,JSON.stringify(policy));
   if(phase==='implementation')this.s.db.query('INSERT INTO routing_projects VALUES (?,?) ON CONFLICT(job) DO UPDATE SET settings=excluded.settings').run(job,JSON.stringify(settings));
   else this.s.db.query('INSERT OR IGNORE INTO routing_projects VALUES (?,?)').run(job,JSON.stringify(settings));
   this.s.db.query('INSERT INTO task_routes(job,phase,binding,route) VALUES (?,?,?,?)').run(job,key,binding,JSON.stringify(route));
   this.s.event(job,'task_route_selected',JSON.stringify({phase:key,...route}));return route;
  }).immediate();
 }
 approve(job:string,hash:string){
  if(!this.get(job,'planning'))return;
  const route=this.get(job,'implementation');
  const j=this.s.get(job);if(route&&route.binding!==digest(JSON.stringify([j.spec,j.plan_hash])))throw Error('Implementation route is stale');
  if(!route)throw Error('Implementation route must be selected before approval');
  this.s.db.query('INSERT INTO route_approvals VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET plan_hash=excluded.plan_hash,route_hash=excluded.route_hash').run(job,hash,this.approvalHash(job,route.route));
 }
 approved(job:string,hash:string):Route|null{
  const row=this.get(job,'implementation');if(!row){
   if(this.get(job,'planning'))throw Error('Approved implementation routing is missing');
   // A revision changes the phase key. Unqualified rows written by an earlier
   // build cannot be proven to cover the active revision, so never report "no
   // route": execution would deliver without the approved routing policy.
   if(this.legacyRoute(job,'implementation')||this.legacyRoute(job,'planning'))throw Error('Legacy routing cannot be bound to the current requirements revision; explicit reconciliation required');
   return null;
  }
  const a=this.s.db.query('SELECT * FROM route_approvals WHERE job=?').get(job) as any;
  if(!a||a.plan_hash!==hash||a.route_hash!==this.approvalHash(job,row.route))throw Error('Routing choice is not covered by the current human approval');
  return JSON.parse(row.route);
 }
 verified(job:string,phase:string){this.s.db.query("UPDATE task_routes SET state='verified' WHERE job=? AND phase=?").run(job,this.phaseKey(job,phase));}
 list(job?:string){const rows=job?this.s.db.query('SELECT job,phase,binding,route,state FROM task_routes WHERE job=?').all(job):this.s.db.query('SELECT job,phase,binding,route,state FROM task_routes').all();return rows.map((r:any)=>({...r,route:JSON.parse(r.route)}));}
}

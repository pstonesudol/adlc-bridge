import {Store,digest} from './core';
import {latestRevision} from './spec-revisions';
import type {Route} from './task-routing';

export function ensureDispatchRoutes(s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS dispatch_route_checks(
 job TEXT NOT NULL REFERENCES jobs(id),binding TEXT NOT NULL,plan_hash TEXT NOT NULL,client_id TEXT NOT NULL,
 route TEXT NOT NULL,state TEXT NOT NULL,next_action TEXT NOT NULL,PRIMARY KEY(job,binding));`);}
export function dispatchRouteBinding(s:Store,job:string,d:any,route:Route){
 const j=s.get(job);
 return digest(JSON.stringify([job,j.spec,d.plan_hash,d.client_id,d.session_id,latestRevision(s,job)?.id??null,route]));
}
export function recordDispatchRoute(s:Store,job:string,d:any,route:Route,state:'available'|'unavailable'|'transient'){
 const binding=dispatchRouteBinding(s,job,d,route);
 const nextAction=state==='unavailable'
  ?'Request scoped route approval in Linear for this plan and dispatch. Restore the pinned model or explicitly reconcile the route and obtain fresh approval; no implicit fallback or turn replay.'
  :state==='transient'?'Retry the read-only model catalog preflight; current approval is retained. No turn was sent.'
  :'Model advertised; continue through current approval and delivery gates.';
 s.db.query('INSERT INTO dispatch_route_checks VALUES (?,?,?,?,?,?,?) ON CONFLICT(job,binding) DO UPDATE SET state=excluded.state,next_action=excluded.next_action').run(job,binding,d.plan_hash,d.client_id,JSON.stringify(route),state,nextAction);
 return {binding,nextAction};
}

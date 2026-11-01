import {Store,digest} from './core';

export function adoptedDelivery(s:Store,job:string):any {
 if(!s.db.query("SELECT name FROM sqlite_master WHERE name='delivery_adoptions'").get())return null;
 return s.db.query("SELECT * FROM delivery_adoptions WHERE job=? AND state='adopted'").get(job);
}
export function deliveryBranch(s:Store,job:string,session:any,repo?:string,pr?:number){
 const p=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
 const run=s.db.query('SELECT * FROM runs WHERE job=?').get(job) as any;
 const j=s.get(job),a=adoptedDelivery(s,job);
 if(!p||!run||p.session_id!==session.id||run.session_id!==session.id||run.owner!=='orchestrator'||session.branch!==p.branch)throw Error('Delivery reservation/session identity mismatch');
 if(a){
  if(a.plan_hash!==j.plan_hash||a.spec_hash!==digest(j.spec)||a.session!==session.id||a.worktree!==run.worktree||a.reserved!==p.branch||repo&&a.repo!==repo||pr&&a.pr!==pr)throw Error('Adopted delivery identity is stale or mismatched');
  return a.branch as string;
 }
 return p.branch as string;
}
export function assertDeliveryTarget(s:Store,job:string,session:any,repo:string,pr:number,b:any){
 const expected=deliveryBranch(s,job,session,repo,pr);
 if(b.state!=='open'||b.draft!==false||b.headRepo!==repo||b.baseRepo!==repo||!b.defaultBranch||!b.baseBranch||b.branch===b.defaultBranch||b.branch===b.baseBranch)throw Error('Target is not the owned open feature PR');
 if(b.branch!==expected)throw Error(`Blocked — branch mismatch: reserved ${session.branch}; actual ${b.branch}; candidate https://github.com/${repo}/pull/${pr}; run recover-handoff JOB CONFIG (preview), then --confirm HASH`);
}

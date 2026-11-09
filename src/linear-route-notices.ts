import {randomUUID} from 'node:crypto';
import {Store} from './core';
import {dispatchRouteBinding,ensureDispatchRoutes} from './dispatch-route';
import {TaskRouting} from './task-routing';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';

// This surface requests approval only. It cannot change a route, grant approval,
// or replay an uncertain implementation or comment delivery.
export class LinearRouteNotices{
 constructor(public s:Store,public api:LinearAPI=linearAPI){
  ensureDispatchRoutes(s);
  s.db.exec(`CREATE TABLE IF NOT EXISTS dispatch_route_notices(job TEXT NOT NULL,binding TEXT NOT NULL,comment_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(job,binding));`);
 }
 current(job:string,check:any){
  const j=this.s.get(job),d=this.s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any;
  if(j.state!=='approved'||j.approved_hash!==check.plan_hash||!d||d.state!=='approved_pending'||d.plan_hash!==check.plan_hash||d.client_id!==check.client_id)return false;
  const route=new TaskRouting(this.s).approved(job,j.plan_hash);
  return route&&dispatchRouteBinding(this.s,job,d,route)===check.binding&&this.s.db.query("SELECT 1 FROM dispatch_route_checks WHERE job=? AND binding=? AND state='unavailable'").get(job,check.binding);
 }
 async sync(c:{linear:{projectId:string;teamId:string}}){
  if(!this.s.db.query("SELECT name FROM sqlite_master WHERE name='implementation_dispatch'").get())return [];
  const checks=this.s.db.query("SELECT r.* FROM dispatch_route_checks r JOIN jobs j ON j.id=r.job JOIN implementation_dispatch d ON d.job=r.job AND d.client_id=r.client_id AND d.plan_hash=r.plan_hash WHERE j.project=? AND j.state='approved' AND d.state='approved_pending' AND r.state='unavailable'").all(c.linear.projectId) as any[],results:any[]=[];
  for(const check of checks)try{
   if(!this.current(check.job,check))continue;
   const j=this.s.get(check.job),route=JSON.parse(check.route);
   let n=this.s.db.query('SELECT * FROM dispatch_route_notices WHERE job=? AND binding=?').get(j.id,check.binding) as any;
   if(n?.state==='posted')continue;
   const issue=await readLinearIssue(j.issue,this.api);
   if(issue?.id!==j.issue||issue.project?.id!==c.linear.projectId||issue.team?.id!==c.linear.teamId||j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Route approval notice requirements or issue scope changed');
   if(!this.current(j.id,check))continue;
   if(!n){
    const body=[`## ADLC: scoped route approval required — ${issue.identifier}`,`Plan: ${check.plan_hash}\nDispatch: ${check.client_id}\nRoute binding: ${check.binding}`,`Pinned model: ${route.model}\nHarness: ${route.harness}\nMode: ${route.mode}\nEffort: ${route.effort??'default'}`,check.next_action,'Please identify and explicitly approve the replacement model, harness, mode and effort for this exact plan through operator route reconciliation and fresh approval. A generic reply does not authorize substitution. Existing fallback configuration is not approval to replace this pinned route. No implementation turn was sent by this preflight; session, branch, PR and delivery history remain intact. Uncertain prior turns must be reconciled, never replayed.'].join('\n\n');
    this.s.db.query("INSERT OR IGNORE INTO dispatch_route_notices VALUES (?,?,?,?,'reserved')").run(j.id,check.binding,randomUUID(),body);
    n=this.s.db.query('SELECT * FROM dispatch_route_notices WHERE job=? AND binding=?').get(j.id,check.binding) as any;
   }
   if(n.state!=='reserved'){
    // Read back the exact ID/body after a lost response, never POST again.
    let after:string|null=null,found=false;const seen=new Set<string>();
    for(let pages=0;pages<10;pages++){
     const b=await this.api('query($id:String!,$after:String){issue(id:$id){id comments(first:100,after:$after){nodes{id body}pageInfo{hasNextPage endCursor}}}}',{id:j.issue,after}),page=b.issue?.comments;
     if(b.issue?.id!==j.issue||!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')break;
     if(page.nodes.some((x:any)=>x.id===n.comment_id&&x.body===n.body)){found=true;break;}
     if(!page.pageInfo.hasNextPage)break;
     after=page.pageInfo.endCursor;if(!after||seen.has(after))break;seen.add(after);
    }
    if(found)this.s.db.query("UPDATE dispatch_route_notices SET state='posted' WHERE job=? AND binding=?").run(j.id,check.binding);
    results.push({job:j.id,state:found?'route_approval_requested':'route_notice_uncertain'});continue;
   }
   if(!this.current(j.id,check))continue;
   const claim=this.s.db.query("UPDATE dispatch_route_notices SET state='delivery_uncertain' WHERE job=? AND binding=? AND state='reserved'").run(j.id,check.binding);
   if(!claim.changes)continue;
   const b=await this.api('mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id body}}}',{input:{id:n.comment_id,issueId:j.issue,body:n.body}});
   if(!b.commentCreate?.success||b.commentCreate.comment?.id!==n.comment_id||b.commentCreate.comment.body!==n.body)throw Error('Route notice outcome uncertain; reconcile exact comment, never repost blindly');
   this.s.db.query("UPDATE dispatch_route_notices SET state='posted' WHERE job=? AND binding=?").run(j.id,check.binding);
   results.push({job:j.id,state:'route_approval_requested'});
  }catch{results.push({job:check.job,state:'route_notice_blocked',reason:'Route approval notice unavailable; inspect persisted dispatch next action. No route was changed.'});}
  return results;
 }
}

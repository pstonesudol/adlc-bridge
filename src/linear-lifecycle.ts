import {Store,digest} from './core';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';
import {prLifecycle} from './github';
export type StatusMapping={enabled:boolean;inProgress:string;inReview:string;done:string};
export type SyncConfig={linear:{projectId:string;teamId:string;readyStateId:string;readyLabelId:string};githubRepo?:string;statusSync?:StatusMapping};
export class LinearLifecycle{
 constructor(public s:Store,public api:LinearAPI=linearAPI,public pr=prLifecycle){s.db.exec(`CREATE TABLE IF NOT EXISTS linear_transitions(job TEXT NOT NULL REFERENCES jobs(id),phase TEXT NOT NULL,desired TEXT NOT NULL,previous TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,PRIMARY KEY(job,phase));`);}
 async move(job:string,phase:string,desired:string,c:SyncConfig){
  const j=this.s.get(job),issue=await readLinearIssue(j.issue,this.api);
  if(!issue||issue.project?.id!==c.linear.projectId||issue.team?.id!==c.linear.teamId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Linear lifecycle identity or label scope mismatch');
  if(j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Requirements changed; refusing status update');
  const target=await this.api('query($id:String!){workflowState(id:$id){id type team{id}}}',{id:desired});
  const expected=phase==='done'?'completed':'started';
  if(target.workflowState?.team?.id!==c.linear.teamId||target.workflowState.type!==expected)throw Error('Configured Linear status has wrong team or category');
  let row=this.s.db.query('SELECT * FROM linear_transitions WHERE job=? AND phase=?').get(job,phase) as any;
  if(row&&row.desired!==desired)throw Error('Status mapping changed; reconcile previous transition');
  if(issue.state.id===desired){
   this.s.db.query('INSERT INTO linear_transitions VALUES (?,?,?,?,?,?) ON CONFLICT(job,phase) DO UPDATE SET state=excluded.state,reason=NULL').run(job,phase,desired,issue.state.id,'confirmed',null);return {state:'confirmed'};
  }
  if(!issue.labels.nodes.some((x:any)=>x.id===c.linear.readyLabelId))throw Error('Ready label removed; refusing status update');
  if(row){return {state:'needs_reconciliation',reason:'Status changed or previous delivery uncertain; no blind replay'};}
  const allowed=phase==='in-progress'?[c.linear.readyStateId]:[c.linear.readyStateId,c.statusSync!.inProgress,c.statusSync!.inReview];
  if(!allowed.includes(issue.state.id))return {state:'needs_reconciliation',reason:'Ticket moved to an unexpected state; human changes preserved'};
  const claim=this.s.db.query('INSERT OR IGNORE INTO linear_transitions VALUES (?,?,?,?,?,?)').run(job,phase,desired,issue.state.id,'delivery_uncertain',null);
  if(!claim.changes)return {state:'delivery_uncertain'};
  const b=await this.api('mutation($id:String!,$state:String!){issueUpdate(id:$id,input:{stateId:$state}){success issue{id state{id}}}}',{id:j.issue,state:desired});
  if(!b.issueUpdate?.success||b.issueUpdate.issue?.id!==j.issue||b.issueUpdate.issue.state?.id!==desired)throw Error('Linear status delivery requires reconciliation');
  this.s.db.query("UPDATE linear_transitions SET state='confirmed' WHERE job=? AND phase=?").run(job,phase);this.s.event(job,'linear_status_changed',JSON.stringify({phase,state:desired}));return {state:'confirmed'};
 }
 async sync(c:SyncConfig){
  if(!c.statusSync?.enabled)return [];
  const rows=this.s.db.query("SELECT j.id,j.state FROM jobs j JOIN planning_runs p ON p.job=j.id WHERE j.project=? AND p.session_id IS NOT NULL AND j.state IN ('awaiting_plan','awaiting_approval','approved','blocked')").all(c.linear.projectId) as any[];
  const results=[];
  for(const row of rows)try{
   const review=this.s.db.query('SELECT repo,pr FROM review_targets WHERE job=?').get(row.id) as any;
   let phase='in-progress',desired=c.statusSync.inProgress;
   if(review){
    if(review.repo!==c.githubRepo)throw Error('PR repository differs from status-sync project');
    const facts=await this.pr(review.repo,review.pr);
    if(facts.merged){phase='done';desired=c.statusSync.done;}
    else if(facts.state!=='open'){results.push({job:row.id,state:'blocked',reason:'PR closed without merge; not marking Done'});continue;}
    else{if(row.state==='blocked')continue;phase='in-review';desired=c.statusSync.inReview;}
   }
   if(row.state==='blocked'&&phase!=='done')continue;
   const result=await this.move(row.id,phase,desired,c);results.push({job:row.id,phase,...result});
   if(phase==='done'&&result.state==='confirmed')this.s.db.transaction(()=>{
    this.s.db.query("UPDATE jobs SET state='done',reason=NULL,updated=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    this.s.db.query("UPDATE runs SET state='completed',reason='PR merge observed; bridge did not merge' WHERE job=?").run(row.id);
    this.s.db.query("UPDATE review_targets SET state='completed',reason='PR merge observed' WHERE job=?").run(row.id);
   })();
  }catch(e){results.push({job:row.id,error:e instanceof Error?e.message:'Linear status sync failed'});}
  return results;
 }
}

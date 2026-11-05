import {Store,digest} from './core';
import type {Workflow} from './workflow';
import {DeliveryRecovery} from './delivery-recovery';
import {dependencyIO,type DependencyIO} from './dependency-evidence';
import {validateDependencies,type DependencyJob} from './dependency-policy';
import {recordResolution,activeResolution,resolutionBinding,readinessFor} from './readiness';
import {assertWorktreeAvailable,canonicalWorktree} from './worktree-reservation';
import {withTurnSubmission} from './turn-submission';
import {LinearBlockers} from './linear-blockers';
import {remediationPolicy} from './remediation';
import {currentOutcome,latestRevision} from './spec-revisions';

export class DependencyRecovery{
 io:DependencyIO;
 constructor(public s:Store,public workflow:Workflow,overrides:Partial<DependencyIO>={},public submit=withTurnSubmission){this.io={...dependencyIO(s),...overrides};}
 install(){this.s.db.exec(`CREATE TABLE IF NOT EXISTS dependency_waits(job TEXT PRIMARY KEY,plan TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,evidence TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS dependency_updates(id TEXT PRIMARY KEY,job TEXT NOT NULL,plan TEXT NOT NULL,worktree TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS active_dependency_worktree ON dependency_updates(worktree) WHERE state IN ('reserved','fetching','updating');`);}
  rows(){return this.s.db.query("SELECT name FROM sqlite_master WHERE name='dependency_waits'").get()?this.s.db.query('SELECT * FROM dependency_waits').all() as any[]:[];}
  currentWait(row:any){
   const j=this.s.get(row.job),d=this.workflow.implementation(row.job),r=latestRevision(this.s,row.job),p=JSON.parse(row.evidence);
   return row.plan===j.plan_hash&&(!r||(p.proof?.auth
    ?p.proof.auth.revision===r.id&&p.proof.auth.delivery===d?.client_id
    :!p.clientId&&currentOutcome(this.s,row.job,this.workflow.outcomes(row.job))));
  }
 status(){return {waits:this.rows(),updates:this.s.db.query("SELECT name FROM sqlite_master WHERE name='dependency_updates'").get()?this.s.db.query('SELECT id,job,plan,worktree,state,detail FROM dependency_updates').all():[],nextAction:'Inspect dependency-preview. Confirm only unchanged safe evidence; never replay uncertain continuation or discard local work.'};}
 definition(job:string,c:any):DependencyJob{
  validateDependencies(c);const j=this.s.get(job),d=c.dependencyRecovery?.enabled&&c.dependencyRecovery.jobs.find((d:DependencyJob)=>d.issue===j.issue);
  if(!d)throw Error('No configured dependency binding; operator must supply exact issue/PR/capabilities and current plan/spec hashes');
  if(d.planHash!==j.plan_hash||d.specHash!==digest(j.spec))throw Error('Dependency plan/specification binding changed; fresh approval/configuration required');
  return d;
 }
 authorization(job:string,c:any){
  const a=new DeliveryRecovery(this.s,{} as any).authorization(job,c),d=this.workflow.implementation(job);
  if(d.runtime!=='supervised-host')throw Error('Unsupported runtime; operator reconciliation required');
  if(!JSON.parse(a.grant).includes('merge-base-feature'))throw Error('Current explicit merge-base-feature grant required');
  if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='remediation_budget'").get()){
   const b=this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any,policy=remediationPolicy(c.remediation);
   if(b&&(b.stop_reason||b.no_progress>=policy.maxNoProgress||policy.maxAttempts!==null&&b.consumed>=policy.maxAttempts+b.extensions))throw Error('Outstanding remediation_budget limit; explicit operator reconciliation required, history preserved');
  }
  for(const [table,query] of [
   ['clarification_receipts',"SELECT 1 FROM clarification_receipts WHERE job=? AND state IN ('waiting','partial','confirmed','resolved','replan','needs_review')"],
   ['branch_updates',"SELECT 1 FROM branch_updates WHERE job=? AND state IN ('accepted','delivery_uncertain')"],
   ['remediation',"SELECT 1 FROM remediation WHERE job=? AND state IN ('reserved','delivery_uncertain')"],
   ['delivery_adoptions',"SELECT 1 FROM delivery_adoptions WHERE job=? AND state!='adopted'"],
  ])if(this.s.db.query('SELECT name FROM sqlite_master WHERE name=?').get(table)&&this.s.db.query(query).get(job))throw Error(`Outstanding ${table} requires reconciliation; dependency polling never resets history`);
  return a;
 }
 async graph(root:string,definition:DependencyJob){
  const graph:Record<string,string[]>={},active=new Set<string>();
  const visit=async(id:string)=>{
   if(active.has(id))throw Error(`Dependency cycle at ${id}`);
   if(graph[id])return;if(Object.keys(graph).length>=100)throw Error('Dependency graph exceeds safe bound');
   active.add(id);const observed=await this.io.relations(id);
   const configured=this.s.db.query("SELECT name FROM sqlite_master WHERE name='feature_dependencies'").get()?(this.s.db.query('SELECT prerequisite FROM feature_dependencies WHERE issue=?').all(id) as any[]).map(d=>d.prerequisite):[];
   graph[id]=[...new Set([...observed,...configured])].sort();
   for(const child of graph[id])await visit(child);active.delete(id);
  };
  await visit(root);
  if(graph[root].some(id=>!definition.prerequisites.some(d=>d.issue===id)))throw Error('Unmapped Linear prerequisite; configure its exact PR and capabilities before resume');
  // Configured edges participate even if Linear has not recorded them.
  for(const d of definition.prerequisites){await visit(d.issue);const reaches=(id:string,seen=new Set<string>()):boolean=>id===root||!seen.has(id)&&(seen.add(id), (graph[id]??[]).some(n=>reaches(n,seen)));if(reaches(d.issue))throw Error('Configured/Linear dependency cycle');}
  return Object.fromEntries(Object.entries(graph).sort(([a],[b])=>a.localeCompare(b)));
 }
 async preview(job:string,c:any){
  const definition=this.definition(job,c),auth=this.authorization(job,c),j=this.s.get(job),o=this.workflow.outcomes(job);
   if(!currentOutcome(this.s,job,o)||o.session_id!==auth.session||o.outcome!=='blocked_dependency'||o.source!=='receipt'||JSON.parse(o.questions).length)throw Error('Current structured dependency-only worker blocker required; unresolved questions use clarification/replanning');
  const readiness=readinessFor(this.s,job);
  if(!readiness||readiness.plan_hash!==j.plan_hash||readiness.spec_hash!==digest(j.spec)||readiness.questions.length)throw Error('Current readiness and resolved plan questions required');
  const refs=[...JSON.parse(o.dependencies),...readiness.dependencies];
  if(!refs.length||refs.some((d:any)=>!definition.prerequisites.some(p=>p.ref===d.ref||p.issue===d.ref)))throw Error('Missing/ambiguous worker prerequisite mapping');
  const issue=await this.io.issue(j.issue);
  const states=[c.linear.readyStateId,...c.statusSync?.enabled?[c.statusSync.inProgress,c.statusSync.inReview]:[]];
  if(issue?.id!==j.issue||issue.project?.id!==j.project||issue.team?.id!==c.linear.teamId||issue.labels?.pageInfo?.hasNextPage!==false||!issue.labels.nodes.some((l:any)=>l.id===c.linear.readyLabelId)||!states.includes(issue.state?.id)||j.spec!==JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}))throw Error('Current Linear specification/eligibility changed or unavailable');
  for(const d of definition.prerequisites){const i=await this.io.issue(d.issue);if(i?.id!==d.issue||i.identifier!==d.ref)throw Error(`Missing or ambiguous prerequisite ${d.ref}`);}
  const graph=await this.graph(j.issue,definition),provider=await this.io.provider(c,definition),facts=await this.io.facts(job,c);
  if(!facts.clean||!facts.isolated||!facts.idle||!facts.completed||facts.session!==auth.session||facts.project!==auth.project||facts.branch!==auth.reserved||facts.tree!==canonicalWorktree(auth.worktree)||facts.owners.length!==1||facts.owners[0]!==auth.session)throw Error('Clean isolated owned idle worktree with completed receipt required; preserve dirty/shared work');
  const binding=resolutionBinding(this.s,job);
  const proof={job,auth,definition,graph,provider,binding,policy:c.dependencyRecovery};
  const id=digest(JSON.stringify(proof));
   const retained=this.s.db.query("SELECT name FROM sqlite_master WHERE name='dependency_updates'").get()?this.s.db.query("SELECT * FROM dependency_updates WHERE job=? AND state IN ('reserved','fetching','updating') ORDER BY id").all(job):[];
   if(!currentOutcome(this.s,job,this.workflow.outcomes(job))||JSON.stringify(this.workflow.outcomes(job))!==JSON.stringify(o)||JSON.stringify(this.authorization(job,c))!==JSON.stringify(auth))throw Error('Dependency blocker or authorization changed during observation');
  return {mode:'preview_only',id,confirmation:digest(JSON.stringify([proof,facts,retained])),proof,facts,retained,nextAction:'Verify/fetch exact base, fast-forward clean feature only, and use existing guarded continuation. Unsafe evidence requires operator reconciliation.'};
 }
 async tick(job:string,c:any,confirmation?:string){return this.submit(async()=>{
  this.install();
   const prior=this.rows().find(r=>r.job===job);
   if(prior&&!this.currentWait(prior))return {job,state:'stale_dependencies',reason:'Retained dependency evidence belongs to a superseded revision or dispatch; history preserved'};
   if(!JSON.parse(prior?.evidence??'{}').clientId&&!currentOutcome(this.s,job,this.workflow.outcomes(job)))return {job,state:'stale_dependencies',reason:'Current revision-bound worker blocker required; no dependency work reserved'};
  // A reserved/sent continuation is never interpreted as permission to retry.
  if(prior){
   const p=JSON.parse(prior.evidence),cont=p.clientId&&this.s.db.query('SELECT * FROM continuations WHERE client_id=?').get(p.clientId) as any;
   if(cont){
    if(prior.plan!==this.s.get(job).plan_hash)return {job,state:'stale_dependencies',reason:'Prior dependency continuation belongs to a different plan; explicit reconciliation required'};
    if(cont.state==='completed'&&this.workflow.outcomes(job)?.outcome==='blocked_dependency')return this.save(job,'waiting_for_dependencies','Worker blocked again after verified continuation; no progress. Reconcile the new blocker; do not reset history or replay.',p);
    return this.save(job,['delivery_accepted','completed'].includes(cont.state)?'resumed':'delivery_uncertain',`Existing continuation ${cont.client_id}: ${cont.state}; never replay`,p);
   }
  }
  let preview:any;
  try{
   preview=await this.preview(job,c);
   if(confirmation&&confirmation!==preview.confirmation)throw Error('Dependency preview changed; inspect again');
   const {id,proof,facts}=preview;
   let row=this.s.db.query('SELECT * FROM dependency_updates WHERE id=?').get(id) as any;
    if(!row){
     if(confirmation&&preview.retained.length){
      this.s.db.transaction(()=>{
       const current=this.s.db.query("SELECT * FROM dependency_updates WHERE job=? AND state IN ('reserved','fetching','updating') ORDER BY id").all(job);
       if(JSON.stringify(current)!==JSON.stringify(preview.retained))throw Error('Retained dependency reservation changed; preview again');
       for(const old of preview.retained){
        const recorded=JSON.parse(old.detail);
        if(!['reserved','fetching'].includes(old.state)||old.worktree!==facts.tree||JSON.stringify(recorded.proof.auth)!==JSON.stringify(proof.auth)||JSON.stringify(recorded.facts)!==JSON.stringify(facts))throw Error('Retained update ownership, worktree or HEAD changed; preserve reservation');
        this.s.db.query("UPDATE dependency_updates SET state='superseded' WHERE id=?").run(old.id);
        this.s.event(job,'dependency_preupdate_superseded',JSON.stringify({old:old.id,current:id,confirmation}));
       }
       assertWorktreeAvailable(this.s,job);
      }).immediate();
     }
     assertWorktreeAvailable(this.s,job);
    row=this.s.db.transaction(()=>{
     if(JSON.stringify(this.authorization(job,c))!==JSON.stringify(proof.auth))throw Error('Approval changed before dependency reservation');
     assertWorktreeAvailable(this.s,job);
     this.s.db.query("INSERT INTO dependency_updates VALUES (?,?,?,?,'reserved',?)").run(id,job,proof.auth.plan,facts.tree,JSON.stringify(preview));
     return this.s.db.query('SELECT * FROM dependency_updates WHERE id=?').get(id);
    }).immediate();
   }
   const original=JSON.parse(row.detail);
   if(row.state==='submitted')throw Error('Dependency evidence already consumed; no-progress requires operator review, not another continuation');
   if(row.state==='fetching'&&!confirmation)throw Error('Interrupted dependency fetch; inspect retained reservation, do not blindly replay');
   if(row.state==='reserved'||confirmation&&['fetching','updating'].includes(row.state)&&facts.head===original.facts.head){
    if(confirmation)this.s.event(job,'dependency_git_reconciliation',JSON.stringify({id,confirmation,stage:row.state,head:facts.head}));
    this.s.db.query("UPDATE dependency_updates SET state='fetching' WHERE id=? AND state='reserved'").run(id);
    await this.io.fetch(facts.tree,proof.provider.baseBranch);
    if(!await this.io.includes(facts.tree,facts.head,proof.provider.base))throw Error('Divergent feature work; only fast-forward is automatic, preserve history for operator merge');
    await this.io.capabilities(facts.tree,proof.provider.base,proof.definition);
     const fresh=await this.preview(job,c);if(fresh.id!==id||JSON.stringify(fresh.facts)!==JSON.stringify(facts))throw Error('Dependency/base/worktree changed before update');
    this.s.db.query("UPDATE dependency_updates SET state='updating' WHERE id=? AND state='fetching'").run(id);
    await this.io.update(facts.tree,proof.provider.base);
   }
   // A crash after update is reconciled by exact base/clean ownership evidence,
   // never by repeating Git. An unchanged old HEAD is not proof it was unattempted.
   const updated=await this.preview(job,c);
   if(updated.id!==id||updated.facts.head!==proof.provider.base)throw Error('Updated HEAD/base differs; retain reservation for manual reconciliation');
   if(updated.facts.remote&&updated.facts.remote!==original.facts.remote)throw Error('Remote feature ref changed during update');
   await this.io.capabilities(facts.tree,updated.facts.head,proof.definition);
   this.s.db.transaction(()=>{
    if(JSON.stringify(this.authorization(job,c))!==JSON.stringify(proof.auth))throw Error('Authorization changed after update');
    const current=activeResolution(this.s,job),detail=JSON.stringify({dependencyEvidence:id,base:proof.provider.base});
    if(current&&current.detail!==detail)throw Error('Another clarification/resolution exists; reconcile instead of overwriting');
    if(!current)recordResolution(this.s,job,'dependency-satisfied','verified-dependency-observer',detail);
    this.s.db.query("UPDATE dependency_updates SET state='ready' WHERE id=?").run(id);
   }).immediate();
   // Persist the expected existing-engine client ID before invoking it. This
   // covers a crash after provider acceptance but before our own result write.
   const resolution=activeResolution(this.s,job),binding=digest(JSON.stringify([resolution.binding,resolution.source,resolution.actor,resolution.detail,resolution.at]));
   const clientId=`adlc-continue-${digest(JSON.stringify([job,proof.auth.plan,binding])).slice(0,32)}`;
   this.save(job,'ready',null,{...updated,clientId});
   const result=await this.workflow.resume(job,c,async()=>{
    const fresh=await this.preview(job,c);
    if(fresh.id!==id||fresh.facts.head!==proof.provider.base)throw Error('Dependency evidence changed immediately before continuation');
   },id);
   this.s.db.query("UPDATE dependency_updates SET state='submitted' WHERE id=?").run(id);
   return this.save(job,result.state==='continuation_delivery_accepted'?'resumed':'delivery_uncertain',result.state,{...updated,clientId});
   }catch(e){if(!currentOutcome(this.s,job,this.workflow.outcomes(job)))return {job,state:'stale_dependencies',reason:'Worker blocker changed during dependency observation; stale wait not recorded'};const saved=this.rows().find(r=>r.job===job),evidence=saved&&JSON.parse(saved.evidence);return this.save(job,'waiting_for_dependencies',e instanceof Error?e.message:'Dependency evidence unavailable',evidence?.clientId?evidence:preview??{definition:c.dependencyRecovery?.jobs?.find((d:DependencyJob)=>d.issue===this.s.get(job).issue)});}
 });}
 save(job:string,state:string,reason:string|null,evidence:any){
  this.s.db.query('INSERT INTO dependency_waits VALUES (?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET plan=excluded.plan,state=excluded.state,reason=excluded.reason,evidence=excluded.evidence').run(job,this.s.get(job).plan_hash,state,reason,JSON.stringify(evidence));
  return {job,state,displayStatus:state==='waiting_for_dependencies'?'Waiting for dependencies':state,reason,nextAction:state==='waiting_for_dependencies'?'Inspect dependency-preview; provide missing proof or reconcile safely, then explicitly confirm dependency-resume. Never replay uncertain delivery.':null};
 }
 async sync(c:any){
  if(!c.dependencyRecovery?.enabled)return [];
   const rows=(this.s.db.query("SELECT j.id FROM jobs j JOIN worker_outcomes w ON w.job=j.id WHERE j.project=? AND j.state='approved' AND w.outcome='blocked_dependency'").all(c.linear.projectId) as any[]).filter(r=>currentOutcome(this.s,r.id,this.workflow.outcomes(r.id)));
   for(const wait of this.rows())if(this.currentWait(wait)&&['ready','delivery_uncertain'].includes(wait.state)&&this.s.get(wait.job).project===c.linear.projectId&&!rows.some(r=>r.id===wait.job))rows.push({id:wait.job});
  const results=[];for(const r of rows)results.push(await this.tick(r.id,c));return results;
 }
  async notices(c:any,blockers:LinearBlockers){
   const results:any[]=[];
   if(!c.blockerSync?.enabled)return results;
   for(const row of this.rows()){
    try{
    const j=this.s.get(row.job);if(j.project!==c.linear.projectId||!this.currentWait(row))continue;
   const p=JSON.parse(row.evidence),definition=p.proof?.definition??p.definition;
   const outcome={plan_hash:row.plan,outcome:row.state,reason:row.reason,questions:'[]',dependencies:JSON.stringify((definition?.prerequisites??[]).map((d:any)=>({ref:d.ref,reason:`${d.repo}#${d.pr}; ${d.kind}; capabilities ${d.capabilities.map((x:any)=>x.path).join(', ')}`})))};
   const reason=row.state==='resumed'?`Verified dependency evidence ${p.id}; continuation accepted in the existing session. No new authorization or runtime activation.`:row.reason;
   await blockers.leave(row.job,outcome,c,{binding:digest(JSON.stringify([row.job,row.plan,row.state,reason,p.id??definition])),applyLabel:row.state!=='resumed',body:`## ADLC: ${row.state==='waiting_for_dependencies'?'Waiting for dependencies':row.state}\n\n${reason??''}\n\nPrerequisites: ${outcome.dependencies}\n\nPlan: ${row.plan}\nNext action: ${row.state==='resumed'?'Wait for the existing worker; do not resend.':'inspect dependency-preview; reconcile failed evidence before dependency-resume.'} No new authorization or runtime activation.`,guard:(issue)=>{if(issue.id!==j.issue||this.s.get(j.id).plan_hash!==row.plan)throw Error('Dependency notice identity changed');}});
     const current=this.workflow.outcomes(row.job);
     const activeBlocker=current?.plan_hash===j.plan_hash&&['needs_input','blocked_dependency','failed','uncertain','needs_reconciliation'].includes(current.outcome);
     if(row.state==='resumed'&&!activeBlocker)await blockers.retract(row.job,c);
    results.push({job:row.job,state:'posted'});
    }catch(error){results.push({job:row.job,state:'blocked',reason:error instanceof Error?error.message:'Dependency notice failed'});}
   }
   return results;
 }
}

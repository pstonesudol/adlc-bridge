import {test,expect,setSystemTime} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {LinearBlockers} from '../src/linear-blockers';
import {validate} from '../src/linear';
import {ConflictRecovery} from '../src/conflict-recovery';
import {ReviewLoop} from '../src/review-loop';
import {RecoveryObservation} from '../src/recovery-observation';
import {readFailure} from '../src/provider-read';
test('posted observation notice is rechecked hourly without duplicates',async()=>{
 const f=fixture();try{
 f.running();new RecoveryObservation(f.s).failed(f.id,readFailure('github','branch-read','HTTP 401',1));
 const blockers=f.blockers();await blockers.sync(f.config);expect(f.creates).toBe(1);
 const checked=Date.parse((f.s.db.query('SELECT checked FROM blocker_notices WHERE job=?').get(f.id) as any).checked);
 expect(Number.isFinite(checked)).toBe(true);
 const before=f.calls;
 await blockers.sync(f.config);expect(f.calls).toBe(before);expect(f.creates).toBe(1);
 setSystemTime(new Date(checked+60*60*1000+1));await blockers.sync(f.config);
 expect(f.calls).toBeGreaterThan(before);expect(f.creates).toBe(1);
 const rechecked=f.calls;await blockers.sync(f.config);expect(f.calls).toBe(rechecked);expect(f.creates).toBe(1);
 // A legacy row without a checked timestamp is rechecked once, then throttled.
 f.s.db.query('UPDATE blocker_notices SET checked=NULL WHERE job=?').run(f.id);
 const legacy=f.calls;await blockers.sync(f.config);expect(f.calls).toBeGreaterThan(legacy);expect(f.creates).toBe(1);
 const settled=f.calls;await blockers.sync(f.config);expect(f.calls).toBe(settled);
 }finally{setSystemTime();f.s.close();}
});
test('transient or unapproved observations publish no notice',async()=>{
 const f=fixture();try{
 f.running();const observations=new RecoveryObservation(f.s);
 observations.failed(f.id,readFailure('github','branch-read','HTTP 503',1));
 await f.blockers().sync(f.config);
 expect(f.comments.some(c=>c.body.includes('provider observation recovery required'))).toBe(false);
 observations.failed(f.id,readFailure('github','branch-read','HTTP 401',1));
 f.s.db.query("UPDATE jobs SET state='awaiting_plan' WHERE id=?").run(f.id);
 await f.blockers().sync(f.config);
 expect(f.comments.some(c=>c.body.includes('provider observation recovery required'))).toBe(false);
 }finally{f.s.close();}
});
test('observation notice does not retain an old-plan owned blocker label',async()=>{
 const f=fixture();try{
 const blockers=f.blockers();await blockers.sync(f.config);expect(f.labels).toContain(labelId);
 const j=f.s.get(f.id),plan='new approved plan',hash=digest(JSON.stringify([j.spec,plan]));
 f.s.db.query("UPDATE jobs SET state='approved',plan=?,plan_hash=?,approved_hash=? WHERE id=?").run(plan,hash,hash,f.id);
 new RecoveryObservation(f.s).failed(f.id,readFailure('github','branch-read','HTTP 401',1));
 await blockers.sync(f.config);expect(f.creates).toBe(2);expect(f.labels).not.toContain(labelId);expect(f.labels).toContain('ready');
 expect(f.comments[1].body).toContain('## ADLC: provider observation recovery required');
 }finally{f.s.close();}
});

test('permanent read failures publish one secret-safe operator notice without labels',async()=>{
 const f=fixture();try{
 f.running();const observations=new RecoveryObservation(f.s);
 observations.failed(f.id,readFailure('github','branch-read','HTTP 401 Authorization: Bearer PRIVATE',1));
 const blockers=f.blockers();await blockers.sync(f.config);await blockers.sync(f.config);
 expect(f.creates).toBe(1);expect(f.updates).toBe(0);expect(f.comments[0].body).toContain('retry-observation');expect(f.comments[0].body).not.toContain('PRIVATE');
 expect(f.comments[0].body).toContain('## ADLC: provider observation recovery required');expect(f.comments[0].body).not.toContain('implementation stopped');expect(f.comments[0].body).toContain('This synchronization records an outcome only.');expect(f.comments[0].body).toContain('Human PR merges remain required.');
 const before=f.calls;await blockers.sync(f.config);expect(f.calls).toBe(before);
 }finally{f.s.close();}
});

const labelId='11111111-1111-1111-1111-111111111111';
const config={linear:{projectId:'p',teamId:'t'},blockerSync:{enabled:true,labelId}};
const spec=JSON.stringify({identifier:'DEV-6',title:'Preview',description:'Repository-only preview'});
function fixture(){
 const s=new Store(':memory:');new Workflow(s,{} as any);
 const id=s.enqueue('p','issue',spec);
 const planHash=digest(JSON.stringify([spec,'plan']));
 s.db.query("UPDATE jobs SET state='approved',plan='plan',plan_hash=?,approved_hash=?,actor='human' WHERE id=?").run(planHash,planHash,id);
 let labels=['ready','team'],comments:any[]=[],updates=0,creates=0,calls=0,lostCreate=false,lostReplyAfterCreate=false,failLabelVerification=false,badIdentity=false,injectHumanLabelBeforeUpdate=false;
 const issue=()=>({id:'issue',...JSON.parse(spec),project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:labels.map(id=>({id})),pageInfo:{hasNextPage:false}}});
 const api=async(q:string,v:any)=>{
  calls++;
  if(q.includes('commentCreate')){
   creates++;if(lostCreate)throw Error('Lost comment reply');
   const comment={id:v.input.id,body:v.input.body,createdAt:new Date().toISOString()};comments.push(comment);
   if(lostReplyAfterCreate)throw Error('Lost comment reply after create');
   return {commentCreate:{success:true,comment}};
  }
  if(q.includes('comments(first:100')){
   return {issue:{id:'issue',comments:{nodes:comments.map(x=>({id:x.id,body:x.body,createdAt:x.createdAt})),pageInfo:{hasNextPage:false,endCursor:null}}}};
  }
  if(q.includes('issueUpdate')){
   updates++;
   if(injectHumanLabelBeforeUpdate){injectHumanLabelBeforeUpdate=false;if(!labels.includes('human-concurrent'))labels.push('human-concurrent');}
   if(q.includes('labelIds:$added'))labels=[...v.added];
   if(q.includes('addedLabelIds:$added'))labels=[...new Set([...labels,...v.added])];
   if(q.includes('labelIds:$removed'))labels=[...v.removed];
   if(q.includes('removedLabelIds:$removed'))labels=labels.filter((id:string)=>!v.removed.includes(id));
   if(failLabelVerification){
    failLabelVerification=false;
    const response=issue();
    if(v.added)response.labels={nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}};
    return {issueUpdate:{success:true,issue:response}};
   }
   return {issueUpdate:{success:true,issue:issue()}};
  }
  if(badIdentity)return {issue:{...issue(),project:{id:'other'}}};
  return {issue:issue()};
 };
 s.db.query(`INSERT INTO worker_outcomes(job,plan_hash,session_id,outcome,reason,questions,dependencies,source,confidence,first_observed,grace_deadline,observed)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,planHash,'session','needs_input','Worker stopped before edits',
   JSON.stringify([{id:'w1',question:'May we publish without Cloudflare Access changes?',kind:'security-scope'}]),
   JSON.stringify([{ref:'DEV-9',reason:'Approved sourcing wording'}]),'receipt','high',Date.now(),null,Date.now());
 return {
  s,id,config:config as any,
  get labels(){return [...labels];},get comments(){return [...comments];},get creates(){return creates;},get updates(){return updates;},get calls(){return calls;},
  loseCreate(){lostCreate=true;},
  loseReplyAfterCreate(){lostReplyAfterCreate=true;},
  failLabel(){failLabelVerification=true;},
  badIdentity(){badIdentity=true;},
  injectHumanLabel(){injectHumanLabelBeforeUpdate=true;},
  running(){s.db.query("UPDATE worker_outcomes SET outcome='running',reason='Continuation accepted' WHERE job=?").run(id);},
  staleEvidence(){s.db.query("UPDATE worker_outcomes SET plan_hash=? WHERE job=?").run(digest('other-plan'),id);},
  addLabel(id:string){if(!labels.includes(id))labels.push(id);},
  removeLabel(id:string){labels=labels.filter((label:string)=>label!==id);},
  blockers:()=>new LinearBlockers(s,api)
 };
}
test('stale worker outcomes from an earlier revision never reach the generic publisher',async()=>{
 const f=fixture();try{
  const j=f.s.get(f.id),dispatch='current-dispatch';
  f.s.db.query('INSERT INTO spec_revisions(id,job,old_hash,new_hash,summary,state) VALUES (?,?,?,?,?,?)').run('blocker-revision',f.id,digest(j.spec),digest(j.spec),'Revision','authorized');
  f.s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(f.id,j.plan_hash,'session',dispatch,'approved_pending','["src/**"]','supervised-host','human',null);
  // A current receipt publishes...
  f.s.db.query('UPDATE worker_outcomes SET revision_id=?,dispatch_id=? WHERE job=?').run('blocker-revision',dispatch,f.id);
  expect((await f.blockers().sync(f.config))[0].state).toBe('posted');expect(f.creates).toBe(1);
  // ...but a later receipt bound to an earlier dispatch and different evidence
  // is historical.
  f.s.db.query("UPDATE worker_outcomes SET dispatch_id='old-dispatch',reason='Superseded receipt',dependencies='[]' WHERE job=?").run(f.id);
  await f.blockers().sync(f.config);
  expect(f.creates).toBe(1);expect(f.comments).toHaveLength(1);
  // A binding change between the row scan and the external write aborts it.
  f.s.db.query('UPDATE worker_outcomes SET revision_id=?,dispatch_id=? WHERE job=?' ).run('blocker-revision',dispatch,f.id);
  f.s.db.query("UPDATE blocker_notices SET state='reserved',comment_id='second-comment' WHERE job=? AND state='posted'").run(f.id);
  const blockers=f.blockers();const api=(blockers as any).api;let mutated=false;
  (blockers as any).api=async(q:string,v:any)=>{if(!mutated&&q.includes('comments(first:100')){mutated=true;f.s.db.query("UPDATE worker_outcomes SET dispatch_id='changed-during-write' WHERE job=?").run(f.id);}return api(q,v);};
  const result=await blockers.sync(f.config);
  expect(result.some((r:any)=>r.state==='blocked'&&r.reason==='Worker blocker binding changed before Linear write')).toBe(true);
  expect(f.creates).toBe(1);expect(f.comments).toHaveLength(1);
  // A same-instance outcome change (worker becomes running) also aborts the write.
  f.s.db.query("UPDATE worker_outcomes SET dispatch_id=?,reason='Worker stopped before edits',dependencies='[{\"ref\":\"DEV-9\",\"reason\":\"Approved sourcing wording\"}]' WHERE job=?").run(dispatch,f.id);
  f.s.db.query("DELETE FROM blocker_notices WHERE job=? AND state!='posted'").run(f.id);
  f.s.db.query("UPDATE blocker_notices SET state='reserved',comment_id='third-comment' WHERE job=? AND state='posted'").run(f.id);
  const second=f.blockers();const api2=(second as any).api;let changed=false;
  (second as any).api=async(q:string,v:any)=>{if(!changed&&q.includes('comments(first:100')){changed=true;f.s.db.query("UPDATE worker_outcomes SET outcome='running' WHERE job=?").run(f.id);}return api2(q,v);};
  const running=await second.sync(f.config);
  expect(running.some((r:any)=>r.state==='blocked'&&r.reason==='Worker blocker changed before Linear write')).toBe(true);
  expect(f.creates).toBe(1);expect(f.comments).toHaveLength(1);
 }finally{f.s.close();}
});
test('a worker change after the comment is written blocks the label update',async()=>{
 const f=fixture();try{
  const j=f.s.get(f.id),dispatch='current-dispatch';
  f.s.db.query('INSERT INTO spec_revisions(id,job,old_hash,new_hash,summary,state) VALUES (?,?,?,?,?,?)').run('late-revision',f.id,digest(j.spec),digest(j.spec),'Revision','authorized');
  f.s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(f.id,j.plan_hash,'session',dispatch,'approved_pending','["src/**"]','supervised-host','human',null);
  f.s.db.query('UPDATE worker_outcomes SET revision_id=?,dispatch_id=? WHERE job=?').run('late-revision',dispatch,f.id);
  expect(f.labels).not.toContain(labelId);
  const blockers=f.blockers(),api=(blockers as any).api;let mutated=false;
  (blockers as any).api=async(q:string,v:any)=>{
   const result=await api(q,v);
   if(!mutated&&q.includes('commentCreate')){mutated=true;f.s.db.query("UPDATE worker_outcomes SET outcome='running' WHERE job=?").run(f.id);}
   return result;
  };
  const result=await blockers.sync(f.config);
  expect(result[0]).toMatchObject({state:'blocked',reason:'Worker blocker changed before Linear write'});
  // The comment was already delivered, but no label mutation follows it.
  expect(f.creates).toBe(1);expect(f.updates).toBe(0);expect(f.labels).not.toContain(labelId);
 }finally{f.s.close();}
});
test('blocker comment and label are idempotent across polls and restarts',async()=>{
 const f=fixture();try{
  const first=await f.blockers().sync(f.config);expect(first[0].state).toBe('posted');
  expect(f.creates).toBe(1);expect(f.updates).toBe(1);expect(f.comments.length).toBe(1);
  expect(f.labels).toEqual(['ready','team',labelId]);
  expect(f.comments[0].body).toContain('May we publish without Cloudflare Access changes?');
  expect(f.comments[0].body).toContain('DEV-9');
  expect(f.comments[0].body).toContain('does not grant readiness');
  await f.blockers().sync(f.config);expect(f.creates).toBe(1);expect(f.updates).toBe(1);
  const restarted=await f.blockers().sync(f.config);expect(restarted[0].state).toBe('posted');expect(f.comments.length).toBe(1);
 }finally{f.s.close();}
});
for(const reason of ['CodeRabbit custom-check failure: full Verification Evidence explanation/resolution is missing or truncated','CodeRabbit review unavailable: automatic review disabled','CodeRabbit review unavailable: request outcome uncertain'])test(`concrete review blocker is deduplicated: ${reason}`,async()=>{
 const f=fixture();try{
  new ReviewLoop(f.s);f.running();
  f.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state,session_id,worktree) VALUES (?,?,?,?,?,?)').run(f.id,'owned',f.s.get(f.id).plan_hash,'running','session','/worktree');
  f.s.db.query("INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head,state,reason,head_since) VALUES (?,?,?,?,?,?,?,?,?,?)").run(f.id,'owner/repo',1,'["CI"]','["src/**"]',1,'a'.repeat(40),reason.includes('uncertain')?'needs_reconciliation':'blocked',reason,Date.now());
  await f.blockers().sync(f.config);await f.blockers().sync(f.config);
  expect(f.creates).toBe(1);expect(f.comments[0].body).toContain(reason);expect(f.comments[0].body).toContain('Do not post secrets');expect(f.labels).toContain(labelId);
 }finally{f.s.close();}
});
for(const stale of ['spec-reset','approval-revoked','new-plan','tampered-plan','stale-run','missing-run','human-owned'])test(`superseded review blocker is not published: ${stale}`,async()=>{
 const f=fixture();try{
  new ReviewLoop(f.s);f.running();
  f.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state,session_id,worktree) VALUES (?,?,?,?,?,?)').run(f.id,'owned',f.s.get(f.id).plan_hash,'running','session','/worktree');
  f.s.db.query("INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head,state,reason,head_since) VALUES (?,?,?,?,?,?,?,?,?,?)").run(f.id,'owner/repo',1,'["CI"]','["src/**"]',1,'a'.repeat(40),'blocked','CodeRabbit custom-check failure: previous PR evidence is missing',Date.now());
  if(stale==='spec-reset')f.s.enqueue('p','issue',JSON.stringify({...JSON.parse(spec),description:'New planning requirements'}));
  if(stale==='approval-revoked')f.s.db.query('UPDATE jobs SET approved_hash=NULL WHERE id=?').run(f.id);
  if(stale==='new-plan'){const hash=f.s.propose(f.id,'replacement plan');f.s.approve(f.id,hash,'human');}
  if(stale==='tampered-plan')f.s.db.query("UPDATE jobs SET plan='unapproved text' WHERE id=?").run(f.id);
  if(stale==='stale-run')f.s.db.query("UPDATE runs SET plan_hash='old-plan' WHERE job=?").run(f.id);
  if(stale==='missing-run')f.s.db.query('DELETE FROM runs WHERE job=?').run(f.id);
  if(stale==='human-owned')f.s.db.query("UPDATE runs SET owner='human' WHERE job=?").run(f.id);
  await f.blockers().sync(f.config);
  expect(f.creates).toBe(0);expect(f.updates).toBe(0);expect(f.labels).toEqual(['ready','team']);
 }finally{f.s.close();}
});
for(const outcome of ['failed','uncertain','needs_reconciliation','needs_input'])test(`post-dependency ${outcome} is still published`,async()=>{
 const f=fixture();try{
  f.s.db.exec('CREATE TABLE dependency_waits(job TEXT,plan TEXT,state TEXT)');
  f.s.db.query('INSERT INTO dependency_waits VALUES (?,?,?)').run(f.id,f.s.get(f.id).plan_hash,'resumed');
  f.s.db.query('UPDATE worker_outcomes SET outcome=? WHERE job=?').run(outcome,f.id);
  await f.blockers().sync(f.config);expect(f.creates).toBe(1);expect(f.comments[0].body).toContain(outcome.replaceAll('_',' '));
 }finally{f.s.close();}
});
test('conflict recovery blockers and completion reuse dedupe without granting readiness',async()=>{
 const f=fixture();try{
  f.running();new ConflictRecovery(f.s).install();
  f.s.db.exec("CREATE TABLE review_targets(job TEXT PRIMARY KEY,head TEXT,state TEXT,required_checks TEXT,reason TEXT)");
  f.s.db.query('INSERT INTO review_targets(job,head,state,required_checks) VALUES (?,?,?,?)').run(f.id,'new-sha','waiting_for_ci','["latest-SHA CI","CodeRabbit"]');
  const review=f.s.db.query('SELECT * FROM review_targets WHERE job=?').get(f.id);
  f.s.db.query('INSERT INTO conflict_recoveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('recovery',f.id,f.s.get(f.id).plan_hash,'/tree','session','owner/repo',1,'feature','main','head','base','{}','resolving','client',1,'{}','app.txt requires a security decision',1);
  await f.blockers().sync(f.config);await f.blockers().sync(f.config);
  expect(f.creates).toBe(1);expect(f.labels).toContain(labelId);expect(f.comments[0].body).toContain('Conflict recovery recovery has an independent reconciliation gate at stage resolving');
  expect(f.comments[0].body).not.toContain('app.txt');
  expect(f.comments[0].body).not.toContain('security decision');
  expect((f.s.db.query('SELECT reason FROM conflict_recoveries').get() as any).reason).toBe('app.txt requires a security decision');
  f.s.db.query("UPDATE conflict_recoveries SET state='completed',reason=NULL,detail=?").run(JSON.stringify({result:'new-sha'}));
  await f.blockers().sync(f.config);await f.blockers().sync(f.config);
  expect(f.creates).toBe(2);expect(f.labels).not.toContain(labelId);expect(f.comments[1].body).toContain('new-sha');expect(f.comments[1].body).toContain('not readiness');
  expect(f.s.get(f.id).state).toBe('approved');
  expect(f.s.db.query('SELECT * FROM review_targets WHERE job=?').get(f.id)).toEqual(review);
 }finally{f.s.close();}
});
test('label verification failure after a successful write is retractable',async()=>{
 const f=fixture();try{
  f.failLabel();
  const first=await f.blockers().sync(f.config);expect(first[0].state).toBe('blocked');expect(first[0].reason).toContain('labels were not verified');
  expect(f.labels).toContain(labelId);
  const retract=await f.blockers().retract(f.id,f.config);expect(retract.state).toBe('retracted');
  expect(f.labels).toEqual(['ready','team']);
 }finally{f.s.close();}
});
test('proven Git publication keeps an independent message-receipt blocker until observed completion',async()=>{
 const f=fixture();try{
  f.running();new ConflictRecovery(f.s).install();
  f.s.db.query('INSERT INTO conflict_recoveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('recovery',f.id,f.s.get(f.id).plan_hash,'/tree','session','owner/repo',1,'feature','main','head','base','{}','completed','client',1,JSON.stringify({result:'new-sha',message:'uncertain'}),null,1);
  await f.blockers().sync(f.config);await f.blockers().sync(f.config);expect(f.labels).toContain(labelId);
  expect(f.comments.some(c=>c.body.includes('independent reconciliation gate'))).toBe(true);
  f.s.db.query('UPDATE conflict_recoveries SET detail=?').run(JSON.stringify({result:'new-sha',message:'completed'}));
  await f.blockers().sync(f.config);expect(f.labels).not.toContain(labelId);
 }finally{f.s.close();}
});
test('stale-plan recovery retains its blocker after a spec change and a newer running outcome',async()=>{
 const f=fixture();try{
  new ConflictRecovery(f.s).install();
  f.s.db.query('INSERT INTO conflict_recoveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('recovery',f.id,f.s.get(f.id).plan_hash,'/tree','session','owner/repo',1,'feature','main','head','base','{}','resolving','client',1,'{}','app.txt needs reconciliation',1);
  await f.blockers().sync(f.config);expect(f.labels).toContain(labelId);
  f.s.enqueue('p','issue',spec+' changed');
  const before=f.calls;await f.blockers().sync(f.config);
  expect(f.labels).toContain(labelId);expect(f.calls).toBe(before);
  f.s.db.query("UPDATE jobs SET plan_hash='new-plan',state='approved' WHERE id=?").run(f.id);
  f.s.db.query("UPDATE worker_outcomes SET plan_hash='new-plan',outcome='running' WHERE job=?").run(f.id);
  await f.blockers().sync(f.config);expect(f.labels).toContain(labelId);expect(f.calls).toBe(before);
 }finally{f.s.close();}
});
test('confirmed completion notices skip provider reads for done jobs, uncertain notices still reconcile',async()=>{
 for(const uncertain of [false,true]){
  const f=fixture();try{
   new ConflictRecovery(f.s).install();f.s.db.query("UPDATE jobs SET state='done' WHERE id=?").run(f.id);
   f.s.db.query('INSERT INTO conflict_recoveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('recovery',f.id,f.s.get(f.id).plan_hash,'/tree','session','owner/repo',1,'feature','main','head','base','{}','completed','client',1,JSON.stringify({result:'new-sha'}),null,1);
   if(uncertain)f.loseReplyAfterCreate();
   await f.blockers().sync(f.config);expect(f.creates).toBe(1);
   const calls=f.calls;
   await f.blockers().sync(f.config);
   if(uncertain)expect(f.calls).toBeGreaterThan(calls);else expect(f.calls).toBe(calls);
   const confirmed=f.calls;await f.blockers().sync(f.config);expect(f.calls).toBe(confirmed);expect(f.creates).toBe(1);
  }finally{f.s.close();}
 }
});
test('a comment that lands before its reply is lost is adopted without reposting',async()=>{
 const f=fixture();try{
  f.loseReplyAfterCreate();const first=await f.blockers().sync(f.config);
  expect(first[0].state).toBe('blocked');expect(first[0].reason).toContain('never repost blindly');
  expect(f.comments.length).toBe(1);
  const second=await f.blockers().sync(f.config);expect(second[0].state).toBe('posted');
  expect(f.creates).toBe(1);expect(f.comments.length).toBe(1);expect(f.labels).toContain(labelId);
 }finally{f.s.close();}
});
test('identity mismatch and stale plan evidence perform no Linear writes',async()=>{
 const identity=fixture();try{
  identity.badIdentity();const result=await identity.blockers().sync(identity.config);
  expect(result[0].state).toBe('blocked');expect(result[0].reason).toContain('identity');
  expect(identity.creates).toBe(0);expect(identity.updates).toBe(0);
 }finally{identity.s.close();}
 const stale=fixture();try{
  stale.staleEvidence();const before=stale.calls;const result=await stale.blockers().sync(stale.config);
  expect(result).toEqual([]);expect(stale.calls).toBe(before);expect(stale.creates).toBe(0);expect(stale.updates).toBe(0);
 }finally{stale.s.close();}
});
test('a running outcome retracts through sync and disabled sync performs no API calls',async()=>{
 const f=fixture();try{
  await f.blockers().sync(f.config);expect(f.labels).toContain(labelId);
  f.running();const result=await f.blockers().sync(f.config);
  expect(result[0].state).toBe('retracted');expect(f.labels).toEqual(['ready','team']);
  const calls=f.calls;const disabled=await f.blockers().sync({...f.config,blockerSync:{enabled:false}} as any);
  expect(disabled).toEqual([]);expect(f.calls).toBe(calls);
 }finally{f.s.close();}
});
test('human label changes are preserved and retraction removes only the blocker label',async()=>{
 const f=fixture();try{
  await f.blockers().sync(f.config);
  expect(f.labels).toContain('ready');
  const retract=await f.blockers().retract(f.id,f.config);expect(retract.state).toBe('retracted');
  expect(f.labels).toEqual(['ready','team']);
 }finally{f.s.close();}
});
test('a human-added blocker label is not claimed or removed by the bridge',async()=>{
 const f=fixture();try{
  f.addLabel(labelId);const first=await f.blockers().sync(f.config);
  expect(first[0].label).toBe('present');expect(f.updates).toBe(0);
  expect((await f.blockers().retract(f.id,f.config)).state).toBe('none');
  expect(f.labels).toContain(labelId);
 }finally{f.s.close();}
});
test('additive label updates preserve human removals and unrelated additions',async()=>{
 const f=fixture();try{
  await f.blockers().sync(f.config);
  f.removeLabel(labelId);f.removeLabel('ready');f.addLabel('human-choice');
  await f.blockers().sync(f.config);
  expect(f.labels).toContain(labelId);expect(f.labels).toContain('human-choice');
  expect(f.labels).not.toContain('ready');
  await f.blockers().retract(f.id,f.config);
  expect(f.labels).not.toContain(labelId);expect(f.labels).toContain('human-choice');expect(f.labels).not.toContain('ready');
 }finally{f.s.close();}
});
test('a human label added between the read and update survives synchronization',async()=>{
 const f=fixture();try{
  f.injectHumanLabel();
  await f.blockers().sync(f.config);
  expect(f.labels).toContain('human-concurrent');
  expect(f.labels).toContain(labelId);
  expect(f.labels).toContain('ready');
 }finally{f.s.close();}
});
test('uncertain comment delivery is never reposted blindly',async()=>{
 const f=fixture();try{
  f.loseCreate();const first=await f.blockers().sync(f.config);
  expect(first[0].state).toBe('blocked');expect(first[0].reason).toContain('never repost blindly');
  const second=await f.blockers().sync(f.config);
  expect(second[0].state).toBe('blocked');expect(second[0].reason).toContain('never repost');
  expect(f.creates).toBe(1);expect(f.comments.length).toBe(0);
 }finally{f.s.close();}
});
test('blocker synchronization refuses missing or malformed labels',async()=>{
 const f=fixture();try{
  await expect(f.blockers().sync({linear:{projectId:'p',teamId:'t'},blockerSync:{enabled:true}} as any)).rejects.toThrow('UUID');
 }finally{f.s.close();}
});
test('blockerSync requires a boolean and a complete UUID',()=>{
 const base:any={version:1,name:'Project',repo:'/repo',linear:{projectId:'00000000-0000-0000-0000-000000000001',teamId:'00000000-0000-0000-0000-000000000002',readyStateId:'00000000-0000-0000-0000-000000000003',readyLabelId:'00000000-0000-0000-0000-000000000004'},requiredChecks:['CI']};
 expect(()=>validate({...base,blockerSync:{enabled:true,labelId:'------------------------------------'}})).toThrow('UUID');
 expect(()=>validate({...base,blockerSync:{enabled:'false',labelId:labelId}})).toThrow('boolean');
 expect(()=>validate({...base,blockerSync:{enabled:true,labelId:base.linear.readyLabelId}})).toThrow('queue label');
 expect(()=>validate({...base,blockerSync:{enabled:false,labelId:'invalid'}})).not.toThrow();
});
test('retraction removes only the label this bridge applied',async()=>{
 const f=fixture();const other='22222222-2222-2222-2222-222222222222';try{
  await f.blockers().sync(f.config);
  expect(f.labels).toContain(labelId);
  f.addLabel(other);
  const result=await f.blockers().retract(f.id,{...f.config,blockerSync:{enabled:true,labelId:other}} as any);
  expect(result.state).toBe('retracted');expect(f.labels).toContain(other);expect(f.labels).not.toContain(labelId);
 }finally{f.s.close();}
});
test('ambiguous legacy label ownership is preserved for manual inspection',async()=>{
 const f=fixture();try{
  await f.blockers().sync(f.config);
  f.s.db.query('UPDATE blocker_notices SET applied_label_id=NULL WHERE job=?').run(f.id);
  const before=f.calls;
  const result=await f.blockers().retract(f.id,f.config);
  expect(result.state).toBe('needs_reconciliation');expect(result.reason).toContain('predates label tracking');
  expect(f.labels).toContain(labelId);expect(f.calls).toBe(before);
 }finally{f.s.close();}
});
test('queue label cannot be configured as the blocker label',async()=>{
 const f=fixture();try{
  await expect(f.blockers().sync({linear:{projectId:'p',teamId:'t',readyLabelId:labelId},blockerSync:{enabled:true,labelId}})).rejects.toThrow('queue label');
 }finally{f.s.close();}
});
test('a spec change retracts a stale bridge-applied blocker label',async()=>{
 const f=fixture();try{
  await f.blockers().sync(f.config);expect(f.labels).toContain(labelId);
  f.s.enqueue('p','issue','changed specification');
  expect(f.s.get(f.id).state).toBe('awaiting_plan');
  const result=await f.blockers().sync(f.config);
  expect(result.some((row:any)=>row.state==='retracted')).toBe(true);
  expect(f.labels).not.toContain(labelId);expect(f.comments.length).toBe(1);
 }finally{f.s.close();}
});
test('disabled blocker sync and retraction perform no Linear work',async()=>{
 const f=fixture();try{
  await f.blockers().sync(f.config);expect(f.labels).toContain(labelId);
  const before=f.calls;
  expect(await f.blockers().sync({...f.config,blockerSync:{enabled:false,labelId}})).toEqual([]);
  expect((await f.blockers().retract(f.id,{...f.config,blockerSync:{enabled:false,labelId}})).state).toBe('disabled');
  expect(f.calls).toBe(before);expect(f.labels).toContain(labelId);
 }finally{f.s.close();}
});

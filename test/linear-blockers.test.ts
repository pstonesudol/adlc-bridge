import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {LinearBlockers} from '../src/linear-blockers';
import {validate} from '../src/linear';
import {ConflictRecovery} from '../src/conflict-recovery';

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
test('conflict recovery blockers and completion reuse dedupe without granting readiness',async()=>{
 const f=fixture();try{
  f.running();new ConflictRecovery(f.s).install();
  f.s.db.query('INSERT INTO conflict_recoveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('recovery',f.id,f.s.get(f.id).plan_hash,'/tree','session','owner/repo',1,'feature','main','head','base','{}','resolving','client',1,'{}','app.txt requires a security decision',1);
  await f.blockers().sync(f.config);await f.blockers().sync(f.config);
  expect(f.creates).toBe(1);expect(f.labels).toContain(labelId);expect(f.comments[0].body).toContain('app.txt');
  f.s.db.query("UPDATE conflict_recoveries SET state='completed',reason=NULL,detail=?").run(JSON.stringify({result:'new-sha'}));
  await f.blockers().sync(f.config);await f.blockers().sync(f.config);
  expect(f.creates).toBe(2);expect(f.labels).not.toContain(labelId);expect(f.comments[1].body).toContain('new-sha');expect(f.comments[1].body).toContain('not readiness');
  expect(f.s.get(f.id).state).toBe('approved');
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

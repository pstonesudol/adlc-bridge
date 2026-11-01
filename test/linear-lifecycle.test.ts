import {test,expect} from 'bun:test';import {Store} from '../src/core';import {Planning} from '../src/planning';import {Workflow} from '../src/workflow';import {ReviewLoop} from '../src/review-loop';import {LinearLifecycle} from '../src/linear-lifecycle';import {Lifecycle} from '../src/lifecycle';
const c={linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},githubRepo:'owner/repo',statusSync:{enabled:true,inProgress:'progress',inReview:'review',done:'done'}};
function fixture(){const s=new Store(':memory:');new Workflow(s,{} as any);new ReviewLoop(s);new Lifecycle(s);const spec={identifier:'DEV-1',title:'Task',description:'Requirements'},id=s.enqueue('p','issue',JSON.stringify(spec));const p=new Planning(s);p.reserve(id,'ao');p.gate(id,'ao','worker',p.get(id).branch,'/worktree');let state='todo',updates=0,merged=false,lost=false,noticeFailure=false,noticeCalls=0;const posted:any[]=[],issueChanges:any={};let beforeAPI:(q:string)=>void=()=>{};
 const issue=()=>({id:'issue',...spec,project:{id:'p'},team:{id:'t'},state:{id:state},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}},...issueChanges});
 const api=async(q:string,v:any)=>{
  beforeAPI(q);
  if(q.includes('workflowState'))return {workflowState:{id:v.id,type:v.id==='done'?'completed':'started',team:{id:'t'}}};
  if(q.includes('commentCreate')){noticeCalls++;if(noticeFailure)throw Error('Lost notice reply');const comment={id:v.input.id,body:v.input.body,createdAt:new Date().toISOString()};posted.push(comment);return {commentCreate:{success:true,comment}};}
  if(q.includes('comments(first'))return {issue:{id:'issue',comments:{nodes:posted,pageInfo:{hasNextPage:false,endCursor:null}}}};
  if(q.includes('issueUpdate')){updates++;state=v.state;if(lost){lost=false;throw Error('Lost status reply');}return {issueUpdate:{success:true,issue:issue()}};}
  return {issue:issue()};
 };
 const sync=new LinearLifecycle(s,api,async()=>({state:merged?'closed':'open',merged}));
 return {s,id,sync,issueChanges,intercept(callback:(q:string)=>void){beforeAPI=callback;},get noticeCalls(){return noticeCalls;},failNotice(){noticeFailure=true;},get state(){return state;},get updates(){return updates;},get posted(){return posted;},merge(){merged=true;},lost(){lost=true;},manual(value:string){state=value;}};
}
test('owned ticket moves In Progress → In Review → Done only after observed merge',async()=>{
 const f=fixture();try{await f.sync.sync(c);expect(f.state).toBe('progress');f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(f.id,'owner/repo',1,'["CI"]','["**"]',Date.now());
 await f.sync.sync(c);expect(f.state).toBe('review');expect(f.s.get(f.id).state).not.toBe('done');f.merge();await f.sync.sync(c);expect(f.state).toBe('done');expect(f.s.get(f.id).state).toBe('done');expect(f.updates).toBe(3);
 }finally{f.s.close();}
});
test('exhausted remediation posts one idempotent Linear blocker notice',async()=>{
 const f=fixture();try{
  f.s.db.query('INSERT INTO remediation_budget(job,consumed,extensions,no_progress,last_head,stop_reason,configured_max_attempts,configured_max_no_progress,window) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(f.id,5,0,1,'a'.repeat(40),'budget_exhausted',5,5,'job');
  f.s.db.query("UPDATE jobs SET state='blocked',reason='Remediation budget exhausted' WHERE id=?").run(f.id);
  const first=await f.sync.sync(c);expect(f.posted.length).toBe(1);expect(first.some((x:any)=>x.phase==='remediation-blocker'&&x.state==='posted')).toBe(true);
  await f.sync.sync(c);expect(f.posted.length).toBe(1);
 }finally{f.s.close();}
});
test('lost status reply reconciles without replay; subsequent manual change is preserved',async()=>{
 const f=fixture();try{f.lost();await f.sync.sync(c);expect(f.updates).toBe(1);await f.sync.sync(c);expect(f.updates).toBe(1);f.manual('todo');const result=await f.sync.sync(c);expect(result[0].state).toBe('needs_reconciliation');expect(f.state).toBe('todo');expect(f.updates).toBe(1);}finally{f.s.close();}
});

test('review-stage branch drift posts one notice and blocks in-review',async()=>{
 const f=fixture();try{
  const reason='Blocked — branch mismatch: reserved old; actual new; candidate https://github.com/owner/repo/pull/7; preview recover-handoff';
  f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since,state,reason) VALUES (?,?,?,?,?,?,?,?)').run(f.id,'owner/repo',7,'["CI"]','["src/**"]',Date.now(),'blocked',reason);
  const first=await f.sync.sync(c);expect(first[0]).toEqual({job:f.id,state:'blocked',reason});
  await f.sync.sync(c);
  expect(f.s.db.query('SELECT count(*) AS n FROM branch_drift_notices').get()).toEqual({n:1});
  expect(f.posted.length).toBe(1);expect(f.state).toBe('todo');expect(f.updates).toBe(0);
 }finally{f.s.close();}
});
function budgetBlocked(){
 const f=fixture();f.s.db.query('INSERT INTO remediation_budget(job,consumed,stop_reason,configured_max_attempts,configured_max_no_progress) VALUES (?,?,?,?,?)').run(f.id,5,'budget_exhausted',5,5);
 f.s.db.query("UPDATE jobs SET state='blocked' WHERE id=?").run(f.id);return f;
}
test('uncertain blocker delivery never reposts and changed bodies reject reconciliation',async()=>{
 for(const tamper of [false,true]){
  const f=budgetBlocked();try{
   f.failNotice();const first=await f.sync.sync(c);expect(first[0].error).toContain('Lost notice reply');
   const n=f.s.db.query('SELECT * FROM remediation_notices WHERE job=?').get(f.id) as any;
   expect(n.state).toBe('delivery_uncertain');
   if(tamper)f.posted.push({id:n.comment_id,body:'tampered',createdAt:new Date().toISOString()});
   const next=await f.sync.sync(c);expect(next[0].error).toContain(tamper?'Posted remediation notice changed':'never repost blindly');
   expect(f.noticeCalls).toBe(1);
  }finally{f.s.close();}
 }
});
test('blocker comments reject changed issue identity, incomplete labels and requirements',async()=>{
 for(const change of [{id:'other'},{project:{id:'other'}},{team:{id:'other'}},{labels:{nodes:[],pageInfo:{hasNextPage:true}}},{description:'changed'}]){
  const f=budgetBlocked();try{
   Object.assign(f.issueChanges,change);const result=await f.sync.sync(c);
   expect(result[0].error).toBeTruthy();expect(f.noticeCalls).toBe(0);
  }finally{f.s.close();}
 }
});
test('human merge of budget-blocked PR still completes Linear, job, run and review target',async()=>{
 const f=budgetBlocked();try{
  f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(f.id,'owner/repo',1,'["CI"]','["src/**"]',Date.now());
  f.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state) VALUES (?,?,?,?)').run(f.id,'correlation','hash','blocked');
  await f.sync.sync(c);expect(f.state).toBe('todo');
  f.merge();await f.sync.sync(c);expect(f.state).toBe('done');expect(f.s.get(f.id).state).toBe('done');
  expect((f.s.db.query('SELECT state FROM runs WHERE job=?').get(f.id) as any).state).toBe('completed');
  expect((f.s.db.query('SELECT state FROM review_targets WHERE job=?').get(f.id) as any).state).toBe('completed');
 }finally{f.s.close();}
});

test('notice failures do not prevent observed merge completion or replay uncertain comments',async()=>{
 for(const failure of ['initial','uncertain','tampered']){
  const f=budgetBlocked();try{
   f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(f.id,'owner/repo',1,'["CI"]','["src/**"]',Date.now());
   f.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state) VALUES (?,?,?,?)').run(f.id,'correlation','hash','blocked');
   f.failNotice();
   if(failure!=='initial'){
    await f.sync.sync(c);expect(f.state).toBe('todo');expect(f.s.get(f.id).state).toBe('blocked');
    if(failure==='tampered'){
     const n=f.s.db.query('SELECT * FROM remediation_notices WHERE job=?').get(f.id) as any;
     f.posted.push({id:n.comment_id,body:'tampered',createdAt:new Date().toISOString()});
    }
   }
   f.merge();const result=await f.sync.sync(c);
   expect(result[0]).toMatchObject({job:f.id,phase:'remediation-blocker'});
   expect(result[0].error).toContain(failure==='initial'?'Lost notice reply':failure==='uncertain'?'never repost blindly':'Posted remediation notice changed');
   expect(result.some((x:any)=>x.phase==='done'&&x.state==='confirmed')).toBe(true);
   expect(f.state).toBe('done');expect(f.s.get(f.id).state).toBe('done');expect(f.noticeCalls).toBe(1);
   expect((f.s.db.query('SELECT state FROM runs WHERE job=?').get(f.id) as any).state).toBe('completed');
   expect((f.s.db.query('SELECT state FROM review_targets WHERE job=?').get(f.id) as any).state).toBe('completed');
   expect((f.s.db.query('SELECT state FROM remediation_notices WHERE job=?').get(f.id) as any).state).toBe('delivery_uncertain');
  }finally{f.s.close();}
 }
});

test('notice failure does not bypass requirements validation for merged work',async()=>{
 const f=budgetBlocked();try{
  f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(f.id,'owner/repo',1,'["CI"]','["src/**"]',Date.now());
  f.failNotice();await f.sync.sync(c);f.issueChanges.description='changed';f.merge();
  const result=await f.sync.sync(c);
  expect(result.some((x:any)=>x.phase==='remediation-blocker'&&x.error)).toBe(true);
  expect(result.some((x:any)=>x.error==='Requirements changed; refusing status update')).toBe(true);
  expect(f.state).toBe('todo');expect(f.s.get(f.id).state).toBe('blocked');expect(f.updates).toBe(0);expect(f.noticeCalls).toBe(1);
 }finally{f.s.close();}
});

test('concurrent intake cannot complete old work against refreshed requirements',async()=>{
 for(const during of ['commentCreate','workflowState','issueUpdate']){
  const f=budgetBlocked();try{
   f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(f.id,'owner/repo',1,'["CI"]','["src/**"]',Date.now());
   f.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state) VALUES (?,?,?,?)').run(f.id,'correlation','hash','blocked');
   f.failNotice();f.merge();let changed=false;
   f.intercept(q=>{
    if(!changed&&q.includes(during)){
     changed=true;f.issueChanges.description='new requirements';
     f.s.enqueue('p','issue',JSON.stringify({identifier:'DEV-1',title:'Task',description:'new requirements'}));
    }
   });
   const result=await f.sync.sync(c);expect(changed).toBe(true);
   expect(result.some((x:any)=>x.error?.includes('Run requirements binding changed or missing'))).toBe(true);
   expect(f.s.get(f.id).state).toBe('awaiting_plan');expect(f.s.get(f.id).approved_hash).toBeNull();
   expect((f.s.db.query('SELECT state FROM runs WHERE job=?').get(f.id) as any).state).toBe('blocked');
   expect((f.s.db.query('SELECT state FROM review_targets WHERE job=?').get(f.id) as any).state).not.toBe('completed');
   expect(f.updates).toBe(during==='issueUpdate'?1:0);
   const transition=f.s.db.query("SELECT state FROM linear_transitions WHERE job=? AND phase='done'").get(f.id) as any;
   expect(transition?.state??null).toBe(during==='issueUpdate'?'delivery_uncertain':null);
  }finally{f.s.close();}
 }
});

test('missing or replaced planning binding fails closed before status writes',async()=>{
 for(const binding of ['', 'stale']){
  const f=fixture();try{
   f.s.db.query('UPDATE planning_runs SET spec_hash=? WHERE job=?').run(binding,f.id);
   const result=await f.sync.sync(c);expect(result[0].error).toContain('Run requirements binding changed or missing');
   expect(f.updates).toBe(0);expect(f.state).toBe('todo');
  }finally{f.s.close();}
 }
});

test('requirements binding is rechecked inside terminal completion transaction',async()=>{
 const f=budgetBlocked();try{
  f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(f.id,'owner/repo',1,'["CI"]','["src/**"]',Date.now());
  f.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state) VALUES (?,?,?,?)').run(f.id,'correlation','hash','blocked');
  const move=f.sync.move.bind(f.sync);
  f.sync.move=async(...args:Parameters<typeof move>)=>{
   const result=await move(...args);
   f.s.enqueue('p','issue',JSON.stringify({identifier:'DEV-1',title:'Task',description:'new requirements'}));
   return result;
  };
  f.merge();const result=await f.sync.sync(c);
  expect(result.some((x:any)=>x.error?.includes('Run requirements binding changed or missing'))).toBe(true);
  expect(f.s.get(f.id).state).toBe('awaiting_plan');
  expect((f.s.db.query('SELECT state FROM runs WHERE job=?').get(f.id) as any).state).toBe('blocked');
  expect((f.s.db.query('SELECT state FROM review_targets WHERE job=?').get(f.id) as any).state).not.toBe('completed');
 }finally{f.s.close();}
});

test('branch mismatch sync posts one notice and confirms uncertain delivery by comment ID',async()=>{
 const f=fixture();try{
  const reason='Blocked — branch mismatch: reserved old; actual new; candidate https://github.com/owner/repo/pull/7; run recover-handoff';
  f.s.db.query('INSERT INTO implementation_dispatch(job,plan_hash,session_id,client_id,state,paths,runtime,actor,reason) VALUES (?,?,?,?,?,?,?,?,?)').run(f.id,'a'.repeat(64),'worker','client','blocked','["**"]','supervised-host','human',reason);
  const comments:any[]=[];let calls=0;const original=f.sync.api;
  f.sync.api=async(q,v)=>{
   if(q.includes('commentCreate')){calls++;expect(v.input.id).toMatch(/^[0-9a-f-]{36}$/);expect(v.input.body).toContain('reserved old; actual new');expect(v.input.body).toContain('--confirm HASH');comments.push({id:v.input.id,body:v.input.body});throw Error('Lost receipt');}
   if(q.includes('comments('))return {issue:{comments:{nodes:comments.slice(),pageInfo:{hasNextPage:false,endCursor:null}}}};
   return original(q,v);
  };
  const first=await f.sync.sync(c);expect(first[0].error).toBe('Lost receipt');expect(calls).toBe(1);expect(f.updates).toBe(0);
  const second=await f.sync.sync(c);expect(second[0]).toEqual({job:f.id,state:'blocked',reason});expect(calls).toBe(1);expect(comments.length).toBe(1);expect(f.updates).toBe(0);
  expect(f.s.db.query('SELECT state FROM branch_drift_notices').all()).toEqual([{state:'confirmed'}]);
 }finally{f.s.close();}
});

test('uncertain drift notice stays fail-closed without an exact comment',async()=>{
 const f=fixture();try{
  const reason='Blocked — branch mismatch: reserved old; actual new; candidate https://github.com/owner/repo/pull/7; run recover-handoff';
  let comments:any[]=[],creates=0,body='';const original=f.sync.api;
  f.sync.api=async(q,v)=>{
   if(q.includes('commentCreate')){creates++;body=v.input.body;comments=[{id:v.input.id,body:v.input.body}];throw Error('Lost receipt');}
   if(q.includes('comments('))return {issue:{comments:{nodes:comments,pageInfo:{hasNextPage:false,endCursor:null}}}};
   return original(q,v);
  };
  await expect(f.sync.driftNotice(f.id,reason,c)).rejects.toThrow('Lost receipt');
  const commentId=(f.s.db.query('SELECT comment_id FROM branch_drift_notices WHERE job=?').get(f.id) as any).comment_id;
  comments=[];await expect(f.sync.driftNotice(f.id,reason,c)).rejects.toThrow('no blind replay');
  expect(f.s.db.query('SELECT state FROM branch_drift_notices WHERE job=?').get(f.id).state).toBe('delivery_uncertain');
  comments=[{id:commentId,body:'different body'}];await expect(f.sync.driftNotice(f.id,reason,c)).rejects.toThrow('no blind replay');
  expect(f.s.db.query('SELECT state FROM branch_drift_notices WHERE job=?').get(f.id).state).toBe('delivery_uncertain');
  comments=[{id:'00000000-0000-4000-8000-000000000000',body}];await expect(f.sync.driftNotice(f.id,reason,c)).rejects.toThrow('no blind replay');
  expect(f.s.db.query('SELECT state FROM branch_drift_notices WHERE job=?').get(f.id).state).toBe('delivery_uncertain');
  expect(creates).toBe(1);
 }finally{f.s.close();}
});
test('drift notice confirms a matching comment on a later page',async()=>{
 const f=fixture();try{
  const reason='Blocked — branch mismatch: reserved old; actual new; candidate https://github.com/owner/repo/pull/7; run recover-handoff';
  let commentId='',body='',pages=0;const original=f.sync.api;
  f.sync.api=async(q,v)=>{
   if(q.includes('commentCreate')){commentId=v.input.id;body=v.input.body;throw Error('Lost receipt');}
   if(q.includes('comments(')){
    pages++;
    if(pages===1)return {issue:{comments:{nodes:[{id:'unrelated',body:'other'}],pageInfo:{hasNextPage:true,endCursor:'cursor-1'}}}};
    expect(v.after).toBe('cursor-1');
    return {issue:{comments:{nodes:[{id:commentId,body}],pageInfo:{hasNextPage:false,endCursor:null}}}};
   }
   return original(q,v);
  };
  await expect(f.sync.driftNotice(f.id,reason,c)).rejects.toThrow('Lost receipt');
  await f.sync.driftNotice(f.id,reason,c);
  expect(pages).toBe(2);expect(f.s.db.query('SELECT state FROM branch_drift_notices WHERE job=?').get(f.id).state).toBe('confirmed');
 }finally{f.s.close();}
});

test('combined budget and branch blockers preserve observed merge completion and requirements checks',async()=>{
 for(const noticeFails of [false,true])for(const merged of [false,true])for(const changed of [false,true]){
  const f=budgetBlocked();try{
   const reason='Blocked — branch mismatch: reserved old; actual new; candidate https://github.com/owner/repo/pull/7';
   f.s.db.query('INSERT INTO implementation_dispatch(job,plan_hash,session_id,client_id,state,paths,runtime,actor,reason) VALUES (?,?,?,?,?,?,?,?,?)').run(f.id,'hash','worker','client','blocked','["src/**"]','supervised-host','human',reason);
   f.s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(f.id,'owner/repo',7,'["CI"]','["src/**"]',Date.now());
   f.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state) VALUES (?,?,?,?)').run(f.id,'correlation','hash','blocked');
   f.sync.driftNotice=async()=>{if(noticeFails)throw Error('Drift notice unavailable');};
   if(merged)f.merge();if(changed)f.issueChanges.description='changed';
   const result=await f.sync.sync(c),done=merged&&!changed;
   expect(f.s.get(f.id).state).toBe(done?'done':'blocked');
   expect(f.state).toBe(done?'done':'todo');expect(f.updates).toBe(done?1:0);
   expect((f.s.db.query('SELECT state FROM runs WHERE job=?').get(f.id) as any).state).toBe(done?'completed':'blocked');
   if(noticeFails)expect(result.some((x:any)=>x.phase==='branch-drift'&&x.error==='Drift notice unavailable')).toBe(true);
  }finally{f.s.close();}
 }
});

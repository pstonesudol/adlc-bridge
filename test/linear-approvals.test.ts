import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {ApprovalPolicyStore} from '../src/approval-policy';
import {LinearApprovals,parsePlanApproval} from '../src/linear-approvals';
import {recordReadiness} from '../src/readiness';
import {SpecRecovery} from '../src/spec-recovery';
import {latestRevision} from '../src/spec-revisions';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {planningPRFixture} from './planning-pr-fixture';
function fixture(path=':memory:'){
 const s=new Store(path),approver='00000000-0000-0000-0000-000000000001';let sends=0,creates=0,lost=false;
 const c:any={repo:'/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},requiredChecks:['CI'],automation:{planningEnabled:false,orchestratorProject:'ao'},approval:{mode:'ready-queue'},planApproval:{enabled:true,approverIds:[approver],scope:['src/**']}};
 const issue:any={id:'issue',identifier:'DEV-12',title:'Task',description:'Requirement',team:{id:'t'},project:{id:'p'},state:{id:'todo'},labels:{nodes:[{id:'ready'},{id:'gate',name:'plan-approval-required'}],pageInfo:{hasNextPage:false}}};
 const spec=JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description});
 const w=new Workflow(s,{startPlan:async()=>{throw Error('Unexpected start');},findPlans:async()=>[],disableFeedback:async()=>{},sendImplementation:async()=>{sends++;},evidence:async()=>({session:{id:'worker',projectId:'ao',branch:p.get(id).branch,isTerminated:false},transcript:{controller:'ready',entries:[],turns:[]}})});
 const id=s.enqueue('p','issue',spec),p=new Planning(s);p.reserve(id,'ao');p.gate(id,'ao','worker',p.get(id).branch,'/worktree');
 s.propose(id,'Plan: edit src/a.ts and run checks');recordReadiness(s,id,'Plan: edit src/a.ts and run checks\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->',s.get(id).plan_hash,digest(spec));s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?,?,?,?)').run(id,digest(spec),'awaiting_approval','worker',null,'plan');
 new ApprovalPolicyStore(s).snapshot('p',new Set(['issue']),Date.now(),new Set(['issue']));
 const comments:any[]=[];
 const api=async(q:string,v:any)=>{
  if(q.startsWith('mutation')){creates++;const comment={id:v.input.id,body:v.input.body,createdAt:new Date(Date.now()-10000).toISOString(),editedAt:null,user:{id:approver,app:false},botActor:null};comments.push(comment);if(lost)throw Error('Reply lost');return {commentCreate:{success:true,comment}};}
  if(q.includes('comments(first:'))return {issue:{id:'issue',comments:{nodes:comments,pageInfo:{hasNextPage:false}}}};
  return {issue};
 };
 const surface=new LinearApprovals(s,w,api);
 const approve=(user=approver,extra:any={})=>{const n=s.db.query('SELECT * FROM plan_approval_notices ORDER BY rowid DESC LIMIT 1').get() as any;comments.push({id:`reply-${comments.length}`,body:`Approve ADLC plan ${n.token}`,createdAt:new Date().toISOString(),editedAt:null,user:{id:user,app:false},botActor:null,...extra});};
 return {s,c,id,w,issue,comments,surface,approve,counts:()=>({sends,creates}),lose:()=>lost=true};
}
test('publishes one plan; exact human reply approves once, implementation starts on next workflow tick',async()=>{
 const f=fixture();try{expect((await f.surface.sync(f.c))[0].state).toBe('awaiting_human_approval');await f.surface.sync(f.c);expect(f.counts()).toEqual({sends:0,creates:1});
 f.approve();expect((await f.surface.sync(f.c))[0].state).toBe('approved');expect(f.s.get(f.id).actor).toContain('Linear user');expect(f.counts().sends).toBe(0);
 await f.surface.sync(f.c);await f.w.tick(f.c);expect(f.counts().sends).toBe(1);
 }finally{f.s.close();}
});
test('invalid plan evidence cannot publish a misleading manual approval notice',async()=>{
 const f=fixture();try{
  const hash=f.s.propose(f.id,'Revised plan without readiness');recordReadiness(f.s,f.id,'Revised plan without readiness',hash,digest(f.s.get(f.id).spec));
  const result=(await f.surface.sync(f.c))[0];expect(result.state).toBe('approval_blocked');expect(result.reason).toContain('plan-reconcile');expect(f.counts().creates).toBe(0);
 }finally{f.s.close();}
});
test('human approval notices summarize eligibility and gate without embedding agent control context',async()=>{
 const f=fixture();try{
  await f.surface.sync(f.c);const body=f.comments[0].body;
  expect(body).toContain('Ticket eligibility verified from current Linear state and readiness label');
  expect(body).toContain('explicit human plan approval required');
  expect(body).not.toContain('host control data');expect(body).not.toContain('Do not ask the human');
  expect(body).not.toContain('"planApprovalRequired"');expect(body).not.toContain('"evidence"');
  expect(body).toContain('Approve ADLC plan');expect(body).toContain('Only configured human approvers');
 }finally{f.s.close();}
});
test('unrevised plans preserve the legacy approval notice binding and pending token',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-legacy-approval-')),path=join(dir,'state.db'),f=fixture(path);let reopened:Store|undefined,closed=false;
 try{
   const j=f.s.get(f.id),route=f.w.router.get(f.id,'implementation');
   const legacy=digest(JSON.stringify([j.spec,j.plan_hash,route?.route??null,f.c.planApproval,f.c.approval??{mode:'manual'}]));
   const token='33333333-3333-3333-3333-333333333333',comment='22222222-2222-2222-2222-222222222222',created=new Date(Date.now()-10000).toISOString(),body=`Legacy plan notice\n\n\`\`\`text\nApprove ADLC plan ${token}\n\`\`\``;
   // Seed the pre-upgrade digest and persisted notice independently of binding().
   f.s.db.query("INSERT INTO plan_approval_notices(job,binding,plan_hash,comment_id,token,body,state,created) VALUES (?,?,?,?,?,?,'posted',?)").run(f.id,legacy,j.plan_hash,comment,token,body,created);
   f.comments.push({id:comment,body,createdAt:created,editedAt:null,user:{id:f.c.planApproval.approverIds[0],app:false},botActor:null});
   f.s.close();closed=true;reopened=new Store(path);
   f.comments.push({id:'original-token-reply',body:`Approve ADLC plan ${token}`,createdAt:new Date().toISOString(),editedAt:null,user:{id:f.c.planApproval.approverIds[0],app:false},botActor:null});
   const surface=new LinearApprovals(reopened,new Workflow(reopened,f.w.t),f.surface.api);
   expect(surface.binding(f.id,f.c)).toBe(legacy);
   expect((await surface.sync(f.c))[0].state).toBe('approved');
   expect(f.counts().creates).toBe(0);expect(f.comments).toHaveLength(2);
   expect(reopened.db.query('SELECT token,state,approval_comment FROM plan_approval_notices WHERE job=?').get(f.id)).toEqual({token,state:'approved',approval_comment:'original-token-reply'});
 }finally{reopened?.close();if(!closed)f.s.close();rmSync(dir,{recursive:true,force:true});}
});
test('unauthorized, bot-authored, edited, and quoted approvals cannot release gate',async()=>{
 const f=fixture();try{await f.surface.sync(f.c);f.approve('outsider');f.approve(undefined,{botActor:{id:'bot'}});f.approve(undefined,{editedAt:new Date().toISOString()});f.approve(undefined,{user:{id:f.c.planApproval.approverIds[0],app:true}});f.approve(undefined,{body:'> Approve ADLC plan quoted'});
 await f.surface.sync(f.c);expect(f.s.get(f.id).state).toBe('awaiting_approval');expect(f.counts().sends).toBe(0);
 }finally{f.s.close();}
});
test('restored spec and plan hashes publish a revision-specific notice and reject the old token',async()=>{
 const f=fixture();try{
  const original=f.s.get(f.id);await f.surface.sync(f.c);
  const before=f.surface.binding(f.id,f.c);
  f.s.enqueue('p','issue','Changed requirements');f.approve();
  f.s.enqueue('p','issue',original.spec);f.s.propose(f.id,original.plan);
  expect(f.s.get(f.id).plan_hash).toBe(original.plan_hash);
  expect(f.surface.binding(f.id,f.c)).not.toBe(before);
  expect((await f.surface.sync(f.c))[0].state).toBe('awaiting_human_approval');
  expect(f.counts().creates).toBe(2);
  expect((await f.surface.sync(f.c))[0].state).toBe('awaiting_human_approval');
  expect(f.s.get(f.id).approved_hash).toBeNull();
  f.approve();expect((await f.surface.sync(f.c))[0]).toMatchObject({state:'approval_blocked',reason:'Exact captured replan for the current requirement revision required'});
  expect(f.w.implementation(f.id)).toBeNull();expect(f.s.get(f.id).approved_hash).toBeNull();
  // A fresh notice alone cannot replace capture, even before first execution.
  // Start a real same-owner revised planning turn and capture its exact reply.
  f.issue.description='Requirement v2';f.s.enqueue('p','issue',JSON.stringify({identifier:f.issue.identifier,title:f.issue.title,description:f.issue.description}));
  f.c.automation.planningEnabled=true;
  const p=new Planning(f.s).get(f.id),e:any={session:{id:'worker',projectId:'ao',branch:p.branch,isTerminated:false,prs:[]},receiptObservation:{complete:true,observed:Date.now()},transcript:{controller:'ready',entries:[],turns:[{id:'initial-plan',state:'completed'}]}};
  f.w.t.evidence=async()=>e;f.w.t.worktree=async()=>({branch:p.branch,head:'a'.repeat(40),tree:'/worktree'});
  f.w.t.planningPRs=planningPRFixture(()=>e);
  f.w.t.sendImplementation=async(_session,_text,clientId)=>{
   e.transcript.entries.push({clientMessageId:clientId,turnId:clientId,sequence:1});
   e.transcript.turns.push({id:clientId,state:'completed'});
   e.transcript.entries.push({sequence:2,turnId:clientId,kind:'message',role:'assistant',origin:'provider',streaming:false,text:`<!-- ADLC_REVISED_PLAN:${latestRevision(f.s,f.id).id} -->\nCurrent revised plan\n<!-- ADLC_PLAN_SCOPE {"version":1,"paths":["src/example.ts"]} -->\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->`});
  };
  const recovery=new SpecRecovery(f.s,f.w,async()=>f.issue,async fn=>fn());
  await recovery.reconcile(f.id,f.c,(await recovery.preview(f.id,f.c)).confirmation);await recovery.capture(f.id,f.c);
  new ApprovalPolicyStore(f.s).snapshot('p',new Set(['issue']),Date.now(),new Set(['issue']));
  expect((await f.surface.sync(f.c))[0].state).toBe('awaiting_human_approval');
  f.approve();expect((await f.surface.sync(f.c))[0].state).toBe('approved');
  expect(f.w.implementation(f.id).session_id).toBe('worker');expect(f.counts().creates).toBe(3);
 }finally{f.s.close();}
});
test('requirements changes and removed eligibility reject a previously issued approval',async()=>{
 const f=fixture();try{await f.surface.sync(f.c);f.approve();f.issue.description='Changed';expect((await f.surface.sync(f.c))[0].state).toBe('approval_blocked');
 f.issue.description='Requirement';f.issue.labels.nodes=[];expect((await f.surface.sync(f.c))[0].state).toBe('approval_blocked');expect(f.s.get(f.id).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
test('lost comment response reconciles the same UUID without duplicate publication',async()=>{
 const f=fixture();try{f.lose();expect((await f.surface.sync(f.c))[0].state).toBe('approval_blocked');expect((await f.surface.sync(f.c))[0].state).toBe('awaiting_human_approval');expect(f.counts().creates).toBe(1);
 }finally{f.s.close();}
});
test('plan or scope changes generate a new challenge; old approval cannot authorize it',async()=>{
 const f=fixture();try{await f.surface.sync(f.c);f.approve();f.c.planApproval.scope=['backend/**'];expect((await f.surface.sync(f.c))[0].state).toBe('awaiting_human_approval');expect(f.counts().creates).toBe(2);
 await f.surface.sync(f.c);expect(f.s.get(f.id).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});

test('new plan hash and expired eligibility cannot consume an old approval',async()=>{
 const f=fixture();try{await f.surface.sync(f.c);f.approve();const revised='Revised plan\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->',hash=f.s.propose(f.id,revised);recordReadiness(f.s,f.id,revised,hash,digest(f.s.get(f.id).spec));
 expect((await f.surface.sync(f.c))[0].state).toBe('awaiting_human_approval');expect(f.counts().creates).toBe(2);
 await f.surface.sync(f.c);expect(f.s.get(f.id).state).toBe('awaiting_approval');
 new ApprovalPolicyStore(f.s).snapshot('p',new Set(['issue']),Date.now()-121000,new Set(['issue']));
 expect((await f.surface.sync(f.c))[0].state).toBe('approval_blocked');expect(f.counts().sends).toBe(0);
 }finally{f.s.close();}
});
test('partial comment inventory cannot accept an otherwise valid human reply',async()=>{
 const f=fixture();try{await f.surface.sync(f.c);f.approve();const api=f.surface.api;
 f.surface.api=async(q,v)=>q.includes('comments(first:')?{issue:{id:'issue',comments:{nodes:f.comments,pageInfo:{hasNextPage:true,endCursor:null}}}}:api(q,v);
 expect((await f.surface.sync(f.c))[0].state).toBe('approval_blocked');expect(f.s.get(f.id).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
test('uncertain missing notice never creates a duplicate on retry',async()=>{
 const f=fixture();try{f.lose();await f.surface.sync(f.c);f.comments.length=0;
 expect((await f.surface.sync(f.c))[0].state).toBe('approval_blocked');expect(f.counts().creates).toBe(1);
 }finally{f.s.close();}
});

const token='12345678-1234-1234-1234-123456789abc',command=`Approve ADLC plan ${token}`;
test('narrow presentation grammar preserves command bytes',()=>{
 for(const body of [command,` \t\r\n${command}\r\n\u00a0`,`\`${command}\``,`\u00a0\`${command}\`\n`,`\`\`\`\n${command}\n\`\`\``,` \r\n\`\`\`text\r\n${command}\r\n\`\`\`\r\n`])expect(parsePlanApproval(body)).toBe(command);
 for(const body of [`> ${command}`,`Please ${command}`,`${command}\nThanks`,`${command}\n${command}`,`\`\`${command}\`\``,`\`${command}`,`\`\`\`text\n${command}\n\`\``,`\`\`\`js\n${command}\n\`\`\``,`\`\`\`text\n\`${command}\`\n\`\`\``,`\`\`\`text\n${command}\n\n\`\`\``,command.replace('ADLC plan','ADLC\u00a0plan'),command.replace('Approve','approve'),`${command}\r`,`\u200b${command}`])expect(parsePlanApproval(body)).toBeNull();
});
for(const wrap of [(s:string)=>`\`${s}\``,(s:string)=>` \r\n\`${s}\`\u00a0`,(s:string)=>`\`\`\`text\r\n${s}\r\n\`\`\``]){
 test('formatted original-issue thread reply approves its exact outstanding plan once',async()=>{
  const f=fixture();try{
   await f.surface.sync(f.c);const n=f.s.db.query('SELECT * FROM plan_approval_notices').get() as any;
   f.approve(undefined,{body:wrap(`Approve ADLC plan ${n.token}`),parent:{id:n.comment_id}});f.approve(undefined,{body:wrap(`Approve ADLC plan ${n.token}`)});
   await Promise.all([f.surface.sync(f.c),new LinearApprovals(f.s,f.w,f.surface.api).sync(f.c)]);
   expect(f.s.get(f.id).state).not.toBe('awaiting_approval');
   await new LinearApprovals(f.s,f.w,f.surface.api).sync(f.c);await f.w.tick(f.c);await f.w.tick(f.c);
   expect(f.counts()).toEqual({sends:1,creates:1});
   expect((f.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='linear_human_plan_approval'").get() as any).n).toBe(1);
  }finally{f.s.close();}
 });
}
test('invalid human attempts persist actionable reasons across surface restarts without comments',async()=>{
 const f=fixture();try{
  await f.surface.sync(f.c);const n=f.s.db.query('SELECT * FROM plan_approval_notices').get() as any;
  for(const body of [`> Approve ADLC plan ${n.token}`,n.body,`Approve ADLC plan ${token}`,`Approve ADLC plan ${n.token}\nThanks`]){
   f.approve(undefined,{body});const result=(await f.surface.sync(f.c))[0];expect(result.reason).toContain('new, unedited');
   expect((f.s.db.query('SELECT reason FROM plan_approval_notices').get() as any).reason).toBe(result.reason);
  }
  const reason=(f.s.db.query('SELECT reason FROM plan_approval_notices').get() as any).reason;
  expect(reason).toContain('new, unedited');
  const restarted=new LinearApprovals(f.s,f.w,f.surface.api);
  expect((f.s.db.query('SELECT reason FROM plan_approval_notices').get() as any).reason).toBe(reason);
  await restarted.sync(f.c);
  expect((f.s.db.query('SELECT reason FROM plan_approval_notices').get() as any).reason).toBe(reason);
  expect(f.counts()).toEqual({sends:0,creates:1});expect(f.s.get(f.id).state).toBe('awaiting_approval');
 }finally{f.s.close();}
});
test('formatted replies retain author, bot, edit, timestamp and issue-inventory checks',async()=>{
 for(const extra of [{user:{id:'outsider',app:false}},{user:{id:'00000000-0000-0000-0000-000000000001',app:true}},{botActor:{id:'bot'}},{editedAt:new Date().toISOString()},{createdAt:'2000-01-01T00:00:00Z'}]){
  const f=fixture();try{await f.surface.sync(f.c);f.approve(undefined,extra);const reply=f.comments.at(-1);reply.body=`\`${reply.body}\``;await f.surface.sync(f.c);expect(f.s.get(f.id).state).toBe('awaiting_approval');}finally{f.s.close();}
 }
 const f=fixture();try{await f.surface.sync(f.c);f.approve();const api=f.surface.api;f.surface.api=async(q,v)=>q.includes('comments(first:')?{issue:{id:'other-issue',comments:{nodes:f.comments,pageInfo:{hasNextPage:false}}}}:api(q,v);expect((await f.surface.sync(f.c))[0].state).toBe('approval_blocked');expect(f.counts().sends).toBe(0);}finally{f.s.close();}
});
test('inline-code stale plan token cannot authorize replacement plan',async()=>{
 const f=fixture();try{await f.surface.sync(f.c);f.approve();const reply=f.comments.at(-1);reply.body=`\`${reply.body}\``;f.s.propose(f.id,'Replacement plan');await f.surface.sync(f.c);await f.surface.sync(f.c);expect(f.s.get(f.id).state).toBe('awaiting_approval');expect(f.counts().sends).toBe(0);}finally{f.s.close();}
});

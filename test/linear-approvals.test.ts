import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {ApprovalPolicyStore} from '../src/approval-policy';
import {LinearApprovals,parsePlanApproval} from '../src/linear-approvals';
import {recordReadiness} from '../src/readiness';
function fixture(){
 const s=new Store(':memory:'),approver='00000000-0000-0000-0000-000000000001';let sends=0,creates=0,lost=false;
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
  f.approve();expect((await f.surface.sync(f.c))[0].state).toBe('approved');
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
 const f=fixture();try{await f.surface.sync(f.c);f.approve();f.s.propose(f.id,'Revised plan');
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

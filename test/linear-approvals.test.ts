import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {ApprovalPolicyStore} from '../src/approval-policy';
import {LinearApprovals} from '../src/linear-approvals';
function fixture(){
 const s=new Store(':memory:'),approver='00000000-0000-0000-0000-000000000001';let sends=0,creates=0,lost=false;
 const c:any={repo:'/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},requiredChecks:['CI'],automation:{planningEnabled:false,orchestratorProject:'ao'},approval:{mode:'ready-queue'},planApproval:{enabled:true,approverIds:[approver],scope:['src/**']}};
 const issue:any={id:'issue',identifier:'DEV-12',title:'Task',description:'Requirement',team:{id:'t'},project:{id:'p'},state:{id:'todo'},labels:{nodes:[{id:'ready'},{id:'gate',name:'plan-approval-required'}],pageInfo:{hasNextPage:false}}};
 const spec=JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description});
 const w=new Workflow(s,{startPlan:async()=>{throw Error('Unexpected start');},findPlans:async()=>[],disableFeedback:async()=>{},sendImplementation:async()=>{sends++;},evidence:async()=>({session:{id:'worker',projectId:'ao',branch:p.get(id).branch,isTerminated:false},transcript:{controller:'ready',entries:[],turns:[]}})});
 const id=s.enqueue('p','issue',spec),p=new Planning(s);p.reserve(id,'ao');p.gate(id,'ao','worker',p.get(id).branch,'/worktree');
 s.propose(id,'Plan: edit src/a.ts and run checks');s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?,?,?,?)').run(id,digest(spec),'awaiting_approval','worker',null,'plan');
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

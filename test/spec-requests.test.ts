import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {SpecRecovery} from '../src/spec-recovery';
import {SpecRequests,parseReplanReply,validateReplanning} from '../src/spec-requests';
import {ApprovalPolicyStore} from '../src/approval-policy';
import {LinearApprovals} from '../src/linear-approvals';
import {latestRevision,revisionStatus} from '../src/spec-revisions';
import {recordReadiness} from '../src/readiness';
import {planPaths} from '../src/file-scope';
import {setProjectIntakePaused} from '../src/turn-submission';
import {planningPRFixture} from './planning-pr-fixture';
import {featureGit} from '../src/approval-policy';
import {ReviewLoop} from '../src/review-loop';
import {Lifecycle} from '../src/lifecycle';
import {activePlanning,PlanningCapacityReached} from '../src/planning-capacity';

const ready='<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->';
const human='11111111-1111-4111-8111-111111111111';
function fixture(path=':memory:'){
 let s=new Store(path),w:Workflow,requests:SpecRequests,recovery:SpecRecovery;
 const c:any={repo:'/repo',githubRepo:'owner/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},automation:{planningEnabled:true,orchestratorProject:'dev110-test'},requiredChecks:['CI'],planApproval:{enabled:true,approverIds:[human],scope:['src/**']},approval:{mode:'ready-queue',id:'standing',authorizedBy:'operator',scope:['src/**'],gitScope:'feature-pr'}};
 const job=s.enqueue('p','issue',JSON.stringify({identifier:'DEV-106',title:'Runtime dependencies',description:'Original'}));
 w=new Workflow(s,{} as any);const p=new Planning(s),r=p.reserve(job,'dev110-test');p.gate(job,'dev110-test','owner',r.branch,'/worktree');
 s.db.query("INSERT INTO planning_dispatch VALUES (?,?,'awaiting_approval','owner',NULL,'initial')").run(job,digest(s.get(job).spec));
 const hash=s.propose(job,'Original plan\n'+ready);recordReadiness(s,job,s.get(job).plan,hash,digest(s.get(job).spec));s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(job);
 const e:any={session:{id:'owner',projectId:'dev110-test',branch:r.branch,isTerminated:false,activity:{state:'idle'},prs:[]},receiptObservation:{complete:true,observed:Date.now()},transcript:{controller:'ready',turns:[{id:'initial',state:'completed'}],entries:[]}};
 const sends:any[]=[],comments:any[]=[];let lose=false,creates=0;
 const transport:any={evidence:async()=>{e.receiptObservation.observed=Date.now();return e;},worktree:async()=>({branch:r.branch,head:'a'.repeat(40),tree:'/worktree'}),disableFeedback:async()=>{},sendImplementation:async(session:string,text:string,clientId:string,mode:string)=>{sends.push({session,text,clientId,mode});e.transcript.entries.push({clientMessageId:clientId,turnId:clientId,sequence:e.transcript.entries.length+1});e.transcript.turns.push({id:clientId,state:'running'});e.transcript.controller='busy';e.session.activity.state='running';if(lose)throw Error('lost send reply');}};
 const issue=()=>({id:'issue',...JSON.parse(s.get(job).spec),project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready',name:'agent-ready'}],pageInfo:{hasNextPage:false}}});
 const api=async(q:string,v:any)=>{
  if(q.startsWith('mutation')){creates++;const comment={...v.input,createdAt:new Date(Date.now()-10000).toISOString(),editedAt:null};comments.push(comment);return {commentCreate:{success:true,comment}};}
  if(q.includes('comments(first:'))return {issue:{id:'issue',comments:{nodes:comments,pageInfo:{hasNextPage:false}}}};
  return {issue:issue()};
 };
 transport.planningPRs=planningPRFixture(()=>e);
 const wire=()=>{w=new Workflow(s,transport);recovery=new SpecRecovery(s,w,async()=>issue(),async f=>f());requests=new SpecRequests(s,w,api,recovery);};wire();
 const snapshot=()=>new ApprovalPolicyStore(s).snapshot('p',new Set(['issue']));
 const edit=(description:string)=>{s.enqueue('p','issue',JSON.stringify({identifier:'DEV-106',title:'Runtime dependencies',description}));snapshot();};
 const row=()=>s.db.query('SELECT * FROM spec_requests WHERE revision=?').get(latestRevision(s,job).id) as any;
 const reply=(body=`Replan ADLC requirements ${row().token}`,extra:any={})=>comments.push({id:`reply-${comments.length}`,body,createdAt:new Date().toISOString(),editedAt:null,user:{id:human,app:false},botActor:null,...extra});
 const complete=(paths=['src/update.ts'])=>{const d=s.db.query('SELECT * FROM spec_replans ORDER BY rowid DESC LIMIT 1').get() as any;e.transcript.controller='ready';e.session.activity.state='idle';e.transcript.turns.at(-1).state='completed';e.transcript.entries.push({kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:d.client_id,sequence:e.transcript.entries.length+1,text:`<!-- ADLC_REVISED_PLAN:${d.revision} -->\nRevised plan\n<!-- ADLC_PLAN_SCOPE ${JSON.stringify({version:1,paths})} -->\n${ready}`});};
 return {get s(){return s;},get w(){return w;},get requests(){return requests;},get recovery(){return recovery;},c,job,e,sends,comments,api,edit,row,reply,complete,snapshot,creates:()=>creates,lose:()=>lose=true,reopen:()=>{s.close();s=new Store(path);wire();}};
}
function capacityPeer(f:ReturnType<typeof fixture>,state='planning',project='p'){
 const job=f.s.enqueue(project,`capacity-${state}-${project}`,JSON.stringify({identifier:'CAP-1',title:'Other planner',description:'Original'}));
 f.s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?,?,?,?)').run(job,digest(f.s.get(job).spec),state,'other-owner',null,`capacity-${job}`);
 return job;
}
for(const automatic of [true,false])test(`capacity wait retains ${automatic?'automatic':'authenticated human'} intent and dispatches once after a slot is free`,async()=>{
 const f=fixture();try{
  f.c.automation.maxPlanning=1;f.c.replanning={automatic};f.edit('revised');
  if(!automatic){await f.requests.sync(f.c);f.reply();}
  const peer=capacityPeer(f);let routed=0;
  f.c.routing={enabled:true};f.w.router.choose=async()=>{routed++;throw Error('Capacity must be checked before routing');};
  expect((await f.requests.sync(f.c)).find(r=>r.job===f.job)).toMatchObject({state:'waiting_for_planning_capacity',nextAction:expect.stringContaining('Wait for configured planning capacity')});
  expect(f.row()).toMatchObject({source:automatic?'automatic':'human',state:'waiting_for_planning_capacity'});
  expect(routed).toBe(0);expect(f.sends).toHaveLength(0);expect(f.s.db.query('SELECT * FROM spec_replans').get()).toBeNull();
  f.s.db.query("UPDATE planning_dispatch SET state='planning_finished' WHERE job=?").run(peer);delete f.c.routing;
  await f.requests.sync(f.c);await f.requests.sync(f.c);expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
for(const state of ['dispatch_uncertain','needs_reconciliation','restore_reserved','restore_setup_consumed'])test(`capacity includes another job's ${state} reservation`,async()=>{
 const f=fixture();try{
  f.c.automation.maxPlanning=1;f.c.replanning={automatic:true};f.edit('revised');
  const peer=capacityPeer(f,state.startsWith('restore_')?'planning_finished':state);
  if(state.startsWith('restore_'))f.s.db.query('INSERT INTO planning_restores VALUES (?,?,?,?,NULL)').run(peer,`restore-${state}`,state.slice('restore_'.length),'{}');
  expect((await f.requests.sync(f.c)).find(r=>r.job===f.job)?.state).toBe('waiting_for_planning_capacity');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('new replan replaces its settled owner slot and does not consume another project capacity',async()=>{
 const f=fixture();try{
  f.c.automation.maxPlanning=1;f.c.replanning={automatic:true};f.edit('revised');
  f.s.db.query("UPDATE planning_dispatch SET state='planning' WHERE job=?").run(f.job);capacityPeer(f,'planning','other-project');
  await f.requests.sync(f.c);expect(f.sends).toHaveLength(1);
  expect(f.s.db.query(`SELECT count(*) AS n FROM planning_dispatch d JOIN jobs j ON j.id=d.job WHERE j.project='p' AND ${activePlanning}`).get()).toEqual({n:1});
 }finally{f.s.close();}
});
test('already-dispatched uncertain replan still reconciles and captures when capacity is full',async()=>{
 const f=fixture();try{
  f.c.automation.maxPlanning=1;f.c.replanning={automatic:true};f.edit('revised');f.lose();await f.requests.sync(f.c);capacityPeer(f);
  expect((await f.requests.sync(f.c)).find(r=>r.job===f.job)?.state).toBe('actively_replanning');expect(f.sends).toHaveLength(1);
  f.complete();expect(await f.w.reconcilePlanning(f.job,f.c)).toMatchObject({state:'awaiting_approval'});expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
for(const change of ['new-reservation','lower-limit'])test(`direct reconciliation rechecks capacity atomically after ${change} during authorization`,async()=>{
 const f=fixture();try{
  f.c.automation.maxPlanning=change==='lower-limit'?2:1;f.edit('revised');if(change==='lower-limit')capacityPeer(f);
  const preview=await f.recovery.preview(f.job,f.c);
  await expect(f.recovery.reconcile(f.job,f.c,preview.confirmation,async()=>{
   if(change==='lower-limit')f.c.automation.maxPlanning=1;else capacityPeer(f);
  })).rejects.toBeInstanceOf(PlanningCapacityReached);
  expect(f.sends).toHaveLength(0);expect(f.s.db.query('SELECT * FROM spec_replans').get()).toBeNull();
 }finally{f.s.close();}
});
test('overlapping revised tickets share one project slot rather than all dispatching in the poll',async()=>{
 const f=fixture();try{
  f.c.automation.maxPlanning=1;f.c.replanning={automatic:true};f.edit('first revision');
  const second=capacityPeer(f,'awaiting_approval'),p=new Planning(f.s),run=p.reserve(second,'dev110-test');p.gate(second,'dev110-test','other-owner',run.branch,'/other-worktree');
  f.s.propose(second,'Original plan\n'+ready);f.s.enqueue('p',f.s.get(second).issue,JSON.stringify({identifier:'CAP-1',title:'Other planner',description:'Second revision'}));
  new ApprovalPolicyStore(f.s).snapshot('p',new Set(['issue',f.s.get(second).issue]));
  const e=structuredClone(f.e);e.session.id='other-owner';e.session.branch=run.branch;
  const w=new Workflow(f.s,{...f.w.t,evidence:async()=>e,worktree:async()=>({branch:run.branch,head:'a'.repeat(40),tree:'/other-worktree'}),sendImplementation:async(session,text,clientId,mode)=>{f.sends.push({session,text,clientId,mode});e.transcript.controller='busy';}});
  const issue=()=>({id:f.s.get(second).issue,...JSON.parse(f.s.get(second).spec),project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}});
  const requests=new SpecRequests(f.s,w,async()=>({issue:issue()}),new SpecRecovery(f.s,w,async()=>issue(),async op=>op()));
  const results=await Promise.allSettled([f.requests.syncOne(f.job,f.c),requests.syncOne(second,f.c)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected'&&r.reason instanceof PlanningCapacityReached)).toHaveLength(1);
  expect(f.sends).toHaveLength(1);expect(f.s.db.query('SELECT count(*) AS n FROM spec_replans').get()).toEqual({n:1});
  expect(f.s.db.query(`SELECT count(*) AS n FROM planning_dispatch d JOIN jobs j ON j.id=d.job WHERE j.project='p' AND ${activePlanning}`).get()).toEqual({n:1});
 }finally{f.s.close();}
});
test('DEV-106: obsolete clarification, second edit, bad replies, busy handoff, restart during dispatch, exact fresh grant',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dev110-')),f=fixture(join(dir,'state.db'));
 try{
  f.edit('Add bun.lock');await f.requests.sync(f.c);const first=f.row();
  expect(first.body).toContain('```text\nReplan ADLC requirements ');expect(first.body).toContain('NOT clarification confirmation or plan approval');
  f.reply('Confirm clarification obsolete: all answers resolve the questions within the existing approved scope; no new permissions.');
  f.edit('Add bun.lock and frozen preparation');await f.requests.sync(f.c);expect(f.creates()).toBe(2);
  expect(f.s.db.query('SELECT state FROM spec_requests WHERE revision=?').get(first.revision)).toEqual({state:'superseded'});
  f.reply(`Replan ADLC requirements ${first.token}`);f.reply(undefined,{user:{id:'outsider',app:false}});f.reply(undefined,{editedAt:new Date().toISOString()});f.reply(undefined,{user:{id:human,app:true}});f.reply(undefined,{botActor:{id:'bot'}});
  expect((await f.requests.sync(f.c))[0].state).toBe('awaiting_replan_confirmation');expect(f.sends).toHaveLength(0);
  f.e.transcript.controller='busy';f.e.transcript.turns.push({id:'other-work',state:'running'});f.reply();f.reply();
  expect((await f.requests.sync(f.c))[0].state).toBe('waiting_for_worker');expect(f.row().source).toBe('human');expect(f.sends).toHaveLength(0);
  f.e.transcript.controller='ready';f.e.transcript.turns.at(-1).state='completed';f.lose();await f.requests.sync(f.c);
  expect(f.sends).toHaveLength(1);expect(f.sends[0]).toMatchObject({session:'owner',mode:'idle-only'});expect(f.sends[0].text).toContain('Do not edit files, run tests');
  f.reopen();expect((await f.requests.sync(f.c))[0].state).toBe('actively_replanning');expect(f.sends).toHaveLength(1);
  f.complete(['src/update.ts','bun.lock']);await f.recovery.capture(f.job,f.c);
  expect(new ApprovalPolicyStore(f.s).evaluate(f.job,'p',f.c.approval)).toMatchObject({allowed:false,reason:expect.stringContaining('bun.lock')});
  expect(f.s.get(f.job).approved_hash).toBeNull();
  const approvals=new LinearApprovals(f.s,f.w,f.api);await approvals.sync(f.c);
  const n=f.s.db.query('SELECT * FROM plan_approval_notices').get() as any;expect(n.body).toContain('`src/update.ts, bun.lock`');
  f.reply(`Approve ADLC plan ${n.token}`);expect((await approvals.sync(f.c))[0].state).toBe('approved');
  expect(JSON.parse(f.w.implementation(f.job).paths)).toEqual(['src/update.ts','bun.lock']);expect(f.w.implementation(f.job).session_id).toBe('owner');expect(f.c.approval.scope).toEqual(['src/**']);expect(f.sends).toHaveLength(1);
 }finally{f.s.close();rmSync(dir,{recursive:true,force:true});}
});
test('automatic planning coalesces busy edits and stale active plans, then standing approval continues in scope',async()=>{
 const f=fixture();try{
  f.c.replanning={automatic:true};f.edit('one');f.e.transcript.controller='busy';
  expect((await f.requests.sync(f.c))[0].state).toBe('waiting_for_worker');f.edit('two');f.e.transcript.controller='ready';
  await f.requests.sync(f.c);expect(f.sends).toHaveLength(1);expect(f.sends[0].text).toContain('"description":"two"');expect(f.creates()).toBe(0);
  f.edit('three during planning');await f.requests.sync(f.c);expect(f.sends).toHaveLength(1);f.complete();await f.recovery.capture(f.job,f.c);expect(f.s.get(f.job).plan).toBeNull();
  await f.requests.sync(f.c);expect(f.sends).toHaveLength(2);f.complete();await f.recovery.capture(f.job,f.c);f.snapshot();
  const proof=new ApprovalPolicyStore(f.s).evaluate(f.job,'p',f.c.approval);expect(proof.allowed).toBe(true);
  await f.w.tick({...f.c,automation:{...f.c.automation,planningEnabled:false}});expect(f.s.get(f.job).state).toBe('approved');expect(f.sends).toHaveLength(3);
 }finally{f.s.close();}
});
test('racing automatic and manual intents share one reservation, including duplicate polls',async()=>{
 const f=fixture();try{
  f.edit('edit');await f.requests.sync(f.c);f.reply();const automatic={...f.c,replanning:{automatic:true}};
  await Promise.allSettled([f.requests.sync(f.c),f.requests.sync(automatic),f.requests.sync(automatic)]);
  expect(f.sends).toHaveLength(1);expect(f.s.db.query('SELECT count(*) AS n FROM spec_replans').get()).toEqual({n:1});
 }finally{f.s.close();}
});
for(const change of ['edited','timestamp','author'])test(`reply ${change} during final ownership reads is rejected before reservation`,async()=>{
 const f=fixture();try{
  f.edit('edit');await f.requests.sync(f.c);f.reply();const worktree=f.w.t.worktree!;
  f.w.t.worktree=async job=>{const reply=f.comments.at(-1);if(change==='edited')reply.editedAt=new Date().toISOString();if(change==='timestamp')reply.createdAt='invalid';if(change==='author')reply.user.id='outsider';return worktree(job);};
  expect((await f.requests.sync(f.c))[0].state).toBe('blocked');expect(f.sends).toHaveLength(0);expect(f.s.db.query('SELECT * FROM spec_replans').get()).toBeNull();
  f.w.t.worktree=worktree;await f.requests.sync(f.c);f.reply();await f.requests.sync(f.c);expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
for(const kind of ['incomplete','stale','future','terminated','wrong-owner','wrong-worktree'])test(`automatic request defers ${kind} evidence with a recovery action`,async()=>{
 const f=fixture();try{
  f.c.replanning={automatic:true};f.edit('edit');
  if(kind==='incomplete')f.e.receiptObservation.complete=false;
  if(kind==='stale'||kind==='future')f.w.t.evidence=async()=>({...f.e,receiptObservation:{complete:true,observed:Date.now()+(kind==='future'?10000:-120001)}});
  if(kind==='terminated')f.e.session.isTerminated=true;
  if(kind==='wrong-owner')f.e.session.id='other';
  if(kind==='wrong-worktree')f.w.t.worktree=async()=>({branch:'other',head:'a'.repeat(40),tree:'/elsewhere'});
  const result=(await f.requests.sync(f.c))[0];expect(result.state).toBe('blocked');expect(result.nextAction).toContain('spec-reconcile');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('lost Linear notice response reconciles its durable ID without reposting',async()=>{
 const f=fixture();try{
  f.edit('edit');f.requests.api=async(q,v)=>{const result=await f.api(q,v);if(q.startsWith('mutation'))throw Error('lost notice response');return result;};
  expect((await f.requests.sync(f.c))[0].state).toBe('blocked');expect(f.creates()).toBe(1);
  f.requests.api=f.api;await f.requests.sync(f.c);expect(f.creates()).toBe(1);f.reply();await f.requests.sync(f.c);expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('consumed reply cannot repeat a retired replan attempt',async()=>{
 const f=fixture();try{
  f.edit('edit');await f.requests.sync(f.c);f.reply();await f.requests.sync(f.c);
  f.s.db.query("UPDATE spec_replans SET state='failed'").run();
  expect((await f.requests.sync(f.c))[0].state).toBe('blocked');expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('paused project never records or dispatches automatic intent',async()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'dev110-pause-'));
 try{f.requests.stateDirectory=dir;setProjectIntakePaused('dev110-test',true,dir);f.c.replanning={automatic:true};f.edit('edit');expect((await f.requests.sync(f.c))[0].state).toBe('blocked');expect(f.sends).toHaveLength(0);expect(f.row()).toBeNull();}
 finally{f.s.close();rmSync(dir,{recursive:true,force:true});}
});
test('edited accepted reply cannot dispatch after busy wait; automatic policy revocation requires manual reply',async()=>{
 const f=fixture();try{
  f.edit('edit');await f.requests.sync(f.c);f.reply();f.e.transcript.controller='busy';await f.requests.sync(f.c);f.comments.at(-1).editedAt=new Date().toISOString();f.e.transcript.controller='ready';
  expect((await f.requests.sync(f.c))[0].state).toBe('awaiting_replan_confirmation');expect(f.sends).toHaveLength(0);
  f.c.replanning={automatic:true};f.e.transcript.controller='busy';await f.requests.sync(f.c);f.c.replanning.automatic=false;f.e.transcript.controller='ready';
  expect((await f.requests.sync(f.c))[0].state).toBe('awaiting_replan_confirmation');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('policy, standalone reply and concrete scope validation fail closed',()=>{
 expect(()=>validateReplanning({})).not.toThrow();expect(()=>validateReplanning({replanning:{automatic:'true'}})).toThrow();
 const command=`Replan ADLC requirements ${human}`;
 for(const body of [command,`\`${command}\``,`\n\u00a0\`\`\`text\r\n${command}\r\n\`\`\`\t`])expect(parseReplanReply(body)).toBe(command);
 for(const body of [`> ${command}`,`please ${command}`,command.replace('Replan ADLC requirements','Approve ADLC plan'),`${command}\nextra`,command.replace('Replan ','Replan  ')])expect(parseReplanReply(body)).toBeNull();
 for(const paths of [['src/**'],['AGENTS.md'],['.env'],['../bun.lock'],['src/a.ts','src/a.ts']])expect(planPaths(`<!-- ADLC_PLAN_SCOPE ${JSON.stringify({version:1,paths})} -->`)).toBeNull();
});
test('initial planning edit has authoritative no-PR context and first creation still needs current Git authorization',async()=>{
 const f=fixture();try{
  f.c.replanning={automatic:true};f.edit('eligible edit before first PR');await f.requests.sync(f.c);
  expect(f.sends).toHaveLength(1);expect(f.sends[0].text).toContain('Complete current branch lookup confirms no PR exists');expect(f.sends[0].text).toContain('do not ask for one');
  expect(f.s.db.query('SELECT * FROM git_grants').get()).toBeNull();expect(f.s.get(f.job).approved_hash).toBeNull();
  f.complete();await f.recovery.capture(f.job,f.c);const hash=f.s.get(f.job).plan_hash;
  expect(()=>f.w.approve(f.job,hash,'human',['src/**'],'supervised-host',['inspect'])).toThrow('complete scoped');
  f.w.approve(f.job,hash,'human',['src/**'],'supervised-host',featureGit);await f.w.executeApproved(f.job,f.c);
  expect(f.sends).toHaveLength(2);expect(f.sends[1].session).toBe('owner');expect(f.sends[1].text).toContain('open or update exactly one PR');expect(f.e.session.prs).toEqual([]);
  expect(JSON.parse((f.s.db.query('SELECT operations FROM git_grants').get() as any).operations)).toContain('open-pr');
 }finally{f.s.close();}
});
for(const kind of ['incomplete','ambiguous','attachment-conflict','stale-head','lookup-failure'])test(`no-PR planning defers ${kind} instead of treating missing evidence as absence`,async()=>{
 const f=fixture();try{
  f.c.replanning={automatic:true};f.edit('edit');const lookup=f.w.t.planningPRs!;
  if(kind==='stale-head'){
   f.e.session.prs=[{number:7,url:'https://github.com/owner/repo/pull/7',state:'open'}];
   f.w.t.branchSnapshot=async()=>({branch:f.e.session.branch,head:'a'.repeat(40),headRepo:'owner/repo',baseRepo:'owner/repo',state:'open'});
  }
  f.w.t.planningPRs=async(repo,branch)=>{
   if(kind==='lookup-failure')throw Error('lookup unavailable');
   const inventory=await lookup(repo,branch),p={number:7,url:`https://github.com/${repo}/pull/7`,repo,base:repo,branch,head:'a'.repeat(40),state:'open' as const};
   if(kind==='incomplete')return {...inventory,complete:false} as any;
   if(kind==='ambiguous')return {...inventory,prs:[p,{...p,number:8,url:`https://github.com/${repo}/pull/8`}]};
   if(kind==='stale-head')p.head='b'.repeat(40);
   return {...inventory,prs:[p]};
  };
  expect((await f.requests.sync(f.c))[0].state).toBe('blocked');expect(f.sends).toHaveLength(0);expect(f.s.db.query('SELECT * FROM spec_replans').get()).toBeNull();
  if(kind==='stale-head'){
   f.w.t.planningPRs=lookup;
   expect((await f.requests.sync(f.c))[0].state).toBe('dispatched');expect(f.sends).toHaveLength(1);
  }
 }finally{f.s.close();}
});
for(const malformed of [null,'{bad json}',JSON.stringify({version:1,paths:['src/**']})])test(`direct revised approval rejects missing/malformed scope (${malformed}) atomically`,async()=>{
 const f=fixture();try{
  f.c.replanning={automatic:true};f.edit('edit');await f.requests.sync(f.c);f.complete();
  f.e.transcript.entries.at(-1).text=f.e.transcript.entries.at(-1).text.replace(/<!-- ADLC_PLAN_SCOPE .*? -->/,malformed?`<!-- ADLC_PLAN_SCOPE ${malformed} -->`:'');
  await f.recovery.capture(f.job,f.c);const before=f.s.get(f.job);
  expect(()=>f.w.approve(f.job,before.plan_hash,'human',['src/**'],'supervised-host',featureGit)).toThrow('valid ADLC_PLAN_SCOPE');
  expect(f.s.get(f.job)).toEqual(before);expect(f.s.db.query('SELECT * FROM git_grants').get()).toBeNull();expect(f.w.implementation(f.job)).toBeNull();
 }finally{f.s.close();}
});
test('automatic policy supersedes an edited human intent only before dispatch',async()=>{
 const f=fixture();try{
  f.edit('edit');await f.requests.sync(f.c);f.reply();f.e.transcript.controller='busy';await f.requests.sync(f.c);expect(f.row().source).toBe('human');
  f.comments.at(-1).editedAt=new Date().toISOString();f.c.replanning={automatic:true};f.e.transcript.controller='ready';await f.requests.sync(f.c);
  expect(f.row()).toMatchObject({source:'automatic',reply:null});expect(f.sends).toHaveLength(1);await f.requests.sync(f.c);expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('a PR appearing between no-PR preview and dispatch invalidates the preview instead of authorizing a replacement',async()=>{
 const f=fixture();try{
  f.c.replanning={automatic:true};f.edit('edit');let reads=0;
  const original=f.w.t.planningPRs!;
  f.w.t.planningPRs=async(repo,branch)=>{if(++reads>1)f.e.session.prs=[{number:9,url:`https://github.com/${repo}/pull/9`,state:'open'}];return original(repo,branch);};
  f.w.t.branchSnapshot=async()=>({branch:f.e.session.branch,head:'a'.repeat(40),headRepo:'owner/repo',baseRepo:'owner/repo',state:'open'});
  expect((await f.requests.sync(f.c))[0].state).toBe('blocked');expect(f.sends).toHaveLength(0);expect(f.s.db.query('SELECT * FROM spec_replans').get()).toBeNull();
 }finally{f.s.close();}
});
for(const change of ['PR','head'])test(`${change} changes during asynchronous authorization invalidate identity before reservation`,async()=>{
 const f=fixture();try{
  f.edit('revised');let head='a'.repeat(40),authorized=0;
  f.w.t.worktree=async()=>({branch:f.e.session.branch,tree:'/worktree',head});
  f.w.t.branchSnapshot=async()=>({branch:f.e.session.branch,head,headRepo:'owner/repo',baseRepo:'owner/repo',state:'open'});
  const preview=await f.recovery.preview(f.job,f.c);
  await expect(f.recovery.reconcile(f.job,f.c,preview.confirmation,async()=>{
   authorized++;await Promise.resolve();
   if(change==='head')head='b'.repeat(40);else f.e.session.prs=[{number:7,url:'https://github.com/owner/repo/pull/7',state:'open'}];
  })).rejects.toThrow('Evidence changed during authorization');
  expect(authorized).toBe(1);expect(f.sends).toHaveLength(0);expect(f.s.db.query('SELECT * FROM spec_replans').get()).toBeNull();
 }finally{f.s.close();}
});
for(const kind of ['stale','future','incomplete','session','project','branch','terminated'])test(`accepted delivery with ${kind} evidence is uncertain, not dispatched, without replay`,async()=>{
 const f=fixture();try{
  f.c.replanning={automatic:true};f.edit('revised');await f.requests.sync(f.c);
  const delivery=f.s.db.query('SELECT * FROM spec_replans').get();
  // Isolate the accepted-receipt fallback, rather than an active owned turn.
  f.e.transcript.entries=[];
  expect((await f.requests.sync(f.c))[0].state).toBe('dispatched');
  const evidence=structuredClone(f.e);evidence.receiptObservation.observed=Date.now();
  if(kind==='stale')evidence.receiptObservation.observed=Date.now()-120001;
  if(kind==='future')evidence.receiptObservation.observed=Date.now()+10000;
  if(kind==='incomplete')evidence.receiptObservation.complete=false;
  if(kind==='session')evidence.session.id='other';
  if(kind==='project')evidence.session.projectId='other';
  if(kind==='branch')evidence.session.branch='other';
  if(kind==='terminated')evidence.session.isTerminated=true;
  f.w.t.evidence=async()=>evidence;
  expect((await f.requests.sync(f.c))[0].state).toBe('delivery_uncertain');expect(f.row().state).toBe('delivery_uncertain');
  expect(f.sends).toHaveLength(1);expect(f.s.db.query('SELECT * FROM spec_replans').get()).toEqual(delivery);
 }finally{f.s.close();}
});
for(const when of ['admission','pre-dispatch'])test(`duplicate Linear reply IDs fail closed at ${when}`,async()=>{
 const f=fixture();try{
  f.edit('edit');await f.requests.sync(f.c);f.reply();
  const duplicate=()=>f.comments.push({...f.comments.at(-1),editedAt:new Date().toISOString()});
  if(when==='admission')duplicate();else{const worktree=f.w.t.worktree!;f.w.t.worktree=async job=>{if(f.comments.at(-1).editedAt===null)duplicate();return worktree(job);};}
  expect((await f.requests.sync(f.c))[0].state).toBe('blocked');expect(f.sends).toHaveLength(0);expect(f.s.db.query('SELECT * FROM spec_replans').get()).toBeNull();
 }finally{f.s.close();}
});
test('definite negative notice acknowledgement retries the same ID; uncertain failure names safe recovery',async()=>{
 const f=fixture();try{
  f.edit('edit');const ids:string[]=[];let reject=true;
  f.requests.api=async(q,v)=>{if(q.startsWith('mutation')){ids.push(v!.input.id);if(reject){reject=false;return {commentCreate:{success:false,comment:null}};}}return f.api(q,v);};
  expect((await f.requests.sync(f.c))[0].state).toBe('blocked');expect(f.row().notice_state).toBe('reserved');await f.requests.sync(f.c);expect(ids[0]).toBe(ids[1]);expect(f.creates()).toBe(1);
 }finally{f.s.close();}
 const g=fixture();try{
  g.edit('edit');g.requests.api=async(q,v)=>{if(q.startsWith('mutation'))throw Error('uncertain');return g.api(q,v);};
  await g.requests.sync(g.c);const result=(await g.requests.sync(g.c))[0];expect(result.reason).toContain(`spec-reconcile ${g.job} CONFIG`);expect(g.creates()).toBe(0);
 }finally{g.s.close();}
});
for(const tamper of [false,true])test(`existing PR scope changes only at exact revised authorization (identity tampered: ${tamper})`,async()=>{
 const f=fixture();try{
  const initial=f.s.get(f.job);f.w.approve(f.job,initial.plan_hash,'human',['src/**'],'supervised-host',featureGit);
  new Lifecycle(f.s).adoptSupervised(f.job,{id:'owner',correlation:new Planning(f.s).get(f.job).correlation,worktree:'/worktree',controller:'running'});
  const loop=new ReviewLoop(f.s);loop.register(f.job,'owner/repo',7,['CI'],['src/**'],true);
  f.e.session.prs=[{number:7,url:'https://github.com/owner/repo/pull/7',state:'open'}];
  f.w.t.branchSnapshot=async()=>({branch:f.e.session.branch,head:'a'.repeat(40),headRepo:'owner/repo',baseRepo:'owner/repo',state:'open'});
  f.c.replanning={automatic:true};f.edit('add bun.lock');await f.requests.sync(f.c);expect(f.sends[0].text).toContain('A verified PR exists');f.complete(['src/update.ts','bun.lock']);await f.recovery.capture(f.job,f.c);
  expect(()=>loop.register(f.job,'owner/repo',7,['CI'],['src/update.ts','bun.lock'],true)).toThrow();
  if(tamper)f.s.db.query('UPDATE review_targets SET pr=8').run();
  const hash=f.s.get(f.job).plan_hash,approve=()=>f.w.approve(f.job,hash,'human',['src/update.ts','bun.lock'],'supervised-host',featureGit);
  if(tamper){expect(approve).toThrow('explicit reconciliation');expect(loop.get(f.job).allowed_paths).toBe('["src/**"]');expect(f.s.get(f.job).approved_hash).toBeNull();}
  else{approve();expect(loop.get(f.job)).toMatchObject({pr:7,allowed_paths:'["src/update.ts","bun.lock"]',state:'waiting_for_review',head:null});loop.register(f.job,'owner/repo',7,['CI'],['src/update.ts','bun.lock'],true);expect(f.w.implementation(f.job).session_id).toBe('owner');}
 }finally{f.s.close();}
});

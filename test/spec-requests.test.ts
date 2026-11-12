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
 const wire=()=>{w=new Workflow(s,transport);recovery=new SpecRecovery(s,w,async()=>issue(),async f=>f());requests=new SpecRequests(s,w,api,recovery);};wire();
 const snapshot=()=>new ApprovalPolicyStore(s).snapshot('p',new Set(['issue']));
 const edit=(description:string)=>{s.enqueue('p','issue',JSON.stringify({identifier:'DEV-106',title:'Runtime dependencies',description}));snapshot();};
 const row=()=>s.db.query('SELECT * FROM spec_requests WHERE revision=?').get(latestRevision(s,job).id) as any;
 const reply=(body=`Replan ADLC requirements ${row().token}`,extra:any={})=>comments.push({id:`reply-${comments.length}`,body,createdAt:new Date().toISOString(),editedAt:null,user:{id:human,app:false},botActor:null,...extra});
 const complete=(paths=['src/update.ts'])=>{const d=s.db.query('SELECT * FROM spec_replans ORDER BY rowid DESC LIMIT 1').get() as any;e.transcript.controller='ready';e.session.activity.state='idle';e.transcript.turns.at(-1).state='completed';e.transcript.entries.push({kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:d.client_id,sequence:e.transcript.entries.length+1,text:`<!-- ADLC_REVISED_PLAN:${d.revision} -->\nRevised plan\n<!-- ADLC_PLAN_SCOPE ${JSON.stringify({version:1,paths})} -->\n${ready}`});};
 return {get s(){return s;},get w(){return w;},get requests(){return requests;},get recovery(){return recovery;},c,job,e,sends,comments,api,edit,row,reply,complete,snapshot,creates:()=>creates,lose:()=>lose=true,reopen:()=>{s.close();s=new Store(path);wire();}};
}
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

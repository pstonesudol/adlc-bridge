import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store,digest} from '../src/core';
import {Workflow,type WorkflowTransport} from '../src/workflow';
import {Planning} from '../src/planning';
import {recordReadiness,activeResolution,clarificationDiscovery,standingReady} from '../src/readiness';
import {LinearBlockers} from '../src/linear-blockers';
import {LinearClarifications,validateClarifications} from '../src/linear-clarifications';
import {LinearApprovals} from '../src/linear-approvals';
import {ApprovalPolicyStore} from '../src/approval-policy';
import {ReviewLoop} from '../src/review-loop';
import {Lifecycle} from '../src/lifecycle';
import {projectMetrics} from '../src/autonomy-metrics';
const human='11111111-1111-1111-1111-111111111111',label='22222222-2222-2222-2222-222222222222';
const config:any={repo:'/repo',requiredChecks:['CI'],linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},blockerSync:{enabled:true,labelId:label},clarifications:{enabled:true,humanIds:[human]}};
const discovery='<!-- ADLC_DISCOVERY {"checked":["ticket","linked-issues","repository"],"summary":"Inspected ticket, linked copy ticket and src/a.ts; approved display wording is unchanged","necessity":"The exact listing identifier is absent and required to address the correct listing"} -->';
async function fixture(path=':memory:',planning=false,dev66=false){
 const s=new Store(path);let e:any,sends:any[]=[],loseSend=false,loseComment=false,loseBeforeComment=false;const trace:string[]=[],comments:any[]=[],labels=['ready','human-label'];let description='Update approved listing',relationIncomplete=false;
 const t:WorkflowTransport={startPlan:async()=>{throw Error('No spawning permitted');},findPlans:async()=>[],evidence:async()=>e,disableFeedback:async()=>{},worktree:async()=>({branch:e.session.branch,head:'a'.repeat(40)}),sendImplementation:async(id,prompt,clientId)=>{
  sends.push({id,prompt,clientId});e.transcript.entries.push({sequence:e.transcript.entries.length+1,clientMessageId:clientId,turnId:clientId,kind:'message',role:'user',text:prompt});e.transcript.turns.push({id:clientId,state:'running'});e.transcript.controller='busy';if(loseSend)throw Error('Lost send reply');
 }};
 const identifier=dev66?'DEV-66':'DEV-18',title=dev66?'Recover legacy missing-binding regression':'Listing';
 if(dev66)description='Test legacy missing-binding recovery; report missing evidence without reopening https://linear.app/example/issue/DEV-43/completed-controls';
 const w=new Workflow(s,t),spec=JSON.stringify({identifier,title,description}),id=s.enqueue('p','issue',spec),p=new Planning(s),r=p.reserve(id,'ao');p.gate(id,'ao','session',r.branch,'/isolated');
 const question=dev66?{id:'q1',question:'Should DEV-66 continue the legacy missing-binding regression when DEV-43 capability evidence is unavailable?',kind:'dependency'}:{id:'q1',question:'What is the exact listing ID?',kind:'requirement'};
 const plan=planning?`Update src/a.ts. ${discovery}\n<!-- ADLC_PLAN_STATUS ${JSON.stringify({version:1,readiness:'needs-input',questions:[question],dependencies:[],risks:[]})} -->`:'Update src/a.ts. <!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->';
 const hash=s.propose(id,plan);recordReadiness(s,id,plan,hash,digest(spec));s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);s.db.query('INSERT INTO planning_dispatch(job,spec_hash,state,session_id,client_id) VALUES (?,?,?,?,?)').run(id,digest(spec),'awaiting_approval','session','planning-message');
 e={receiptObservation:{complete:true,observed:Date.now()},session:{id:'session',projectId:'ao',branch:r.branch,isTerminated:false,prs:[]},transcript:{controller:'ready',entries:[],turns:[]}};
 if(!planning){w.approve(id,hash,'Patrick',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);await w.executeApproved(id);}
 const block=async(questions=[{id:'q1',kind:'requirement',question:'What is the exact listing ID?'}],deps:any[]=[])=>{
  e.transcript.controller='ready';for(const turn of e.transcript.turns)turn.state='completed';
  e.transcript.entries.push({sequence:e.transcript.entries.length+1,kind:'message',role:'assistant',origin:'provider',turnId:e.transcript.turns.at(-1).id,streaming:false,text:`${discovery}\n<!-- ADLC_WORKER_STATUS ${JSON.stringify({version:1,outcome:'needs-input',reason:'Exact ID is missing',questions,dependencies:deps})} -->`});
  await w.executionStatus(id,e,config);
 };
 if(!planning)await block();
 const issue=()=>({id:'issue',identifier,title,description,project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:labels.map(id=>({id})),pageInfo:{hasNextPage:false}}});
 const closed={id:'closed-43',identifier:'DEV-43',title:'Completed controls',description:'Completed; capability evidence unavailable',state:{id:'done'}};
 const updates:any[]=[];
 const api=async(q:string,v:any)=>{
  if(q.includes('commentCreate')){
   trace.push('publish');if(loseBeforeComment)throw Error('Lost before create');
   const x={id:v.input.id,body:v.input.body,createdAt:'2026-11-02T10:00:00Z',editedAt:null,user:{id:'bot',app:true},botActor:{id:'bot'}};comments.push(x);
   if(loseComment){loseComment=false;throw Error('Lost after create');}return {commentCreate:{success:true,comment:x}};
  }
  if(q.includes('comments(first:100')){trace.push('comments');return {issue:{id:v.id,comments:{nodes:v.id==='issue'?comments:[],pageInfo:{hasNextPage:false}}}};}
  if(q.includes('inverseRelations')){trace.push('linked');return {issue:{id:'issue',relations:{nodes:[],pageInfo:{hasNextPage:relationIncomplete}},inverseRelations:{nodes:[],pageInfo:{hasNextPage:false}}}};}
  if(q.includes('issueUpdate')){
   updates.push(v);if(v.id!=='issue')throw Error('Must not mutate a linked ticket');
   trace.push('labels');if(v.added)for(const l of v.added)if(!labels.includes(l))labels.push(l);
   if(v.removed)for(const l of v.removed){const at=labels.indexOf(l);if(at>=0)labels.splice(at,1);}
   return {issueUpdate:{success:true,issue:issue()}};
  }
  trace.push('issue');return {issue:v.id==='DEV-43'?closed:issue()};
 };
 const blockers=new LinearBlockers(s,api),adapter=()=>new LinearClarifications(s,w,blockers,()=>{trace.push('repository');return ['src/a.ts (hash)'];});
 const reference=()=>JSON.parse((s.db.query('SELECT context FROM clarification_receipts WHERE job=? ORDER BY rowid DESC').get(id) as any).context).reference;
 const reply=(body:string,patch:any={})=>{const x={id:`human-${comments.length}`,body,createdAt:`2026-11-02T10:${String(comments.length+1).padStart(2,'0')}:00Z`,editedAt:null,user:{id:human,app:false},botActor:null,...patch};comments.push(x);return x;};
 const confirm=()=>reply(`Confirm clarification ${reference()}: all answers resolve the questions within the existing approved scope; no new permissions.`);
 return {s,w,id,e,t,api,trace,comments,labels,sends,adapter,blockers,block,reply,confirm,reference,closed,updates,loseSend:()=>loseSend=true,loseComment:()=>loseComment=true,loseBeforeComment:()=>loseBeforeComment=true,changeDescription:()=>description='Expanded scope',incomplete:()=>relationIncomplete=true};
}
test('discovery occurs before exact question publication; configured label is additive and deduplicated',async()=>{
 const f=await fixture();try{
  expect((await f.adapter().sync(config))[0].state).toBe('waiting');
  expect(f.trace.indexOf('linked')).toBeLessThan(f.trace.indexOf('publish'));expect(f.trace.indexOf('repository')).toBeLessThan(f.trace.indexOf('publish'));
  const body=f.comments[0].body;expect(body).toContain('1. **q1** (requirement): What is the exact listing ID?');expect(body).toContain('Why this answer is necessary');expect(body).toContain('Reply on this same Linear issue');expect(body).toContain('```text');expect(body).toContain(f.reference());expect(body).toContain(f.id);expect(body).toContain('Never post secrets');
  expect(f.labels).toEqual(['ready','human-label',label]);await f.adapter().sync(config);expect(f.comments.length).toBe(1);
  await f.blockers.sync(config);expect(f.comments.length).toBe(1);expect(f.labels).toContain(label);
 }finally{f.s.close();}
});
test('verification remediation on an existing PR publishes exact prerequisites and resumes once through clarification',async()=>{
 const f=await fixture();try{
  const c={...config,githubRepo:'owner/repo'},loop=new ReviewLoop(f.s);loop.register(f.id,'owner/repo',1,['CI'],['src/**'],true);
  const attempt=new Lifecycle(f.s).reserveRemediation(f.id,'a'.repeat(40),'verification evidence') as any;
  f.s.db.query("UPDATE remediation SET state='completed' WHERE job=?").run(f.id);
  f.s.db.query('INSERT INTO remediation_context VALUES (?,?,?,?)').run(f.id,attempt.attempt,'pr_description','original-description');
  f.e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];
  f.t.branchSnapshot=async()=>({branch:f.e.session.branch,head:'a'.repeat(40),state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'});
  const handle=`adlc-fix-${f.id.slice(0,12)}-${attempt.attempt}`;
  f.e.transcript.entries.push({sequence:4,clientMessageId:handle,turnId:'verify'});f.e.transcript.turns.push({id:'verify',state:'completed'});
  f.e.transcript.entries.push({sequence:5,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'verify',text:`${discovery}\n<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"needs-input","reason":"Validated verification runtime reference is unavailable","questions":[{"id":"runtime","kind":"requirement","question":"Which already validated runtime reference should the configured runner use?"}],"dependencies":[]} -->`});
  await f.w.executionStatus(f.id,f.e,c);expect(f.w.outcomes(f.id).source).toBe(`remediation:${handle}`);
  await f.adapter().sync(c);expect(f.comments[0].body).toContain('Which already validated runtime reference');
  f.reply('The existing validated runtime reference');f.confirm();await f.adapter().sync(c);await f.adapter().sync(c);
  expect(f.sends).toHaveLength(2);expect(f.sends[1].id).toBe('session');expect(f.sends[1].prompt).toContain('Description and verification only');
  expect(f.s.get(f.id).attempts).toBe(1);expect(f.e.session.prs).toHaveLength(1);
 }finally{f.s.close();}
});
test('missing discovery and incomplete linked inventories never ask',async()=>{
 for(const missing of [true,false]){const f=await fixture();try{
  if(missing)f.s.db.query('UPDATE worker_outcomes SET discovery=NULL WHERE job=?').run(f.id);else f.incomplete();
  const r=await f.adapter().sync(config);expect(r[0].state).toBe(missing?'discovery_required':'needs_reconciliation');expect(f.comments).toHaveLength(0);expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}}
 expect(clarificationDiscovery('bad')).toBeNull();
});
test('normal human answer plus explicit scope confirmation resumes exactly once through real foundation',async()=>{
 const f=await fixture();try{
  await f.adapter().sync(config);f.reply('listing-42');await f.adapter().sync(config);
  expect(f.sends).toHaveLength(1);expect(activeResolution(f.s,f.id)).toBeNull();f.confirm();
  await Promise.all([f.adapter().sync(config),f.adapter().sync(config)]);
  expect(f.sends).toHaveLength(2);expect(f.sends[1].id).toBe('session');expect(f.sends[1].prompt).toContain('GUARDED CONTINUATION');expect(f.sends[1].prompt).toContain('listing-42');expect(f.sends[1].prompt).not.toContain('ADLC APPROVED IMPLEMENTATION');
  expect(f.labels).toEqual(['ready','human-label']);expect(f.s.get(f.id).actor).toBe('Patrick');expect(f.s.get(f.id).approved_hash).toBe(f.s.get(f.id).plan_hash);
  const resolution=f.s.db.query('SELECT * FROM plan_resolutions').get() as any;
  await f.adapter().sync(config);expect(f.sends).toHaveLength(2);expect((f.s.db.query('SELECT * FROM plan_resolutions').get() as any).at).toBe(resolution.at);
   expect(f.comments.some(x=>x.body.includes('work resumed in the existing session'))).toBe(true);
   const report=projectMetrics(f.s,{},Date.now()+1000),row=report.jobs.find(j=>j.job===f.id)!;
   expect(row.interventions).toBe(0);expect(row.humanActions).toBeGreaterThanOrEqual(2);
   expect(row.provenance.some(p=>p.category==='expected_human_action')).toBe(true);
   expect(row.handoff).toBeNull(); // A clarification reply is not reviewed-PR completion.
 }finally{f.s.close();}
});
test('unauthorized, bot, quoted, edited and stale replies cannot resolve',async()=>{
 const f=await fixture();try{
  await f.adapter().sync(config);
  for(const patch of [{user:{id:'outsider',app:false}},{user:{id:human,app:true}},{botActor:{}},{editedAt:'2026-11-02T10:20:00Z'},{createdAt:'2026-11-01T00:00:00Z'}])f.reply('listing-42',patch);
  f.reply('> listing-42');f.reply('Clarification stale\nq1: listing-42');f.confirm();await f.adapter().sync(config);
  expect(activeResolution(f.s,f.id)).toBeNull();expect(f.sends).toHaveLength(1);expect(f.labels).toContain(label);
 }finally{f.s.close();}
});
test('partial and dependency answers survive adapter restart and ask only what remains',async()=>{
 const f=await fixture();try{
  await f.block([{id:'q1',kind:'requirement',question:'Which ID?'},{id:'q2',kind:'requirement',question:'Approved wording?'}],[{ref:'External copy review',reason:'Final copy needed'}]);
  await f.adapter().sync(config);f.reply(`Clarification ${f.reference()}\nq1: listing-42`);await f.adapter().sync(config);
  expect(f.comments.at(-1).body).toContain('Still needed: q2');expect(f.comments.at(-1).body).toContain('dependency-1');
  f.reply('q2: Approved display wording');f.confirm();await f.adapter().sync(config);expect(f.sends).toHaveLength(1);
  f.reply('dependency-1: Final copy review complete');f.confirm();await f.adapter().sync(config);expect(f.sends).toHaveLength(2);
 }finally{f.s.close();}
});
test('changed scope, stale requirements and edited accepted answers never silently continue',async()=>{
 const f=await fixture();try{
  await f.adapter().sync(config);f.reply(`Replan clarification ${f.reference()}`);await f.adapter().sync(config);expect(f.sends).toHaveLength(1);expect(activeResolution(f.s,f.id)).toBeNull();
 }finally{f.s.close();}
 const edited=await fixture();try{
  await edited.adapter().sync(config);const answer=edited.reply('listing-42');await edited.adapter().sync(config);answer.editedAt='2026-11-02T12:00:00Z';edited.confirm();await edited.adapter().sync(config);expect(edited.sends).toHaveLength(1);expect(edited.adapter().status()[0].state).toBe('needs_review');
 }finally{edited.s.close();}
 const stale=await fixture();try{
  await stale.adapter().sync(config);stale.reply('listing-42');stale.confirm();stale.changeDescription();await stale.adapter().sync(config);expect(stale.sends).toHaveLength(1);expect(activeResolution(stale.s,stale.id)).toBeNull();
 }finally{stale.s.close();}
});
test('lost comment receipt is reconciled, uncertain sends never replay, active workers wait',async()=>{
 const f=await fixture();try{
  f.loseComment();await f.adapter().sync(config);await f.adapter().sync(config);await f.adapter().sync(config);expect(f.comments).toHaveLength(1);
  f.reply('listing-42');f.confirm();f.loseSend();await f.adapter().sync(config);await f.adapter().sync(config);expect(f.sends).toHaveLength(2);expect(f.w.continuation(f.id).state).toBe('delivery_uncertain');
 }finally{f.s.close();}
 const active=await fixture();try{
  await active.adapter().sync(config);active.reply('listing-42');active.confirm();active.e.transcript.controller='busy';await active.adapter().sync(config);expect(active.sends).toHaveLength(1);
  active.e.transcript.controller='ready';await active.adapter().sync(config);expect(active.sends).toHaveLength(2);
 }finally{active.s.close();}
});
test('label ownership, disabled adapter and configuration validation fail closed',async()=>{
 const f=await fixture();try{
  f.labels.push(label);await f.adapter().sync(config);f.reply('listing-42');f.confirm();await f.adapter().sync(config);expect(f.labels).toContain(label);
  expect(await f.adapter().sync({...config,clarifications:{enabled:false,humanIds:[]}})).toEqual([]);
  for(const clarifications of [{enabled:'true',humanIds:[human]},{enabled:true,humanIds:[]},{enabled:true,humanIds:['name']}])expect(()=>validateClarifications({...config,clarifications})).toThrow();
 }finally{f.s.close();}
});
test('disk-backed restart preserves partial answers and publication receipts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-clarification-')),path=join(dir,'state.sqlite');const f=await fixture(path);let reopened:Store|undefined;
 try{
  await f.adapter().sync(config);f.reply('listing-42');await f.adapter().sync(config);f.confirm();f.s.close();
  reopened=new Store(path);const w=new Workflow(reopened,f.t),blockers=new LinearBlockers(reopened,f.api),adapter=new LinearClarifications(reopened,w,blockers,()=>['src/a.ts']);
  await adapter.sync(config);await adapter.sync(config);expect(f.sends).toHaveLength(2);expect((reopened.db.query('SELECT count(*) AS n FROM clarification_receipts').get() as any).n).toBe(1);
 }finally{(reopened??f.s).close();rmSync(dir,{recursive:true,force:true});}
});
test('missing comment receipts never replay and landed acknowledgments reconcile without duplication',async()=>{
 const missing=await fixture();try{missing.loseBeforeComment();await missing.adapter().sync(config);await missing.adapter().sync(config);expect(missing.trace.filter(x=>x==='publish')).toHaveLength(1);}finally{missing.s.close();}
 const f=await fixture();try{
  await f.adapter().sync(config);f.reply('listing-42');f.confirm();f.loseComment();await f.adapter().sync(config);const count=f.comments.length;await f.adapter().sync(config);expect(f.sends).toHaveLength(2);expect(f.comments.length).toBe(count);
 }finally{f.s.close();}
});
test('new requirements supersede partial requests without retaining their owned label',async()=>{
 const f=await fixture();try{
  await f.adapter().sync(config);f.reply('listing-42');await f.adapter().sync(config);
  f.s.enqueue('p','issue',JSON.stringify({identifier:'DEV-18',title:'Listing',description:'New approved scope needs a plan'}));
  await f.adapter().sync(config);expect(f.adapter().status()[0].state).toBe('superseded');await f.blockers.sync(config);expect(f.labels).not.toContain(label);expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('planning replies resolve readiness but never approve or start implementation; edits invalidate resolution',async()=>{
 const f=await fixture(':memory:',true);try{
  await f.adapter().sync(config);const answer=f.reply('listing-42');f.confirm();await f.adapter().sync(config);
  expect(activeResolution(f.s,f.id).source).toBe('human-answer');expect(f.s.get(f.id).state).toBe('awaiting_approval');expect(f.s.get(f.id).approved_hash).toBeNull();expect(f.w.implementation(f.id)).toBeNull();expect(f.sends).toHaveLength(0);
  expect(f.comments.at(-1).body).toContain('awaits plan approval');answer.editedAt='2026-11-02T12:00:00Z';await f.adapter().sync(config);expect(activeResolution(f.s,f.id)).toBeNull();
 }finally{f.s.close();}
});
test('DEV-23 multi-question answers reevaluate standing policy and dispatch exactly once after adapter restart',async()=>{
 for(const manual of [false,true]){const f=await fixture(':memory:',true);try{
  const c:any={...config,approval:{mode:'ready-queue',id:'standing',authorizedBy:'human',scope:['src/**'],gitScope:'feature-pr'}};
  const plan=f.s.get(f.id).plan.replace('"questions":[{"id":"q1","question":"What is the exact listing ID?","kind":"requirement"}]','"questions":[{"id":"q1","question":"What is the exact listing ID?","kind":"requirement"},{"id":"q2","question":"Which existing ruleset?","kind":"requirement"}]');
  const hash=f.s.propose(f.id,plan);recordReadiness(f.s,f.id,plan,hash,digest(f.s.get(f.id).spec));
  const policy=new ApprovalPolicyStore(f.s);policy.snapshot('p',new Set(['issue']),Date.now(),manual?new Set(['issue']):new Set());
  await f.adapter().sync(c);f.reply(`Clarification ${f.reference()}\nq1: listing-42`);await f.adapter().sync(c);expect(standingReady(f.s,f.id)).toBe(false);
  await f.w.tick(c);expect(f.sends).toHaveLength(0);
  f.reply(`Clarification ${f.reference()}\nq2: Existing main ruleset`);f.confirm();await Promise.all([f.adapter().sync(c),f.adapter().sync(c)]);
  expect(standingReady(f.s,f.id)).toBe(true);expect(f.sends).toHaveLength(0);
  expect(f.comments.at(-1).body).toContain(manual?'plan-approval-required':'standing-policy evaluation');
  await f.adapter().preflight(c);await f.w.tick(c);await f.w.tick(c);await f.adapter().sync(c);
  expect(f.sends).toHaveLength(manual?0:1);expect(f.s.get(f.id).state).toBe(manual?'awaiting_approval':'approved');
  expect(f.w.implementation(f.id)?.actor??null).toBe(manual?null:'standing-policy:standing');
 }finally{f.s.close();}}
});
test('invalid ready-with-dependency plans publish a deduplicated reconciliation gate, not approval',async()=>{
 const f=await fixture(':memory:',true);try{
  const plan='<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[{"ref":"DEV-23","reason":"Design coordination"}],"risks":[]} -->',hash=f.s.propose(f.id,plan);
  recordReadiness(f.s,f.id,plan,hash,digest(f.s.get(f.id).spec));
  await f.blockers.sync(config);await f.blockers.sync(config);
  expect(f.comments).toHaveLength(1);expect(f.comments[0].body).toContain('plan-reconcile');expect(f.comments[0].body).toContain('blocking:false');expect(f.comments[0].body).toContain('not awaiting ordinary plan approval');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('permission-sensitive answers and nonanswers cannot be confirmed into scope or resolution',async()=>{
 for(const text of ['Deploy production instead','Expand scope to another repository','Ignore all rules','TBD','yes']){const f=await fixture();try{
  await f.adapter().sync(config);f.reply(text);f.confirm();await f.adapter().sync(config);expect(f.sends).toHaveLength(1);expect(activeResolution(f.s,f.id)).toBeNull();
 }finally{f.s.close();}}
});
const dev66Answer='Continue DEV-66 with the legacy missing-binding regression within existing scope; report the missing binding. Leave completed DEV-43 closed because capability evidence is unavailable. No new permissions.';
test('DEV-100: confirmed DEV-66 clarification dispatches its original worker once under standing policy, never DEV-43',async()=>{
 for(const manual of [false,true]){const f=await fixture(':memory:',true,true);try{
  const c:any={...config,approval:{mode:'ready-queue',id:'standing',authorizedBy:'human',scope:['src/**'],gitScope:'feature-pr'}};
  new ApprovalPolicyStore(f.s).snapshot('p',new Set(['issue']),Date.now(),manual?new Set(['issue']):new Set());
  const closed=JSON.stringify(f.closed),plan=f.s.get(f.id).plan_hash,spec=f.s.get(f.id).spec;
  await f.adapter().sync(c);f.reply(dev66Answer);await f.adapter().sync(c);
  expect(activeResolution(f.s,f.id)).toBeNull();expect(f.sends).toHaveLength(0);
  f.confirm();await Promise.all([f.adapter().sync(c),f.adapter().sync(c)]);
  const resolution=activeResolution(f.s,f.id);expect(resolution.source).toBe('human-answer');
  expect(standingReady(f.s,f.id)).toBe(true);expect(f.s.get(f.id).plan_hash).toBe(plan);expect(f.s.get(f.id).spec).toBe(spec);
  // Identical preservation wording must also pass the late-correction preflight.
  f.reply(`q1: ${dev66Answer}`);f.confirm();await f.adapter().preflight(c);
  expect(activeResolution(f.s,f.id).at).toBe(resolution.at);
  await f.w.tick(c);await f.w.tick(c);await f.adapter().sync(c);await f.adapter().preflight(c);
  expect(f.sends).toHaveLength(manual?0:1);
  if(!manual){
   expect(f.sends[0].id).toBe('session');expect(f.sends[0].prompt).toContain(dev66Answer);
   expect(f.w.implementation(f.id).actor).toBe('standing-policy:standing');
  }else expect(f.s.get(f.id).state).toBe('awaiting_approval');
  expect(JSON.stringify(f.closed)).toBe(closed);expect(f.closed.state.id).toBe('done');
  expect(f.updates.every(v=>v.id==='issue')).toBe(true);
  expect((f.s.db.query('SELECT count(*) AS n FROM jobs').get() as any).n).toBe(1);
  expect((f.s.db.query('SELECT count(*) AS n FROM plan_resolutions').get() as any).n).toBe(1);
 }finally{f.s.close();}}
});
test('DEV-100: preservation wording cannot hide ambiguity or expansion behind confirmation',async()=>{
 for(const text of [
  'Maybe continue within existing scope',
  'Continue within existing scope unless extra permissions are needed',
  `${dev66Answer} Expand scope to another repository.`,
  `${dev66Answer} Deploy production instead.`,
 ]){const f=await fixture();try{
  await f.adapter().sync(config);f.reply(text);f.confirm();await f.adapter().sync(config);await f.adapter().sync(config);
  expect(activeResolution(f.s,f.id)).toBeNull();expect(f.sends).toHaveLength(1);
  const receipt=f.adapter().status()[0];expect(receipt.state).toBe('replan');expect(receipt.reason).toContain('q1: Unresolved sensitive clause:');
  expect(f.comments.at(-1).body).toContain(receipt.reason);expect(f.comments.at(-1).body).toContain('plan-reconcile JOB CONFIG SEQUENCE');
 }finally{f.s.close();}}
});
test('DEV-100: preserved scope does not excuse stale, edited or superseded replies',async()=>{
 for(const mode of ['stale','edited','requirements']){const f=await fixture(':memory:',true,true);try{
  await f.adapter().sync(config);const answer=f.reply(dev66Answer,mode==='stale'?{createdAt:'2026-11-01T00:00:00Z'}:{});
  if(mode==='edited')answer.editedAt='2026-11-02T12:00:00Z';
  if(mode==='requirements')f.changeDescription();
  f.confirm();await f.adapter().sync(config);expect(activeResolution(f.s,f.id)).toBeNull();expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}}
});
test('DEV-100: preserved scope retains uncertain continuation receipts without replay',async()=>{
 const f=await fixture();try{
  await f.adapter().sync(config);f.reply(dev66Answer);f.confirm();f.loseSend();
  await f.adapter().sync(config);const resolution=activeResolution(f.s,f.id);
  await f.adapter().sync(config);await f.adapter().sync(config);
  expect(f.sends).toHaveLength(2);expect(f.w.continuation(f.id).state).toBe('delivery_uncertain');
  expect(activeResolution(f.s,f.id).at).toBe(resolution.at);
 }finally{f.s.close();}
});
test('human ownership, queued turns, revoked grants and reduced scope cannot continue',async()=>{
 for(const mutate of [
  (f:any)=>f.s.db.query("UPDATE runs SET owner='human' WHERE job=?").run(f.id),
  (f:any)=>f.e.transcript.turns.push({id:'queued',state:'queued'}),
  (f:any)=>f.s.db.query('UPDATE jobs SET approved_hash=NULL WHERE id=?').run(f.id),
  (f:any)=>f.s.db.query('UPDATE git_grants SET operations=? WHERE job=?').run('["inspect"]',f.id),
 ]){const f=await fixture();try{
  await f.adapter().sync(config);f.reply('listing-42');f.confirm();mutate(f);await f.adapter().sync(config);expect(f.sends).toHaveLength(1);expect(f.w.continuation(f.id)).toBeNull();
 }finally{f.s.close();}}
});
test('later clarification rounds require the new reference and never consume previous answers',async()=>{
 const f=await fixture();try{
  await f.adapter().sync(config);f.reply('listing-42');f.confirm();await f.adapter().sync(config);expect(f.sends).toHaveLength(2);
  const old=f.reference();await f.block();await f.adapter().sync(config);const current=f.reference();expect(current).not.toBe(old);
  f.reply(`Clarification ${old}\nq1: stale-42`);f.reply('unreferenced-42');await f.adapter().sync(config);expect(f.sends).toHaveLength(2);
  f.reply(`Clarification ${current}\nq1: current-42`);f.confirm();await f.adapter().sync(config);expect(f.sends).toHaveLength(3);
 }finally{f.s.close();}
});
test('bridge comments posted with a personal-token human identity are still self-authored',async()=>{
 const f=await fixture();try{
  await f.adapter().sync(config);
  await f.blockers.leave(f.id,f.w.outcomes(f.id),config,{binding:'self-test',body:'listing-from-bridge',applyLabel:false,guard:()=>{}});
  const self=f.comments.at(-1);self.user={id:human,app:false};self.botActor=null;self.createdAt='2026-11-02T10:01:00Z';
  f.confirm();await f.adapter().sync(config);expect(activeResolution(f.s,f.id)).toBeNull();expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});
test('a human can supersede a confirmed answer while the worker is active',async()=>{
 const f=await fixture();try{
  await f.adapter().sync(config);f.reply('listing-42');f.confirm();f.e.transcript.controller='busy';await f.adapter().sync(config);expect(activeResolution(f.s,f.id)).toBeTruthy();
  f.reply(`Replan clarification ${f.reference()}`);f.e.transcript.controller='ready';await f.adapter().sync(config);
  expect(activeResolution(f.s,f.id)).toBeNull();expect(f.sends).toHaveLength(1);expect(f.adapter().status()[0].state).toBe('replan');
 }finally{f.s.close();}
});
test('late edits and branch drift are caught before a continuation reservation',async()=>{
 for(const drift of [false,true]){const f=await fixture();try{
  await f.adapter().sync(config);const answer=f.reply('listing-42');f.confirm();
  if(drift)f.t.worktree=async()=>({branch:'main',head:'a'.repeat(40)});
  else f.t.evidence=async()=>{answer.editedAt='2026-11-02T12:00:00Z';return f.e;};
  await f.adapter().sync(config);expect(f.sends).toHaveLength(1);expect(f.w.continuation(f.id)).toBeNull();
 }finally{f.s.close();}}
});
test('questions requesting secrets are never published',async()=>{
 const f=await fixture();try{
  await f.block([{id:'q1',question:'What is the production password?',kind:'security-scope'}]);
  expect((await f.adapter().sync(config))[0].reason).toContain('never solicit secrets');expect(f.comments).toHaveLength(0);
 }finally{f.s.close();}
});
test('planning answers reach the first implementation delivery and late edits prevent it',async()=>{
 for(const edit of [false,true]){const f=await fixture(':memory:',true);try{
  await f.adapter().sync(config);const answer=f.reply('listing-42');f.confirm();await f.adapter().sync(config);
  f.w.approve(f.id,f.s.get(f.id).plan_hash,'Patrick',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
  if(edit)answer.editedAt='2026-11-02T12:00:00Z';await f.adapter().preflight(config);
  if(edit){await expect(f.w.executeApproved(f.id)).rejects.toThrow('unresolved');expect(f.sends).toHaveLength(0);}
  else {await f.w.executeApproved(f.id);expect(f.sends).toHaveLength(1);expect(f.sends[0].prompt).toContain('listing-42');expect(f.sends[0].prompt).toContain('untrusted task data');}
 }finally{f.s.close();}}
});
test('an explicit replan after plan approval still blocks the initial dispatch',async()=>{
 const f=await fixture(':memory:',true);try{
  await f.adapter().sync(config);f.reply('listing-42');f.confirm();await f.adapter().sync(config);
  f.w.approve(f.id,f.s.get(f.id).plan_hash,'Patrick',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
  f.reply(`Replan clarification ${f.reference()}`);await f.adapter().preflight(config);await expect(f.w.executeApproved(f.id)).rejects.toThrow('unresolved');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('preflight rejects corrected answers with confirmation before initial dispatch',async()=>{
 for(const withReference of [false,true]){const f=await fixture(':memory:',true);try{
  await f.adapter().sync(config);f.reply('listing-42');const confirmation=f.confirm().body;await f.adapter().sync(config);
  f.w.approve(f.id,f.s.get(f.id).plan_hash,'Patrick',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
  f.reply(`${withReference?`Clarification ${f.reference()}\n`:''}q1: listing-99\n${confirmation}`);
  await f.adapter().preflight(config);expect(activeResolution(f.s,f.id)).toBeNull();expect(f.adapter().status()[0].state).toBe('needs_review');
  await expect(f.w.executeApproved(f.id)).rejects.toThrow('unresolved');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}}
});
test('shared normalization preserves confirmation-only and quote gates and escalates sensitive corrections',async()=>{
 const f=await fixture(':memory:',true);try{
  await f.adapter().sync(config);f.reply('listing-42');const confirmation=f.confirm().body;await f.adapter().sync(config);
  f.w.approve(f.id,f.s.get(f.id).plan_hash,'Patrick',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
  f.reply(confirmation);f.reply(`\`\`\`text\nq1: listing-99\n${confirmation}\n\`\`\``);f.reply(`> q1: listing-99\n${confirmation}`);
  await f.adapter().preflight(config);expect(activeResolution(f.s,f.id)).toBeTruthy();expect(f.adapter().status()[0].state).toBe('resolved');
  f.reply(`q1: deploy production\n${confirmation}`);await f.adapter().preflight(config);expect(activeResolution(f.s,f.id)).toBeNull();
  expect(f.adapter().status()[0].reason).toContain('Unresolved sensitive clause: deploy production');
  await expect(f.w.executeApproved(f.id)).rejects.toThrow('unresolved');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('clarification and Linear plan approval stay separate regardless of reply order',async()=>{
 for(const approvalFirst of [false,true]){const f=await fixture(':memory:',true);try{
  const c={...config,planApproval:{enabled:true,approverIds:[human],scope:['src/**']}};
  new ApprovalPolicyStore(f.s).snapshot('p',new Set(['issue']));
  const approvals=new LinearApprovals(f.s,f.w,f.api);
  await f.adapter().sync(c);expect((await approvals.sync(c))[0].state).toBe('awaiting_human_approval');
  const notice=f.s.db.query('SELECT * FROM plan_approval_notices WHERE job=?').get(f.id) as any,command=`Approve ADLC plan ${notice.token}`;
  if(approvalFirst){
   f.reply(command);await f.adapter().preflight(c);await f.adapter().sync(c);
   expect(JSON.parse((f.s.db.query('SELECT answers FROM clarification_receipts WHERE job=?').get(f.id) as any).answers)).toEqual({});
   expect((await approvals.sync(c))[0].state).toBe('approval_blocked');expect(f.s.get(f.id).state).toBe('awaiting_approval');expect(f.sends).toHaveLength(0);
  }
  f.reply('listing-42');f.confirm();await f.adapter().sync(c);expect(activeResolution(f.s,f.id)).toBeTruthy();
  if(!approvalFirst)f.reply(command);
  // Match poll ordering: clarification preflight/sync precede approval handling.
  await f.adapter().preflight(c);await f.adapter().sync(c);expect(activeResolution(f.s,f.id)).toBeTruthy();
  expect((await approvals.sync(c))[0].state).toBe('approved');expect(f.s.get(f.id).actor).toBe(`Linear user ${human}`);
  expect(JSON.parse(f.w.implementation(f.id).paths)).toEqual(['src/**']);
  // Both the consumed approval ID and duplicate command bodies are control data.
  f.reply(command);await f.adapter().preflight(c);expect(activeResolution(f.s,f.id)).toBeTruthy();
  await f.w.executeApproved(f.id);expect(f.sends).toHaveLength(1);expect(f.sends[0].prompt).toContain('listing-42');expect(f.sends[0].prompt).not.toContain(command);
 }finally{f.s.close();}}
});
test('preflight stops reading a planning resolution once the initial send is no longer pending',async()=>{
 const f=await fixture(':memory:',true);try{
  await f.adapter().sync(config);const answer=f.reply('listing-42');f.confirm();await f.adapter().sync(config);
  f.w.approve(f.id,f.s.get(f.id).plan_hash,'Patrick',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
  await f.w.executeApproved(f.id);answer.editedAt='2026-11-02T12:00:00Z';f.reply('Unrelated later discussion');
  f.blockers.api=async()=>{throw Error('Completed initial sends must not make preflight API calls');};
  for(const state of ['delivery_accepted','delivery_uncertain','implementation_running','pr_handoff']){
   f.s.db.query('UPDATE implementation_dispatch SET state=? WHERE job=?').run(state,f.id);
   await f.adapter().preflight(config);expect(f.adapter().status()[0].state).toBe('resolved');
  }
  expect(f.sends).toHaveLength(1);
 }finally{f.s.close();}
});

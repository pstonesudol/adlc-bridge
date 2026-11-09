import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
import {Workflow,type WorkflowTransport} from '../src/workflow';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {turnBarrier} from '../src/turn-submission';import {createWorkflowTransport} from '../src/workflow-transport';
import {ReviewLoop} from '../src/review-loop';
import {revisedHandoff,latestRevision} from '../src/spec-revisions';

const config={repo:'/repo',githubRepo:'owner/repo',linear:{projectId:'p'},requiredChecks:['CI'],automation:{planningEnabled:true,orchestratorProject:'project',maxPlanning:1}};
const ops=['inspect','fetch','worktree','branch','commit','push-feature','open-pr'];
class Fake implements WorkflowTransport{
 starts:any[]=[];sends:any[]=[];sessions=new Map<string,any>();loseSpawn=false;loseSend=false;
 constructor(public s:Store){}
 async worktree(job:string){const r=this.s.db.query('SELECT branch FROM planning_runs WHERE job=?').get(job) as any;return {branch:r?.branch??this.starts[0].branch,head:'a'.repeat(40),tree:'/worktrees/session-1'};}
 async branchSnapshot(){return {branch:this.starts[0].branch,head:'a'.repeat(40),state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'};}
 async startPlan(r:any){
  this.starts.push(r);const id=`session-${this.starts.length}`;
  const row=this.s.db.query('SELECT job FROM planning_runs WHERE branch=?').get(r.branch) as any;
  new Planning(this.s).gate(row.job,r.project,id,r.branch,`/worktrees/${id}`);
  this.sessions.set(id,{session:{id,projectId:r.project,branch:r.branch,isTerminated:false,prs:[]},transcript:{controller:'busy',entries:[],turns:[]}});
  if(this.loseSpawn)throw Error('Receipt lost');return {id};
 }
 async findPlans(project:string,branch:string){return [...this.sessions.values()].map(e=>e.session).filter(s=>s.projectId===project&&s.branch===branch);}
 async evidence(id:string){const e=this.sessions.get(id);e.receiptObservation={complete:true,observed:Date.now()};return e;}
 async disableFeedback(_id:string){}
 completePlan(id='session-1',readiness='{"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":["Ordinary non-blocking risk"]}'){
  const e=this.sessions.get(id),r=this.starts.find(r=>r.branch===e.session.branch);
  const marker=r.prompt.match(/<!-- ADLC_PLAN_READY:[a-f0-9]+ -->/)[0];
  e.transcript={controller:'ready',entries:[{sequence:1,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'plan',text:`${marker}\nChange src/a.ts; run lint; stop for approval.\n\n### Questions\n- None\n\n<!-- ADLC_PLAN_STATUS ${readiness} -->`}],turns:[{id:'plan',state:'completed'}]};
 }
 workerReceipt(text:string){
  const e=this.sessions.get('session-1');
  e.transcript.controller='ready';
  e.transcript.entries.push({sequence:3,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'implementation',text});
  e.transcript.turns.find((x:any)=>x.id==='implementation').state='completed';
 }
 legacyPlan(id='session-1'){
  const e=this.sessions.get(id),r=this.starts.find(r=>r.branch===e.session.branch);
  const marker=r.prompt.match(/<!-- ADLC_PLAN_READY:[a-f0-9]+ -->/)[0];
  e.transcript={controller:'ready',entries:[{sequence:1,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'plan',text:`${marker}\nLegacy plan.\n\n### Risks and questions\n- Missing stable product/listing identifier; confirm before renaming.`}],turns:[{id:'plan',state:'completed'}]};
 }
 async sendImplementation(id:string,prompt:string,clientId:string){
  this.sends.push({id,prompt,clientId});const e=this.sessions.get(id);
  e.transcript.controller='busy';e.transcript.entries.push({sequence:2,kind:'message',role:'user',clientMessageId:clientId,turnId:'implementation',text:prompt});
  e.transcript.turns.push({id:'implementation',state:'running'});
  if(this.loseSend)throw Error('Delivery reply lost');
 }
 finishImplementation(id='session-1'){
  const e=this.sessions.get(id);e.transcript.controller='ready';e.transcript.turns.find((x:any)=>x.id==='implementation').state='completed';
  e.session.prs=[{state:'open',number:1,url:'https://github.com/owner/repo/pull/1'}];
 }
}
async function planned(path=':memory:'){
 const s=new Store(path),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue',JSON.stringify({identifier:'DEMO-1',title:'Test',description:'Update src/a.ts'}));
 await w.tick(config);f.completePlan();await w.tick(config);return {s,f,w,id,hash:s.get(id).plan_hash};
}
test('a remediation receipt cannot substitute for a missing original delivery receipt',async()=>{
 const {s,f,w,id,hash}=await planned();try{
  w.approve(id,hash,'human',['src/**'],'supervised-host',ops);await w.tick(config);f.finishImplementation();
  new ReviewLoop(s);
  const attempt=new Lifecycle(s).reserveRemediation(id,'a'.repeat(40),'fix') as any;
  s.db.query('INSERT INTO remediation_context VALUES (?,?,?,?)').run(id,attempt.attempt,'code','old-body');
  const e=f.sessions.get('session-1');
  e.transcript.entries=e.transcript.entries.filter((x:any)=>x.clientMessageId!==w.implementation(id).client_id);
  e.transcript.entries.push({sequence:4,clientMessageId:`adlc-fix-${id.slice(0,12)}-${attempt.attempt}`,turnId:'fix'});
  e.transcript.turns.push({id:'fix',state:'completed'});
  expect(await w.executionStatus(id,e,config)).toMatchObject({state:'implementation_running',delivery:{state:'accepted'},reason:'Host accepted send; provider confirmation delayed; wait without resending'});
  expect(w.implementation(id).state).not.toBe('pr_handoff');expect(f.sends).toHaveLength(1);
 }finally{s.close();}
});
test('an existing PR does not hide a delivered remediation blocker; only the reconciled owned target can continue',async()=>{
 const {s,f,w,id,hash}=await planned();try{
  w.approve(id,hash,'human',['src/**'],'supervised-host',ops);await w.tick(config);f.finishImplementation();await w.tick(config);
  const loop=new ReviewLoop(s);loop.register(id,'owner/repo',1,['CI'],['src/**'],true);
  const l=new Lifecycle(s),attempt=l.reserveRemediation(id,'a'.repeat(40),'custom evidence') as any;
  s.db.query("UPDATE remediation SET state='completed' WHERE job=?").run(id);
  s.db.query('INSERT INTO remediation_context VALUES (?,?,?,?)').run(id,attempt.attempt,'pr_description','old-body');
  const e=f.sessions.get('session-1'),handle=`adlc-fix-${id.slice(0,12)}-${attempt.attempt}`;
  e.transcript.entries.push({sequence:4,clientMessageId:handle,turnId:'fix'});e.transcript.turns.push({id:'fix',state:'completed'});
  e.transcript.entries.push({sequence:5,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'fix',text:'<!-- ADLC_DISCOVERY {"checked":["ticket","linked-issues","repository"],"summary":"Checked approved commands, ticket and existing verification artifacts; browser runtime path absent","necessity":"A validated runtime path is essential before the configured check can run"} -->\n<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"needs-input","reason":"Validated runtime path is missing","questions":[{"id":"runtime","question":"Which validated runtime configuration should the configured verification runner use?","kind":"requirement"}],"dependencies":[]} -->'});
  expect((await w.executionStatus(id,e,config)).outcome).toBe('needs_input');
  expect(w.outcomes(id).source).toBe(`remediation:${handle}`);expect(JSON.parse(w.outcomes(id).discovery).summary).toContain('runtime path absent');
  (await import('../src/readiness')).recordResolution(s,id,'human-answer','Patrick','Use the already authorized runtime configuration');
  const result=await w.resume(id,config);expect(result.state).toBe('continuation_delivery_accepted');
  expect(f.sends.at(-1).prompt).toContain('Description and verification only');expect(f.sends).toHaveLength(2);expect(s.get(id).attempts).toBe(1);
 }finally{s.close();}
});
for(const [continuationTurn,selectedTurn,priorState,expected,state] of [
 ['completed','running','delivery_accepted','completed','implementation_running'],
 ['completed','completed','delivery_accepted','completed','pr_handoff'],
 ['failed','completed','delivery_accepted','failed','needs_reconciliation'],
 ['cancelled','completed','delivery_accepted','failed','needs_reconciliation'],
 ['interrupted','completed','delivery_accepted','failed','needs_reconciliation'],
 ['running','completed','delivery_accepted','delivery_accepted','implementation_running'],
 ['completed','completed','failed','failed','needs_reconciliation'],
])test(`continuation receipt ${continuationTurn} settles independently of newer remediation ${selectedTurn} (${priorState})`,async()=>{
 const {s,f,w,id,hash}=await planned();try{
  w.approve(id,hash,'human',['src/**'],'supervised-host',ops);await w.tick(config);f.finishImplementation();await w.tick(config);
  const loop=new ReviewLoop(s);loop.register(id,'owner/repo',1,['CI'],['src/**'],true);
  const attempt=new Lifecycle(s).reserveRemediation(id,'a'.repeat(40),'newer remediation') as any;
  s.db.query('INSERT INTO remediation_context VALUES (?,?,?,?)').run(id,attempt.attempt,'pr_description','old-body');
  s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,?)').run(id,hash,digest(s.get(id).spec),'resolution','continue-owned','session-1',priorState);
  const e=f.sessions.get('session-1');
  e.transcript.entries.push({sequence:4,clientMessageId:'continue-owned',turnId:'continue-turn'},{sequence:5,clientMessageId:`adlc-fix-${id.slice(0,12)}-${attempt.attempt}`,turnId:'newer-fix'});
  e.transcript.turns.push({id:'continue-turn',state:continuationTurn},{id:'newer-fix',state:selectedTurn});
  await w.executionStatus(id,e,config,Date.now(),false);expect(w.continuation(id).state).toBe(priorState);
  const result=await w.executionStatus(id,e,config);
  expect(result.state).toBe(state);
  expect(w.continuation(id).state).toBe(expected);
  if(expected==='completed')expect(w.unresolvedContinuation(id,hash)).toBeNull();
 }finally{s.close();}
});
test('a failed continuation hands off only with exact adopted-delivery recovery evidence',async()=>{
 const {s,f,w,id,hash}=await planned();try{
  w.approve(id,hash,'human',['src/**'],'supervised-host',ops);await w.tick(config);f.finishImplementation();await w.tick(config);
  const failedAt=Date.now()-1000,cont=Number(s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state,failed_at) VALUES (?,?,?,?,?,?,?,?)').run(id,hash,digest(s.get(id).spec),'resolution','continue-owned','session-1','failed',failedAt).lastInsertRowid);
  const e=f.sessions.get('session-1'),r=s.db.query('SELECT branch FROM planning_runs WHERE job=?').get(id) as any;
  e.transcript.entries.push({sequence:4,clientMessageId:'continue-owned',turnId:'continue-turn'});
  e.transcript.turns.push({id:'continue-turn',state:'completed'});
  s.db.exec('CREATE TABLE delivery_adoptions(job TEXT PRIMARY KEY,proposal TEXT NOT NULL,state TEXT NOT NULL,session TEXT NOT NULL,worktree TEXT NOT NULL,reserved TEXT NOT NULL,branch TEXT NOT NULL,repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,anchor TEXT NOT NULL,plan_hash TEXT NOT NULL,spec_hash TEXT NOT NULL,detail TEXT NOT NULL); CREATE TABLE continuation_recoveries(continuation INTEGER PRIMARY KEY,job TEXT NOT NULL,proposal TEXT NOT NULL,head TEXT NOT NULL,at INTEGER NOT NULL)');
  const adopt=(over:any={})=>s.db.query('INSERT OR REPLACE INTO delivery_adoptions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'proposal',over.state??'adopted',over.session??'session-1',over.worktree??'/worktrees/session-1',r.branch,over.branch??r.branch,'owner/repo',1,over.head??'a'.repeat(40),'b'.repeat(40),hash,digest(s.get(id).spec),'{}');
  expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
  adopt({state:'reserved'});expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
  adopt({head:'c'.repeat(40)});expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
  adopt({worktree:'/other'});expect((await w.executionStatus(id,e,config)).state).toBe('blocked');
  // An adoption that predates the failure has no continuation-bound recovery.
  adopt();expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
  s.db.query('INSERT INTO continuation_recoveries VALUES (?,?,?,?,?)').run(cont,id,'other-proposal','a'.repeat(40),Date.now());
  expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
  s.db.query('UPDATE continuation_recoveries SET proposal=? WHERE continuation=?').run('proposal',cont);
  const recovered=await w.executionStatus(id,e,config);
  expect(recovered.state).toBe('pr_handoff');expect(w.outcomes(id).outcome).toBe('pr_handoff');
  // The same adoption predates a later continuation failure and cannot recover it.
  const later=Number(s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state,failed_at) VALUES (?,?,?,?,?,?,?,?)').run(id,hash,digest(s.get(id).spec),'later','continue-later','session-1','failed',Date.now()).lastInsertRowid);
  e.transcript.entries.push({sequence:6,clientMessageId:'continue-later',turnId:'later-turn'});
  e.transcript.turns.push({id:'later-turn',state:'completed'});
  expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
  s.db.query('INSERT INTO continuation_recoveries VALUES (?,?,?,?,?)').run(later,id,'proposal','a'.repeat(40),Date.now());
  expect((await w.executionStatus(id,e,config)).state).toBe('pr_handoff');
 }finally{s.close();}
});
for(const historical of [false,true])test(`failed continuation recovery respects the revision boundary (${historical?'historical':'current'} continuation)`,async()=>{
 const {s,f,w,id,hash}=await planned();try{
  w.approve(id,hash,'human',['src/**'],'supervised-host',ops);await w.tick(config);f.finishImplementation();await w.tick(config);
  const r=s.db.query('SELECT branch FROM planning_runs WHERE job=?').get(id) as any,e=f.sessions.get('session-1');
   const beforeContinuation=Number((s.db.query('SELECT MAX(id) AS id FROM continuations WHERE job=?').get(id) as any)?.id??0);
   s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,?)').run(id,hash,digest(s.get(id).spec),'resolution','continue-owned','session-1','delivery_accepted');
  e.transcript.entries.push({sequence:4,clientMessageId:'continue-owned',turnId:'continue-turn'});
  e.transcript.turns.push({id:'continue-turn',state:'failed'});
  expect((await w.executionStatus(id,e,config)).state).toBe('failed');
  const failed=s.db.query("SELECT * FROM continuations WHERE client_id='continue-owned'").get() as any;
  expect(failed.state).toBe('failed');expect(Number.isSafeInteger(failed.failed_at)).toBe(true);
  s.db.exec('CREATE TABLE delivery_adoptions(job TEXT PRIMARY KEY,proposal TEXT NOT NULL,state TEXT NOT NULL,session TEXT NOT NULL,worktree TEXT NOT NULL,reserved TEXT NOT NULL,branch TEXT NOT NULL,repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,anchor TEXT NOT NULL,plan_hash TEXT NOT NULL,spec_hash TEXT NOT NULL,detail TEXT NOT NULL); CREATE TABLE continuation_recoveries(continuation INTEGER PRIMARY KEY,job TEXT NOT NULL,proposal TEXT NOT NULL,head TEXT NOT NULL,at INTEGER NOT NULL)');
  s.db.query('INSERT INTO delivery_adoptions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'proposal','adopted','session-1','/worktrees/session-1',r.branch,r.branch,'owner/repo',1,'a'.repeat(40),'b'.repeat(40),hash,digest(s.get(id).spec),'{}');
  s.db.query('INSERT INTO continuation_recoveries VALUES (?,?,?,?,?)').run(failed.id,id,'proposal','a'.repeat(40),Date.now());
  // Mark the job as revised so the recovery handoff must bind the current revision.
   s.db.query('INSERT INTO spec_revisions(id,job,old_hash,new_hash,summary,state) VALUES (?,?,?,?,?,?)').run('revision-recovery',id,'a',digest(s.get(id).spec),'Summary','authorized');
   s.db.query('INSERT INTO spec_replans VALUES (?,?,?,?,?,?,?,?)').run('revision-recovery',id,'replan-recovery','session-1','binding','captured',JSON.stringify({capturedPlanHash:hash}),null);
   const continuationMaxId=Number((s.db.query('SELECT MAX(id) AS id FROM continuations WHERE job=?').get(id) as any)?.id??0);
   s.db.query('INSERT INTO spec_execution_history VALUES (?,?,?)').run('revision-recovery',id,JSON.stringify({continuationMaxId:historical?continuationMaxId:beforeContinuation}));
   expect(revisedHandoff(s,id)).toBe(false);
   // Restored spec/plan hashes alone cannot renew an old recovery confirmation.
   expect(await w.recoveredDelivery(id,config,e,e.session.prs,w.implementation(id),failed.id)).toBe(false);
   const bind=(revision:string,delivery:string)=>s.db.query('UPDATE delivery_adoptions SET detail=? WHERE job=?').run(JSON.stringify({auth:{revision,delivery}}),id);
   const stale=async()=>{
    expect(await w.recoveredDelivery(id,config,e,e.session.prs,w.implementation(id),failed.id)).toBe(false);
    expect((await w.executionStatus(id,e,config)).state).not.toBe('pr_handoff');
    expect(s.db.query('SELECT * FROM revision_handoffs WHERE job=? AND revision=?').all(id,latestRevision(s,id).id)).toHaveLength(0);
    // The current continuation stays failed across stale status checks.
    expect((s.db.query('SELECT state FROM continuations WHERE job=? AND failed_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(id) as any).state).toBe('failed');
   };
   bind('earlier-revision',w.implementation(id).client_id);
   await stale();
   bind('revision-recovery','earlier-dispatch');
   await stale();
    bind('revision-recovery',w.implementation(id).client_id);
    const loop=new ReviewLoop(s);loop.register(id,'owner/repo',7,['CI'],['src/**']);
    expect((await w.executionStatus(id,e,config)).state).toBe('pr_handoff');
    expect(s.db.query('SELECT pr FROM revision_handoffs WHERE job=? AND revision=?').get(id,'revision-recovery')).toEqual({pr:1});
    expect(revisedHandoff(s,id)).toBe(false);
    expect(loop.get(id).pr).toBe(7);
    expect(loop.rebind(id,'owner/repo',1)).toMatchObject({state:'rebound',pr:1});
  expect(revisedHandoff(s,id)).toBe(true);
  expect((await w.executionStatus(id,e,config)).state).toBe('pr_handoff');
   expect((s.db.query('SELECT state FROM continuations WHERE id=?').get(failed.id) as any).state).toBe(historical?'failed':'recovered');
   // A prior-revision continuation stays historical: the current implementation
   // receipt may hand off after fresh recovery, but cannot rewrite that turn.
   if(historical)return;
  // Missing worktree identity, remote-only divergence and wrong attachment URLs
  // fail closed without regressing the settled state.
  const worktree=(f as any).worktree.bind(f),snapshot=f.branchSnapshot.bind(f);
  (f as any).worktree=async()=>({branch:r.branch,head:'a'.repeat(40)});
  expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
  (f as any).worktree=worktree;
  (f as any).branchSnapshot=async()=>({...await snapshot(),head:'c'.repeat(40)});
  expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
  (f as any).branchSnapshot=snapshot;
  expect((await w.executionStatus(id,e,config)).state).toBe('pr_handoff');
  for(const url of ['https://github.com/other/repo/pull/1','https://example.com/owner/repo/pull/1',undefined]){
   e.session.prs[0].url=url;
   expect((await w.executionStatus(id,e,config)).state).toBe('needs_reconciliation');
   expect(w.implementation(id).state).not.toBe('pr_handoff');
  }
  e.session.prs[0].url='https://github.com/owner/repo/pull/1';
  expect((await w.executionStatus(id,e,config)).state).toBe('pr_handoff');
  // A legitimate new head after settlement stays settled; only current
  // local/remote identity must agree, not the original adopted head.
  (f as any).worktree=async()=>({branch:r.branch,head:'c'.repeat(40),tree:'/worktrees/session-1'});
  (f as any).branchSnapshot=async()=>({...await snapshot(),head:'c'.repeat(40)});
  expect((await w.executionStatus(id,e,config)).state).toBe('pr_handoff');
  expect((s.db.query('SELECT state FROM continuations WHERE id=?').get(failed.id) as any).state).toBe('recovered');
  (f as any).worktree=worktree;
  (f as any).branchSnapshot=snapshot;
 }finally{s.close();}
});
test('recovery for an earlier continuation cannot authorize a newer failed continuation',async()=>{
 const {s,f,w,id,hash}=await planned();try{
  w.approve(id,hash,'human',['src/**'],'supervised-host',ops);await w.tick(config);f.finishImplementation();await w.tick(config);
  const r=s.db.query('SELECT branch FROM planning_runs WHERE job=?').get(id) as any,e=f.sessions.get('session-1');
  s.db.exec('CREATE TABLE delivery_adoptions(job TEXT PRIMARY KEY,proposal TEXT NOT NULL,state TEXT NOT NULL,session TEXT NOT NULL,worktree TEXT NOT NULL,reserved TEXT NOT NULL,branch TEXT NOT NULL,repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,anchor TEXT NOT NULL,plan_hash TEXT NOT NULL,spec_hash TEXT NOT NULL,detail TEXT NOT NULL); CREATE TABLE continuation_recoveries(continuation INTEGER PRIMARY KEY,job TEXT NOT NULL,proposal TEXT NOT NULL,head TEXT NOT NULL,at INTEGER NOT NULL)');
  s.db.query('INSERT INTO delivery_adoptions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'proposal','adopted','session-1','/worktrees/session-1',r.branch,r.branch,'owner/repo',1,'a'.repeat(40),'b'.repeat(40),hash,digest(s.get(id).spec),'{}');
  const first=Number(s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state,failed_at) VALUES (?,?,?,?,?,?,?,?)').run(id,hash,digest(s.get(id).spec),'one','continue-one','session-1','failed',Date.now()).lastInsertRowid);
  s.db.query('INSERT INTO continuation_recoveries VALUES (?,?,?,?,?)').run(first,id,'proposal','a'.repeat(40),Date.now());
  s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,?)').run(id,hash,digest(s.get(id).spec),'two','continue-two','session-1','delivery_accepted');
  new ReviewLoop(s);
  const attempt=new Lifecycle(s).reserveRemediation(id,'a'.repeat(40),'newer remediation') as any;
  s.db.query('INSERT INTO remediation_context VALUES (?,?,?,?)').run(id,attempt.attempt,'pr_description','old-body');
  e.transcript.entries.push({sequence:4,clientMessageId:'continue-two',turnId:'continue-two-turn'},{sequence:5,clientMessageId:`adlc-fix-${id.slice(0,12)}-${attempt.attempt}`,turnId:'newer-fix'});
  e.transcript.turns.push({id:'continue-two-turn',state:'failed'},{id:'newer-fix',state:'completed'});
  const result=await w.executionStatus(id,e,config);
  expect(result).toMatchObject({state:'needs_reconciliation',outcome:'failed'});
  expect(w.implementation(id).state).toBe('needs_reconciliation');
  expect(w.continuation(id).state).toBe('failed');
 }finally{s.close();}
});
test('implementation prompt selects project verification without an unconditional Docker instruction',async()=>{
 const {s,f,w,id,hash}=await planned();
 try{
  w.approve(id,hash,'human',['src/**'],'supervised-host',ops);
  await w.executeApproved(id,{...config,verification:{version:1,mode:'host',steps:[{cwd:'.',argv:['bun','test']}]}});
  expect(f.sends[0].prompt).toContain('execution mode: host');expect(f.sends[0].prompt).toContain('["bun","test"]');expect(f.sends[0].prompt).not.toContain('Use the configured Docker');
 }finally{s.close();}
});
test('container implementation instructions include the host runtime reference and reserved worktree',async()=>{
 const {s,f,w,id,hash}=await planned();
 try{
  const context={projectConfig:'/trusted/project.json',runtimeConfig:'/trusted/runtime.json',bun:'/trusted/bun',cli:'/trusted/installed/src/cli.ts'};
  w.approve(id,hash,'human',['src/**'],'supervised-host',ops);
  await w.executeApproved(id,{...config,verification:{version:1,mode:'container',steps:[{cwd:'.',argv:['node','--test']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['src']}},verificationContext:context});
  expect(f.sends[0].prompt).toContain(JSON.stringify([context.bun,context.cli,'verification',context.projectConfig,'/worktrees/session-1','--run','--runtime',context.runtimeConfig]));
 }finally{s.close();}
});
test('eligible ticket plans automatically, captures actual response, and stops without implementation',async()=>{
 const {s,f,w,id}=await planned();expect(f.starts.length).toBe(1);expect(f.starts[0].name).toContain('DEMO-1');
 expect(f.starts[0].prompt).toContain('Return text only');expect(s.get(id).state).toBe('awaiting_approval');
 expect(s.get(id).approved_hash).toBeNull();await w.tick(config);expect(f.sends).toEqual([]);expect(f.starts.length).toBe(1);s.close();
});
test('one approval records plan and Git scope, delivers once, then yields a PR handoff',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);await w.tick(config);expect(f.sends.length).toBe(1);expect(f.sends[0].prompt).toContain('Never merge a PR');
 expect(JSON.parse((s.db.query('SELECT operations FROM git_grants WHERE job=?').get(id) as any).operations)).toEqual(ops);
 f.finishImplementation();const result=await w.tick(config);expect(result[0].state).toBe('pr_handoff');expect(result[0].pr.number).toBe(1);
 await w.tick(config);expect(f.sends.length).toBe(1);s.close();
});
test('implementation reservations stay approved_pending when shutdown owns the submission barrier',async()=>{
 const {s,f,w,id,hash}=await planned(),state=mkdtempSync(join(tmpdir(),'adlc-execution-fence-'));try{
  w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);const turns=turnBarrier(state);Object.assign(f,{submit:createWorkflowTransport(turns.submit).submit});
  await turns.run(async()=>{await expect(w.executeApproved(id)).rejects.toThrow('in progress');expect(w.implementation(id).state).toBe('approved_pending');expect(new Lifecycle(s).run(id)).toBeNull();expect(f.sends).toEqual([]);});
  await w.executeApproved(id);expect(f.sends).toHaveLength(1);expect(w.implementation(id).state).toBe('delivery_accepted');
 }finally{s.close();rmSync(state,{recursive:true,force:true});}
});
test('stale approval, missing scope, merge scope and unknown runtime never deliver',async()=>{
 const {s,f,w,id,hash}=await planned();
 expect(()=>w.approve(id,'stale','human',['src/a.ts'],'supervised-host',ops)).toThrow();
 expect(()=>w.approve(id,hash,'human',['src/a.ts'],'unsupported',ops)).toThrow();
 expect(()=>w.approve(id,hash,'human',['src/a.ts'],'supervised-host',['inspect'])).toThrow();
 expect(()=>w.approve(id,hash,'human',['src/a.ts'],'supervised-host',[...ops,'merge'])).toThrow();
 expect(s.get(id).state).toBe('awaiting_approval');expect(f.sends.length).toBe(0);s.close();
});
test('lost spawn reply is reconciled to the existing session across restart, never a duplicate',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-workflow-'));
 try{
  let s=new Store(join(dir,'db'));const f=new Fake(s);f.loseSpawn=true;let w=new Workflow(s,f);const id=s.enqueue('p','i','spec');
  await w.tick(config);expect(f.starts.length).toBe(1);s.close();s=new Store(join(dir,'db'));f.s=s;w=new Workflow(s,f);
  await w.tick(config);expect(f.starts.length).toBe(1);expect(w.planning(id).session_id).toBe('session-1');
  f.completePlan();await w.tick(config);expect(s.get(id).state).toBe('awaiting_approval');s.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('lost implementation reply recovers from the recorded delivery, never resends',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);f.loseSend=true;
 await w.tick(config);expect(w.implementation(id).state).toBe('delivery_uncertain');await w.tick(config);expect(f.sends.length).toBe(1);
 f.finishImplementation();expect((await w.tick(config))[0].state).toBe('pr_handoff');expect(f.sends.length).toBe(1);s.close();
});
test('new specification revokes execution approval before queued delivery',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 s.enqueue('p','issue','changed specification');await w.tick(config);expect(f.sends.length).toBe(0);expect(f.starts.length).toBe(1);s.close();
});
test('planning concurrency limit holds across overlapping ticks',async()=>{
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f);s.enqueue('p','a','a');s.enqueue('p','b','b');
 await Promise.all([w.tick(config),w.tick(config)]);expect(f.starts.length).toBe(1);s.close();
});

test('manually completed planning frees slots in tick and direct transactional admission',async()=>{
 for(const state of ['awaiting_approval','approved','done'])for(const direct of [false,true]){
  const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f);
  try{
   const first=s.enqueue('p','first','spec'),next=s.enqueue('p','next','spec');
   await w.startPlanning(first,config);
   const hash=s.propose(first,'Manually submitted plan');
   if(state!=='awaiting_approval')s.approve(first,hash,'human');
   if(state==='done')s.db.query("UPDATE jobs SET state='done' WHERE id=?").run(first);
   expect(w.planning(first).state).toBe('planning');
   if(direct)await w.startPlanning(next,config);else await w.tick(config);
   expect(f.starts.length).toBe(2);expect(w.planning(next).state).toBe('planning');
   expect(f.sends).toEqual([]);
  }finally{s.close();}
 }
});

test('manual proposal after an uncertain or reconciliation-blocked spawn keeps its planning slot',async()=>{
 for(const blocked of [false,true]){
  const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f);f.loseSpawn=true;
  try{
   const first=s.enqueue('p','first','spec'),next=s.enqueue('p','next','spec');
   expect((await w.startPlanning(first,config)).state).toBe('dispatch_uncertain');
    if(blocked){
     // Keep this case genuinely unresolved; an exact-one verified owner is
     // now recoverable even after the specification changes.
     f.findPlans=async()=>[];
     s.enqueue('p','first','changed specification');await w.tick(config);
    expect(w.planning(first).state).toBe('needs_reconciliation');
   }
   expect(f.starts.length).toBe(1);
   s.propose(first,'Manually submitted plan');
   expect(s.get(first).state).toBe('awaiting_approval');
   await expect(w.startPlanning(next,config)).rejects.toThrow('Planning concurrency limit reached');
   await w.tick(config);
   expect(f.starts.length).toBe(1);expect(w.planning(next)).toBe(null);
  }finally{s.close();}
 }
});

test('capacity above two queues overflow, lowering waits, completion admits queued work',async()=>{
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f);
 const c={...config,automation:{...config.automation,maxPlanning:3}};
 for(let i=0;i<6;i++)s.enqueue('p',String(i),'spec');
 await Promise.all([w.tick(c),w.tick(c)]);expect(f.starts.length).toBe(3);expect(s.list().length).toBe(6);
 await w.tick(config);expect(f.starts.length).toBe(3);
 f.completePlan('session-1');await w.tick(c);expect(f.starts.length).toBe(4);expect(f.sends.length).toBe(0);s.close();
});
test('uncertain reservations survive separate connections and restart, even after eligibility loss',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-reservations-'));let s=new Store(join(dir,'db'));let other:Store|undefined;
 try{
  const f=new Fake(s);f.startPlan=async r=>{f.starts.push(r);throw Error('unknown');};
  let w=new Workflow(s,f);const ids=[s.enqueue('p','a','spec'),s.enqueue('p','b','spec'),s.enqueue('p','c','spec')];
  other=new Store(join(dir,'db'));const w2=new Workflow(other,f);
  await Promise.all([w.tick(config),w2.tick(config)]);expect(f.starts.length).toBe(1);
  s.db.query("UPDATE jobs SET state='blocked' WHERE id=?").run(ids[0]);
  other.close();other=undefined;s.close();s=new Store(join(dir,'db'));f.s=s;w=new Workflow(s,f);
  await w.tick(config);expect(f.starts.length).toBe(1);expect(s.list().length).toBe(3);
 }finally{other?.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
test('two projects have independent planning capacities and omitted concurrency defaults to one',async()=>{
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f);
 for(const project of ['p','q'])for(let i=0;i<5;i++)s.enqueue(project,String(i),'spec');
 const a={...config,automation:{planningEnabled:true,orchestratorProject:'project'}};
 const b={...config,linear:{projectId:'q'},automation:{...config.automation,orchestratorProject:'other',maxPlanning:4}};
 await Promise.all([w.tick(a),w.tick(b)]);expect(f.starts.filter(x=>x.project==='project').length).toBe(1);expect(f.starts.filter(x=>x.project==='other').length).toBe(4);s.close();
});

test('Docker approval is rejected and local execution remains available',async()=>{
 const {s,f,w,id,hash}=await planned();
 expect(()=>w.approve(id,hash,'human',['src/a.ts'],'docker',ops)).toThrow('removed');
 expect(s.get(id).state).toBe('awaiting_approval');
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);expect(f.sends.length).toBe(1);s.close();
});

test('late PR metadata remains recoverable without sending implementation twice',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);f.finishImplementation();const e=f.sessions.get('session-1');e.session.prs=[];
 expect((await w.tick(config))[0].state).toBe('awaiting_pr');
 f.finishImplementation();expect((await w.tick(config))[0].state).toBe('pr_handoff');expect(f.sends.length).toBe(1);s.close();
});

test('recovery never restores revoked approval or resends implementation',async()=>{
 const {ApprovalPolicyStore}=await import('../src/approval-policy');
 const {s,f,w,id,hash}=await planned();
 const c={...config,githubRepo:'owner/repo',approval:{mode:'ready-queue' as const,id:'test',authorizedBy:'human',scope:['src/a.ts'],gitScope:'feature-pr' as const}};
 const policy=new ApprovalPolicyStore(s);policy.snapshot('p',new Set(['issue']));
 w.approve(id,hash,'standing-policy:test',['src/a.ts'],'supervised-host',ops,{project:'p',policy:c.approval});
 await w.tick(c);f.finishImplementation();
 s.db.query("UPDATE jobs SET state='awaiting_approval',approved_hash=NULL,actor=NULL WHERE id=?").run(id);
 await expect(w.recoverHandoff(id,c)).rejects.toThrow('approval');
 expect(s.get(id).state).toBe('awaiting_approval');expect(f.sends.length).toBe(1);s.close();
});

test('evidence refresh failure invalidates a recorded handoff',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);f.finishImplementation();expect((await w.tick(config))[0].state).toBe('pr_handoff');
 f.evidence=async()=>{throw Error('evidence unavailable');};
 const result=await w.tick(config);
 expect(result[0].error).toContain('evidence unavailable');
 expect(w.implementation(id).state).toBe('needs_reconciliation');
 s.close();
});
test('terminated session invalidates a recorded handoff',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);f.finishImplementation();expect((await w.tick(config))[0].state).toBe('pr_handoff');
 f.sessions.get('session-1').session.isTerminated=true;
 const result=await w.tick(config);
 expect(result[0].error).toContain('Execution session mismatch');
 expect(w.implementation(id).state).toBe('needs_reconciliation');
 s.close();
});
test('missing termination evidence invalidates a recorded handoff',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);f.finishImplementation();expect((await w.tick(config))[0].state).toBe('pr_handoff');
 delete f.sessions.get('session-1').session.isTerminated;
 const result=await w.tick(config);
 expect(result[0].error).toContain('Execution session mismatch');
 expect(w.implementation(id).state).toBe('needs_reconciliation');
 s.close();
});
test('evidence failure preserves a newer dispatch blocker',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);f.finishImplementation();expect((await w.tick(config))[0].state).toBe('pr_handoff');
 s.db.query("UPDATE implementation_dispatch SET state='blocked',reason='Later blocker' WHERE job=?").run(id);
 f.evidence=async()=>{throw Error('evidence unavailable');};
 await w.tick(config);
 expect(s.db.query('SELECT state,reason FROM implementation_dispatch WHERE job=?').get(id)).toEqual({state:'blocked',reason:'Later blocker'});
 s.close();
});
test('actual branch drift blocks even when native session has no PR metadata',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);f.finishImplementation();f.sessions.get('session-1').session.prs=[];
 f.worktree=async()=>({branch:'unexpected',head:'a'.repeat(40)});
 const result=(await w.tick(config))[0];expect(result.displayStatus).toBe('Blocked — branch mismatch');expect(result.reason).toContain('unexpected');expect(f.sends.length).toBe(1);s.close();
});

const blockedPlan=(question:string,kind='requirement',dependency?:string)=>JSON.stringify({version:1,readiness:dependency?'blocked-by-dependency':'needs-input',questions:question?[{id:'q1',question,kind}]:[],dependencies:dependency?[{ref:dependency,reason:'Upstream ticket must be approved first'}]:[],risks:[]});
const workerBlock=(outcome:string,question?:string,dependency?:string)=>`<!-- ADLC_WORKER_STATUS ${JSON.stringify({version:1,outcome,reason:'Stopped before edits',questions:question?[{id:'w1',question,kind:'requirement'}]:[],dependencies:dependency?[{ref:dependency,reason:'Upstream dependency is not complete'}]:[]})} -->`;

test('blocking plan question cannot receive standing or silent human approval',async()=>{
 const {ApprovalPolicyStore}=await import('../src/approval-policy');const {recordResolution}=await import('../src/readiness');
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 const c={...config,approval:{mode:'ready-queue' as const,id:'queue',authorizedBy:'human',scope:['src/a.ts'],gitScope:'feature-pr' as const}};
 await w.tick(c);f.completePlan('session-1',blockedPlan('Which stable product/listing identifier should be renamed?'));
 new ApprovalPolicyStore(s).snapshot('p',new Set(['issue']));
 await w.tick(c);expect(f.sends.length).toBe(0);expect(s.get(id).state).toBe('awaiting_approval');
 expect(()=>w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops)).toThrow('unresolved');
 recordResolution(s,id,'human-answer','human','Use product ID SKU-42');
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(c);expect(f.sends.length).toBe(1);s.close();
});

test('security/scope decision and dependency block standing approval',async()=>{
 const {ApprovalPolicyStore}=await import('../src/approval-policy');
 const c={...config,approval:{mode:'ready-queue' as const,id:'queue',authorizedBy:'human',scope:['src/a.ts'],gitScope:'feature-pr' as const}};
 for(const [plan,dependency] of [[blockedPlan('May we publish the preview without Cloudflare Access?','security-scope'),null],[blockedPlan('',undefined,'DEV-9'),'DEV-9']] as any[]){
  const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
  await w.tick(c);f.completePlan('session-1',plan);new ApprovalPolicyStore(s).snapshot('p',new Set(['issue']));
  await w.tick(c);expect(f.sends.length).toBe(0);expect(s.get(id).state).toBe('awaiting_approval');
  if(dependency){const row=new (await import('../src/readiness')).readinessFor(s,id);expect(row.dependencies[0].ref).toBe('DEV-9');}
  s.close();
 }
});

test('needs-input and blocked-dependency worker receipts surface questions instead of awaiting_pr',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Missing exact DEV-9-approved sourcing wording'));
 let result=(await w.tick(config))[0];expect(result.state).toBe('needs_input');expect(result.questions[0].question).toContain('DEV-9-approved');
 expect(s.get(id).state).toBe('approved');expect(f.sends.length).toBe(1);
 const blocked=new Store(':memory:'),bf=new Fake(blocked),bw=new Workflow(blocked,bf),bid=blocked.enqueue('p','issue','spec');
 await bw.tick(config);bf.completePlan();await bw.tick(config);bw.approve(bid,blocked.get(bid).plan_hash,'human',['src/a.ts'],'supervised-host',ops);await bw.tick(config);
 bf.workerReceipt(workerBlock('blocked-dependency',undefined,'DEV-9'));
 result=(await bw.tick(config))[0];expect(result.state).toBe('blocked_dependency');expect(result.dependencies[0].ref).toBe('DEV-9');
 const {recordResolution}=await import('../src/readiness');
 recordResolution(blocked,bid,'dependency-satisfied','Alice','DEV-9 is approved and complete');
 expect((await bw.resume(bid,config)).state).toBe('continuation_delivery_accepted');
 s.close();blocked.close();
});

test('a captured plan replacement cannot reuse an earlier readiness receipt',async()=>{
 const {s,f,w,id}=await planned();
 const replacement='Replacement plan.\n\n### Questions\n- Which approved copy should be used?\n\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"needs-input","questions":[{"id":"q1","question":"Which approved copy should be used?","kind":"requirement"}],"dependencies":[],"risks":[]} -->\n';
 const next=s.propose(id,replacement);
 expect(()=>w.approve(id,next,'human',['src/a.ts'],'supervised-host',ops)).toThrow('unresolved');
 expect(()=>w.approve(id,next,'human',['src/a.ts'],'supervised-host',ops,undefined,{readiness:true})).toThrow('unresolved');
 expect(w.planning(id).state).toBe('awaiting_approval');expect(f.sends.length).toBe(0);s.close();
});

test('a resolved plan blocker does not resurface during PR grace, but changed readiness does',async()=>{
 const {recordResolution}=await import('../src/readiness');
 const c={...config,workflow:{prGraceMs:0}};
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 await w.tick(c);f.completePlan('session-1',blockedPlan('Which stable product/listing identifier?'));
 await w.tick(c);recordResolution(s,id,'human-answer','Alice','Use SKU-42');
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(c);f.finishImplementation();f.sessions.get('session-1').session.prs=[];
 expect((await w.tick({...config,workflow:{prGraceMs:60000}}))[0].state).toBe('awaiting_pr');
 s.db.query('UPDATE plan_readiness SET questions=? WHERE job=?').run(JSON.stringify([{id:'q1',question:'A new security decision',kind:'security-scope'}]),id);
 expect((await w.tick(c))[0].state).toBe('needs_input');
 s.close();
});

test('worker-reported failure becomes an explicit blocker without resending',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('failed'));
 const result=(await w.tick(config))[0];expect(result.state).toBe('failed');expect(result.reason).toContain('Stopped before edits');
 expect(f.sends.length).toBe(1);s.close();
});

test('PR metadata grace expires into an explicit reconciliation reason',async()=>{
 const c={...config,workflow:{prGraceMs:0}};const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(c);f.finishImplementation();f.sessions.get('session-1').session.prs=[];
 const result=(await w.tick(c))[0];expect(result.state).toBe('needs_reconciliation');expect(result.reason).toContain('grace period');expect(f.sends.length).toBe(1);s.close();
});

test('legacy session without structured output is classified conservatively after grace',async()=>{
 const c={...config,workflow:{prGraceMs:0}};const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 await w.tick(c);f.legacyPlan();
 await w.tick(c);w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops,undefined,{readiness:true});
 s.db.query('DELETE FROM plan_readiness WHERE job=?').run(id);
 await w.tick(c);f.workerReceipt('Completed without a status receipt.');f.sessions.get('session-1').session.prs=[];
 const result=(await w.tick(c))[0];expect(result.state).toBe('needs_input');expect(result.source).toBe('legacy-plan');expect(result.confidence).toBe('low');
 expect(result.questions[0].question).toContain('product/listing identifier');s.close();
});

test('PR metadata grace begins when completion is observed, not when the turn started',async()=>{
 const {s,f,w,id,hash}=await planned();const grace={...config,workflow:{prGraceMs:60000}};w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 const e=f.sessions.get('session-1');expect((await w.executionStatus(id,e,grace,1000)).state).toBe('implementation_running');
 f.finishImplementation();e.session.prs=[];
 const waiting=await w.executionStatus(id,e,grace,91000);expect(waiting.state).toBe('awaiting_pr');expect(waiting.graceDeadline).toBe(151000);
 expect((await w.executionStatus(id,e,grace,151001)).state).toBe('needs_reconciliation');expect(f.sends.length).toBe(1);s.close();
});

test('guarded resume requires current resolution, resends no original request and is single-shot',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Missing stable product ID'));await w.tick(config);
 await expect(w.resume(id,config)).rejects.toThrow('human answer');
 recordResolution(s,id,'human-answer','Alice','Product ID SKU-42 confirmed');
 const before=f.sends.length;
 const attempts=await Promise.allSettled([w.resume(id,config),w.resume(id,config)]);
 expect(attempts.filter(x=>x.status==='fulfilled').length).toBe(1);
 const result=(attempts.find(x=>x.status==='fulfilled') as any).value;
 expect(result.state).toBe('continuation_delivery_accepted');expect(f.sends.length).toBe(before+1);
 expect(f.sends.at(-1).prompt).toContain('GUARDED CONTINUATION');expect(f.sends.at(-1).prompt).not.toContain('ADLC APPROVED IMPLEMENTATION');
 expect(f.sends.at(-1).clientId).not.toBe(w.implementation(id).client_id);
 s.db.query("UPDATE worker_outcomes SET outcome='needs_input' WHERE job=?").run(id);
 f.sessions.get('session-1').transcript.controller='ready';
 await expect(w.resume(id,config)).rejects.toThrow('already in flight');
 expect(f.sends.length).toBe(before+1);s.close();
});

test('failed continuation requires exact reviewed delivery recovery before another resume',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();try{
  w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
  f.workerReceipt(workerBlock('needs-input','Which listing ID?'));await w.tick(config);
  recordResolution(s,id,'human-answer','Alice','SKU-42');
  s.db.query('INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,?)').run(id,hash,digest(s.get(id).spec),'old-resolution','continue-failed','session-1','failed');
  await expect(w.resume(id,config)).rejects.toThrow('exact reviewed delivery recovery required');
  expect(f.sends).toHaveLength(1);
 }finally{s.close();}
});
test('changed requirements or stale answers invalidate resume authorization',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Which copy is approved?'));await w.tick(config);
 recordResolution(s,id,'human-answer','Alice','Use the approved copy');
 s.db.query("UPDATE plan_readiness SET questions=? WHERE job=?").run(JSON.stringify([{id:'q1',question:'New security decision',kind:'security-scope'}]),id);
 await expect(w.resume(id,config)).rejects.toThrow('human answer');
 recordResolution(s,id,'human-answer','Alice','Use the approved copy');
 s.db.query("UPDATE worker_outcomes SET questions=? WHERE job=?").run(JSON.stringify([{id:'w2',question:'A new worker question',kind:'requirement'}]),id);
 await expect(w.resume(id,config)).rejects.toThrow('human answer');
 s.enqueue('p','issue','materially changed requirements');
 await expect(w.resume(id,config)).rejects.toThrow('replan after material changes');expect(f.sends.length).toBe(1);s.close();
});

test('uncertain continuation send is never resent',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Which listing ID?'));await w.tick(config);
 recordResolution(s,id,'human-answer','Alice','SKU-42');
 f.loseSend=true;const first=await w.resume(id,config);expect(first.state).toBe('continuation_delivery_uncertain');
 f.sessions.get('session-1').transcript.controller='ready';
 await expect(w.resume(id,config)).rejects.toThrow('never resend');
 recordResolution(s,id,'human-answer','Alice','A newer answer recorded after the uncertain send');
 await expect(w.resume(id,config)).rejects.toThrow('never resend');
 expect(f.sends.length).toBe(2);s.close();
});
test('a resolved legacy plan blocker does not resurface after PR grace',async()=>{
 const {recordResolution}=await import('../src/readiness');
 const c={...config,workflow:{prGraceMs:0}};
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 await w.tick(c);f.legacyPlan();await w.tick(c);
 recordResolution(s,id,'human-answer','Alice','Identifier SKU-42 confirmed');
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(c);f.workerReceipt('Completed without a status receipt.');f.sessions.get('session-1').session.prs=[];
 const result=(await w.tick(c))[0];
 expect(result.state).toBe('needs_reconciliation');expect(result.questions).toEqual([]);
 s.close();
});
test('acknowledgement alone does not hide concrete legacy questions',async()=>{
 const c={...config,workflow:{prGraceMs:0}};
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 await w.tick(c);f.legacyPlan();await w.tick(c);
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops,undefined,{readiness:true});
 await w.tick(c);f.workerReceipt('Completed without a status receipt.');f.sessions.get('session-1').session.prs=[];
 const result=(await w.tick(c))[0];
 expect(result.state).toBe('needs_input');expect(result.questions[0].question).toContain('product/listing identifier');
 s.close();
});
test('legacy questions require a human answer, not acknowledgement or dependency evidence',async()=>{
 const {recordResolution}=await import('../src/readiness');
 const c={...config,workflow:{prGraceMs:0}};
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 await w.tick(c);f.legacyPlan();await w.tick(c);
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops,undefined,{readiness:true});
 await w.tick(c);f.workerReceipt('Completed without a status receipt.');f.sessions.get('session-1').session.prs=[];
 expect((await w.tick(c))[0].state).toBe('needs_input');
 recordResolution(s,id,'dependency-satisfied','Alice','DEV-9 is complete');
 expect((await w.tick(c))[0].state).toBe('needs_input');
 recordResolution(s,id,'human-answer','Alice','Identifier SKU-42 confirmed');
 expect((await w.tick(c))[0].questions).toEqual([]);
 s.close();
});
test('resume rechecks approval inside the reservation transaction',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Which listing ID?'));await w.tick(config);
 recordResolution(s,id,'human-answer','Alice','SKU-42');
 const original=f.evidence.bind(f);let revoked=false;
 f.evidence=async(session:string)=>{if(!revoked){revoked=true;s.db.query("UPDATE jobs SET state='blocked',approved_hash=NULL WHERE id=?").run(id);}return original(session);};
 await expect(w.resume(id,config)).rejects.toThrow('approval revoked');
 expect(f.sends.length).toBe(1);s.close();
});
test('the reservation transaction refuses an in-flight continuation even if the pre-check was stale',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Which listing ID?'));await w.tick(config);
 recordResolution(s,id,'human-answer','Alice','SKU-42');
 s.db.query("INSERT INTO continuations(job,plan_hash,spec_hash,binding,client_id,session_id,state) VALUES (?,?,?,?,?,?,'delivery_uncertain')")
  .run(id,s.get(id).plan_hash,digest(s.get(id).spec),'manual-binding','manual-client','session-1');
 const original=(w as any).unresolvedContinuation.bind(w);let calls=0;
 (w as any).unresolvedContinuation=(job:string,plan:string)=>{calls++;return calls===1?null:original(job,plan);};
 await expect(w.resume(id,config)).rejects.toThrow('never duplicate a resume delivery');
 expect(f.sends.length).toBe(1);s.close();
});

test('blocked-by-dependency plans still require human answers for non-dependency questions',async()=>{
 const {recordResolution}=await import('../src/readiness');
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 const plan=JSON.stringify({version:1,readiness:'blocked-by-dependency',questions:[{id:'q1',question:'May we change access?',kind:'security-scope'}],dependencies:[{ref:'DEV-9',reason:'Upstream wording'}],risks:[]});
 await w.tick(config);f.completePlan('session-1',plan);await w.tick(config);
 recordResolution(s,id,'dependency-satisfied','Alice','DEV-9 complete');
 expect(()=>w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops)).toThrow('unresolved');
 recordResolution(s,id,'human-answer','Alice','Access scope approved');
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops);
 s.close();
});
test('acknowledgement cannot satisfy a structured blocker at approval',async()=>{
 const {recordResolution}=await import('../src/readiness');
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 await w.tick(config);f.completePlan('session-1',blockedPlan('Which approved copy?'));
 await w.tick(config);
 recordResolution(s,id,'human-acknowledgement','Alice','Acknowledged legacy readiness');
 expect(()=>w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops)).toThrow('unresolved');
 recordResolution(s,id,'human-answer','Alice','Use the approved copy');
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops);
 s.close();
});
test('resume rejects a busy worker and a different configured project',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Which listing ID?'));await w.tick(config);
 recordResolution(s,id,'human-answer','Alice','SKU-42');
 expect(()=>w.resume(id,{...config,linear:{projectId:'other'}})).toThrow('Job project does not match');
 f.sessions.get('session-1').transcript.controller='busy';
 await expect(w.resume(id,config)).rejects.toThrow('Worker is not idle');
 expect(f.sends.length).toBe(1);s.close();
});
test('dependency-only plans cannot mask worker requirement or security questions',async()=>{
 const {recordResolution}=await import('../src/readiness');
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f),id=s.enqueue('p','issue','spec');
 await w.tick(config);
 f.completePlan('session-1',JSON.stringify({version:1,readiness:'blocked-by-dependency',questions:[],dependencies:[{ref:'DEV-9',reason:'Upstream wording'}],risks:[]}));
 await w.tick(config);recordResolution(s,id,'dependency-satisfied','Alice','DEV-9 complete');
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(`<!-- ADLC_WORKER_STATUS ${JSON.stringify({version:1,outcome:'needs-input',reason:'Security decision needed',questions:[{id:'w1',question:'May we change access?',kind:'security-scope'}],dependencies:[]})} -->`);
 await w.tick(config);recordResolution(s,id,'dependency-satisfied','Alice','DEV-9 complete again');
 await expect(w.resume(id,config)).rejects.toThrow('human answer');
 recordResolution(s,id,'human-answer','Alice','Access scope approved');
 expect((await w.resume(id,config)).state).toBe('continuation_delivery_accepted');s.close();
});
test('blocked-dependency worker outcomes still require answers for non-dependency questions',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('blocked-dependency','Which requirement applies?','DEV-9'));await w.tick(config);
 recordResolution(s,id,'dependency-satisfied','Alice','DEV-9 complete');
 await expect(w.resume(id,config)).rejects.toThrow('human answer');
 recordResolution(s,id,'human-answer','Alice','Requirement chosen');
 expect((await w.resume(id,config)).state).toBe('continuation_delivery_accepted');s.close();
});
test('worker outcome questions require the same applicable resolution sources as plans',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Which security decision applies?'));await w.tick(config);
 recordResolution(s,id,'human-acknowledgement','Alice','Acknowledged only');
 await expect(w.resume(id,config)).rejects.toThrow('human answer');
 recordResolution(s,id,'dependency-satisfied','Alice','Dependency done');
 await expect(w.resume(id,config)).rejects.toThrow('human answer');
 recordResolution(s,id,'human-answer','Alice','Use the approved decision');
 expect((await w.resume(id,config)).state).toBe('continuation_delivery_accepted');
 s.close();
});
test('read-only preview tolerates a base-schema database without blocker tables',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-preview-base-'));try{
  const path=join(dir,'state.sqlite'),s=new Store(path),p=new Planning(s),id=s.enqueue('p','issue','spec');new Lifecycle(s);
  s.db.exec(`CREATE TABLE IF NOT EXISTS implementation_dispatch(job TEXT PRIMARY KEY REFERENCES jobs(id),plan_hash TEXT NOT NULL,session_id TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,paths TEXT NOT NULL,runtime TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT);`);
  p.reserve(id,'project');const r=p.get(id);p.gate(id,'project','session',r.branch,'/worktrees/session');
  s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);
  s.db.query("UPDATE jobs SET state='approved',plan='plan',plan_hash=?,approved_hash=?,actor='human' WHERE id=?").run(digest(JSON.stringify(['spec','plan'])),digest(JSON.stringify(['spec','plan'])),id);
  const hash=s.get(id).plan_hash;
  s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(id,hash,'session','client','delivery_accepted','["src/**"]','supervised-host','human',null);
  s.db.query('INSERT INTO runs(job,correlation,plan_hash,state,session_id,worktree,owner) VALUES (?,?,?,?,?,?,?)').run(id,'correlation',hash,'running','session','/worktrees/session','orchestrator');
  const tables=s.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[];
  s.close();
  const before=readFileSync(path);
  const evidence={session:{id:'session',projectId:'project',branch:r.branch,isTerminated:false,prs:[]},transcript:{controller:'ready',entries:[{sequence:2,kind:'message',role:'user',clientMessageId:'client',turnId:'turn'}],turns:[{id:'turn',state:'completed'}]}};
  const transport:any={evidence:async()=>evidence,worktree:async()=>({branch:r.branch,head:'a'.repeat(40)}),disableFeedback:async()=>{},sendImplementation:async()=>{}};
  const ro=new Store(path,true),w=new Workflow(ro,transport,undefined,true);
  const preview=await w.previewReconcile({repo:'/repo',linear:{projectId:'p'},requiredChecks:['CI'],githubRepo:'owner/repo',workflow:{prGraceMs:0}});
  expect(preview.results[0].state).not.toBe('unavailable');ro.close();
  expect(readFileSync(path).equals(before)).toBe(true);
  const after=(()=>{const check=new Store(path,true);try{return check.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as any[];}finally{check.close();}})();
  expect(after).toEqual(tables);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('preview reports an existing PR handoff instead of a false blocker',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);f.finishImplementation();
 const preview=await w.previewReconcile(config);
 expect(preview.results[0].state).toBe('pr_handoff');expect(preview.results[0].pr?.number).toBe(1);
 s.close();
});
test('read-only reconciliation preview does not modify the state database',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-preview-'));try{
  const path=join(dir,'state.sqlite'),{s,f,w,id,hash}=await planned(path);w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
  await w.tick(config);f.finishImplementation();s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');s.close();
  const before=readFileSync(path);
  const ro=new Store(path,true),readonly=new Workflow(ro,f,undefined,true);f.s=ro;
  const preview=await readonly.previewReconcile(config);
  expect(preview.results[0].state).toBe('pr_handoff');ro.close();
  expect(readFileSync(path).equals(before)).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('preview reconciliation exposes the three reported blockers without applying repairs',async()=>{
 const cases=[
  ['DEV-6','May we publish repository-only preview metadata while Cloudflare Access changes remain out of scope?','security-scope'],
  ['DEV-10','Missing exact DEV-9-approved sourcing wording for the About story','requirement'],
  ['DEV-13','Missing stable product/listing identifier; confirm before renaming','requirement']
 ] as const;
 const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f);
 for(const [identifier,question] of cases){
  s.enqueue('p',identifier,JSON.stringify({identifier,title:identifier,description:`${identifier} requirements`}));
  await w.tick(config);
  const sid=`session-${f.starts.length}`;f.completePlan(sid);
  await w.tick(config);
  const row=s.db.query('SELECT job FROM planning_runs WHERE session_id=?').get(sid) as any;
  w.approve(row.job,s.get(row.job).plan_hash,'human',['src/a.ts'],'supervised-host',ops);
  await w.tick(config);
 }
 for(const [index,[identifier,question,kind]] of cases.entries()){
  const sid=`session-${index+1}`,e=f.sessions.get(sid);e.session.prs=[];
  e.transcript.entries.push({sequence:3,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'implementation',text:`<!-- ADLC_WORKER_STATUS ${JSON.stringify({version:1,outcome:'needs-input',reason:`${identifier} stopped before edits`,questions:[{id:'q1',question,kind}],dependencies:[]})} -->`});
  e.transcript.turns.find((x:any)=>x.id==='implementation').state='completed';
 }
 const before=s.db.query('SELECT job,state FROM implementation_dispatch ORDER BY job').all();
 const outcomeCount=s.db.query('SELECT count(*) AS n FROM worker_outcomes').get() as any;
 const preview=await w.previewReconcile(config);
 expect(preview.mode).toBe('preview_only');expect(preview.applied).toBe(false);expect(preview.results.length).toBe(3);
 for(const [identifier,question] of cases){
  const result=preview.results.find((x:any)=>x.issue===identifier) as any;
  expect(result.state).toBe('needs_input');expect(result.questions[0].question).toBe(question);
 }
 expect((s.db.query('SELECT count(*) AS n FROM worker_outcomes').get() as any).n).toBe(outcomeCount.n);
 expect(s.db.query('SELECT job,state FROM implementation_dispatch ORDER BY job').all()).toEqual(before);
 s.close();
});

test('blocked planning releases capacity only after authoritative completion without restoring eligibility',async()=>{
 for(const terminated of [false,true]){
  const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f);
  try{
   const id=s.enqueue('p','first','spec'),next=s.enqueue('p','next','spec');await w.startPlanning(id,config);
   s.db.query("UPDATE jobs SET state='blocked',reason='No longer eligible in Linear' WHERE id=?").run(id);
   await w.tick(config);expect(f.starts.length).toBe(1);expect(w.planning(id).state).toBe('planning');
   if(terminated)f.sessions.get('session-1').session.isTerminated=true;else f.completePlan();
   await w.tick(config);expect(w.planning(id).state).toBe('planning_finished');expect(w.planning(next).state).toBe('planning');
   expect(s.get(id).state).toBe('blocked');expect(s.get(id).plan_hash).toBeNull();expect(s.get(id).approved_hash).toBeNull();expect(f.sends).toEqual([]);
   await w.tick(config);expect(f.starts.length).toBe(2);
  }finally{s.close();}
 }
});

test('blocked uncertain reservations persist across restart until unique matching ended-session evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-blocked-plan-'));let s=new Store(join(dir,'db'));const f=new Fake(s);f.loseSpawn=true;
 try{
  let w=new Workflow(s,f);const id=s.enqueue('p','first','spec');s.enqueue('p','next','spec');await w.startPlanning(id,config);
  s.db.query('UPDATE planning_runs SET session_id=NULL WHERE job=?').run(id);
  s.db.query("UPDATE jobs SET state='blocked' WHERE id=?").run(id);s.close();s=new Store(join(dir,'db'));f.s=s;w=new Workflow(s,f);
  const find=f.findPlans.bind(f),e=f.sessions.get('session-1');f.completePlan();
  for(const matches of [[],[e.session,e.session]]){
   f.findPlans=async()=>matches;await w.tick(config);expect(f.starts.length).toBe(1);expect(w.planning(id).state).toBe('dispatch_uncertain');
  }
  f.findPlans=find;
  const originalEvidence=f.evidence.bind(f);
  for(const key of ['id','projectId','branch']){
   f.evidence=async(sid:string)=>{const r=await originalEvidence(sid);return {...r,session:{...r.session,[key]:'wrong'}};};
   const result=await w.tick(config);
   expect(result.find(x=>x.job===id)).toMatchObject({state:'needs_reconciliation',reason:'Blocked planning session identity mismatch'});
   expect(result.some(x=>x.error)).toBe(false);expect(f.starts.length).toBe(1);expect(w.planning(id).state).toBe('dispatch_uncertain');
  }
  f.evidence=originalEvidence;
  e.transcript.controller='busy';await w.tick(config);expect(f.starts.length).toBe(1);
  e.transcript.controller='ready';e.transcript.turns.push({id:'live',state:'running'});await w.tick(config);expect(f.starts.length).toBe(1);e.transcript.turns.pop();
  const text=e.transcript.entries[0].text;e.transcript.entries[0].text='Uncorrelated plan';await w.tick(config);expect(f.starts.length).toBe(1);e.transcript.entries[0].text=text;
  await w.tick(config);expect(w.planning(id).state).toBe('planning_finished');expect(f.starts.length).toBe(2);expect(f.sends).toEqual([]);expect(s.get(id).state).toBe('blocked');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});


test('finished planning remains released after eligibility re-enqueue and waits for explicit recovery',async()=>{
 for(const terminated of [false,true])for(const changed of [false,true]){
  const s=new Store(':memory:'),f=new Fake(s),w=new Workflow(s,f);
  try{
   const id=s.enqueue('p','first','spec');await w.startPlanning(id,config);
   s.db.query("UPDATE jobs SET state='blocked',reason='No longer eligible in Linear' WHERE id=?").run(id);
   if(terminated)f.sessions.get('session-1').session.isTerminated=true;else f.completePlan();
   await w.tick(config);expect(w.planning(id).state).toBe('planning_finished');
   s.enqueue('p','first',changed?'changed specification':'spec');expect(s.get(id).state).toBe('awaiting_plan');
   const next=s.enqueue('p','next','spec');
   f.evidence=async()=>{throw Error('Finished dispatch must not inspect its old session');};
   const result=await w.tick(config);
   expect(result.find(x=>x.job===id)).toMatchObject({state:'planning_finished'});
   expect(result.some(x=>x.error)).toBe(false);expect(w.planning(id).state).toBe('planning_finished');
   expect(w.planning(next).state).toBe('planning');expect(f.starts.length).toBe(2);
   await w.tick(config);expect(w.planning(id).state).toBe('planning_finished');expect(f.starts.length).toBe(2);
   expect(s.get(id).state).toBe('awaiting_plan');expect(s.get(id).plan_hash).toBeNull();expect(s.get(id).approved_hash).toBeNull();expect(f.sends).toEqual([]);
  }finally{s.close();}
 }
});

test('blocked captured plans retain their dispatch and can be recaptured after eligible re-enqueue',async()=>{
 const {s,f,w,id,hash}=await planned();
 try{
  const dispatch={...w.planning(id)},evidence=f.evidence.bind(f);let reads=0;
  s.db.query("UPDATE jobs SET state='blocked',reason='No longer eligible in Linear' WHERE id=?").run(id);
  f.evidence=async sid=>{reads++;return evidence(sid);};
  expect(await w.reconcileBlockedPlanning(id)).toEqual({state:'awaiting_approval'});expect(reads).toBe(0);
  const result=await w.tick(config);
  expect(result.some(x=>x.job===id)).toBe(false);expect(reads).toBe(0);expect(w.planning(id)).toEqual(dispatch);
  expect(s.get(id).state).toBe('blocked');expect(s.get(id).plan_hash).toBe(hash);expect(f.sends).toEqual([]);
  s.enqueue('p','issue',s.get(id).spec);expect(s.get(id).state).toBe('awaiting_plan');
  await w.tick(config);
  expect(reads).toBe(1);expect(w.planning(id).state).toBe('awaiting_approval');expect(s.get(id).state).toBe('awaiting_approval');
  expect(s.get(id).plan_hash).toBe(hash);expect(s.get(id).approved_hash).toBeNull();expect(f.starts.length).toBe(1);expect(f.sends).toEqual([]);
 }finally{s.close();}
});

// Real inventory transport path, but no host AO command or provider request.
function inventoryTransport(sessions:any[],omitBranch=false){
 const calls:string[][]=[];
 const spawn=((args:string[])=>{
  calls.push(args);
  const data=args[2]==='ls'?{data:sessions.map(s=>({id:s.id,projectId:s.projectId,...(omitBranch?{}:{branch:s.branch}),isTerminated:s.isTerminated}))}:{session:sessions.find(s=>s.id===args[3])};
  return {stdout:new Blob([JSON.stringify(data)]).stream(),stderr:new Blob([]).stream(),exited:Promise.resolve(0)};
 }) as any;
 return {calls,transport:createWorkflowTransport(async operation=>operation(),spawn)};
}

test('inventory transport includes terminated matches only when explicitly requested and retains ambiguity',async()=>{
 const ended={id:'ended',projectId:'project',branch:'branch',isTerminated:true};
 const rows=[ended,{id:'other-project',projectId:'elsewhere',branch:'branch',isTerminated:true},{id:'other-branch',projectId:'project',branch:'elsewhere',isTerminated:true}];
 const {calls,transport}=inventoryTransport(rows);
 expect(await transport.findPlans('project','branch')).toEqual([]);
 expect(await transport.findPlans('project','branch',true)).toEqual([ended]);
 expect(calls.filter(a=>a[2]==='ls').every(a=>a.includes('--include-terminated'))).toBe(true);
 rows.push({...ended,id:'another-ended'});
 expect((await transport.findPlans('project','branch',true)).length).toBe(2);
 expect(calls.filter(a=>a[2]==='get').map(a=>a[3])).toEqual(['ended','ended','another-ended']);
});

test('lost spawn reply then termination releases blocked capacity using recorded run or terminated inventory',async()=>{
 for(const recorded of [true,false]){
  const dir=mkdtempSync(join(tmpdir(),'adlc-terminated-spawn-'));let s=new Store(join(dir,'db'));const f=new Fake(s);f.loseSpawn=true;
  try{
   let w=new Workflow(s,f);const id=s.enqueue('p','first','spec'),next=s.enqueue('p','next','spec');
   await w.startPlanning(id,config);expect(w.planning(id).session_id).toBeNull();
   if(!recorded)s.db.query('UPDATE planning_runs SET session_id=NULL WHERE job=?').run(id);
   s.db.query("UPDATE jobs SET state='blocked' WHERE id=?").run(id);
   const ended=f.sessions.get('session-1').session;ended.isTerminated=true;
   const {calls,transport}=inventoryTransport([ended]);
   f.findPlans=recorded?async()=>{throw Error('Recorded planning-run identity must avoid inventory');}:transport.findPlans;
   s.close();s=new Store(join(dir,'db'));f.s=s;w=new Workflow(s,f);
   await w.tick(config);
   expect(w.planning(id).state).toBe('planning_finished');expect(w.planning(id).session_id).toBe('session-1');
   expect(w.planning(next).state).toBe('dispatch_uncertain');expect(f.starts.length).toBe(2);
   expect(s.get(id).state).toBe('blocked');expect(s.get(id).approved_hash).toBeNull();expect(f.sends).toEqual([]);
   expect(calls.length>0).toBe(!recorded);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
 }
});


test('inventory rows without branch metadata still fetch details and exclude mismatched branches',async()=>{
 const match={id:'matching',projectId:'project',branch:'branch',isTerminated:false};
 const rows=[match,{id:'unrelated-branch',projectId:'project',branch:'elsewhere',isTerminated:false},{id:'unrelated-project',projectId:'elsewhere',branch:'branch',isTerminated:false}];
 const {calls,transport}=inventoryTransport(rows,true);
 expect(await transport.findPlans('project','branch')).toEqual([match]);
 expect(calls.filter(a=>a[2]==='get').map(a=>a[3])).toEqual(['matching','unrelated-branch']);
});

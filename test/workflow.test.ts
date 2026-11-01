import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow,type WorkflowTransport} from '../src/workflow';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const config={repo:'/repo',githubRepo:'owner/repo',linear:{projectId:'p'},requiredChecks:['CI'],automation:{planningEnabled:true,orchestratorProject:'project',maxPlanning:1}};
const ops=['inspect','fetch','worktree','branch','commit','push-feature','open-pr'];
class Fake implements WorkflowTransport{
 starts:any[]=[];sends:any[]=[];sessions=new Map<string,any>();loseSpawn=false;loseSend=false;
 constructor(public s:Store){}
 async worktree(job:string){const r=this.s.db.query('SELECT branch FROM planning_runs WHERE job=?').get(job) as any;return {branch:r?.branch??this.starts[0].branch,head:'a'.repeat(40)};}
 async branchSnapshot(){return {branch:this.starts[0].branch,head:'a'.repeat(40),state:'open',draft:false,headRepo:'owner/repo',baseRepo:'owner/repo',defaultBranch:'main',baseBranch:'main'};}
 async startPlan(r:any){
  this.starts.push(r);const id=`session-${this.starts.length}`;
  const row=this.s.db.query('SELECT job FROM planning_runs WHERE branch=?').get(r.branch) as any;
  new Planning(this.s).gate(row.job,r.project,id,r.branch,`/worktrees/${id}`);
  this.sessions.set(id,{session:{id,projectId:r.project,branch:r.branch,isTerminated:false,prs:[]},transcript:{controller:'busy',entries:[],turns:[]}});
  if(this.loseSpawn)throw Error('Receipt lost');return {id};
 }
 async findPlans(project:string,branch:string){return [...this.sessions.values()].map(e=>e.session).filter(s=>s.projectId===project&&s.branch===branch);}
 async evidence(id:string){return this.sessions.get(id);}
 async disableFeedback(_id:string){}
 completePlan(id='session-1',readiness='{"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":["Ordinary non-blocking risk"]}'){
  const e=this.sessions.get(id),r=this.starts.find(r=>r.branch===e.session.branch);
  const marker=r.prompt.match(/<!-- ADLC_PLAN_READY:[a-f0-9]+ -->/)[0];
  e.transcript={controller:'ready',entries:[{sequence:1,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'plan',text:`${marker}\nChange src/a.ts; run lint; stop for approval.\n\n### Questions\n- None\n\n<!-- ADLC_PLAN_STATUS ${readiness} -->`}],turns:[{id:'plan',state:'completed'}]};
 }
 workerReceipt(text:string){
  const e=this.sessions.get('session-1');
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
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 const e=f.sessions.get('session-1');expect((await w.executionStatus(id,e,60000,1000)).state).toBe('implementation_running');
 f.finishImplementation();e.session.prs=[];
 const waiting=await w.executionStatus(id,e,60000,91000);expect(waiting.state).toBe('awaiting_pr');expect(waiting.graceDeadline).toBe(151000);
 expect((await w.executionStatus(id,e,60000,151001)).state).toBe('needs_reconciliation');expect(f.sends.length).toBe(1);s.close();
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
 await expect(w.resume(id,config)).rejects.toThrow();
 expect(f.sends.length).toBe(before+1);s.close();
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
 await expect(w.resume(id,config)).rejects.toThrow();expect(f.sends.length).toBe(1);s.close();
});

test('uncertain continuation send is never resent',async()=>{
 const {recordResolution}=await import('../src/readiness');const {s,f,w,id,hash}=await planned();
 w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 f.workerReceipt(workerBlock('needs-input','Which listing ID?'));await w.tick(config);
 recordResolution(s,id,'human-answer','Alice','SKU-42');
 f.loseSend=true;const first=await w.resume(id,config);expect(first.state).toBe('continuation_delivery_uncertain');
 await expect(w.resume(id,config)).rejects.toThrow('never resend');
 expect(f.sends.length).toBe(2);s.close();
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

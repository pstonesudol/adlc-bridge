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
 async worktree(){return {branch:this.starts[0].branch,head:'a'.repeat(40)};}
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
 completePlan(id='session-1'){
  const e=this.sessions.get(id),r=this.starts.find(r=>r.branch===e.session.branch);
  const marker=r.prompt.match(/<!-- ADLC_PLAN_READY:[a-f0-9]+ -->/)[0];
  e.transcript={controller:'ready',entries:[{sequence:1,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'plan',text:`${marker}\nChange src/a.ts; run lint; stop for approval.`}],turns:[{id:'plan',state:'completed'}]};
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
test('actual branch drift blocks even when native session has no PR metadata',async()=>{
 const {s,f,w,id,hash}=await planned();w.approve(id,hash,'human',['src/a.ts'],'supervised-host',ops);
 await w.tick(config);f.finishImplementation();f.sessions.get('session-1').session.prs=[];
 f.worktree=async()=>({branch:'unexpected',head:'a'.repeat(40)});
 const result=(await w.tick(config))[0];expect(result.displayStatus).toBe('Blocked — branch mismatch');expect(result.reason).toContain('unexpected');expect(f.sends.length).toBe(1);s.close();
});

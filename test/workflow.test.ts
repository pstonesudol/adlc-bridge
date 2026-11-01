import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow,type WorkflowTransport} from '../src/workflow';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const config={repo:'/repo',linear:{projectId:'p'},requiredChecks:['CI'],automation:{planningEnabled:true,orchestratorProject:'project',maxPlanning:1}};
const ops=['inspect','fetch','worktree','branch','commit','push-feature','open-pr'];
class Fake implements WorkflowTransport{
 starts:any[]=[];sends:any[]=[];sessions=new Map<string,any>();loseSpawn=false;loseSend=false;
 constructor(public s:Store){}
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

test('recovery restores only unchanged eligible standing authorization for an existing PR',async()=>{
 const {ApprovalPolicyStore}=await import('../src/approval-policy');
 const {s,f,w,id,hash}=await planned();
 const c={...config,githubRepo:'owner/repo',approval:{mode:'ready-queue' as const,id:'test',authorizedBy:'human',scope:['src/a.ts'],gitScope:'feature-pr' as const}};
 const policy=new ApprovalPolicyStore(s);policy.snapshot('p',new Set(['issue']));
 w.approve(id,hash,'standing-policy:test',['src/a.ts'],'supervised-host',ops,{project:'p',policy:c.approval});
 await w.tick(c);f.finishImplementation();
 s.db.query("UPDATE jobs SET state='awaiting_approval',approved_hash=NULL,actor=NULL WHERE id=?").run(id);
 const e=f.sessions.get('session-1');e.session.branch='wrong';
 await expect(w.recoverHandoff(id,c)).rejects.toThrow('identity');e.session.branch=f.starts[0].branch;
 policy.snapshot('p',new Set());await expect(w.recoverHandoff(id,c)).rejects.toThrow('snapshot');
 policy.snapshot('p',new Set(['issue']));expect((await w.recoverHandoff(id,c)).pr.number).toBe(1);
 expect(s.get(id).state).toBe('approved');expect(f.sends.length).toBe(1);s.close();
});

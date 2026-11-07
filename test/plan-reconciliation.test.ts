import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {capturePlan} from '../src/session-evidence';
import {PlanReconciliation} from '../src/plan-reconciliation';
import {assessPlan,readinessFor} from '../src/readiness';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(path=':memory:'){
 const s=new Store(path),spec={identifier:'DEV-73',title:'Current-head review',description:'Require approval on the current head'},job=s.enqueue('p','issue',JSON.stringify(spec));
 const c:any={repo:'/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},automation:{orchestratorProject:'ao'},requiredChecks:['CI']};
 const w=new Workflow(s,{startPlan:async()=>{throw Error('No spawn');},findPlans:async()=>[],evidence:async()=>e,disableFeedback:async()=>{},sendImplementation:async()=>{throw Error('No sends');}});
 const p=new Planning(s),r=p.reserve(job,'ao');p.gate(job,'ao','worker',r.branch,'/isolated');
 const marker=`<!-- ADLC_PLAN_READY:${r.correlation} -->`,plan=(dependencies:any[])=>`${marker}\nSame requirements and scoped implementation.\n<!-- ADLC_PLAN_STATUS ${JSON.stringify({version:1,readiness:'ready',questions:[],dependencies,risks:[]})} -->`;
 const e:any={receiptObservation:{complete:true,observed:Date.now()},session:{id:'worker',projectId:'ao',branch:r.branch,isTerminated:false},transcript:{controller:'ready',turns:[{id:'original',state:'completed'},{id:'corrected',state:'completed'}],entries:[{sequence:20,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'original',text:plan([{ref:'DEV-23',reason:'Design coordination'}])},{sequence:34,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'corrected',text:plan([])}]}};
 capturePlan(s,job,e,20);s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?,?,?,?)').run(job,digest(JSON.stringify(spec)),'awaiting_approval','worker',null,'planning');
 const issue:any={id:'issue',...spec,project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}};
 const recovery=new PlanReconciliation(s,w,async()=>issue,async op=>op());
 return {s,w,job,c,e,issue,recovery};
}
test('DEV-73 corrected sequence 34 replaces invalid same-spec receipt only on confirmation, preserving history',async()=>{
 const f=fixture();try{
  const before=f.s.get(f.job),preview=await f.recovery.preview(f.job,f.c,34);
  expect(readinessFor(f.s,f.job).valid).toBe(false);expect(f.s.get(f.job)).toEqual(before);
  const result=await f.recovery.reconcile(f.job,f.c,34,preview.confirmation);
  expect(result.approved).toBe(false);expect(f.s.get(f.job).state).toBe('awaiting_approval');expect(f.s.get(f.job).approved_hash).toBeNull();expect(readinessFor(f.s,f.job).state).toBe('ready');
  const history=f.s.db.query("SELECT detail FROM events WHERE job=? AND kind='same_spec_plan_superseded'").get(f.job) as any;
  expect(JSON.parse(history.detail).previous.j.plan).toBe(before.plan);expect(JSON.parse(history.detail).previous.readiness[0].valid).toBe(0);
  await expect(f.recovery.reconcile(f.job,f.c,34,preview.confirmation)).rejects.toThrow();
  expect(f.w.implementation(f.job)).toBeNull();
 }finally{f.s.close();}
});
test('replacement refuses busy, incomplete, stale, foreign, ambiguous or non-ready plan evidence',async()=>{
 const mutations=[
  (f:any)=>f.e.transcript.controller='busy',
  (f:any)=>f.e.transcript.turns.push({id:'queued',state:'queued'}),
  (f:any)=>f.e.transcript.turns[1].state='failed',
  (f:any)=>f.e.receiptObservation.complete=false,
  (f:any)=>f.e.receiptObservation.observed=0,
  (f:any)=>f.e.session.id='other',
  (f:any)=>f.e.session.branch='main',
  (f:any)=>f.e.transcript.entries.push({...f.e.transcript.entries[1]}),
  (f:any)=>f.e.transcript.entries[1].streaming=true,
  (f:any)=>f.e.transcript.entries[1].text='No receipt',
  (f:any)=>f.e.transcript.entries[1].text+='\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready"} -->',
  (f:any)=>f.issue.description='Changed requirements',
  (f:any)=>f.s.db.query("UPDATE planning_dispatch SET state='dispatch_uncertain' WHERE job=?").run(f.job),
  (f:any)=>f.s.db.query('INSERT INTO planning_delivery VALUES (?,?,?,?)').run(f.job,'worker','planning-turn','delivery_uncertain'),
  (f:any)=>f.s.db.query("INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)").run(f.job,f.s.get(f.job).plan_hash,'worker','execution','delivery_uncertain','["src/**"]','supervised-host','human',null),
  (f:any)=>f.s.approve(f.job,f.s.get(f.job).plan_hash,'human'),
 ];
 for(const mutate of mutations){const f=fixture();try{mutate(f);const before=f.s.get(f.job);await expect(f.recovery.preview(f.job,f.c,34)).rejects.toThrow();expect(f.s.get(f.job)).toEqual(before);}finally{f.s.close();}}
});
test('read-only preview and a restarted confirmer share the exact evidence without replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-plan-reconcile-')),path=join(dir,'state.sqlite'),f=fixture(path);f.s.close();
 let store:Store|undefined;
 try{
  store=Store.readonly(path);let w=new Workflow(store,f.w.t,undefined,true),recovery=new PlanReconciliation(store,w,async()=>f.issue,async op=>op());
  const preview=await recovery.preview(f.job,f.c,34);store.close();store=new Store(path);
  w=new Workflow(store,f.w.t);recovery=new PlanReconciliation(store,w,async()=>f.issue,async op=>op());
  await recovery.reconcile(f.job,f.c,34,preview.confirmation);expect(store.get(f.job).approved_hash).toBeNull();expect(readinessFor(store,f.job).state).toBe('ready');
  await expect(recovery.reconcile(f.job,f.c,34,preview.confirmation)).rejects.toThrow();
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('confirmation rejects changed spec, transcript, policy or route and concurrent confirmation applies once',async()=>{
 for(const mutate of [
  (f:any)=>f.s.enqueue('p','issue','new spec'),
  (f:any)=>f.e.transcript.entries[1].text+=' changed plan',
  (f:any)=>f.c.approval={mode:'manual'},
  (f:any)=>f.c.planApproval={scope:['other/**']},
  (f:any)=>f.s.db.query('INSERT INTO task_routes VALUES (?,?,?,?,?)').run(f.job,'implementation',digest(JSON.stringify([f.s.get(f.job).spec,f.s.get(f.job).plan_hash])),'{}','selected'),
 ]){const f=fixture();try{const p=await f.recovery.preview(f.job,f.c,34);mutate(f);await expect(f.recovery.reconcile(f.job,f.c,34,p.confirmation)).rejects.toThrow();}finally{f.s.close();}}
 const f=fixture();try{const p=await f.recovery.preview(f.job,f.c,34),results=await Promise.allSettled([f.recovery.reconcile(f.job,f.c,34,p.confirmation),f.recovery.reconcile(f.job,f.c,34,p.confirmation)]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((f.s.db.query("SELECT count(*) AS n FROM events WHERE kind='same_spec_plan_superseded'").get() as any).n).toBe(1);}finally{f.s.close();}
});
test('coordination references require explicit nonblocking semantics; legacy dependencies remain blocking',()=>{
 const plan=(dependencies:any[],readiness='ready')=>`<!-- ADLC_PLAN_STATUS ${JSON.stringify({version:1,readiness,questions:[],dependencies,risks:[]})} -->`;
 expect(assessPlan(plan([{ref:'DEV-23',reason:'Coordination',blocking:false}])).state).toBe('ready');
 for(const blocking of [true,undefined]){const result=assessPlan(plan([{ref:'DEV-23',reason:'Prerequisite',blocking}]));expect(result.valid).toBe(false);expect(result.reason).toContain('blocking:false');}
 expect(assessPlan(plan([{ref:'DEV-23',reason:'Coordination',blocking:'false'}])).valid).toBe(false);
 expect(assessPlan(plan([{ref:'DEV-23',reason:'Coordination',blocking:false}],'blocked-by-dependency')).valid).toBe(false);
});

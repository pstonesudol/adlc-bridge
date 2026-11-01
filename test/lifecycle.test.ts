import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {Lifecycle,type Session,type Transport} from '../src/lifecycle';
import {ReviewLoop} from '../src/review-loop';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function setup(path=':memory:'){
  const s=new Store(path);const l=new Lifecycle(s);const id=s.enqueue('p','i','spec');
  const hash=s.propose(id,'plan');s.approve(id,hash,'human');
  l.grantGit(id,hash,['inspect','fetch','worktree','branch'],'human');return {s,l,id,hash};
}
const receipt=(correlation:string):Session=>({id:'session-1',correlation,worktree:'/isolated/worktree',controller:'running'});
const runtime={isolated:true,hostVerified:true};

test('dispatch requires approved plan, scoped Git grant and validated runtime',async()=>{
  const {s,l,id,hash}=setup();let called=false;
  const t:Transport={start:async r=>{called=true;return receipt(r.correlation);}};
  await expect(l.dispatch(id,t,{isolated:false,hostVerified:false})).rejects.toThrow();
  expect(()=>l.grantGit(id,hash,['merge'],'human')).toThrow();
  expect(()=>l.grantGit(id,'stale',['branch'],'human')).toThrow();
  l.grantGit(id,hash,['inspect'],'human');await expect(l.dispatch(id,t,runtime)).rejects.toThrow();
  expect(called).toBe(false);s.close();
});
test('concurrent dispatch cannot start a second transport',async()=>{
  const {s,l,id}=setup();let calls=0;let finish!:(s:Session)=>void;let correlation='';
  const t:Transport={start:async r=>{calls++;correlation=r.correlation;return await new Promise<Session>(resolve=>finish=resolve);}};
  const first=l.dispatch(id,t,runtime);
  await expect(l.dispatch(id,t,runtime)).rejects.toThrow('Existing run');
  finish(receipt(correlation));await first;expect(calls).toBe(1);expect(l.run(id).state).toBe('running');s.close();
});
test('uncertain dispatch remains reserved after restart and cannot be resent',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'adlc-recovery-'));
  try{
    let {s,l,id}=setup(join(dir,'state.db'));
    await expect(l.dispatch(id,{start:async()=>{throw Error('lost receipt');}},runtime)).rejects.toThrow('uncertain');
    const correlation=l.run(id).correlation;s.close();s=new Store(join(dir,'state.db'));l=new Lifecycle(s);
    await expect(l.dispatch(id,{start:async r=>receipt(r.correlation)},runtime)).rejects.toThrow('Existing run');
    expect(()=>l.reconcile(id,[],false)).toThrow();
    expect(l.reconcile(id,[],true).state).toBe('needs_reconciliation');
    expect(l.reconcile(id,[receipt(correlation)],true).state).toBe('running');s.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('five persistent remediation reservations, duplicate findings do not spend twice',async()=>{
  const {s,l,id}=setup();await l.dispatch(id,{start:async r=>receipt(r.correlation)},runtime);
  const sha='a'.repeat(40);expect(l.reserveRemediation(id,sha,'fix one').attempt).toBe(1);
  expect(l.reserveRemediation(id,sha,'fix one').attempt).toBe(1);
  for(let i=2;i<=5;i++)expect(l.reserveRemediation(id,sha,`fix ${i}`).attempt).toBe(i);
  expect(l.reserveRemediation(id,sha,'sixth').blocked).toBe(true);
  expect(s.get(id).attempts).toBe(5);expect(s.get(id).state).toBe('blocked');s.close();
});
test('custom budget above five is used without clamping; uncapped mode still uses no-progress stops',async()=>{
 const custom=setup();await custom.l.dispatch(custom.id,{start:async r=>receipt(r.correlation)},runtime);
 const sha='b'.repeat(40),policy={maxAttempts:8,maxNoProgress:20,window:'job' as const};
 for(let i=1;i<=8;i++)expect(custom.l.reserveRemediation(custom.id,sha,`custom ${i}`,policy).attempt).toBe(i);
 expect(custom.l.reserveRemediation(custom.id,sha,'custom ninth',policy).blocked).toBe(true);
 expect(custom.l.budgetSummary(custom.id,policy)).toMatchObject({consumed:8,effectiveMaxAttempts:8,remaining:0,stopReason:'budget_exhausted'});
 custom.s.close();
 const uncapped=setup();await uncapped.l.dispatch(uncapped.id,{start:async r=>receipt(r.correlation)},runtime);
 const open={maxAttempts:null,maxNoProgress:20,window:'job' as const};
 for(let i=1;i<=12;i++)expect(uncapped.l.reserveRemediation(uncapped.id,sha,`open ${i}`,open).attempt).toBe(i);
 expect(uncapped.l.budgetSummary(uncapped.id,open)).toMatchObject({uncapped:true,consumed:12,remaining:null});
 uncapped.s.close();
});

test('remediation budgets are isolated between jobs and uncapped mode still stops on no progress',async()=>{
 const s=new Store(':memory:'),l=new Lifecycle(s),sha='6'.repeat(40);
 const make=async(project:string,issue:string)=>{
  const id=s.enqueue(project,issue,'spec'),hash=s.propose(id,'plan');s.approve(id,hash,'human');
  l.grantGit(id,hash,['inspect','fetch','worktree','branch','commit','push-feature','open-pr'],'human');
  await l.dispatch(id,{start:async r=>({id:`session-${project}-${issue}`,correlation:r.correlation,worktree:'/isolated/worktree',controller:'running'})},runtime);return id;
 };
 const one=await make('p1','one'),two=await make('p2','two'),policy={maxAttempts:8,maxNoProgress:20,window:'job' as const};
 expect(l.reserveRemediation(one,sha,'one a',policy).attempt).toBe(1);
 expect(l.reserveRemediation(one,sha,'one b',policy).attempt).toBe(2);
 expect(l.reserveRemediation(two,sha,'two a',policy).attempt).toBe(1);
 expect(l.budgetSummary(one,policy).consumed).toBe(2);expect(l.budgetSummary(two,policy).consumed).toBe(1);
 s.close();
 const open=setup();await open.l.dispatch(open.id,{start:async r=>receipt(r.correlation)},runtime);
 const uncapped={maxAttempts:null,maxNoProgress:2,window:'job' as const};
 expect(open.l.reserveRemediation(open.id,sha,'open one',uncapped).attempt).toBe(1);
 expect(open.l.reserveRemediation(open.id,sha,'open two',uncapped).attempt).toBe(2);
 const stopped=open.l.reserveRemediation(open.id,sha,'open three',uncapped) as any;
 expect(stopped.blocked).toBe(true);expect(open.l.budgetSummary(open.id,uncapped).stopReason).toBe('no_progress_exhausted');open.s.close();
});

test('consecutive no-progress stops separately and verified progress resets only that counter',async()=>{
 const stuck=setup();await stuck.l.dispatch(stuck.id,{start:async r=>receipt(r.correlation)},runtime);
 const sha='c'.repeat(40),policy={maxAttempts:20,maxNoProgress:2,window:'job' as const};
 expect(stuck.l.reserveRemediation(stuck.id,sha,'one',policy).attempt).toBe(1);
 expect(stuck.l.reserveRemediation(stuck.id,sha,'two',policy).attempt).toBe(2);
 const blocked=stuck.l.reserveRemediation(stuck.id,sha,'three',policy) as any;
 expect(blocked.blocked).toBe(true);expect(blocked.reason).toContain('No-progress');
 expect(stuck.l.budgetSummary(stuck.id,policy)).toMatchObject({consumed:2,stopReason:'no_progress_exhausted'});
 stuck.s.close();
 const progress=setup();await progress.l.dispatch(progress.id,{start:async r=>receipt(r.correlation)},runtime);
 const p={maxAttempts:20,maxNoProgress:2,window:'job' as const},first='d'.repeat(40),next='e'.repeat(40);
 expect(progress.l.reserveRemediation(progress.id,first,'one',p).attempt).toBe(1);
 progress.s.db.query("UPDATE remediation SET state='completed' WHERE job=? AND attempt=1").run(progress.id);
 expect(progress.l.reserveRemediation(progress.id,next,'changed findings',p).attempt).toBe(2);
 expect(progress.l.budgetSummary(progress.id,p)).toMatchObject({consumed:2,noProgress:0,stopReason:null});
 expect(progress.l.reserveRemediation(progress.id,next,'another finding',p).attempt).toBe(3);
 expect(progress.l.budgetSummary(progress.id,p).noProgress).toBe(1);
 progress.s.close();
});

test('uncertain delivery blocks new reservations across heads and never spends a duplicate twice',async()=>{
 const {s,l,id}=setup();await l.dispatch(id,{start:async r=>receipt(r.correlation)},runtime);
 const first='f'.repeat(40),next='1'.repeat(40);
 expect(l.reserveRemediation(id,first,'fix one').attempt).toBe(1);
 s.db.query("UPDATE remediation SET state='delivery_uncertain' WHERE job=? AND attempt=1").run(id);
 const blocked=l.reserveRemediation(id,next,'new head findings') as any;
 expect(blocked.blocked).toBe(true);expect(blocked.reason).toContain('uncertain');
 expect(s.get(id).attempts).toBe(1);s.close();
});

test('budget state survives restart and duplicate findings do not spend again',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-budget-'));
 try{
  let {s,l,id}=setup(join(dir,'state.db'));const sha='2'.repeat(40);
  await l.dispatch(id,{start:async r=>receipt(r.correlation)},runtime);
  expect(l.reserveRemediation(id,sha,'fix one').attempt).toBe(1);
  expect(l.reserveRemediation(id,sha,'fix one').attempt).toBe(1);
  expect(l.budgetSummary(id).consumed).toBe(1);s.close();
  s=new Store(join(dir,'state.db'));l=new Lifecycle(s);
  const second=new Store(join(dir,'state.db'));
  expect(l.reserveRemediation(id,sha,'fix one').attempt).toBe(1);
  expect(new Lifecycle(second).reserveRemediation(id,sha,'fix one').attempt).toBe(1);
  expect(l.budgetSummary(id).consumed).toBe(1);second.close();
  expect(l.reserveRemediation(id,sha,'fix two').attempt).toBe(2);
  expect(l.budgetSummary(id)).toMatchObject({consumed:2,configuredMaxAttempts:5});s.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('lower limits apply on the next reservation without cancelling an in-flight worker',async()=>{
 const {s,l,id}=setup();await l.dispatch(id,{start:async r=>receipt(r.correlation)},runtime);
 const sha='3'.repeat(40),high={maxAttempts:8,maxNoProgress:20,window:'job' as const},low={maxAttempts:1,maxNoProgress:20,window:'job' as const};
 expect(l.reserveRemediation(id,sha,'one',high).attempt).toBe(1);
 l.recordRemediationPolicy(id,low);
 expect(l.run(id).state).toBe('running');expect(s.get(id).state).toBe('approved');expect(l.budgetPolicy(id)).toEqual(low);
 expect(l.reserveRemediation(id,sha,'two',low).blocked).toBe(true);
 expect(l.run(id).state).toBe('blocked');s.close();
});

test('exhausted budget requires a previewed, audited extension and does not replay history',async()=>{
 const {s,l,id,hash}=setup();await l.dispatch(id,{start:async r=>receipt(r.correlation)},runtime);
 l.grantGit(id,hash,['inspect','fetch','worktree','branch','commit','push-feature','open-pr'],'human');
 const loop=new ReviewLoop(s);loop.register(id,'owner/repo',1,['CI'],['src/**'],true);
 const sha='4'.repeat(40);s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(sha,id);
 const policy={maxAttempts:5,maxNoProgress:5,window:'job' as const};
 for(let i=1;i<=5;i++)expect(l.reserveRemediation(id,sha,`fix ${i}`,policy).attempt).toBe(i);
 expect(l.reserveRemediation(id,sha,'sixth',policy).blocked).toBe(true);
 expect(l.run(id).state).toBe('blocked');expect(s.get(id).state).toBe('blocked');
 const preview=l.extendRemediationBudget(id,{actor:'Human',additional:2,head:sha,policy,reason:'reviewed receipts'});
 expect(preview.preview).toBe(true);expect(l.budgetSummary(id,policy).extensions).toBe(0);
 const wrong=l.extendRemediationBudget(id,{actor:'Human',additional:2,head:sha,policy,confirm:'wrong'});
 expect(wrong.preview).toBe(true);expect(l.budgetSummary(id,policy).extensions).toBe(0);
 const applied=l.extendRemediationBudget(id,{actor:'Human',additional:2,head:sha,policy,reason:'reviewed receipts',confirm:preview.confirmHash});
 expect(applied.preview).toBe(false);expect(applied.budget).toMatchObject({extensions:2,effectiveMaxAttempts:7,consumed:5,remaining:2});
 expect(s.get(id).state).toBe('approved');expect(l.run(id).state).toBe('running');
 expect((s.db.query('SELECT count(*) AS n FROM remediation_budget_extensions WHERE job=?').get(id) as any).n).toBe(1);
 expect((s.db.query('SELECT count(*) AS n FROM remediation WHERE job=?').get(id) as any).n).toBe(5);
 expect(l.reserveRemediation(id,sha,'sixth',policy).attempt).toBe(6);
 expect(s.get(id).attempts).toBe(6);expect(l.budgetSummary(id,policy).consumed).toBe(6);s.close();
});

test('OpenChamber handoff requires stopped processes and revokes approval',async()=>{
  const {s,l,id}=setup();const run=await l.dispatch(id,{start:async r=>receipt(r.correlation)},runtime);
  expect(()=>l.takeHumanControl(id,receipt(run.correlation),false)).toThrow();
  const stopped={...receipt(run.correlation),controller:'stopped' as const};
  expect(l.takeHumanControl(id,stopped,true).owner).toBe('human');
  expect(s.get(id).approved_hash).toBeNull();
  expect(()=>l.reserveRemediation(id,'a'.repeat(40),'fix')).toThrow();
  expect(l.reconcile(id,[stopped],true).state).toBe('human_control');s.close();
});
test('approval revoked while dispatch is in flight cannot be marked running',async()=>{
  const {s,l,id}=setup();
  await l.dispatch(id,{start:async r=>{s.enqueue('p','i','new spec');return receipt(r.correlation);}},runtime);
  expect(l.run(id).state).toBe('needs_reconciliation');s.close();
});

test('supervised adoption matches reserved session and never enables new isolated dispatch',()=>{
 const s=new Store(':memory:');
 // Planning creates its own schema; the session receipt is pinned before adoption.
 s.db.exec('CREATE TABLE planning_runs(job TEXT,session_id TEXT,worktree TEXT,correlation TEXT)');
 const id=s.enqueue('p','i','spec'),hash=s.propose(id,'plan');s.approve(id,hash,'human');
 const l=new Lifecycle(s);s.db.query('INSERT INTO planning_runs VALUES (?,?,?,?)').run(id,'session','/worktree','correlation');
 expect(()=>l.adoptSupervised(id,{id:'other',worktree:'/worktree',correlation:'correlation',controller:'running'})).toThrow();
 const receipt={id:'session',worktree:'/worktree',correlation:'correlation',controller:'running' as const};
 expect(l.adoptSupervised(id,receipt).reason).toContain('containment not verified');
 expect(l.adoptSupervised(id,receipt).session_id).toBe('session');s.close();
});

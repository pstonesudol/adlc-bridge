import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {Lifecycle,type Session,type Transport} from '../src/lifecycle';
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

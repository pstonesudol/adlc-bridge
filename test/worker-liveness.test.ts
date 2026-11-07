import {test,expect,afterEach,setSystemTime} from 'bun:test';
import {incident} from './incidents/harness';
import {observeLiveness,livenessStatus} from '../src/worker-liveness';
import {ActionWatchdog,actionStatus,WATCHDOG_LIMITS} from '../src/action-watchdog';
import {ReceiptReconciliation} from '../src/receipt-reconciliation';
import {Store,digest} from '../src/core';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

afterEach(()=>setSystemTime());
const window=WATCHDOG_LIMITS.livenessMs;
function fixture(){
 setSystemTime(new Date('2026-01-01'));
 const f=incident();
 const observe=()=>{f.session.receiptObservation.observed=Date.now();return observeLiveness(f.s,f.id,f.session,f.evidence.head,window);};
 return {...f,observe,advance:(ms=window)=>setSystemTime(new Date(Date.now()+ms))};
}
test('closed classes: alive, busy, stuck; content progress restarts bounded silence without persisting content',()=>{
 const f=fixture();try{
  expect(f.observe().classification).toBe('alive');
  f.session.transcript.controller='running';f.session.transcript.turns=[{id:'turn',state:'running'}];
  expect(f.observe().classification).toBe('busy');f.advance(window-1);expect(f.observe().classification).toBe('busy');
  f.session.transcript.entries.push({sequence:1,text:'PRIVATE TRANSCRIPT'});expect(f.observe().classification).toBe('busy');
  f.advance();expect(f.observe().classification).toBe('stuck');
  expect(JSON.stringify(livenessStatus(f.s,f.id))).not.toContain('PRIVATE TRANSCRIPT');
  expect(livenessStatus(f.s,f.id)?.recoveryAttempts).toBe(0);
 }finally{f.s.close();}
});
for(const state of ['running','queued'])test(`${state} is never replaced or nudged after silence`,async()=>{
 const f=fixture();try{
  f.session.transcript.turns=[{id:'native-turn',state}];f.session.transcript.controller='running';
  expect((await f.loop.tick(f.id)).send).toBe(false);f.advance();
  for(let i=0;i<3;i++)expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false});
  expect(livenessStatus(f.s,f.id)).toMatchObject({classification:'stuck',turn:'native-turn',turnState:state});
  expect(f.calls).toEqual([]);f.assertSafe();
 }finally{f.s.close();}
});
test('idle accepted delivery with absent receipt waits then reconciles, retaining original receipt and no resend',async()=>{
 const f=fixture();try{
  const j=f.s.get(f.id),receipts=new ReceiptReconciliation(f.s);
  receipts.reserve({job:f.id,plan:j.plan_hash!,spec:digest(j.spec),session:'fake-session',client:'original',attempt:'implementation'});receipts.accepted('original');
  const before=receipts.get('original');
  f.evidence.clear=false;f.evidence.findings=[{path:'src/example.ts',body:'repair'}];
  expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_worker',send:false});
  expect(livenessStatus(f.s,f.id)?.classification).toBe('idle_no_delivery');
  f.advance();expect(await f.loop.tick(f.id)).toMatchObject({state:'needs_reconciliation',send:false});
  expect(receipts.get('original')).toEqual(before);expect(f.calls).toEqual([]);f.assertSafe();
 }finally{f.s.close();}
});
for(const kind of ['owner','stale','incomplete','turn','controller','reservation'])test(`unknown ${kind} evidence fails closed`,async()=>{
 const f=fixture();try{
  if(kind==='owner')f.session.session.id='other';
  if(kind==='stale')f.session.receiptObservation.observed-=120001;
  if(kind==='incomplete')f.session.receiptObservation.complete=false;
  if(kind==='turn')f.session.transcript.turns=[{id:'x',state:'invented'}];
  if(kind==='controller')f.session.transcript.controller='invented';
  if(kind==='reservation')f.s.db.query("UPDATE planning_runs SET worktree='/other' WHERE job=?").run(f.id);
  const result=observeLiveness(f.s,f.id,f.session,f.evidence.head,window);
  expect(result.classification).toBe('unknown');expect(f.calls).toEqual([]);
 }finally{f.s.close();}
});
test('watchdog records terminated escalation and retained cumulative budget across new bindings',async()=>{
 const f=fixture();try{
  f.s.db.query("UPDATE git_grants SET operations='[\"inspect\",\"commit\",\"push-feature\",\"open-pr\"]' WHERE job=?").run(f.id);
  const c={linear:{projectId:'incident'},githubRepo:'fixture/repo',automation:{orchestratorProject:'fake-project'}},w=new ActionWatchdog(f.s);
  f.session.session.projectId='fake-project';f.session.session.isTerminated=true;
  const a=w.scheduleReview(f.id,c);
  expect((await f.loop.tick(f.id,undefined,undefined,undefined,c,{watchdog:w,id:a.id})).state).toBe('observed');
  const result=await f.loop.tick(f.id);w.finishReview(a.id,result);
  expect(actionStatus(f.s,f.id)).toMatchObject({outcome:'worker_terminated',state:'escalated',liveness:{classification:'terminated',recoveryAttempts:0}});
  expect(w.due('incident',4,true)).toEqual([]);
  f.s.db.query('UPDATE watchdog_budgets SET attempts=max_attempts WHERE job=?').run(f.id);
  f.s.db.query("UPDATE review_targets SET head=?,state='waiting_for_worker' WHERE job=?").run('b'.repeat(40),f.id);
  expect(w.scheduleReview(f.id,c)).toMatchObject({state:'escalated',outcome:'budget_exhausted'});
  expect(w.due('incident',4,true)).toEqual([]);expect(f.s.get(f.id).attempts).toBe(0);expect(f.calls).toEqual([]);
  expect(f.loop.list()).toHaveLength(1);expect(f.loop.get(f.id)).toMatchObject({repo:'fixture/repo',pr:1});
 }finally{f.s.close();}
});
test('busy liveness backoff shares watchdog cadence and stops at the cumulative cap before another read',async()=>{
 const f=fixture();try{
  f.s.db.query("UPDATE git_grants SET operations='[\"inspect\",\"commit\",\"push-feature\",\"open-pr\"]' WHERE job=?").run(f.id);
  f.session.session.projectId='fake-project';f.session.transcript.controller='running';f.session.transcript.turns=[{id:'in-flight',state:'queued'}];
  f.evidence.clear=false;f.evidence.findings=[{path:'src/example.ts',body:'repair'}];
  const c={linear:{projectId:'incident'},githubRepo:'fixture/repo'},w=new ActionWatchdog(f.s),a=w.scheduleReview(f.id,c);
  for(const [age,delay] of [[0,1],[1,2],[3,4],[7,8],[15,15]]){
   setSystemTime(new Date(Date.parse('2026-01-01')+age*60000));
   const result=await f.loop.tick(f.id);w.finishReview(a.id,{...result,state:'waiting_for_worker'});
   expect(actionStatus(f.s,f.id)?.evaluation.next_tick-Date.now()).toBe(delay*60000);
  }
  f.s.db.query('UPDATE watchdog_budgets SET max_attempts=attempts+1 WHERE job=?').run(f.id);
  f.advance();const next=w.scheduleReview(f.id,c);
  await w.observeReview(next.id,c,f.loop.io);
  f.advance();expect(w.scheduleReview(f.id,c).outcome).toBe('budget_exhausted');
  let reads=0;await expect(w.observeReview(next.id,c,{sessionEvidence:async()=>{reads++;return f.session;},readBranchSnapshot:f.loop.io.readBranchSnapshot})).rejects.toThrow();
  expect(reads).toBe(0);expect(f.calls).toEqual([]);
 }finally{f.s.close();}
});
test('terminal delivery receipts are never replayed as a liveness recovery',async()=>{
 const f=fixture();try{
  const j=f.s.get(f.id),receipts=new ReceiptReconciliation(f.s),b={job:f.id,plan:j.plan_hash!,spec:digest(j.spec),session:'fake-session',client:'failed-send',attempt:'implementation'};
  receipts.reserve(b);f.session.transcript.entries=[{clientMessageId:b.client,turnId:'failed-turn'}];f.session.transcript.turns=[{id:'failed-turn',state:'failed'}];
  receipts.inspect(b,f.session);const before=receipts.get(b.client);
  f.evidence.clear=false;f.evidence.findings=[{path:'src/example.ts',body:'repair'}];
  for(let i=0;i<3;i++){await f.loop.tick(f.id);f.advance();}
  expect(receipts.get(b.client)).toEqual(before);expect(f.calls).toEqual([]);f.assertSafe();
 }finally{f.s.close();}
});
test('progress age survives a connection restart and read-only inspection is byte unchanged',()=>{
 const f=fixture(),dir=mkdtempSync(join(tmpdir(),'adlc-liveness-')),path=join(dir,'state.sqlite');let restarted:Store|undefined,readonly:Store|undefined;
 try{
  f.session.transcript.controller='running';f.session.transcript.turns=[{id:'original-turn',state:'running'}];
  const first=f.observe();f.s.db.query('VACUUM INTO ?').run(path);
  restarted=new Store(path);f.advance();f.session.receiptObservation.observed=Date.now();
  expect(observeLiveness(restarted,f.id,f.session,f.evidence.head,window)).toMatchObject({since:first.since,classification:'stuck',recoveryAttempts:0});
  restarted.close();restarted=undefined;const before=readFileSync(path);readonly=Store.readonly(path);
  expect(livenessStatus(readonly,f.id)?.classification).toBe('stuck');readonly.close();readonly=undefined;
  expect(readFileSync(path).equals(before)).toBe(true);expect(f.calls).toEqual([]);
 }finally{readonly?.close();restarted?.close();f.s.close();rmSync(dir,{recursive:true,force:true});}
});

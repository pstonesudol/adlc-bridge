/** DEV-78 incident acceptance matrix. Runner: bun test test/incidents
 * Includes DEV-88 restart/throttling measurement assertions; see README for coverage limits.
 * 1 duplicate/cancelled CI (#150): active DEV-77
 * 2 skipped current-head review + stale CHANGES_REQUESTED (#30): active DEV-65
 * 3 missing body-bound attestation: active DEV-70 (wait for provider evidence)
 * 4 repairable required CI: active DEV-80
 * 5 transient provider read/backoff: active DEV-56
 * 6 terminated/stuck worker: active DEV-83, safe human escalation, no resend
 * 7 uncertain worker receipt: active DEV-84;
 *   uncertain review-request receipt already runs as a separate safety case
 * 8 in-scope findings and human decision: active, never infer approval
 */
import {test,expect,setSystemTime,spyOn,afterEach} from 'bun:test';
import {reviewGate,type ReviewEvidence} from '../../src/core';
import {REVIEW_GRACE_MS} from '../../src/coderabbit-scheduling';
import {RecoveryObservation} from '../../src/recovery-observation';
import {readFailure} from '../../src/provider-read';
import {incident,seededRandom} from './harness';
import {ReviewLoop} from '../../src/review-loop';
import {projectMetrics} from '../../src/autonomy-metrics';

afterEach(()=>setSystemTime());
function clock(){setSystemTime(new Date('2026-01-01T00:00:00Z'));}
async function replay(run:(f:ReturnType<typeof incident>)=>Promise<void>){
 clock();
 const spawn=spyOn(Bun,'spawn').mockImplementation(()=>{throw Error('Incident attempted real process execution');});
 const spawnSync=spyOn(Bun,'spawnSync').mockImplementation(()=>{throw Error('Incident attempted real synchronous process execution');});
 const network=spyOn(globalThis,'fetch').mockImplementation(()=>{throw Error('Incident attempted network access');});
 const f=incident();try{await run(f);}finally{f.s.close();spawn.mockRestore();spawnSync.mockRestore();network.mockRestore();}
}

test('approved baseline is stable across repeated polling, with zero operator commands',()=>replay(async f=>{
 for(let i=0;i<3;i++)expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
 expect(f.calls).toEqual([]);f.assertSafe();
}));

test('DEV-88: restart preserves one durable reviewed handoff and zero rescue observations',()=>replay(async f=>{
 await f.loop.tick(f.id);
 const restarted=new ReviewLoop(f.s,f.loop.postReview,f.loop.io);
 for(let i=0;i<3;i++)expect((await restarted.tick(f.id)).state).toBe('ready_for_human');
 const report=projectMetrics(f.s,{since:'2026-01-01T00:00:00Z',until:'2026-01-01T00:01:00Z'},Date.now()+60000);
 expect(report.summary).toMatchObject({reviewedHandoffs:1,handoffsWithoutRecordedRescue:1,interventions:0});
 expect(report.jobs[0].provenance.filter(p=>p.category==='review')).toHaveLength(1);f.assertSafe();
}));

test('DEV-88: throttling survives reconstruction, honors cooldown, then records automatic recovery',()=>replay(async f=>{
 const original=f.loop.io.readBranchSnapshot;let reads=0;
 f.loop.io.readBranchSnapshot=async(...args)=>{if(++reads===1)throw readFailure('github','snapshot','HTTP 429',1);return original(...args);};
 await f.loop.tick(f.id);const status=new RecoveryObservation(f.s).status(f.id);
 const restarted=new ReviewLoop(f.s,f.loop.postReview,f.loop.io);
 await restarted.tick(f.id);expect(reads).toBe(1);
 setSystemTime(new Date(status.next_read));expect((await restarted.tick(f.id)).state).toBe('ready_for_human');
 const row=projectMetrics(f.s,{since:'2026-01-01T00:00:00Z',until:'2026-01-02T00:00:00Z'},Date.parse('2026-01-02T00:00:00Z')).jobs[0];
 expect(row.interventions).toBe(0);expect(row.retries.throttled).toBe(1);expect(row.recoveries[0]).toMatchObject({outcome:'success',durationMs:status.next_read-Date.parse('2026-01-01T00:00:00Z')});f.assertSafe();
}));

test('1 DEV-77: duplicate/cancelled CI run instances reach ready_for_human',()=>replay(async f=>{
 const check={name:'CI',sha:f.evidence.head,app:'github-actions',status:'completed',conclusion:'success'};
  const raw:ReviewEvidence={head:f.evidence.head,observedHead:f.evidence.head,required:['CI'],checks:[{...check,id:101,started_at:'2025-12-31T23:50:00Z',completed_at:'2025-12-31T23:51:00Z',conclusion:'cancelled'},{...check,id:102,started_at:'2025-12-31T23:52:00Z',completed_at:'2025-12-31T23:53:00Z'},{...check,name:'CodeRabbit',app:'coderabbitai'}],review:{sha:f.evidence.head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true};
  const gate=reviewGate(raw);expect(gate).toEqual({clear:true,reasons:[]});
 Object.assign(f.evidence,gate);expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');f.assertSafe();
}));

test('2 DEV-65: classified skipped current-head CodeRabbit + stale CHANGES_REQUESTED requests once, then accepts current approval',()=>replay(async f=>{
  const head=f.evidence.head;
  // Collector classification is covered separately; replay its output through
  // the real ReviewLoop request gate, not a fabricated clear=true transition.
  Object.assign(f.evidence,{clear:false,reasons:['Explicit latest-SHA CodeRabbit approval missing'],review:null,botReviewSubmittedAt:null,
   reviewSchedule:{head,signature:'stale-review-skipped-check',blocker:null,incremental:false,evidence:{
    classification:'stale-submitted-review',recoverable:true,
    review:{id:201,state:'CHANGES_REQUESTED',commit:'b'.repeat(40),submittedAt:Date.now()-60000,stale:true},
    check:{id:202,name:'CodeRabbit',status:'completed',conclusion:'skipped',startedAt:Date.now()-2000,completedAt:Date.now()-1000},
    runs:1,reviewedCommits:1,pauseThreshold:5,incremental:false,
   }}});
  expect(f.loop.get(f.id).remediate).toBe(1);
  expect(f.session.transcript.controller).toBe('ready');
  for(let i=0;i<2;i++)expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_coderabbit',send:false,head});
  expect(f.calls).toEqual([]);
  setSystemTime(new Date(Date.now()+REVIEW_GRACE_MS+1));
  expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_coderabbit',send:false,head});
  expect(f.calls.filter(c=>c.kind==='review-request')).toHaveLength(1);
  expect(f.loop.requests.get('fixture/repo',1,head)).toMatchObject({state:'accepted',attempts:1});
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
  setSystemTime(new Date(Date.now()+REVIEW_GRACE_MS+1));
  const review={sha:head,author:'coderabbitai[bot]',state:'APPROVED'};
  const gate=reviewGate({head,observedHead:head,required:['CI'],checks:[
   {name:'CI',sha:head,app:'github-actions',status:'completed',conclusion:'success'},
   {name:'CodeRabbit',sha:head,app:'coderabbitai',status:'completed',conclusion:'success'},
  ],review,unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true});
  expect(gate).toEqual({clear:true,reasons:[]});
  Object.assign(f.evidence,gate,{review,botReviewSubmittedAt:Date.now()});
  Object.assign(f.evidence.reviewSchedule.evidence,{classification:'current-review',recoverable:false,
   review:{id:203,state:'APPROVED',commit:head,submittedAt:Date.now(),stale:false},
   check:{id:204,name:'CodeRabbit',status:'completed',conclusion:'success',startedAt:Date.now()-1000,completedAt:Date.now()}});
  for(let i=0;i<3;i++)expect(await f.loop.tick(f.id)).toMatchObject({state:'ready_for_human',send:false,head});
  expect(f.calls).toHaveLength(1);expect(f.calls[0].kind).toBe('review-request');f.assertSafe();
}));

test('3 missing body-bound attestation waits, then accepts fresh attestation without operator commands',()=>replay(async f=>{
 f.loop.configureMetadataChecks('incident',['PR body structure']);
 expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_ci',send:false});
 expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_ci',send:false});
 f.evidence.metadataCheckEvidence=[{name:'PR body structure',checkId:1,sha:f.evidence.head,status:'completed',conclusion:'success',descriptionHash:f.evidence.descriptionHash}];
 setSystemTime(new Date(Date.now()+1000));f.evidence.botReviewSubmittedAt=Date.now()+1;
 expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');f.assertSafe();
}));

test('4 DEV-80: repair required CI using existing worker exactly once',()=>replay(async f=>{
 Object.assign(f.evidence,{clear:false,reasons:['Required CI failed'],failedChecks:[{name:'CI',sha:f.evidence.head,id:1,conclusion:'failure',url:'https://github.com/fixture/repo/actions/runs/1/job/1'}]});
 expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');
 expect(f.calls.filter(c=>c.kind==='send')).toHaveLength(1);
 for(let i=0;i<3;i++)expect((await f.loop.tick(f.id)).send).toBe(false);
 expect(f.calls.filter(c=>c.kind==='send')).toHaveLength(1);
 expect(f.s.get(f.id).attempts).toBe(1);
 f.complete();expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');f.assertSafe();
}));

test('5 transient provider failure persists seeded backoff, performs no early read, then recovers',()=>replay(async f=>{
 const random=spyOn(Math,'random').mockImplementation(seededRandom());
 try{
  let reads=0;const original=f.loop.io.readBranchSnapshot;
  f.loop.io.readBranchSnapshot=async(...args)=>{if(++reads===1)throw readFailure('github','snapshot','HTTP 503',1,undefined,Date.now());return original(...args);};
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_worker');
  const status=new RecoveryObservation(f.s).status(f.id);
  expect(status.failures).toBe(1);expect(status.next_read).toBeGreaterThan(Date.now());
  await f.loop.tick(f.id);expect(reads).toBe(1);
  setSystemTime(new Date(status.next_read));
  expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
  expect(new RecoveryObservation(f.s).status(f.id)).toBeNull();f.assertSafe();
 }finally{random.mockRestore();}
}));

for(const kind of ['terminated','stuck'])test(`6 DEV-83: ${kind} worker escalates without duplicate worker or send`,()=>replay(async f=>{
 f.session.session.isTerminated=kind==='terminated';f.session.transcript.controller=kind==='stuck'?'running':'ready';
 f.evidence.clear=false;f.evidence.findings=[{path:'src/example.ts',body:'Repair bounded finding'}];
  if(kind==='stuck')f.session.transcript.turns=[{id:'abandoned',state:'running'}];
  await f.loop.tick(f.id);
  setSystemTime(new Date(Date.now()+31*60000));
  for(let i=0;i<3;i++){
   const result=await f.loop.tick(f.id);
   expect(result).toMatchObject({state:'blocked',send:false});
   expect(result.reason).toContain(`Worker ${kind}`);
   expect(result.reason).toContain('fake-session');
   expect(result.reason).toContain('/incident-worktree');
  }
  expect(f.calls).toEqual([]);f.assertSafe();
}));

test('7 DEV-84: lost worker reply reconciles accepted/running/completed receipt with exactly one send',()=>replay(async f=>{
 Object.assign(f.evidence,{clear:false,reasons:['CHANGES_REQUESTED'],findings:[{path:'src/example.ts',body:'Fix null handling'}]});
 const spawn=f.io.spawn;f.io.spawn=(args:string[])=>({...spawn(args),exited:Promise.resolve(1)});
 expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');
 const entry=f.session.transcript.entries[0],turn=f.session.transcript.turns[0];
 f.session.transcript.entries=[];
 expect(await f.loop.tick(f.id)).toMatchObject({state:'needs_reconciliation',delivery:{code:'receipt_absent'}});
 f.session.transcript.entries=[entry];
 const read=f.loop.io.sessionEvidence;
 f.loop.io.sessionEvidence=async()=>{f.session.receiptObservation={complete:false,observed:Date.now()-120001};return f.session;};
 expect(await f.loop.tick(f.id)).toMatchObject({state:'needs_reconciliation',delivery:{code:'observation_stale_or_incomplete'}});
 f.loop.io.sessionEvidence=read;
 delete entry.turnId;f.session.transcript.turns=[];
 expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_worker',delivery:{state:'accepted',code:'client_accepted_unconfirmed'}});
 entry.turnId=turn.id;f.session.transcript.turns=[turn];
 for(const state of ['queued','running']){turn.state=state;expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_worker',delivery:{state}});}
 f.complete();f.evidence.clear=false;f.evidence.findings=[];f.evidence.reasons=['Explicit latest-SHA CodeRabbit approval missing'];
 expect((await f.loop.tick(f.id)).state).not.toBe('ready_for_human');
 setSystemTime(new Date(Date.now()+31*60000));f.evidence.clear=true;
 for(let n=0;n<3;n++)expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
 expect(f.calls.filter(c=>c.kind==='send')).toHaveLength(1);
   expect(f.s.db.query('SELECT state FROM remediation WHERE job=?').get(f.id)).toEqual({state:'completed'});
   expect(f.s.get(f.id).attempts).toBe(1);f.assertSafe();
   const measured=projectMetrics(f.s,{since:'2026-01-01T00:00:00Z',until:'2026-01-02T00:00:00Z'},Date.parse('2026-01-02T00:00:00Z')).jobs[0];
   expect(measured.interventions).toBe(0);expect(measured.handoff).not.toBeNull();expect(measured.retries.worker_remediation).toBe(1);
   const row=projectMetrics(f.s,{since:'2026-01-01T00:00:00Z',until:'2026-01-02T00:00:00Z'},Date.parse('2026-01-02T00:00:00Z')).jobs[0];
   expect(row.interventions).toBe(0);expect(row.handoff).not.toBeNull();expect(row.retries.worker_remediation).toBe(1);
}));

test('7 safety: lost review-request reply reconciles matching receipt without duplicate mutation',()=>replay(async f=>{
 Object.assign(f.evidence,{clear:false,reasons:['Explicit latest-SHA CodeRabbit approval missing'],reviewSchedule:{head:f.evidence.head,signature:'config',blocker:null,incremental:false}});
 await f.loop.tick(f.id);setSystemTime(new Date(Date.now()+6*60*1000));
 let marker='';f.loop.postReview=async(_repo,_pr,value)=>{marker=value!;f.calls.push({kind:'review-request',key:marker});throw Error('lost reply');};
 await expect(f.loop.tick(f.id)).rejects.toThrow('lost reply');
 expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');
 f.evidence.requestComments=[{id:42,author:'fixture-bot',body:`@coderabbitai full review\n\n${marker}`,created:new Date(Date.now()+1).toISOString()}];
 expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
 f.evidence.clear=true;f.evidence.botReviewSubmittedAt=Date.now()+2;
 expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
 expect(f.calls).toHaveLength(1);f.assertSafe();
}));

test('8 in-scope CHANGES_REQUESTED never clears until worker repair and fresh approval',()=>replay(async f=>{
 Object.assign(f.evidence,{clear:false,reasons:['CHANGES_REQUESTED'],findings:[{path:'src/example.ts',body:'Fix null handling'}]});
 expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');
 expect(f.calls.filter(c=>c.kind==='send')).toHaveLength(1);
 expect((await f.loop.tick(f.id)).state).not.toBe('ready_for_human');
 f.complete();expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');f.assertSafe();
}));

test('8 human-only decision stays blocked; exactly one explicit operator decision is recorded',()=>replay(async f=>{
 Object.assign(f.evidence,{clear:false,reasons:['CHANGES_REQUESTED'],reviewThreads:{humanOnly:[{threadId:'human',path:'src/example.ts'}],stale:[]}});
 for(let i=0;i<3;i++)expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false});
 expect(f.calls).toEqual([]);f.assertSafe();
 // Count an explicit human action, not a poll or a notification. It does not
 // fabricate approval or change production state: the job must remain stopped.
 f.operator('human decision required: choose compatibility policy');
 expect((await f.loop.tick(f.id)).state).toBe('blocked');f.assertSafe(1);
}));

test('safety: out-of-scope findings stop and PR/scope rebinding is rejected',()=>replay(async f=>{
 Object.assign(f.evidence,{clear:false,reasons:['CHANGES_REQUESTED'],findings:[{path:'secrets/config.ts',body:'Expand permission scope'}]});
 expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false});
 expect(()=>f.loop.register(f.id,'fixture/repo',2,['CI'],['src/example.ts'],true)).toThrow();
 expect(()=>f.loop.register(f.id,'fixture/repo',1,['CI'],['**'],true)).toThrow();
 expect(f.calls).toEqual([]);f.assertSafe();
}));

/** DEV-78 incident acceptance matrix. Runner: bun test test/incidents
 * 1 duplicate/cancelled CI (#150): skip DEV-77
 * 2 skipped current-head review + stale CHANGES_REQUESTED (#30): todo DEV-65
 * 3 missing body-bound attestation: active DEV-70 (wait for provider evidence)
 * 4 repairable required CI: skip later CI-remediation ticket (not assigned yet)
 * 5 transient provider read/backoff: active DEV-56
 * 6 terminated/stuck worker: skip later liveness ticket (not assigned yet)
 * 7 uncertain worker receipt: skip later receipt ticket (not assigned yet);
 *   uncertain review-request receipt already runs as a separate safety case
 * 8 in-scope findings and human decision: active, never infer approval
 */
import {test,expect,setSystemTime,spyOn,afterEach} from 'bun:test';
import {reviewGate,type ReviewEvidence} from '../../src/core';
import {latestWorkflowChecks} from '../../src/check-runs';
import {RecoveryObservation} from '../../src/recovery-observation';
import {readFailure} from '../../src/provider-read';
import {incident,seededRandom} from './harness';

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

test.skip('1 DEV-77: duplicate/cancelled CI run instances reach ready_for_human',()=>replay(async f=>{
 const check={name:'CI',sha:f.evidence.head,app:'github-actions',status:'completed',conclusion:'success'};
 const raw:ReviewEvidence={head:f.evidence.head,observedHead:f.evidence.head,required:['CI'],checks:[{...check,conclusion:'cancelled'},check,{...check,name:'CodeRabbit',app:'coderabbitai'}],review:{sha:f.evidence.head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true};
 const gate=reviewGate({...raw,checks:latestWorkflowChecks(raw.checks)});
 Object.assign(f.evidence,gate);expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');f.assertSafe();
}));

test.todo('2 DEV-65: replay skipped current-head CodeRabbit + stale CHANGES_REQUESTED through injected collector, request once, approve current head');

test('3 missing body-bound attestation waits, then accepts fresh attestation without operator commands',()=>replay(async f=>{
 f.loop.configureMetadataChecks('incident',['PR body structure']);
 expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_ci',send:false});
 expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_ci',send:false});
 f.evidence.metadataCheckEvidence=[{name:'PR body structure',checkId:1,sha:f.evidence.head,status:'completed',conclusion:'success',descriptionHash:f.evidence.descriptionHash}];
 setSystemTime(new Date(Date.now()+1000));f.evidence.botReviewSubmittedAt=Date.now()+1;
 expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');f.assertSafe();
}));

test.skip('4 later CI-remediation ticket (unassigned): repair required CI using existing worker',()=>replay(async f=>{
 Object.assign(f.evidence,{clear:false,reasons:['Required CI failed'],failedChecks:[{name:'CI',sha:f.evidence.head,id:1}]});
 expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');
 expect(f.calls.filter(c=>c.kind==='send')).toHaveLength(1);
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

for(const kind of ['terminated','stuck'])test.skip(`6 later liveness ticket (unassigned): ${kind} worker recovers without operator`,()=>replay(async f=>{
 f.session.session.isTerminated=kind==='terminated';f.session.transcript.controller=kind==='stuck'?'running':'ready';
 f.evidence.clear=false;f.evidence.findings=[{path:'src/example.ts',body:'Repair bounded finding'}];
 await f.loop.tick(f.id);
 // Future production recovery must establish a live worker before this step.
 expect(f.calls.filter(c=>c.kind==='send')).toHaveLength(1);
 f.complete();expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');f.assertSafe();
}));

test.todo('7 later receipt ticket (unassigned): uncertain worker send reconciles accepted/completed receipt, reaches ready_for_human with exactly one send');

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

import {test,expect,setSystemTime,afterEach} from 'bun:test';
import {classifyCIFailure,readCIFailure,remediationFingerprint} from '../src/ci-failures';
import {Lifecycle} from '../src/lifecycle';
import {incident} from './incidents/harness';
import {ActionWatchdog,WATCHDOG_LIMITS} from '../src/action-watchdog';
import {readFailure,ReadValidationError} from '../src/provider-read';
import {RecoveryObservation} from '../src/recovery-observation';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

afterEach(()=>setSystemTime());
const scope=['src/example.ts'];
const log='FAIL src/example.ts\nAssertionError: expected true';
const check=(head:string)=>({id:1,sha:head,name:'CI',conclusion:'failure',url:'https://github.com/fixture/repo/actions/runs/2/job/3'});
function failed(){const f=incident();Object.assign(f.evidence,{clear:false,reasons:['Required CI failed'],failedChecks:[check(f.evidence.head)]});return f;}

for(const [text,classification] of [
 [log,'repairable'],['src/example.ts(1,1): error TS1234: invalid type','repairable'],
 ['FAIL src/example.ts\nHTTP 503','transient'],['FAIL src/example.ts\nPermission denied','unauthorized'],
 ['FAIL other/file.ts\nAssertionError','out_of_scope'],['FAIL src/example.ts\nCVE-2026-123','out_of_scope'],
 ['Process exited with code 1','unknown'],[null,'unknown'],['x'.repeat(128*1024+1),'unknown'],
] as const)test(`classifier ${classification}: ${text?.slice(0,45)}`,()=>{
 const result=classifyCIFailure(text,scope);expect(result.classification).toBe(classification);
 expect(JSON.stringify(result)).not.toContain('AssertionError');
});

test('log reader binds job, run, SHA, check identity and conclusion before reading logs',async()=>{
 const c=check('a'.repeat(40));
 const job={id:3,run_id:2,head_sha:c.sha,name:'CI',status:'completed',conclusion:'failure',check_run_url:'https://api.github.com/repos/fixture/repo/check-runs/1'};
 for(const change of [{},{id:4},{run_id:9},{head_sha:'b'.repeat(40)},{name:'other'},{conclusion:'cancelled'},{check_run_url:'wrong'}]){
  const reads:string[]=[];
  const result=await readCIFailure('fixture/repo',c,async path=>{reads.push(path);return path.endsWith('/logs')?log:JSON.stringify({...job,...change});});
  if(Object.keys(change).length)expect(classifyCIFailure(result,scope)).toMatchObject({classification:'unknown',reason:expect.stringContaining('provenance mismatch')});else expect(result).toBe(log);
  expect(reads.length).toBe(Object.keys(change).length?1:2);
 }
 expect(await readCIFailure('fixture/repo',{...c,url:'https://evil.test/fixture/repo/actions/runs/2/job/3'},async()=>{throw Error('must not read');})).toBeNull();
});

test('concurrent evaluations and repeated polls send once, retain owned session and receipts',async()=>{
 const f=failed();try{
  const owned=new Lifecycle(f.s).run(f.id);
  await Promise.all([f.loop.tick(f.id),f.loop.tick(f.id)]);
  for(let i=0;i<4;i++)await f.loop.tick(f.id);
  expect(f.calls.filter(x=>x.kind==='send')).toHaveLength(1);
  expect(f.s.get(f.id).attempts).toBe(1);
  expect(new Lifecycle(f.s).run(f.id)).toEqual(owned);
  expect(f.s.db.query('SELECT state FROM remediation').all()).toEqual([{state:'delivery_uncertain'}]);
  f.complete();expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
  f.assertSafe();
 }finally{f.s.close();}
});

for(const [text,classification] of [['HTTP 503','transient'],['Permission denied','unauthorized'],['FAIL other/file.ts\nAssertionError','out_of_scope'],['no evidence','unknown']] as const)test(`${classification} never sends and names check; transient eventually escalates`,async()=>{
 setSystemTime(new Date('2026-01-01'));
 const f=failed();try{
  f.loop.io.readCIFailure=async()=>text;
  const result=await f.loop.tick(f.id);
  expect(result.send).toBe(false);expect(result.reason).toContain(`CI (#1, ${f.evidence.head}): ${classification}`);
  expect(result.state).toBe(classification==='transient'?'waiting_for_ci':'blocked');
  setSystemTime(new Date(Date.now()+31*60000));expect((await f.loop.tick(f.id)).state).toBe('blocked');
  expect(f.calls).toEqual([]);expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.s.close();}
});

test('missing authorization and stale/ambiguous/cancelled identities fail closed',async()=>{
 for(const kind of ['grant','stale','duplicate','cancelled','pending']){
  const f=failed();try{
   if(kind==='grant')f.s.db.query("UPDATE git_grants SET operations='[]' WHERE job=?").run(f.id);
   if(kind==='stale')f.evidence.failedChecks[0].sha='b'.repeat(40);
   if(kind==='duplicate')f.evidence.failedChecks.push({...f.evidence.failedChecks[0],id:2});
   if(kind==='cancelled')f.evidence.failedChecks[0].conclusion='cancelled';
   if(kind==='pending')f.evidence.pendingChecks=['CI'];
   expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.calls).toEqual([]);
  }finally{f.s.close();}
 }
});

test('identity changing during diagnosis never sends',async()=>{
 const f=failed();try{
  f.loop.io.readCIFailure=async()=>{f.evidence.failedChecks=[{...check(f.evidence.head),id:9}];return log;};
  expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.calls).toEqual([]);
 }finally{f.s.close();}
});

test('every failed check is classified; a transient cannot hide a human-only blocker',async()=>{
 const f=failed();try{
  f.evidence.failedChecks.push({...check(f.evidence.head),name:'Security',id:2});
  const reads:string[]=[];
  f.loop.io.readCIFailure=async(_repo,c)=>{reads.push(c.name);return c.name==='CI'?'HTTP 503':'CVE-2026-123';};
  const result=await f.loop.tick(f.id);expect(result.state).toBe('blocked');
  expect(result.reason).toContain('CI (#1');expect(result.reason).toContain('Security (#2');
  expect(result.reason).toContain('out_of_scope');expect(reads).toEqual(['CI','Security']);expect(f.calls).toEqual([]);
 }finally{f.s.close();}
});

test('same CI signature on new heads/run IDs consumes existing no-progress budget',async()=>{
 const f=failed(),policy={maxAttempts:10,maxNoProgress:2,window:'job' as const};try{
  for(let i=0;i<3;i++){
   const result=await f.loop.tick(f.id,undefined,policy);
   if(i<2){expect(result.state).toBe('remediation_pending');f.complete();f.evidence.clear=false;f.evidence.head=String(i+4).repeat(40);f.evidence.failedChecks=[{...check(f.evidence.head),id:i+2}];}
   else{expect(result.state).toBe('blocked');expect(result.reason).toContain('CI: No-progress');}
  }
  expect(f.calls.filter(x=>x.kind==='send')).toHaveLength(2);expect(f.s.get(f.id).attempts).toBe(2);
 }finally{f.s.close();}
});

test('fingerprint excludes volatile CI identity, but not stable diagnosis',()=>{
 const a={source:'required-ci',check:'CI',signature:'fixed',paths:scope,sha:'a',checkId:1};
 expect(remediationFingerprint(JSON.stringify([a]))).toBe(remediationFingerprint(JSON.stringify([{...a,sha:'b',checkId:2}])));
 expect(remediationFingerprint(JSON.stringify([a]))).not.toBe(remediationFingerprint(JSON.stringify([{...a,signature:'other'}])));
});

test('total remediation budget exhaustion names the CI check and never sends again',async()=>{
 const f=failed(),policy={maxAttempts:1,maxNoProgress:5,window:'job' as const};try{
  await f.loop.tick(f.id,undefined,policy);f.complete();
  f.evidence.clear=false;f.evidence.failedChecks=[check(f.evidence.head)];
  const result=await f.loop.tick(f.id,undefined,policy);
  expect(result.state).toBe('blocked');expect(result.reason).toContain('Required CI CI: Remediation budget exhausted');
  expect(f.calls.filter(x=>x.kind==='send')).toHaveLength(1);
 }finally{f.s.close();}
});

test('sender reclassification fails closed before spending budget; raw diagnostics never persist',async()=>{
 const f=failed();try{
  f.io.readCIFailure=async()=> 'Permission denied SECRET_SENTINEL_PROVIDER_BODY';
  const result=await f.loop.tick(f.id);
  expect(result).toMatchObject({state:'blocked',send:false});expect(result.reason).toContain('CI (#1): unauthorized');
  expect(f.calls).toEqual([]);expect(f.s.get(f.id).attempts).toBe(0);
  const events=f.s.db.query('SELECT * FROM events').all();
  expect(JSON.stringify(events)).not.toContain('SECRET_SENTINEL');
 }finally{f.s.close();}
});

test('watchdog observation schedules existing evaluator only; transient backoff shares its due ledger',async()=>{
 setSystemTime(new Date('2026-01-01'));
 const f=failed(),root=mkdtempSync(join(tmpdir(),'dev80-watchdog-'));
 try{
  const j=f.s.get(f.id);new Lifecycle(f.s).grantGit(f.id,j.plan_hash,['inspect','commit','push-feature','open-pr'],'fixture-human');
  f.session.session.projectId='fake-project';
  const c={linear:{projectId:'incident'},githubRepo:'fixture/repo',approval:{mode:'manual'}};
  const w=new ActionWatchdog(f.s,Date.now,()=>0.5,root),a=w.scheduleReview(f.id,c);
  expect(a.state).toBe('pending');expect(w.beginReview(a.id,c)).toBe(true);
  expect((await f.loop.tick(f.id,undefined,undefined,undefined,c,{watchdog:w,id:a.id})).state).toBe('observed');
  expect(f.calls).toEqual([]);expect(f.s.get(f.id).attempts).toBe(0);
  const result=await f.loop.tick(f.id,undefined,undefined,undefined,c);w.finishReview(a.id,result);
  expect(result.state).toBe('remediation_pending');expect(f.calls.filter(x=>x.kind==='send')).toHaveLength(1);
  expect(w.due('incident')).toEqual([]);expect(f.s.db.query('SELECT * FROM watchdog_budgets').all()).toHaveLength(1);
  f.complete();f.evidence.clear=false;f.evidence.failedChecks=[check(f.evidence.head)];f.loop.io.readCIFailure=async()=> 'HTTP 503';
  const wait=await f.loop.tick(f.id);expect(wait.state).toBe('waiting_for_ci');
  const b=w.scheduleReview(f.id,c);w.finishReview(b.id,wait);
  const evaluation:any=f.s.db.query('SELECT * FROM watchdog_evaluations WHERE job=?').get(f.id);
  expect(evaluation.next_tick).toBe(Date.now()+WATCHDOG_LIMITS.intervalMs);
  // Lifetime history must not accelerate a new head's first transient wait.
  f.s.db.query('UPDATE watchdog_actions SET attempts=100 WHERE id=?').run(b.id);
  f.s.db.query('UPDATE watchdog_budgets SET attempts=100 WHERE job=?').run(f.id);
  for(const [age,delay] of [[0,1],[1,2],[3,4],[7,8],[15,15]]){
   setSystemTime(new Date(f.loop.get(f.id).head_since+age*60000));
   const transient=await f.loop.tick(f.id);expect(transient.state).toBe('waiting_for_ci');
   w.finishReview(b.id,transient);
   const next:any=f.s.db.query('SELECT * FROM watchdog_evaluations WHERE job=?').get(f.id);
   expect(next.next_tick).toBe(Date.now()+delay*60000);
  }
  f.evidence.head='d'.repeat(40);f.evidence.failedChecks=[check(f.evidence.head)];
  const newWait=await f.loop.tick(f.id),newAction=w.scheduleReview(f.id,c);w.finishReview(newAction.id,newWait);
  expect(newAction.id).not.toBe(b.id);expect(newAction.attempts).toBe(100);
  expect((f.s.db.query('SELECT next_tick FROM watchdog_evaluations WHERE job=?').get(f.id) as any).next_tick).toBe(Date.now()+WATCHDOG_LIMITS.intervalMs);
  f.evidence.failedChecks=[];f.evidence.pendingChecks=['CI'];
  setSystemTime(new Date(Date.now()+15*60000));
  const pending=await f.loop.tick(f.id);w.finishReview(newAction.id,pending);
  expect(pending.state).toBe('waiting_for_ci');
  expect((f.s.db.query('SELECT next_tick FROM watchdog_evaluations WHERE job=?').get(f.id) as any).next_tick).toBe(Date.now()+WATCHDOG_LIMITS.intervalMs);
  expect(w.due('incident')).toEqual([]);expect(f.calls.filter(x=>x.kind==='send')).toHaveLength(1);
 }finally{f.s.close();rmSync(root,{recursive:true,force:true});}
});

for(const kind of ['server','authentication','capacity','validation'] as const)test(`post-diagnosis ${kind} read failure settles without charging evaluation failures`,async()=>{
 setSystemTime(new Date('2026-01-01'));
 const f=failed(),root=mkdtempSync(join(tmpdir(),'dev80-read-failure-'));
 try{
  const j=f.s.get(f.id);new Lifecycle(f.s).grantGit(f.id,j.plan_hash,['inspect','commit','push-feature','open-pr'],'fixture-human');
  const c={linear:{projectId:'incident'},githubRepo:'fixture/repo',approval:{mode:'manual'}};
  const w=new ActionWatchdog(f.s,Date.now,()=>0.5,root),a=w.scheduleReview(f.id,c);
  let reads=0;
  f.loop.io.readiness=async()=>{
   if(++reads===1)return f.evidence;
   if(kind==='validation')throw new ReadValidationError();
   throw readFailure('github','readiness',kind==='server'?'HTTP 503':'HTTP 401');
  };
  f.loop.io.readCIFailure=async()=>{
   if(kind==='capacity')f.s.db.query("INSERT INTO observation_capacity VALUES ('github',?)").run(Date.now()+60000);
   if(kind==='validation')f.s.db.query('INSERT INTO recovery_observations VALUES (?,1,?,?)').run(f.id,Date.now(),JSON.stringify({provider:'github',classification:'server'}));
   return log;
  };
  const result=await f.loop.tick(f.id);w.finishReview(a.id,result);
  expect(result).toMatchObject({state:['server','capacity'].includes(kind)?'waiting_for_worker':'blocked',head:f.evidence.head,send:false});
  expect(reads).toBe(kind==='capacity'?1:2);expect(f.calls).toEqual([]);expect(f.s.get(f.id).attempts).toBe(0);
  expect((f.s.db.query('SELECT failures FROM watchdog_evaluations WHERE job=?').get(f.id) as any).failures).toBe(0);
  expect(w.get(a.id).outcome).not.toBe('evaluation_failed');
  const observation=new RecoveryObservation(f.s).status(f.id);
  if(kind==='validation'||kind==='capacity')expect(observation).toBeNull();
  else expect(observation.evidence.classification).toBe(kind);
 }finally{f.s.close();rmSync(root,{recursive:true,force:true});}
});

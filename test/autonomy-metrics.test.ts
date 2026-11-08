import {test,expect,setSystemTime,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core';
import {projectMetrics,autonomyMetrics,metricsWindow} from '../src/autonomy-metrics';
import {RecoveryObservation} from '../src/recovery-observation';
import {readFailure} from '../src/provider-read';
const start=Date.parse('2026-01-01T00:00:00Z');
const window={since:'2026-01-01T00:00:00Z',until:'2026-01-02T00:00:00Z'};
const handoff=(s:Store,id:string)=>s.event(id,'review_state_changed',JSON.stringify({state:'ready_for_human',head:'a'.repeat(40),reason:'PRIVATE PROMPT'}));
afterEach(()=>setSystemTime());
test('durable handoff, expected actions, retries, censoring and version cohorts are explicit',()=>{
 setSystemTime(new Date(start));const s=new Store(':memory:');try{
 const id=s.enqueue('p','i','PRIVATE SPEC'),hash=s.propose(id,'PRIVATE PLAN');s.approve(id,hash,'PRIVATE ACTOR');
 s.event(id,'plan_readiness_resolved',JSON.stringify({source:'human-answer',answer:'PRIVATE ANSWER'}));
 s.event(id,'remediation_reserved',JSON.stringify({attempt:1}));s.event(id,'remediation_reserved',JSON.stringify({attempt:1}));handoff(s,id);
 s.event(id,'operator_read_retry','AFTER HANDOFF');
 const flight=s.enqueue('p','flight','PRIVATE');s.db.query("UPDATE jobs SET state='done' WHERE id=?").run(flight);
 const report=projectMetrics(s,window,start+86400000);
 expect(report.summary).toMatchObject({jobs:2,eligible:2,censored:1,reviewedHandoffs:1,handoffsWithoutRecordedRescue:1,proportion:.5,interventions:1});
 const row=report.jobs.find(j=>j.job===id)!;expect(row.humanActions).toBe(2);expect(row.retries.worker_remediation).toBe(1);expect(row.provenance.every(p=>p.attempt===0&&p.runtimeVersion==='0.6.0')).toBe(true);
 expect(report.jobs.find(j=>j.job===flight)!.status).toBe('closed_without_handoff_evidence');expect(JSON.stringify(report)).not.toContain('PRIVATE');
 s.db.query("UPDATE event_provenance SET runtime_version='0.5.0' WHERE seq=(SELECT MIN(seq) FROM events WHERE job=?)").run(id);
 expect(projectMetrics(s,window,start+86400000).versions.map(v=>v.version)).toContain('mixed');
 }finally{s.close();}
});
test('legacy, tampered and unknown events never produce a success claim',()=>{
 setSystemTime(new Date(start));const s=new Store(':memory:');try{
 const id=s.enqueue('p','i','spec');handoff(s,id);
 s.db.query('DELETE FROM event_provenance WHERE seq=(SELECT MIN(seq) FROM events)').run();
 s.event(id,'PRIVATE_UNRECOGNIZED_EVENT','PRIVATE');
 let r=projectMetrics(s,window,start+86400000);expect(r.summary.proportion).toBeNull();expect(r.jobs[0]).toMatchObject({missingProvenance:1,unknownEvents:1,coverage:'incomplete'});expect(JSON.stringify(r)).not.toContain('PRIVATE');
 s.db.query("UPDATE events SET detail='tampered' WHERE kind='review_state_changed'").run();r=projectMetrics(s,window,start+86400000);expect(r.jobs[0].handoff).toBeNull();
 }finally{s.close();}
});
test('provider retries retain history, successful read recovery duration, invalidation and open waits',()=>{
 setSystemTime(new Date(start));const s=new Store(':memory:');try{
 const id=s.enqueue('p','i','spec'),o=new RecoveryObservation(s,()=>Date.now(),()=>0);
 o.failed(id,readFailure('github','snapshot','HTTP 429',1));setSystemTime(new Date(start+60000));o.failed(id,readFailure('github','snapshot','HTTP 429',1));setSystemTime(new Date(start+120000));o.clear(id);
 o.failed(id,readFailure('github','snapshot','HTTP 503',1));setSystemTime(new Date(start+130000));o.clear(id,false);
 o.failed(id,readFailure('github','snapshot','HTTP 503',1));
 const row=projectMetrics(s,window,start+86400000).jobs[0];expect(row.retries).toEqual({throttled:2,server:2});expect(row.recoveries.map(r=>r.outcome)).toEqual(['success','invalidated','censored']);expect(row.recoveries[0].durationMs).toBe(120000);expect(row.interventions).toBe(0);
 expect((s.db.query('SELECT COUNT(*) AS n FROM events').get() as any).n).toBe(7);
 }finally{s.close();}
});
test('operator retry is not automatic recovery and reports cannot mutate or create state',()=>{
 const root=mkdtempSync(join(tmpdir(),'metrics-'));try{
 setSystemTime(new Date(start));const path=join(root,'state.sqlite'),s=new Store(path),id=s.enqueue('p','i','PRIVATE SPEC');
 const o=new RecoveryObservation(s);o.failed(id,readFailure('github','snapshot','HTTP 503'));o.retry(id);s.event(id,'operator_read_retry','PRIVATE REASON');handoff(s,id);s.close();
 const before=readFileSync(path),r=autonomyMetrics(path,window,start+86400000);expect(r.summary.proportion).toBe(0);expect(r.jobs[0].recoveries[0].outcome).toBe('operator_interrupted');expect(readFileSync(path)).toEqual(before);
 const absent=join(root,'absent');expect(autonomyMetrics(absent,window,start+86400000).summary.proportion).toBeNull();expect(existsSync(absent)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('half-open cohort bounds, project selection and invalid timestamps fail closed',()=>{
 setSystemTime(new Date(start));const s=new Store(':memory:');try{
 s.enqueue('p','i','spec');s.enqueue('other','i','spec');setSystemTime(new Date(start+86400000));s.enqueue('p','late','spec');
 expect(projectMetrics(s,{...window,project:'p'},start+86400000).jobs).toHaveLength(1);
 for(const options of [{since:'2026-02-30T00:00:00Z'}, {since:window.until,until:window.since},{since:'2024-01-01T00:00:00Z',until:window.until}])expect(()=>metricsWindow(options,start+86400000)).toThrow();
 }finally{s.close();}
});
test('event scan bound rejects incomplete output rather than silently truncating',()=>{
 setSystemTime(new Date(start));const s=new Store(':memory:');try{
 const id=s.enqueue('p','i','spec'),insert=s.db.query('INSERT INTO events(job,kind,detail,at) VALUES (?,?,?,?)');
 s.db.transaction(()=>{for(let i=0;i<50000;i++)insert.run(id,'legacy','',new Date(start).toISOString());}).immediate();
 expect(()=>projectMetrics(s,window,start+86400000)).toThrow('Metrics event bound exceeded');
 }finally{s.close();}
});
test('event and provenance commit atomically and bind the current plan/attempt',()=>{
 const s=new Store(':memory:');try{
 const id=s.enqueue('p','i','spec'),hash=s.propose(id,'plan');s.db.query('UPDATE jobs SET attempts=3 WHERE id=?').run(id);s.event(id,'operator_read_retry','');
 expect(s.db.query('SELECT attempt,plan_hash FROM event_provenance ORDER BY seq DESC LIMIT 1').get()).toEqual({attempt:3,plan_hash:hash});
 const before=s.db.query('SELECT COUNT(*) AS n FROM events').get();
 s.db.exec("CREATE TRIGGER reject_provenance BEFORE INSERT ON event_provenance BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect(()=>s.event(id,'operator_read_retry','')).toThrow('fixture');expect(s.db.query('SELECT COUNT(*) AS n FROM events').get()).toEqual(before);
 }finally{s.close();}
});
test('permanent provider observation stops recovery without manufacturing success',()=>{
 setSystemTime(new Date(start));const s=new Store(':memory:');try{
 const id=s.enqueue('p','i','spec'),o=new RecoveryObservation(s);o.failed(id,readFailure('github','snapshot','HTTP 401',1));
 const report=projectMetrics(s,window,start+86400000);expect(report.summary.automaticRecovery).toMatchObject({failure:1,success:0,censored:0,meanTimeToRecoveryMs:null});expect(report.jobs[0].current.blocker).toBe('external_provider');
 }finally{s.close();}
});

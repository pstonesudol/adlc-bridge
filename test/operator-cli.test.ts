import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core';
import {RecoveryObservation} from '../src/recovery-observation';
import {readFailure} from '../src/provider-read';
import {resolveJob,jobViews} from '../src/operator-cli';
const cli=join(import.meta.dir,'../src/cli.ts');
test('CLI shared cooldown override and job retry remain separate operator actions',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-cooldown-'));try{
 const path=join(root,'state.sqlite'),s=new Store(path),id=s.enqueue('p','i','{}'),hash=s.propose(id,'plan');s.approve(id,hash,'human');
 const o=new RecoveryObservation(s);o.failed(id,readFailure('github','branch-read','HTTP 429\nRetry-After: 999999999\n',1));const expected=o.status(id).sharedNextRead;s.close();
 const run=(...args:string[])=>Bun.spawnSync([process.execPath,cli,'retry-observation',id,...args],{env:{PATH:process.env.PATH,HOME:root,ADLC_DB:path}});
 expect(run('--override-shared-cooldown','github',String(expected-1)).exitCode).not.toBe(0);
 const override=run('--override-shared-cooldown','github',String(expected));expect(override.exitCode).toBe(0);expect(JSON.parse(override.stdout.toString())).toMatchObject({readRetry:false,sharedCooldown:'cleared',mutationReplay:false});
 const inspect=new Store(path);expect(new RecoveryObservation(inspect).status(id)).toMatchObject({failures:1,sharedNextRead:null});inspect.close();
 expect(run().exitCode).toBe(0);const after=new Store(path);expect(new RecoveryObservation(after).status(id)).toBeNull();after.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('persisted blocked and waiting guidance outranks historical transient observations',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-blocked-'));try{
 const path=join(root,'state.sqlite'),s=new Store(path),id=s.enqueue('p','i','{}');
 new RecoveryObservation(s).failed(id,readFailure('github','review-read','HTTP 503'));
 s.close();
 for(const [persisted,state,action] of [['blocked','blocked',`adlc jobs recover ${id}`],['awaiting_approval','approval_wait',`adlc jobs show-plan ${id}`],['awaiting_plan','awaiting_plan','Inspect queue list for eligibility and planning capacity; no worker has been dispatched.']]){
 const writer=new Store(path);writer.db.query('UPDATE jobs SET state=?,reason=? WHERE id=?').run(persisted,'Eligibility changed',id);writer.close();
 expect(jobViews(path)[0]).toMatchObject({state,reason:'Eligibility changed',nextAction:action,observation:{failures:1,nextRetry:null,error:{classification:'server'}}});
 }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('completed jobs retain observation evidence without suggesting an inactive probe',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-complete-'));try{
 const path=join(root,'state.sqlite'),s=new Store(path),id=s.enqueue('p','i','{}');
 new RecoveryObservation(s).failed(id,readFailure('github','review-read','HTTP 503'));
 s.db.query("UPDATE jobs SET state='done',reason='Human merged PR' WHERE id=?").run(id);s.close();
 expect(jobViews(path)[0]).toMatchObject({state:'complete',reason:'Human merged PR',nextAction:'No job action required; merging remains human-only.',observation:{failures:1,nextRetry:null,error:{classification:'server'}}});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('ticket lookup requires project selection, never picks a candidate',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-'));try{
  const path=join(root,'state.sqlite'),s=new Store(path);
  const first=s.enqueue('p1','uuid1',JSON.stringify({identifier:'DEV-31'}));
  s.enqueue('p3',first,JSON.stringify({identifier:'OTHER-1'}));
  s.enqueue('p2','uuid2',JSON.stringify({identifier:'DEV-31'}));s.close();
  expect(()=>resolveJob(path,'DEV-31')).toThrow('Ambiguous');
  expect(resolveJob(path,'dev-31','p1')).toBe(first);
  expect(resolveJob(path,first)).toBe(first);
  expect(()=>resolveJob(path,'DEV-404')).toThrow('No job');
  const run=(...args:string[])=>Bun.spawnSync([process.execPath,cli,...args],{env:{PATH:process.env.PATH,HOME:root,ADLC_DB:path}});
  const before=readFileSync(path);
  const ambiguous=run('jobs','lookup','DEV-31','--json');
  expect(ambiguous.exitCode).toBe(4);expect(JSON.parse(ambiguous.stderr.toString()).error.candidates).toHaveLength(2);
  const result=run('jobs','status','DEV-31','--project','p1','--json');
  expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout.toString())).toMatchObject({schemaVersion:1,command:'jobs',data:{jobs:[{job:first,state:'awaiting_plan',worker:{activity:'unknown'},evidence:{freshness:'unknown'}}]}});
  expect(run('jobs','status','DEV-404').exitCode).toBe(3);
  expect(run('jobs','list','--bogus').exitCode).toBe(2);
  expect(run('jobs','status','DEV-31','--project','p1').stdout.toString()).toContain('Next:');
  expect(readFileSync(path)).toEqual(before);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('status projection and help do not create missing state',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-empty-'));try{
  const path=join(root,'absent.sqlite');expect(jobViews(path)).toEqual([]);
  for(const args of [['jobs','--help'],['services','start','--help'],['help'],['jobs','list','--json']]){
   const r=Bun.spawnSync([process.execPath,cli,...args],{env:{PATH:process.env.PATH,HOME:root,ADLC_DB:path}});expect(r.exitCode).toBe(0);
  }
  expect(existsSync(path)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('status distinguishes approval, blocked and complete without worker claims',()=>{
 const s=new Store(':memory:');s.close();
 const root=mkdtempSync(join(tmpdir(),'operator-states-'));try{
  const path=join(root,'state.sqlite'),store=new Store(path),id=store.enqueue('p','i','{}');
  store.propose(id,'plan');store.close();expect(jobViews(path)[0].state).toBe('approval_wait');
  for(const [state,expected] of [['blocked','blocked'],['done','complete']]){
   const writer=new Store(path);writer.db.query('UPDATE jobs SET state=? WHERE id=?').run(state,id);writer.close();
   expect(jobViews(path)[0].state).toBe(expected);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('dependency status trusts current persisted bindings, not resumed or stale waits',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-deps-'));try{
  const path=join(root,'state.sqlite'),s=new Store(path),id=s.enqueue('p','i','{}'),hash=s.propose(id,'plan');s.approve(id,hash,'human');
  s.db.exec('CREATE TABLE dependency_waits(job TEXT,plan TEXT,state TEXT,reason TEXT)');
  s.db.exec('CREATE TABLE worker_outcomes(job TEXT,plan_hash TEXT,outcome TEXT)');s.db.query('INSERT INTO worker_outcomes VALUES (?,?,?)').run(id,hash,'blocked_dependency');
  s.db.query('INSERT INTO dependency_waits VALUES (?,?,?,?)').run(id,hash,'waiting_for_dependencies','Missing prerequisite proof');s.close();
  expect(jobViews(path)[0]).toMatchObject({state:'dependency_wait',reason:'Missing prerequisite proof'});
  const writer=new Store(path);writer.db.query("UPDATE dependency_waits SET state='resumed'").run();writer.close();
  expect(jobViews(path)[0].state).toBe('working');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('legacy doctor output remains unwrapped and grouped alias has versioned JSON',()=>{
 const run=(...args:string[])=>Bun.spawnSync([process.execPath,cli,...args]);
 const flat=JSON.parse(run('doctor').stdout.toString()),grouped=JSON.parse(run('diagnostics','doctor','--json').stdout.toString());
 expect(flat.schemaVersion).toBeUndefined();expect(grouped.schemaVersion).toBe(1);expect(grouped.data).toEqual(flat);
});

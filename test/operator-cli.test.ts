import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core';
import {resolveJob,jobViews} from '../src/operator-cli';
const cli=join(import.meta.dir,'../src/cli.ts');
test('ticket lookup requires project selection, never picks a candidate',()=>{
 const root=mkdtempSync(join(tmpdir(),'operator-'));try{
  const path=join(root,'state.sqlite'),s=new Store(path);
  const first=s.enqueue('p1','uuid1',JSON.stringify({identifier:'DEV-31'}));
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
  expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout.toString())).toMatchObject({schemaVersion:1,command:'jobs',data:{jobs:[{job:first,state:'working',worker:{activity:'unknown'},evidence:{freshness:'unknown'}}]}});
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

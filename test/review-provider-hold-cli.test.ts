import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/core';
import {ReviewLoop} from '../src/review-loop';
import {ReviewRequests} from '../src/coderabbit-scheduling';
test('provider hold CLI previews read-only and requires exact confirmation plus named human without replay',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-review-hold-cli-')),db=join(root,'state.sqlite');const s=new Store(db);
 try{
  new ReviewLoop(s);const job=s.enqueue('p','i','spec'),hash=s.propose(job,'plan');s.approve(job,hash,'human');const requests=new ReviewRequests(s);
  requests.claim(job,'o/r',1,{head:'head',signature:'config',blocker:null,incremental:false});requests.holdForInspection(job,'o/r',1,'head');
  const run=(...args:string[])=>Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'reconcile-review-provider',job,...args],{env:{PATH:process.env.PATH,HOME:root,ADLC_DB:db},stdout:'pipe',stderr:'pipe'});
  const count=()=>s.db.query('SELECT count(*) AS n FROM events').get();const before=count(),preview=run();
  expect(preview.exitCode).toBe(0);expect(preview.stderr.toString()).toBe('');expect(count()).toEqual(before);
  const confirmation=JSON.parse(preview.stdout.toString()).confirmation;
  expect(run('--confirm',confirmation).exitCode).not.toBe(0);expect(requests.providerHold()).not.toBeNull();
  expect(run('--confirm','0'.repeat(64),'--human','Operator').exitCode).not.toBe(0);expect(requests.providerHold()).not.toBeNull();
  const applied=run('--confirm',confirmation,'--human','Operator');expect(applied.exitCode).toBe(0);expect(JSON.parse(applied.stdout.toString())).toMatchObject({state:'provider_hold_cleared',mutationReplay:false});
  expect(requests.providerHold()).toBeNull();expect(requests.get('o/r',1,'head')).toMatchObject({state:'delivery_uncertain',attempts:1});expect(s.get(job).attempts).toBe(0);
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});
test('review-cycle CLI preview is read-only; extension requires bound confirmation and retains uncertain query',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-review-cycle-cli-')),db=join(root,'state.sqlite'),s=new Store(db);
 try{
  const loop=new ReviewLoop(s),job=s.enqueue('p','i','spec'),hash=s.propose(job,'plan');s.approve(job,hash,'human');
  s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(job,'o/r',1,'["CI"]','["src/**"]',Date.now());
  const ledger=loop.requests.cooldowns;ledger.http('o/r',1,'head',1);const c=ledger.get('o/r',1),q=ledger.claimQuery(c);
  s.db.query("UPDATE coderabbit_cycles SET state='exhausted',attempts=6").run();
  const run=(...args:string[])=>Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'extend-review-cycle',job,...args],{env:{PATH:process.env.PATH,HOME:root,ADLC_DB:db},stdout:'pipe',stderr:'pipe'});
  const before=ledger.get('o/r',1),preview=run();expect(preview.exitCode).toBe(0);expect(ledger.get('o/r',1)).toEqual(before);
  const confirmation=JSON.parse(preview.stdout.toString()).confirmation;
  expect(run('--confirm',confirmation).exitCode).not.toBe(0);expect(run('--confirm','0'.repeat(64),'--human','Operator').exitCode).not.toBe(0);
  const applied=run('--confirm',confirmation,'--human','Operator');expect(applied.exitCode).toBe(0);expect(JSON.parse(applied.stdout.toString())).toMatchObject({state:'extended',mutationReplay:false});
  expect(ledger.get('o/r',1)).toMatchObject({attempts:6,limit_attempts:12,state:'waiting'});expect(ledger.query(c)).toMatchObject({state:'delivery_uncertain',body:q.body});
  const current=ledger.get('o/r',1),due=ledger.effectiveRetry(current)+1;expect(due).toBeLessThan(current.deadline);
  ledger.now=()=>due;expect(ledger.reserve('o/r',1,'head')).toBe(false);
  expect(ledger.settleQuery(ledger.query(c),{id:42,body:q.body,user:{id:7},created_at:new Date(q.requested).toISOString()})).toBe(true);
  expect(ledger.reserve('o/r',1,'head')).toBe(true);expect(ledger.get('o/r',1).attempts).toBe(7);expect(s.get(job).attempts).toBe(0);
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});

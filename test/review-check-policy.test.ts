import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,digest} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {Lifecycle} from '../src/lifecycle';
import {featureGit} from '../src/approval-policy';
import {ReviewLoop} from '../src/review-loop';
import {RecoveryObservation} from '../src/recovery-observation';
import {ReceiptReconciliation} from '../src/receipt-reconciliation';
import {previewReviewChecks,confirmReviewChecks} from '../src/review-check-policy';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'review-check-policy-')),db=join(root,'state.sqlite'),s=new Store(db);
 new Workflow(s,{} as any);
 const project='11111111-1111-4111-8111-111111111111',p=new Planning(s),job=s.enqueue(project,'issue','spec'),r=p.reserve(job,'ao');
 p.gate(job,'ao','worker',r.branch,join(root,'tree'));
 const plan=s.propose(job,'plan');s.approve(job,plan,'Human');const lifecycle=new Lifecycle(s);
 lifecycle.grantGit(job,plan,featureGit,'Human');lifecycle.adoptSupervised(job,{id:'worker',correlation:r.correlation,worktree:join(root,'tree'),controller:'running'});
 s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(job,plan,'worker','dispatch','pr_handoff','["src/**"]','supervised-host','Human',null);
 const loop=new ReviewLoop(s);loop.register(job,'owner/repo',1,['CI'],['src/**'],true);
 s.db.query("UPDATE review_targets SET head=?,state='ready_for_human',reason='Previous checks clear',last_signature='old-clearance' WHERE job=?").run('a'.repeat(40),job);
 const c={version:1,name:'Fixture',repo:root,githubRepo:'owner/repo',requiredChecks:['CI','Security'],linear:{projectId:project,teamId:project,readyStateId:project,readyLabelId:project},automation:{orchestratorProject:'ao'}};
 return {root,db,s,job,plan,c,loop,close:()=>{s.close();rmSync(root,{recursive:true,force:true});}};
}

test('required-check preview is read-only and exact confirmation invalidates stale readiness once',()=>{
 const f=fixture();let reader:Store|undefined;
 try{
  const before=f.loop.get(f.job),events=f.s.db.query('SELECT * FROM events').all(),budget=f.s.db.query('SELECT * FROM remediation_budget').all(),attempts=f.s.get(f.job).attempts;
  reader=Store.readonly(f.db);const preview=previewReviewChecks(reader,f.job,f.c,'Operator');
  expect(preview).toMatchObject({before:['CI'],after:['CI','Security'],added:['Security'],changed:true});
  expect(f.loop.get(f.job)).toEqual(before);expect(f.s.db.query('SELECT * FROM events').all()).toEqual(events);
  expect(()=>confirmReviewChecks(f.s,f.job,f.c,'Operator','0'.repeat(64))).toThrow('proof changed');
  expect(confirmReviewChecks(f.s,f.job,f.c,'Operator',preview.confirmation)).toMatchObject({state:'required_checks_reconciled',requiredChecks:['CI','Security'],mutationReplay:false});
  expect(f.loop.get(f.job)).toMatchObject({required_checks:'["CI","Security"]',state:'waiting_for_review',reason:null,last_signature:null,head:before.head,head_since:before.head_since});
  const applied=f.loop.get(f.job),next=previewReviewChecks(f.s,f.job,f.c,'Operator');
  expect(confirmReviewChecks(f.s,f.job,f.c,'Operator',next.confirmation).state).toBe('unchanged');expect(f.loop.get(f.job)).toEqual(applied);
  expect(()=>confirmReviewChecks(f.s,f.job,f.c,'Operator',preview.confirmation)).toThrow('proof changed');
  expect(f.s.db.query("SELECT count(*) AS n FROM events WHERE kind='review_required_checks_reconciled'").get()).toEqual({n:1});
  expect(f.s.db.query('SELECT * FROM remediation_budget').all()).toEqual(budget);expect(f.s.get(f.job).attempts).toBe(attempts);
 }finally{reader?.close();f.close();}
});
for(const gate of ['own-policy','independent-review','delivery','reservation'])test(`required-check reconciliation preserves independent gates: ${gate}`,()=>{
 const f=fixture();try{
  const state=gate==='delivery'?'needs_reconciliation':'blocked',reason=gate==='own-policy'?`Required-check policy changed; preview reconcile-review-checks ${f.job} CONFIG HUMAN`:'Independent security/delivery gate';
  f.s.db.query('UPDATE review_targets SET state=?,reason=? WHERE job=?').run(state,reason,f.job);
  if(gate==='reservation'){
   f.s.db.exec('CREATE TABLE branch_syncs(job TEXT PRIMARY KEY,worktree TEXT,state TEXT,proof TEXT,reason TEXT)');
   f.s.db.query("INSERT INTO branch_syncs VALUES (?,?,'updating','retained-proof','preserve')").run(f.job,join(f.root,'tree'));
  }
  const reservations=gate==='reservation'?f.s.db.query('SELECT * FROM branch_syncs').all():null;
  const preview=previewReviewChecks(f.s,f.job,f.c,'Operator');confirmReviewChecks(f.s,f.job,f.c,'Operator',preview.confirmation);
  expect(f.loop.get(f.job)).toMatchObject({required_checks:'["CI","Security"]',last_signature:null,state:gate==='own-policy'?'waiting_for_review':state,reason:gate==='own-policy'?null:reason});
  if(reservations)expect(f.s.db.query('SELECT * FROM branch_syncs').all()).toEqual(reservations);
 }finally{f.close();}
});
for(const fault of ['remove','replace','empty','human','approval','owner','target','scope','config','session','active-review'])test(`required-check reconciliation rejects ${fault} drift without changing policy or gates`,()=>{
 const f=fixture();let release:(()=>void)|null=null;
 try{
  const preview=previewReviewChecks(f.s,f.job,f.c,'Operator');let human='Operator';
  if(fault==='remove')f.c.requiredChecks=['Security'];
  if(fault==='replace')f.c.requiredChecks=['Other'];
  if(fault==='empty')f.c.requiredChecks=[];
  if(fault==='human')human='Another operator';
  if(fault==='approval')f.s.db.query('UPDATE jobs SET approved_hash=NULL WHERE id=?').run(f.job);
  if(fault==='owner'){f.s.db.exec('CREATE TABLE ownership(session_id TEXT PRIMARY KEY,owner TEXT)');f.s.db.query("INSERT INTO ownership VALUES ('worker','human')").run();}
  if(fault==='target')f.s.db.query('UPDATE review_targets SET pr=2 WHERE job=?').run(f.job);
  if(fault==='scope')f.s.db.query("UPDATE review_targets SET allowed_paths='[\"other/**\"]' WHERE job=?").run(f.job);
  if(fault==='config')f.c.requiredChecks=['CI','Security','Additional'];
  if(fault==='session')f.s.db.query("UPDATE implementation_dispatch SET session_id='other' WHERE job=?").run(f.job);
  if(fault==='active-review')release=new RecoveryObservation(f.s).claim(`job:${f.job}`);
  const before=f.loop.get(f.job),events=f.s.db.query('SELECT * FROM events').all();
  expect(()=>confirmReviewChecks(f.s,f.job,f.c,human,preview.confirmation)).toThrow();
  expect(f.loop.get(f.job)).toEqual(before);expect(f.s.db.query('SELECT * FROM events').all()).toEqual(events);
 }finally{release?.();f.close();}
});
test('required-check CLI previews read-only, requires a named operator and exact hash, and persists configured checks',()=>{
 const f=fixture();try{
  const config=join(f.root,'project.json');writeFileSync(config,JSON.stringify(f.c));
  const run=(...args:string[])=>Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'reconcile-review-checks',f.job,config,...args],{env:{PATH:process.env.PATH,HOME:f.root,ADLC_DB:f.db},stdout:'pipe',stderr:'pipe'});
  const events=f.s.db.query('SELECT * FROM events').all(),before=f.loop.get(f.job);
  expect(run().exitCode).not.toBe(0);
  const output=run('Operator');expect(output.exitCode).toBe(0);expect(output.stderr.toString()).toBe('');
  const preview=JSON.parse(output.stdout.toString());expect(f.loop.get(f.job)).toEqual(before);expect(f.s.db.query('SELECT * FROM events').all()).toEqual(events);
  expect(run('Operator','--confirm','0'.repeat(64)).exitCode).not.toBe(0);
  const result=run('Operator','--confirm',preview.confirmation);expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString())).toMatchObject({state:'required_checks_reconciled',requiredChecks:['CI','Security']});
  expect(f.loop.get(f.job)).toMatchObject({required_checks:'["CI","Security"]',state:'waiting_for_review',last_signature:null,reason:null});
 }finally{f.close();}
});
test('review polling after reconciliation evaluates the added check rather than reusing old clearance',async()=>{
 const f=fixture();try{
  const preview=previewReviewChecks(f.s,f.job,f.c,'Operator');confirmReviewChecks(f.s,f.job,f.c,'Operator',preview.confirmation);
  const head='a'.repeat(40),branch=(f.s.db.query('SELECT branch FROM planning_runs WHERE job=?').get(f.job) as any).branch;
  const ledger=new ReceiptReconciliation(f.s);ledger.reserve({job:f.job,plan:f.plan,spec:digest(f.s.get(f.job).spec),session:'worker',client:'dispatch',attempt:'implementation:1'});ledger.accepted('dispatch');
  f.loop.configureMetadataChecks(f.c.linear.projectId,[]);
  f.loop.io.sessionEvidence=async()=>({session:{id:'worker',projectId:'ao',kind:'worker',branch,isTerminated:false,activity:{state:'idle'},prs:[{number:1,url:'https://github.com/owner/repo/pull/1',state:'open'}]},transcript:{controller:'ready',entries:[{clientMessageId:'dispatch',turnId:'implementation'}],turns:[{id:'implementation',state:'completed'}]},receiptObservation:{complete:true,observed:Date.now()}});
  f.loop.io.worktreeIdentity=async()=>({tree:join(f.root,'tree'),branch,head});
  f.loop.io.readBranchSnapshot=async()=>({head,base:'b'.repeat(40),branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:true,behind:0});
  const requirements:string[][]=[];
  f.loop.io.readiness=async(_repo,_pr,checks)=>{requirements.push(checks);return {head,clear:false,reasons:['Security pending'],findings:[],failedChecks:[],pendingChecks:['Security'],missingChecks:[],coderabbitPresent:true,coderabbitPending:false} as any;};
  expect(await f.loop.tick(f.job,undefined,undefined,undefined,f.c)).toMatchObject({state:'waiting_for_ci',send:false});
  expect(requirements).toEqual([['CI','Security']]);expect(f.loop.get(f.job).state).not.toBe('ready_for_human');
 }finally{f.close();}
});

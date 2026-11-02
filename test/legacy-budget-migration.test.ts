import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Lifecycle} from '../src/lifecycle';
import {ReviewLoop} from '../src/review-loop';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const REASON='Remediation limit exhausted';
const policy={maxAttempts:5,maxNoProgress:5,window:'job' as const};

// Reproduces the pre-budget schema from the released implementation: jobs,
// git_grants, runs, remediation and review_targets exist, but no
// remediation_budget table has ever been written.
function legacyFixture(path=':memory:'){
  const s=new Store(path);
  s.db.exec(`CREATE TABLE IF NOT EXISTS git_grants (
    job TEXT PRIMARY KEY REFERENCES jobs(id), plan_hash TEXT NOT NULL,
    operations TEXT NOT NULL, actor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
    job TEXT PRIMARY KEY REFERENCES jobs(id), correlation TEXT NOT NULL UNIQUE,
    plan_hash TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT, worktree TEXT,
    owner TEXT NOT NULL DEFAULT 'orchestrator', reason TEXT);
    CREATE TABLE IF NOT EXISTS remediation (
    job TEXT NOT NULL REFERENCES jobs(id), head TEXT NOT NULL, findings_hash TEXT NOT NULL,
    attempt INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(job,head,findings_hash));
    CREATE TABLE IF NOT EXISTS review_targets(
    job TEXT PRIMARY KEY REFERENCES jobs(id),repo TEXT NOT NULL,pr INTEGER NOT NULL,
    required_checks TEXT NOT NULL,allowed_paths TEXT NOT NULL,remediate INTEGER NOT NULL DEFAULT 0,
    head TEXT,state TEXT NOT NULL DEFAULT 'waiting_for_review',reason TEXT,
    head_since INTEGER NOT NULL,last_signature TEXT,updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  const id=digest(JSON.stringify(['project','DEV-15'])),spec='{"identifier":"DEV-15"}',plan='Approved plan';
  const hash=digest(JSON.stringify([spec,plan])),head='a'.repeat(40),correlation=digest(JSON.stringify([id,hash]));
  s.db.query(`INSERT INTO jobs(id,project,issue,spec,state,plan,plan_hash,approved_hash,actor,attempts,reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,'project','DEV-15',spec,'blocked',plan,hash,hash,'Patrick Stone-Sudol',5,REASON);
  s.db.query('INSERT INTO git_grants VALUES (?,?,?,?)').run(id,hash,JSON.stringify(['inspect','fetch','worktree','branch','commit','push-feature','open-pr']),'Patrick Stone-Sudol');
  s.db.query(`INSERT INTO runs(job,correlation,plan_hash,state,session_id,worktree,owner,reason)
    VALUES (?,?,?,?,?,?,?,?)`).run(id,correlation,hash,'blocked','session-1','/isolated/worktree','orchestrator',REASON);
  for(let attempt=1;attempt<=5;attempt++)s.db.query('INSERT INTO remediation VALUES (?,?,?,?,?)').run(id,head,digest(`fix ${attempt}`),attempt,'completed');
  s.db.query(`INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head,state,reason,head_since)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,'owner/repo',3,JSON.stringify(['CI']),JSON.stringify(['src/**']),1,head,'remediation_pending','Actionable latest-SHA CodeRabbit findings',Date.now());
  return {s,id,hash,head,l:new Lifecycle(s)};
}

const options=(f:ReturnType<typeof legacyFixture>)=>({actor:'Patrick Stone-Sudol',additional:2,head:f.head,policy,reason:'reviewed legacy receipts'});

test('legacy pre-budget exhaustion migrates once and extend-budget recovers without resetting attempts',()=>{
  const f=legacyFixture();
  try{
    expect(f.l.budgetSummary(f.id,policy)).toMatchObject({consumed:5,effectiveMaxAttempts:5,remaining:0,stopReason:'budget_exhausted'});
    expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_migrations').get() as any).n).toBe(0);
    const preview=f.l.extendRemediationBudget(f.id,options(f)) as any;
    expect(preview.preview).toBe(true);expect(preview.budget).toMatchObject({consumed:5,extensions:0,remaining:0,stopReason:'budget_exhausted'});
    // Preview may mirror the legacy stop and provenance, but grants nothing.
    expect(f.l.budgetSummary(f.id,policy).extensions).toBe(0);
    expect(f.s.get(f.id).state).toBe('blocked');expect(f.l.run(f.id).state).toBe('blocked');
    expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_migrations WHERE job=?').get(f.id) as any).n).toBe(1);
    expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_extensions').get() as any).n).toBe(0);
    expect((f.s.db.query("SELECT count(*) AS n FROM events WHERE job=? AND kind='legacy_remediation_budget_reconciled'").get(f.id) as any).n).toBe(1);
    const applied=f.l.extendRemediationBudget(f.id,{...options(f),confirm:preview.confirmHash}) as any;
    expect(applied.preview).toBe(false);expect(applied.budget).toMatchObject({consumed:5,extensions:2,effectiveMaxAttempts:7,remaining:2});
    expect(f.s.get(f.id).attempts).toBe(5);expect(f.s.get(f.id).state).toBe('approved');expect(f.l.run(f.id).state).toBe('running');
    expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_extensions').get() as any).n).toBe(1);
    expect((f.s.db.query('SELECT count(*) AS n FROM remediation WHERE job=?').get(f.id) as any).n).toBe(5);
    expect(f.l.reserveRemediation(f.id,f.head,'fix six',policy).attempt).toBe(6);
    expect(f.s.get(f.id).attempts).toBe(6);
  }finally{f.s.close();}
});

test('repeated and overlapping previews share one migration row and one extension',()=>{
  const dir=mkdtempSync(join(tmpdir(),'adlc-legacy-budget-'));
  const path=join(dir,'state.db');
  try{
    const f=legacyFixture(path),second=new Store(path),other=new Lifecycle(second);
    try{
      const first=f.l.extendRemediationBudget(f.id,options(f)) as any;
      const again=other.extendRemediationBudget(f.id,options(f)) as any;
      expect(first.preview).toBe(true);expect(again.preview).toBe(true);expect(again.confirmHash).toBe(first.confirmHash);
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_migrations').get() as any).n).toBe(1);
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget').get() as any).n).toBe(1);
      const applied=other.extendRemediationBudget(f.id,{...options(f),confirm:again.confirmHash}) as any;
      expect(applied.budget).toMatchObject({extensions:2,consumed:5});
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_extensions').get() as any).n).toBe(1);
      expect(()=>f.l.extendRemediationBudget(f.id,{...options(f),confirm:first.confirmHash})).toThrow('not exhausted');
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_migrations').get() as any).n).toBe(1);
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_extensions').get() as any).n).toBe(1);
    }finally{second.close();f.s.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('partial legacy budget state is reconciled instead of seeding a neutral row',()=>{
  const f=legacyFixture();
  try{
    f.s.db.query(`INSERT INTO remediation_budget(job,consumed,extensions,no_progress,stop_reason,configured_max_attempts,configured_max_no_progress,window)
      VALUES (?,?,?,?,?,?,?,?)`).run(f.id,5,0,0,null,5,5,'job');
    expect(f.l.budgetSummary(f.id,policy).stopReason).toBeNull();
    const preview=f.l.extendRemediationBudget(f.id,options(f)) as any;
    expect(preview.preview).toBe(true);expect(preview.budget.stopReason).toBe('budget_exhausted');
    expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_migrations').get() as any).n).toBe(1);
    expect(f.s.get(f.id).attempts).toBe(5);
  }finally{f.s.close();}
});

test('alternate blockers are not migrated and extension stays refused without writing budget state',()=>{
  for(const reason of ['Blocked — branch mismatch: reserved feature; actual other','No longer eligible in Linear','Review findings exceed approved file scope']){
    const f=legacyFixture();
    try{
      f.s.db.query('UPDATE jobs SET reason=? WHERE id=?').run(reason,f.id);
      f.s.db.query('UPDATE runs SET reason=? WHERE job=?').run(reason,f.id);
      expect(f.l.budgetSummary(f.id,policy).stopReason).toBeNull();
      expect(()=>f.l.extendRemediationBudget(f.id,options(f))).toThrow('not exhausted');
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_migrations').get() as any).n).toBe(0);
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget').get() as any).n).toBe(0);
      expect(f.s.get(f.id).state).toBe('blocked');
    }finally{f.s.close();}
  }
});

test('raised and uncapped policy require confirmation to clear a superseded legacy stop without extending',()=>{
  for(const [name,current] of [['raised',{maxAttempts:8,maxNoProgress:5,window:'job' as const}],['uncapped',{maxAttempts:null,maxNoProgress:5,window:'job' as const}]] as const){
    const f=legacyFixture();
    try{
      const preview=f.l.extendRemediationBudget(f.id,{...options(f),policy:current}) as any;
      expect(preview.action,name).toBe('resume_legacy_stop');expect(preview.preview).toBe(true);expect(preview.additional).toBe(0);
      expect(f.s.get(f.id).state).toBe('blocked');expect(f.l.budgetSummary(f.id,current).stopReason).toBeNull();
      expect((f.s.db.query('SELECT outcome FROM remediation_budget_migrations WHERE job=?').get(f.id) as any).outcome).toBe(name==='raised'?'raised_current_policy':'uncapped_current_policy');
      const applied=f.l.extendRemediationBudget(f.id,{...options(f),policy:current,confirm:preview.confirmHash}) as any;
      expect(applied.preview).toBe(false);expect(applied.budget.extensions).toBe(0);
      expect(f.s.get(f.id).state).toBe('approved');expect(f.s.get(f.id).attempts).toBe(5);expect(f.l.run(f.id).state).toBe('running');
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_extensions').get() as any).n).toBe(0);
      expect(f.l.reserveRemediation(f.id,f.head,'fix six',current).attempt).toBe(6);
    }finally{f.s.close();}
  }
});

test('lowered policy still treats the legacy five-attempt stop as exhausted',()=>{
  const f=legacyFixture(),lowered={maxAttempts:3,maxNoProgress:5,window:'job' as const};
  try{
    expect(f.l.budgetSummary(f.id,lowered)).toMatchObject({configuredMaxAttempts:3,consumed:5,remaining:0,stopReason:'budget_exhausted'});
    const preview=f.l.extendRemediationBudget(f.id,{...options(f),additional:3,policy:lowered}) as any;
    expect(preview.preview).toBe(true);
    const applied=f.l.extendRemediationBudget(f.id,{...options(f),additional:3,policy:lowered,confirm:preview.confirmHash}) as any;
    expect(applied.budget).toMatchObject({extensions:3,effectiveMaxAttempts:6,consumed:5,remaining:1});
    expect(f.l.reserveRemediation(f.id,f.head,'fix six',lowered).attempt).toBe(6);
  }finally{f.s.close();}
});

test('an exhausted legacy migration follows a later raised or uncapped policy without a budget extension',()=>{
  for(const [name,current] of [['raised',{maxAttempts:8,maxNoProgress:5,window:'job' as const}],['uncapped',{maxAttempts:null,maxNoProgress:5,window:'job' as const}]] as const){
    const f=legacyFixture();
    try{
      const exhausted=f.l.extendRemediationBudget(f.id,options(f)) as any;
      expect(exhausted.budget.stopReason).toBe('budget_exhausted');
      const preview=f.l.extendRemediationBudget(f.id,{...options(f),policy:current}) as any;
      expect(preview.action,name).toBe('resume_legacy_stop');expect(preview.preview).toBe(true);expect(preview.additional).toBe(0);
      expect(f.l.budgetSummary(f.id,current).stopReason).toBeNull();
      expect((f.s.db.query('SELECT outcome FROM remediation_budget_migrations WHERE job=?').get(f.id) as any).outcome).toBe(name==='raised'?'raised_current_policy':'uncapped_current_policy');
      const applied=f.l.extendRemediationBudget(f.id,{...options(f),policy:current,confirm:preview.confirmHash}) as any;
      expect(applied.preview).toBe(false);expect(applied.budget.extensions).toBe(0);
      expect(f.s.get(f.id).state).toBe('approved');expect(f.s.get(f.id).attempts).toBe(5);expect(f.l.run(f.id).state).toBe('running');
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_extensions').get() as any).n).toBe(0);
    }finally{f.s.close();}
  }
});

test('resume confirmation is evidence-guarded, transactional and replay-safe',()=>{
  const f=legacyFixture(),raised={maxAttempts:8,maxNoProgress:5,window:'job' as const};
  try{
    const preview=f.l.extendRemediationBudget(f.id,{...options(f),policy:raised}) as any;
    expect(preview.action).toBe('resume_legacy_stop');
    // Evidence can change between preview and confirmation.
    f.s.db.query('UPDATE runs SET reason=? WHERE job=?').run('manual review',f.id);
    expect(()=>f.l.extendRemediationBudget(f.id,{...options(f),policy:raised,confirm:preview.confirmHash})).toThrow('Legacy budget stop changed');
    f.s.db.query('UPDATE runs SET reason=? WHERE job=?').run(REASON,f.id);
    // A transaction failure after clearing the stop must roll back every change.
    f.s.db.exec("CREATE TRIGGER fail_resume BEFORE UPDATE ON review_targets BEGIN SELECT RAISE(ABORT,'resume blocked'); END");
    expect(()=>f.l.extendRemediationBudget(f.id,{...options(f),policy:raised,confirm:preview.confirmHash})).toThrow('resume blocked');
    f.s.db.exec('DROP TRIGGER fail_resume');
    expect(f.s.get(f.id).state).toBe('blocked');expect(f.l.run(f.id).state).toBe('blocked');
    expect((f.s.db.query('SELECT state,reason FROM review_targets WHERE job=?').get(f.id) as any)).toMatchObject({state:'remediation_pending',reason:'Actionable latest-SHA CodeRabbit findings'});
    expect((f.s.db.query("SELECT count(*) AS n FROM events WHERE job=? AND kind='legacy_remediation_budget_resumed'").get(f.id) as any).n).toBe(0);
    const applied=f.l.extendRemediationBudget(f.id,{...options(f),policy:raised,confirm:preview.confirmHash}) as any;
    expect(applied).toMatchObject({preview:false,action:'resume_legacy_stop',alreadyApplied:false});
    expect((f.s.db.query('SELECT state,reason FROM review_targets WHERE job=?').get(f.id) as any)).toMatchObject({state:'remediation_pending',reason:'Legacy budget stop cleared under current policy; next poll reevaluates current evidence'});
    expect((f.s.db.query("SELECT count(*) AS n FROM events WHERE job=? AND kind='legacy_remediation_budget_resumed'").get(f.id) as any).n).toBe(1);
    const target=f.s.db.query('SELECT state,reason,updated FROM review_targets WHERE job=?').get(f.id) as any;
    const replay=f.l.extendRemediationBudget(f.id,{...options(f),policy:raised,confirm:preview.confirmHash}) as any;
    expect(replay).toMatchObject({preview:false,action:'resume_legacy_stop',alreadyApplied:true});
    expect((f.s.db.query("SELECT count(*) AS n FROM events WHERE job=? AND kind='legacy_remediation_budget_resumed'").get(f.id) as any).n).toBe(1);
    expect(f.s.db.query('SELECT state,reason,updated FROM review_targets WHERE job=?').get(f.id)).toEqual(target);
    expect(f.s.get(f.id).state).toBe('approved');expect(f.s.get(f.id).attempts).toBe(5);
  }finally{f.s.close();}
});


test('legacy migration refuses uncertainty, stale approval, wrong owner, changed head or scope before writing',()=>{
  const cases:[string,(f:ReturnType<typeof legacyFixture>)=>void,string][]=[
    ['uncertain delivery',f=>{f.s.db.query("UPDATE remediation SET state='delivery_uncertain' WHERE job=? AND attempt=5").run(f.id)},'Prior delivery uncertainty'],
    ['stale approval',f=>{f.s.db.query("UPDATE jobs SET approved_hash='stale' WHERE id=?").run(f.id)},'Current plan approval'],
    ['human owned run',f=>{f.s.db.query("UPDATE runs SET owner='human' WHERE job=?").run(f.id)},'Existing owned job'],
    ['changed head',f=>{f.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run('b'.repeat(40),f.id)},'tick-review'],
    ['missing scope',f=>{f.s.db.query('DELETE FROM git_grants WHERE job=?').run(f.id)},'Current scoped GitHub'],
  ];
  for(const [name,mutate,message] of cases){
    const f=legacyFixture();
    try{
      mutate(f);expect(()=>f.l.extendRemediationBudget(f.id,options(f)),name).toThrow(message);
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_migrations').get() as any).n).toBe(0);
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget').get() as any).n).toBe(0);
      expect((f.s.db.query('SELECT count(*) AS n FROM remediation_budget_extensions').get() as any).n).toBe(0);
      expect(f.s.get(f.id).state).toBe('blocked');expect(f.s.get(f.id).attempts).toBe(5);
    }finally{f.s.close();}
  }
});

test('failed confirmation rolls back extension state and preserves the migrated stop',()=>{
  const f=legacyFixture();
  try{
    const preview=f.l.extendRemediationBudget(f.id,options(f)) as any;
    f.s.db.exec('DROP TABLE remediation_budget_extensions');
    expect(()=>f.l.extendRemediationBudget(f.id,{...options(f),confirm:preview.confirmHash})).toThrow();
    expect(f.s.get(f.id).state).toBe('blocked');expect(f.s.get(f.id).attempts).toBe(5);
    expect(f.l.run(f.id).state).toBe('blocked');
    expect(f.l.budgetSummary(f.id,policy)).toMatchObject({extensions:0,stopReason:'budget_exhausted'});
  }finally{f.s.close();}
});

test('review-status and status report the legacy stop as blocked while keeping review evidence',()=>{
  const dir=mkdtempSync(join(tmpdir(),'adlc-legacy-status-')),path=join(dir,'state.db');
  try{
    const f=legacyFixture(path);f.s.close();
    const env={ADLC_DB:path,HOME:dir,PATH:process.env.PATH??'/usr/bin:/bin'};
    for(const command of ['review-status','status']){
      const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),command],{env});
      expect(result.exitCode).toBe(0);
      const parsed=JSON.parse(result.stdout.toString()),row=command==='review-status'?parsed[0]:parsed.reviews[0];
      expect(row).toMatchObject({state:'blocked',displayStatus:'Blocked',reviewState:'remediation_pending',blockedReason:REASON});
      expect(row.remediation).toMatchObject({consumed:5,remaining:0,stopReason:'budget_exhausted'});
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('review-status preserves a needs_reconciliation display when the job is blocked',()=>{
  const dir=mkdtempSync(join(tmpdir(),'adlc-legacy-status-')),path=join(dir,'state.db');
  try{
    const f=legacyFixture(path);
    f.s.db.query("UPDATE review_targets SET state='needs_reconciliation',reason='Previous remediation delivery is uncertain; never resend' WHERE job=?").run(f.id);
    f.s.close();
    const env={ADLC_DB:path,HOME:dir,PATH:process.env.PATH??'/usr/bin:/bin'};
    const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'review-status'],{env});
    expect(result.exitCode).toBe(0);
    const row=JSON.parse(result.stdout.toString())[0];
    expect(row).toMatchObject({state:'needs_reconciliation',displayStatus:'Blocked — delivery needs reconciliation',reviewState:'needs_reconciliation',jobState:'blocked'});
    expect(row.remediation).toMatchObject({consumed:5,remaining:0,stopReason:'budget_exhausted'});
  }finally{rmSync(dir,{recursive:true,force:true});}
});

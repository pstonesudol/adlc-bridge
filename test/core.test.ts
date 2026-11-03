import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core';

// Frozen v1 DDL, independent of the current initializer.
const legacy = `CREATE TABLE jobs (
id TEXT PRIMARY KEY, project TEXT NOT NULL, issue TEXT NOT NULL,
spec TEXT NOT NULL, state TEXT NOT NULL, plan TEXT, plan_hash TEXT,
approved_hash TEXT, actor TEXT, attempts INTEGER NOT NULL DEFAULT 0,
reason TEXT, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project,issue));
CREATE TABLE events (seq INTEGER PRIMARY KEY,job TEXT NOT NULL REFERENCES jobs(id),
kind TEXT NOT NULL,detail TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE approvals (seq INTEGER PRIMARY KEY,job TEXT NOT NULL REFERENCES jobs(id),
plan_hash TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
PRAGMA user_version=1;
INSERT INTO jobs VALUES ('job','project','DEV-fixture','spec','approved','plan','hash','hash','human',3,NULL,'2026-01-01');
INSERT INTO events VALUES (7,'job','human_plan_approval_recorded','hash','2026-01-01');
INSERT INTO approvals VALUES (9,'job','hash','human','2026-01-01');`;
function records(db:Database) {
  return ['jobs','events','approvals'].map(table=>db.query(`SELECT * FROM ${table}`).all());
}
function fixture(run:(path:string,dir:string)=>void) {
  const dir=mkdtempSync(join(tmpdir(),'adlc-schema-'));
  try {run(join(dir,'state.db'),dir);} finally {rmSync(dir,{recursive:true,force:true});}
}
test('v1 upgrade preserves records, indexes and repeated opens',()=>fixture(path=>{
  const db=new Database(path);db.exec(legacy);const before=records(db);db.close();
  for(let i=0;i<2;i++) {
    const s=new Store(path);
    try {
      expect(records(s.db)).toEqual(before);
      expect(s.db.query('PRAGMA user_version').get()).toEqual({user_version:2});
      expect(s.db.query("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('events_job_seq','approvals_job_seq')").all()).toHaveLength(2);
      expect(s.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {s.close();}
  }
}));
test('unsupported and failed upgrades preserve data and roll back DDL',()=>{
  for(const setup of ['PRAGMA user_version=99','CREATE TABLE approvals_job_seq (sentinel TEXT)']) fixture(path=>{
    const db=new Database(path);db.exec(legacy);db.exec(setup);
    const before=records(db),schema=db.query('SELECT * FROM sqlite_master ORDER BY name').all();
    const version=db.query('PRAGMA user_version').get();db.close();
    expect(()=>new Store(path)).toThrow();
    const check=new Database(path,{readonly:true});
    try {
      expect(records(check)).toEqual(before);
      expect(check.query('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema);
      expect(check.query('PRAGMA user_version').get()).toEqual(version);
    } finally {check.close();}
  });
});
test('SQLite backup and restore preserves committed WAL records and integrity',()=>fixture((path,dir)=>{
  const s=new Store(path);
  try {
    const id=s.enqueue('fixture','DEV-fixture','spec');const hash=s.propose(id,'plan');s.approve(id,hash,'fixture-human');
    const before=records(s.db),backup=join(dir,'backup.db');
    // VACUUM INTO makes a consistent SQLite snapshot, including committed WAL data.
    s.db.query('VACUUM INTO ?').run(backup);
    const snapshot=new Database(backup,{readonly:true});
    try {snapshot.query('VACUUM INTO ?').run(join(dir,'restored.db'));} finally {snapshot.close();}
    const restored=new Store(join(dir,'restored.db'));
    try {
      expect(records(restored.db)).toEqual(before);
      expect(restored.db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
      expect(restored.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {restored.close();}
  } finally {s.close();}
}));

import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tryVerifiedCoordinator,verifiedCoordinator} from '../src/coordinator-gate';
test('only the registered coordinator workspace is admitted; worker and forged roles fail closed',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'coordinator-gate-'))),db=new Database(':memory:');
 try{
  const source=join(root,'repo'),cwd=join(root,'worktrees','demo','orchestrator','demo-orchestrator');
  mkdirSync(source);mkdirSync(cwd,{recursive:true});
  db.exec('CREATE TABLE projects(id TEXT,path TEXT,config TEXT,archived_at TEXT); CREATE TABLE sessions(project_id TEXT,kind TEXT,is_terminated INTEGER,workspace_path TEXT)');
  db.query('INSERT INTO projects VALUES(?,?,?,NULL)').run('demo',source,'{}');
  db.query('INSERT INTO sessions VALUES(?,?,0,?)').run('demo','orchestrator','');
  expect(verifiedCoordinator(db,'demo',source,cwd,root)).toBe(true);
  expect(verifiedCoordinator(db,'demo',source,source,root)).toBe(false);
  expect(verifiedCoordinator(db,'other',source,cwd,root)).toBe(false);
  db.exec("UPDATE sessions SET kind='worker'");
  expect(verifiedCoordinator(db,'demo',source,cwd,root)).toBe(false);
  db.exec("UPDATE sessions SET kind='orchestrator',is_terminated=1");
  expect(verifiedCoordinator(db,'demo',source,cwd,root)).toBe(false);
  db.exec("UPDATE sessions SET is_terminated=0");
  db.query('INSERT INTO sessions VALUES(?,?,0,?)').run('demo','orchestrator','');
  expect(verifiedCoordinator(db,'demo',source,cwd,root)).toBe(false);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('a missing, corrupt or unsupported AO registry closes coordinator admission without throwing',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'coordinator-registry-')));
 try{
  const source=join(root,'repo'),cwd=join(root,'worktrees','demo','orchestrator','demo-orchestrator');
  mkdirSync(source);mkdirSync(cwd,{recursive:true});
  expect(tryVerifiedCoordinator('demo',source,cwd,root)).toBe(false);
  expect(existsSync(join(root,'ao.db'))).toBe(false);
  writeFileSync(join(root,'ao.db'),'not a database');
  expect(tryVerifiedCoordinator('demo',source,cwd,root)).toBe(false);
  rmSync(join(root,'ao.db'));
  const db=new Database(join(root,'ao.db'));db.exec('CREATE TABLE unrelated(x)');db.close();
  expect(tryVerifiedCoordinator('demo',source,cwd,root)).toBe(false);
  expect(tryVerifiedCoordinator('demo',source,cwd,join(root,'absent'))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

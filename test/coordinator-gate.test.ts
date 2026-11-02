import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifiedCoordinator} from '../src/coordinator-gate';
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

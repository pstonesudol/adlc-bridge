import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../src/core';
import {Planning} from '../src/planning';

function git(args:string[],cwd:string){
 const p=Bun.spawnSync(['/usr/bin/git',...args],{cwd,env:{...process.env,GIT_AUTHOR_NAME:'ADLC',GIT_AUTHOR_EMAIL:'adlc@example.test',GIT_COMMITTER_NAME:'ADLC',GIT_COMMITTER_EMAIL:'adlc@example.test'}});
 if(p.exitCode!==0)throw Error(p.stderr.toString());return p.stdout.toString().trim();
}

function repository(path:string,message='fixture'){
 git(['init','-q','-b','main'],path);writeFileSync(join(path,'README.md'),message);git(['add','.'],path);git(['commit','-qm','init'],path);
}

function configured(root:string,source:string){
 const path=join(root,'config.json');
 writeFileSync(path,JSON.stringify({repo:source,automation:{planningEnabled:true,orchestratorProject:'demo'},linear:{projectId:'project-1'}}));
 return path;
}

// Runs the real setup hook with a temporary HOME; ~/.ao/data exists only when a test creates it.
function runGate(home:string,source:string,cwd:string,config:string){
 const p=Bun.spawnSync([process.execPath,resolve(import.meta.dir,'../src/planning-gate.ts')],{cwd,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_WORKFLOW_CONFIG:config,AO_SOURCE_TREE_PATH:source,AO_WORKTREE_PATH:cwd}});
 return {code:p.exitCode,out:p.stdout.toString(),err:p.stderr.toString()};
}

function workerFixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-planning-gate-'))),home=join(root,'home'),source=join(root,'repo'),cwd=join(root,'worktree'),state=join(home,'Library','Application Support','ADLC Bridge','state.sqlite');
 mkdirSync(source);mkdirSync(home);repository(source);
 const s=new Store(state),id=s.enqueue('project-1','DEV-49','spec'),r=new Planning(s).reserve(id,'demo');
 s.db.exec('CREATE TABLE planning_dispatch (job TEXT PRIMARY KEY REFERENCES jobs(id),spec_hash TEXT NOT NULL,state TEXT NOT NULL,session_id TEXT,reason TEXT,client_id TEXT NOT NULL UNIQUE)');
 return {
  root,
  reserve:()=>s.db.query('INSERT INTO planning_dispatch(job,spec_hash,state,client_id) VALUES (?,?,?,?)').run(id,r.spec_hash,'dispatch_uncertain','adlc-plan-fixture'),
  run:()=>{
   s.close();
   git(['worktree','add','-q','-b',r.branch,cwd],source);
   return runGate(home,source,cwd,configured(root,source));
  }
 };
}

// Registers the native coordinator workspace in AO's read-only project/session registry.
// Mismatch options exist so a removed registry comparison cannot pass unnoticed.
function coordinatorFixture(options:{shared?:boolean;projectPath?:'source'|'other';workspace?:'empty'|'other'}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-coordinator-admission-'))),home=join(root,'home'),source=join(root,'repo'),dataRoot=join(home,'.ao','data'),cwd=join(dataRoot,'worktrees','demo','orchestrator','demo-orchestrator');
 mkdirSync(source);mkdirSync(dataRoot,{recursive:true});repository(source);
 const state=new Store(join(home,'Library','Application Support','ADLC Bridge','state.sqlite'));
 state.db.exec('CREATE TABLE planning_dispatch (job TEXT PRIMARY KEY REFERENCES jobs(id),spec_hash TEXT NOT NULL,state TEXT NOT NULL,session_id TEXT,reason TEXT,client_id TEXT NOT NULL UNIQUE)');
 state.close();
 const other=join(root,'other');
 if(options.projectPath==='other'||options.workspace==='other'){mkdirSync(other);repository(other,'other repository');}
 if(options.shared??true)git(['worktree','add','-q','-b','ao/demo-orchestrator',cwd],source);
 else{mkdirSync(cwd,{recursive:true});repository(cwd,'unrelated repository');}
 const db=new Database(join(dataRoot,'ao.db'));
 db.exec('CREATE TABLE projects(id TEXT,path TEXT,config TEXT,archived_at TEXT); CREATE TABLE sessions(project_id TEXT,kind TEXT,is_terminated INTEGER,workspace_path TEXT)');
 db.query('INSERT INTO projects VALUES(?,?,?,NULL)').run('demo',options.projectPath==='other'?other:source,'{}');
 db.query('INSERT INTO sessions VALUES(?,?,0,?)').run('demo','orchestrator',options.workspace==='other'?other:'');
 db.close();
 return {root,run:()=>runGate(home,source,cwd,configured(root,source))};
}

test('an absent AO registry does not block a worker holding a valid planning reservation',()=>{
 const f=workerFixture();try{
  f.reserve();const r=f.run();
  if(r.code!==0)throw Error(r.err);
  expect(r.code).toBe(0);
  expect(r.out).toContain('reserved planning stage admitted');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('an unreserved worker still fails setup when the AO registry is absent',()=>{
 const f=workerFixture();try{
  const r=f.run();
  expect(r.code).toBe(78);
  expect(r.err).toContain('No durable planning dispatch authorizes this branch');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('the configured gate admits a registered coordinator sharing the source repository',()=>{
 const f=coordinatorFixture({shared:true});try{
  const r=f.run();
  if(r.code!==0)throw Error(r.err);
  expect(r.code).toBe(0);
  expect(r.out).toContain('verified project coordinator admitted');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('the configured gate rejects a registered coordinator in a different repository',()=>{
 const f=coordinatorFixture({shared:false});try{
  const r=f.run();
  expect(r.code).toBe(78);
  expect(r.err).toContain('Coordinator repository mismatch');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('the configured gate rejects a registry project path outside the source repository',()=>{
 const f=coordinatorFixture({projectPath:'other'});try{
  const r=f.run();
  expect(r.code).toBe(78);
  expect(r.err).toContain('No durable planning dispatch authorizes this branch');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('the configured gate rejects a coordinator session workspace outside the managed path',()=>{
 const f=coordinatorFixture({workspace:'other'});try{
  const r=f.run();
  expect(r.code).toBe(78);
  expect(r.err).toContain('No durable planning dispatch authorizes this branch');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

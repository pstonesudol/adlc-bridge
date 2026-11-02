import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../src/core';
import {Planning} from '../src/planning';

function git(args:string[],cwd:string){
 const p=Bun.spawnSync(['/usr/bin/git',...args],{cwd,env:{...process.env,GIT_AUTHOR_NAME:'ADLC',GIT_AUTHOR_EMAIL:'adlc@example.test',GIT_COMMITTER_NAME:'ADLC',GIT_COMMITTER_EMAIL:'adlc@example.test'}});
 if(p.exitCode!==0)throw Error(p.stderr.toString());return p.stdout.toString().trim();
}

// Minimal configured project without ~/.ao/data: the AO registry is absent by design.
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-planning-gate-'))),home=join(root,'home'),source=join(root,'repo'),cwd=join(root,'worktree'),state=join(home,'Library','Application Support','ADLC Bridge','state.sqlite');
 mkdirSync(source);mkdirSync(home);
 git(['init','-q','-b','main'],source);writeFileSync(join(source,'README.md'),'fixture');git(['add','.'],source);git(['commit','-qm','init'],source);
 const s=new Store(state),id=s.enqueue('project-1','DEV-49','spec'),r=new Planning(s).reserve(id,'demo');
 s.db.exec('CREATE TABLE planning_dispatch (job TEXT PRIMARY KEY REFERENCES jobs(id),spec_hash TEXT NOT NULL,state TEXT NOT NULL,session_id TEXT,reason TEXT,client_id TEXT NOT NULL UNIQUE)');
 return {
  root,source,cwd,
  reserve:()=>s.db.query('INSERT INTO planning_dispatch(job,spec_hash,state,client_id) VALUES (?,?,?,?)').run(id,r.spec_hash,'dispatch_uncertain','adlc-plan-fixture'),
  run:()=>{
   s.close();
   const config=join(root,'config.json');
   writeFileSync(config,JSON.stringify({repo:source,automation:{planningEnabled:true,orchestratorProject:'demo'},linear:{projectId:'project-1'}}));
   git(['worktree','add','-q','-b',r.branch,cwd],source);
   const p=Bun.spawnSync([process.execPath,resolve(import.meta.dir,'../src/planning-gate.ts')],{cwd,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_WORKFLOW_CONFIG:config,AO_SOURCE_TREE_PATH:source,AO_WORKTREE_PATH:cwd}});
   return {code:p.exitCode,out:p.stdout.toString(),err:p.stderr.toString()};
  }
 };
}

test('an absent AO registry does not block a worker holding a valid planning reservation',()=>{
 const f=fixture();try{
  f.reserve();const r=f.run();
  if(r.code!==0)throw Error(r.err);
  expect(r.code).toBe(0);
  expect(r.out).toContain('reserved planning stage admitted');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('an unreserved worker still fails setup when the AO registry is absent',()=>{
 const f=fixture();try{
  const r=f.run();
  expect(r.code).toBe(78);
  expect(r.err).toContain('No durable planning dispatch authorizes this branch');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

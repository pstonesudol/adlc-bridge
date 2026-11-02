import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync,symlinkSync} from 'node:fs';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {setupPreview,writeSetupService,type RuntimeConfig} from '../src/setup';import {projectServiceLabel,legacyLabel,ProjectServices,assertDefinition} from '../src/project-services';import {Store} from '../src/core';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-preview-identity-'))),repo=join(root,'repo'),config=join(root,'project.json'),registry=join(root,'state.sqlite'),bin=join(root,'bin'),controller=join(root,'installed/src/cli.ts');
 for(const dir of [repo,bin,dirname(controller)])mkdirSync(dir,{recursive:true});writeFileSync(controller,'fixture controller');
 const executable=(path:string)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'#!/bin/sh\nprintf "1.4.2\\n"\n',{mode:0o755});};
 for(const tool of ['bun','ao','git','gh','docker'])executable(join(bin,tool));
 const uuid='00000000-0000-0000-0000-000000000001',c={version:1,name:'Fixture',repo,automation:{planningEnabled:false,orchestratorProject:'preview-identity-fixture'},requiredChecks:['CI'],linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid}};writeFileSync(config,JSON.stringify(c));
 const r:RuntimeConfig={version:1,platform:'launchd',projectConfig:config,controller,workingDirectory:dirname(controller),tools:Object.fromEntries(['bun','ao','git','gh','docker'].map(n=>[n,{path:join(bin,n),version:'1.4.2'}])),service:{label:projectServiceLabel(c.automation.orchestratorProject),path:join(root,'staged.plist'),interval:60,runAtLoad:false,stdout:join(root,'out'),stderr:join(root,'err')}};
 const preview=()=>setupPreview(c,r,()=>true,undefined,config,registry);
 return {root,repo,config,registry,bin,controller,c,r,executable,preview,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('preview rejects unsupported controller aliases before staging; named cli aliases retain canonical identity',()=>{
 const f=fixture();try{
  expect(f.preview().passed).toBe(true);const alias=join(f.root,'bridge.ts');symlinkSync(f.controller,alias);f.r.controller=alias;
  expect(f.preview().checks.find(c=>c.name==='controller')?.passed).toBe(false);expect(f.preview().passed).toBe(false);
  expect(()=>writeSetupService(f.c,f.r,undefined,f.config)).toThrow('Setup validation failed');expect(existsSync(f.r.service.path)).toBe(false);expect(existsSync(f.registry)).toBe(false);
  const named=join(f.root,'alias/cli.ts');mkdirSync(dirname(named));symlinkSync(f.controller,named);f.r.controller=named;
  expect(f.preview().passed).toBe(true);expect(()=>assertDefinition({Label:f.r.service.label,ProgramArguments:[process.execPath,named,'poll',f.config]},f.r.service.label,f.config,f.controller)).not.toThrow();
 }finally{f.close();}
});
test('preview enforces generated or existing registered label with read-only config/repository identity',()=>{
 const f=fixture();try{
  const generated=f.r.service.label;expect(f.preview().passed).toBe(true);expect(existsSync(f.registry)).toBe(false);
  for(const label of ['local.adlc.other',legacyLabel]){f.r.service.label=label;expect(f.preview().checks.find(c=>c.name==='service-label')?.passed).toBe(false);expect(f.preview().passed).toBe(false);}
  const s=new Store(f.registry);new ProjectServices(s).register(f.config,legacyLabel);s.close();const before=readFileSync(f.registry);
  expect(f.preview().passed).toBe(true);expect(readFileSync(f.registry)).toEqual(before);
  f.r.service.label=generated;expect(f.preview().passed).toBe(false);expect(readFileSync(f.registry)).toEqual(before);
  const copy=join(f.root,'copy.json');writeFileSync(copy,readFileSync(f.config));const changed=new Store(f.registry);changed.db.query('UPDATE project_services SET config=?').run(copy);changed.close();const changedBytes=readFileSync(f.registry);f.r.service.label=legacyLabel;
  expect(f.preview().checks.find(c=>c.name==='service-label')?.passed).toBe(false);expect(readFileSync(f.registry)).toEqual(changedBytes);expect(existsSync(f.r.service.path)).toBe(false);
  const collision=new Store(f.registry);collision.db.query('UPDATE project_services SET project=?,label=?').run('another-project',projectServiceLabel('another-project'));collision.close();f.r.service.label=generated;
  const collisionBytes=readFileSync(f.registry);expect(f.preview().passed).toBe(false);expect(readFileSync(f.registry)).toEqual(collisionBytes);
 }finally{f.close();}
});
for(const tool of ['git','gh','docker'])test(`preview rejects a PATH-shadowed ${tool} pin and accepts its canonical executable`,()=>{
 const f=fixture();try{
  const early=join(f.root,'early');f.executable(join(early,'bun'));f.r.tools.bun.path=join(early,'bun');f.executable(join(early,tool));
  const preview=f.preview();expect(preview.checks.find(c=>c.name===`${tool}-path`)?.passed).toBe(false);expect(preview.passed).toBe(false);
  expect(()=>writeSetupService(f.c,f.r,undefined,f.config)).toThrow('Setup validation failed');expect(existsSync(f.r.service.path)).toBe(false);
  rmSync(join(early,tool));expect(f.preview().passed).toBe(true);
  symlinkSync(f.r.tools[tool].path,join(early,tool));expect(f.preview().checks.find(c=>c.name===`${tool}-path`)?.passed).toBe(true);expect(f.preview().passed).toBe(true);
 }finally{f.close();}
});

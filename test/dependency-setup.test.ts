import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {tmpdir} from 'node:os';
import {Store} from '../src/core';
import {DependencySetup,setupInputs,installOffline,offlineSetupProgram,setupWorkerOwners,type SetupBinding} from '../src/dependency-setup';
import {validateDependencySetup} from '../src/dependency-setup-policy';
import {runVerification,validateVerification} from '../src/verification';

const policy={version:1 as const,runtime:'verification-container' as const,cwd:'.',lockfile:'package-lock.json' as const,manifests:['package.json','frontend/package.json'],cache:'/opt/npm-cache'};
function git(root:string,...args:string[]){const p=Bun.spawnSync(['git',...args],{cwd:root,stdout:'pipe',stderr:'pipe'});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString();}
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-setup-test-'))),repo=join(root,'repo'),tree=join(root,'tree');mkdirSync(repo);
 git(repo,'init');git(repo,'config','core.hooksPath',join(root,'hooks'));git(repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','initial');git(repo,'worktree','add','-b','worker',tree);
 mkdirSync(join(tree,'frontend'));writeFileSync(join(tree,'.gitignore'),'node_modules\n.adlc-dependencies-*\n');writeFileSync(join(tree,'package.json'),JSON.stringify({name:'honey-fixture',workspaces:['frontend']}));writeFileSync(join(tree,'frontend/package.json'),JSON.stringify({name:'frontend'}));
 writeFileSync(join(tree,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{name:'honey-fixture'},frontend:{name:'frontend'},'node_modules/frontend':{link:true,resolved:'frontend'}}}));
 git(tree,'add','.');git(tree,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','workspace');
 const s=new Store(join(root,'state.sqlite')),job=s.enqueue('project','issue','spec');
 const facts:SetupBinding={job,plan:'plan',spec:'spec',session:'worker',branch:'worker',worktree:tree,dispatch:'dispatch',grant:'grant',runtime:{docker:{path:'/trusted/docker',version:'1.2.3'}}};
 const c:any={repo,dependencySetup:policy,verification:{version:1,mode:'container',steps:[{cwd:'frontend',argv:['node','--version']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['frontend']}}};
 let installs=0;const io={facts:async()=>structuredClone(facts),install:async(input:any)=>{installs++;mkdirSync(join(input.destination,'0'));writeFileSync(join(input.destination,'0','package.json'),'{}');symlinkSync('../frontend',join(input.destination,'0','frontend'));}};
 const setup=new DependencySetup(s,io);
 return {root,repo,tree,s,job,c,facts,io,setup,installs:()=>installs,close(){s.close();rmSync(root,{recursive:true,force:true});}};
}
test('policy rejects traversal, implicit inputs, host runtime and cache mount paths',()=>{
 validateDependencySetup(policy);
 for(const bad of [{cwd:'../escape'},{runtime:'host'},{manifests:['package.json','../package.json']},{cache:'/tmp/cache'},{cache:'/opt/../cache'},{extra:true}])expect(()=>validateDependencySetup({...policy,...bad})).toThrow();
});
for(const staged of [false,true])test(`Honey Summer fresh linked worktree installs offline and preserves staged edits (${staged})`,async()=>{
 const f=fixture();try{
  if(staged){writeFileSync(join(f.tree,'frontend/story.txt'),'staged story');const lock=JSON.parse(readFileSync(join(f.tree,'package-lock.json'),'utf8'));lock.name='staged-lock';writeFileSync(join(f.tree,'package-lock.json'),JSON.stringify(lock));git(f.tree,'add','frontend/story.txt','package-lock.json');}
  const before=git(f.tree,'diff','--cached','--binary'),lock=readFileSync(join(f.tree,'package-lock.json')),hooks=git(f.tree,'config','--get-regexp','core.hooksPath')||'';
  expect(await f.setup.ensure(f.job,f.c)).toMatchObject({state:'ready'});
  expect(await new DependencySetup(f.s,f.io).ensure(f.job,f.c)).toMatchObject({state:'ready'});
  expect(await f.setup.ensure(f.job,f.c,true)).toMatchObject({state:'ready'});
  expect(f.installs()).toBe(1);expect(git(f.tree,'diff','--cached','--binary')).toBe(before);expect(readFileSync(join(f.tree,'package-lock.json'))).toEqual(lock);
  expect(git(f.tree,'config','--get-regexp','core.hooksPath')||'').toBe(hooks);
 }finally{f.close();}
});
test('blocked cache install retains staged edits and blocks duplicate setup after restart',async()=>{
 const f=fixture();try{
  writeFileSync(join(f.tree,'frontend/story.txt'),'staged story');git(f.tree,'add','frontend/story.txt');const before=git(f.tree,'diff','--cached','--binary');
  let calls=0;const io={...f.io,install:async()=>{calls++;throw Error('cache missing');}};
  await expect(new DependencySetup(f.s,io).ensure(f.job,f.c)).rejects.toThrow('Setup failed');
  await expect(new DependencySetup(f.s,io).ensure(f.job,f.c)).rejects.toThrow('Operator');
  expect(calls).toBe(1);expect(git(f.tree,'diff','--cached','--binary')).toBe(before);
 }finally{f.close();}
});
for(const change of ['manifest','cache','image','session'])test(`failed setup hold survives ${change} changes across service restart`,async()=>{
 const f=fixture();try{
  let calls=0;const io={...f.io,install:async()=>{calls++;throw Error('cache missing');}};
  await expect(new DependencySetup(f.s,io).ensure(f.job,f.c)).rejects.toThrow('Setup failed');
  if(change==='manifest'){const p=join(f.tree,'package.json'),m=JSON.parse(readFileSync(p,'utf8'));m.description='harmless edit';writeFileSync(p,JSON.stringify(m));}
  if(change==='cache')f.c.dependencySetup={...policy,cache:'/opt/replacement-cache'};
  if(change==='image')f.c.verification.container.image='registry.example/project@sha256:'+'b'.repeat(64);
  if(change==='session')f.facts.session='replacement';
  const reopened=new Store(join(f.root,'state.sqlite'));try{
   await expect(new DependencySetup(reopened,io).ensure(f.job,f.c)).rejects.toThrow('operator reconciliation required');
   expect(reopened.db.query('SELECT state FROM dependency_setups').all()).toEqual([{state:'blocked'}]);expect(calls).toBe(1);
  }finally{reopened.close();}
 }finally{f.close();}
});
test('a hold appearing during preflight is rechecked atomically before install reservation',async()=>{
 const f=fixture();try{
  let observations=0;f.setup.io.facts=async()=>{
   if(++observations===2)f.s.db.query("INSERT INTO dependency_setups VALUES ('other',?,?,'blocked','{}','prior failure',NULL)").run(f.job,f.tree);
   return structuredClone(f.facts);
  };
  await expect(f.setup.ensure(f.job,f.c)).rejects.toThrow('operator reconciliation required');expect(f.installs()).toBe(0);
 }finally{f.close();}
});
test('setup accepts the same registry-qualified immutable image as verification',async()=>{
 const f=fixture();try{
  f.c.verification.container.image='registry.example/project@sha256:'+'a'.repeat(64);validateVerification(f.c.verification);
  let installedImage='';const install=f.io.install;f.setup.io.install=async input=>{installedImage=input.image;await install(input);};
  expect(await f.setup.ensure(f.job,f.c)).toMatchObject({state:'ready'});expect(installedImage).toBe(f.c.verification.container.image);
  f.c.verification.container.image='registry.example/project:latest';await expect(f.setup.ensure(f.job,f.c)).rejects.toThrow('immutable');
 }finally{f.close();}
});
test('missing branch metadata is resolved before exclusive ownership is decided',async()=>{
 const rows={data:[{id:'owner',projectId:'project',isTerminated:false},{id:'other',projectId:'project',isTerminated:false}]};
 const calls:string[]=[];const detail=async(id:string)=>{calls.push(id);return {session:{id,projectId:'project',branch:id==='owner'?'worker':'different',isTerminated:false}};};
 expect((await setupWorkerOwners(rows,'project','worker',detail)).map(x=>x.id)).toEqual(['owner']);expect(calls).toEqual(['owner','other']);
 expect(await setupWorkerOwners({data:rows.data.slice(1)},'project','worker',detail)).toEqual([]);
 expect(await setupWorkerOwners(rows,'project','worker',async id=>({session:{id,projectId:'project',branch:'worker',isTerminated:false}}))).toHaveLength(2);
 await expect(setupWorkerOwners(rows,'project','worker',async()=>({session:{}}))).rejects.toThrow('Incomplete detailed');
 await expect(setupWorkerOwners(rows,'project','worker',async()=>{throw Error('unavailable');})).rejects.toThrow('unavailable');
});
test('offline npm uses separate empty user/global configuration without invoking npm',()=>{
 const written=new Map<string,string>();let calls=0;
 runInNewContext(offlineSetupProgram,{
  require:(name:string)=>{
   if(name==='fs')return {existsSync:(p:string)=>p==='/opt/cache',cpSync:()=>{},writeFileSync:(p:string,text:string)=>written.set(p,text)};
   if(name==='path')return {join};
   if(name==='child_process')return {spawnSync:(name:string,args:string[],options:any)=>{
    calls++;expect(name).toBe('npm');expect(args).toContain('--offline');expect(args).toContain('--ignore-scripts');
    const {npm_config_userconfig:user,npm_config_globalconfig:global}=options.env;expect(user).not.toBe(global);expect(written.get(user)).toBe('');expect(written.get(global)).toBe('');expect(user).toStartWith('/tmp/');expect(global).toStartWith('/tmp/');return {status:0};
   }};
   throw Error('unexpected module');
  },process:{argv:['node',JSON.stringify({cache:'/opt/cache',outputs:[]})],env:{PATH:'/runtime/bin'},exit:()=>{throw Error('unexpected exit');}},console,
 });
 expect(calls).toBe(1);
});
test('install script and symlink inputs fail before any install',async()=>{
 const f=fixture();try{
  writeFileSync(join(f.tree,'frontend/package.json'),JSON.stringify({name:'frontend',scripts:{prepare:'danger'}}));
  await expect(f.setup.ensure(f.job,f.c)).rejects.toThrow('Lifecycle');expect(f.installs()).toBe(0);
  rmSync(join(f.tree,'frontend/package.json'));symlinkSync('../package.json',join(f.tree,'frontend/package.json'));
  expect(()=>setupInputs(f.tree,policy)).toThrow('Symbolic');
 }finally{f.close();}
});
test('lockfile lifecycle flags and workspace globs block instead of widening input scope',()=>{
 const f=fixture();try{
  writeFileSync(join(f.tree,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/native':{hasInstallScript:true}}}));expect(()=>setupInputs(f.tree,policy)).toThrow('Lifecycle');
  writeFileSync(join(f.tree,'package.json'),JSON.stringify({workspaces:['*']}));expect(()=>setupInputs(f.tree,policy)).toThrow('workspace');
 }finally{f.close();}
});
test('check-only verification never installs, and changed dependencies never reuse readiness',async()=>{
 const f=fixture();try{
  await expect(f.setup.ensure(f.job,f.c,true)).rejects.toThrow('No verified');expect(f.installs()).toBe(0);
  await f.setup.ensure(f.job,f.c);writeFileSync(join(f.tree,'node_modules/package.json'),'changed');
  await expect(f.setup.ensure(f.job,f.c,true)).rejects.toThrow('changed dependencies');expect(f.installs()).toBe(1);
 }finally{f.close();}
});
test('identity changes during install prevent publication and consume the attempt',async()=>{
 const f=fixture();try{
  const install=f.io.install;f.setup.io.install=async input=>{await install(input);f.facts.session='replacement';};
  await expect(f.setup.ensure(f.job,f.c)).rejects.toThrow('changed during setup');
  expect(f.s.db.query('SELECT state FROM dependency_setups').get()).toEqual({state:'blocked'});
 }finally{f.close();}
});
test('interrupted install receipt is never replayed even with a new service instance',async()=>{
 const f=fixture();try{
  await f.setup.ensure(f.job,f.c);f.s.db.query("UPDATE dependency_setups SET state='installing',outputs=NULL").run();
  await expect(new DependencySetup(f.s,f.io).ensure(f.job,f.c)).rejects.toThrow('never replay');expect(f.installs()).toBe(1);
 }finally{f.close();}
});
test('verification refuses a failed setup guard before spawning a check',async()=>{
 const f=fixture();try{
  let calls=0;await expect(runVerification(f.tree,f.c.verification,(()=>{calls++;throw Error('must not spawn');}) as any,{projectRepo:f.repo,dependencySetup:policy,dependencyGuard:async()=>{throw Error('missing cache');}})).rejects.toThrow('missing cache');expect(calls).toBe(0);
 }finally{f.close();}
});
test('verification mounts prepared workspace dependencies read-only and rechecks the receipt',async()=>{
 const f=fixture();try{
  await f.setup.ensure(f.job,f.c);let argv:string[]=[],guards=0;
  let dependencyMount='';
  const result=await runVerification(f.tree,f.c.verification,((args:string[])=>{argv=args;dependencyMount=args.find(x=>x.endsWith('dst=/workspace/node_modules,readonly'))!;expect(dependencyMount).not.toContain(f.tree);const source=dependencyMount.split(',')[1].slice('src='.length);expect(readFileSync(join(source,'package.json'),'utf8')).toBe('{}');return {exited:Promise.resolve(0)};}) as any,{projectRepo:f.repo,docker:{path:'/trusted/docker',version:'1.2.3'},probeDocker:()=>true,dependencySetup:policy,dependencyGuard:async()=>{guards++;return f.setup.ensure(f.job,f.c,true);}});
  expect(result.passed).toBe(true);expect(guards).toBe(4);expect(dependencyMount).toContain('adlc-verification-');expect(argv[argv.indexOf('--network')+1]).toBe('none');
 }finally{f.close();}
});
for(const restore of [false,true])test(`verification excludes live worktree writers during a step (restored=${restore})`,async()=>{
 const f=fixture();try{
  await f.setup.ensure(f.job,f.c);let calls=0;
  const verify=()=>runVerification(f.tree,f.c.verification,((args:string[])=>{
   calls++;const mount=args.find(x=>x.endsWith('dst=/workspace/node_modules,readonly'))!,source=mount.split(',')[1].slice('src='.length);
   writeFileSync(join(f.tree,'node_modules/package.json'),'changed while check runs');
   expect(readFileSync(join(source,'package.json'),'utf8')).toBe('{}');
   if(restore)writeFileSync(join(f.tree,'node_modules/package.json'),'{}');
   return {exited:Promise.resolve(0)};
  }) as any,{projectRepo:f.repo,docker:{path:'/trusted/docker',version:'1.2.3'},probeDocker:()=>true,dependencySetup:policy,dependencyGuard:()=>f.setup.ensure(f.job,f.c,true)});
  if(restore)expect((await verify()).passed).toBe(true);else await expect(verify()).rejects.toThrow('changed dependencies');
  expect(calls).toBe(1);
 }finally{f.close();}
});
test('dependency mutation while copying cannot enter verification with an old receipt',async()=>{
 const f=fixture();try{
  await f.setup.ensure(f.job,f.c);let guards=0,calls=0;
  await expect(runVerification(f.tree,f.c.verification,(()=>{calls++;return {exited:Promise.resolve(0)};}) as any,{projectRepo:f.repo,docker:{path:'/trusted/docker',version:'1.2.3'},probeDocker:()=>true,dependencySetup:policy,dependencyGuard:async()=>{
   // Deliberately simulate a writer just after the initial source hash was read.
   const proof=await f.setup.ensure(f.job,f.c,true);
   if(++guards===1)writeFileSync(join(f.tree,'node_modules/package.json'),'transient mutation');
   else writeFileSync(join(f.tree,'node_modules/package.json'),'{}');
   return proof;
  }})).rejects.toThrow('snapshot differs');expect(calls).toBe(0);
 }finally{f.close();}
});
test('post-step snapshot fingerprint rejects private dependency changes even when live outputs match',async()=>{
 const f=fixture();try{
  await f.setup.ensure(f.job,f.c);
  await expect(runVerification(f.tree,f.c.verification,((args:string[])=>{
   const mount=args.find(x=>x.endsWith('dst=/workspace/node_modules,readonly'))!,source=mount.split(',')[1].slice('src='.length);
   writeFileSync(join(source,'package.json'),'changed snapshot');return {exited:Promise.resolve(0)};
  }) as any,{projectRepo:f.repo,docker:{path:'/trusted/docker',version:'1.2.3'},probeDocker:()=>true,dependencySetup:policy,dependencyGuard:()=>f.setup.ensure(f.job,f.c,true)})).rejects.toThrow('snapshot differs');
 }finally{f.close();}
});
test('offline container program and invocation prohibit scripts, network, pulls and host credentials',async()=>{
 const f=fixture();try{
  let argv:string[]=[];const spawn=((args:string[],options:any)=>{argv=args;expect(options.env).toEqual({PATH:'/usr/bin:/bin'});return {exited:Promise.resolve(0)};}) as any;
  // Version probe is deliberately separate from the injected install executor.
  // A tiny temporary executable simulates that trusted --version boundary.
  const tool=join(f.root,'docker');writeFileSync(tool,'#!/bin/sh\necho Docker version 1.2.3, build fixture\n',{mode:0o700});
  await installOffline({files:setupInputs(f.tree,policy).files,outputs:['node_modules'],policy,image:f.c.verification.container.image,docker:{path:tool,version:'1.2.3'},destination:f.root},spawn);
  expect(argv).toContain('--network');expect(argv[argv.indexOf('--network')+1]).toBe('none');expect(argv).toContain('--pull=never');expect(argv).toContain('--read-only');
  expect(offlineSetupProgram).toContain("'--ignore-scripts','--offline'");expect(offlineSetupProgram).toContain('Lifecycle script prerequisite');
  expect(argv.join(' ')).not.toContain('/var/run/docker.sock');
 }finally{f.close();}
});

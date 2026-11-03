import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {turnBarrier} from '../src/turn-submission';
import {UpdateManager,validateUpdatePolicy,classifyChanges,classifyChangedFiles,changedFiles,repositoryFromRemote,stageCandidate,candidateCompatibility,evaluateCheckRuns,writeUpdatePolicy,type UpdateIO,type UpdatePolicy} from '../src/update';
import {installBridge} from '../src/install';

const repo='acme/adlc';
test('verification rejects malformed objects and automatic policies without named checks',()=>{
 for(const verification of [null,[],42,'CI'])expect(()=>policy({verification})).toThrow('JSON object');
 for(const verification of [{},{requiredCheck:['CI']},{requiredChecks:[]}])expect(()=>policy({mode:'automatic',verification})).toThrow('at least one');
});
test('schema rollback requires a baseline captured before intake restarts',async()=>{
 for(const baseline of [null,'before']){
  const f=fixture({files:['src/cli.ts','patches/001.sql'],migration:{required:true,compatible:true,rollbackSafe:true,detail:'compatible'}});try{
   let db:string|null=baseline;f.io.dbHash=()=>db;
   const project=f.io.stack.project;f.io.stack.project=async(action,id)=>{const result=await project(action,id);if(action==='start')db='after';return result;};
   await f.manager.apply();const record=JSON.parse(readFileSync(join(f.state,'update-state.json'),'utf8'));
   expect(record.dbHash).toBe(baseline);expect(record.rollbackSafe).toBe(baseline!==null);
   await expect(f.manager.rollback()).rejects.toThrow(baseline===null?'Rollback is unsafe':'Database changed');
  }finally{f.close();}
 }
});
test('apply refuses staged content changed by candidate tests',async()=>{
 const f=fixture();try{
  let modified=false;const stage=f.io.stage;
  f.io.stage=async(p,c)=>({...await stage(p,c),version:modified?'changed':'v2'});
  f.io.tests=async()=>{modified=true;return {passed:true,skipped:false,detail:'passed'};};
  await expect(f.manager.apply()).rejects.toThrow('Staged candidate changed');expect(f.installs).toEqual([]);
 }finally{f.close();}
});
test('successful backend activation retains accumulated intent fields',async()=>{
 const f=fixture({files:['src/cli.ts','src/serve-orchestrator.py']});try{
  await f.manager.apply();expect(JSON.parse(readFileSync(join(f.state,'update-intent.json'),'utf8'))).toMatchObject({stage:'completed',installed:true,backendStopped:true,priorServices:[{project:'one',loaded:true},{project:'two',loaded:false}]});
 }finally{f.close();}
});
test('rollback rejects a traversal path even when the external CLI exists',async()=>{
 const f=fixture();try{
  await f.manager.apply();mkdirSync(join(f.root,'source','src'),{recursive:true});writeFileSync(join(f.root,'source','src/cli.ts'),'external');
  const path=join(f.state,'update-state.json'),record=JSON.parse(readFileSync(path,'utf8'));
  writeFileSync(path,JSON.stringify({...record,previousSource:join(f.state,'versions')+'/../../source'}),{mode:0o600});
  await expect(f.manager.rollback()).rejects.toThrow('Previous verified snapshot is unavailable');expect(f.installs).toHaveLength(1);
 }finally{f.close();}
});
test('hot rollback succeeds without stopping the backend',async()=>{
 const f=fixture();try{
  await f.manager.apply();expect(await f.manager.rollback()).toMatchObject({rolledBack:true,version:'v1'});
  expect(f.installs.at(-1)).toBe(join(f.state,'versions','v1'));expect(f.calls).not.toContain('backend:stop');
 }finally{f.close();}
});
const policy=(over:any={})=>validateUpdatePolicy({version:1,repository:repo,remote:'git@github.com:acme/adlc.git',ref:'main',refKind:'branch',mode:'manual',...over});
function fixture(over:any={}){
 const root=mkdtempSync(join(tmpdir(),'adlc-update-')),state=join(root,'ADLC Bridge'),v1=join(state,'versions','v1');
 mkdirSync(join(v1,'src'),{recursive:true});
 writeFileSync(join(v1,'src/cli.ts'),'old cli');writeFileSync(join(v1,'manifest.json'),JSON.stringify({version:'v1',files:['src/cli.ts']}),{mode:0o600});
 writeFileSync(join(state,'installation.json'),JSON.stringify({source:join(root,'source'),version:'v1',cli:join(v1,'src/cli.ts'),launcher:join(root,'adlc')}),{mode:0o600});
 writeUpdatePolicy(policy(over.policy),state);
 const services:Record<string,boolean>={one:true,two:false},calls:string[]=[],installs:string[]=[],notifications:string[]=[];
 let blockers:{session:string;reason:string}[]=over.blockers??[],backendReady=true,backendLoaded=true,managed=true,failInstall=false,backendStartFailures=over.failBackendStarts??0,serviceStartFailures=over.failServiceStartOnce?1:0,candidate=over.candidate??'a'.repeat(40),checks=over.checks??{passed:true,names:['CI'],detail:'ok'},tests=over.tests??{passed:true,skipped:true,detail:'skipped'};
 const turns=turnBarrier(state);
 const stack:any={turns,projects:async()=>Object.keys(services).map(project=>({project})),project:async(action:string,id:string)=>{calls.push(`${action}:${id}`);if(action==='service-status')return {project:id,loaded:services[id]};if(action==='stop')services[id]=false;if(action==='start'){await turns.run(async()=>{},'start');if(over.failStart||serviceStartFailures-->0)throw Error('start failed');services[id]=true;}return {project:id,loaded:services[id]};},backend:async()=>({ready:backendReady,loaded:backendLoaded,managed,pid:1}),backendStart:async()=>{calls.push('backend:start');if(backendStartFailures-->0){backendLoaded=true;throw Error('backend start failed');}backendReady=true;backendLoaded=true;},backendStop:async()=>{calls.push('backend:stop');backendReady=false;backendLoaded=false;},blockers:async()=>{if(over.blockersError)throw new Error(over.blockersError);return blockers;}};
 const io:UpdateIO={state:()=>state,resolve:async p=>({commit:typeof candidate==='function'?candidate():candidate,ref:'refs/heads/main',source:p.remote}),stage:async(p,c)=>{if(over.stageCommit)return {root:join(root,'stage'),commit:over.stageCommit,version:'v2',files:['src/cli.ts']};return {root:join(root,'stage'),commit:c.commit,version:over.version??'v2',files:over.files??['src/cli.ts']};},checks:async()=>checks,tests:async()=>tests,compatibility:()=>({compatible:over.incompatible?false:true,detail:over.incompatible?'incompatible candidate':'compatible'}),reattachment:async()=>({safe:over.reattachment??true,detail:over.reattachment===false?'controller attachment unverified':'reattachment verified'}),stack,install:async(_apply:boolean,source:string)=>{installs.push(source);calls.push(`install:${source}`);if(failInstall){failInstall=false;throw Error('install failed');}return {installed:true};},launcher:()=>join(root,'adlc'),migrations:async()=>over.migration,dbHash:()=>over.dbHash??'db1',notify:(event,key)=>notifications.push(`${event}:${key}`),now:()=>over.now??1000};
 return {root,state,services,calls,installs,notifications,io,manager:new UpdateManager(io,turnBarrier(state)),policy:policy(over.policy),setBlockers:(value:any)=>blockers=value,setBackend:(ready:boolean,isManaged=true)=>{backendReady=ready;managed=isManaged;},setFail:(value:boolean)=>failInstall=value,setCandidate:(value:any)=>candidate=value,setChecks:(value:any)=>checks=value,setTests:(value:any)=>tests=value,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('update policy is manual by default and rejects credential or trust mismatches',()=>{
 expect(policy().mode).toBe('manual');
 expect(policy().maintenance.blockIntakeDuringActivation).toBe(true);
 for(const bad of [{remote:'https://token@github.com/acme/adlc.git'},{remote:'https://github.com/other/adlc.git'},{ref:'-main'},{ref:'main..next'},{mode:'sometimes'},{remote:'git@example.com:acme/adlc.git'}])expect(()=>validateUpdatePolicy({version:1,repository:repo,remote:'git@github.com:acme/adlc.git',...bad})).toThrow();
 expect(repositoryFromRemote('https://github.com/acme/adlc.git')).toBe(repo);
});
test('classification separates hot bridge, backend and schema changes',()=>{
 expect(classifyChanges(['src/cli.ts'],['src/cli.ts','src/core.ts'])).toBe('hot');
 expect(classifyChanges(['src/cli.ts'],['src/cli.ts','src/serve-orchestrator.py'])).toBe('backend');
 expect(classifyChanges(['src/cli.ts'],['src/cli.ts','patches/001.sql'])).toBe('schema');
});
test('incomplete check-run pages fail closed',()=>{
 const incomplete=evaluateCheckRuns(policy(),{total_count:2,check_runs:[{name:'CI',status:'completed',conclusion:'success'}]});
 expect(incomplete).toMatchObject({passed:false,detail:'Check evidence is incomplete for the exact candidate'});
 expect(evaluateCheckRuns(policy(),{total_count:1,check_runs:[{name:'CI',status:'completed',conclusion:'success'}]}).passed).toBe(true);
});
test('content-only backend changes are detected from snapshot bytes',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-update-diff-'));try{
  const before=join(root,'before'),after=join(root,'after');for(const dir of [before,after])mkdirSync(join(dir,'src'),{recursive:true});
  writeFileSync(join(before,'src/serve-orchestrator.py'),'old');writeFileSync(join(after,'src/serve-orchestrator.py'),'new');
  writeFileSync(join(before,'src/cli.ts'),'same');writeFileSync(join(after,'src/cli.ts'),'same');
  const changed=changedFiles(before,after,['src/cli.ts','src/serve-orchestrator.py'],['src/cli.ts','src/serve-orchestrator.py']);
  expect(changed).toEqual(['src/serve-orchestrator.py']);expect(classifyChangedFiles(changed)).toBe('backend');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('check and preview pin the exact candidate without activating anything',async()=>{
 const f=fixture();try{
  const checked=await f.manager.check();expect(checked).toMatchObject({candidate:{commit:'a'.repeat(40)},updateAvailable:true,policyMode:'manual'});
  const preview=await f.manager.preview();expect(preview.ready).toBe(true);expect(preview).toMatchObject({classification:'hot',installedVersion:'v1',checks:{passed:true},tests:{skipped:true}});
  expect(f.installs).toEqual([]);expect(f.calls).toEqual([]);
 }finally{f.close();}
});
test('active, queued and unknown worker activity defer the update and restore prior intake',async()=>{
 const f=fixture({blockers:[{session:'worker',reason:'running turn'}]});try{
  const deferred=await f.manager.apply();expect(deferred).toMatchObject({deferred:true});
  expect(f.installs).toEqual([]);expect(f.services).toEqual({one:true,two:false});expect(f.calls).toEqual(['service-status:one','service-status:two','stop:one','start:one']);
  const intent=JSON.parse(readFileSync(join(f.state,'update-intent.json'),'utf8'));expect(intent.stage).toBe('deferred');
  expect(f.manager.turns.isPaused()).toBe(false);expect(f.notifications.filter(x=>x.startsWith('waiting-for-idle:'))).toHaveLength(1);
 }finally{f.close();}
 const unknown=fixture({blockersError:'activity unavailable'});try{
  const deferred=await unknown.manager.apply();expect(deferred.deferred).toBe(true);expect(deferred.reason).toContain('unknown');expect(unknown.installs).toEqual([]);expect(unknown.services.one).toBe(true);
 }finally{unknown.close();}
});
test('failed checks, tests and dirty staging fail closed before activation',async()=>{
 const f=fixture({checks:{passed:false,names:[],detail:'required check missing'}});try{
  const preview=await f.manager.preview();expect(preview.ready).toBe(false);await expect(f.manager.apply()).rejects.toThrow('not ready');expect(f.installs).toEqual([]);
  f.setChecks({passed:true,names:['CI'],detail:'ok'});f.setTests({passed:false,skipped:false,detail:'tests failed'});expect((await f.manager.preview()).ready).toBe(false);
  f.setTests({passed:true,skipped:true,detail:'skipped'});f.io.stage=async()=>({root:join(f.root,'stage'),commit:'b'.repeat(40),version:'v2',files:['src/cli.ts']});
  await expect(f.manager.preview()).rejects.toThrow('candidate is now ambiguous');
 }finally{f.close();}
});
test('source changes between staging and activation are refused without installing',async()=>{
 const f=fixture();try{
  let calls=0;const first='a'.repeat(40),second='b'.repeat(40);f.setCandidate(()=>++calls===1?first:second);
  await expect(f.manager.apply()).rejects.toThrow('changed during activation');expect(f.installs).toEqual([]);expect(f.services.one).toBe(true);
 }finally{f.close();}
});
test('uncertain delivery and configuration incompatibility fail closed before activation',async()=>{
 const f=fixture({blockers:[{session:'worker',reason:'uncertain delivery'}]});try{
  const deferred=await f.manager.apply();expect(deferred).toMatchObject({deferred:true});expect(deferred.reason).toContain('uncertain delivery');expect(f.installs).toEqual([]);expect(f.services.one).toBe(true);
 }finally{f.close();}
 const incompatible=fixture({incompatible:true});try{const preview=await incompatible.manager.preview();expect(preview.ready).toBe(false);expect(preview.blockers).toContain('incompatible candidate');await expect(incompatible.manager.apply()).rejects.toThrow('not ready');expect(incompatible.installs).toEqual([]);}finally{incompatible.close();}
});
test('isolated staging pins the exact commit and refuses a modified checkout',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-update-git-'));try{
  const remote=join(root,'remote'),state=join(root,'state');mkdirSync(join(remote,'src'),{recursive:true});writeFileSync(join(remote,'src/cli.ts'),'candidate bytes');
  const git=(args:string[])=>Bun.spawnSync(['git',...args],{cwd:remote,stdout:'pipe',stderr:'pipe'});
  expect(git(['init','--quiet']).exitCode).toBe(0);expect(git(['add','.']).exitCode).toBe(0);
  expect(git(['-c','user.name=Test','-c','user.email=test@example.com','commit','--quiet','-m','candidate']).exitCode).toBe(0);
  const commit=Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:remote,stdout:'pipe'}).stdout.toString().trim();
  const staged=await stageCandidate({...policy(),remote} as UpdatePolicy,{commit,ref:'refs/heads/main',source:remote},state);
  expect(staged).toMatchObject({commit,files:['src/cli.ts']});expect(readFileSync(join(staged.root,'src/cli.ts'),'utf8')).toBe('candidate bytes');
  expect(candidateCompatibility({...staged,files:['src/cli.ts']}).compatible).toBe(false);
  writeFileSync(join(staged.root,'src/cli.ts'),'modified');await expect(stageCandidate({...policy(),remote} as UpdatePolicy,{commit,ref:'refs/heads/main',source:remote},state)).rejects.toThrow('modified');
  writeFileSync(join(staged.root,'src/cli.ts'),'candidate bytes');
  writeFileSync(join(staged.root,'.git/info/exclude'),'src/generated.ts\n');writeFileSync(join(staged.root,'src/generated.ts'),'ignored bytes');
  await expect(stageCandidate({...policy(),remote} as UpdatePolicy,{commit,ref:'refs/heads/main',source:remote},state)).rejects.toThrow('modified');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('a deferral whose intake restoration fails remains paused for operator action',async()=>{
 const f=fixture({blockers:[{session:'worker',reason:'running turn'}],failStart:true});try{
  await expect(f.manager.apply()).rejects.toThrow('prior intake could not be fully restored');
  expect(JSON.parse(readFileSync(join(f.state,'update-intent.json'),'utf8')).stage).toBe('operator-action-required');
  expect(f.manager.turns.isPaused()).toBe(true);expect(f.notifications.some(x=>x.startsWith('operator-action-required:'))).toBe(true);
 }finally{f.close();}
});
test('installation preserves explicit prior snapshot roots instead of redirecting',async()=>{
 const f=fixture();try{
  const v2=join(f.state,'versions','v2');mkdirSync(join(v2,'src'),{recursive:true});writeFileSync(join(v2,'src/cli.ts'),'v2');writeFileSync(join(v2,'manifest.json'),JSON.stringify({version:'v2',files:['src/cli.ts']}),{mode:0o600});
  writeFileSync(join(f.state,'installation.json'),JSON.stringify({source:join(f.root,'source'),version:'v2',cli:join(v2,'src/cli.ts'),launcher:join(f.root,'adlc')}),{mode:0o600});
  const result=await installBridge(false,join(f.state,'versions','v1'),join(f.root,'adlc'),{state:()=>f.state,home:()=>f.root,registeredProjects:async()=>[]});
  expect(result.source).toBe(join(f.state,'versions','v1'));
 }finally{f.close();}
});
test('an automatic attempt starts the cadence window even when it defers',async()=>{
 const f=fixture({policy:{mode:'automatic',cadenceSeconds:60,verification:{requiredChecks:['CI']}},blockers:[{session:'s',reason:'busy'}]});try{
  expect(await f.manager.apply({automatic:true})).toMatchObject({deferred:true});
  expect(existsSync(join(f.state,'update-auto.json'))).toBe(true);
  await f.manager.check();
  expect(await f.manager.apply({automatic:true})).toEqual({skipped:true,reason:'Update cadence has not elapsed'});
  expect(f.installs).toEqual([]);
 }finally{f.close();}
});
test('automatic adoption requires explicit opt-in and cadence, and never schedules itself',async()=>{
 const f=fixture();try{
  await expect(f.manager.apply({automatic:true})).rejects.toThrow('not enabled');expect(f.installs).toEqual([]);
  rmSync(join(f.state,'update-policy.json'));writeUpdatePolicy(policy({mode:'automatic',cadenceSeconds:60,verification:{requiredChecks:['CI']}}),f.state);
  writeFileSync(join(f.state,'update-auto.json'),JSON.stringify({attemptedAt:new Date(1000).toISOString()}),{mode:0o600});
  await f.manager.check();const skipped=await f.manager.apply({automatic:true});expect(skipped).toEqual({skipped:true,reason:'Update cadence has not elapsed'});
  const later=fixture({now:Date.now()+3600000,policy:{mode:'automatic',cadenceSeconds:60,verification:{requiredChecks:['CI']}}});try{writeFileSync(join(later.state,'update-auto.json'),JSON.stringify({attemptedAt:new Date(0).toISOString()}),{mode:0o600});expect((await later.manager.apply({automatic:true})).activated).toBe(true);}finally{later.close();}
 }finally{f.close();}
});
test('concurrent polls and interrupted intents never double-activate',async()=>{
 const f=fixture();try{
  mkdirSync(join(f.state,'update.lock'));await expect(f.manager.apply()).rejects.toThrow('in progress');rmSync(join(f.state,'update.lock'),{recursive:true});
  writeFileSync(join(f.state,'update-intent.json'),JSON.stringify({version:1,stage:'installing',candidate:'a'.repeat(40),fromVersion:'v1',classification:'hot',priorServices:[],backendStopped:false,installed:false,startedAt:'x',updatedAt:'x'}),{mode:0o600});
  await expect(f.manager.apply()).rejects.toThrow('interrupted');expect(f.installs).toEqual([]);const status=await f.manager.status();expect(status.pending.reason).toContain('interrupted');
 }finally{f.close();}
});
test('installed version changes after preview are rejected under the update lock',async()=>{
 const f=fixture();try{
  f.io.checks=async()=>{
   const v2=join(f.state,'versions','v2');mkdirSync(join(v2,'src'),{recursive:true});writeFileSync(join(v2,'src/cli.ts'),'v2');writeFileSync(join(v2,'manifest.json'),JSON.stringify({version:'v2',files:['src/cli.ts']}),{mode:0o600});
   writeFileSync(join(f.state,'installation.json'),JSON.stringify({source:join(f.root,'source'),version:'v2',cli:join(v2,'src/cli.ts'),launcher:join(f.root,'adlc')}),{mode:0o600});
   return {passed:true,names:['CI'],detail:'ok'};
  };
  await expect(f.manager.apply()).rejects.toThrow('Installed version changed after preview');expect(f.installs).toEqual([]);expect(f.services.one).toBe(true);
 }finally{f.close();}
});
test('activation restores exact prior per-project service states and verifies backend readiness',async()=>{
 const f=fixture();try{
  const result=await f.manager.apply();expect(result).toMatchObject({activated:true,classification:'hot'});
  expect(f.calls).toEqual(['service-status:one','service-status:two','stop:one',`install:${join(f.root,'stage')}`,'start:one','service-status:one']);expect(f.services).toEqual({one:true,two:false});
  expect(f.installs).toEqual([join(f.root,'stage')]);expect(f.manager.turns.isPaused()).toBe(false);
 }finally{f.close();}
});
test('backend changes use the supported graceful restart and verify it',async()=>{
 const f=fixture({files:['src/cli.ts','src/serve-orchestrator.py']});try{
  const result=await f.manager.apply();expect(result.classification).toBe('backend');expect(f.calls).toContain('backend:stop');expect(f.calls).toContain('backend:start');expect(f.calls.indexOf('backend:start')).toBeGreaterThan(f.calls.indexOf('backend:stop'));
 }finally{f.close();}
 const unverified=fixture({files:['src/cli.ts','src/serve-orchestrator.py'],reattachment:false});try{
  const deferred=await unverified.manager.apply();expect(deferred).toMatchObject({deferred:true});expect(deferred.reason).toContain('unverified');expect(unverified.installs).toEqual([]);expect(unverified.services.one).toBe(true);
 }finally{unverified.close();}
 const shared=fixture({files:['src/cli.ts','src/serve-orchestrator.py']});try{shared.setBackend(true,false);await expect(shared.manager.apply()).rejects.toThrow('not ready for a guarded backend restart');expect(shared.installs).toEqual([]);expect(shared.services.one).toBe(true);}finally{shared.close();}
});
test('backend recovery stops before restoring files and starts afterwards',async()=>{
 const f=fixture({files:['src/cli.ts','src/serve-orchestrator.py'],failBackendStarts:1});try{
  await expect(f.manager.apply()).rejects.toThrow('Update failed');
  const installedStage=`install:${join(f.root,'stage')}`,installedPrior=`install:${join(f.state,'versions','v1')}`;
  expect(f.installs).toEqual([join(f.root,'stage'),join(f.state,'versions','v1')]);
  expect(f.calls.filter(x=>x==='backend:stop')).toHaveLength(2);
  expect(f.calls.lastIndexOf('backend:stop')).toBeLessThan(f.calls.indexOf(installedPrior));
  expect(f.calls.indexOf('backend:stop')).toBeLessThan(f.calls.indexOf(installedStage));
  expect(f.calls.indexOf('backend:start')).toBeGreaterThan(f.calls.indexOf(installedStage));
  expect(f.calls.lastIndexOf('backend:start')).toBeGreaterThan(f.calls.indexOf(installedPrior));
  expect(f.services.one).toBe(true);
 }finally{f.close();}
});
test('backend recovery stops the candidate before restoring and starts the prior runtime',async()=>{
 const f=fixture({files:['src/cli.ts','src/serve-orchestrator.py'],failServiceStartOnce:true});try{
  await expect(f.manager.apply()).rejects.toThrow('Update failed');
  const stops=f.calls.filter(x=>x==='backend:stop'),starts=f.calls.filter(x=>x==='backend:start');
  expect(stops).toHaveLength(2);expect(starts).toHaveLength(2);
  expect(f.calls.lastIndexOf('backend:stop')).toBeLessThan(f.calls.indexOf(`install:${join(f.state,'versions','v1')}`));
  expect(f.calls.lastIndexOf('backend:start')).toBeGreaterThan(f.calls.indexOf(`install:${join(f.state,'versions','v1')}`));
  expect(f.services.one).toBe(true);expect(JSON.parse(readFileSync(join(f.state,'update-intent.json'),'utf8')).stage).toBe('rolled-back');
 }finally{f.close();}
});
test('failed activation rolls back files and services, while unsafe rollback preserves evidence and blocks intake',async()=>{
 const f=fixture();try{
  f.setFail(true);await expect(f.manager.apply()).rejects.toThrow('Update failed');expect(f.installs).toEqual([join(f.root,'stage'),join(f.state,'versions','v1')]);expect(f.services.one).toBe(true);
  expect(JSON.parse(readFileSync(join(f.state,'update-intent.json'),'utf8')).stage).toBe('rolled-back');expect(f.manager.turns.isPaused()).toBe(false);
 }finally{f.close();}
 const unsafe=fixture({files:['src/cli.ts','patches/001.sql'],migration:{required:true,compatible:true,rollbackSafe:false,detail:'irreversible migration'}});try{
  unsafe.setFail(true);await expect(unsafe.manager.apply()).rejects.toThrow('Rollback is unsafe');expect(unsafe.manager.turns.isPaused()).toBe(true);expect(JSON.parse(readFileSync(join(unsafe.state,'update-intent.json'),'utf8')).stage).toBe('operator-action-required');
 }finally{unsafe.close();}
});
test('schema changes require explicit compatible migration evidence',async()=>{
 const missing=fixture({files:['src/cli.ts','patches/001.sql']});try{expect((await missing.manager.preview()).blockers.join(' ')).toContain('explicit migration compatibility');await expect(missing.manager.apply()).rejects.toThrow('not ready');}finally{missing.close();}
 const incompatible=fixture({files:['src/cli.ts','patches/001.sql'],migration:{required:true,compatible:false,rollbackSafe:true,detail:'schema mismatch'}});try{expect((await incompatible.manager.preview()).blockers.join(' ')).toContain('not compatible');}finally{incompatible.close();}
});
test('rollback restores the prior verified snapshot and refuses after incompatible database work',async()=>{
 const f=fixture({files:['src/cli.ts','patches/001.sql'],migration:{required:true,compatible:true,rollbackSafe:true,detail:'reversible'}});try{
  await f.manager.apply();const before=f.notifications.length;const result=await f.manager.rollback();expect(result).toMatchObject({rolledBack:true,version:'v1'});
  expect(f.installs.at(-1)).toBe(join(f.state,'versions','v1'));expect(f.services.one).toBe(true);expect(f.notifications.length).toBeGreaterThan(before);
  expect(JSON.parse(readFileSync(join(f.state,'update-intent.json'),'utf8')).stage).toBe('rolled-back');
  const installations=f.installs.length;await expect(f.manager.rollback()).rejects.toThrow('No activated update');expect(f.installs).toHaveLength(installations);
 }finally{f.close();}
 const changed=fixture({files:['src/cli.ts','patches/001.sql'],migration:{required:true,compatible:true,rollbackSafe:true,detail:'reversible'},dbHash:'db1'});try{
  await changed.manager.apply();changed.io.dbHash=()=> 'db2';await expect(changed.manager.rollback()).rejects.toThrow('Database changed after activation');expect(changed.installs).toHaveLength(1);
 }finally{changed.close();}
});
test('rollback acquires the update lock before reading or changing state',async()=>{
 const f=fixture();try{
  await f.manager.apply();const installations=f.installs.length;mkdirSync(join(f.state,'update.lock'));
  await expect(f.manager.rollback()).rejects.toThrow('in progress');
  expect(existsSync(join(f.state,'update-state.json'))).toBe(true);expect(f.installs).toHaveLength(installations);
 }finally{f.close();}
});
test('rollback rejects an empty or foreign previous source',async()=>{
 const f=fixture();try{
  await f.manager.apply();const path=join(f.state,'update-state.json'),state=JSON.parse(readFileSync(path,'utf8'));
  writeFileSync(path,JSON.stringify({...state,previousSource:''}),{mode:0o600});await expect(f.manager.rollback()).rejects.toThrow('Previous verified snapshot is unavailable');
  writeFileSync(path,JSON.stringify({...state,previousSource:f.root}),{mode:0o600});await expect(f.manager.rollback()).rejects.toThrow('Previous verified snapshot is unavailable');
  expect(f.installs).toHaveLength(1);
 }finally{f.close();}
});
test('rollback of a hot update is allowed and an unavailable previous snapshot fails closed',async()=>{
 const f=fixture();try{
  await f.manager.apply();rmSync(join(f.state,'versions','v1'),{recursive:true,force:true});await expect(f.manager.rollback()).rejects.toThrow('Previous verified snapshot is unavailable');
 }finally{f.close();}
 const schema=fixture({files:['src/cli.ts','patches/001.sql'],migration:{required:true,compatible:true,rollbackSafe:false,detail:'irreversible'}});try{schema.setFail(true);await expect(schema.manager.apply()).rejects.toThrow('Rollback is unsafe');expect(schema.installs).toEqual([join(schema.root,'stage')]);expect(schema.manager.turns.isPaused()).toBe(true);}finally{schema.close();}
});

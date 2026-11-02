import {test,expect} from 'bun:test';import {Store} from '../src/core';import {ProjectServices,projectServiceLabel,assertDefinition,legacyLabel} from '../src/project-services';import {serviceDefinition} from '../src/init';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {readDefinition} from '../src/project-services';
import {serviceSettings} from '../src/service-settings';
import {reloadService} from '../src/service-control';
import {acknowledgePoll} from '../src/poll-process';
import {turnBarrier} from '../src/turn-submission';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'adlc-projects-')),s=new Store(':memory:'),registry=new ProjectServices(s);
 const config=(id:string,linear:string)=>{const repo=join(dir,id);mkdirSync(repo);const path=join(dir,id+'.json');writeFileSync(path,JSON.stringify({version:1,name:id,repo,requiredChecks:['CI'],automation:{orchestratorProject:id},linear:{projectId:linear,teamId:'00000000-0000-0000-0000-000000000001',readyStateId:'00000000-0000-0000-0000-000000000002',readyLabelId:'00000000-0000-0000-0000-000000000003'}}));return path;};return {dir,s,registry,config,close:()=>{s.close();rmSync(dir,{recursive:true,force:true});}};}
test('separate projects retain independent labels; ambiguous controls never choose a project',()=>{const f=fixture();try{const a=f.registry.register(f.config('one','00000000-0000-0000-0000-000000000004'),legacyLabel),b=f.registry.register(f.config('two','00000000-0000-0000-0000-000000000005'));expect(a.label).toBe(legacyLabel);expect(b.label).not.toBe(a.label);expect(()=>f.registry.select()).toThrow('Multiple');expect(f.registry.select('one')).toEqual(a);expect(f.registry.select('two')).toEqual(b);expect(f.registry.register(a.config)).toEqual(a);}finally{f.close();}});
test('registration preflight detects conflicts without writing or replacing identities',()=>{const f=fixture();try{const a=f.registry.register(f.config('one','00000000-0000-0000-0000-000000000004'));const other=f.config('two','00000000-0000-0000-0000-000000000004');expect(()=>f.registry.register(other,undefined,false)).toThrow('already');expect(f.registry.list()).toEqual([a]);const third=f.config('three','00000000-0000-0000-0000-000000000005');f.registry.register(third,undefined,false);expect(f.registry.list().length).toBe(1);}finally{f.close();}});
test('launch definitions use independent labels and log paths and reject a mismatched configuration',()=>{const label=projectServiceLabel('second');const xml=serviceDefinition('/config/second.json','/bun',resolve(import.meta.dir,'../src/cli.ts'),'/home/test',label);expect(xml).toContain(`<string>${label}</string>`);expect(xml).toContain(`${label}.log`);expect(()=>assertDefinition({Label:label,ProgramArguments:['/bun',resolve(import.meta.dir,'../src/cli.ts'),'poll','/other.json']},label,'/config/second.json')).toThrow('preserved');});
test('installed stable controller discovery is independent of running development checkout and identity stays bound',()=>{
 const f=fixture();try{
  const config=f.config('stable','00000000-0000-0000-0000-000000000004');
  const stable=join(f.dir,'stable-install','cli.ts'),other=join(f.dir,'other-install','cli.ts');mkdirSync(join(f.dir,'stable-install'));mkdirSync(join(f.dir,'other-install'));writeFileSync(stable,'');writeFileSync(other,'');
  const home=join(f.dir,'home'),agents=join(home,'Library','LaunchAgents');mkdirSync(agents,{recursive:true});writeFileSync(join(agents,legacyLabel+'.plist'),'fixture');
  const def={Label:legacyLabel,ProgramArguments:['/bun',stable,'poll',config]};
  const entry=f.registry.discoverLegacy(home,()=>def)!;expect(entry.label).toBe(legacyLabel);expect(f.registry.select('stable')).toEqual(entry);
  expect(()=>f.registry.discoverLegacy(home,()=>def)).not.toThrow();expect(()=>f.registry.assertInstalled(def,entry.label,config)).not.toThrow();
  expect(()=>f.registry.assertInstalled({...def,ProgramArguments:['/bun',other,'poll',config]},entry.label,config)).toThrow('preserved');
  expect(()=>f.registry.assertInstalled({...def,Label:'wrong'},entry.label,config)).toThrow('preserved');
  expect(()=>f.registry.assertInstalled({...def,ProgramArguments:['/bun',stable,'poll','/wrong.json']},entry.label,config)).toThrow('preserved');
  const fresh=new ProjectServices(f.s);expect(()=>fresh.assertInstalled({...def,ProgramArguments:['/bun',other,'poll',config]},entry.label,config)).toThrow('preserved');expect(fresh.list()).toEqual([entry]);
 }finally{f.close();}
});
test('ordinary service checks cannot adopt a plist when an existing registration has no controller identity',()=>{
 const f=fixture();try{
  const config=f.config('unbound','00000000-0000-0000-0000-000000000004'),entry=f.registry.register(config);
  const controller=resolve(import.meta.dir,'../src/cli.ts'),changed=join(f.dir,'changed','cli.ts');mkdirSync(join(f.dir,'changed'));writeFileSync(changed,'');
  const def=(path:string)=>({Label:entry.label,ProgramArguments:['/bun',path,'poll',config]});
  for(const persist of [true,false])for(const path of [controller,changed])expect(()=>f.registry.assertInstalled(def(path),entry.label,config,persist)).toThrow('controller identity missing');
  expect(f.s.db.query('SELECT * FROM project_service_controllers').all()).toEqual([]);
  f.registry.registerController(config,controller);expect(()=>f.registry.assertInstalled(def(controller),entry.label,config)).not.toThrow();
  expect(()=>f.registry.assertInstalled(def(changed),entry.label,config)).toThrow('preserved');
 }finally{f.close();}
});

test.skipIf(process.platform!=='darwin')('service preview is read-only and apply changes only the selected interval',async()=>{
 const f=fixture();try{
  const a=f.registry.register(f.config('one','00000000-0000-0000-0000-000000000004')),b=f.registry.register(f.config('two','00000000-0000-0000-0000-000000000005'));
  const source=resolve(import.meta.dir,'../src/cli.ts'),pa=join(f.dir,'a.plist'),pb=join(f.dir,'b.plist');
  writeFileSync(pa,serviceDefinition(a.config,'/bun',source,f.dir,a.label).replace('</dict></plist>','<key>ThrottleInterval</key><integer>17</integer></dict></plist>'));
  writeFileSync(pb,serviceDefinition(b.config,'/bun',source,f.dir,b.label));
  const before=readFileSync(pa,'utf8'),other=readFileSync(pb,'utf8'),definition=readDefinition(pa),settings={pollingIntervalSeconds:15,automation:{maxPlanning:4}};
  expect(serviceSettings(pa,a.label,a.config,settings)).toMatchObject({changed:true,applied:false,maxPlanning:4});expect(readFileSync(pa,'utf8')).toBe(before);
  expect(()=>serviceSettings(pa,b.label,b.config,settings,true)).toThrow('preserved');expect(readFileSync(pa,'utf8')).toBe(before);
  expect(serviceSettings(pa,a.label,a.config,settings,true).applied).toBe(true);
  expect(readDefinition(pa)).toEqual({...definition,StartInterval:15});expect(readFileSync(pb,'utf8')).toBe(other);
  expect(serviceSettings(pa,a.label,a.config,settings,true).applied).toBe(false);
  // The file now matches, but the first unload can fail. Explicit apply must retry.
  const calls:string[][]=[];let fail=true;
  const run=async(args:string[])=>{calls.push(args);return {code:args[0]==='bootout'&&fail?1:0};};
   await expect(reloadService(true,true,'gui/test',a.label,pa,run)).rejects.toThrow('retry');
   expect(calls.map(x=>x[0])).toEqual(['bootout']);fail=false;
   expect(serviceSettings(pa,a.label,a.config,settings,true).applied).toBe(false);
   expect(await reloadService(true,true,'gui/test',a.label,pa,run)).toBe(true);
   expect(calls.map(x=>x[0])).toEqual(['bootout','bootout','bootstrap']);
  expect(()=>serviceSettings(pa,a.label,a.config,{pollingIntervalSeconds:0},true)).toThrow('pollingIntervalSeconds');
 }finally{f.close();}
});

test('reload leaves previews and stopped services alone and reports bootstrap failure',async()=>{
 const calls:string[][]=[];
 const run=async(args:string[])=>{calls.push(args);return {code:args[0]==='bootstrap'?1:0};};
 expect(await reloadService(false,true,'domain','target','plist',run)).toBe(false);
 expect(await reloadService(true,false,'domain','target','plist',run)).toBe(false);
 expect(calls).toEqual([]);
 await expect(reloadService(true,true,'domain','target','plist',run)).rejects.toThrow('use start PROJECT');
 expect(calls).toEqual([['bootout','target'],['bootstrap','domain','plist']]);
});

test('registered recovery tolerates only invalid runtime settings and preserves identity/config checks',()=>{
 const f=fixture();try{
  const entry=f.registry.register(f.config('one','00000000-0000-0000-0000-000000000004'));
  const original=JSON.parse(readFileSync(entry.config,'utf8'));
  for(const override of [{pollingIntervalSeconds:0},{automation:{...original.automation,maxPlanning:33}}]){
   const invalid={...original,...override};writeFileSync(entry.config,JSON.stringify(invalid));
   expect(()=>f.registry.verify(entry)).toThrow();
   expect(f.registry.verify(entry,false)).toEqual(invalid);
   expect(JSON.parse(readFileSync(entry.config,'utf8'))).toEqual(invalid);
   writeFileSync(entry.config,JSON.stringify({...invalid,automation:{...invalid.automation,orchestratorProject:'other'}}));
   expect(()=>f.registry.verify(entry,false)).toThrow('identity changed');
  }
  writeFileSync(entry.config,JSON.stringify({...original,name:'',pollingIntervalSeconds:0}));
  expect(()=>f.registry.verify(entry,false)).toThrow('Invalid project configuration');
  writeFileSync(entry.config,'{');expect(()=>f.registry.verify(entry,false)).toThrow();
  rmSync(entry.config);expect(()=>f.registry.verify(entry,false)).toThrow();
 }finally{f.close();}
});

test('registered legacy discovery supports recovery without validating edited runtime limits',()=>{
 const f=fixture();try{
  const entry=f.registry.register(f.config('one','00000000-0000-0000-0000-000000000004'),legacyLabel);
  const config=JSON.parse(readFileSync(entry.config,'utf8'));config.pollingIntervalSeconds=0;
  writeFileSync(entry.config,JSON.stringify(config));
  mkdirSync(join(f.dir,'Library/LaunchAgents'),{recursive:true});
  writeFileSync(join(f.dir,'Library/LaunchAgents',legacyLabel+'.plist'),'placeholder');
  const read=()=>({Label:legacyLabel,ProgramArguments:['/bun',resolve(import.meta.dir,'../src/cli.ts'),'poll',entry.config]});
  expect(()=>f.registry.discoverLegacy(f.dir,read)).toThrow('pollingIntervalSeconds');
  expect(f.registry.discoverLegacy(f.dir,read,true,true)).toEqual(entry);
 }finally{f.close();}
});

test.skipIf(process.platform!=='darwin')('service-control recovery handles registered and newly adopted legacy services with invalid settings',async()=>{
 const {serviceControl}=await import('../src/service-control');
 for(const registered of [false,true])for(const action of ['stop','service-status'])for(const setting of ['pollingIntervalSeconds','maxPlanning']){
  const f=fixture();try{
   const path=realpathSync(f.config('one','00000000-0000-0000-0000-000000000004')),statePath=join(f.dir,'registry.sqlite');
   if(registered){const s=new Store(statePath);try{const registry=new ProjectServices(s);registry.register(path,legacyLabel);registry.registerController(path,resolve(import.meta.dir,'../src/cli.ts'));}finally{s.close();}}
   mkdirSync(join(f.dir,'Library/LaunchAgents'),{recursive:true});
   writeFileSync(join(f.dir,'Library/LaunchAgents',legacyLabel+'.plist'),serviceDefinition(path,process.execPath,resolve(import.meta.dir,'../src/cli.ts'),f.dir,legacyLabel));
   const config=JSON.parse(readFileSync(path,'utf8'));
   if(setting==='pollingIntervalSeconds')config.pollingIntervalSeconds=0;else config.automation.maxPlanning=33;
   const invalid=JSON.stringify(config);writeFileSync(path,invalid);
   const calls:string[][]=[];let loaded=true;
   const run=async(args:string[])=>{
    calls.push(args);
    if(args[0]==='print')return {code:loaded?0:1,stdout:loaded?'state = waiting':'',stderr:loaded?'':'Could not find service'};
    if(args[0]==='bootout'){loaded=false;return {code:0,stdout:'',stderr:''};}
    throw Error('Unexpected service command');
   };
   const options={home:f.dir,statePath,run,turns:turnBarrier(join(f.dir,'fence')),pollState:join(f.dir,'poll-state')};
   // Satisfy main's idle-process receipt gate without touching live state.
   const finished=await acknowledgePoll(path,resolve(import.meta.dir,'../src/cli.ts'),options.pollState,undefined,async operation=>operation());finished();
   const result=await serviceControl(action,'one',false,options);
   expect(result).toMatchObject({project:'one',loaded:action!=='stop',settingsError:expect.stringContaining(setting==='maxPlanning'?'automation.maxPlanning':setting)});
   expect(calls.map(c=>c[0])).toEqual(action==='stop'?['print','bootout','print']:['print']);
   expect(readFileSync(path,'utf8')).toBe(invalid);
   if(registered||action==='stop'){
    const after=Store.readonly(statePath);try{expect(new ProjectServices(after,false).list()[0].label).toBe(legacyLabel);}finally{after.close();}
   }else expect(existsSync(statePath)).toBe(false); // status must not register legacy state
   calls.length=0;
   for(const strict of ['start','service-config'])await expect(serviceControl(strict,'one',false,options)).rejects.toThrow();
   expect(calls).toEqual([]);
   // Recovery must still reject changed identities, malformed JSON, and missing config.
   writeFileSync(path,JSON.stringify({...config,automation:{...config.automation,orchestratorProject:'other'}}));
   await expect(serviceControl(action,'one',false,options)).rejects.toThrow();
   writeFileSync(path,'{');await expect(serviceControl(action,'one',false,options)).rejects.toThrow();
   rmSync(path);await expect(serviceControl(action,'one',false,options)).rejects.toThrow();
   expect(calls).toEqual([]);
  }finally{f.close();}
 }
});

test.skipIf(process.platform!=='darwin')('service-config apply preserves fences and requires a verified idle receipt before definition changes',async()=>{
 const {serviceControl}=await import('../src/service-control');const f=fixture();try{
  const path=realpathSync(f.config('one','00000000-0000-0000-0000-000000000004')),statePath=join(f.dir,'registry.sqlite');
  const s=new Store(statePath);let entry;try{const registry=new ProjectServices(s);entry=registry.register(path);registry.registerController(path,resolve(import.meta.dir,'../src/cli.ts'));}finally{s.close();}
  mkdirSync(join(f.dir,'Library/LaunchAgents'),{recursive:true});
  const plist=join(f.dir,'Library/LaunchAgents',entry.label+'.plist');
  writeFileSync(plist,serviceDefinition(path,process.execPath,resolve(import.meta.dir,'../src/cli.ts'),f.dir,entry.label));
  const before=readFileSync(plist,'utf8'),config=JSON.parse(readFileSync(path,'utf8'));config.pollingIntervalSeconds=15;writeFileSync(path,JSON.stringify(config));
  const calls:string[][]=[],turns=turnBarrier(join(f.dir,'fence'));
  const run=async(args:string[])=>{calls.push(args);if(args[0]!=='print')throw Error('Unexpected mutation');return {code:0,stdout:'state = waiting',stderr:''};};
  const options={home:f.dir,statePath,run,turns,pollState:join(f.dir,'receipts')};
  await expect(serviceControl('service-config','one',true,options)).rejects.toThrow('barrier support is unverified');
  expect(calls.map(x=>x[0])).toEqual(['print']);expect(readFileSync(plist,'utf8')).toBe(before);calls.length=0;
  await turns.submit(async()=>{
   await expect(serviceControl('service-config','one',true,options)).rejects.toThrow('in progress');
  });
  expect(calls).toEqual([]);expect(readFileSync(plist,'utf8')).toBe(before);
 }finally{f.close();}
});

test.skipIf(process.platform!=='darwin')('service-config apply covers the loaded reload order and stopped updates without mutations',async()=>{
 const {serviceControl}=await import('../src/service-control');const f=fixture();try{
  const path=realpathSync(f.config('one','00000000-0000-0000-0000-000000000004')),statePath=join(f.dir,'registry.sqlite');
  const s=new Store(statePath);let entry;try{const registry=new ProjectServices(s);entry=registry.register(path);registry.registerController(path,resolve(import.meta.dir,'../src/cli.ts'));}finally{s.close();}
  mkdirSync(join(f.dir,'Library/LaunchAgents'),{recursive:true});
  const plist=join(f.dir,'Library/LaunchAgents',entry.label+'.plist'),cli=resolve(import.meta.dir,'../src/cli.ts');
  writeFileSync(plist,serviceDefinition(path,process.execPath,cli,f.dir,entry.label));
  const config=JSON.parse(readFileSync(path,'utf8'));config.pollingIntervalSeconds=15;writeFileSync(path,JSON.stringify(config));
  const calls:string[][]=[],turns=turnBarrier(join(f.dir,'fence')),pollState=join(f.dir,'receipts');
  let loaded=true,failNextBootout=false,staleStartup=false,pauses=0;
  let finishStartup:undefined|(()=>void);
  const run=async(args:string[])=>{
   calls.push(args);
   if(args[0]==='print')return loaded?{code:0,stdout:`state = running\npid = ${process.pid}`,stderr:''}:{code:1,stdout:'',stderr:'Could not find service'};
   if(args[0]==='bootout'){
    if(failNextBootout){failNextBootout=false;return {code:1,stdout:'',stderr:'Simulated unload failure'};}
    loaded=false;return {code:0,stdout:'',stderr:''};
   }
   if(args[0]==='bootstrap'){loaded=true;return {code:0,stdout:'',stderr:''};}
   if(args[0]==='kickstart'){
    if(!staleStartup)finishStartup=await acknowledgePoll(path,cli,pollState,undefined,async operation=>operation());
    return {code:0,stdout:'',stderr:''};
   }
   throw Error('Unexpected service command');
  };
  const options={home:f.dir,statePath,run,turns,pollState,startupWait:{attempts:2,pause:async()=>{pauses++;}}};
  // Establish idle support. Only kickstart publishes the fresh running receipt.
  const idle=await acknowledgePoll(path,cli,pollState,undefined,async operation=>operation());idle();
  const applied=await serviceControl('service-config','one',true,options);
  const domain=`gui/${process.getuid!()}`,target=`${domain}/${entry.label}`;
  expect(applied).toMatchObject({changed:true,applied:true,reloaded:true,pollingIntervalSeconds:15});
  expect(calls).toEqual([['print',target],['bootout',target],['bootstrap',domain,plist],['kickstart',target],['print',target]]);
  expect(readDefinition(plist).StartInterval).toBe(15);
  // Partial apply updates the definition before unload fails. A matching file
  // on the next apply must not suppress the retry or startup acknowledgement.
  config.pollingIntervalSeconds=18;writeFileSync(path,JSON.stringify(config));calls.length=0;failNextBootout=true;
  await expect(serviceControl('service-config','one',true,options)).rejects.toThrow('Service unload failed');
  expect(calls).toEqual([['print',target],['bootout',target]]);
  expect(readDefinition(plist).StartInterval).toBe(18);expect(loaded).toBe(true);
  calls.length=0;
  const retried=await serviceControl('service-config','one',true,options);
  expect(retried).toMatchObject({changed:false,applied:false,reloaded:true,pollingIntervalSeconds:18});
  expect(calls).toEqual([['print',target],['bootout',target],['bootstrap',domain,plist],['kickstart',target],['print',target]]);
  expect(readDefinition(plist).StartInterval).toBe(18);
  // A stale idle receipt must not acknowledge the fake running PID after reload.
  finishStartup!();staleStartup=true;pauses=0;calls.length=0;
  config.pollingIntervalSeconds=19;writeFileSync(path,JSON.stringify(config));
  await expect(serviceControl('service-config','one',true,options)).rejects.toThrow('intake startup not confirmed');
  expect(calls).toEqual([['print',target],['bootout',target],['bootstrap',domain,plist],['kickstart',target],['print',target],['print',target]]);
  expect(pauses).toBe(1);expect(readDefinition(plist).StartInterval).toBe(19);
  config.pollingIntervalSeconds=20;writeFileSync(path,JSON.stringify(config));calls.length=0;loaded=false;
  const stopped=await serviceControl('service-config','one',true,options);
  expect(stopped).toMatchObject({changed:true,applied:true,reloaded:false,pollingIntervalSeconds:20});
  expect(calls).toEqual([['print',target]]);expect(readDefinition(plist).StartInterval).toBe(20);
 }finally{f.close();}
});

test('read-only legacy discovery retains verified controller identity only in that registry instance',()=>{
 const f=fixture();try{
  const config=realpathSync(f.config('discovered','00000000-0000-0000-0000-000000000004'));
  const controller=join(f.dir,'stable/cli.ts');mkdirSync(join(f.dir,'stable'));writeFileSync(controller,'fixture');
  mkdirSync(join(f.dir,'Library/LaunchAgents'),{recursive:true});writeFileSync(join(f.dir,'Library/LaunchAgents',legacyLabel+'.plist'),'fixture');
  const def={Label:legacyLabel,ProgramArguments:['/bun',controller,'poll',config]};
  f.registry.discoverLegacy(f.dir,()=>def,false);
  expect(()=>f.registry.assertInstalled(def,legacyLabel,config,false)).not.toThrow();
  expect(()=>f.registry.assertInstalled({...def,ProgramArguments:['/bun',resolve(import.meta.dir,'../src/cli.ts'),'poll',config]},legacyLabel,config,false)).toThrow('preserved');
  expect(f.registry.list()).toEqual([]);expect(f.s.db.query('SELECT * FROM project_service_controllers').all()).toEqual([]);
  expect(()=>new ProjectServices(f.s).assertInstalled(def,legacyLabel,config,false)).toThrow('controller identity missing');
 }finally{f.close();}
});

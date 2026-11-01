import {test,expect} from 'bun:test';import {Store} from '../src/core';import {ProjectServices,projectServiceLabel,assertDefinition,legacyLabel} from '../src/project-services';import {serviceDefinition} from '../src/init';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {readDefinition} from '../src/project-services';
import {serviceSettings} from '../src/service-settings';
import {reloadService} from '../src/service-control';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'adlc-projects-')),s=new Store(':memory:'),registry=new ProjectServices(s);
 const config=(id:string,linear:string)=>{const repo=join(dir,id);mkdirSync(repo);const path=join(dir,id+'.json');writeFileSync(path,JSON.stringify({version:1,name:id,repo,automation:{orchestratorProject:id},linear:{projectId:linear,teamId:'00000000-0000-0000-0000-000000000001',readyStateId:'00000000-0000-0000-0000-000000000002',readyLabelId:'00000000-0000-0000-0000-000000000003'}}));return path;};return {dir,s,registry,config,close:()=>{s.close();rmSync(dir,{recursive:true,force:true});}};}
test('separate projects retain independent labels; ambiguous controls never choose a project',()=>{const f=fixture();try{const a=f.registry.register(f.config('one','00000000-0000-0000-0000-000000000004'),legacyLabel),b=f.registry.register(f.config('two','00000000-0000-0000-0000-000000000005'));expect(a.label).toBe(legacyLabel);expect(b.label).not.toBe(a.label);expect(()=>f.registry.select()).toThrow('Multiple');expect(f.registry.select('one')).toEqual(a);expect(f.registry.select('two')).toEqual(b);expect(f.registry.register(a.config)).toEqual(a);}finally{f.close();}});
test('registration preflight detects conflicts without writing or replacing identities',()=>{const f=fixture();try{const a=f.registry.register(f.config('one','00000000-0000-0000-0000-000000000004'));const other=f.config('two','00000000-0000-0000-0000-000000000004');expect(()=>f.registry.register(other,undefined,false)).toThrow('already');expect(f.registry.list()).toEqual([a]);const third=f.config('three','00000000-0000-0000-0000-000000000005');f.registry.register(third,undefined,false);expect(f.registry.list().length).toBe(1);}finally{f.close();}});
test('launch definitions use independent labels and log paths and reject a mismatched configuration',()=>{const label=projectServiceLabel('second');const xml=serviceDefinition('/config/second.json','/bun',resolve(import.meta.dir,'../src/cli.ts'),'/home/test',label);expect(xml).toContain(`<string>${label}</string>`);expect(xml).toContain(`${label}.log`);expect(()=>assertDefinition({Label:label,ProgramArguments:['/bun',resolve(import.meta.dir,'../src/cli.ts'),'poll','/other.json']},label,'/config/second.json')).toThrow('preserved');});

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
  expect(f.registry.discoverLegacy(f.dir,read,true)).toEqual(entry);
 }finally{f.close();}
});

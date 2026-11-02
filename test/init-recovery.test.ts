import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {publishInitService,publishServiceFile,initWizard,serviceDefinition} from '../src/init';import {Store} from '../src/core';import {ProjectServices} from '../src/project-services';
function fixture(){
 const home=realpathSync(mkdtempSync(join(tmpdir(),'adlc-init-recovery-'))),repo=join(home,'repo'),config=join(home,'config.json'),db=join(home,'state.sqlite'),controller=join(home,'known/src/cli.ts');mkdirSync(repo);mkdirSync(dirname(controller),{recursive:true});writeFileSync(controller,'known cli');
 const uuid='00000000-0000-0000-0000-000000000001';writeFileSync(config,JSON.stringify({version:1,name:'Saved',repo,requiredChecks:['CI'],automation:{orchestratorProject:'project'},linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid},approval:{mode:'manual'}}));
 const s=new Store(db),entry=new ProjectServices(s).register(config);s.close();return {home,repo,config,db,controller,entry,plist:join(home,'Library/LaunchAgents',entry.label+'.plist'),close:()=>rmSync(home,{recursive:true,force:true})};
}
test('binding is durable before service publication and an interrupted write retries without duplicate registrations',()=>{
 const f=fixture();try{
  expect(()=>publishInitService(f.config,f.home,f.db,join(f.home,'missing/cli.ts'))).toThrow();expect(existsSync(f.plist)).toBe(false);
  const io:any={write:()=>{const s=Store.readonly(f.db);try{expect(s.db.query('SELECT controller FROM project_service_controllers').get()).toEqual({controller:f.controller});}finally{s.close();}throw Error('interrupted publication');}};
  expect(()=>publishInitService(f.config,f.home,f.db,f.controller,process.execPath,io)).toThrow('interrupted publication');expect(existsSync(f.plist)).toBe(false);
  expect(publishInitService(f.config,f.home,f.db,f.controller).existingServicePreserved).toBe(false);const bytes=readFileSync(f.plist);
  expect(publishInitService(f.config,f.home,f.db,f.controller).existingServicePreserved).toBe(true);expect(readFileSync(f.plist)).toEqual(bytes);
  const s=Store.readonly(f.db);try{expect(new ProjectServices(s,false).list()).toHaveLength(1);}finally{s.close();}
 }finally{f.close();}
});
test('init resumes a saved partial service explicitly, preserving configuration/plist and never starting it',async()=>{
 const f=fixture();try{
  mkdirSync(dirname(f.plist),{recursive:true});writeFileSync(f.plist,serviceDefinition(f.config,process.execPath,f.controller,f.home,f.entry.label));const config=readFileSync(f.config),plist=readFileSync(f.plist);let gates=0,verified=0,closed=false;const answers=['yes','yes'];
  const result=await initWizard(f.repo,['--config',f.config],{interactive:()=>true,home:()=>f.home,registryPath:()=>f.db,controller:()=>f.controller,linearToken:()=> 'fixture',verifyInitConfig:async()=>{verified++;},installWorkflowHook:async()=>{gates++;return {} as any;},serviceControl:async()=>{throw Error('Must not activate preserved service');},log:()=>{},prompts:()=>({question:async()=>answers.shift()??'no',close:()=>{closed=true;}})});
  expect(result).toMatchObject({existingServicePreserved:true,serviceEnabled:false});expect(gates).toBe(1);expect(verified).toBe(1);expect(closed).toBe(true);expect(answers).toEqual([]);expect(readFileSync(f.config)).toEqual(config);expect(readFileSync(f.plist)).toEqual(plist);
  const s=Store.readonly(f.db);try{expect(s.db.query('SELECT controller FROM project_service_controllers').get()).toEqual({controller:f.controller});}finally{s.close();}
 }finally{f.close();}
});
test('atomic service publication never clobbers a competing existing definition',()=>{
 const f=fixture();try{mkdirSync(dirname(f.plist),{recursive:true});writeFileSync(f.plist,'existing operator content');expect(()=>publishServiceFile(f.plist,'replacement')).toThrow();expect(readFileSync(f.plist,'utf8')).toBe('existing operator content');}finally{f.close();}
});
test('conflicting existing plist rejects recovery without binding or changing service bytes',()=>{
 const f=fixture();try{
  const other=join(f.home,'other/src/cli.ts');mkdirSync(dirname(other),{recursive:true});writeFileSync(other,'different controller');
  mkdirSync(dirname(f.plist),{recursive:true});writeFileSync(f.plist,serviceDefinition(f.config,process.execPath,other,f.home,f.entry.label));const before=readFileSync(f.plist);
  expect(()=>publishInitService(f.config,f.home,f.db,f.controller)).toThrow('Service definition does not match this project; existing service preserved');
  expect(readFileSync(f.plist)).toEqual(before);const s=Store.readonly(f.db);try{expect(s.db.query('SELECT * FROM project_service_controllers').all()).toEqual([]);}finally{s.close();}
 }finally{f.close();}
});

test('initial service publication uses configured project polling without changing controller binding',()=>{
 const f=fixture();try{
  const c=JSON.parse(readFileSync(f.config,'utf8'));c.pollingIntervalSeconds=120;writeFileSync(f.config,JSON.stringify(c));
  publishInitService(f.config,f.home,f.db,f.controller);
  const xml=readFileSync(f.plist,'utf8');expect(xml).toContain('<integer>120</integer>');expect(xml).toContain(f.controller);
  const s=Store.readonly(f.db);try{expect(s.db.query('SELECT controller FROM project_service_controllers').get()).toEqual({controller:f.controller});}finally{s.close();}
 }finally{f.close();}
});

import {test,expect} from 'bun:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {snapshot,distributionFiles} from '../src/install';
import {installBridge} from '../src/install';import {copyFileSync,readdirSync,existsSync,realpathSync,chmodSync,symlinkSync} from 'node:fs';
test('installation snapshots exclude credentials, Git data, tests and internal notes and survive checkout edits',()=>{const root=mkdtempSync(join(tmpdir(),'adlc-install-'));try{const source=join(root,'source'),dest=join(root,'versions');for(const d of ['src','config','.git'])mkdirSync(join(source,d),{recursive:true});writeFileSync(join(source,'src/cli.ts'),'original');writeFileSync(join(source,'config/private.json'),'secret');writeFileSync(join(source,'.env'),'secret');writeFileSync(join(source,'IMPLEMENTATION-STATUS.md'),'private');const a=snapshot(source,dest);expect(distributionFiles(source)).toEqual(['src/cli.ts']);writeFileSync(join(source,'src/cli.ts'),'changed');expect(readFileSync(a.cli,'utf8')).toBe('original');expect(snapshot(source,dest).version).not.toBe(a.version);writeFileSync(a.cli,'tampered');writeFileSync(join(source,'src/cli.ts'),'original');expect(()=>snapshot(source,dest)).toThrow('changed');}finally{rmSync(root,{recursive:true,force:true});}});
test('interrupted snapshot copy leaves no published partial version and can be retried',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-copy-'));try{
  const source=join(root,'source'),dest=join(root,'versions');mkdirSync(join(source,'src'),{recursive:true});writeFileSync(join(source,'src/cli.ts'),'original');
  expect(()=>snapshot(source,dest,(from,to)=>{copyFileSync(from,to);throw Error('interrupted copy');})).toThrow('interrupted');expect(readdirSync(dest)).toEqual([]);
  const built=snapshot(source,dest);expect(readFileSync(built.cli,'utf8')).toBe('original');expect(existsSync(join(dest,built.version,'manifest.json'))).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('installer migrates projects without plists and rolls back gates, record, launcher and exact plists on failure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-rollback-'));try{
  const source=join(root,'source'),state=join(root,'state'),home=join(root,'home'),launcher=join(root,'adlc');
  for(const path of [join(source,'src'),state,join(home,'Library/LaunchAgents')])mkdirSync(path,{recursive:true});writeFileSync(join(source,'src/cli.ts'),'original');
  const projects=['loaded','unloaded','no-plist'].map(project=>({project,label:`local.adlc.${project}`,config:`/${project}.json`}));
  for(const p of projects.slice(0,2))writeFileSync(join(home,'Library/LaunchAgents',p.label+'.plist'),'old '+p.project);
  writeFileSync(join(state,'installation.json'),'old record');writeFileSync(launcher,'old src/cli.ts launcher',{mode:0o755});
  const calls:string[]=[],hooks:string[]=[],restored:{path:string;config:any}[]=[];
  const io:any={state:()=>state,home:()=>home,registeredProjects:async()=>projects,readDefinition:()=>({Label:'old'}),assertDefinition:()=>{},
   serviceControl:async(action:string,id:string)=>{calls.push(`${action}:${id}`);return {loaded:id==='loaded'};},
   localAO:async(path:string,method?:string,body?:any)=>{if(method==='PUT'){restored.push({path,config:body.config});return {};}return {status:'ok',project:{config:{original:path.split('/')[1]}}};},
   installWorkflowHook:async(path:string)=>{hooks.push(path);if(path==='/no-plist.json')throw Error('hook failed');}};
  await expect(installBridge(true,source,launcher,io)).rejects.toThrow('hook failed');
  expect(hooks).toEqual(projects.map(p=>p.config));expect(restored).toEqual(projects.map(p=>({path:`projects/${p.project}/config`,config:{original:p.project}})));
  expect(readFileSync(join(state,'installation.json'),'utf8')).toBe('old record');expect(readFileSync(launcher,'utf8')).toBe('old src/cli.ts launcher');
  for(const p of projects.slice(0,2))expect(readFileSync(join(home,'Library/LaunchAgents',p.label+'.plist'),'utf8')).toBe('old '+p.project);
  expect(calls.filter(x=>x.startsWith('start:'))).toEqual(['start:loaded']);expect(calls.filter(x=>x.startsWith('stop:'))).toEqual(['stop:loaded']);
  expect(readdirSync(join(state,'versions'))).toHaveLength(1);expect(readFileSync(snapshot(source,join(state,'versions')).cli,'utf8')).toBe('original');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('snapshot reinstalls use only a verified installation source and preserve the root when no record exists',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-reinstall-'))),state=join(root,'ADLC Bridge'),installed=join(state,'versions/abc'),source=join(root,'source'),record=join(state,'installation.json');
 try{
  for(const dir of [join(installed,'src'),join(source,'src')])mkdirSync(dir,{recursive:true});writeFileSync(join(installed,'src/cli.ts'),'installed');writeFileSync(join(source,'src/cli.ts'),'source');
  let reads=0;const io:any={state:()=>state,home:()=>root,registeredProjects:async()=>{reads++;return [];}};
  expect((await installBridge(false,installed,join(root,'adlc'),io)).source).toBe(installed);
  const valid={source,cli:join(installed,'src/cli.ts')};writeFileSync(record,JSON.stringify(valid),{mode:0o600});expect((await installBridge(false,installed,join(root,'adlc'),io)).source).toBe(source);
  reads=0;chmodSync(record,0o644);await expect(installBridge(false,installed,join(root,'adlc'),io)).rejects.toThrow('owner-only');expect(reads).toBe(0);chmodSync(record,0o600);
  writeFileSync(record,JSON.stringify({...valid,source:'relative'}));await expect(installBridge(false,installed,join(root,'adlc'),io)).rejects.toThrow('Invalid installation source');expect(reads).toBe(0);
  const other=join(root,'other-record');writeFileSync(other,JSON.stringify(valid),{mode:0o600});rmSync(record);symlinkSync(other,record);await expect(installBridge(false,installed,join(root,'adlc'),io)).rejects.toThrow('owner-only');expect(reads).toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('install uses read-only project discovery for preview and writable discovery for apply',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-install-discovery-'));try{
  const source=join(root,'source'),state=join(root,'state'),modes:boolean[]=[];mkdirSync(join(source,'src'),{recursive:true});writeFileSync(join(source,'src/cli.ts'),'test cli');
  const io:any={state:()=>state,home:()=>root,registeredProjects:async(readOnly:boolean)=>{modes.push(readOnly);return [];}};
  await installBridge(false,source,join(root,'adlc'),io);expect(existsSync(join(state,'installation.json'))).toBe(false);await installBridge(true,source,join(root,'adlc'),io);expect(modes).toEqual([true,false]);expect(existsSync(join(state,'installation.json'))).toBe(true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('incomplete installation rollback reports every failure and continues restoration without restarting intake',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-rollback-errors-'));try{
  const source=join(root,'source'),state=join(root,'state'),home=join(root,'home'),launcher=join(root,'adlc'),record=join(state,'installation.json');
  for(const path of [join(source,'src'),state,join(home,'Library/LaunchAgents')])mkdirSync(path,{recursive:true});writeFileSync(join(source,'src/cli.ts'),'new cli');writeFileSync(record,'old record');writeFileSync(launcher,'old src/cli.ts launcher');
  const projects=['first','second'].map(project=>({project,label:`local.adlc.${project}`,config:`/${project}.json`})),plists=projects.map(p=>join(home,'Library/LaunchAgents',p.label+'.plist'));for(const path of plists)writeFileSync(path,'old plist');
  const original=Error('activation failed'),settings=Error('settings restore failed'),restart=Error('restart failed'),calls:string[]=[];let starts=0;
  const io:any={state:()=>state,home:()=>home,registeredProjects:async()=>projects,readDefinition:()=>({}),assertDefinition:()=>{},installWorkflowHook:async()=>{},
   localAO:async(path:string,method?:string)=>{calls.push(`${method??'GET'}:${path}`);if(method==='PUT'&&path.includes('/first/'))throw settings;return {status:'ok',project:{config:{old:true}}};},
   serviceControl:async(action:string,id:string)=>{calls.push(`${action}:${id}`);if(action==='service-status')return {loaded:true};if(action==='start'&&id==='first'){
    if(++starts===1){for(const path of [record,plists[0],launcher]){rmSync(path);mkdirSync(path);}throw original;}throw restart;
   }return {};}};
  const error=await installBridge(true,source,launcher,io).catch(error=>error);
   expect(error).toBeInstanceOf(AggregateError);expect(error.errors).toHaveLength(5);expect(error.errors[0]).toBe(original);expect(error.message).toContain(original.message);
   expect(error.errors.map((e:any)=>e.cause)).toContain(settings);expect(error.errors.map((e:any)=>e.cause)).not.toContain(restart);
  for(const target of [record,plists[0],launcher,'first'])expect(error.message).toContain(target);
   expect(calls).toContain('PUT:projects/second/config');expect(calls.filter(call=>call.startsWith('start:'))).toEqual(['start:first']);expect(readFileSync(plists[1],'utf8')).toBe('old plist');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('failed rollback pauses preserve activated artifacts and settings without restarting any intake',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-rollback-pause-'));try{
  const source=join(root,'source'),state=join(root,'state'),home=join(root,'home'),launcher=join(root,'adlc'),record=join(state,'installation.json');
  for(const path of [join(source,'src'),state,join(home,'Library/LaunchAgents')])mkdirSync(path,{recursive:true});writeFileSync(join(source,'src/cli.ts'),'new cli');writeFileSync(record,'old record');writeFileSync(launcher,'old src/cli.ts launcher');
  const projects=['first','second','third'].map(project=>({project,label:`local.adlc.${project}`,config:`/${project}.json`})),plists=projects.map(p=>join(home,'Library/LaunchAgents',p.label+'.plist'));for(const path of plists)writeFileSync(path,'old plist');
  const original=Error('second start uncertain'),pauses=[Error('first pause failed'),Error('second pause failed')],calls:string[]=[];let rollback=false,activated:Buffer[]=[];
  const io:any={state:()=>state,home:()=>home,registeredProjects:async()=>projects,readDefinition:()=>({}),assertDefinition:()=>{},installWorkflowHook:async()=>{},localAO:async(path:string,method?:string)=>{calls.push(`${method??'GET'}:${path}`);return {status:'ok',project:{config:{old:true}}};},
   serviceControl:async(action:string,id:string)=>{calls.push(`${action}:${id}`);if(action==='service-status')return {loaded:true};if(action==='start'&&id==='second'){activated=[record,launcher,...plists].map(path=>readFileSync(path));rollback=true;throw original;}if(action==='stop'&&rollback)throw pauses[id==='first'?0:1];return {};}};
  const error=await installBridge(true,source,launcher,io).catch(error=>error);expect(error).toBeInstanceOf(AggregateError);expect(error.errors[0]).toBe(original);expect(error.errors.map((e:any)=>e.cause).slice(1)).toEqual(pauses);expect(error.message).toContain('artifacts preserved');
  expect(calls.slice(-2)).toEqual(['stop:first','stop:second']);expect(calls.filter(call=>call.startsWith('start:'))).toEqual(['start:first','start:second']);expect(calls.some(call=>call.startsWith('PUT:'))).toBe(false);
  expect([record,launcher,...plists].map(path=>readFileSync(path))).toEqual(activated);expect(readFileSync(record,'utf8')).not.toBe('old record');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('successful installation rollback rethrows the original error unchanged',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-rollback-original-'));try{
  const source=join(root,'source');mkdirSync(join(source,'src'),{recursive:true});writeFileSync(join(source,'src/cli.ts'),'cli');const original=Error('hook failure');
  const io:any={state:()=>join(root,'state'),home:()=>root,registeredProjects:async()=>[{project:'one',label:'local.adlc.one',config:'/one.json'}],localAO:async()=>({status:'ok',project:{config:{}}}),installWorkflowHook:async()=>{throw original;}};
  expect(await installBridge(true,source,join(root,'adlc'),io).catch(error=>error)).toBe(original);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('rollback settings restoration failure alone leaves every intake stopped',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-settings-rollback-'));try{
  const source=join(root,'source'),state=join(root,'state'),home=join(root,'home'),launcher=join(root,'adlc');
  for(const path of [join(source,'src'),state,join(home,'Library/LaunchAgents')])mkdirSync(path,{recursive:true});writeFileSync(join(source,'src/cli.ts'),'new cli');writeFileSync(join(state,'installation.json'),'old record');writeFileSync(launcher,'old src/cli.ts launcher');
  const projects=['first','second'].map(project=>({project,label:`local.adlc.${project}`,config:`/${project}.json`}));for(const p of projects)writeFileSync(join(home,'Library/LaunchAgents',p.label+'.plist'),'old plist');
  const original=Error('hook failed'),settings=Error('settings PUT failed'),calls:string[]=[];
  const io:any={state:()=>state,home:()=>home,registeredProjects:async()=>projects,readDefinition:()=>({}),assertDefinition:()=>{},installWorkflowHook:async()=>{throw original;},serviceControl:async(action:string,id:string)=>{calls.push(`${action}:${id}`);return {loaded:true};},localAO:async(path:string,method?:string)=>{if(method==='PUT'){calls.push(`restore:${path}`);if(path.includes('/first/'))throw settings;}return {status:'ok',project:{config:{old:true}}};}};
  const error=await installBridge(true,source,launcher,io).catch(error=>error);expect(error).toBeInstanceOf(AggregateError);expect(error.errors[0]).toBe(original);expect(error.errors[1].cause).toBe(settings);expect(error.errors).toHaveLength(2);
  expect(calls).toContain('restore:projects/second/config');expect(calls.filter(call=>call.startsWith('start:'))).toEqual([]);expect(readFileSync(join(state,'installation.json'),'utf8')).toBe('old record');expect(readFileSync(launcher,'utf8')).toBe('old src/cli.ts launcher');
  for(const p of projects)expect(readFileSync(join(home,'Library/LaunchAgents',p.label+'.plist'),'utf8')).toBe('old plist');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('successful restoration still attempts intake restarts and aggregates restart failures',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-restart-rollback-'));try{
  const source=join(root,'source'),state=join(root,'state'),home=join(root,'home'),launcher=join(root,'adlc');
  for(const path of [join(source,'src'),state,join(home,'Library/LaunchAgents')])mkdirSync(path,{recursive:true});writeFileSync(join(source,'src/cli.ts'),'new cli');writeFileSync(join(state,'installation.json'),'old record');writeFileSync(launcher,'old src/cli.ts launcher');
  const projects=['first','second'].map(project=>({project,label:`local.adlc.${project}`,config:`/${project}.json`}));for(const p of projects)writeFileSync(join(home,'Library/LaunchAgents',p.label+'.plist'),'old plist');
  const original=Error('hook failed'),restart=Error('first restart failed'),calls:string[]=[];
  const io:any={state:()=>state,home:()=>home,registeredProjects:async()=>projects,readDefinition:()=>({}),assertDefinition:()=>{},installWorkflowHook:async()=>{throw original;},localAO:async()=>({status:'ok',project:{config:{old:true}}}),serviceControl:async(action:string,id:string)=>{calls.push(`${action}:${id}`);if(action==='start'){
   expect(readFileSync(join(state,'installation.json'),'utf8')).toBe('old record');expect(readFileSync(launcher,'utf8')).toBe('old src/cli.ts launcher');if(id==='first')throw restart;
  }return {loaded:true};}};
  const error=await installBridge(true,source,launcher,io).catch(error=>error);expect(error).toBeInstanceOf(AggregateError);expect(error.errors).toHaveLength(2);expect(error.errors[0]).toBe(original);expect(error.errors[1].cause).toBe(restart);expect(calls.slice(-2)).toEqual(['start:first','start:second']);
 }finally{rmSync(root,{recursive:true,force:true});}
});

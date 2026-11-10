import {test,expect} from 'bun:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,statSync,rmSync,realpathSync} from 'node:fs';import {join,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {registeredProjects} from '../src/service-control';import {Store} from '../src/core';import {ProjectServices,legacyLabel} from '../src/project-services';import {serviceDefinition} from '../src/init';
import {installBridge,snapshot} from '../src/install';import {readDefinition,assertDefinition} from '../src/project-services';
import {cpSync} from 'node:fs';
import {registrations} from '../src/maintenance';
function fixture(){
 const home=realpathSync(mkdtempSync(join(tmpdir(),'adlc-readonly-registry-'))),repo=join(home,'repo'),config=join(home,'project.json'),path=join(home,'state/state.sqlite'),plist=join(home,'Library/LaunchAgents',legacyLabel+'.plist');mkdirSync(repo);mkdirSync(dirname(plist),{recursive:true});
 writeFileSync(config,JSON.stringify({version:1,name:'Legacy',repo,requiredChecks:['CI'],automation:{orchestratorProject:'legacy'},linear:{projectId:'00000000-0000-0000-0000-000000000001',teamId:'00000000-0000-0000-0000-000000000002',readyStateId:'00000000-0000-0000-0000-000000000003',readyLabelId:'00000000-0000-0000-0000-000000000004'}}));
 writeFileSync(plist,serviceDefinition(config,process.execPath,resolve(import.meta.dir,'../src/cli.ts'),home));return {home,repo,config,path,close:()=>rmSync(home,{recursive:true,force:true})};
}
test('read-only discovery shows an unregistered legacy service without creating a database',async()=>{
 const f=fixture();try{const rows=await registeredProjects(true,f.home,f.path);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({project:'legacy',label:legacyLabel,definitionInstalled:true});expect(existsSync(f.path)).toBe(false);expect(existsSync(dirname(f.path))).toBe(false);}finally{f.close();}
});
test('read-only discovery never inserts legacy registry rows or changes existing database bytes or permissions',async()=>{
 const f=fixture();try{
  const s=new Store(f.path);new ProjectServices(s);s.close();const before=readFileSync(f.path),mode=statSync(f.path).mode,files=readdirSync(dirname(f.path));
  expect(await registeredProjects(true,f.home,f.path)).toHaveLength(1);expect(readFileSync(f.path)).toEqual(before);expect(statSync(f.path).mode).toBe(mode);expect(readdirSync(dirname(f.path))).toEqual(files);
  const inspect=Store.readonly(f.path);try{expect(inspect.db.query('SELECT * FROM project_services').all()).toEqual([]);expect(()=>inspect.db.query('INSERT INTO project_services VALUES (?,?,?,?,?,?)').run('x','x','x','x','x','x')).toThrow();}finally{inspect.close();}
  expect(await registeredProjects(false,f.home,f.path)).toHaveLength(1);const persisted=Store.readonly(f.path);try{expect(persisted.db.query('SELECT project FROM project_services').all()).toEqual([{project:'legacy'}]);}finally{persisted.close();}
 }finally{f.close();}
});
test('read-only discovery does not initialize a project-services table in an older database',async()=>{
 const f=fixture();try{const s=new Store(f.path);s.close();await registeredProjects(true,f.home,f.path);const inspect=Store.readonly(f.path);try{expect(inspect.db.query("SELECT name FROM sqlite_master WHERE name='project_services'").all()).toEqual([]);}finally{inspect.close();}}finally{f.close();}
});
test('maintenance registration reads do not initialize tables, change bytes or modes, or create a missing registry',()=>{
 for(const initialized of [false,true]){const f=fixture();try{
   const s=new Store(f.path),expected=initialized?[new ProjectServices(s).register(f.config,legacyLabel)]:[];s.close();const before=readFileSync(f.path),mode=statSync(f.path).mode,files=readdirSync(dirname(f.path));
   expect(registrations(f.path)).toEqual(expected);expect(readFileSync(f.path)).toEqual(before);expect(statSync(f.path).mode).toBe(mode);expect(readdirSync(dirname(f.path))).toEqual(files);
  const inspect=Store.readonly(f.path);try{expect(inspect.db.query("SELECT name FROM sqlite_master WHERE name='project_services'").all()).toHaveLength(initialized?1:0);}finally{inspect.close();}
 }finally{f.close();}}
 const f=fixture();try{expect(()=>registrations(f.path)).toThrow();expect(existsSync(f.path)).toBe(false);expect(existsSync(dirname(f.path))).toBe(false);}finally{f.close();}
});
test('install preview discovers legacy projects without creating or changing the registry',async()=>{
 for(const existing of [false,true])for(const approvalRequired of [true,false]){const f=fixture();try{
  const config=JSON.parse(readFileSync(f.config,'utf8'));config.reviewers=[{id:'coderabbit',approvalRequired}];writeFileSync(f.config,JSON.stringify(config));const configBefore=readFileSync(f.config);
  if(existing){const s=new Store(f.path);new ProjectServices(s);s.close();}
  const before=existing?readFileSync(f.path):undefined,files=existing?readdirSync(dirname(f.path)):undefined;
  const io:any={state:()=>join(f.home,'ADLC Bridge'),home:()=>f.home,registeredProjects:(readOnly:boolean)=>registeredProjects(readOnly,f.home,f.path),readDefinition,assertDefinition};
  const preview=await installBridge(false,f.repo,join(f.home,'adlc'),io);expect(preview.projects).toEqual(['legacy']);expect(preview.preview).toBe(true);expect(readFileSync(f.config)).toEqual(configBefore);expect(existsSync(join(f.home,'ADLC Bridge'))).toBe(false);expect(existsSync(join(f.home,'adlc'))).toBe(false);
  if(existing){expect(readFileSync(f.path)).toEqual(before!);expect(readdirSync(dirname(f.path))).toEqual(files!);const s=Store.readonly(f.path);try{expect(new ProjectServices(s,false).list()).toEqual([]);}finally{s.close();}}
  else{expect(existsSync(f.path)).toBe(false);expect(existsSync(dirname(f.path))).toBe(false);}
 }finally{f.close();}}
});
test('application-source snapshot install preview accepts advisory CodeRabbit without a runtime patch',()=>{
 const f=fixture();try{
  // Test the packaged application code independently of dependency staging.
  cpSync(resolve(import.meta.dir,'../src'),join(f.repo,'src'),{recursive:true});
  const built=snapshot(f.repo,join(f.home,'snapshots')),root=dirname(dirname(built.cli));
  const config=JSON.parse(readFileSync(f.config,'utf8'));config.reviewers=[{id:'coderabbit',approvalRequired:false}];writeFileSync(f.config,JSON.stringify(config));
  writeFileSync(join(f.home,'Library/LaunchAgents',legacyLabel+'.plist'),serviceDefinition(f.config,process.execPath,built.cli,f.home));
  const script=`import {installBridge} from ${JSON.stringify(join(root,'src/install.ts'))};
import {registeredProjects} from ${JSON.stringify(join(root,'src/service-control.ts'))};
import {readDefinition,assertDefinition} from ${JSON.stringify(join(root,'src/project-services.ts'))};
const home=${JSON.stringify(f.home)},path=${JSON.stringify(f.path)};
console.log(JSON.stringify(await installBridge(false,${JSON.stringify(root)},home+'/adlc',{state:()=>home+'/ADLC Bridge',home:()=>home,registeredProjects:readOnly=>registeredProjects(readOnly,home,path),readDefinition,assertDefinition})));`;
  const result=Bun.spawnSync([process.execPath,'--no-install','--eval',script],{cwd:root,env:{HOME:f.home,PATH:process.env.PATH}});
  expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');
  expect(JSON.parse(result.stdout.toString())).toMatchObject({preview:true,source:root,projects:['legacy']});
  expect(existsSync(f.path)).toBe(false);expect(existsSync(join(f.home,'ADLC Bridge'))).toBe(false);expect(existsSync(join(f.home,'adlc'))).toBe(false);
 }finally{f.close();}
});

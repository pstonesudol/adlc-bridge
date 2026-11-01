import {test,expect} from 'bun:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,statSync,rmSync} from 'node:fs';import {join,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {registeredProjects} from '../src/service-control';import {Store} from '../src/core';import {ProjectServices,legacyLabel} from '../src/project-services';import {serviceDefinition} from '../src/init';
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'adlc-readonly-registry-')),repo=join(home,'repo'),config=join(home,'project.json'),path=join(home,'state/state.sqlite'),plist=join(home,'Library/LaunchAgents',legacyLabel+'.plist');mkdirSync(repo);mkdirSync(dirname(plist),{recursive:true});
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

import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../src/core';import {ProjectServices} from '../src/project-services';
import {migrateController} from '../src/controller-migration';import {turnBarrier} from '../src/turn-submission';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-bind-controller-'))),repo=join(root,'repo'),config=join(root,'project.json'),db=join(root,'Library/Application Support/ADLC Bridge/state.sqlite'),controller=join(root,'known/src/cli.ts');
 mkdirSync(repo);mkdirSync(dirname(controller),{recursive:true});writeFileSync(controller,'known controller',{mode:0o600});
 const uuid='00000000-0000-0000-0000-000000000001';writeFileSync(config,JSON.stringify({version:1,name:'Fixture',repo,requiredChecks:['CI'],automation:{orchestratorProject:'project'},linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid}}));
 const s=new Store(db);new ProjectServices(s).register(config);s.close();
 return {root,repo,config,db,controller,io:{path:()=>db,state:()=>join(root,'fence'),trustedControllers:()=>[controller]},close:()=>rmSync(root,{recursive:true,force:true})};
}
test('controller migration previews without writes, requires fresh confirmation and binds only the verified identity',async()=>{
 const f=fixture();try{
  const before=readFileSync(f.db),preview=await migrateController('project',f.controller,false,undefined,f.io);expect(preview.preview).toBe(true);expect(readFileSync(f.db)).toEqual(before);expect(existsSync(f.io.state())).toBe(false);
  await expect(migrateController('project',f.controller,true,'wrong',f.io)).rejects.toThrow('confirmation hash');expect(readFileSync(f.db)).toEqual(before);
  writeFileSync(f.controller,'updated known controller');await expect(migrateController('project',f.controller,true,preview.confirmation,f.io)).rejects.toThrow('state may have changed');expect(readFileSync(f.db)).toEqual(before);
  const c=JSON.parse(readFileSync(f.config,'utf8'));writeFileSync(f.config,JSON.stringify({...c,name:'Changed'}));await expect(migrateController('project',f.controller,true,preview.confirmation,f.io)).rejects.toThrow('state may have changed');
  const fresh=await migrateController('project',f.controller,false,undefined,f.io);expect((await migrateController('project',f.controller,true,fresh.confirmation,f.io)).applied).toBe(true);
  const s=Store.readonly(f.db);try{expect(s.db.query('SELECT controller FROM project_service_controllers').get()).toEqual({controller:f.controller});}finally{s.close();}
  const again=await migrateController('project',f.controller,false,undefined,f.io);expect(await migrateController('project',f.controller,true,again.confirmation,f.io)).toMatchObject({alreadyBound:true,applied:false});
  const other=join(f.root,'another/src/cli.ts');mkdirSync(dirname(other),{recursive:true});writeFileSync(other,'another verified fixture');const io={...f.io,trustedControllers:()=>[f.controller,other]};await expect(migrateController('project',other,false,undefined,io)).rejects.toThrow('binding differs');
 }finally{f.close();}
});
test('controller migration rejects untrusted/symlink targets and is blocked by an active submission',async()=>{
 const f=fixture();try{
  const other=join(f.root,'other.ts');writeFileSync(other,'other');await expect(migrateController('project',other,false,undefined,f.io)).rejects.toThrow('executing CLI');
  const link=join(f.root,'link');symlinkSync(f.controller,link);await expect(migrateController('project',link,false,undefined,f.io)).rejects.toThrow('executing CLI');
  const p=await migrateController('project',f.controller,false,undefined,f.io);await turnBarrier(f.io.state()).submit(async()=>{await expect(migrateController('project',f.controller,true,p.confirmation,f.io)).rejects.toThrow('in progress');});
  const s=Store.readonly(f.db);try{expect(s.db.query('SELECT * FROM project_service_controllers').all()).toEqual([]);}finally{s.close();}
 }finally{f.close();}
});
test('bind-controller CLI exposes a read-only preview using executing-code identity, not a plist',()=>{
 const f=fixture();try{
  const before=readFileSync(f.db),cli=resolve(import.meta.dir,'../src/cli.ts');
  const p=Bun.spawnSync([process.execPath,cli,'bind-controller','project',cli],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root},stdout:'pipe',stderr:'pipe'});
  expect(p.exitCode).toBe(0);expect(JSON.parse(p.stdout.toString())).toMatchObject({preview:true,project:'project',controller:realpathSync(cli)});expect(readFileSync(f.db)).toEqual(before);
 }finally{f.close();}
});

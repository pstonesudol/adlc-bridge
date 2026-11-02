import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('verified snapshot rotation preserves read-only registry bytes and only rebinds on an explicit write path',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'adlc-controller-rotation-')));
 try{
  const script=`
import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
import {ProjectServices,legacyLabel} from ${JSON.stringify(join(import.meta.dir,'../src/project-services.ts'))};
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join,dirname} from 'node:path';
const home=${JSON.stringify(home)},state=join(home,'Library/Application Support/ADLC Bridge'),repo=join(home,'repo'),config=join(home,'project.json'),db=join(home,'registry.sqlite');
const oldCLI=join(state,'versions/old/src/cli.ts'),newCLI=join(state,'versions/new/src/cli.ts'),rogue=join(repo,'rogue/cli.ts');
for(const path of [oldCLI,newCLI,rogue]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'');}
const uuid='00000000-0000-0000-0000-000000000001';writeFileSync(config,JSON.stringify({version:1,name:'Fixture',repo,requiredChecks:['CI'],automation:{orchestratorProject:'fixture'},linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid}}));
const def=cli=>({Label:legacyLabel,ProgramArguments:[process.execPath,cli,'poll',config]});
let s=new Store(db),registry=new ProjectServices(s);registry.register(config,legacyLabel);registry.assertInstalled(def(oldCLI),legacyLabel,config);s.close();
writeFileSync(join(state,'installation.json'),JSON.stringify({source:repo,cli:newCLI}),{mode:0o600});rmSync(oldCLI);
const before=readFileSync(db);s=Store.readonly(db);registry=new ProjectServices(s,false);registry.assertInstalled(def(newCLI),legacyLabel,config,false);const readBinding=s.db.query('SELECT controller FROM project_service_controllers').get().controller;s.close();const unchanged=before.equals(readFileSync(db));
s=new Store(db);registry=new ProjectServices(s);registry.assertInstalled(def(newCLI),legacyLabel,config);const writeBinding=s.db.query('SELECT controller FROM project_service_controllers').get().controller;let rejected=false;try{registry.assertInstalled(def(rogue),legacyLabel,config);}catch{rejected=true;}const finalBinding=s.db.query('SELECT controller FROM project_service_controllers').get().controller;s.close();
console.log(JSON.stringify({oldCLI,newCLI,readBinding,writeBinding,finalBinding,unchanged,rejected}));`;
  const child=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home},stdout:'pipe',stderr:'pipe'});
  expect(child.exitCode).toBe(0);expect(child.stderr.toString()).toBe('');
  const result=JSON.parse(child.stdout.toString());expect(result.readBinding).toBe(result.oldCLI);expect(result.unchanged).toBe(true);expect(result.writeBinding).toBe(result.newCLI);expect(result.finalBinding).toBe(result.newCLI);expect(result.rejected).toBe(true);
 }finally{rmSync(home,{recursive:true,force:true});}
});

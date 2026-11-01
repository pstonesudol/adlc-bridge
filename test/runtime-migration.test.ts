import {test,expect} from 'bun:test';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {installBridge} from '../src/install';import {trustedDaemon} from '../src/daemon-runtime';import {readDefinition,definitionXML} from '../src/project-services';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-runtime-migration-'))),home=join(root,'home'),state=join(root,'state'),source=join(root,'source'),launcher=join(root,'adlc');
 const prior=join(state,'versions/prior/src/serve-orchestrator.py'),binary=join(state,'runtimes/binary/ao'),pinPath=join(state,'orchestrator-runtime.json'),plist=join(home,'Library/LaunchAgents/local.adlc.orchestrator.plist');
 for(const dir of [dirname(prior),dirname(binary),dirname(plist),join(source,'src')])mkdirSync(dir,{recursive:true});
 writeFileSync(prior,'old launcher');writeFileSync(binary,'unchanged daemon',{mode:0o700});writeFileSync(join(source,'src/cli.ts'),'new cli');writeFileSync(join(source,'src/serve-orchestrator.py'),'new launcher');
 const pin={executable:binary,sha256:createHash('sha256').update('unchanged daemon').digest('hex'),serviceLabel:'local.adlc.orchestrator',launcher:prior,appRunId:'keep-run-id'};
 const def={Label:pin.serviceLabel,ProgramArguments:['/usr/bin/python3',prior],RunAtLoad:true,EnvironmentVariables:{CUSTOM_SETTING:'preserve'},ThrottleInterval:42};
 writeFileSync(pinPath,JSON.stringify(pin),{mode:0o600});writeFileSync(plist,definitionXML(def),{mode:0o600});writeFileSync(join(state,'installation.json'),'prior record',{mode:0o600});writeFileSync(launcher,'prior src/cli.ts launcher',{mode:0o755});
 const calls:string[]=[],io:any={state:()=>state,home:()=>home,registeredProjects:async()=>[],readDefinition,assertDefinition:()=>{},trustedDaemon,
  serviceControl:async()=>{calls.push('service');throw Error('Must not control backend');},localAO:async()=>{calls.push('AO');throw Error('No projects');},installWorkflowHook:async()=>{calls.push('hook');throw Error('No projects');}};
 return {root,home,state,source,launcher,prior,binary,pinPath,plist,pin,def,io,calls,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('bridge activation migrates runtime pin and plist to the new snapshot without restarting or altering the daemon',async()=>{
 const f=fixture();try{
  const oldPin=readFileSync(f.pinPath),oldPlist=readFileSync(f.plist);const preview=await installBridge(false,f.source,f.launcher,f.io);expect(preview.runtimeLauncherMigration).toBe(true);expect(readFileSync(f.pinPath)).toEqual(oldPin);
  const result=await installBridge(true,f.source,f.launcher,f.io),next=join(dirname(result.cli!),'serve-orchestrator.py');
  expect(JSON.parse(readFileSync(f.pinPath,'utf8'))).toEqual({...f.pin,launcher:next});expect(readDefinition(f.plist)).toEqual({...f.def,ProgramArguments:['/usr/bin/python3',next]});expect(readFileSync(next,'utf8')).toBe('new launcher');
  expect(readFileSync(f.binary,'utf8')).toBe('unchanged daemon');expect(trustedDaemon(f.binary,f.pinPath)).toBe(true);expect(result.runtimeRestartRequired).toBe(true);expect(f.calls).toEqual([]);
  expect(readFileSync(join(result.backup!,'orchestrator-runtime.json'))).toEqual(oldPin);expect(readFileSync(join(result.backup!,'orchestrator-runtime.plist'))).toEqual(oldPlist);
 }finally{f.close();}
});
test('runtime migration rolls back both registrations and the installation record on trust failure or later launcher failure',async()=>{
 for(const failure of ['trust','launcher']){const f=fixture();try{
  const oldPin=readFileSync(f.pinPath),oldPlist=readFileSync(f.plist);let launcher=f.launcher;
  if(failure==='trust'){let checks=0;f.io.trustedDaemon=(path:string,config:string)=>++checks===1&&trustedDaemon(path,config);}
  else{const block=join(f.root,'blocked');writeFileSync(block,'not a directory');launcher=join(block,'adlc');}
  await expect(installBridge(true,f.source,launcher,f.io)).rejects.toThrow();expect(readFileSync(f.pinPath)).toEqual(oldPin);expect(readFileSync(f.plist)).toEqual(oldPlist);expect(readFileSync(join(f.state,'installation.json'),'utf8')).toBe('prior record');expect(f.calls).toEqual([]);
 }finally{f.close();}}
});
test('runtime migration refuses untrusted binaries, mismatched plists and symlinked pins before activating a snapshot',async()=>{
 for(const change of [(f:any)=>writeFileSync(f.binary,'tampered'),(f:any)=>writeFileSync(f.plist,definitionXML({...f.def,ProgramArguments:['/bin/sh',f.prior]})),(f:any)=>{const saved=join(f.state,'saved-pin');writeFileSync(saved,readFileSync(f.pinPath),{mode:0o600});rmSync(f.pinPath);symlinkSync(saved,f.pinPath);}]){const f=fixture();try{
  change(f);await expect(installBridge(true,f.source,f.launcher,f.io)).rejects.toThrow();expect(readFileSync(join(f.state,'installation.json'),'utf8')).toBe('prior record');expect(f.calls).toEqual([]);expect(existsSync(join(f.state,'backups'))).toBe(false);
 }finally{f.close();}}
});

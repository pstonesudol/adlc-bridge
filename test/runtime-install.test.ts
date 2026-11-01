import {test,expect} from 'bun:test';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,mkdirSync,existsSync,statSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {installRuntime} from '../src/runtime-install';import {trustedDaemon} from '../src/daemon-runtime';
import {stackControl,type StackOps} from '../src/stack-control';import {turnBarrier} from '../src/turn-submission';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-runtime-install-'))),state=join(root,'state'),home=join(root,'home'),binary=join(root,'build-ao');mkdirSync(state);mkdirSync(home);writeFileSync(binary,'original binary');
 const pin=join(state,'orchestrator-runtime.json'),plist=join(home,'Library/LaunchAgents/local.adlc.orchestrator.plist');let status='stopped',failTrust=false;
 const io:any={state:()=>state,home:()=>home,installedCLI:()=>join(root,'versions/version/src/cli.ts'),command:(args:string[])=>{
  if(args[1]==='status'){writeFileSync(binary,'source replaced after initial hash');return {stdout:Buffer.from(JSON.stringify({state:status})),exitCode:0};}
  return {exitCode:1};
 },trustedDaemon:(exe:string)=>!failTrust&&trustedDaemon(exe,pin)};
 return {root,binary,pin,plist,io,status:(s:string)=>status=s,failTrust:()=>failTrust=true,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('runtime installs the originally hashed bytes despite a changed source and passes real trust verification',async()=>{
 for(const status of ['stopped','not_running']){const f=fixture();try{f.status(status);const r=await installRuntime(f.binary,true,f.io);expect(readFileSync(r.executable!,'utf8')).toBe('original binary');expect(r.sha256).toBe(createHash('sha256').update('original binary').digest('hex'));expect(trustedDaemon(r.executable!,f.pin)).toBe(true);expect(statSync(f.pin).mode&0o777).toBe(0o600);expect(statSync(f.plist).mode&0o777).toBe(0o600);}finally{f.close();}}
});
test('runtime registration restores both prior files if the post-install trust check rejects',async()=>{
 const f=fixture();try{mkdirSync(join(f.io.home(),'Library/LaunchAgents'),{recursive:true});const old='{"serviceLabel":"local.adlc.orchestrator"}\n';writeFileSync(f.pin,old,{mode:0o600});writeFileSync(f.plist,'prior plist');f.failTrust();await expect(installRuntime(f.binary,true,f.io)).rejects.toThrow('not trusted');expect(readFileSync(f.pin,'utf8')).toBe(old);expect(readFileSync(f.plist,'utf8')).toBe('prior plist');}finally{f.close();}
});
test('runtime status failures are rejected before creating registrations',async()=>{
 for(const result of [{stdout:Buffer.from('malformed'),exitCode:0},{stdout:Buffer.from('{"state":"stopped"}'),exitCode:1}]){const f=fixture();try{f.io.command=()=>result;await expect(installRuntime(f.binary,true,f.io)).rejects.toThrow();expect(existsSync(f.pin)).toBe(false);expect(existsSync(f.plist)).toBe(false);}finally{f.close();}}
});
test('runtime rollback reports the original failure and every affected path instead of discarding restoration errors',async()=>{
 const f=fixture();try{
  mkdirSync(join(f.io.home(),'Library/LaunchAgents'),{recursive:true});writeFileSync(f.pin,'{"serviceLabel":"local.adlc.orchestrator"}',{mode:0o600});writeFileSync(f.plist,'prior plist');const original=Error('trust check failed');
  f.io.trustedDaemon=()=>{for(const path of [f.pin,f.plist]){rmSync(path);mkdirSync(path);}throw original;};
  const error=await installRuntime(f.binary,true,f.io).catch(error=>error);expect(error).toBeInstanceOf(AggregateError);expect(error.errors).toHaveLength(3);expect(error.errors[0]).toBe(original);expect(error.message).toContain(original.message);
  for(const [i,path] of [f.pin,f.plist].entries()){expect(error.message).toContain(path);expect(error.errors[i+1].message).toContain(path);expect(error.errors[i+1].cause).toBeInstanceOf(Error);}
 }finally{f.close();}
});
test('runtime rollback continues restoring the plist after pin restoration fails',async()=>{
 const f=fixture();try{
  mkdirSync(join(f.io.home(),'Library/LaunchAgents'),{recursive:true});writeFileSync(f.pin,'{"serviceLabel":"local.adlc.orchestrator"}',{mode:0o600});writeFileSync(f.plist,'prior plist');
  f.io.trustedDaemon=()=>{rmSync(f.pin);mkdirSync(f.pin);return false;};
  const error=await installRuntime(f.binary,true,f.io).catch(error=>error);expect(error).toBeInstanceOf(AggregateError);expect(error.errors).toHaveLength(2);expect(error.errors[0].message).toContain('not trusted');expect(error.message).toContain(f.pin);expect(readFileSync(f.plist,'utf8')).toBe('prior plist');
 }finally{f.close();}
});
test('successful runtime rollback preserves the original error identity',async()=>{
 const f=fixture();try{
  const original=Error('trust read failed');f.io.trustedDaemon=()=>{throw original;};
  expect(await installRuntime(f.binary,true,f.io).catch(error=>error)).toBe(original);expect(existsSync(f.pin)).toBe(false);expect(existsSync(f.plist)).toBe(false);
 }finally{f.close();}
});
test('runtime apply excludes stack definition reads and the next start uses the newly registered binary',async()=>{
 const f=fixture();try{
  const prior=await installRuntime(f.binary,true,f.io);writeFileSync(f.binary,'new runtime bytes');
  const stackModule=join(import.meta.dir,'../src/stack-control.ts');
  const script=`import {stackControl} from ${JSON.stringify(stackModule)};import {readFileSync} from 'node:fs';let reads=0,started=null,on=false,error=null;try{await stackControl('start',{state:()=>${JSON.stringify(f.io.state())},ops:(_readOnly,turns)=>{reads++;const pin=JSON.parse(readFileSync(${JSON.stringify(f.pin)},'utf8'));return {turns,projects:async()=>[],project:async()=>({}),backendStart:async()=>{on=true;started=pin.executable;},backend:async()=>({ready:on,loaded:on,managed:true}),backendStop:async()=>{},blockers:async()=>[]};}});}catch(e){error=e.message;}console.log(JSON.stringify({reads,started,error}));`;
  const start=()=>Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root}});
  let overlap:any;const command=f.io.command;f.io.command=(args:string[])=>{if(args[1]==='status')overlap=start();return command(args);};
  const installed=await installRuntime(f.binary,true,f.io);expect(overlap.exitCode).toBe(0);expect(JSON.parse(overlap.stdout.toString())).toMatchObject({reads:0,started:null,error:expect.stringContaining('in progress')});
  expect(installed.executable).not.toBe(prior.executable);const later=start();expect(later.exitCode).toBe(0);expect(later.stderr.toString()).toBe('');expect(JSON.parse(later.stdout.toString())).toEqual({reads:1,started:installed.executable,error:null});expect(existsSync(join(f.io.state(),'turn-submission.lock'))).toBe(false);
 }finally{f.close();}
},15000);
test('a held stack-start scope rejects runtime installation before registration preflight',async()=>{
 const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let startup:Promise<any>|undefined;
 try{
  let entered!:()=>void;const starting=new Promise<void>(resolve=>entered=resolve);let reads=0;
  const io={state:f.io.state,ops:(_readOnly:boolean,turns:ReturnType<typeof turnBarrier>):StackOps=>{expect(existsSync(join(f.io.state(),'turn-submission.lock'))).toBe(true);return {turns,projects:async()=>[],project:async()=>({}),backendStart:async()=>{entered();await gate;},backend:async()=>({ready:true,loaded:true,managed:true}),backendStop:async()=>{},blockers:async()=>[]};}};
  startup=stackControl('start',io);await starting;
  await expect(installRuntime(f.binary,true,{...f.io,installedCLI:()=>{reads++;return f.io.installedCLI();},command:()=>{reads++;throw Error('Must not probe while stack start owns the fence');}})).rejects.toThrow('in progress');expect(reads).toBe(0);expect(existsSync(f.pin)).toBe(false);expect(existsSync(f.plist)).toBe(false);
  release();await startup;expect(existsSync(join(f.io.state(),'turn-submission.lock'))).toBe(false);
 }finally{release?.();if(startup)await startup.catch(()=>{});f.close();}
});
test('runtime preview stays read-only and lock-free while another process owns the control fence',async()=>{
 const f=fixture();try{
  const module=join(import.meta.dir,'../src/runtime-install.ts'),script=`import {installRuntime} from ${JSON.stringify(module)};console.log(JSON.stringify(await installRuntime(${JSON.stringify(f.binary)},false,{state:()=>${JSON.stringify(f.io.state())},home:()=>${JSON.stringify(f.io.home())},installedCLI:()=>${JSON.stringify(f.io.installedCLI())},command:()=>{throw Error('Preview must not probe services');},trustedDaemon:()=>{throw Error('Preview must not change registration');}})));`;
  await turnBarrier(f.io.state()).run(async()=>{const child=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:f.root}});expect(child.exitCode).toBe(0);expect(child.stderr.toString()).toBe('');expect(JSON.parse(child.stdout.toString()).preview).toBe(true);});
  expect(existsSync(f.pin)).toBe(false);expect(existsSync(f.plist)).toBe(false);expect(existsSync(join(f.io.state(),'backups'))).toBe(false);expect(existsSync(join(f.io.state(),'runtimes'))).toBe(false);
 }finally{f.close();}
},15000);

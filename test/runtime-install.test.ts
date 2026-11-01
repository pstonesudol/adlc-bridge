import {test,expect} from 'bun:test';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,mkdirSync,existsSync,statSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {installRuntime} from '../src/runtime-install';import {trustedDaemon} from '../src/daemon-runtime';
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

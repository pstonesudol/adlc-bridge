import {test,expect} from 'bun:test';import {trustedDaemon,bundledAO} from '../src/daemon-runtime';import {realpathSync,mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {spyOn} from 'bun:test';import {symlinkSync} from 'node:fs';
test('stock daemon is accepted; custom backend requires an exact owner-only hash pin',()=>{const dir=realpathSync(mkdtempSync(join(tmpdir(),'adlc-daemon-')));try{const exe=join(dir,'ao'),config=join(dir,'runtime.json');writeFileSync(exe,'test-backend',{mode:0o700});expect(trustedDaemon(bundledAO,config)).toBe(true);expect(trustedDaemon(exe,config)).toBe(false);writeFileSync(config,JSON.stringify({executable:exe,sha256:createHash('sha256').update('test-backend').digest('hex')}),{mode:0o600});expect(trustedDaemon(exe,config)).toBe(true);writeFileSync(exe,'changed-backend');expect(trustedDaemon(exe,config)).toBe(false);chmodSync(config,0o644);expect(()=>trustedDaemon(exe,config)).toThrow('owner-only');}finally{rmSync(dir,{recursive:true,force:true});}});
test('daemon pin rejects symlinks, writable binaries, mismatched paths, malformed hashes and wrong ownership',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'adlc-daemon-')));
 try{
  const exe=join(dir,'ao'),config=join(dir,'runtime.json'),link=join(dir,'link');const sha256=createHash('sha256').update('binary').digest('hex');
  writeFileSync(exe,'binary',{mode:0o700});const pin=(executable=exe,sha=sha256)=>writeFileSync(config,JSON.stringify({executable,sha256:sha}),{mode:0o600});pin();
  symlinkSync(exe,link);pin(link);expect(trustedDaemon(link,config)).toBe(false);pin();
  for(const mode of [0o720,0o702]){chmodSync(exe,mode);expect(trustedDaemon(exe,config)).toBe(false);}chmodSync(exe,0o700);
  pin(link);expect(trustedDaemon(exe,config)).toBe(false);pin(exe,'not-a-sha');expect(trustedDaemon(exe,config)).toBe(false);pin();
  const configLink=join(dir,'pin-link');symlinkSync(config,configLink);expect(()=>trustedDaemon(exe,configLink)).toThrow('owner-only');
  const uid=process.getuid!();const spy=spyOn(process,'getuid').mockReturnValue(uid+1);try{expect(()=>trustedDaemon(exe,config)).toThrow('owner-only');}finally{spy.mockRestore();}
  expect(trustedDaemon(exe,config)).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

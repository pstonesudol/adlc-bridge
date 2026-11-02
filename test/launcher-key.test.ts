import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,statSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
test('launcher creates private keys under permissive umask and rejects unsafe existing keys without overwriting',()=>{
 const home=mkdtempSync(join(tmpdir(),'adlc-key-'));
 try{
  const source=readFileSync(join(import.meta.dir,'../src/serve-orchestrator.py'),'utf8');
  const program="from pathlib import Path\nimport os,base64,secrets,stat\nos.umask(0)\n"+source.slice(source.indexOf("data=Path.home()"),source.indexOf('records=raw'));
  const run=()=>Bun.spawnSync(['/usr/bin/python3','-c',program],{env:{...process.env,HOME:home}});
  expect(run().exitCode).toBe(0);const key=join(home,'.ao/data/browser-runtime.key'),original=readFileSync(key,'utf8');expect(statSync(key).mode&0o777).toBe(0o600);expect(run().exitCode).toBe(0);expect(readFileSync(key,'utf8')).toBe(original);
  chmodSync(key,0o644);expect(run().exitCode).not.toBe(0);expect(readFileSync(key,'utf8')).toBe(original);
  rmSync(key);const other=join(home,'other');writeFileSync(other,original,{mode:0o600});symlinkSync(other,key);expect(run().exitCode).not.toBe(0);expect(readFileSync(other,'utf8')).toBe(original);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('optimized Python retains binary-hash and decoded-key-length trust checks',()=>{
 const home=mkdtempSync(join(tmpdir(),'adlc-optimized-trust-'));try{
  const root=join(home,'Library/Application Support/ADLC Bridge'),exe=join(home,'test-binary');mkdirSync(root,{recursive:true});writeFileSync(exe,'test-only binary');
  const manifest=join(root,'orchestrator-runtime.json'),sha256=createHash('sha256').update('test-only binary').digest('hex');writeFileSync(manifest,JSON.stringify({executable:exe,sha256}));
  const source=readFileSync(join(import.meta.dir,'../src/serve-orchestrator.py'),'utf8'),trust=source.slice(0,source.indexOf("resources=Path("));
  // Execute the real trust gates only; never launch a daemon or touch launchd.
  const run=(prefix='')=>Bun.spawnSync(['/usr/bin/python3','-O','-c',prefix+trust+"\nprint('trust passed')\n"],{env:{PATH:'/usr/bin:/bin',HOME:home}});
  const valid=run();expect(valid.exitCode).toBe(0);expect(valid.stdout.toString()).toBe('trust passed\n');
  writeFileSync(exe,'changed binary');const changed=run();expect(changed.exitCode).not.toBe(0);expect(changed.stderr.toString()).toContain('Hotfix binary changed');expect(changed.stdout.toString()).toBe('');
  writeFileSync(exe,'test-only binary');
  // A valid 43-character record normally decodes to 32 bytes. Stub only the
  // decoder to exercise the defensive length gate under optimization.
  const invalid=run("import base64\nbase64.urlsafe_b64decode=lambda _: b'short'\n");expect(invalid.exitCode).not.toBe(0);expect(invalid.stderr.toString()).toContain('Browser runtime key must decode to exactly 32 bytes');expect(invalid.stdout.toString()).toBe('');
 }finally{rmSync(home,{recursive:true,force:true});}
});

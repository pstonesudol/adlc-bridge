import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,statSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
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

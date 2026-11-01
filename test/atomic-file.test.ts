import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {atomicFile} from '../src/atomic-file';
test('atomic writes verify staged bytes before replacement and preserve targets on rejection',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-atomic-')),path=join(root,'pin');
 try{
  writeFileSync(path,'prior');
  expect(()=>atomicFile(path,'replacement',0o600,staged=>{expect(readFileSync(path,'utf8')).toBe('prior');expect(readFileSync(staged,'utf8')).toBe('replacement');throw Error('verification failed');})).toThrow('verification failed');
  expect(readFileSync(path,'utf8')).toBe('prior');expect(readdirSync(root)).toEqual(['pin']);
  atomicFile(path,'replacement',0o600);expect(readFileSync(path,'utf8')).toBe('replacement');expect(statSync(path).mode&0o777).toBe(0o600);
 }finally{rmSync(root,{recursive:true,force:true});}
});

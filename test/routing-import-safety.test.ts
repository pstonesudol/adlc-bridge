import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync,lstatSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';
import {importRouting} from '../src/routing-config';import {routingConfig} from './routing-fixture';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'adlc-import-safety-')),source=join(dir,'source.json');writeFileSync(source,JSON.stringify(routingConfig));return {dir,source};}
test('import rejects regular and dangling destination symlinks without changing any files',()=>{
 for(const dangling of [false,true]){const f=fixture();try{
  const other=join(f.dir,'other.json'),destination=join(f.dir,'routing.json');if(!dangling)writeFileSync(other,'existing configuration');symlinkSync(other,destination);
  const before=readdirSync(f.dir).sort(),source=readFileSync(f.source,'utf8');
  for(const apply of [false,true]){expect(()=>importRouting(f.source,destination,apply)).toThrow('must not be a symlink');expect(lstatSync(destination).isSymbolicLink()).toBe(true);expect(readFileSync(f.source,'utf8')).toBe(source);expect(readdirSync(f.dir).sort()).toEqual(before);if(dangling)expect(existsSync(other)).toBe(false);else expect(readFileSync(other,'utf8')).toBe('existing configuration');}
 }finally{rmSync(f.dir,{recursive:true,force:true});}}
});
test('import uses the real destination directory through a symlinked parent and preserves regular backups',()=>{
 for(const exists of [false,true]){const f=fixture();try{
  const real=join(f.dir,'real'),alias=join(f.dir,'alias');mkdirSync(real);symlinkSync(real,alias,'dir');const destination=join(alias,'routing.json');if(exists)writeFileSync(destination,'old configuration');
  const before=readdirSync(real).sort();expect(importRouting(f.source,destination).applied).toBe(false);expect(readdirSync(real).sort()).toEqual(before);
  const result=importRouting(f.source,destination,true);expect(lstatSync(alias).isSymbolicLink()).toBe(true);expect(lstatSync(destination).isFile()).toBe(true);expect(JSON.parse(readFileSync(destination,'utf8')).version).toBe(1);
  if(exists){expect(dirname(result.backup!)).toBe(realpathSync(real));expect(readFileSync(result.backup!,'utf8')).toBe('old configuration');}else expect(result.backup).toBeNull();
  expect(readdirSync(real).some(name=>name.startsWith('.routing-'))).toBe(false);expect(JSON.parse(readFileSync(f.source,'utf8'))).toEqual(routingConfig);
 }finally{rmSync(f.dir,{recursive:true,force:true});}}
});
test('backup collision cannot overwrite an existing backup or modify the destination',()=>{
 const f=fixture();const random=spyOn(crypto,'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
 try{
  const destination=join(f.dir,'routing.json'),backup=destination+'.backup-00000000-0000-4000-8000-000000000001';writeFileSync(destination,'old configuration');writeFileSync(backup,'preserved backup');const before=readdirSync(f.dir).sort();
  expect(()=>importRouting(f.source,destination,true)).toThrow();expect(readFileSync(destination,'utf8')).toBe('old configuration');expect(readFileSync(backup,'utf8')).toBe('preserved backup');expect(readdirSync(f.dir).sort()).toEqual(before);
 }finally{random.mockRestore();rmSync(f.dir,{recursive:true,force:true});}
});
test('prototype-like source keys are unsupported and never copied into the routing document',()=>{
 const f=fixture();try{
  const raw=JSON.parse(JSON.stringify(routingConfig));for(const key of ['__proto__','constructor','prototype'])Object.defineProperty(raw,key,{value:{adlcPolluted:true},enumerable:true});writeFileSync(f.source,JSON.stringify(raw));
  const result=importRouting(f.source,join(f.dir,'routing.json'));expect(result.unsupported).toEqual(['__proto__','constructor','prototype']);expect(Object.getPrototypeOf(result.config)).toBe(Object.prototype);expect(({} as any).adlcPolluted).toBeUndefined();for(const key of result.unsupported)expect(Object.hasOwn(result.config,key)).toBe(false);
 }finally{rmSync(f.dir,{recursive:true,force:true});}
});

import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {copyFrontend} from '../src/container-check';
test('verification snapshot excludes credentials, generated files and escaping links',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-test-'));
 try{
 const src=join(root,'src'),dst=join(root,'dst');mkdirSync(src);
 writeFileSync(join(src,'page.tsx'),'page');writeFileSync(join(src,'.env.local'),'secret');
 mkdirSync(join(src,'node_modules'));writeFileSync(join(src,'node_modules','private'),'secret');
 symlinkSync('/etc',join(src,'outside'));
 copyFrontend(src,dst);
 expect(existsSync(join(dst,'page.tsx'))).toBe(true);
 for(const name of ['.env.local','node_modules','outside'])expect(existsSync(join(dst,name))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

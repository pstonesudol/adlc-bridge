import {test,expect} from 'bun:test';
import {readFileSync,writeFileSync,rmSync,existsSync,readdirSync,symlinkSync,copyFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {snapshot,distributionFiles} from '../src/install';
import {routingClientURL,routingRuntimePackages} from '../src/routing-dependencies';
import {routingRuntimeFixture} from './routing-runtime-fixture';

test('snapshot hashes and packages pinned runtime closure without secrets, unrelated packages or runtime installation',()=>{
 const f=routingRuntimeFixture();try{
  expect(routingRuntimePackages['@opencode/client']).toBe('2.2.5');const files=distributionFiles(f.source);
  expect(files).toContain('node_modules/@opencode/client/dist/promise/service.js');expect(files.some(p=>p.includes('.env')||p.includes('unrelated'))).toBe(false);
  const built=snapshot(f.source,f.destination),installed=dirname(dirname(built.cli));
  expect(JSON.parse(readFileSync(join(installed,'manifest.json'),'utf8')).files).toEqual(files);
  expect(readFileSync(join(installed,'node_modules/@opencode/client/LICENSE'),'utf8')).toBe('fixture license');
  rmSync(join(f.source,'node_modules'),{recursive:true});
  const probe=Bun.spawnSync([process.execPath,'--no-install','--eval',`const {Service}=await import(${JSON.stringify(routingClientURL(installed))});console.log(typeof Service.discover);`],{cwd:installed,env:{HOME:f.root,PATH:process.env.PATH},stdout:'pipe',stderr:'pipe'});
  expect(probe.exitCode).toBe(0);expect(probe.stdout.toString().trim()).toBe('function');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('missing incompatible and symlinked dependencies fail snapshot preparation without publishing a version',()=>{
 for(const kind of ['missing','version','dependency','symlink']){const f=routingRuntimeFixture();try{
  const manifest=join(f.source,'node_modules/@opencode/client/package.json');
  if(kind==='missing')rmSync(join(f.source,'node_modules/effect'),{recursive:true});
  if(kind==='version'||kind==='dependency'){const pkg=JSON.parse(readFileSync(manifest,'utf8'));if(kind==='version')pkg.version='2.2.6';else pkg.dependencies.unknown='1.0.0';writeFileSync(manifest,JSON.stringify(pkg));}
  if(kind==='symlink'){const path=join(f.source,'node_modules/@opencode/client/dist/promise/service.js');rmSync(path);symlinkSync('/outside-fixture',path);}
  expect(()=>snapshot(f.source,f.destination)).toThrow();expect(existsSync(f.destination)).toBe(false);
 }finally{rmSync(f.root,{recursive:true,force:true});}}
});
test('unloadable or partial dependency copies never publish and dependency content changes the version hash',()=>{
 const f=routingRuntimeFixture();try{
  const built=snapshot(f.source,f.destination),entry=join(f.source,'node_modules/@opencode/client/dist/promise/service.js'),original=readFileSync(entry,'utf8');
  writeFileSync(entry,original+'\n// new bytes');const changed=snapshot(f.source,f.destination);expect(changed.version).not.toBe(built.version);
  writeFileSync(entry,'export const Service={};');expect(()=>snapshot(f.source,f.destination)).toThrow('import verification failed');expect(readdirSync(f.destination).sort()).toEqual([built.version,changed.version].sort());
  writeFileSync(entry,original);
  const partial=f.destination+'-partial';expect(()=>snapshot(f.source,partial,(from,to)=>{copyFileSync(from,to);if(from.includes('node_modules/effect/dist/'))writeFileSync(to,'partial');})).toThrow('Source changed');expect(readdirSync(partial)).toEqual([]);
  writeFileSync(join(dirname(dirname(built.cli)),'node_modules/@opencode/client/dist/promise/service.js'),'tampered');expect(()=>snapshot(f.source,f.destination)).toThrow('changed');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

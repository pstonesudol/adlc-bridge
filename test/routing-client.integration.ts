// Explicit installed-client integration: bun test ./test/routing-client.integration.ts
// The dependency-free default suite tests ADLC's adapter in routing-classifier.test.ts.
import {test,expect} from 'bun:test';
import {Service} from '@opencode/client/service';
import {classifyOpenCode,connectClassifier} from '../src/routing-config';
import {routingConfig} from './routing-fixture';
import {snapshot} from '../src/install';import {routingClientURL} from '../src/routing-dependencies';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,dirname,resolve} from 'node:path';

test('pinned native client discovers/authenticates only the temporary service without changing its registration',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-service-fixture-')),file=join(dir,'service.json'),paths:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  expect(request.headers.get('authorization')).toBe('Basic '+Buffer.from('opencode:fixture-only').toString('base64'));
  const path=new URL(request.url).pathname;paths.push(path);
  if(path==='/api/info')return Response.json({version:'2.2.5',pid:process.pid});
  expect(path).toBe('/api/experimental/generate/text');expect((await request.json()).prompt).toContain('private fixture');
  return Response.json({data:{text:JSON.stringify({choice:'implement',confidence:0.99})}});
 }});
 const registration=JSON.stringify({version:'2.2.5',pid:process.pid,url:server.url.toString(),password:'fixture-only'});writeFileSync(file,registration,{mode:0o600});
 try{
  // Use ADLC's actual connection boundary and the installed client. Only the
  // native registration file argument is redirected to this disposable fixture.
  const connect=()=>connectClassifier(async()=>({Service:{...Service,discover:options=>Service.discover({...options,file})}}));
  const result=await classifyOpenCode('authorized/classifier','private fixture',routingConfig,{connect,fetch,timeoutMs:1000});
  expect(result.choice).toBe('implement');expect(paths).toEqual(['/api/info','/api/experimental/generate/text']);expect(readFileSync(file,'utf8')).toBe(registration);
 }finally{server.stop(true);rmSync(dir,{recursive:true,force:true});}
});
test('real pinned runtime closure loads from a verified snapshot with auto-install disabled',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-native-snapshot-'));
 try{
  const built=snapshot(resolve(import.meta.dir,'..'),join(root,'versions')),installed=dirname(dirname(built.cli));
  const proc=Bun.spawnSync([process.execPath,'--no-install','--eval',`const {Service}=await import(${JSON.stringify(routingClientURL(installed))});if(typeof Service.discover!=='function')throw Error('not packaged');console.log('packaged client loaded');`],{cwd:installed,env:{HOME:root,PATH:process.env.PATH},stdout:'pipe',stderr:'pipe',timeout:10000});
  expect(proc.stderr.toString()).toBe('');expect(proc.exitCode).toBe(0);expect(proc.stdout.toString().trim()).toBe('packaged client loaded');
 }finally{rmSync(root,{recursive:true,force:true});}
});

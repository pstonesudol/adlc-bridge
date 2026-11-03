import {test,expect} from 'bun:test';
import {classifyOpenCode,type ClassifierTransport} from '../src/routing-config';
import {TaskRouting} from '../src/task-routing';
import {Store} from '../src/core';
import {routingConfig,settings} from './routing-fixture';
import {Service} from '@opencode/client/service';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';

const answer=()=>Response.json({data:{text:JSON.stringify({choice:'implement',confidence:0.99})}});
function transport(overrides:Partial<ClassifierTransport>={}):ClassifierTransport{
 return {connect:async()=>({url:'http://127.0.0.1:12345',headers:{authorization:'Bearer fixture-only'}}),fetch:async()=>answer(),timeoutMs:1000,...overrides};
}
test('classifier sends private task data only in a stateless generation HTTP body',async()=>{
 let calls=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  calls++;expect(new URL(request.url).pathname).toBe('/api/experimental/generate/text');expect(request.method).toBe('POST');
  expect(request.headers.get('authorization')).toBe('Bearer fixture-only');
  const body=await request.json();expect(Object.keys(body).sort()).toEqual(['model','prompt']);expect(body.model).toEqual({providerID:'authorized',id:'classifier/nested'});expect(body.prompt).toContain('private Linear fixture');expect(request.url).not.toContain('private');
  // No agent/session route or permission verification is needed or permitted:
  // even a service with tool-allowing agent/managed config receives only generation.
  return answer();
 }});
 try{const result=await classifyOpenCode('authorized/classifier/nested','private Linear fixture',routingConfig,transport({connect:async()=>({url:server.url.toString(),headers:{authorization:'Bearer fixture-only'}}),fetch}));expect(result.choice).toBe('implement');expect(calls).toBe(1);}finally{server.stop(true);}
});
test('pinned native client discovers/authenticates only the temporary service without changing its registration',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-service-fixture-')),file=join(dir,'service.json'),paths:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  expect(request.headers.get('authorization')).toBe('Basic '+Buffer.from('opencode:fixture-only').toString('base64'));
  const path=new URL(request.url).pathname;paths.push(path);
  if(path==='/api/info')return Response.json({version:'2.2.5',pid:process.pid});
  expect(path).toBe('/api/experimental/generate/text');expect((await request.json()).prompt).toContain('private fixture');return answer();
 }});
 const registration=JSON.stringify({version:'2.2.5',pid:process.pid,url:server.url.toString(),password:'fixture-only'});writeFileSync(file,registration,{mode:0o600});
 try{const result=await classifyOpenCode('authorized/classifier','private fixture',routingConfig,transport({connect:async()=>{
  const endpoint=await Service.discover({file,version:version=>version.startsWith('2.')});if(!endpoint)throw Error('Fixture discovery failed');return {url:endpoint.url,headers:Service.headers(endpoint)??{}};
 },fetch}));expect(result.choice).toBe('implement');expect(paths).toEqual(['/api/info','/api/experimental/generate/text']);expect(readFileSync(file,'utf8')).toBe(registration);}finally{server.stop(true);rmSync(dir,{recursive:true,force:true});}
});
test('deadline bounds discovery even if connection never settles',async()=>{
 let called=false;
 await expect(classifyOpenCode('authorized/classifier','task',routingConfig,transport({timeoutMs:30,connect:()=>new Promise(()=>{}),fetch:async()=>{called=true;return answer();}}))).rejects.toThrow('deadline');
 expect(called).toBe(false);
});
test('late discovery after the deadline cannot send private data',async()=>{
 let release!:(value:Awaited<ReturnType<ClassifierTransport['connect']>>)=>void,called=false;
 const pending=new Promise<Awaited<ReturnType<ClassifierTransport['connect']>>>(resolve=>{release=resolve;});
 await expect(classifyOpenCode('authorized/classifier','task',routingConfig,transport({timeoutMs:30,connect:()=>pending,fetch:async()=>{called=true;return answer();}}))).rejects.toThrow('deadline');
 release({url:'http://127.0.0.1:1',headers:{}});await Promise.resolve();await Promise.resolve();expect(called).toBe(false);
});
test('deadline aborts HTTP and cancels stdout-replacement stream without waiting for cancellation',async()=>{
 let signal:AbortSignal|undefined,cancelled=false;
 const body=new ReadableStream<Uint8Array>({pull:()=>new Promise(()=>{}),cancel(){cancelled=true;return new Promise(()=>{});}});
 await expect(classifyOpenCode('authorized/classifier','task',routingConfig,transport({timeoutMs:30,fetch:async(_,options)=>{signal=options!.signal as AbortSignal;return new Response(body);}}))).rejects.toThrow('deadline');
 expect(signal?.aborted).toBe(true);expect(cancelled).toBe(true);
});
test('deadline returns even when HTTP transport ignores abort',async()=>{
 let signal:AbortSignal|undefined;
 await expect(classifyOpenCode('authorized/classifier','task',routingConfig,transport({timeoutMs:30,fetch:(_,options)=>{signal=options!.signal as AbortSignal;return new Promise(()=>{});}}))).rejects.toThrow('deadline');expect(signal?.aborted).toBe(true);
});
test('late HTTP response after timeout is cancelled rather than consumed',async()=>{
 let release!:(response:Response)=>void,cancelled=false;
 const pending=new Promise<Response>(resolve=>{release=resolve;});
 await expect(classifyOpenCode('authorized/classifier','task',routingConfig,transport({timeoutMs:30,fetch:()=>pending}))).rejects.toThrow('deadline');
 release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await Promise.resolve();await Promise.resolve();expect(cancelled).toBe(true);
});
test('unsupported endpoint, hostile model output and oversized bodies use existing failure fallback',async()=>{
 for(const response of [new Response('not supported',{status:404}),Response.json({data:{text:'{"tool_calls":[{"name":"shell","arguments":"never execute"}]}'}}),new Response('x'.repeat(1024*1024+1))]){
  let calls=0;const t=transport({fetch:async()=>{calls++;return response;}}),s=new Store(':memory:');
  try{const router=new TaskRouting(s,async()=>({config:routingConfig,classify:request=>classifyOpenCode('authorized/classifier',request,routingConfig,t)})),job=s.enqueue('p','i','private task');const route=await router.choose(job,'implementation','binding','private task',settings);expect(route.reason).toBe('classifier-unavailable');expect(route.model).toBe('opencode-go/flash');expect(calls).toBe(1);expect(JSON.stringify(router.list())).not.toContain('never execute');}finally{s.close();}
 }
});

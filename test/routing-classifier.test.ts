import {test,expect} from 'bun:test';
import {classifyOpenCode,connectClassifier,type ClassifierTransport} from '../src/routing-config';
import {TaskRouting} from '../src/task-routing';
import {Store} from '../src/core';
import {routingConfig,settings} from './routing-fixture';
import {mkdtempSync,cpSync,writeFileSync,rmSync} from 'node:fs';
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
test('ADLC loads service discovery lazily and passes authentication through its supported boundary',async()=>{
 const calls:string[]=[],endpoint={url:'http://127.0.0.1:12345',auth:{type:'basic' as const,username:'opencode',password:'fixture-only'}},headers={authorization:'fixture-only header'};
 const result=await connectClassifier(async()=>{calls.push('load');return {Service:{
  async discover(options){calls.push('discover');expect(options.version('2.2.5')).toBe(true);expect(options.version('1.9.0')).toBe(false);expect(options.version('3.0.0')).toBe(false);return endpoint;},
  headers(value){calls.push('headers');expect(value).toBe(endpoint);return headers;}
 }};});
 expect(calls).toEqual(['load','discover','headers']);expect(result.url).toBe(endpoint.url);expect(result.headers).toBe(headers);
});
test('service boundary rejects unavailable discovery and supports anonymous local service headers',async()=>{
 await expect(connectClassifier(async()=>({Service:{discover:async()=>undefined,headers(){throw Error('No endpoint may be authenticated');}}}))).rejects.toThrow('Start an authorized OpenCode V2 service');
 const result=await connectClassifier(async()=>({Service:{discover:async()=>({url:'http://127.0.0.1:12345'}),headers:()=>undefined}}));expect(result.headers).toEqual({});
});
test('missing optional client becomes configured failure fallback without persisting import diagnostics',async()=>{
 const s=new Store(':memory:');try{
  const connect=()=>connectClassifier(async()=>{throw Error('Cannot find module @opencode/client/service; private fixture detail');});
  const router=new TaskRouting(s,async()=>({config:routingConfig,classify:request=>classifyOpenCode('authorized/classifier',request,routingConfig,transport({connect}))})),job=s.enqueue('p','i','task');
  const route=await router.choose(job,'implementation','binding','task',settings);expect(route.model).toBe('opencode-go/flash');expect(route.reason).toBe('classifier-unavailable');expect(JSON.stringify(router.list())).not.toContain('private fixture detail');
 }finally{s.close();}
});
test('real default loader retains planning and failure fallback without installed client or OpenChamber',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-no-client-'));
 try{
  cpSync(join(import.meta.dir,'../src'),join(dir,'src'),{recursive:true});
  const configFile=join(dir,'routing.json');writeFileSync(configFile,JSON.stringify({...routingConfig,version:1,harness:'opencode-v2',classifier:{adapter:'opencode',model:'authorized/classifier'}}));
  writeFileSync(join(dir,'probe.ts'),`import {Store} from './src/core';import {TaskRouting} from './src/task-routing';
const s=new Store(':memory:');try{const router=new TaskRouting(s),job=s.enqueue('p','i','spec'),settings=${JSON.stringify({...settings,configFile})};
const planning=await router.choose(job,'planning','plan-binding','plan',settings,'planning');
const implementation=await router.choose(job,'implementation','implementation-binding','task',settings);
console.log(JSON.stringify({planning,implementation,routes:router.list()}));}finally{s.close();}`);
  const proc=Bun.spawn([process.execPath,'--no-install',join(dir,'probe.ts')],{cwd:dir,env:{HOME:dir,PATH:process.env.PATH},stdout:'pipe',stderr:'pipe'});
  const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();expect(error).toBe('');expect(await proc.exited).toBe(0);
  const result=JSON.parse(output);expect(result.planning.model).toBe('openai/luna');expect(result.implementation.model).toBe('opencode-go/flash');expect(result.implementation.reason).toBe('classifier-unavailable');expect(JSON.stringify(result.routes)).not.toContain('Cannot find module');
 }finally{rmSync(dir,{recursive:true,force:true});}
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

import {test,expect} from 'bun:test';
import {discoverMode,confirmMode,openCodeModes,nativeModeFailure,NativeModeFailure,type ModeAdapter} from '../src/provider-mode';
import {createLocalAO} from '../src/workflow-transport';
import {configureSessionRoute} from '../src/routing-session';
import {selectRoute} from '../src/task-routing';
import {routingConfig} from './routing-fixture';

const representative:ModeAdapter={id:'representative',option:'workflow',modes:{planning:['inspect','read-only'],execution:['edit']}};
const catalog=(id:string,current:string,values:string[])=>[{id,currentValue:current,choices:values.map(value=>({value}))}];
for(const [adapter,plan,build] of [[openCodeModes,'plan','build'],[representative,'inspect','edit']] as const){
 test(`${adapter.id}: discovers semantic intent, confirms exact provider mode without permission data changes`,()=>{
  const before=catalog(adapter.option,build,[plan,build]),saved=JSON.stringify(before);
  const selected=discoverMode('planning',adapter,before);
  expect(selected.mode).toBe(plan);expect(selected.intent).toBe('planning');
  expect(confirmMode(selected,catalog(adapter.option,plan,[plan,build]))).toEqual(selected);
  expect(JSON.stringify(before)).toBe(saved);
  expect(()=>confirmMode(selected,before)).toThrow('unconfirmed');
  expect(()=>confirmMode(selected,null)).toThrow('unconfirmed');
  expect(()=>discoverMode('planning',adapter,catalog(adapter.option,build,[build]))).toThrow('unsupported');
 });
}
test('aliases require explicit unambiguous mapping; pinned modes never fall back',()=>{
 const c=catalog('workflow','edit',['read-only','edit']);
 expect(discoverMode('planning',representative,c).mode).toBe('read-only');
 expect(()=>discoverMode('planning',representative,c,'inspect')).toThrow('unsupported');
 expect(()=>discoverMode('planning',representative,catalog('workflow','edit',['read-only','inspect','edit']))).toThrow('unsupported');
 expect(()=>discoverMode('planning',representative,[{id:'workflow',currentValue:'edit',choices:[{value:'edit',name:'Planning'}]}])).toThrow('unsupported');
});
test('ambiguous discovery and conflicting intent mappings fail closed',()=>{
 const c=catalog('mode','build',['plan','build']);
 for(const value of [undefined,{},[],[...c,...c],[{id:'mode',choices:[{value:'plan'},{value:'plan'}]}]])expect(()=>discoverMode('planning',openCodeModes,value)).toThrow('unsupported');
 expect(()=>discoverMode('planning',{...openCodeModes,modes:{planning:['build'],execution:['build']}},c)).toThrow('unsupported');
});
test('advertised permission posture cannot expand the existing boundary',()=>{
 const c=[{id:'mode',currentValue:'build',choices:[{value:'plan',permissionMode:'bypass-permissions'},{value:'build'}]}];
 expect(()=>discoverMode('planning',openCodeModes,c)).toThrow('rejected');
 const selected=discoverMode('planning',openCodeModes,c,'plan','bypass-permissions');
 expect(()=>confirmMode(selected,[{...c[0],currentValue:'plan',choices:[{value:'plan',permissionMode:'auto'}]}])).toThrow('rejected');
});
test('diagnostic errors do not echo arbitrary provider output',()=>{
 try{discoverMode('planning',openCodeModes,catalog('mode','Bearer secret / key',['build']));throw Error('expected failure');}
 catch(e:any){expect(e.message).toContain('observed=unknown');expect(e.message).not.toContain('secret');}
});
test('only typed native mode failures cross the HTTP redaction boundary',async()=>{
 for(const nested of [false,true])for(const kind of ['unsupported','rejected','unconfirmed','transient','uncertain']){
  const error={error:'conflict',code:'PROVIDER_MODE_RESTORE_FAILED',message:'Bearer private provider output',details:{failureKind:kind,requestedMode:'plan',observedMode:'build',retrySafe:false}};
  const body=nested?{error}:error;
  const api=createLocalAO(async()=>({state:'ready',executablePath:'/verified/ao',port:3001}),async()=>new Response(JSON.stringify(body),{status:409}),()=>true);
  await expect(api('sessions/owned/restore','POST',{})).rejects.toThrow(`Native provider mode ${kind}: requested=plan; observed=build`);
  expect(nativeModeFailure(body)?.message).not.toContain('Bearer');
 }
 for(const body of [null,{error:{code:'OTHER',message:'private'}},{error:{code:'PROVIDER_MODE_RESTORE_FAILED',details:{failureKind:'uncertain',retrySafe:true}}}])expect(nativeModeFailure(body)).toBeNull();
 expect(nativeModeFailure({error:{code:'PROVIDER_MODE_RESTORE_FAILED',details:{failureKind:'uncertain',requestedMode:'Bearer secret',observedMode:'build',retrySafe:false}}})?.message).not.toContain('secret');
});
test('native envelope support does not weaken error schema validation',()=>{
 for(const details of [null,[],{}, {failureKind:'unknown',retrySafe:false},{failureKind:'uncertain',retrySafe:true}]){
  const error={code:'PROVIDER_MODE_RESTORE_FAILED',details};
  expect(nativeModeFailure(error)).toBeNull();expect(nativeModeFailure({error})).toBeNull();
 }
 for(const body of [null,[],"private",{error:null},{code:'OTHER',error:{code:'PROVIDER_MODE_RESTORE_FAILED',details:{failureKind:'uncertain',retrySafe:false}}}])expect(nativeModeFailure(body)).toBeNull();
});
for(const failure of ['unsupported','unconfirmed','rejected','transient','uncertain'] as const){
 test(`routing ${failure} remains a precise intent blocker with no retry or send`,async()=>{
  const route=selectRoute(routingConfig,{choice:'planning',confidence:1}),calls:string[]=[];
  const options=()=>[
   {id:'model',currentValue:route.model,choices:[{value:route.model}]},
   {id:'effort',currentValue:route.effort,choices:[{value:route.effort}]},
   ...catalog('mode','build',failure==='unsupported'?['build']:['plan','build'])
  ];
  const api=async(path:string,method?:string)=>{
   calls.push(`${method??'GET'} ${path}`);
   if(path.endsWith('/conversation'))return {controller:'ready',turns:[]};
   if(path==='sessions/owned')return {session:{id:'owned',harness:'opencode-v2',isTerminated:false}};
   if(path.endsWith('/mode')&&method==='PATCH'){
    if(failure==='unconfirmed')return {options:[]};
    throw new NativeModeFailure(failure,'plan','build');
   }
   return {options:options()};
  };
  await expect(configureSessionRoute('owned',route,api)).rejects.toThrow(`Provider mode ${failure}: intent=planning`);
  expect(calls.filter(c=>c.endsWith('/mode')).length).toBe(failure==='unsupported'?0:1);
  expect(calls.some(c=>c.includes('messages')||c==='POST sessions'||c.includes('restore'))).toBe(false);
 });
}

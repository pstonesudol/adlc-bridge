import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {TaskRouting,selectRoute,type RoutingConfig} from '../src/task-routing';
import {configureSessionRoute} from '../src/routing-session';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {routingConfig,settings} from './routing-fixture';
test('task categories preserve provider, model and effort rather than using one default',()=>{
 for(const [category,model,effort] of [['planning','openai/luna','high'],['implement','openai/sol','medium'],['hard','openai/astra','high'],['testing','openai/sol','low']]){
  const route=selectRoute(routingConfig,{choice:category,confidence:0.9});expect(route.model).toBe(model);expect(route.effort).toBe(effort);
 }
});
test('unknown, disabled, low-confidence and malformed answers use only the configured fallback',()=>{
 for(const answer of [{choice:'unknown',confidence:1},{choice:'implement',confidence:0.1},{choice:'implement',confidence:NaN},{choice:'implement',confidence:2}]){
  const route=selectRoute(routingConfig,answer);expect(route.category).toBeNull();expect(route.model).toBe('opencode-go/flash');
 }
 expect(selectRoute({...routingConfig,categories:routingConfig.categories.map(c=>({...c,enabled:false}))},{choice:'implement',confidence:1}).model).toBe('opencode-go/flash');
 expect(()=>selectRoute({...routingConfig,enabled:false},null)).toThrow();
 expect(()=>selectRoute({...routingConfig,fallback:null},null)).toThrow();
});
test('route choice survives restart and config changes; changed specification is rejected',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-route-'));let s=new Store(join(dir,'db'));let loads=0;
 try{
  const id=s.enqueue('p','i','spec');const load=async()=>{loads++;return {config:routingConfig,classify:async()=>({choice:'implement',confidence:1})};};
  let router=new TaskRouting(s,load);const first=await router.choose(id,'planning',digest('spec'),'plan',settings,'planning');
  s.close();s=new Store(join(dir,'db'));router=new TaskRouting(s,load);
  expect((await router.choose(id,'planning',digest('spec'),'plan',settings,'planning')).model).toBe(first.model);expect(loads).toBe(1);
  await expect(router.choose(id,'planning',digest('changed'),'plan',settings,'planning')).rejects.toThrow('binding');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('classifier outage records the configured fallback without storing credentials or error payloads',async()=>{
 const s=new Store(':memory:'),id=s.enqueue('p','i','spec');
 try{const router=new TaskRouting(s,async()=>({config:routingConfig,classify:async()=>{throw Error('secret must never persist');}}));
 const route=await router.choose(id,'implementation','binding','change',settings);expect(route.model).toBe('opencode-go/flash');expect(route.reason).toBe('classifier-unavailable');expect(JSON.stringify(router.list())).not.toContain('secret');}finally{s.close();}
});
test('native routing sets model before effort, confirms read-only mode and rejects unavailable settings',async()=>{
 const route=selectRoute(routingConfig,{choice:'planning',confidence:1}),calls:any[]=[];let model='old',effort='default',mode='build';
 const options=()=>({options:[{id:'model',currentValue:model,choices:[{value:route.model}]},{id:'effort',currentValue:effort,choices:[{value:'high'},{value:'default'}]},{id:'mode',currentValue:mode,choices:[{value:'plan'},{value:'build'}]}]});
 const api=async(path:string,method?:string,body?:any)=>{
  if(path.endsWith('/conversation'))return {controller:'ready',turns:[]};
  if(!path.includes('config-options'))return {session:{harness:'opencode-v2',status:'idle'}};
  if(method==='PATCH'){const id=path.split('/').at(-1);calls.push([id,body.value]);if(id==='model'){model=body.value;effort='default';}if(id==='effort')effort=body.value;if(id==='mode')mode=body.value;}return options();
 };
 await configureSessionRoute('session',route,api);expect(calls).toEqual([['model','openai/luna'],['effort','high'],['mode','plan']]);
 await expect(configureSessionRoute('session',{...route,effort:'unsupported'},api)).rejects.toThrow('not advertised');
 await expect(configureSessionRoute('session',route,async()=>({session:{harness:'opencode-v2',status:'working'}}))).rejects.toThrow('idle');
});

test('remediation uses the approved routing policy even after OpenChamber preferences change',async()=>{
 const s=new Store(':memory:'),id=s.enqueue('p','i','spec');let changed=false;
 try{
 const modified={...routingConfig,categories:routingConfig.categories.map(c=>c.id==='hard'?{...c,model:{providerID:'other',modelID:'unapproved'}}:c)};
 const router=new TaskRouting(s,async()=>({config:changed?modified:routingConfig,classify:async(request)=>({choice:request==='fix'?'hard':'implement',confidence:1})}));
 await router.choose(id,'planning',digest('spec'),'plan',settings,'planning');const hash=s.propose(id,'plan');
 await router.choose(id,'implementation',digest(JSON.stringify(['spec',hash])),'implement',settings);s.approve(id,hash,'human');router.approve(id,hash);changed=true;
 const remediation=await router.choose(id,'remediation:head:findings','head-binding','fix',settings);expect(remediation.model).toBe('openai/astra');
 s.db.query('DELETE FROM task_routes WHERE job=? AND phase=?').run(id,'implementation');expect(()=>router.approved(id,hash)).toThrow('missing');
 }finally{s.close();}
});

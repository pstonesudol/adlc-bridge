import {test,expect,spyOn} from 'bun:test';
import {Store} from '../src/core';
import {createLinearAPI,coordinatedLinearFetch,withLinearReservation,LinearPreSendFailure} from '../src/linear-api';
import {LinearCooldowns,linearQuotaStatus,LinearCooldown,LinearPreSendCooldown} from '../src/linear-cooldowns';
const viewer='11111111-1111-1111-1111-111111111111';
test('API verifies viewer once, shares across keys, and does not replay throttled mutations',async()=>{
  const s=new Store(':memory:');let now=1800000000000;const q=new LinearCooldowns(s,()=>now,async ms=>{now+=ms;});let identities=0,mutations=0;
  const send=(async(_url:any,init:any)=>{
    const query=JSON.parse(init.body).query;
    if(query==='query{viewer{id}}'){identities++;return Response.json({data:{viewer:{id:viewer}}});}
    mutations++;return Response.json({errors:[{message:'never log secret-key',extensions:{code:'RATELIMITED'}}]},{headers:{'Retry-After':'90'}});
  }) as typeof fetch;
  try{
    const a=createLinearAPI(send,()=> 'secret-key',q),b=createLinearAPI(send,()=> 'another-key',q);
    await expect(a('mutation{write{success}}')).rejects.toThrow('cooldown');
    await expect(a('mutation{write{success}}')).rejects.toThrow('cooldown');
    await expect(b('mutation{write{success}}')).rejects.toThrow('cooldown');
    expect(identities).toBe(2);expect(mutations).toBe(1);
  }finally{s.close();}
});
test('failed viewer verification retains credential-local throttle; 429 need not have a JSON body',async()=>{
  const s=new Store(':memory:');let now=1800000000000;const q=new LinearCooldowns(s,()=>now,async ms=>{now+=ms;});let calls=0;
  const send=(async()=>{calls++;if(calls===1)return Response.json({errors:[{message:'identity unavailable'}]});return new Response('not JSON',{status:429,headers:{'retry-after':'60'}});}) as typeof fetch;
  try{
    const api=createLinearAPI(send,()=> 'private-key',q);
    await expect(api('query{issues{id}}')).rejects.toThrow('cooldown');expect(q.verified('private-key')).toBe(false);
    await expect(api('query{issues{id}}')).rejects.toThrow('cooldown');expect(calls).toBe(2);
    await expect(coordinatedLinearFetch(q,'private-key',send,'one')('https://api.linear.app/graphql')).rejects.toThrow('cooldown');
    expect(linearQuotaStatus(s,'one',now).crossKeySharing).toBe('unverified');
  }finally{s.close();}
});
test('network errors are sanitized without retrying and ordinary GraphQL errors fail closed',async()=>{
  const s=new Store(':memory:'),q=new LinearCooldowns(s,Date.now,async()=>{});q.verify('private-key',viewer);
  try{
    const api=createLinearAPI((async()=>{throw Error('private-key');}) as typeof fetch,()=> 'private-key',q);
    await expect(api('mutation{write{success}}')).rejects.toThrow('delivery may be uncertain');
    const bad=createLinearAPI((async()=>Response.json({errors:[{message:'private-key'}]})) as typeof fetch,()=> 'private-key',q);
    await expect(bad('query{x}')).rejects.toThrow('Linear returned errors');
    const malformed=createLinearAPI((async()=>new Response('private-key')) as typeof fetch,()=> 'private-key',q);
    await expect(malformed('query{x}')).rejects.toThrow('Linear returned invalid JSON');
  }finally{s.close();}
});

test('quota persistence failures during viewer verification stop the request instead of falling back',async()=>{
 const s=new Store(':memory:'),q=new LinearCooldowns(s,Date.now,async()=>{});let calls=0;
 q.observe=()=>{throw Error('quota persistence unavailable');};
 const api=createLinearAPI((async()=>{calls++;return Response.json({data:{viewer:{id:viewer}}});}) as typeof fetch,()=> 'private-key',q);
 try{await expect(api('mutation{write{success}}')).rejects.toThrow('quota persistence unavailable');expect(calls).toBe(1);}finally{s.close();}
});

test('reservation release is limited to proven pre-send cooldowns, not sent throttles or transport failures',async()=>{
 let releases=0;
 for(const error of [new LinearCooldown(Date.now()+60000),Error('delivery uncertain')])await expect(withLinearReservation(async()=>{throw error;},()=>{releases++;})).rejects.toThrow();
 expect(releases).toBe(0);
 await expect(withLinearReservation(async()=>{throw new LinearPreSendCooldown(Date.now()+60000);},()=>{releases++;})).rejects.toBeInstanceOf(LinearPreSendCooldown);expect(releases).toBe(1);
});

test('viewer-verification throttling is pre-send for the requested mutation',async()=>{
 const s=new Store(':memory:'),q=new LinearCooldowns(s,Date.now,async()=>{});let sends=0;
 const api=createLinearAPI((async(_url:any,init:any)=>{sends++;expect(JSON.parse(init.body).query).toBe('query{viewer{id}}');return new Response('throttled',{status:429});}) as typeof fetch,()=> 'key',q);
 try{await expect(api('mutation{write{success}}')).rejects.toBeInstanceOf(LinearPreSendCooldown);expect(sends).toBe(1);}finally{s.close();}
});

test('a pacing wait longer than twenty seconds does not consume the mutation send timeout',async()=>{
 const s=new Store(':memory:');let now=1800000000000,sends=0,waiting=false;const timers:{at:number;ms:number;controller:AbortController}[]=[];
 const timeout=spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const controller=new AbortController();timers.push({at:now,ms,controller});return controller.signal;});
 const q=new LinearCooldowns(s,()=>now,async ms=>{waiting=true;expect(ms).toBe(25000);expect(timers).toHaveLength(0);now+=ms;for(const timer of timers)if(now-timer.at>=timer.ms)timer.controller.abort();});
 try{
  q.verify('key',viewer);await q.admit('key');s.db.query('UPDATE linear_quota_state SET next_request=?').run(now+25000);
  const api=createLinearAPI((async(_url:any,init:any)=>{sends++;expect(waiting).toBe(true);expect(init.signal.aborted).toBe(false);return Response.json({data:{success:true}});}) as typeof fetch,()=> 'key',q);
  expect(await withLinearReservation(()=>api('mutation{write{success}}'),()=>{throw Error('A fresh send must not release its reservation');})).toEqual({success:true});
  expect(sends).toBe(1);expect(timers).toHaveLength(1);expect(timers[0].ms).toBe(20000);expect(timers[0].at).toBe(now);
 }finally{timeout.mockRestore();s.close();}
});

for(const source of ['init','request'])test(`caller ${source} cancellation during admission is pre-send and releases only the owned reservation`,async()=>{
 const s=new Store(':memory:'),controller=new AbortController();let now=1800000000000,sends=0,releases=0;
 const q=new LinearCooldowns(s,()=>now,async ms=>{now+=ms;controller.abort('cancelled while pacing');});
 try{
  await q.admit('key');const transport=coordinatedLinearFetch(q,'key',(async()=>{sends++;return Response.json({data:{}});}) as typeof fetch);
  const url='https://api.linear.app/graphql',request=source==='request'?new Request(url,{signal:controller.signal}):url;
  await expect(withLinearReservation(()=>transport(request,source==='init'?{signal:controller.signal}:undefined),()=>{releases++;})).rejects.toBeInstanceOf(LinearPreSendFailure);
  expect(sends).toBe(0);expect(releases).toBe(1);
 }finally{s.close();}
});

for(const source of ['init','request'])test(`caller ${source} cancellation remains linked to the admitted fetch signal`,async()=>{
 const s=new Store(':memory:'),controller=new AbortController(),q=new LinearCooldowns(s,Date.now,async()=>{});
 try{
  const transport=coordinatedLinearFetch(q,'key',(async(_url:any,init:any)=>{expect(init.signal.aborted).toBe(false);controller.abort('caller cancellation');expect(init.signal.aborted).toBe(true);expect(init.signal.reason).toBe('caller cancellation');throw Error('send already attempted');}) as typeof fetch);
  const url='https://api.linear.app/graphql',request=source==='request'?new Request(url,{signal:controller.signal}):url;let released=false;
  await expect(withLinearReservation(()=>transport(request,source==='init'?{signal:controller.signal}:undefined),()=>{released=true;})).rejects.toThrow('delivery may be uncertain');expect(released).toBe(false);
 }finally{s.close();}
});

test('validation rejection after admission is known-unsent rather than a rate-limit response',async()=>{
 const s=new Store(':memory:'),q=new LinearCooldowns(s,Date.now,async()=>{});q.verify('key',viewer);let sends=0,releases=0;
 try{
  const api=createLinearAPI((async()=>{sends++;return Response.json({data:{}});}) as typeof fetch,()=> 'key',q);
  const operation=()=>api('mutation{write{success}}',{}, {beforeSend:()=>{throw Error('requirements changed');}});
  await expect(withLinearReservation(operation,()=>{releases++;})).rejects.toBeInstanceOf(LinearPreSendFailure);expect(sends).toBe(0);expect(releases).toBe(1);
 }finally{s.close();}
});

test('an explicit null caller signal overrides a cancelled inherited Request signal',async()=>{
 const s=new Store(':memory:'),q=new LinearCooldowns(s,Date.now,async()=>{}),controller=new AbortController();controller.abort();let sends=0;
 try{
  const transport=coordinatedLinearFetch(q,'key',(async(_url:any,init:any)=>{sends++;expect(init.signal.aborted).toBe(false);return Response.json({data:{success:true}});}) as typeof fetch);
  await transport(new Request('https://api.linear.app/graphql',{signal:controller.signal}),{signal:null});expect(sends).toBe(1);
 }finally{s.close();}
});

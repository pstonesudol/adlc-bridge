import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {createLinearAPI,coordinatedLinearFetch} from '../src/linear-api';
import {LinearCooldowns,linearQuotaStatus} from '../src/linear-cooldowns';
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

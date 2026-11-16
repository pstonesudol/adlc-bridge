import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {LinearCooldowns,LinearCooldown,linearQuotaStatus,quotaEvidence} from '../src/linear-cooldowns';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const viewer='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
const now=1800000000000;

test('Retry-After seconds/date and seconds/millisecond resets are normalized; malformed evidence is unknown',()=>{
  const e=quotaEvidence(new Headers({'Retry-After':'30','X-RateLimit-Requests-Remaining':'0','X-RateLimit-Requests-Reset':String(now/1000+90),'X-RateLimit-Complexity-Reset':String(now+120000),'X-RateLimit-Endpoint-Requests-Remaining':'bad'}),now);
  expect(e.retryAfter).toBe(now+30000);expect(e.requests.reset).toBe(now+90000);expect(e.complexity.reset).toBe(now+120000);expect(e.endpointRequests.remaining).toBeNull();
  expect(quotaEvidence(new Headers({'retry-after':new Date(now+60000).toUTCString()}),now).retryAfter).toBe(now+60000);
  expect(quotaEvidence(new Headers({'retry-after':'garbage','x-ratelimit-requests-reset':'Infinity'}),now).requests.reset).toBeNull();
});

test('two project workers and keys share the verified viewer cooldown across connections and restart',async()=>{
  const root=mkdtempSync(join(tmpdir(),'adlc-quota-')),path=join(root,'state.sqlite');let clock=now;
  const a=new Store(path),b=new Store(path);let reopened:Store|undefined;
  try{
    const qa=new LinearCooldowns(a,()=>clock,async()=>{}),qb=new LinearCooldowns(b,()=>clock,async()=>{});
    qa.verify('key-a',viewer);qb.verify('key-b',viewer);qb.verify('other-key',other);
    await qa.admit('key-a','one');await qb.admit('key-b','two');
    qa.observe('key-a',429,new Headers({'retry-after':'120','x-ratelimit-requests-remaining':'0','x-ratelimit-requests-reset':String(now+60000)}),{});
    await expect(qb.admit('key-b','two')).rejects.toBeInstanceOf(LinearCooldown);
    await qb.admit('other-key','three');
    expect(linearQuotaStatus(b,'two',clock)).toMatchObject({identityVerification:'verified',crossKeySharing:'verified',intakeState:'cooldown',availableRequestBudget:0,nextEligiblePoll:now+120000});
    // Late successful responses must never erase another worker's cooldown.
    qb.observe('key-b',200,new Headers(),{data:{viewer:{id:viewer}}});
    a.close();reopened=new Store(path);const restarted=new LinearCooldowns(reopened,()=>clock,async ms=>{clock+=ms;});
    await expect(restarted.admit('key-a','one')).rejects.toBeInstanceOf(LinearCooldown);
    clock+=120000;await restarted.admit('key-a','one');await restarted.admit('key-b','two');expect(clock).toBe(now+120250);
    expect(JSON.stringify(linearQuotaStatus(reopened,'two',clock))).not.toContain('key-b');
  }finally{if(!reopened)a.close();reopened?.close();b.close();rmSync(root,{recursive:true,force:true});}
});

test('unverified scopes remain credential-local; verification merges a hold without shortening the shared hold',async()=>{
  const s=new Store(':memory:'),q=new LinearCooldowns(s,()=>now,async()=>{});
  try{
    await q.admit('unknown-a','one');q.observe('unknown-a',200,new Headers(),{errors:[{extensions:{code:'RATELIMITED'}}]});
    await expect(q.admit('unknown-a','two')).rejects.toThrow('cooldown');await q.admit('unknown-b','three');
    expect(linearQuotaStatus(s,'one',now)).toMatchObject({crossKeySharing:'unverified',nextEligiblePoll:now+60000});
    q.verify('known',viewer);q.observe('known',429,new Headers({'retry-after':'180'}),{});q.verify('unknown-a',viewer);
    expect(linearQuotaStatus(s,'one',now)).toMatchObject({crossKeySharing:'verified',nextEligiblePoll:now+180000});
  }finally{s.close();}
});

test('only applicable exhausted budgets reset a throttle; fallback is bounded and server times are not capped',()=>{
  const s=new Store(':memory:'),q=new LinearCooldowns(s,()=>now,async()=>{});
  try{
    expect(q.observe('a',429,new Headers({'retry-after':'10','x-ratelimit-requests-remaining':'50','x-ratelimit-requests-reset':String(now+999000),'x-ratelimit-endpoint-requests-remaining':'0','x-ratelimit-endpoint-requests-reset':String(now+20000),'x-ratelimit-complexity-remaining':'0','x-ratelimit-complexity-reset':String(now+30000)}),{})).toBe(now+30000);
    for(let i=0;i<10;i++)q.observe('fallback',429,new Headers({'retry-after':'bad'}),{});
    expect(q.observe('fallback',429,new Headers(),{})).toBe(now+900000);
    expect(q.observe('server',429,new Headers({'retry-after':'7200'}),{})).toBe(now+7200000);
    expect(q.observe('insufficient-complexity',429,new Headers({'x-ratelimit-complexity-remaining':'5','x-ratelimit-complexity-reset':String(now+360000)}),{})).toBe(now+360000);
    expect(q.observe('success-exhausted',200,new Headers({'x-ratelimit-requests-remaining':'0','x-ratelimit-requests-reset':String(now+90000)}),{data:{}})).toBe(now+90000);
  }finally{s.close();}
});

test('credential-local cooldown survives restart without falsely verifying cross-key sharing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-unverified-quota-')),path=join(root,'state.sqlite');let s=new Store(path);
 try{
  const q=new LinearCooldowns(s,()=>now,async()=>{});await q.admit('local-secret','one');q.observe('local-secret',429,new Headers(),{});
  s.close();s=new Store(path);const restarted=new LinearCooldowns(s,()=>now,async()=>{});
  await expect(restarted.admit('local-secret','one')).rejects.toThrow('cooldown');await restarted.admit('different-secret','two');
  expect(linearQuotaStatus(s,'one',now)).toMatchObject({identityVerification:'unknown',crossKeySharing:'unverified',nextEligiblePoll:now+60000});
  expect(linearQuotaStatus(s,'one',now+60000).intakeState).toBe('eligible');
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});

test('concurrent admission reserves distinct durable slots and rechecks throttles after waiting',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-concurrent-quota-')),path=join(root,'state.sqlite'),a=new Store(path),b=new Store(path);let clock=now,release!:()=>void,waiting=0;
 const qa=new LinearCooldowns(a,()=>clock,async()=>{}),qb=new LinearCooldowns(b,()=>clock,async ms=>{waiting=ms;await new Promise<void>(resolve=>{release=resolve;});clock+=ms;});
 try{
  qa.verify('one',viewer);qb.verify('two',viewer);
  await qa.admit('one','one');const second=qb.admit('two','two');expect(waiting).toBe(250);
  expect(a.db.query('SELECT next_request FROM linear_quota_state WHERE scope=?').get('viewer:'+viewer)).toEqual({next_request:now+500});
  qa.observe('one',429,new Headers({'retry-after':'60'}),{});release();await expect(second).rejects.toThrow('cooldown');
 }finally{a.close();b.close();rmSync(root,{recursive:true,force:true});}
});

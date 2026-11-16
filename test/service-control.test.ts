import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {LinearCooldowns,linearQuotaStatus} from '../src/linear-cooldowns';
import {ProjectServices} from '../src/project-services';
import {serviceControl} from '../src/service-control';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';

test('quota status is read-only and explicitly unknown for a legacy database',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-quota-status-')),path=join(root,'state.sqlite'),s=new Store(path);
 try{
  s.db.exec('DROP TABLE linear_quota_projects;DROP TABLE linear_quota_credentials;DROP TABLE linear_quota_state;');s.close();
  const before=readFileSync(path),ro=Store.readonly(path);
  try{expect(linearQuotaStatus(ro,'one')).toMatchObject({identityVerification:'unknown',crossKeySharing:'unverified',evidence:'unknown',lastThrottle:null,availableRequestBudget:null,nextEligiblePoll:null});}finally{ro.close();}
  expect(readFileSync(path)).toEqual(before);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test.skipIf(process.platform!=='darwin')('service status includes shared quota evidence without credentials or state writes',async()=>{
 const home=mkdtempSync(join(tmpdir(),'adlc-service-quota-')),path=join(home,'state.sqlite'),config=join(home,'project.json');
 const project='00000000-0000-0000-0000-000000000004',s=new Store(path),clock=Date.now();
 try{
  writeFileSync(config,JSON.stringify({version:1,name:'one',repo:home,requiredChecks:['CI'],automation:{orchestratorProject:'one'},linear:{projectId:project,teamId:'00000000-0000-0000-0000-000000000001',readyStateId:'00000000-0000-0000-0000-000000000002',readyLabelId:'00000000-0000-0000-0000-000000000003'}}));
  const registry=new ProjectServices(s);registry.register(config);
  const q=new LinearCooldowns(s,()=>clock,async()=>{});q.verify('do-not-expose-this-key','11111111-1111-1111-1111-111111111111');await q.admit('do-not-expose-this-key',project);
  q.observe('do-not-expose-this-key',429,new Headers({'retry-after':'60','x-ratelimit-requests-remaining':'0','x-ratelimit-requests-reset':String(clock+60000)}),{});
  const before=s.db.query('SELECT * FROM linear_quota_state').all(),calls:string[][]=[];
  const result=await serviceControl('service-status','one',false,{home,statePath:path,run:async(args)=>{calls.push(args);return {code:0,stdout:'state = waiting',stderr:''};}});
  expect(result.linearQuota).toMatchObject({project,identityVerification:'verified',intakeState:'cooldown',availableRequestBudget:0,nextEligiblePoll:clock+60000,lastThrottle:{at:clock,kind:'HTTP 429'}});
  expect(JSON.stringify(result)).not.toContain('do-not-expose-this-key');expect(JSON.stringify(result)).not.toContain('credential:');
  expect(calls.map(c=>c[0])).toEqual(['print']);expect(s.db.query('SELECT * FROM linear_quota_state').all()).toEqual(before);
 }finally{s.close();rmSync(home,{recursive:true,force:true});}
});

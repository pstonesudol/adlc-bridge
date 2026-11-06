import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../src/core';import {ProjectServices} from '../src/project-services';
import {authStatus,selectProject,queueView,completion} from '../src/operator-discovery';
import {configuration} from './operator-config.test';
test('queue pagination, missing evidence, and planning-only capacity are read-only',async()=>{
 const root=mkdtempSync(join(tmpdir(),'op-queue-'));try{
  const path=join(root,'s.sqlite'),s=new Store(path),c=configuration(root),id=s.enqueue(c.linear.projectId,'i','{"identifier":"DEV-1"}');
  s.db.exec('CREATE TABLE planning_dispatch(job TEXT,state TEXT,session_id TEXT)');s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?)').run(id,'dispatch_uncertain','session');s.close();const before=readFileSync(path);
  let calls=0;const issue={id:'i',identifier:'DEV-1',project:{id:c.linear.projectId},team:{id:c.linear.teamId},state:{id:c.linear.readyStateId},labels:{nodes:[{id:c.linear.readyLabelId}],pageInfo:{hasNextPage:false}}};
  const api=async()=>({issues:{nodes:calls++===0?[issue]:[],pageInfo:{hasNextPage:calls===1,endCursor:'page2'}}});
  const view=await queueView(c,path,api,100);expect(calls).toBe(2);expect(view).toMatchObject({planning:{capacity:1,occupancy:1,scope:'concurrent-planning-only'},provider:{complete:true,observedAt:100},tickets:[{job:id,intakeEligible:true}]});
  const unavailable=await queueView(c,path,async()=>{throw Error('sensitive token');});expect(unavailable.provider).toMatchObject({complete:false,state:'unavailable'});expect(JSON.stringify(unavailable)).not.toContain('sensitive token');
  calls=0;const incomplete=await queueView(c,path,async()=>{if(calls++)throw Error('timeout');return {issues:{nodes:[issue],pageInfo:{hasNextPage:true,endCursor:'next'}}};});expect(incomplete.provider).toMatchObject({complete:false,state:'incomplete'});expect(incomplete.tickets[0].intakeEligible).toBeNull();
  expect(readFileSync(path)).toEqual(before);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('auth never exposes credential values or references and completion only emits shell text',()=>{
 const status=authStatus(configuration('/repo'),{ADLC_LINEAR_TOKEN:'SECRET_TOKEN'} as any,true);expect(status.providers[0].state).toBe('unverified');expect(JSON.stringify(status)).not.toMatch(/SECRET_TOKEN|secret\/reference|DO_NOT_PRINT/);expect(authStatus({},{} as any,false).providers[0].state).toBe('missing');
 for(const shell of ['bash','zsh','fish'])expect(completion(shell,['jobs','config'])).toContain('adlc');expect(()=>completion('unsupported',[])).toThrow('Supported');
 expect(()=>selectProject([{project:'p1'},{project:'p2'}] as any)).toThrow('multiple');
});
test('core CLI scoped commands share project identity, JSON and safe errors',()=>{
 const root=mkdtempSync(join(tmpdir(),'op-core-'));try{
  const path=join(root,'s.sqlite'),config=join(root,'p.json'),c=configuration(root);writeFileSync(config,JSON.stringify(c));
  const s=new Store(path);new ProjectServices(s).register(config);s.enqueue(c.linear.projectId,'i','{"identifier":"DEV-1"}');s.close();
  const run=(...args:string[])=>Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),...args],{env:{HOME:root,PATH:process.env.PATH,ADLC_DB:path}});
  for(const args of [['projects','show','p'],['status','--project','p'],['doctor','--project','p'],['auth','status','--project','p'],['jobs','show','DEV-1','--project','p'],['config','get','automation.maxPlanning','--project','p'],['config','set','automation.maxPlanning','8','--project','p']]){
   const r=run(...args,'--json');expect(r.exitCode).toBe(0);const output=r.stdout.toString();expect(JSON.parse(output).schemaVersion).toBe(1);expect(output).not.toMatch(/DO_NOT_PRINT|secret\/reference/);
  }
  expect(JSON.parse(readFileSync(config,'utf8')).automation.maxPlanning).toBeUndefined();
  const applied=run('config','set','automation.maxPlanning','8','--project','p','--apply','--json');expect(applied.exitCode).toBe(0);expect(JSON.parse(readFileSync(config,'utf8')).automation.maxPlanning).toBe(8);
  for(const args of [['config','get','routing.harness','--project','p'],['config','show','--project','p','--project','other'],['services','stop','--project','other']])expect(run(...args).exitCode).toBe(2);
  expect(run('projects','--json').exitCode).toBe(0);
  expect(run('jobs','list','--state','awaiting_plan','--project','p','--json').exitCode).toBe(0);
  expect(run('completion','fish').stdout.toString()).toContain('complete -c adlc');
  expect(JSON.parse(run('version','--json').stdout.toString()).data.runningBackend.state).toBe('unknown');
  expect(run('install-runtime','--json').stderr.toString()).not.toContain('schemaVersion');
  expect(run('jobs','approve','--json').exitCode).toBe(2);expect(run('jobs','recover','--json').exitCode).toBe(2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

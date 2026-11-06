import {test,expect} from 'bun:test';
import {classifyOpenCode,routingSnapshot} from '../src/routing-config';
import {TaskRouting} from '../src/task-routing';import {Store,digest} from '../src/core';
import {routingConfig,settings} from './routing-fixture';
import {routingRuntimeFixture} from './routing-runtime-fixture';
import {cpSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {join} from 'node:path';
const document=(enabled:boolean)=>({...routingConfig,enabled,version:1,harness:'opencode-v2' as const,classifier:{adapter:'opencode' as const,model:'authorized/classifier'}});

test('disabled classifier entry rejects before service discovery or HTTP',async()=>{
 let calls=0;await expect(classifyOpenCode('authorized/classifier','private task',document(false),{connect:async()=>{calls++;throw Error('unexpected discovery');},fetch:async()=>{calls++;throw Error('unexpected HTTP');},timeoutMs:1000})).rejects.toThrow('disabled');expect(calls).toBe(0);
});
test('snapshot checks the selected policy enablement before calling its classifier',async()=>{
 let calls=0;const classify=async()=>{calls++;return {choice:'implement',confidence:1};};
 const enabled=document(true),disabled=document(false);
 await expect(routingSnapshot(enabled,classify).classify('private',disabled)).rejects.toThrow('disabled');
 await expect(routingSnapshot(disabled,classify).classify('private')).rejects.toThrow('disabled');expect(calls).toBe(0);
 expect((await routingSnapshot(disabled,classify).classify('task',enabled)).choice).toBe('implement');expect(calls).toBe(1);
});
test('disabled task selection and reconciliation never invoke even an injected classifier or change approval',async()=>{
 const s=new Store(':memory:');let calls=0,enabled=true;
 try{const router=new TaskRouting(s,async()=>({config:document(enabled),classify:async()=>{calls++;return {choice:'implement',confidence:1};}})),job=s.enqueue('p','i','spec');
  await router.choose(job,'planning','spec','plan',settings,'planning');const hash=s.propose(job,'plan');
  await router.choose(job,'implementation',digest(JSON.stringify(['spec',hash])),'implement',settings);router.approve(job,hash);const old=router.approved(job,hash);calls=0;enabled=false;
  const fresh=s.enqueue('p','i2','spec');await expect(router.choose(fresh,'implementation','fresh','private',settings)).rejects.toThrow('disabled');
  await expect(router.reconcile(job,settings)).rejects.toThrow('disabled');expect(calls).toBe(0);expect(router.approved(job,hash)).toEqual(old);expect(router.list(fresh)).toEqual([]);
 }finally{s.close();}
});
test('disabled CLI task-file preview does not discover its local fake service',async()=>{
 const f=routingRuntimeFixture();try{
  cpSync(join(import.meta.dir,'../src'),join(f.source,'src'),{recursive:true});
  const configFile=join(f.source,'routing.json'),project=join(f.source,'project.json'),task=join(f.source,'task.txt'),marker=join(f.root,'discovery');
  writeFileSync(configFile,JSON.stringify(document(false)));writeFileSync(project,JSON.stringify({routing:{...settings,configFile}}));writeFileSync(task,'private task data');
  const proc=Bun.spawn([process.execPath,'--no-install',join(f.source,'src/cli.ts'),'routing',project,task],{cwd:f.source,env:{HOME:f.root,PATH:process.env.PATH,ADLC_TEST_DISCOVERY:marker},stdout:'pipe',stderr:'pipe'});
  const output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();expect(await proc.exited).not.toBe(0);expect(error).toContain('ADLC routing is disabled');expect(output).not.toContain('private task data');expect(existsSync(marker)).toBe(false);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

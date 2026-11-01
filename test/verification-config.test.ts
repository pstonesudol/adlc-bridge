import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateVerification,verificationInstructions,runVerification,type Verification} from '../src/verification';
import {validateRuntime,runtimeServiceDefinition,setupPreview,sanitizedSetup,type RuntimeConfig} from '../src/setup';
import {validate} from '../src/linear';
import {codeRemediationInstructions} from '../src/pilot';
const host:Verification={version:1,mode:'host',steps:[{cwd:'.',argv:['bun','test']}]};
const container:Verification={version:1,mode:'container',steps:[{cwd:'frontend',argv:['node','--test','tests']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['frontend']}};
const dockerExecution={docker:{path:'/configured/bin/docker',version:'28.1.0'},probeDocker:()=>true};
const uuid='00000000-0000-0000-0000-000000000001';
const project=(repo:string,verification?:Verification)=>({version:1,name:'PRIVATE_NAME',repo,linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid},approval:{mode:'manual'},verification});
function runtime(root:string):RuntimeConfig{return {version:1,platform:'launchd',projectConfig:join(root,'project.json'),controller:join(root,'cli.ts'),workingDirectory:root,tools:Object.fromEntries(['bun','ao','git','gh'].map(n=>[n,{path:join(root,n),version:'1.4.2'}])),service:{label:'local.adlc.legacy',path:join(root,'service.plist'),interval:60,runAtLoad:false,stdout:join(root,'out.log'),stderr:join(root,'err.log')}};}
test('versioned modes reject unknown fields, mutable images and escaping paths',()=>{
 for(const v of [host,container])expect(()=>validateVerification(v)).not.toThrow();
 for(const v of [{...host,version:2},{...host,token:'secret'},{...host,steps:[{cwd:'../outside',argv:['bun']}]},{...container,container:{image:'latest',inputs:['frontend']}},{...container,container:{...container.container,inputs:['.ssh']}}])expect(()=>validateVerification(v)).toThrow();
 expect(verificationInstructions(host)).toContain('execution mode: host');expect(verificationInstructions(container)).toContain(container.container!.image);
 expect(verificationInstructions()).toContain('Do not assume Docker');
 expect(codeRemediationInstructions(host)).toContain('execution mode: host');expect(codeRemediationInstructions(container)).toContain(container.container!.image);expect(codeRemediationInstructions()).not.toContain('test using the container verification workflow');
 expect(()=>validate(project('/repo'))).not.toThrow();expect(()=>validate(project('/repo',{...host,version:2} as any))).toThrow();
});
test('host and container argv selection, failures, cleanup and symlink confinement (mocked execution)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-verification-test-'));let calls:any[]=[];
 try{
  mkdirSync(join(root,'.git'));mkdirSync(join(root,'frontend'));writeFileSync(join(root,'frontend','index.js'),'');writeFileSync(join(root,'frontend','.env'),'secret');
  const spawn=((argv:any,options:any)=>{calls.push({argv,options});return {exited:Promise.resolve(0)};}) as any;
  expect((await runVerification(root,host,spawn)).passed).toBe(true);expect(calls[0].argv).toEqual(['bun','test']);
  expect((await runVerification(root,container,spawn,dockerExecution)).passed).toBe(true);
  const cmd=calls[1].argv;expect(cmd[0]).toBe(dockerExecution.docker.path);expect(cmd).toContain('--pull=never');expect(cmd).toContain('--read-only');expect(cmd).toContain(container.container!.image);
  expect(existsSync(calls[1].options.cwd)).toBe(false);
  symlinkSync(tmpdir(),join(root,'escape'));await expect(runVerification(root,{...host,steps:[{cwd:'escape',argv:['bun']}]},spawn)).rejects.toThrow('escapes');
  const fail=(()=>({exited:Promise.resolve(1)})) as any;expect((await runVerification(root,host,fail)).passed).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('container rejects selected and ancestor links to private in-worktree inputs before spawning',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-link-test-'));let spawned=false;
 try{
  mkdirSync(join(root,'.git'));mkdirSync(join(root,'private'));mkdirSync(join(root,'private','nested'));writeFileSync(join(root,'private','credentials.json'),'private');symlinkSync('private',join(root,'frontend'));
  const spawn=(()=>{spawned=true;throw Error('must not run');}) as any;
  for(const input of ['frontend','frontend/','frontend/nested'])await expect(runVerification(root,{...container,container:{...container.container!,inputs:[input]}},spawn,dockerExecution)).rejects.toThrow('cannot be symbolic link');
  expect(spawned).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('container fails closed for missing/relative Docker pins or a version mismatch before spawning',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-docker-pin-test-'));let spawned=false;
 try{
  mkdirSync(join(root,'.git'));
  const spawn=(()=>{spawned=true;throw Error('must not run');}) as any;
  await expect(runVerification(root,container,spawn)).rejects.toThrow('requires an absolute Docker');
  await expect(runVerification(root,container,spawn,{...dockerExecution,docker:{path:'docker',version:'28.1.0'}})).rejects.toThrow('requires an absolute Docker');
  await expect(runVerification(root,container,spawn,{...dockerExecution,probeDocker:()=>false})).rejects.toThrow('version check failed');
  expect(spawned).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('runner probes the pinned executable and accepts Docker version punctuation (mocked container)',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-docker-version-test-'));let command:string[]=[];
 try{
  mkdirSync(join(root,'.git'));mkdirSync(join(root,'frontend'));
  const path=join(root,'pinned-docker');writeFileSync(path,'#!/bin/sh\nprintf "Docker version 28.1.0, build fixture\\n"\n',{mode:0o755});
  const spawn=((argv:string[])=>{command=argv;return {exited:Promise.resolve(0)};}) as any;
  expect((await runVerification(root,container,spawn,{docker:{path,version:'28.1.0'}})).passed).toBe(true);expect(command[0]).toBe(path);
  await expect(runVerification(root,container,spawn,{docker:{path,version:'28.1.1'}})).rejects.toThrow('version check failed');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('both project setup flows preserve config, render deterministically and distinguish mocked probes',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-setup-test-'));
 try{for(const verification of [host,container]){
  const c=project(root,verification),r=runtime(root);if(verification.mode==='container')r.tools.docker={path:join(root,'docker'),version:'1.2.3'};
  writeFileSync(r.projectConfig,JSON.stringify(c));writeFileSync(r.controller,'');
  const before=JSON.stringify(c),preview=setupPreview(c,r,()=>true);
  expect(preview.passed).toBe(true);expect(preview.activation).toBe(false);expect(preview.service).toBe('create');expect(JSON.stringify(c)).toBe(before);
  expect(preview.definition).toBe(runtimeServiceDefinition(r));expect(preview.definition).toContain('local.adlc.legacy');
  expect(preview.checks.some(x=>x.kind==='injected-probe-not-live')).toBe(true);
  expect(setupPreview(c,r,()=>false).passed).toBe(false);
  const escaped=structuredClone(r);escaped.service.stdout=join(root,'a & b.log');expect(runtimeServiceDefinition(escaped)).toContain('a &amp; b.log');
  writeFileSync(r.service.path,preview.definition);expect(setupPreview(c,r,()=>true).service).toBe('unchanged');
  writeFileSync(r.service.path,'existing');expect(setupPreview(c,r,()=>true).passed).toBe(false);rmSync(r.service.path);
  const exported=JSON.stringify(sanitizedSetup(c,r));expect(exported).not.toContain(root);expect(exported).not.toContain(uuid);expect(exported).not.toContain('PRIVATE_NAME');expect(exported).not.toContain('ready-queue');
 }
 const r=runtime(root);expect(()=>validateRuntime({...r,credentials:'no'})).toThrow();expect(()=>validateRuntime({...r,version:2})).toThrow();
 r.service.label='unsafe<label';expect(()=>runtimeServiceDefinition(r)).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});

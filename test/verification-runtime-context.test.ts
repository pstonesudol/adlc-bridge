import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {withVerificationContext,runtimeServiceDefinition,type RuntimeConfig} from '../src/setup';
import {verificationInstructions,type Verification} from '../src/verification';
import {serviceDefinition} from '../src/init';

test('trusted runtime file context reaches CLI instructions; forged project context is ignored',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-verification-context-')));
 try{
  const project=join(root,'project.json'),runtime=join(root,"runtime owner's config.json"),repo=join(root,'repo');mkdirSync(repo);
  const v:Verification={version:1,mode:'container',steps:[{cwd:'.',argv:['node','--test']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['src']}};
  const uuid='00000000-0000-0000-0000-000000000001',c={version:1,name:'Fixture',repo,requiredChecks:['CI'],linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid},verification:v,verificationContext:{runtimeConfig:'/FORGED_RUNTIME'}};
  writeFileSync(project,JSON.stringify(c));
  const r:RuntimeConfig={version:1,platform:'launchd',projectConfig:project,controller:join(root,'installed/src/cli.ts'),workingDirectory:root,tools:Object.fromEntries(['bun','ao','git','gh','docker'].map(k=>[k,{path:`/trusted/bin/${k}`,version:'1.4.2'}])),service:{label:'local.adlc.fixture',path:join(root,'staged.plist'),interval:60,runAtLoad:false,stdout:join(root,'out.log'),stderr:join(root,'err.log')}};
  writeFileSync(runtime,JSON.stringify(r));
  const absent=withVerificationContext(c,project);expect(absent.verificationContext).toBeUndefined();expect(verificationInstructions(v,absent.verificationContext)).toContain('STOP before container verification');
  const context=withVerificationContext(c,project,runtime).verificationContext!;
  const instructions=verificationInstructions(v,context,'/reserved/worktree');
  expect(instructions).toContain(JSON.stringify(['/trusted/bin/bun',r.controller,'verification',project,'/reserved/worktree','--run','--runtime',runtime]));expect(instructions).not.toContain('/FORGED_RUNTIME');
  const cli=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'verification',project,'--runtime',runtime],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:root},stdout:'pipe',stderr:'pipe'});
  expect(cli.exitCode).toBe(0);expect(cli.stdout.toString()).toContain(JSON.stringify(runtime));expect(cli.stdout.toString()).not.toContain('/FORGED_RUNTIME');
  expect(runtimeServiceDefinition(r,runtime)).toContain('<key>ADLC_VERIFICATION_RUNTIME_CONFIG</key>');expect(serviceDefinition(project,process.execPath,r.controller,root,r.service.label,runtime)).toContain('runtime owner&apos;s config.json');
  const other=join(root,'other.json');writeFileSync(other,JSON.stringify(c));writeFileSync(runtime,JSON.stringify({...r,projectConfig:other}));expect(()=>withVerificationContext(c,project,runtime)).toThrow('different project config');
 }finally{rmSync(root,{recursive:true,force:true});}
});

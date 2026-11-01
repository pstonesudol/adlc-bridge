import {test,expect} from 'bun:test';
import {bridgePlanningHook,createWorkflowTransport} from '../src/workflow-transport';
import {verifiedInstallationSource} from '../src/install-state';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,realpathSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('implementation send has a bounded timeout and retains uncertain-delivery handling',async()=>{
 for(const code of [0,1]){let options:any;const transport=createWorkflowTransport(async operation=>operation(),((_args:any,opts:any)=>{options=opts;return {stdout:new Response('').body,stderr:new Response('').body,exited:Promise.resolve(code)};}) as any);
  const result=transport.sendImplementation('worker','prompt','key');if(code===0)await result;else await expect(result).rejects.toThrow('Implementation delivery uncertain');expect(options).toEqual({stdout:'pipe',stderr:'pipe',timeout:30000});
 }
});
test('gate parsing decodes shell-quoted apostrophes without expanding commands',()=>{
 const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'",checkout="/work/owner's bridge/src/planning-gate.ts",versions="/home/owner's home/Library/Application Support/ADLC Bridge/versions";
 expect(bridgePlanningHook(`${quote("/bin/owner's bun")} ${quote(checkout)}`,checkout,versions)).toBe(true);
 expect(bridgePlanningHook(`${quote("/bin/owner's bun")} ${quote(versions+'/abc/src/planning-gate.ts')}`,checkout,versions)).toBe(true);
 for(const script of [`bun '${checkout}`,`bun $(echo gate)`,`bun ${quote(checkout)}; echo extra`,`bun "\${GATE}"`])expect(bridgePlanningHook(script,checkout,versions)).toBe(false);
});
test('installation source recognition requires the owner-only validated installation record',()=>{
 const state=realpathSync(mkdtempSync(join(tmpdir(),'adlc-source-proof-'))),source=join(state,'source'),path=join(state,'installation.json');mkdirSync(source);
 try{
  const record={source,cli:join(state,'versions/abc/src/cli.ts')};writeFileSync(path,JSON.stringify(record),{mode:0o600});expect(verifiedInstallationSource(state)).toBe(source);
  const sourceGate=join(verifiedInstallationSource(state)!,'src/planning-gate.ts');expect(bridgePlanningHook(`bun '${sourceGate}'`,'/snapshot/src/planning-gate.ts',join(state,'versions'),sourceGate)).toBe(true);expect(bridgePlanningHook(`bun '${sourceGate}'`,'/snapshot/src/planning-gate.ts',join(state,'versions'))).toBe(false);
  chmodSync(path,0o644);expect(()=>verifiedInstallationSource(state)).toThrow('owner-only');chmodSync(path,0o600);
  writeFileSync(path,JSON.stringify({...record,cli:'/untrusted/src/cli.ts'}));expect(()=>verifiedInstallationSource(state)).toThrow('Invalid installed CLI');writeFileSync(path,JSON.stringify({...record,source:'relative'}));expect(()=>verifiedInstallationSource(state)).toThrow('Invalid installation source');
  rmSync(path);const other=join(state,'other');writeFileSync(other,JSON.stringify(record),{mode:0o600});symlinkSync(other,path);expect(()=>verifiedInstallationSource(state)).toThrow('owner-only');
 }finally{rmSync(state,{recursive:true,force:true});}
});
test('snapshot hook installation replaces a recorded source gate with apostrophes and remains idempotent',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),"adlc-owner's-home-")));
 try{
  const state=join(home,'Library/Application Support/ADLC Bridge'),source=join(home,"owner's source"),cli=join(state,"versions/abc/src/cli.ts"),config=join(home,'config.json');mkdirSync(state,{recursive:true});mkdirSync(source);
  writeFileSync(join(state,'installation.json'),JSON.stringify({source,cli}),{mode:0o600});writeFileSync(config,JSON.stringify({repo:source,automation:{orchestratorProject:'project'}}));
  const script=`import {installWorkflowHook} from ${JSON.stringify(join(import.meta.dir,'../src/workflow-transport.ts'))};const quote=s=>"'"+s.replaceAll("'","'\\\\''")+"'";let current={postCreate:[quote("/old/owner's bun")+' '+quote(${JSON.stringify(join(source,'src/planning-gate.ts'))}),"bun /unrelated/src/planning-gate.ts"]};const api=async(path,method,body)=>{if(method==='PUT'){current=body.config;return {};}return {status:'ok',project:{path:${JSON.stringify(source)},config:current}};};await installWorkflowHook(${JSON.stringify(config)},api);await Bun.sleep(5);await installWorkflowHook(${JSON.stringify(config)},api);console.log(JSON.stringify(current.postCreate));`;
  const child=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home}});expect(child.exitCode).toBe(0);const hooks=JSON.parse(child.stdout.toString());expect(hooks).toHaveLength(2);expect(hooks[0]).toContain('versions/abc/src/planning-gate.ts');expect(hooks[1]).toBe('bun /unrelated/src/planning-gate.ts');
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('gate filtering recognizes only the current checkout and managed snapshot paths',()=>{
 const checkout='/work/bridge/src/planning-gate.ts',versions='/home/user/Library/Application Support/ADLC Bridge/versions';
 for(const script of [`'/bin/bun' '${checkout}'`,`bun ${checkout}`,`'/old/bun' '${versions}/abc/src/planning-gate.ts'`])expect(bridgePlanningHook(script,checkout,versions)).toBe(true);
 for(const script of ["bun /other/project/src/planning-gate.ts",`echo '${checkout}' is documentation`,`bun '${versions}-other/abc/src/planning-gate.ts'`,`bun '${versions}/abc/other/src/planning-gate.ts'`,`bun '${checkout}.backup'`,'echo setup'])expect(bridgePlanningHook(script,checkout,versions)).toBe(false);
});

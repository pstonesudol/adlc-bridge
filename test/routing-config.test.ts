import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,unlinkSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {effectiveRouting,validateRouting,loadRouting,importRouting} from '../src/routing-config';
import {TaskRouting,selectRoute} from '../src/task-routing';import {Store,digest} from '../src/core';
import {routingConfig} from './routing-fixture';
const document=()=>({...routingConfig,version:1,harness:'opencode-v2',classifier:{adapter:'off'}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'adlc-owned-routing-'));const configFile=join(dir,'routing.json');writeFileSync(configFile,JSON.stringify(document()));return {dir,settings:{enabled:true,harness:'opencode-v2' as const,configFile}};}
test('routing example remains disabled even after targets are configured',()=>{
 const example=validateRouting(JSON.parse(readFileSync(join(import.meta.dir,'../config/routing.example.json'),'utf8')));
 expect(example.enabled).toBe(false);
 const configured=validateRouting({...example,fallback:routingConfig.fallback,categories:routingConfig.categories});
 expect(()=>selectRoute(configured,{choice:'implement',confidence:1})).toThrow('disabled');
});
test('setup must enable intended categories as well as the document',()=>{
 const example=JSON.parse(readFileSync(join(import.meta.dir,'../config/routing.example.json'),'utf8'));
 const config=validateRouting({...example,enabled:true,categories:example.categories.map((c:any)=>({...c,model:routingConfig.categories[0].model}))});
 expect(()=>selectRoute(config,{choice:'planning',confidence:1})).toThrow('no configured fallback');
 const enabled=validateRouting({...config,categories:config.categories.map(c=>({...c,enabled:true}))});
 expect(selectRoute(enabled,{choice:'planning',confidence:1}).category).toBe('planning');
});
test('fallback rejects agent fields while categories retain supported agents',()=>{
 for(const agent of ['plan','build',null])expect(()=>validateRouting({...document(),fallback:{...routingConfig.fallback,agent}})).toThrow('routing.fallback.agent: unsupported field');
 for(const agent of ['plan','build']){
  const config=validateRouting({...document(),categories:[{...routingConfig.categories[1],agent}]});
  const route=selectRoute(config,{choice:'implement',confidence:1});expect(route.agent).toBe(agent);expect(route.mode).toBe(agent);
 }
});
test('validated ADLC configuration works without OpenChamber and deterministic planning avoids classifier',async()=>{
 const {dir,settings}=fixture(),s=new Store(':memory:');try{const id=s.enqueue('p','i','spec'),router=new TaskRouting(s);const route=await router.choose(id,'planning',digest('spec'),'plan',settings,'planning');expect(route.model).toBe('openai/luna');expect(route.mode).toBe('plan');const snapshot=await loadRouting(settings);await expect(snapshot.classify('task')).rejects.toThrow('disabled');expect((await router.choose(id,'implementation','binding','task',settings)).reason).toBe('classifier-unavailable');expect(existsSync(join(dir,'openchamber'))).toBe(false);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('explicit overrides replace whole fields with provenance and validate merged policy',()=>{
 const {dir,settings}=fixture();try{const overridesFile=join(dir,'project.json');writeFileSync(overridesFile,JSON.stringify({version:1,minConfidence:0.95}));const result=effectiveRouting({...settings,overridesFile});expect(result.config.minConfidence).toBe(0.95);expect(result.provenance.minConfidence).toBe(overridesFile);expect(result.provenance.categories).toBe(settings.configFile);expect(selectRoute(result.config,{choice:'implement',confidence:0.9}).category).toBeNull();writeFileSync(overridesFile,'{"version":1,"token":"do not copy"}');expect(()=>effectiveRouting({...settings,overridesFile})).toThrow('unsupported field');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('missing malformed unsupported and invalid routing configs give diagnostics',()=>{
 const {dir,settings}=fixture();try{for(const change of [{version:2},{harness:'codex'},{minConfidence:2},{enabled:'yes'},{classifier:{adapter:'custom',token:'secret'}},{categories:[routingConfig.categories[0],routingConfig.categories[0]]},{fallback:{model:{providerID:'openchamber',modelID:'auto'}}}])expect(()=>validateRouting({...document(),...change})).toThrow();writeFileSync(settings.configFile,'{');expect(()=>effectiveRouting(settings)).toThrow('valid version 1 JSON');expect(()=>effectiveRouting({...settings,configFile:join(dir,'missing')})).toThrow('Cannot read');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('import preview is read-only; explicit atomic apply backs up ADLC and preserves equivalent routes',()=>{
 const {dir,settings}=fixture();try{const source=join(dir,'source.json'),raw=JSON.stringify({...routingConfig,classifierToken:'secret'});writeFileSync(source,raw);const before=readFileSync(settings.configFile,'utf8'),preview=importRouting(source,settings.configFile);expect(preview.unsupported).toEqual(['classifierToken']);expect(JSON.stringify(preview)).not.toContain('secret');expect(readFileSync(settings.configFile,'utf8')).toBe(before);const applied=importRouting(source,settings.configFile,true);expect(readFileSync(applied.backup!,'utf8')).toBe(before);expect(readFileSync(source,'utf8')).toBe(raw);for(const c of routingConfig.categories){const answer={choice:c.id,confidence:1};expect(selectRoute(applied.config,answer).model).toBe(selectRoute(routingConfig,answer).model);}expect(()=>importRouting(source,source,true)).toThrow('differ');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('existing route and approval hashes survive missing config and reconciliation is explicit',async()=>{
 const {dir,settings}=fixture(),s=new Store(':memory:');try{const id=s.enqueue('p','i','spec'),router=new TaskRouting(s);await router.choose(id,'planning',digest('spec'),'plan',settings,'planning');const hash=s.propose(id,'plan');await router.choose(id,'implementation',digest(JSON.stringify(['spec',hash])),'task',settings);router.approve(id,hash);const before=router.approved(id,hash);writeFileSync(settings.configFile,JSON.stringify({...document(),fallback:{model:{providerID:'other',modelID:'new'}}}));expect(router.approved(id,hash)).toEqual(before);expect(await router.choose(id,'implementation',digest(JSON.stringify(['spec',hash])),'task',settings)).toEqual(before);const preview=await router.reconcile(id,settings);expect(preview.applied).toBe(false);expect(router.approved(id,hash)).toEqual(before);await router.reconcile(id,settings,preview.hash);expect(()=>router.approved(id,hash)).toThrow('approval');router.approve(id,hash);expect(router.approved(id,hash)?.model).toBe('other/new');s.approve(id,hash,'human');await expect(router.reconcile(id,settings)).rejects.toThrow('unapproved');}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('pinned remediation needs neither current config nor OpenChamber runtime',async()=>{
 const {dir,settings}=fixture(),s=new Store(':memory:');try{const id=s.enqueue('p','i','spec'),router=new TaskRouting(s);await router.choose(id,'implementation','binding','task',settings);unlinkSync(settings.configFile);const route=await router.choose(id,'remediation:head:findings','head','fix',settings);expect(route.model).toBe('opencode-go/flash');expect(route.reason).toBe('classifier-unavailable');}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('import refuses a symlink alias of the source',()=>{
 const {dir,settings}=fixture();try{const alias=join(dir,'alias.json');symlinkSync(settings.configFile,alias);expect(()=>importRouting(settings.configFile,alias,true)).toThrow('differ');expect(JSON.parse(readFileSync(settings.configFile,'utf8')).version).toBe(1);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('CLI previews classifier configuration without starting inference or OpenChamber',async()=>{
 const {dir,settings}=fixture();try{
  writeFileSync(settings.configFile,JSON.stringify({...document(),classifier:{adapter:'opencode',model:'authorized/classifier'}}));
  const project=join(dir,'project.json');writeFileSync(project,JSON.stringify({routing:settings}));
  const p=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),'routing',project],{cwd:dir,env:{...process.env,HOME:dir},stdout:'pipe',stderr:'pipe'});
  const output=await new Response(p.stdout).text(),error=await new Response(p.stderr).text();expect(await p.exited).toBe(0);expect(error).toBe('');expect(JSON.parse(output).config.classifier.model).toBe('authorized/classifier');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

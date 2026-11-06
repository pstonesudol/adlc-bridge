import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync,readdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {editConfig,configView,configValue,configPolling} from '../src/operator-config';
export function configuration(repo:string){return {version:1,name:'fixture',repo,requiredChecks:['CI'],automation:{orchestratorProject:'p'},linear:{projectId:'00000000-0000-0000-0000-000000000001',teamId:'00000000-0000-0000-0000-000000000002',readyStateId:'00000000-0000-0000-0000-000000000003',readyLabelId:'00000000-0000-0000-0000-000000000004'},privateCredential:'DO_NOT_PRINT',routing:{harness:'opencode-v2',credentialPath:'/secret/reference'}};}
test('config preview, apply, defaults, permissions, redaction, reset and retained fields',()=>{
 const root=mkdtempSync(join(tmpdir(),'op-config-'));try{
  const path=join(root,'project.json'),original=configuration(root);writeFileSync(path,JSON.stringify(original),{mode:0o640});const before=readFileSync(path);
  expect(editConfig(path,'automation.maxPlanning','8').saved).toBe(false);expect(readFileSync(path)).toEqual(before);expect(readdirSync(root)).toEqual(['project.json']);
  expect(editConfig(path,'automation.maxPlanning','8',true).saved).toBe(true);expect(statSync(path).mode&0o777).toBe(0o640);
  editConfig(path,'pollingIntervalSeconds','30',true);editConfig(path,'remediation.maxAttempts','null',true);
  const saved=JSON.parse(readFileSync(path,'utf8'));expect(saved.automation.maxPlanning).toBe(8);expect(saved.pollingIntervalSeconds).toBe(30);expect(saved.remediation.maxAttempts).toBeNull();expect(saved.privateCredential).toBe(original.privateCredential);expect(saved.routing).toEqual(original.routing);
  expect(JSON.stringify(configView(saved))).not.toMatch(/DO_NOT_PRINT|secret\/reference/);
  editConfig(path,'automation.maxPlanning',undefined,true);expect(configView(JSON.parse(readFileSync(path,'utf8')))[0]).toMatchObject({effective:1,source:'default',declaredPresent:false});
  expect(readdirSync(root).filter(p=>p.includes('.backup-')).length).toBe(4);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('strict values/ranges and allowlist reject invalid inputs before writes',()=>{
 const root=mkdtempSync(join(tmpdir(),'op-types-'));try{
  const path=join(root,'p.json');writeFileSync(path,JSON.stringify(configuration(root)));const before=readFileSync(path);
  for(const [key,value] of [['automation.maxPlanning','0'],['automation.maxPlanning','33'],['pollingIntervalSeconds','4'],['pollingIntervalSeconds','86401'],['remediation.maxNoProgress','0'],['remediation.window','day'],['routing.harness','x'],...['1e1','08','+8','8.0',' 8','NaN','true','null'].map(v=>['automation.maxPlanning',v])])expect(()=>editConfig(path,key,value,true)).toThrow();
  expect(readFileSync(path)).toEqual(before);expect(configValue('remediation.maxAttempts','null')).toBeNull();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('concurrent edits and atomic failure preserve current configuration',()=>{
 const root=mkdtempSync(join(tmpdir(),'op-concurrent-'));try{
  const path=join(root,'p.json');const before=JSON.stringify(configuration(root));writeFileSync(path,before);
  expect(()=>editConfig(path,'automation.maxPlanning','8',true,{atomic:()=>{throw Error('atomic failure');},beforeCommit:()=>{}})).toThrow('atomic failure');expect(readFileSync(path,'utf8')).toBe(before);
  expect(()=>editConfig(path,'automation.maxPlanning','8',true,{atomic:()=>{throw Error('must not reach');},beforeCommit:()=>writeFileSync(path,before+' ')})).toThrow('concurrently');expect(readFileSync(path,'utf8')).toBe(before+' ');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('polling preview, stopped service and partial reload preserve truthful activation',async()=>{
 const calls:any[]=[];let loaded=false,fail=false;
 const control=async(action:string,project:string,apply?:boolean)=>{calls.push([action,project,apply]);if(action==='service-status')return {loaded,definitionInstalled:true};if(fail)throw Error('reload failure');return {pollingIntervalSeconds:30,installedIntervalSeconds:60,reloaded:!!apply&&loaded};};
 expect(await configPolling('p',false,control)).toMatchObject({state:'preview',activeIntervalSeconds:null,installedIntervalSeconds:60});
 expect(await configPolling('p',true,control)).toMatchObject({state:'applied',activeIntervalSeconds:null,reloaded:false});
 loaded=true;expect(await configPolling('p',true,control)).toMatchObject({activeIntervalSeconds:30});
 fail=true;expect(await configPolling('p',true,control)).toMatchObject({state:'partial-or-unavailable',activeIntervalSeconds:null});expect(calls.some(c=>['start','stop'].includes(c[0]))).toBe(false);
});

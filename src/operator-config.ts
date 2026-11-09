import {readFileSync,lstatSync,writeFileSync,unlinkSync,openSync,closeSync,chmodSync} from 'node:fs';
import {atomicFile} from './atomic-file';
import {effectiveSettings} from './project-settings';
import {remediationPolicy} from './remediation';
import {validate} from './linear';
import {OperatorError} from './operator-cli';
import {reviewerPolicyView} from './reviewer-policy';

export const configDefaults:Record<string,unknown>={'automation.maxPlanning':1,pollingIntervalSeconds:60,'remediation.maxAttempts':5,'remediation.maxNoProgress':5,'remediation.window':'job'};
const allowed=(key:string)=>{if(!Object.hasOwn(configDefaults,key))throw new OperatorError('Unsupported configuration key. Allowed: '+Object.keys(configDefaults).join(', '));};
function value(c:any,key:string){return key.split('.').reduce((v,k)=>v?.[k],c);}
export function configView(c:any){
 const settings=effectiveSettings(c),policy=remediationPolicy(c.remediation);
 const effective:Record<string,unknown>={'automation.maxPlanning':settings.maxPlanning,pollingIntervalSeconds:settings.pollingIntervalSeconds,'remediation.maxAttempts':policy.maxAttempts,'remediation.maxNoProgress':policy.maxNoProgress,'remediation.window':policy.window};
  return [...Object.keys(configDefaults).map(key=>({key,declared:value(c,key)??null,declaredPresent:value(c,key)!==undefined,default:configDefaults[key],effective:effective[key],source:value(c,key)===undefined?'default':'project'})),{key:'reviewers',declared:c.reviewers??null,declaredPresent:c.reviewers!==undefined,default:reviewerPolicyView(undefined),effective:reviewerPolicyView(c.reviewers),source:c.reviewers===undefined?'default':'project'}];
}
export function configValue(key:string,text:string){
 allowed(key);
 if(key==='remediation.window'){if(text!=='job')throw new OperatorError('remediation.window must be job');return text;}
 if(key==='remediation.maxAttempts'&&text==='null')return null;
 if(!/^(0|[1-9][0-9]*)$/.test(text)||!Number.isSafeInteger(Number(text)))throw new OperatorError('Expected a canonical nonnegative decimal integer (or null for remediation.maxAttempts)');
 return Number(text);
}
export function editConfig(path:string,key:string,text:string|undefined,apply=false,io={atomic:atomicFile,beforeCommit:()=>{}}){
 allowed(key);
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new OperatorError('Project configuration must be a regular non-symlink file');
 const before=readFileSync(path),original=JSON.parse(before.toString()),next=structuredClone(original);
 const parts=key.split('.'),leaf=parts.pop()!;let target=next;
 for(const part of parts){if(target[part]===undefined)target[part]={};if(!target[part]||typeof target[part]!=='object'||Array.isArray(target[part]))throw new OperatorError('Invalid configuration object');target=target[part];}
 if(text===undefined)delete target[leaf];else target[leaf]=configValue(key,text);
 try{validate(next);}catch{throw new OperatorError('Configuration validation failed; use config validate. Check key range and existing project settings.');}
 const changes={key,before:configView(original).find(v=>v.key===key),after:configView(next).find(v=>v.key===key)};
 const changed=JSON.stringify(original)!==JSON.stringify(next);
 const result={preview:!apply,changed,saved:false,backupCreated:false,changes,adoption:key==='automation.maxPlanning'?'Next poll adopts planning capacity; active work is never killed.':key.startsWith('remediation.')?'Policy only; attempts, history and existing stops are retained.':'Saved interval is not proof of active service interval.'};
 if(!apply||!changed)return result;
 const lock=path+'.adlc-config-lock';let fd:number;
 try{fd=openSync(lock,'wx',0o600);}catch{throw new OperatorError('Configuration edit is locked; inspect the other editor before retrying.',1);}
 try{
  const verify=()=>{const current=lstatSync(path);if(!current.isFile()||current.isSymbolicLink()||current.ino!==stat.ino||current.mode!==stat.mode||!readFileSync(path).equals(before))throw new OperatorError('Configuration changed concurrently; preview again.',1);};
  verify();io.beforeCommit();verify();
  const backup=path+`.backup-${Date.now()}-${crypto.randomUUID()}`;
  writeFileSync(backup,before,{flag:'wx',mode:stat.mode&0o777});
  chmodSync(backup,stat.mode&0o777);
  io.atomic(path,JSON.stringify(next,null,2)+'\n',stat.mode&0o777,staged=>{chmodSync(staged,stat.mode&0o777);verify();});
  return {...result,saved:true,backupCreated:true};
 }finally{closeSync(fd);unlinkSync(lock);}
}

export async function configPolling(project:string,apply:boolean,control:(action:string,project:string,apply?:boolean)=>Promise<any>){
 try{
  const status=await control('service-status',project);
  if(!status.definitionInstalled)return {state:'not-installed',activeIntervalSeconds:null,nextAction:'Complete explicit service setup; no service was started.'};
  const update=await control('service-config',project,apply);
  return {state:apply?'applied':'preview',...update,activeIntervalSeconds:apply&&update.reloaded?update.pollingIntervalSeconds:null,nextAction:status.loaded?'Inspect service-status to verify activation.':'Service remains stopped; use explicit start when ready.'};
 }catch{return {state:'partial-or-unavailable',activeIntervalSeconds:null,nextAction:`Saved configuration may differ from installed/active settings. Inspect service-status ${project}, then preview service-config ${project}; apply only after resolving identity/quiescence errors. Never assume the interval is active.`};}
}

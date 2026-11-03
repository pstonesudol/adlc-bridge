import {existsSync,lstatSync,readFileSync,mkdirSync,rmSync,renameSync,unlinkSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {appState,installationRecord} from './install-state';
import {atomicFile} from './atomic-file';
import {distributionFiles,distributionVersion,installBridge} from './install';
import {turnBarrier,type TurnBarrier} from './turn-submission';
import {liveStackOps,type StackOps} from './stack-control';

export type UpdateMode='manual'|'automatic';
export type UpdatePolicy={
 version:1;
 repository:string;
 remote:string;
 ref:string;
 refKind:'branch'|'release';
 cadenceSeconds:number;
 mode:UpdateMode;
 verification:{requiredChecks:string[];allowCandidateTests:boolean;testCommand:string[]};
 maintenance:{blockIntakeDuringActivation:boolean};
};
export type Candidate={commit:string;ref:string;source:string};
export type Staged={root:string;commit:string;version:string;files:string[]};
export type CheckEvidence={passed:boolean;names:string[];detail:string};
export type TestEvidence={passed:boolean;skipped:boolean;detail:string};
export type MigrationEvidence={required:boolean;compatible:boolean;rollbackSafe:boolean;detail:string};
export type Classification='hot'|'backend'|'schema';
export type PriorService={project:string;loaded:boolean};
export type UpdateIntent={version:1;stage:string;candidate:string;fromVersion:string;classification:Classification;priorServices:PriorService[];backendStopped:boolean;installed:boolean;startedAt:string;updatedAt:string;error?:string};
export type InstalledUpdateState={version:1;commit:string|null;contentVersion:string;classification:Classification;rollbackSafe:boolean;restartRequired:boolean;previousSource:string;previousVersion:string;previousCommit:string|null;dbHash:string|null;activatedAt:string};

export const UPDATE_STAGES=['staged','stopping','quiesced','installing','starting','verifying','completed','deferred','rolled-back','failed','operator-action-required'] as const;
const activeStages=new Set(['staged','stopping','quiesced','installing','starting','verifying']);
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const readJson=(path:string)=>{const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('Update state must be an owner-only regular file');return JSON.parse(readFileSync(path,'utf8'));};

export function repositoryFromRemote(remote:string){
 if(typeof remote!=='string'||!remote.trim())throw Error('Trusted update remote is required');
 if(remote.includes('@')&&remote.startsWith('https://'))throw Error('Update remote must not contain credentials');
 if(remote.startsWith('https://')){
  const url=new URL(remote);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Update remote must be a credential-free HTTPS URL');
  if(url.hostname!=='github.com')throw Error('Update remote must be the authenticated GitHub host');
  const parts=url.pathname.replace(/^\/|\/$/g,'').split('/');if(parts.length!==2)throw Error('Update remote must name exactly one repository');
  return `${parts[0]}/${parts[1].replace(/\.git$/,'')}`;
 }
 const match=remote.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);if(!match)throw Error('Update remote must be an authenticated GitHub SSH or HTTPS remote');
 return `${match[1]}/${match[2]}`;
}
export function validateUpdatePolicy(input:any):UpdatePolicy{
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Update policy must be a JSON object');
 if(input.version!==1)throw Error('Update policy version must be 1');
 const repository=input.repository,remote=input.remote;
 if(typeof repository!=='string'||!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('Update policy repository must be OWNER/REPO');
 if(repositoryFromRemote(remote)!==repository)throw Error('Trusted update remote does not match the configured repository');
 const ref=input.ref??'main',refKind=input.refKind??'branch';
 if(typeof ref!=='string'||!/^[A-Za-z0-9._\/-]+$/.test(ref)||ref.startsWith('-')||ref.startsWith('/')||ref.endsWith('/')||ref.includes('..')||ref.includes('//')||ref.includes('@{'))throw Error('Update ref must be a safe branch or release name');
 if(refKind!=='branch'&&refKind!=='release')throw Error('Update refKind must be branch or release');
 const mode=input.mode??'manual';if(mode!=='manual'&&mode!=='automatic')throw Error('Update mode must be manual or automatic');
 const cadenceSeconds=input.cadenceSeconds??3600;if(!Number.isSafeInteger(cadenceSeconds)||cadenceSeconds<60)throw Error('Update cadenceSeconds must be an integer of at least 60');
 const verification=input.verification??{};
 const requiredChecks=verification.requiredChecks??[];if(!Array.isArray(requiredChecks)||requiredChecks.some((name:any)=>typeof name!=='string'||!name.trim()))throw Error('Update requiredChecks must be a list of check names');
 const allowCandidateTests=verification.allowCandidateTests??false;if(typeof allowCandidateTests!=='boolean')throw Error('allowCandidateTests must be true or false');
 const testCommand=verification.testCommand??['bun','test'];if(!Array.isArray(testCommand)||!testCommand.length||testCommand.some((part:any)=>typeof part!=='string'||!part.trim()))throw Error('Update testCommand must be a non-empty argument list');
 const maintenance=input.maintenance??{};if(maintenance.blockIntakeDuringActivation!==undefined&&maintenance.blockIntakeDuringActivation!==true)throw Error('Updates always block intake during activation');
 return {version:1,repository,remote,ref,refKind,cadenceSeconds,mode,verification:{requiredChecks:[...requiredChecks],allowCandidateTests,testCommand:[...testCommand]},maintenance:{blockIntakeDuringActivation:true}};
}
export function readUpdatePolicy(state=appState()){const path=join(state,'update-policy.json');if(!existsSync(path))return;return validateUpdatePolicy(readJson(path));}
export function writeUpdatePolicy(policy:any,state=appState()){
 const valid=validateUpdatePolicy(policy);atomicFile(join(state,'update-policy.json'),JSON.stringify(valid,null,2)+'\n');return valid;
}
export function classifyChanges(previous:string[],next:string[]):Classification{
 const changed=[...new Set([...previous,...next])].filter(file=>!previous.includes(file)||!next.includes(file));
 return classifyChangedFiles(changed);
}
export function classifyChangedFiles(changed:string[]):Classification{
 if(changed.some(file=>/migration/i.test(file)||file.startsWith('patches/')))return 'schema';
 if(changed.some(file=>file==='package.json'||file==='src/serve-orchestrator.py'||file.startsWith('scripts/')||file.startsWith('patches/')))return 'backend';
 return 'hot';
}
export function changedFiles(previousRoot:string,nextRoot:string,previous:string[],next:string[]){
 return [...new Set([...previous,...next])].sort().filter(file=>{
  const before=join(previousRoot,file),after=join(nextRoot,file);
  if(!existsSync(before)||!existsSync(after))return true;
  try{return !readFileSync(before).equals(readFileSync(after));}catch{return true;}
 });
}
export function blockerSummary(blockers:{session:string;reason:string}[]){
 return blockers.map(blocker=>`${blocker.session} (${blocker.reason})`).join(', ');
}
export function notifyOnce(state:string,event:string,key:string,detail:Record<string,unknown>={},now=Date.now()){
 const path=join(state,'update-notifications.json'),prior=existsSync(path)?readJson(path):{},id=`${event}:${key}`;
 if(prior[id])return false;
 atomicFile(path,JSON.stringify({...prior,[id]:{event,key,at:new Date(now).toISOString(),detail}},null,2)+'\n');return true;
}
function runGit(args:string[],cwd?:string){
 const result=Bun.spawnSync(['git',...args],{cwd,stdout:'pipe',stderr:'pipe',timeout:120000,env:{...Bun.env,GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'true'}});
 if(result.exitCode!==0)throw Error(`Update repository evidence failed: git ${args[0]} exited ${result.exitCode}; ${result.stderr.toString().trim().slice(0,400)}`);
 return result.stdout.toString();
}
export async function resolveCandidate(policy:UpdatePolicy):Promise<Candidate>{
 if(process.platform==='win32')throw Error('Update evidence requires a POSIX Git host');
 const ref=policy.refKind==='branch'?`refs/heads/${policy.ref}`:`refs/tags/${policy.ref}`;
 const text=runGit(['ls-remote','--exit-code',policy.remote,ref,`${ref}^{}`]);
 const rows=text.trim().split('\n').filter(Boolean).map(line=>{const [sha,name]=line.split('\t');return {sha,name};});
 if(!rows.length)throw Error('Authoritative update ref was not found');
 const chosen=policy.refKind==='release'?rows.find(row=>row.name===`${ref}^{}`)??rows.find(row=>row.name===ref):rows.find(row=>row.name===ref);
 if(!chosen||!/^[a-f0-9]{40,64}$/.test(chosen.sha))throw Error('Authoritative update evidence did not identify exactly one immutable commit');
 return {commit:chosen.sha,ref,source:policy.remote};
}
export async function stageCandidate(policy:UpdatePolicy,candidate:Candidate,state=appState()):Promise<Staged>{
 const root=join(state,'updates','work',candidate.commit);
 const inspect=()=>{
  if(!existsSync(join(root,'.git')))throw Error('Staged update checkout is missing its pinned Git identity');
  const head=runGit(['rev-parse','HEAD'],root).trim();if(head!==candidate.commit)throw Error('Staged update checkout no longer matches the pinned candidate');
  if(runGit(['status','--porcelain'],root).trim())throw Error('Staged update checkout was modified; operator action required');
  const files=distributionFiles(root);return {root,commit:head,version:distributionVersion(root,files),files};
 };
 if(existsSync(root))return inspect();
 mkdirSync(dirname(root),{recursive:true,mode:0o700});
 const temp=join(state,'updates','work',`.stage-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
 try{
  runGit(['init','--quiet',temp]);
  runGit(['fetch','--quiet','--depth=1','--no-tags',policy.remote,candidate.commit],temp);
  runGit(['checkout','--quiet','--detach','FETCH_HEAD'],temp);
  const head=runGit(['rev-parse','HEAD'],temp).trim();
  if(head!==candidate.commit)throw Error('Source changed during update staging; candidate is now ambiguous');
  if(runGit(['status','--porcelain'],temp).trim())throw Error('Staged update checkout is not clean');
  renameSync(temp,root);
 }finally{rmSync(temp,{recursive:true,force:true});}
 return inspect();
}
export async function githubChecks(policy:UpdatePolicy,candidate:Candidate):Promise<CheckEvidence>{
 const result=Bun.spawnSync(['gh','api','--method','GET',`repos/${policy.repository}/commits/${candidate.commit}/check-runs?per_page=100`],{stdout:'pipe',stderr:'pipe',timeout:60000,env:{...Bun.env,GH_PROMPT_DISABLED:'1'}});
 if(result.exitCode!==0)return {passed:false,names:[],detail:'Required check evidence is unavailable for the exact candidate'};
 let body:any;try{body=JSON.parse(result.stdout.toString());}catch{return {passed:false,names:[],detail:'Required check evidence was not readable'};}
 return evaluateCheckRuns(policy,body);
}
export function evaluateCheckRuns(policy:Pick<UpdatePolicy,'verification'>,body:any):CheckEvidence{
 const runs=Array.isArray(body?.check_runs)?body.check_runs:null;if(!runs||!Number.isSafeInteger(body.total_count)||body.total_count<1)return {passed:false,names:[],detail:'No required checks were reported for the exact candidate'};
 if(runs.length<body.total_count)return {passed:false,names:[],detail:'Check evidence is incomplete for the exact candidate'};
 const names=runs.map((run:any)=>String(run?.name??'')).filter(Boolean);
 const accepted=new Set(['success','skipped','neutral']);
 const passed=runs.every((run:any)=>run?.status==='completed'&&accepted.has(run?.conclusion))&&policy.verification.requiredChecks.every(name=>names.includes(name));
 return {passed,names,detail:passed?'Required checks passed for the exact candidate':'A required check is missing, pending or unsuccessful'};
}
export async function runCandidateTests(policy:UpdatePolicy,staged:Staged,state=appState()):Promise<TestEvidence>{
 if(!policy.verification.allowCandidateTests)return {passed:true,skipped:true,detail:'Candidate code execution is not authorized; exact-candidate required checks are authoritative'};
 const [program,...args]=policy.verification.testCommand;if(program!=='bun')return {passed:false,skipped:false,detail:'Only the local Bun test runner may be used for candidate tests'};
 const home=join(state,'updates','test-home');mkdirSync(home,{recursive:true,mode:0o700});
 const result=Bun.spawnSync([program,...args],{cwd:staged.root,stdout:'pipe',stderr:'pipe',timeout:900000,env:{PATH:Bun.env.PATH??'/usr/bin:/bin',HOME:home,TMPDIR:tmpdir(),CI:'1',NO_COLOR:'1'}});
 return {passed:result.exitCode===0,skipped:false,detail:result.exitCode===0?'Candidate tests passed':'Candidate tests failed'};
}
export function candidateCompatibility(staged:Staged):{compatible:boolean;detail:string}{
 const pkgPath=join(staged.root,'package.json');if(!existsSync(pkgPath))return {compatible:false,detail:'Candidate package.json is missing'};
 try{const pkg=JSON.parse(readFileSync(pkgPath,'utf8'));if(pkg?.name!=='adlc-bridge'||pkg?.type!=='module'||typeof pkg?.bin?.adlc!=='string')return {compatible:false,detail:'Candidate package identity or bridge entrypoint is incompatible'};}
 catch{return {compatible:false,detail:'Candidate package.json is not readable'};}
 if(!staged.files.includes('src/cli.ts')||!staged.files.includes('src/serve-orchestrator.py'))return {compatible:false,detail:'Candidate is missing the bridge CLI or native launcher'};
 return {compatible:true,detail:'Candidate package identity and bridge entrypoints are compatible'};
}
function installedVersion(state:string){
 const record=installationRecord(state);if(!record||typeof record.version!=='string'||typeof record.source!=='string')throw Error('A stable bridge installation is required before updating');
 const manifest=join(state,'versions',record.version,'manifest.json');if(!existsSync(manifest))throw Error('Installed snapshot manifest is unavailable; preserve it for operator inspection');
 const parsed=readJson(manifest);if(!Array.isArray(parsed.files))throw Error('Installed snapshot manifest is invalid');
 return {record,files:parsed.files as string[]};
}
function readIntent(state:string):UpdateIntent|undefined{const path=join(state,'update-intent.json');if(!existsSync(path))return;const intent=readJson(path);if(intent.version!==1||typeof intent.stage!=='string')throw Error('Update intent is invalid; operator action required');return intent;}
function writeIntent(state:string,intent:UpdateIntent){atomicFile(join(state,'update-intent.json'),JSON.stringify(intent,null,2)+'\n');return intent;}
function advance(state:string,intent:UpdateIntent,stage:string,extra:Partial<UpdateIntent>={}){return writeIntent(state,{...intent,...extra,stage,updatedAt:new Date().toISOString()});}
function readInstalledState(state:string):InstalledUpdateState|undefined{const path=join(state,'update-state.json');if(!existsSync(path))return;const value=readJson(path);if(value.version!==1||(typeof value.commit!=='string'&&value.commit!==null))throw Error('Installed update state is invalid; operator action required');return value;}
function writeInstalledState(state:string,value:InstalledUpdateState){atomicFile(join(state,'update-state.json'),JSON.stringify(value,null,2)+'\n');return value;}
function acquireLock(state:string){
 const lock=join(state,'update.lock');mkdirSync(state,{recursive:true,mode:0o700});
 try{mkdirSync(lock,{mode:0o700});}catch(error:any){if(error?.code==='EEXIST')throw Error('Another update operation is in progress. If interrupted, inspect services and update-intent.json before removing update.lock');throw error;}
 return ()=>{try{rmSync(lock,{recursive:true});}catch{console.error('Update lock cleanup needs inspection:',lock);}};
}
function dbHash(path=process.env.ADLC_DB??join(appState(),'state.sqlite')){
 try{return existsSync(path)?digest(readFileSync(path)):null;}catch{return null;}
}
function previousServices(stack:StackOps){
 return (async()=>{
  const projects=await stack.projects(),prior:PriorService[]=[];
  for(const project of projects){const status=await stack.project('service-status',project.project);prior.push({project:project.project,loaded:!!status?.loaded});}
  return prior;
 })();
}

export type UpdateIO={
 state():string;
 resolve(policy:UpdatePolicy):Promise<Candidate>;
 stage(policy:UpdatePolicy,candidate:Candidate):Promise<Staged>;
 checks(policy:UpdatePolicy,candidate:Candidate):Promise<CheckEvidence>;
 tests(policy:UpdatePolicy,staged:Staged):Promise<TestEvidence>;
 compatibility?(staged:Staged):{compatible:boolean;detail:string};
 reattachment?():Promise<{safe:boolean;detail:string}>;
 stack:StackOps;
 install(apply:boolean,source:string,launcher?:string):Promise<any>;
 launcher():string|undefined;
 migrations?(fromVersion:string,toVersion:string,files:string[]):Promise<MigrationEvidence|undefined>;
 dbHash():string|null;
 notify(event:string,key:string,detail?:Record<string,unknown>):void;
 now():number;
};
export function liveUpdateIO(state=appState()):UpdateIO{
 // Loaded lazily so read-only help never constructs live service state.
 let stack:StackOps|undefined;
 return {
  state:()=>state,
  resolve:resolveCandidate,
  stage:(policy,candidate)=>stageCandidate(policy,candidate,state),
  checks:githubChecks,
  tests:(policy,staged)=>runCandidateTests(policy,staged,state),
  compatibility:candidateCompatibility,
  get stack(){return stack??=liveStackOps(false);},
  install:(apply,source,launcher)=>installBridge(apply,source,launcher),
  launcher:()=>installationRecord(state)?.launcher as string|undefined,
  dbHash,
  notify:(event,key,detail)=>notifyOnce(state,event,key,detail),
  now:()=>Date.now()
 };
}
function readCheckRecord(state:string){const path=join(state,'update-check.json');return existsSync(path)?readJson(path):undefined;}
function readAutoRecord(state:string){const path=join(state,'update-auto.json');return existsSync(path)?readJson(path):undefined;}
function writeAutoAttempt(state:string,now:number){atomicFile(join(state,'update-auto.json'),JSON.stringify({attemptedAt:new Date(now).toISOString()},null,2)+'\n');}

export class UpdateManager{
 constructor(public io:UpdateIO,public turns:TurnBarrier=turnBarrier(io.state())){}
 private notify(event:string,key:string,detail?:Record<string,unknown>){try{this.io.notify(event,key,detail);}catch(error){console.error('Update notification needs inspection:',error instanceof Error?error.message:String(error));}}
 policy(){const policy=readUpdatePolicy(this.io.state());if(!policy)throw Error('Update policy is not configured; run update-config POLICY_JSON --apply first');return policy;}
 async status(){
  const state=this.io.state(),installed=readInstalledState(state),intent=readIntent(state);
  let record:any,recordError:string|undefined;try{record=installationRecord(state);}catch(error){recordError=error instanceof Error?error.message:String(error);}
  let backend:any;try{backend=await this.io.stack.backend();}catch(error){backend={unknown:true,reason:error instanceof Error?error.message:String(error)};}
  const services=[];try{for(const project of await this.io.stack.projects()){try{services.push(await this.io.stack.project('service-status',project.project));}catch(error){services.push({project:project.project,unknown:true,reason:error instanceof Error?error.message:String(error)});}}}catch(error){services.push({unknown:true,reason:error instanceof Error?error.message:String(error)});}
  let policy:UpdatePolicy|undefined,policyError:string|undefined;try{policy=readUpdatePolicy(state);}catch(error){policyError=error instanceof Error?error.message:String(error);}
  let notifications:any={};try{notifications=existsSync(join(state,'update-notifications.json'))?readJson(join(state,'update-notifications.json')):{};}catch(error){notifications={error:error instanceof Error?error.message:String(error)};}
  return {
   source:{path:record?.source??null,commit:installed?.commit??null,commitKnown:!!installed,error:recordError},
   installed:{version:record?.version??null,cli:record?.cli??null,contentHash:record?.version??null,activatedAt:installed?.activatedAt??null},
   running:{backend,services},
   policy:{configured:!!policy,mode:policy?.mode??'manual',repository:policy?.repository??null,ref:policy?.ref??null,error:policyError},
   intent:intent??null,
   lastCheck:readCheckRecord(state)??null,
   lockHeld:existsSync(join(state,'update.lock')),
   pending:{restart:installed?.restartRequired??(installed?.classification==='backend'||installed?.classification==='schema'),migration:installed?.classification==='schema',reason:intent&&activeStages.has(intent.stage)?`Update interrupted at ${intent.stage}; operator action required`:existsSync(join(state,'update.lock'))?'An update lock is held; inspect services before removing it':installed?.restartRequired?'Native launcher migrated; guarded backend restart is still pending':undefined},
   notifications
  };
 }
 async check(){
  const policy=this.policy(),candidate=await this.io.resolve(policy),installed=readInstalledState(this.io.state());
  const result={checkedAt:new Date(this.io.now()).toISOString(),policyMode:policy.mode,candidate,installedCommit:installed?.commit??null,updateAvailable:candidate.commit!==(installed?.commit??null)};
  atomicFile(join(this.io.state(),'update-check.json'),JSON.stringify(result,null,2)+'\n');if(result.updateAvailable)this.notify('update-available',candidate.commit,{ref:candidate.ref});return result;
 }
 async preview(){
  const policy=this.policy(),state=this.io.state(),candidate=await this.io.resolve(policy),current=installedVersion(state),installed=readInstalledState(state);
  const staged=await this.io.stage(policy,candidate);
  if(staged.commit!==candidate.commit)throw Error('Source changed during staging; candidate is now ambiguous');
  if(staged.version===current.record.version)return {upToDate:true,candidate,installedVersion:current.record.version,policy};
  const classification=classifyChangedFiles(changedFiles(join(state,'versions',current.record.version),staged.root,current.files,staged.files)),checks=await this.io.checks(policy,candidate),tests=await this.io.tests(policy,staged),compatibility=(this.io.compatibility??candidateCompatibility)(staged);
  const blockers:string[]=[];
  if(!compatibility.compatible)blockers.push(compatibility.detail);
  if(!checks.passed)blockers.push(checks.detail);
  if(!tests.passed)blockers.push(tests.detail);
  let migration:MigrationEvidence|undefined;
  if(classification==='schema'){
   try{migration=await this.io.migrations?.(current.record.version,staged.version,staged.files);}catch(error){blockers.push(error instanceof Error?error.message:String(error));}
   if(!migration)blockers.push('Schema change requires explicit migration compatibility and restore evidence');
   else{if(!migration.compatible)blockers.push(`Schema change is not compatible: ${migration.detail}`);}
  }
  let quiescence:{session:string;reason:string}[]=[],activityUnknown:string|undefined,reattachment:{safe:boolean;detail:string}|undefined;
  if(classification!=='hot'){try{reattachment=await this.io.reattachment?.();}catch(error){reattachment={safe:false,detail:`Controller reattachment is unverified: ${error instanceof Error?error.message:String(error)}`};}reattachment??={safe:false,detail:'Controller reattachment safety is unverified; backend restart will defer'};}
  try{quiescence=await this.io.stack.blockers();}catch(error){activityUnknown=`Worker activity is unknown: ${error instanceof Error?error.message:String(error)}`;}
  return {upToDate:false,candidate,staged:{commit:staged.commit,version:staged.version,root:staged.root},installedVersion:current.record.version,classification,policy,checks,tests,compatibility,reattachment,migration,migrationEvidence:migration?.detail??null,quiescence,activityUnknown,blockers,ready:blockers.length===0,waitingForIdle:quiescence.length>0||!!activityUnknown,note:'Preview stages an isolated checkout; it does not install, stop or restart anything.'};
 }
 async apply(options:{automatic?:boolean}={}){
  const policy=this.policy(),state=this.io.state();
  if(options.automatic&&policy.mode!=='automatic')throw Error('Automatic update adoption is not enabled; apply updates explicitly');
  if(options.automatic){const last=readAutoRecord(state);if(last?.attemptedAt&&this.io.now()-Date.parse(last.attemptedAt)<policy.cadenceSeconds*1000)return {skipped:true,reason:'Update cadence has not elapsed'};writeAutoAttempt(state,this.io.now());}
  const plan=await this.preview();if(plan.upToDate)return {upToDate:true};
  if(plan.blockers.length)throw Error(`Update is not ready: ${plan.blockers.join('; ')}`);
  this.notify('update-available',plan.candidate.commit,{ref:plan.candidate.ref,classification:plan.classification});
  const launcher=this.io.launcher();if(!launcher)throw Error('Installed launcher identity is unavailable; preserve the installation and inspect it before updating');
  const release=acquireLock(state);
  const wasPaused=this.turns.isPaused();
  const startService=(project:string)=>wasPaused?this.io.stack.project('start',project):this.turns.run(()=>this.io.stack.project('start',project));
  try{
   if(installedVersion(state).record.version!==plan.installedVersion)throw Error('Installed version changed after preview; re-run the update');
   const existing=readIntent(state);if(existing&&activeStages.has(existing.stage))throw Error(`An interrupted update is recorded at ${existing.stage}; inspect services and update-intent.json, then use update-rollback or explicit operator recovery`);
   if(existing?.stage==='operator-action-required')throw Error('A prior update requires explicit operator recovery; inspect services and update-intent.json before retrying');
   const intent=writeIntent(state,{version:1,stage:'staged',candidate:plan.candidate.commit,fromVersion:plan.installedVersion,classification:plan.classification,priorServices:[],backendStopped:false,installed:false,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
   if(!wasPaused)this.turns.pause();
   let prior:PriorService[]=[];let backendStopped=false;let leavePaused=false;let installAttempted=false;
   try{
    prior=await previousServices(this.io.stack);advance(state,intent,'stopping',{priorServices:prior});
    const backup=join(state,'backups',`update-${plan.candidate.commit}`);mkdirSync(backup,{recursive:true,mode:0o700});atomicFile(join(backup,'prior.json'),JSON.stringify({candidate:plan.candidate.commit,fromVersion:plan.installedVersion,classification:plan.classification,priorServices:prior,reattachment:plan.reattachment??null},null,2)+'\n');
    for(const service of prior)if(service.loaded)await this.io.stack.project('stop',service.project);
    let blockers:{session:string;reason:string}[]=[];
    try{blockers=await this.io.stack.blockers();}catch(error){throw new UpdateDeferred(`Worker activity is unknown: ${error instanceof Error?error.message:String(error)}`);}
    if(blockers.length)throw new UpdateDeferred(`Update deferred until idle: ${blockerSummary(blockers)}`);
    advance(state,intent,'quiesced');
    if(plan.classification!=='hot'){
     if(!plan.reattachment?.safe)throw new UpdateDeferred(plan.reattachment?.detail??'Controller reattachment safety is unverified; backend restart deferred');
     const backend=await this.io.stack.backend();if(!backend.ready||!backend.managed)throw Error('Managed Orchestrator is not ready for a guarded backend restart');
     await this.io.stack.backendStop();backendStopped=true;advance(state,intent,'quiesced',{backendStopped:true});
    }
    advance(state,intent,'installing');
    const confirmed=await this.io.resolve(policy);if(confirmed.commit!==plan.candidate.commit)throw Error('Authoritative candidate changed during activation; no installation attempted');
    installAttempted=true;
    const result=await this.io.install(true,plan.staged.root,this.io.launcher());
    advance(state,intent,'starting',{installed:true});
    if(backendStopped)await this.io.stack.backendStart();
    for(const service of prior)if(service.loaded){await startService(service.project);}
    advance(state,intent,'verifying');
    const backend=await this.io.stack.backend();if(!backend.ready||!backend.managed)throw Error('Activated runtime is not healthy');
    for(const service of prior)if(service.loaded){const status=await this.io.stack.project('service-status',service.project);if(!status?.loaded)throw Error(`Project ${service.project} did not restore after activation`);}
    writeInstalledState(state,{version:1,commit:plan.candidate.commit,contentVersion:plan.staged.version,classification:plan.classification,rollbackSafe:plan.migration?.rollbackSafe??true,restartRequired:plan.classification==='hot'&&!!result?.runtimeRestartRequired,previousSource:join(state,'versions',plan.installedVersion),previousVersion:plan.installedVersion,previousCommit:readInstalledState(state)?.commit??null,dbHash:this.io.dbHash(),activatedAt:new Date().toISOString()});
    advance(state,intent,'completed');
    this.notify('activated',plan.candidate.commit,{version:plan.staged.version,classification:plan.classification});
    if(!wasPaused)this.turns.resume();
    return {activated:true,candidate:plan.candidate.commit,version:plan.staged.version,classification:plan.classification,restoredServices:prior,install:result};
   }catch(error){
    const deferred=error instanceof UpdateDeferred;
    const recovery:Error[]=[];let rolledBack=false,runtimeStopped=false;
    if(!deferred){
     const installedState=readInstalledState(state),safe=plan.migration?.rollbackSafe??installedState?.rollbackSafe??true;
     const runtimeRecovery=installAttempted&&plan.classification!=='hot';
     if(runtimeRecovery&&safe){
      // Never restore files or start a runtime underneath a candidate backend.
      try{const backend=await this.io.stack.backend();if(backend.ready||backend.loaded)await this.io.stack.backendStop();runtimeStopped=true;}catch(restore){recovery.push(new Error('Backend could not be stopped before safe restoration',{cause:restore}));}
     }
     if(installAttempted){
      if(!safe)recovery.push(new Error(`Rollback is unsafe: ${plan.migration?.detail??'schema migration evidence is missing'}; backups preserved`));
      else if(!recovery.length)try{await this.io.install(true,join(state,'versions',plan.installedVersion),launcher);rolledBack=true;}catch(restore){recovery.push(new Error('Runtime files could not be restored',{cause:restore}));}
     }
     if(!recovery.length&&(backendStopped||runtimeStopped))try{await this.io.stack.backendStart();}catch(restore){recovery.push(new Error('Backend restart during recovery failed',{cause:restore}));}
    }
    if(deferred||!recovery.length)for(const service of prior)if(service.loaded)try{await startService(service.project);}catch(restore){recovery.push(new Error(`Project ${service.project} did not restart`,{cause:restore}));}
    if(deferred){
     if(recovery.length){
      advance(state,intent,'operator-action-required',{error:error instanceof Error?error.message:String(error)});leavePaused=true;
      this.notify('operator-action-required',plan.candidate.commit,{reason:`Intake restoration failed: ${recovery.map(item=>item.message).join('; ')}`});
      throw new Error(`Update deferred, but prior intake could not be fully restored. Intake remains paused; inspect services and update-intent.json: ${recovery.map(item=>item.message).join('; ')}`,{cause:error});
     }
     advance(state,intent,'deferred',{error:error instanceof Error?error.message:String(error)});
     this.notify('waiting-for-idle',plan.candidate.commit,{reason:error instanceof Error?error.message:String(error)});
     if(!wasPaused)this.turns.resume();
     return {deferred:true,reason:error instanceof Error?error.message:String(error),candidate:plan.candidate.commit};
    }
    const stage=recovery.length?'operator-action-required':rolledBack?'rolled-back':'failed';
    advance(state,intent,stage,{error:error instanceof Error?error.message:String(error)});leavePaused=recovery.length>0;
    this.notify(stage==='operator-action-required'?'operator-action-required':rolledBack?'rolled-back':'failed',plan.candidate.commit,{reason:error instanceof Error?error.message:String(error)});
    if(!leavePaused&&!wasPaused)this.turns.resume();
    const steps=recovery.length?`Intake remains paused. Inspect update-intent.json, ${join(state,'backups')} and service-status; recovery errors: ${recovery.map(item=>item.message).join('; ')}`:`Prior runtime restored; inspect update-intent.json and logs`;
    throw new Error(`Update failed (${error instanceof Error?error.message:String(error)}). ${steps}`,{cause:error});
   }
  }finally{release();}
 }
 async rollback(){
  const state=this.io.state();
  const launcher=this.io.launcher();if(!launcher)throw Error('Installed launcher identity is unavailable; preserve the installation and follow operator recovery steps');
  const release=acquireLock(state),wasPaused=this.turns.isPaused();
  const startService=(project:string)=>wasPaused?this.io.stack.project('start',project):this.turns.run(()=>this.io.stack.project('start',project));
  try{
   const installed=readInstalledState(state);if(!installed)throw Error('No activated update is recorded; nothing to roll back');
   if(!installed.rollbackSafe)throw Error(`Rollback is unsafe: ${installed.classification} changes require explicit migration restore evidence; backups preserved at ${join(state,'backups')}`);
   if(installed.classification==='schema'&&installed.dbHash!==null&&this.io.dbHash()!==installed.dbHash)throw Error('Database changed after activation; refusing to roll back against possibly incompatible work. Preserve evidence and follow operator recovery steps');
   const existing=readIntent(state);if(existing&&activeStages.has(existing.stage))throw Error(`An interrupted update is recorded at ${existing.stage}; explicit operator recovery is required`);
   const source=installed.previousSource;if(typeof source!=='string'||!isAbsolute(source)||!source.startsWith(join(state,'versions')+'/')||!existsSync(join(source,'src','cli.ts')))throw Error('Previous verified snapshot is unavailable; preserve evidence and follow operator recovery steps');
   const intent=writeIntent(state,{version:1,stage:'staged',candidate:installed.previousCommit??installed.previousVersion,fromVersion:installed.contentVersion,classification:installed.classification,priorServices:[],backendStopped:false,installed:false,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
   if(!wasPaused)this.turns.pause();
   let prior:PriorService[]=[];let leavePaused=false,backendStopped=false;
   try{
    prior=await previousServices(this.io.stack);advance(state,intent,'stopping',{priorServices:prior});
    for(const service of prior)if(service.loaded){await this.io.stack.project('stop',service.project);}
    const blockers=await this.io.stack.blockers();if(blockers.length)throw new Error(`Rollback refused while workers are busy: ${blockerSummary(blockers)}`);
    if(installed.classification!=='hot'){
     const reattachment=await this.io.reattachment?.();if(!reattachment?.safe)throw new Error(reattachment?.detail??'Controller reattachment safety is unverified; rollback backend restart deferred');
     const backend=await this.io.stack.backend();if(!backend.ready||!backend.managed)throw Error('Managed Orchestrator is not ready for a guarded rollback restart');
     await this.io.stack.backendStop();backendStopped=true;
    }
    advance(state,intent,'installing');
    await this.io.install(true,source,launcher);
    advance(state,intent,'starting');
    if(backendStopped)await this.io.stack.backendStart();
    for(const service of prior)if(service.loaded)await startService(service.project);
    const backend=await this.io.stack.backend();if(!backend.ready||!backend.managed)throw Error('Restored runtime is not healthy');
    // A successful rollback is terminal for this record; never leave metadata
    // that could authorize another restore from an empty or stale source.
    if(existsSync(join(state,'update-state.json')))unlinkSync(join(state,'update-state.json'));
    advance(state,intent,'rolled-back');
    this.notify('rolled-back',installed.commit,{version:installed.previousVersion});
    if(!wasPaused)this.turns.resume();
    return {rolledBack:true,version:installed.previousVersion,restoredServices:prior};
   }catch(error){
    const recovery:Error[]=[];
    if(backendStopped)recovery.push(new Error('Backend remains stopped after rollback failure; operator action required'));
    else for(const service of prior)if(service.loaded)try{await startService(service.project);}catch(restore){recovery.push(new Error(`Project ${service.project} did not restart`,{cause:restore}));}
    advance(state,intent,recovery.length?'operator-action-required':'failed',{error:error instanceof Error?error.message:String(error)});leavePaused=recovery.length>0;
    if(!leavePaused&&!wasPaused)this.turns.resume();
    throw new Error(`Rollback failed (${error instanceof Error?error.message:String(error)}). Inspect update-intent.json and service-status`,{cause:error});
   }
  }finally{release();}
 }
}
class UpdateDeferred extends Error{}

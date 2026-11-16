import {existsSync,lstatSync,realpathSync,readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,renameSync,readdirSync,readlinkSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Store,digest} from './core';
import {validateDependencySetup,type DependencySetupPolicy} from './dependency-setup-policy';
import {assertWorktreeAvailable,canonicalWorktree} from './worktree-reservation';
import {command,worktreeIdentity} from './delivery-evidence';
import {sessionEvidence} from './session-evidence';
import {AO} from './orchestrator';
import {validateRuntime} from './setup';
import {featureGit} from './approval-policy';
import {RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';
import {isImmutableImage} from './verification';

const action='Operator: inspect dependencySetup, the pinned image/cache and named prerequisite; prepare the approved cache/runtime separately, then recheck this same worker. Never enable scripts, go online, reset edits or resend delivery.';
export class SetupBlocker extends Error{constructor(message:string){super(`${message}. ${action}`);}}
function present(path:string){try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
function safe(root:string,path:string,file=false){
 if(/[,\x00-\x1f]/.test(root))throw new SetupBlocker('Worktree path cannot be represented safely as a runtime mount');
 let p=root;for(const part of path.split('/').filter(x=>x!=='.')){p=join(p,part);if(present(p)&&lstatSync(p).isSymbolicLink())throw new SetupBlocker(`Symbolic setup path ${path}`);}
 if(relative(root,p).startsWith('..')||isAbsolute(relative(root,p)))throw new SetupBlocker('Setup path escapes worktree');
 if(file&&(!existsSync(p)||!lstatSync(p).isFile()))throw new SetupBlocker(`Missing regular setup input ${path}`);
 return p;
}
const lifecycle=['preinstall','install','postinstall','prepare','prepublish','preprepare','postprepare'];
export function setupInputs(tree:string,p:DependencySetupPolicy){
 validateDependencySetup(p);const root=safe(realpathSync(tree),p.cwd),files:Record<string,string>={};
 for(const path of [...p.manifests,p.lockfile]){const full=safe(root,path,true);if(lstatSync(full).size>8_000_000)throw new SetupBlocker(`Oversized input ${path}`);files[path]=readFileSync(full,'utf8');}
 const lock=JSON.parse(files[p.lockfile]);
 if(![2,3].includes(lock.lockfileVersion)||!lock.packages||typeof lock.packages!=='object')throw new SetupBlocker('npm lockfile v2/v3 packages required');
 const manifest=JSON.parse(files['package.json']);
 // Exact paths only in v1: workspace globs/implicit nested packages cannot silently
 // add readable input or writable node_modules locations.
 const workspaces=Array.isArray(manifest.workspaces)?manifest.workspaces:manifest.workspaces?.packages??[];
 const declared=p.manifests.slice(1).map(x=>dirname(x));
 if(!Array.isArray(workspaces)||JSON.stringify([...workspaces].sort())!==JSON.stringify([...declared].sort()))throw new SetupBlocker('Declare every exact npm workspace manifest (workspace globs unsupported in v1)');
 for(const [path,entry] of Object.entries(lock.packages) as [string,any][]){
  if(!entry||entry.hasInstallScript)throw new SetupBlocker(`Lifecycle script requirement in lockfile package ${path||'.'}`);
  if(path.split('/').includes('node_modules')&&!entry.link&&(!/^https:\/\//.test(entry.resolved??'')||typeof entry.integrity!=='string'))throw new SetupBlocker(`Package ${path} needs a registry tarball with locked integrity; git/file dependencies unsupported`);
  if(entry.link&&!declared.includes(entry.resolved))throw new SetupBlocker(`Undeclared local dependency ${path}`);
  if(!entry.link&&path&&!path.split('/').includes('node_modules')&&!declared.includes(path))throw new SetupBlocker(`Undeclared lockfile workspace ${path}`);
 }
 for(const path of p.manifests){const m=JSON.parse(files[path]);if(lifecycle.some(k=>m.scripts?.[k]))throw new SetupBlocker(`Lifecycle script requirement in ${path}`);}
 return {root,files,outputs:['node_modules',...declared.map(x=>`${x}/node_modules`)]};
}

export type SetupBinding={job:string;plan:string;spec:string;session:string;branch:string;worktree:string;dispatch:string;grant:string;runtime:unknown};
export type SetupIO={facts:(job:string,c:any,checkOnly?:boolean)=>Promise<SetupBinding>;install:(input:{files:Record<string,string>;outputs:string[];policy:DependencySetupPolicy;image:string;docker:{path:string;version:string};destination:string})=>Promise<void>};
// The image's node/npm and cache are trusted operator-provisioned prerequisites.
// Installation uses private tmpfs; only selected manifests enter the container.
export const offlineSetupProgram=`
const fs=require('fs'),cp=require('child_process'),path=require('path');
const cfg=JSON.parse(process.argv[1]);
function fail(s){console.error(s);process.exit(2)}
if(!fs.existsSync(cfg.cache))fail('Missing pre-populated npm cache');
fs.cpSync(cfg.cache,'/tmp/cache',{recursive:true});
fs.cpSync('/input','/tmp/project',{recursive:true});
fs.writeFileSync('/tmp/npm-user.npmrc','');
fs.writeFileSync('/tmp/npm-global.npmrc','');
const r=cp.spawnSync('npm',['ci','--ignore-scripts','--offline','--no-audit','--no-fund','--cache','/tmp/cache'],{cwd:'/tmp/project',env:{PATH:process.env.PATH,HOME:'/tmp',npm_config_userconfig:'/tmp/npm-user.npmrc',npm_config_globalconfig:'/tmp/npm-global.npmrc'},stdio:'inherit'});
if(r.status!==0)fail('Offline npm ci failed; inspect missing cached package or runtime prerequisite');
function inspect(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isSymbolicLink())continue;if(ent.isDirectory()){inspect(p);continue}if(ent.name==='binding.gyp')fail('Native lifecycle build prerequisite: '+p);if(ent.name==='package.json'){const m=JSON.parse(fs.readFileSync(p));if(['preinstall','install','postinstall','prepare','prepublish','preprepare','postprepare'].some(k=>m.scripts&&m.scripts[k]))fail('Lifecycle script prerequisite: '+p);}}}
for(let i=0;i<cfg.outputs.length;i++){const src=path.join('/tmp/project',cfg.outputs[i]);if(!fs.existsSync(src))continue;inspect(src);fs.cpSync(src,path.join('/output',String(i)),{recursive:true,dereference:false,verbatimSymlinks:true});}
`;
export async function installOffline(input:Parameters<SetupIO['install']>[0],spawn:typeof Bun.spawn=Bun.spawn){
 const {docker,image,policy,files,outputs,destination}=input;
 const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||gid===undefined)throw new SetupBlocker('Non-root runtime UID/GID required');
 const p=Bun.spawnSync([docker.path,'--version'],{env:{PATH:'/usr/bin:/bin'},stdout:'pipe',stderr:'pipe',timeout:10000});
 if(p.exitCode||!p.stdout.toString().split(/\s+/).some(s=>s.replace(/,$/,'')===docker.version))throw new SetupBlocker('Pinned Docker version unavailable');
 const temp=mkdtempSync(join(tmpdir(),'adlc-npm-input-'));
 try{
  for(const [path,content] of Object.entries(files)){mkdirSync(dirname(join(temp,path)),{recursive:true});writeFileSync(join(temp,path),content);}
  const argv=[docker.path,'run','--rm','--pull=never',...(process.env.AO_SESSION_ID?['--label',`ao.session=${process.env.AO_SESSION_ID}`]:[]),'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',`${uid}:${gid}`,'--pids-limit','128','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,nosuid,nodev,size=1g','--mount',`type=bind,src=${temp},dst=/input,readonly`,'--mount',`type=bind,src=${destination},dst=/output`,'--entrypoint','node',image,'-e',offlineSetupProgram,JSON.stringify({cache:policy.cache,outputs})];
  const child=spawn(argv,{env:{PATH:'/usr/bin:/bin'},stdin:'ignore',stdout:'inherit',stderr:'inherit',timeout:600000});
  if(await child.exited!==0)throw new SetupBlocker('Offline npm setup failed: inspect local output for missing cached package, lifecycle script or image prerequisite');
 }finally{rmSync(temp,{recursive:true,force:true});}
}
export function outputDigest(root:string,logicalRoot=root,workspaceRoot=root):string{
 const entries:any[]=[];let count=0;
 function visit(path:string){if(++count>200000)throw new SetupBlocker('Dependency output exceeds bounded inspection');const s=lstatSync(path),name=relative(root,path);if(s.isSymbolicLink()){const target=readlinkSync(path),resolved=relative(workspaceRoot,resolve(dirname(join(logicalRoot,name)),target));if(isAbsolute(target)||resolved.startsWith('..')||isAbsolute(resolved)||resolved.split('/').some(x=>x==='.git'||x.startsWith('.env')))throw new SetupBlocker(`Unsafe dependency symlink ${name}`);entries.push([name,'link',target]);}else if(s.isDirectory()){entries.push([name,'dir']);for(const n of readdirSync(path).sort())visit(join(path,n));}else if(s.isFile()){if(s.size>64_000_000)throw new SetupBlocker('Dependency file exceeds bounded inspection');entries.push([name,s.mode&0o777,createHash('sha256').update(readFileSync(path)).digest('hex')]);}else throw new SetupBlocker('Unsupported dependency output file');}
 visit(root);return digest(JSON.stringify(entries));
}
export async function setupWorkerOwners(inventory:any,project:string,branch:string,detail:(id:string)=>Promise<any>=async id=>JSON.parse(await command([AO,'session','get',id,'--json']))){
 if(!Array.isArray(inventory.data))throw new SetupBlocker('Complete worker ownership inventory required');
 const owners=[];
 for(const row of inventory.data){
  if(row.isTerminated===true||row.projectId&&row.projectId!==project||row.branch&&row.branch!==branch)continue;
  let session=row;
  if(!row.branch||!row.projectId||typeof row.isTerminated!=='boolean'){
   if(typeof row.id!=='string'||!row.id||row.id.startsWith('-'))throw new SetupBlocker('Invalid worker inventory identity');
   session=(await detail(row.id)).session;
   if(session?.id!==row.id||typeof session.projectId!=='string'||typeof session.branch!=='string'||typeof session.isTerminated!=='boolean')throw new SetupBlocker('Incomplete detailed worker ownership evidence');
  }
  if(!session.isTerminated&&session.projectId===project&&session.branch===branch)owners.push(session);
 }
 return owners;
}
export class DependencySetup{
 io:SetupIO;
 constructor(public s:Store,overrides:Partial<SetupIO>={}){this.io={facts:(j,c,checkOnly)=>this.facts(j,c,checkOnly),install:installOffline,...overrides};}
 private table(){this.s.db.exec(`CREATE TABLE IF NOT EXISTS dependency_setups(binding TEXT PRIMARY KEY,job TEXT NOT NULL,worktree TEXT NOT NULL,state TEXT NOT NULL,proof TEXT NOT NULL,reason TEXT,outputs TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS active_dependency_setup ON dependency_setups(worktree) WHERE state IN ('installing','publishing');`);}
 async facts(job:string,c:any,checkOnly=false):Promise<SetupBinding>{
  assertWorktreeAvailable(this.s,job);
  const j=this.s.get(job),p=this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any,d=this.s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any,g=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
  if(j.project!==c.linear.projectId||j.state!=='approved'||j.approved_hash!==j.plan_hash||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan]))||!p?.worktree||p.state!=='plan_captured'||p.spec_hash!==digest(j.spec)||d?.plan_hash!==j.plan_hash||d.session_id!==p.session_id||g?.plan_hash!==j.plan_hash||d.runtime!=='supervised-host')throw new SetupBlocker('Current captured approval, owned worker and Git grant required');
  if(featureGit.some(op=>!JSON.parse(g.operations).includes(op)))throw new SetupBlocker('Current complete scoped feature Git grant required');
  const run=this.s.db.query('SELECT * FROM runs WHERE job=?').get(job) as any;
  if(run&&(run.owner!=='orchestrator'||run.session_id!==p.session_id||realpathSync(run.worktree)!==realpathSync(p.worktree)||run.plan_hash!==j.plan_hash))throw new SetupBlocker('Execution ownership changed');
  const e=await sessionEvidence(p.session_id),w=await worktreeIdentity(this.s,job);
  const age=Date.now()-e.receiptObservation?.observed;
  if(e.receiptObservation?.complete!==true||!Number.isFinite(age)||age<0||age>RECEIPT_FRESHNESS_MS)throw new SetupBlocker('Fresh complete same-worker evidence required');
  if(e.session?.id!==p.session_id||e.session.projectId!==p.project||e.session.branch!==p.branch||e.session.isTerminated!==false||!checkOnly&&(e.transcript?.controller!=='ready'||!Array.isArray(e.transcript.turns)||e.transcript.turns.some((x:any)=>!['completed','failed','cancelled','interrupted','recovered'].includes(x.state)))||w.branch!==p.branch||w.tree===realpathSync(c.repo))throw new SetupBlocker('Same isolated idle worker required');
  const common=async(path:string)=>realpathSync(resolve(path,await command(['git','--no-optional-locks','rev-parse','--git-common-dir'],path)));
  if(await common(w.tree)!==await common(c.repo))throw new SetupBlocker('Worktree belongs to another repository');
  const inventory=JSON.parse(await command([AO,'session','ls','--all','--include-terminated','--json']));
  const owners=await setupWorkerOwners(inventory,p.project,p.branch);
  if(owners.length!==1||owners[0].id!==p.session_id)throw new SetupBlocker('Exclusive same-worker ownership required');
  const runtime=JSON.parse(readFileSync(c.verificationContext?.runtimeConfig,'utf8'));validateRuntime(runtime);
  if(realpathSync(runtime.projectConfig)!==realpathSync(c.verificationContext.projectConfig)||!runtime.tools.docker)throw new SetupBlocker('Matching host-validated runtime with pinned Docker required');
  if(JSON.stringify(this.s.get(job))!==JSON.stringify(j)||JSON.stringify(this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job))!==JSON.stringify(p)||JSON.stringify(this.s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job))!==JSON.stringify(d)||JSON.stringify(this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job))!==JSON.stringify(g)||JSON.stringify(this.s.db.query('SELECT * FROM runs WHERE job=?').get(job))!==JSON.stringify(run))throw new SetupBlocker('Authorization or execution ownership changed while collecting setup evidence');
  return {job,plan:j.plan_hash,spec:digest(j.spec),session:p.session_id,branch:w.branch,worktree:w.tree,dispatch:d.client_id,grant:JSON.stringify(g),runtime:{docker:runtime.tools.docker,projectConfig:realpathSync(runtime.projectConfig)}};
 }
 async ensure(job:string,c:any,checkOnly=false){
  try{return await this.ensureWithin(job,c,checkOnly);}catch(error){if(error instanceof SetupBlocker)throw error;throw new SetupBlocker('Dependency setup evidence/runtime unavailable or invalid; inspect configured inputs, worker ownership and runtime pins');}
 }
 private async ensureWithin(job:string,c:any,checkOnly=false){
  if(!c?.dependencySetup)return;
  validateDependencySetup(c.dependencySetup);const policy=c.dependencySetup as DependencySetupPolicy;
  if(c.verification?.mode!=='container'||!isImmutableImage(c.verification.container?.image))throw new SetupBlocker('Existing immutable container verification runtime required');
  this.table();
  const facts=await this.io.facts(job,c,checkOnly),input=setupInputs(facts.worktree,policy),runtime=facts.runtime as any;
  // Holds belong to the worktree, not just one hash of its mutable inputs.
  const assertNoHolds=()=>{
   const hold=(this.s.db.query("SELECT binding,worktree,state FROM dependency_setups WHERE state IN ('blocked','installing','publishing')").all() as any[]).find(row=>canonicalWorktree(row.worktree)===facts.worktree);
   if(hold)throw new SetupBlocker(`Retained ${hold.state} setup ${hold.binding}; operator reconciliation required, never replay after input changes`);
  };
  assertNoHolds();
  const proof={facts,policy,image:c.verification.container.image,inputs:Object.fromEntries(Object.entries(input.files).map(([path,text])=>[path,digest(text)]))},binding=digest(JSON.stringify(proof));
  const row=this.s.db.query('SELECT * FROM dependency_setups WHERE binding=?').get(binding) as any;
  const outputs=input.outputs.map(path=>safe(input.root,path));
  const fingerprint=()=>outputs.map(path=>present(path)?outputDigest(path,path,input.root):null);
  if(row){const fingerprints=fingerprint();if(row.state==='ready'&&row.outputs===JSON.stringify(fingerprints))return {binding,state:'ready',fingerprints};throw new SetupBlocker(row.reason??`Retained ${row.state} setup or changed dependencies: inspect dependency_setups binding ${binding}; never replay an interrupted install`);}
  if(checkOnly)throw new SetupBlocker('No verified dependency setup receipt for current inputs; stop verification and request guarded setup in the idle same worker');
  for(let i=0;i<outputs.length;i++){
   if(present(outputs[i]))throw new SetupBlocker(`Unmanaged dependency output ${input.outputs[i]} exists; preserve it and reconcile separately`);
   const rel=relative(facts.worktree,outputs[i]);
   if(await command(['git','--no-optional-locks','ls-files','--',rel],facts.worktree))throw new SetupBlocker(`Tracked dependency output ${rel}`);
   try{await command(['git','--no-optional-locks','check-ignore','--',rel],facts.worktree);}catch{throw new SetupBlocker(`Dependency output ${rel} must already be ignored; operator review required`);}
  }
  const index=await command(['git','--no-optional-locks','diff','--cached','--binary'],facts.worktree);
  const unchanged=async()=>{if(JSON.stringify(await this.io.facts(job,c))!==JSON.stringify(facts)||JSON.stringify(setupInputs(facts.worktree,policy).files)!==JSON.stringify(input.files)||await command(['git','--no-optional-locks','diff','--cached','--binary'],facts.worktree)!==index)throw new SetupBlocker('Approval, worker, inputs or staged edits changed during setup; preserve work for reconciliation');};
  await unchanged();
  this.s.db.transaction(()=>{assertNoHolds();this.s.db.query("INSERT INTO dependency_setups VALUES (?,?,?,'installing',?,NULL,NULL)").run(binding,job,facts.worktree,JSON.stringify(proof));}).immediate();
  const temp=mkdtempSync(join(tmpdir(),'adlc-npm-output-'));
  try{
   await this.io.install({files:input.files,outputs:input.outputs,policy,image:proof.image,docker:runtime.docker,destination:temp});
   await unchanged();
   if(outputs.some(path=>present(path)))throw new SetupBlocker('Dependency output appeared during installation');
   // Same filesystem staging makes each publication an atomic rename. A crash
   // between outputs remains publishing/blocked, never permission to reinstall.
   this.s.db.query("UPDATE dependency_setups SET state='publishing' WHERE binding=?").run(binding);
   for(let i=0;i<outputs.length;i++)if(existsSync(join(temp,String(i)))){
    outputDigest(join(temp,String(i)),outputs[i],input.root);
    // cpSync is used only on generated dependencies, never on source or index.
    const {cpSync}=await import('node:fs');const staged=mkdtempSync(join(dirname(outputs[i]),'.adlc-dependencies-'));
    try{cpSync(join(temp,String(i)),join(staged,'node_modules'),{recursive:true,verbatimSymlinks:true});renameSync(join(staged,'node_modules'),outputs[i]);}finally{rmSync(staged,{recursive:true,force:true});}
   }
   if(!existsSync(outputs[0]))throw new SetupBlocker('Runtime did not produce root node_modules');
   await unchanged();
   const fingerprints=fingerprint();
   this.s.db.query("UPDATE dependency_setups SET state='ready',outputs=? WHERE binding=?").run(JSON.stringify(fingerprints),binding);
   return {binding,state:'ready',fingerprints};
  }catch(e){const reason=e instanceof SetupBlocker?e.message:new SetupBlocker('Setup failed; inspect the local runtime and retained binding').message;this.s.db.query("UPDATE dependency_setups SET state='blocked',reason=? WHERE binding=?").run(reason,binding);throw new SetupBlocker(reason);}
  finally{rmSync(temp,{recursive:true,force:true});}
 }
}

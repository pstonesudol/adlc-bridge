import {existsSync,lstatSync,realpathSync,mkdtempSync,mkdirSync,rmSync,cpSync} from 'node:fs';
import {resolve,relative,join,isAbsolute,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {copyFrontend} from './container-check';
import {validateDependencySetup,type DependencySetupPolicy} from './dependency-setup-policy';
import {outputDigest} from './dependency-setup';

export type Verification={version:1;mode:'host'|'container';steps:{cwd:string;argv:string[]}[];container?:{image:string;inputs:string[]}};
export type VerificationContext={projectConfig:string;runtimeConfig:string;bun:string;cli:string};
export function validateVerificationContext(c:any):asserts c is VerificationContext{
 keys(c,['projectConfig','runtimeConfig','bun','cli']);
 for(const name of ['projectConfig','runtimeConfig','bun','cli'])if(typeof c[name]!=='string'||!isAbsolute(c[name])||/[\x00-\x1f]/.test(c[name]))throw Error('Validated absolute verification context paths required');
}
const safePath=(p:unknown):p is string=>typeof p==='string'&&p.length>0&&/^[\w. /-]+$/.test(p)&&!p.startsWith('/')&&!p.split('/').includes('..');
function keys(v:any,allowed:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw Error('Unknown verification field');}
export function isImmutableImage(image:unknown):image is string{return typeof image==='string'&&/^([\w./:-]+@)?sha256:[a-f0-9]{64}$/.test(image);}
export function validateVerification(v:any):asserts v is Verification{
 keys(v,['version','mode','steps','container']);
 if(v.version!==1||!['host','container'].includes(v.mode)||!Array.isArray(v.steps)||!v.steps.length)throw Error('Invalid verification version, mode or steps');
 for(const s of v.steps){keys(s,['cwd','argv']);if(!safePath(s.cwd)||!Array.isArray(s.argv)||!s.argv.length||s.argv.some((a:any)=>typeof a!=='string'||!a.length||/[\x00-\x1f]/.test(a)))throw Error('Verification needs safe relative cwd and argv');}
 if(v.mode==='host'&&v.container!==undefined)throw Error('Host verification cannot configure a container');
 if(v.mode==='container'){
  keys(v.container,['image','inputs']);
   if(!isImmutableImage(v.container.image)||!Array.isArray(v.container.inputs)||!v.container.inputs.length||v.container.inputs.some((p:any)=>!safePath(p)||p==='.'||p.split('/').some((x:string)=>x.startsWith('.')||['node_modules','AGENTS.md'].includes(x))))throw Error('Container requires immutable image and explicit non-private input paths');
 }
}
export function verificationInstructions(v?:Verification,context?:VerificationContext,worktree='CURRENT_ISOLATED_WORKTREE',dependencySetup=false){
 if(!v)return 'Verification is not configured in this legacy project. Use only the human-approved plan verification; report this configuration gap. Do not assume Docker or invent results.';
 validateVerification(v);
 if(context)validateVerificationContext(context);
  const runner=v.mode==='container'?(context?`Host-validated verification runner argv (use the current reserved worktree): ${JSON.stringify([context.bun,context.cli,'verification',context.projectConfig,worktree,'--run','--runtime',context.runtimeConfig])}`:'STOP before container verification: the host has not supplied a validated runtime configuration path. Request it; never guess a --runtime path or bypass the configured runner.'):'Host verification uses the commands below.';
  if(dependencySetup)return verificationInstructions(v,context,worktree)+ '\nDependency setup is configured: use only the guarded verification runner above, which checks the same-worker setup receipt and mounts a hash-verified private dependency snapshot read-only. Never install dependencies yourself or bypass a cache/script/runtime blocker.';
 return `Project verification v1, execution mode: ${v.mode}. ${v.mode==='container'?`Use existing image ${v.container!.image}; no pulls, host credentials or Docker socket. Inputs: ${JSON.stringify(v.container!.inputs)}.`:'Commands run on the supervised host, not in a container.'}\n${runner}\n${v.steps.map(s=>`Working directory relative to the current isolated worktree: ${JSON.stringify(s.cwd)}; argv: ${JSON.stringify(s.argv)}`).join('\n')}\nNever put credentials in commands or evidence. Report exact commands, exit codes and limitations; mocked checks are not live verification.`;
}
function within(root:string,path:string){const p=realpathSync(resolve(root,path));if(relative(root,p).startsWith('..')||relative(root,p).startsWith('/'))throw Error('Verification path escapes worktree');return p;}
type DockerPin={path:string;version:string};
const probeDocker=(pin:DockerPin)=>{
 const p=Bun.spawnSync([pin.path,'--version'],{stdout:'pipe',stderr:'pipe',timeout:10000,env:{PATH:'/usr/bin:/bin'}});
 return p.exitCode===0&&p.stdout.toString().trim().split(/\s+/).some(x=>x.replace(/,$/,'')===pin.version||x===`v${pin.version}`);
};
export function assertVerificationRepository(worktree:string,projectRepo?:string,inspect:typeof Bun.spawnSync=Bun.spawnSync){
 if(typeof projectRepo!=='string'||!isAbsolute(projectRepo))throw Error('Configured project repository required');
 const common=(repo:string)=>{
  const p=inspect(['git','-C',repo,'rev-parse','--git-common-dir'],{stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  if(p.exitCode!==0)throw Error('Valid project repository/worktree required');
  return realpathSync(resolve(repo,p.stdout.toString().trim()));
 };
 if(common(worktree)!==common(projectRepo))throw Error('Verification worktree belongs to a different project repository');
}
export async function runVerification(worktree:string,v:Verification,spawn:typeof Bun.spawn=Bun.spawn,execution:{projectRepo?:string;docker?:DockerPin;probeDocker?:(pin:DockerPin)=>boolean;dependencySetup?:DependencySetupPolicy;dependencyGuard?:()=>Promise<unknown>}={}){
 validateVerification(v);const root=realpathSync(worktree);if(!existsSync(join(root,'.git')))throw Error('Git worktree required');
  assertVerificationRepository(root,execution.projectRepo);
  const setup=execution.dependencySetup;
   let receipt:any;
   const dependencyPaths=setup?[join(setup.cwd,'node_modules'),...setup.manifests.slice(1).map(p=>join(setup.cwd,p.slice(0,-'/package.json'.length),'node_modules'))]:[];
   const guard=async()=>{
    const current=await execution.dependencyGuard!() as any;
    if(!current||current.state!=='ready'||typeof current.binding!=='string'||!Array.isArray(current.fingerprints)||current.fingerprints.length!==dependencyPaths.length||current.fingerprints.some((x:any)=>x!==null&&(typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x))))throw Error('Verified dependency fingerprints required');
    if(receipt&&JSON.stringify(current)!==JSON.stringify(receipt))throw Error('Dependency readiness changed during verification');
    receipt=current;
   };
   if(setup){validateDependencySetup(setup);if(v.mode!=='container'||!execution.dependencyGuard)throw Error('Guarded container dependency setup required');await guard();}
 const docker=execution.docker;
 const uid=process.getuid?.(),gid=process.getgid?.();
 if(v.mode==='container'){
  if(typeof uid!=='number'||typeof gid!=='number'||!Number.isSafeInteger(uid)||!Number.isSafeInteger(gid)||uid<1||gid<0)throw Error('Container verification requires a non-root invoking UID/GID');
  if(!docker||typeof docker.path!=='string'||!isAbsolute(docker.path)||/[\x00-\x1f]/.test(docker.path)||typeof docker.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(docker.version))throw Error('Container verification requires an absolute Docker executable and exact version from runtime configuration');
  if(!(execution.probeDocker??probeDocker)(docker))throw Error('Configured Docker executable version check failed');
 }
  const snapshot=v.mode==='container'?realpathSync(mkdtempSync(join(tmpdir(),'adlc-verification-'))):undefined;
  const dependencyMounts:string[]=[];
  const checkSnapshot=()=>{
   if(!setup||!snapshot)return;
   for(let i=0;i<dependencyPaths.length;i++){
    const path=dependencyPaths[i],dest=resolve(snapshot,path);
    const actual=existsSync(dest)?outputDigest(dest,resolve(root,path),resolve(root,setup.cwd)):null;
    if(actual!==receipt.fingerprints[i])throw Error('Dependency snapshot differs from verified setup receipt');
   }
  };
 try{
  if(snapshot){
   for(const input of v.container!.inputs){
    // Check the lexical path before realpath hides any selected/ancestor link.
    let selected=root;
    for(const part of input.split('/').filter(Boolean)){selected=join(selected,part);if(lstatSync(selected).isSymbolicLink())throw Error('Verification input cannot be symbolic link');}
    const source=within(root,input),dest=resolve(snapshot,input);mkdirSync(resolve(dest,'..'),{recursive:true});copyFrontend(source,dest);
   }
   if(setup&&snapshot){
    for(let i=0;i<dependencyPaths.length;i++)if(receipt.fingerprints[i]!==null){
     const path=dependencyPaths[i],dest=resolve(snapshot,path);mkdirSync(dirname(dest),{recursive:true});
     cpSync(within(root,path),dest,{recursive:true,dereference:false,verbatimSymlinks:true});
     dependencyMounts.push('--mount',`type=bind,src=${dest},dst=/workspace/${path},readonly`);
    }
    // Containers never read the live worktree dependencies. Comparing the private
    // copy to the recorded hashes also rejects transient writers during copying.
    checkSnapshot();await guard();
   }
  }
  const results=[];
  for(const step of v.steps){
   const cwd=within(snapshot??root,step.cwd);
     if(setup){await guard();checkSnapshot();}
    const argv=snapshot?[docker!.path,'run','--rm','--pull=never',...(process.env.AO_SESSION_ID?['--label',`ao.session=${process.env.AO_SESSION_ID}`]:[]),'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user',`${uid}:${gid}`,'--pids-limit','128','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,nosuid,nodev,size=512m',...v.container!.inputs.flatMap(input=>['--mount',`type=bind,src=${resolve(snapshot,input)},dst=/workspace/${input},readonly`]),...dependencyMounts,'--workdir',`/workspace/${relative(snapshot,cwd)}`,'--entrypoint',step.argv[0],v.container!.image,...step.argv.slice(1)]:step.argv;
   // Output is inherited, not captured/exported as setup data. Commands must never contain secrets.
   const p=spawn(argv,{cwd,stdin:'ignore',stdout:'inherit',stderr:'inherit',env:snapshot?{PATH:process.env.PATH}:process.env});
    const code=await p.exited;
    if(setup){await guard();checkSnapshot();}
    results.push({cwd:step.cwd,argv:step.argv,code});if(code!==0)break;
  }
  return {mode:v.mode,passed:results.length===v.steps.length&&results.every(r=>r.code===0),results,agentContained:false};
 }finally{if(snapshot)rmSync(snapshot,{recursive:true,force:true});}
}

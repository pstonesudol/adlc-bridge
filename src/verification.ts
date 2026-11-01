import {existsSync,realpathSync,mkdtempSync,mkdirSync,rmSync,chmodSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {tmpdir} from 'node:os';
import {copyFrontend} from './container-check';

export type Verification={version:1;mode:'host'|'container';steps:{cwd:string;argv:string[]}[];container?:{image:string;inputs:string[]}};
const safePath=(p:unknown):p is string=>typeof p==='string'&&p.length>0&&/^[\w. /-]+$/.test(p)&&!p.startsWith('/')&&!p.split('/').includes('..');
function keys(v:any,allowed:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw Error('Unknown verification field');}
export function validateVerification(v:any):asserts v is Verification{
 keys(v,['version','mode','steps','container']);
 if(v.version!==1||!['host','container'].includes(v.mode)||!Array.isArray(v.steps)||!v.steps.length)throw Error('Invalid verification version, mode or steps');
 for(const s of v.steps){keys(s,['cwd','argv']);if(!safePath(s.cwd)||!Array.isArray(s.argv)||!s.argv.length||s.argv.some((a:any)=>typeof a!=='string'||!a.length||/[\x00-\x1f]/.test(a)))throw Error('Verification needs safe relative cwd and argv');}
 if(v.mode==='host'&&v.container!==undefined)throw Error('Host verification cannot configure a container');
 if(v.mode==='container'){
  keys(v.container,['image','inputs']);
  if(typeof v.container.image!=='string'||!/^([\w./:-]+@)?sha256:[a-f0-9]{64}$/.test(v.container.image)||!Array.isArray(v.container.inputs)||!v.container.inputs.length||v.container.inputs.some((p:any)=>!safePath(p)||p==='.'||p.split('/').some((x:string)=>x.startsWith('.')||['node_modules','AGENTS.md'].includes(x))))throw Error('Container requires immutable image and explicit non-private input paths');
 }
}
export function verificationInstructions(v?:Verification){
 if(!v)return 'Verification is not configured in this legacy project. Use only the human-approved plan verification; report this configuration gap. Do not assume Docker or invent results.';
 validateVerification(v);
 return `Project verification v1, execution mode: ${v.mode}. ${v.mode==='container'?`Use existing image ${v.container!.image}; no pulls, host credentials or Docker socket. Inputs: ${JSON.stringify(v.container!.inputs)}.`:'Commands run on the supervised host, not in a container.'}\n${v.steps.map(s=>`Working directory relative to the current isolated worktree: ${JSON.stringify(s.cwd)}; argv: ${JSON.stringify(s.argv)}`).join('\n')}\nNever put credentials in commands or evidence. Report exact commands, exit codes and limitations; mocked checks are not live verification.`;
}
function within(root:string,path:string){const p=realpathSync(resolve(root,path));if(relative(root,p).startsWith('..')||relative(root,p).startsWith('/'))throw Error('Verification path escapes worktree');return p;}
export async function runVerification(worktree:string,v:Verification,spawn:typeof Bun.spawn=Bun.spawn){
 validateVerification(v);const root=realpathSync(worktree);if(!existsSync(join(root,'.git')))throw Error('Git worktree required');
 const snapshot=v.mode==='container'?realpathSync(mkdtempSync(join(tmpdir(),'adlc-verification-'))):undefined;
 try{
  if(snapshot){chmodSync(snapshot,0o755);for(const input of v.container!.inputs){const source=within(root,input),dest=resolve(snapshot,input);mkdirSync(resolve(dest,'..'),{recursive:true});copyFrontend(source,dest);}}
  const results=[];
  for(const step of v.steps){
   const cwd=within(snapshot??root,step.cwd);
   const argv=snapshot?['docker','run','--rm','--pull=never',...(process.env.AO_SESSION_ID?['--label',`ao.session=${process.env.AO_SESSION_ID}`]:[]),'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534','--pids-limit','128','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,nosuid,nodev,size=512m',...v.container!.inputs.flatMap(input=>['--mount',`type=bind,src=${resolve(snapshot,input)},dst=/workspace/${input},readonly`]),'--workdir',`/workspace/${relative(snapshot,cwd)}`,'--entrypoint',step.argv[0],v.container!.image,...step.argv.slice(1)]:step.argv;
   // Output is inherited, not captured/exported as setup data. Commands must never contain secrets.
   const p=spawn(argv,{cwd,stdin:'ignore',stdout:'inherit',stderr:'inherit',env:snapshot?{PATH:process.env.PATH}:process.env});
   const code=await p.exited;results.push({cwd:step.cwd,argv:step.argv,code});if(code!==0)break;
  }
  return {mode:v.mode,passed:results.length===v.steps.length&&results.every(r=>r.code===0),results,agentContained:false};
 }finally{if(snapshot)rmSync(snapshot,{recursive:true,force:true});}
}

import {mkdirSync,readdirSync,readFileSync,writeFileSync,lstatSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export type LockOwner={version:1;boot:string;pid:number;started:string;token:string};
export type LockIdentity={boot():string;started(pid:number):string|null};
export const lockIdentity:LockIdentity={
 boot(){
  const argv=process.platform==='darwin'?['/usr/sbin/sysctl','-n','kern.boottime']:['/bin/cat','/proc/sys/kernel/random/boot_id'];
  const r=Bun.spawnSync(argv,{env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}),value=r.stdout.toString().trim();
  if(r.exitCode!==0||!value)throw Error('Boot identity unavailable; lock ownership cannot be proved');return value;
 },
 started(pid){
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid lock owner PID');
  const r=Bun.spawnSync(['/bin/ps','-p',String(pid),'-o','lstart='],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}),text=r.stdout.toString().trim();
  if(r.exitCode===1&&!text&&!r.stderr.toString().trim()&&!r.signalCode)return null;
  if(r.exitCode!==0||!text)throw Error('Process identity unavailable; lock preserved');return text;
 }
};
// Reclaim only an exact, proved-dead generation. Unique filenames make unlink
// the compare-and-swap: a second reaper cannot remove a replacement owner's file.
// Unknown/legacy locks remain operator-gated. Removing a lock grants no replay
// authority: callers must still reconcile their durable mutation receipts.
export function acquireProcessLock(path:string,io:LockIdentity=lockIdentity){
 const boot=io.boot(),started=io.started(process.pid);if(!started)throw Error('Current process identity unavailable');
 const owner:LockOwner={version:1,boot,pid:process.pid,started,token:randomUUID()};
 try{mkdirSync(path,{mode:0o700});}catch(error:any){
  if(error?.code!=='EEXIST')throw error;
  const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('Unsafe lock; preserve for operator inspection');
  const names=readdirSync(path);if(names.length!==1||!/^owner-[\w-]+\.json$/.test(names[0]))throw Error('Lock ownership missing or ambiguous; inspect before retrying');
  const file=join(path,names[0]),fs=lstatSync(file);
  if(!fs.isFile()||fs.isSymbolicLink()||fs.uid!==process.getuid?.()||(fs.mode&0o077)!==0)throw Error('Unsafe lock owner evidence');
  const old:LockOwner=JSON.parse(readFileSync(file,'utf8'));
  if(old.version!==1||!old.boot||!old.started||!Number.isSafeInteger(old.pid)||old.pid<1||names[0]!==`owner-${old.token}.json`)throw Error('Lock owner evidence invalid');
  if(old.boot===boot&&io.started(old.pid)===old.started)throw Error('Another live process holds the lock');
  // A read/permission failure above is not evidence of death. No awaits occur
  // between the generation-specific unlink and rmdir; failed CAS never retries.
  unlinkSync(file);rmdirSync(path);mkdirSync(path,{mode:0o700});
 }
 const file=join(path,`owner-${owner.token}.json`);
 writeFileSync(file,JSON.stringify(owner),{flag:'wx',mode:0o600});
 return ()=>{unlinkSync(file);rmdirSync(path);};
}

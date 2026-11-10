import {test,expect} from 'bun:test';
import {acquireProcessLock,type LockIdentity} from '../src/process-lock';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
for(const state of ['live','dead','reboot','reused-pid','unknown','legacy'])test(`durable lock owner: ${state}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'process-lock-')),lock=join(root,'lock');
 try{
  mkdirSync(lock,{mode:0o700});
  const old={version:1,boot:state==='reboot'?'old-boot':'boot',pid:98765,started:'old-start',token:'old-token'};
  if(state!=='legacy')writeFileSync(join(lock,'owner-old-token.json'),JSON.stringify(old),{mode:0o600});
  const io:LockIdentity={boot:()=> 'boot',started:pid=>{if(pid===process.pid)return 'current-start';if(state==='unknown')throw Error('permission denied');return state==='live'?'old-start':state==='reused-pid'?'new-start':null;}};
  if(['live','unknown','legacy'].includes(state)){expect(()=>acquireProcessLock(lock,io)).toThrow();expect(readdirSync(lock)).toHaveLength(state==='legacy'?0:1);}
  else{const release=acquireProcessLock(lock,io),files=readdirSync(lock);expect(files).toHaveLength(1);expect(JSON.parse(readFileSync(join(lock,files[0]),'utf8')).pid).toBe(process.pid);expect(()=>acquireProcessLock(lock,io)).toThrow('live');release();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

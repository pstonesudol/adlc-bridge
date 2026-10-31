import {cpSync,existsSync,lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Only a disposable frontend snapshot is exposed. No Git metadata, credential
// files, host home, Docker socket, application DB, or controller state is mounted.
const excluded=new Set(['node_modules','.git','.next','.wrangler','source-photos','.npmrc','.netrc','.ssh']);
export function copyFrontend(source:string,destination:string){
  cpSync(source,destination,{recursive:true,dereference:false,filter:(path)=>{
    const name=path.split('/').at(-1)!;
    return !excluded.has(name)&&!name.startsWith('.env')&&!name.endsWith('.tsbuildinfo')&&!lstatSync(path).isSymbolicLink();
  }});
}
export async function containerCheck(worktree:string,selectedImage?:string){
  const root=realpathSync(worktree);
  if(!existsSync(join(root,'.git')))throw Error('Git worktree required');
  const image=selectedImage??process.env.ADLC_FRONTEND_CHECK_IMAGE;
  if(!image)throw Error('ADLC_FRONTEND_CHECK_IMAGE or an explicit image is required');
  const inspect=Bun.spawn(['docker','image','inspect',image,'--format','{{.Id}}'],{stdout:'pipe',stderr:'pipe'});
  const imageId=(await new Response(inspect.stdout).text()).trim();
  if(await inspect.exited!==0||!/^sha256:[a-f0-9]{64}$/.test(imageId))throw Error('Existing frontend image required; no automatic pull');
  // Reusing installed dependencies is valid only for the identical manifest/lock.
  const expected=JSON.stringify([readFileSync(join(root,'package.json'),'utf8'),readFileSync(join(root,'package-lock.json'),'utf8'),readFileSync(join(root,'frontend/package.json'),'utf8')]);
  const probe=Bun.spawn(['docker','run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','node',imageId,'-e',`const fs=require('fs');console.log(JSON.stringify(['/app/package.json','/app/package-lock.json','/app/frontend/package.json'].map(p=>fs.readFileSync(p,'utf8'))))`],{stdout:'pipe',stderr:'pipe'});
  const actual=(await new Response(probe.stdout).text()).trim();
  if(await probe.exited!==0||actual!==expected)throw Error('Container dependencies differ from worktree; rebuild explicitly before verification');
  const snapshot=mkdtempSync(join(tmpdir(),'adlc-check-'));
  try{
    copyFrontend(join(root,'frontend'),join(snapshot,'frontend'));
    copyFrontend(join(root,'backend/templates'),join(snapshot,'backend/templates'));
    const script='cp -R /snapshot/frontend /tmp/frontend && cp -R /snapshot/backend /tmp/backend && ln -s /app/node_modules /tmp/node_modules && cd /tmp/frontend && /app/node_modules/.bin/eslint && /app/node_modules/.bin/tsc --noEmit --incremental false && node --experimental-strip-types --test tests/*.test.mjs';
    const p=Bun.spawn(['docker','run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534','--pids-limit','128','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,nosuid,nodev,size=512m','--mount',`type=bind,src=${snapshot},dst=/snapshot,readonly`,'--entrypoint','sh',imageId,'-c',script],{stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    return {passed:code===0,code,imageId,worktree:root,checks:['eslint','tsc --noEmit --incremental false','frontend tests'],stdout,stderr,agentContained:false};
  }finally{rmSync(snapshot,{recursive:true,force:true});}
}
if(import.meta.main){containerCheck(process.argv[2]??'').then(r=>{console.log(JSON.stringify(r,null,2));if(!r.passed)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;});}

import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {Lifecycle} from '../src/lifecycle';
import {featureGit} from '../src/approval-policy';
import {ConflictRecovery,type RecoveryCommand} from '../src/conflict-recovery';
import {validateConflictPolicy} from '../src/conflict-policy';
import {BranchUpdates} from '../src/branch-updates';
import {sendPilotRemediation} from '../src/pilot';
import {assertWorktreeAvailable,worktreeReservation} from '../src/worktree-reservation';
import {DeliveryRecovery} from '../src/delivery-recovery';
import {maintenance} from '../src/maintenance';

async function fixture(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'adlc-conflict-'))),source=join(dir,'source'),remote=join(dir,'remote.git'),tree=join(dir,'tree');
 const commands:string[][]=[];
 const command:RecoveryCommand=async(args,cwd)=>{
  commands.push(args);
  const p=Bun.spawn(args,{cwd,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {out,err,code};
 };
 const git=async(cwd:string,...args:string[])=>{const r=await command(['git',...args],cwd);if(r.code)throw Error(r.err);return r.out.trim();};
 await git(dir,'init','--bare',remote);await git(dir,'init','-b','main',source);
 writeFileSync(join(source,'app.txt'),'feature=old\nsafety=old\n');await git(source,'add','.');await git(source,'commit','-m','Initial');await git(source,'remote','add','origin',remote);await git(source,'push','origin','main');
 const s=new Store(join(dir,'state.sqlite')),workflow=new Workflow(s,{} as any),p=new Planning(s),job=s.enqueue('project','issue','spec'),reserved=p.reserve(job,'ao');
 await git(source,'worktree','add','-b',reserved.branch,tree);
 writeFileSync(join(tree,'app.txt'),'feature=new\nsafety=old\n');await git(tree,'add','.');await git(tree,'commit','-m','Feature');await git(tree,'push','origin',reserved.branch);
 writeFileSync(join(source,'app.txt'),'feature=old\nsafety=new\n');writeFileSync(join(source,'safeguard.txt'),'base safeguard\n');await git(source,'add','.');await git(source,'commit','-m','Base safety');await git(source,'push','origin','main');
 p.gate(job,'ao','worker',reserved.branch,tree);const plan=s.propose(job,'approved plan');s.approve(job,plan,'human');const l=new Lifecycle(s);l.grantGit(job,plan,[...featureGit,'merge-base-feature'],'human');l.adoptSupervised(job,{id:'worker',correlation:reserved.correlation,worktree:tree,controller:'running'});
 s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(job,plan,'worker','original','pr_handoff',JSON.stringify(['app.txt']),'supervised-host','human',null);
 s.db.exec(`CREATE TABLE review_targets(job TEXT PRIMARY KEY,head TEXT,head_since INTEGER,state TEXT,reason TEXT,last_signature TEXT);`);
 s.db.query('INSERT INTO review_targets VALUES (?,?,?,?,?,?)').run(job,null,0,'ready_for_human',null,'old');
 const config={repo:source,githubRepo:'owner/repo',linear:{projectId:'project'},conflictRecovery:{version:1 as const,enabled:true,authorizedBy:'human',baseBranch:'main',maxRecoveries:3,verification:[[process.execPath,'-e',"if(require('fs').readFileSync('app.txt','utf8')!=='feature=new\\nsafety=new\\n')process.exit(1)"]]}};
 const e:any={session:{id:'worker',branch:reserved.branch,isTerminated:false,activity:{state:'idle'},prs:[{number:1,url:'https://github.com/owner/repo/pull/1',state:'open'}]},transcript:{controller:'ready',entries:[],turns:[]}};
 let sends=0,owners=['worker'],idle=true,lost=false;
 const snapshot=async()=>({head:await git(remote,'rev-parse',`refs/heads/${reserved.branch}`),base:await git(remote,'rev-parse','refs/heads/main'),branch:reserved.branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:false,behind:1});
 const io={command,snapshot,evidence:async()=>e,submit:async<T>(fn:()=>Promise<T>)=>fn(),send:async(_s:string,_p:string,id:string)=>{sends++;if(lost)throw Error('Lost receipt');e.transcript.entries=[{clientMessageId:id,turnId:'resolution'}];e.transcript.turns=[{id:'resolution',state:'running'}];},facts:async()=>{const b=await snapshot();return {session:'worker',project:'ao',reserved:reserved.branch,worktree:tree,branch:await git(tree,'branch','--show-current'),head:await git(tree,'rev-parse','HEAD'),anchor:await git(tree,'rev-parse',reserved.branch),clean:!(await git(tree,'status','--porcelain')),isolated:true,lineage:true,idle,completed:true,owners,candidates:[{repo:'owner/repo',pr:1,url:'https://github.com/owner/repo/pull/1',branch:reserved.branch,head:b.head,baseBranch:'main',defaultBranch:'main',fork:false,state:'open',draft:false}]};}};
 const recovery=new ConflictRecovery(s,io as any);
 return {s,job,workflow,l,plan,config,dir,tree,remote,source,branch:reserved.branch,e,io,recovery,commands,git,sends:()=>sends,setOwners:(v:string[])=>owners=v,lose:()=>lost=true,resolve:()=>{writeFileSync(join(tree,'app.txt'),'feature=new\nsafety=new\n');e.transcript.turns=[{id:'resolution',state:'completed'}];},close:()=>{s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('DEV-15/16 conflict preserves feature and base safeguards, normal pushes and invalidates old clearance',async()=>{
 const f=await fixture();try{
  expect((await f.recovery.tick(f.job,f.config,'owner/repo',1))?.stage).toBe('resolving');expect(f.sends()).toBe(1);
  expect((await f.recovery.tick(f.job,f.config,'owner/repo',1))?.state).toBe('waiting_for_worker');expect(f.s.get(f.job).attempts).toBe(1);
  f.resolve();expect(await new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1)).toBeNull();
  expect(readFileSync(join(f.tree,'app.txt'),'utf8')).toBe('feature=new\nsafety=new\n');
  expect(readFileSync(join(f.tree,'safeguard.txt'),'utf8')).toBe('base safeguard\n');
  const row=f.recovery.row(f.job),detail=JSON.parse(row.detail);expect(row.state).toBe('completed');expect(detail.verification[0].code).toBe(0);
  expect(await f.git(f.remote,'rev-parse',`refs/heads/${f.branch}`)).toBe(detail.result);
  expect((f.s.db.query('SELECT * FROM review_targets').get() as any).state).toBe('waiting_for_ci');
  expect(f.commands.filter(a=>a[0]==='git'&&a[1]==='push').at(-1)).toEqual(['git','push','origin',`${detail.result}:refs/heads/${f.branch}`]);
  expect(f.commands.flat().some(a=>['--force','--force-with-lease','reset','rebase','--ours','--theirs'].includes(a))).toBe(false);
 }finally{f.close();}
});
test('rejected normal push retains merge commit and never overwrites a competing actor',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  const actor=join(f.dir,'actor');await f.git(f.source,'worktree','add','--detach',actor,f.recovery.row(f.job).head);await f.git(actor,'commit','--allow-empty','-m','Other actor');const actorHead=await f.git(actor,'rev-parse','HEAD');
  let changed=false;
  const io={...f.io,command:async(args:string[],cwd:string)=>{if(!changed&&args[0]==='git'&&args[1]==='push'){changed=true;await f.git(actor,'push','origin',`HEAD:refs/heads/${f.branch}`);}return f.io.command(args,cwd);}};
  const result=await new ConflictRecovery(f.s,io as any).tick(f.job,f.config,'owner/repo',1);expect(result?.reason).toContain('rejected');
  expect(await f.git(f.remote,'rev-parse',`refs/heads/${f.branch}`)).toBe(actorHead);expect(await f.git(f.tree,'rev-parse','HEAD')).not.toBe(actorHead);
  const count=f.commands.filter(a=>a[1]==='push').length;await f.recovery.tick(f.job,f.config,'owner/repo',1);expect(f.commands.filter(a=>a[1]==='push').length).toBe(count);
 }finally{f.close();}
});
test('unresolved markers and worker changes to new base safeguards cannot publish',async()=>{
 for(const kind of ['markers','base-edit']){
  const f=await fixture();try{
   await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
   if(kind==='markers')writeFileSync(join(f.tree,'app.txt'),'<<<<<<< unresolved\n=======\n>>>>>>> base\n');
   else writeFileSync(join(f.tree,'safeguard.txt'),'weakened\n');
   const r=await f.recovery.tick(f.job,f.config,'owner/repo',1);expect(r?.state).toBe('blocked');expect(f.recovery.row(f.job).state).not.toBe('completed');
   expect(await f.git(f.remote,'rev-parse',`refs/heads/${f.branch}`)).toBe(f.recovery.row(f.job).head);
  }finally{f.close();}
 }
});
test('durable database restart keeps missing-receipt reservation and does not replay',async()=>{
 const f=await fixture();try{
  f.lose();await f.recovery.tick(f.job,f.config,'owner/repo',1);
  const reopened=new Store(join(f.dir,'state.sqlite'));
  try{const r=new ConflictRecovery(reopened,f.io as any);await r.tick(f.job,f.config,'owner/repo',1);expect(r.row(f.job).state).toBe('resolving');expect(f.sends()).toBe(1);}finally{reopened.close();}
 }finally{f.close();}
});
test('existing grants do not acquire merge authority; disabled and malformed policy refuse recovery',async()=>{
 const f=await fixture();try{
  f.l.grantGit(f.job,f.plan,featureGit,'human');await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('merge-base-feature');expect(f.s.get(f.job).attempts).toBe(0);
  expect(()=>validateConflictPolicy({...f.config.conflictRecovery,version:2})).toThrow();expect(()=>validateConflictPolicy({...f.config.conflictRecovery,verification:[]})).toThrow();
  await expect(f.recovery.tick(f.job,{...f.config,conflictRecovery:undefined},'owner/repo',1)).rejects.toThrow('enabled');
 }finally{f.close();}
});
test('dirty, divergent, competing-owner, stale approval and pre-existing merge refuse before reservation',async()=>{
 const f=await fixture();try{
  f.setOwners(['worker','other']);await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('mismatch');f.setOwners(['worker']);
  writeFileSync(join(f.tree,'extra'),'dirty');await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('Dirty');rmSync(join(f.tree,'extra'));
  await f.git(f.tree,'commit','--allow-empty','-m','Unpublished');await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('divergent');
  f.s.db.query("UPDATE jobs SET approved_hash='stale' WHERE id=?").run(f.job);await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('approval');expect(f.s.get(f.job).attempts).toBe(0);
 }finally{f.close();}
});
test('lost delivery and restart never replay even on changed head; durable worktree reservation fences all competing paths',async()=>{
 const f=await fixture();try{
  f.lose();await f.recovery.tick(f.job,f.config,'owner/repo',1);expect(f.sends()).toBe(1);
  await new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1);expect(f.sends()).toBe(1);expect(worktreeReservation(f.s,f.job)).toBeTruthy();
  expect(()=>assertWorktreeAvailable(f.s,f.job)).toThrow('reserved');
  await expect(new BranchUpdates(f.s).ensure(f.job,'owner/repo',1,f.e)).rejects.toThrow('reserved');
  await expect(sendPilotRemediation(f.s,f.job,'a'.repeat(40),'[]','owner/repo',1,[])).rejects.toThrow('reserved');
  expect(()=>f.l.reserveRemediation(f.job,'a'.repeat(40),'other')).toThrow('reserved');
  await expect(f.workflow.startPlanning(f.job,f.config)).rejects.toThrow('reserved');
  await expect(f.workflow.deliverPlanning(f.job,'worker',{} as any)).rejects.toThrow('reserved');
  await expect(f.workflow.resume(f.job,f.config)).rejects.toThrow('reserved');
  expect((await f.workflow.executeApproved(f.job,f.config))?.state).toBe('conflict_recovery');
  await expect(new DeliveryRecovery(f.s,{} as any).confirm(f.job,f.config,'hash')).rejects.toThrow('reserved');
  await expect(maintenance(f.s,'recover',f.job)).rejects.toThrow('reserved');
  expect(()=>f.l.reconcile(f.job,[],true)).toThrow('reserved');
 }finally{f.close();}
});
test('simultaneous polls reserve one intent and send once',async()=>{
 const f=await fixture();try{
  await Promise.allSettled([f.recovery.tick(f.job,f.config,'owner/repo',1),new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1)]);
  expect(f.sends()).toBe(1);expect(f.s.get(f.job).attempts).toBe(1);expect((f.s.db.query('SELECT count(*) AS n FROM conflict_recoveries').get() as any).n).toBe(1);
 }finally{f.close();}
});
test('out-of-scope conflict preserves merge evidence and never sends or publishes',async()=>{
 const f=await fixture();try{
  f.s.db.query('UPDATE implementation_dispatch SET paths=? WHERE job=?').run(JSON.stringify(['other.txt']),f.job);
  const r=await f.recovery.tick(f.job,f.config,'owner/repo',1);expect(r?.reason).toContain('app.txt');expect(f.sends()).toBe(0);expect(await f.git(f.tree,'rev-parse','MERGE_HEAD')).toBe(f.recovery.row(f.job).base);
 }finally{f.close();}
});
test('base changes before publication stop without rewriting or dropping merged work',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();await f.git(f.source,'commit','--allow-empty','-m','Concurrent base');await f.git(f.source,'push','origin','main');
  expect((await f.recovery.tick(f.job,f.config,'owner/repo',1))?.reason).toContain('changed');expect(f.sends()).toBe(1);
  expect(await f.git(f.tree,'rev-parse','MERGE_HEAD')).toBe(f.recovery.row(f.job).base);
 }finally{f.close();}
});
test('restart after merge/commit uncertainty preserves evidence and never repeats mutation',async()=>{
 for(const boundary of ['merge','commit']){
  const f=await fixture();try{
   let fired=false;
   const io={...f.io,command:async(args:string[],cwd:string)=>{const result=await f.io.command(args,cwd);if(!fired&&args.includes(boundary)&&args[0]==='git'){fired=true;throw Error('Simulated crash after '+boundary);}return result;}};
   const r=new ConflictRecovery(f.s,io as any);await r.tick(f.job,f.config,'owner/repo',1);
   if(boundary==='commit'){f.resolve();await r.tick(f.job,f.config,'owner/repo',1);}
   const head=await f.git(f.tree,'rev-parse','HEAD'),count=f.commands.filter(a=>a.includes(boundary)).length;
   await new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1);
   expect(await f.git(f.tree,'rev-parse','HEAD')).toBe(head);expect(f.commands.filter(a=>a.includes(boundary)).length).toBe(count);
   expect(f.recovery.row(f.job).reason).toContain('Simulated crash');
  }finally{f.close();}
 }
});
test('lost successful push response reconciles on restart without a second push',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  const io={...f.io,command:async(args:string[],cwd:string)=>{const result=await f.io.command(args,cwd);if(args[0]==='git'&&args[1]==='push')throw Error('Lost push response');return result;}};
  expect((await new ConflictRecovery(f.s,io as any).tick(f.job,f.config,'owner/repo',1))?.stage).toBe('pushing');
  const count=f.commands.filter(a=>a[1]==='push').length;
  expect(await new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1)).toBeNull();expect(f.commands.filter(a=>a[1]==='push').length).toBe(count);
  expect(f.recovery.row(f.job).state).toBe('completed');
 }finally{f.close();}
});
test('operator reconciliation preview is read-only; exact confirm verifies published merge without sends/pushes',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  const io={...f.io,command:async(args:string[],cwd:string)=>{const result=await f.io.command(args,cwd);if(args.includes('commit')&&args[0]==='git')throw Error('Lost commit receipt');return result;}};
  await new ConflictRecovery(f.s,io as any).tick(f.job,f.config,'owner/repo',1);
  await f.git(f.tree,'push','origin',`HEAD:refs/heads/${f.branch}`);const count=f.commands.filter(a=>a[1]==='push').length;
  const before=JSON.stringify(f.recovery.row(f.job)),preview=await f.recovery.manualPreview(f.job,f.config);expect(JSON.stringify(f.recovery.row(f.job))).toBe(before);
  await expect(f.recovery.manualConfirm(f.job,f.config,'stale','human')).rejects.toThrow('changed');
  expect((await f.recovery.manualConfirm(f.job,f.config,preview.confirmation,'human')).state).toBe('completed');expect(f.commands.filter(a=>a[1]==='push').length).toBe(count);expect(f.sends()).toBe(1);
 }finally{f.close();}
});
test('verification is fail-fast and never publishes a failed merged tree',async()=>{
 const f=await fixture();try{
  f.config.conflictRecovery.verification=[[process.execPath,'-e','process.exit(3)'],[process.execPath,'-e',"throw Error('must not run')"]];
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();const before=await f.git(f.remote,'rev-parse',`refs/heads/${f.branch}`);
  expect((await f.recovery.tick(f.job,f.config,'owner/repo',1))?.reason).toContain('Verification failed');expect(await f.git(f.remote,'rev-parse',`refs/heads/${f.branch}`)).toBe(before);
  expect(JSON.parse(f.recovery.row(f.job).detail).verification.length).toBe(1);
  await new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1);expect(JSON.parse(f.recovery.row(f.job).detail).verification.length).toBe(1);
 }finally{f.close();}
});

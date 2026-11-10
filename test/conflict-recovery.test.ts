import {test,expect,setSystemTime} from 'bun:test';
import {RecoveryObservation} from '../src/recovery-observation';
import {readFailure} from '../src/provider-read';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {Lifecycle} from '../src/lifecycle';
import {featureGit} from '../src/approval-policy';
import {ConflictRecovery,recoveryCommand,verificationCommand,type RecoveryCommand} from '../src/conflict-recovery';
import {validateConflictPolicy} from '../src/conflict-policy';
import {BranchUpdates} from '../src/branch-updates';
import {sendPilotRemediation} from '../src/pilot';
import {assertWorktreeAvailable,worktreeReservation} from '../src/worktree-reservation';
import {DeliveryRecovery} from '../src/delivery-recovery';
import {maintenance} from '../src/maintenance';

async function fixture(filename='app.txt'){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'adlc-conflict-'))),source=join(dir,'source'),remote=join(dir,'remote.git'),tree=join(dir,'tree');
 const commands:string[][]=[];
 const command:RecoveryCommand=async(args,cwd)=>{
  commands.push(args);
  const p=Bun.spawn(args,{cwd,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {out,err,code};
 };
 const git=async(cwd:string,...args:string[])=>{const r=await command(['git',...args],cwd);if(r.code)throw Error(r.err);return r.out.trim();};
 await git(dir,'init','--bare',remote);await git(dir,'init','-b','main',source);
 writeFileSync(join(source,filename),'feature=old\nsafety=old\n');await git(source,'add','.');await git(source,'commit','-m','Initial');await git(source,'remote','add','origin',remote);await git(source,'push','origin','main');
 const s=new Store(join(dir,'state.sqlite')),workflow=new Workflow(s,{} as any),p=new Planning(s),job=s.enqueue('project','issue','spec'),reserved=p.reserve(job,'ao');
 await git(source,'worktree','add','-b',reserved.branch,tree);
 writeFileSync(join(tree,filename),'feature=new\nsafety=old\n');await git(tree,'add','.');await git(tree,'commit','-m','Feature');await git(tree,'push','origin',reserved.branch);
 writeFileSync(join(source,filename),'feature=old\nsafety=new\n');writeFileSync(join(source,'safeguard.txt'),'base safeguard\n');await git(source,'add','.');await git(source,'commit','-m','Base safety');await git(source,'push','origin','main');
 p.gate(job,'ao','worker',reserved.branch,tree);const plan=s.propose(job,'approved plan');s.approve(job,plan,'human');const l=new Lifecycle(s);l.grantGit(job,plan,[...featureGit,'merge-base-feature'],'human');l.adoptSupervised(job,{id:'worker',correlation:reserved.correlation,worktree:tree,controller:'running'});
 s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(job,plan,'worker','original','pr_handoff',JSON.stringify([filename]),'supervised-host','human',null);
 s.db.exec(`CREATE TABLE review_targets(job TEXT PRIMARY KEY,head TEXT,head_since INTEGER,state TEXT,reason TEXT,last_signature TEXT,repo TEXT DEFAULT 'owner/repo',pr INTEGER DEFAULT 1);`);
 s.db.query('INSERT INTO review_targets(job,head,head_since,state,reason,last_signature) VALUES (?,?,?,?,?,?)').run(job,null,0,'ready_for_human',null,'old');
 const config={repo:source,githubRepo:'owner/repo',linear:{projectId:'project'},conflictRecovery:{version:1 as const,enabled:true,authorizedBy:'human',baseBranch:'main',maxRecoveries:3,verification:[[process.execPath,'-e',`if(require('fs').readFileSync(${JSON.stringify(filename)},'utf8')!=='feature=new\\nsafety=new\\n')process.exit(1)`]]}};
 const e:any={session:{id:'worker',branch:reserved.branch,isTerminated:false,activity:{state:'idle'},prs:[{number:1,url:'https://github.com/owner/repo/pull/1',state:'open'}]},transcript:{controller:'ready',entries:[],turns:[]}};
 let sends=0,owners=['worker'],idle=true,lost=false;
 const snapshot=async()=>({head:await git(remote,'rev-parse',`refs/heads/${reserved.branch}`),base:await git(remote,'rev-parse','refs/heads/main'),branch:reserved.branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:false,behind:1});
 const io={command,snapshot,evidence:async()=>e,submit:async<T>(fn:()=>Promise<T>)=>fn(),send:async(_s:string,_p:string,id:string)=>{sends++;if(lost)throw Error('Lost receipt');e.transcript.entries=[{clientMessageId:id,turnId:'resolution'}];e.transcript.turns=[{id:'resolution',state:'running'}];},facts:async()=>{const b=await snapshot();return {session:'worker',project:'ao',reserved:reserved.branch,worktree:tree,branch:await git(tree,'branch','--show-current'),head:await git(tree,'rev-parse','HEAD'),anchor:await git(tree,'rev-parse',reserved.branch),clean:!(await git(tree,'status','--porcelain')),isolated:true,lineage:true,idle,completed:true,owners,candidates:[{repo:'owner/repo',pr:1,url:'https://github.com/owner/repo/pull/1',branch:reserved.branch,head:b.head,baseBranch:'main',defaultBranch:'main',fork:false,state:'open',draft:false}]};}};
 const recovery=new ConflictRecovery(s,io as any);
  return {s,job,workflow,l,plan,config,dir,tree,remote,source,branch:reserved.branch,e,io,recovery,commands,git,sends:()=>sends,setOwners:(v:string[])=>owners=v,lose:()=>lost=true,resolve:()=>{writeFileSync(join(tree,filename),'feature=new\nsafety=new\n');e.transcript.turns=[{id:'resolution',state:'completed'}];e.transcript.entries.push({kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'resolution',text:`<!-- ADLC_WORKER_STATUS ${JSON.stringify({version:1,outcome:'host-ready',reason:`Resolved ${filename}; host staging, verification and publication remain`,questions:[],dependencies:[]})} -->`});},close:()=>{s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('reserved conflict recovery retries six read failures before any mutation',async()=>{
 const f=await fixture();let fail=true,reads=0;
 const snapshot=async()=>{if(++reads>=3&&fail)throw readFailure('github','branch-read','HTTP 503',1);return f.io.snapshot();};
 try{
 for(let n=1;n<=6;n++){
 const result=await new ConflictRecovery(f.s,{...f.io,snapshot} as any).tick(f.job,f.config,'owner/repo',1);
 expect(result?.state).toBe('waiting_for_worker');expect(f.recovery.row(f.job)).toMatchObject({state:'reserved',reason:null});expect(f.sends()).toBe(0);
 expect(f.commands.filter(a=>a[0]==='git'&&['fetch','merge','update-ref'].includes(a[1]))).toHaveLength(0);
 const status=new RecoveryObservation(f.s).status(f.job);expect(status.failures).toBe(n);setSystemTime(new Date(status.next_read+1));
 }
 fail=false;expect((await new ConflictRecovery(f.s,{...f.io,snapshot} as any).tick(f.job,f.config,'owner/repo',1))?.stage).toBe('resolving');
 expect(f.sends()).toBe(1);expect(f.s.get(f.job).attempts).toBe(1);
 // A complete guarded observation resets only the job's read failure history.
 expect(new RecoveryObservation(f.s).status(f.job)).toBeNull();
 }finally{setSystemTime();f.close();}
},60000);
test('reserved conflict recovery retries transient facts read failures after GitHub recovers',async()=>{
 const f=await fixture();let calls=0,remaining=2;
 // The reservation preview and inspection read facts before the row exists;
 // only reads under the reserved stage may be tracked and retried.
 const facts=async()=>{if(++calls>2&&remaining-->0)throw readFailure('github','recovery-facts','HTTP 503',1);return f.io.facts(f.job,f.config);};
 try{
 for(let n=1;n<=2;n++){
 const result=await new ConflictRecovery(f.s,{...f.io,facts} as any).tick(f.job,f.config,'owner/repo',1);
 expect(result?.state).toBe('waiting_for_worker');expect(f.sends()).toBe(0);expect(f.recovery.row(f.job)).toMatchObject({state:'reserved',reason:null});
 expect(f.commands.filter(a=>a[0]==='git'&&['fetch','merge','update-ref'].includes(a[1]))).toHaveLength(0);
 const status=new RecoveryObservation(f.s).status(f.job);expect(status.failures).toBe(n);expect(status.evidence).toMatchObject({provider:'github',classification:'server'});setSystemTime(new Date(status.next_read+1));
 }
 expect((await new ConflictRecovery(f.s,{...f.io,facts} as any).tick(f.job,f.config,'owner/repo',1))?.stage).toBe('resolving');
 expect(f.sends()).toBe(1);expect(f.s.get(f.job).attempts).toBe(1);
 }finally{setSystemTime();f.close();}
},60000);
test('reserved conflict recovery retries transient orchestrator facts failures after AO recovers',async()=>{
 const f=await fixture();let calls=0,remaining=2;
 const facts=async()=>{if(++calls>2&&remaining-->0)throw readFailure('orchestrator','recovery-facts','AO daemon is not running — start it with `ao start`',1);return f.io.facts(f.job,f.config);};
 try{
 for(let n=1;n<=2;n++){
 const result=await new ConflictRecovery(f.s,{...f.io,facts} as any).tick(f.job,f.config,'owner/repo',1);
 expect(result?.state).toBe('waiting_for_worker');expect(f.sends()).toBe(0);expect(f.recovery.row(f.job)).toMatchObject({state:'reserved',reason:null});
 const status=new RecoveryObservation(f.s).status(f.job);expect(status.failures).toBe(n);expect(status.evidence).toMatchObject({provider:'orchestrator',classification:'network'});setSystemTime(new Date(status.next_read+1));
 }
 expect((await new ConflictRecovery(f.s,{...f.io,facts} as any).tick(f.job,f.config,'owner/repo',1))?.stage).toBe('resolving');
 expect(f.sends()).toBe(1);
 }finally{setSystemTime();f.close();}
},60000);
test('transient reservation reads back off before a conflict recovery row exists',async()=>{
 const f=await fixture();let fail=true;
 const facts=async()=>{if(fail)throw readFailure('github','recovery-facts','HTTP 503',1);return f.io.facts(f.job,f.config);};
 try{
 const first=await new ConflictRecovery(f.s,{...f.io,facts} as any).tick(f.job,f.config,'owner/repo',1);
 expect(first).toMatchObject({state:'waiting_for_worker',send:false,reason:expect.stringContaining('backoff')});expect(f.recovery.row(f.job)).toBeUndefined();expect(f.sends()).toBe(0);
 const status=new RecoveryObservation(f.s).status(f.job);expect(status).toMatchObject({failures:1,evidence:{provider:'github',classification:'server'}});
 let reads=0;const counted=async()=>{reads++;return f.io.facts(f.job,f.config);};
 expect((await new ConflictRecovery(f.s,{...f.io,facts:counted} as any).tick(f.job,f.config,'owner/repo',1)).state).toBe('waiting_for_worker');
 expect(reads).toBe(0);expect(f.recovery.row(f.job)).toBeUndefined();
 fail=false;setSystemTime(new Date(status.next_read+1));
 expect((await new ConflictRecovery(f.s,{...f.io,facts:counted} as any).tick(f.job,f.config,'owner/repo',1))?.stage).toBe('resolving');
 expect(f.sends()).toBe(1);expect(f.s.get(f.job).attempts).toBe(1);
 }finally{setSystemTime();f.close();}
},60000);
test('shared provider cooldown defers an unreserved conflict tick without provider reads',async()=>{
 const f=await fixture();let reads=0;
 const unavailable=async()=>{reads++;throw Error('Provider read attempted during shared cooldown');};
 const gated={...f.io,facts:unavailable,snapshot:unavailable,evidence:unavailable};
 try{
 new RecoveryObservation(f.s).failed('other-job',readFailure('github','branch-read','HTTP 429\nRetry-After: 60\n',1));
 const result=await new ConflictRecovery(f.s,gated as any).tick(f.job,f.config,'owner/repo',1);
 expect(result).toMatchObject({state:'waiting_for_worker',send:false});expect(result.reason).toContain('deferred until');
 expect(reads).toBe(0);expect(f.recovery.row(f.job)).toBeUndefined();expect(f.sends()).toBe(0);
 }finally{f.close();}
},60000);
async function reservedWithReadFailure(f:any){
 let reads=0;const snapshot=async()=>{if(++reads===3)throw readFailure('github','branch-read','HTTP 503',1);return f.io.snapshot();};
 await new ConflictRecovery(f.s,{...f.io,snapshot} as any).tick(f.job,f.config,'owner/repo',1);
 return snapshot;
}
const mutating=(commands:string[][])=>commands.filter(a=>a[0]==='git'&&['fetch','merge','update-ref','commit','push'].includes(a[1]));
test('DEV-103/DEV-67 host-ready text-only handoff publishes once across repeated polls',async()=>{
 const f=await fixture();try{
  let prompt='';const io={...f.io,send:async(s:string,p:string,id:string)=>{prompt=p;return f.io.send(s,p,id);}};
  const r=new ConflictRecovery(f.s,io as any);
  await r.tick(f.job,f.config,'owner/repo',1);
  expect(prompt).toContain('host-ready');expect(prompt).toContain('not uncertainty');
  f.resolve();expect(await r.tick(f.job,f.config,'owner/repo',1)).toBeNull();
  const before=f.commands.length;
  // A completed recovery is observed by the normal review loop with fresh branch facts.
  const settled={...io,snapshot:async()=>({...await f.io.snapshot(),mergeable:true,behind:0})};
  for(let n=0;n<3;n++)await expect(new ConflictRecovery(f.s,settled as any).tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('Confirmed base conflict required');
  expect(mutating(f.commands.slice(before))).toHaveLength(0);expect(f.sends()).toBe(1);
  expect(f.commands.filter(a=>a[1]==='push'&&a[2]==='origin'&&a[3]?.includes(':refs/heads/'))).toHaveLength(1);
 }finally{f.close();}
},60000);
test('DEV-103 missing, uncertain, malformed and non-authoritative handoffs never stage or publish',async()=>{
 for(const kind of ['missing','uncertain','malformed','duplicate','wrong-origin','wrong-turn','streaming','later-message','questions']){
  const f=await fixture();try{
   await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();const message=f.e.transcript.entries.at(-1);
   if(kind==='missing')message.text='Resolved files; host work remains';
   if(kind==='uncertain')message.text='<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"uncertain","reason":"Resolution semantics are uncertain"} -->';
   if(kind==='malformed')message.text='<!-- ADLC_WORKER_STATUS {bad json} -->';
   if(kind==='duplicate')message.text+='\n'+message.text;
   if(kind==='wrong-origin')message.origin='user';
   if(kind==='wrong-turn')message.turnId='other';
   if(kind==='streaming')message.streaming=true;
   if(kind==='later-message')f.e.transcript.entries.push({...message,text:'Actually not ready'});
   if(kind==='questions')message.text='<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"host-ready","reason":"Resolved","questions":[{"id":"q1","question":"Which behavior?","kind":"requirement"}]} -->';
   const before=f.commands.length;
   for(let n=0;n<3;n++)expect((await new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1))?.state).toBe('blocked');
   expect(f.commands.slice(before).some(a=>['add','commit','push'].includes(a[1]))).toBe(false);
   expect(f.sends()).toBe(1);expect(f.recovery.row(f.job).state).toBe('resolving');
  }finally{f.close();}
 }
},60000);
test('DEV-103 verification tool state uses private temporary home and preserves strict cleanliness',async()=>{
 for(const dirty of [false,true]){
  const f=await fixture();try{
   f.config.conflictRecovery.verification=[[process.execPath,'-e',`const fs=require('fs'),path=require('path');const state=process.env.XDG_STATE_HOME||path.join(process.env.HOME||'.','.local/state');fs.mkdirSync(path.join(state,'gh'),{recursive:true});fs.writeFileSync(path.join(state,'gh/device-id'),'fixture');console.log(process.env.HOME);${dirty?"fs.writeFileSync('unexpected-state','keep me');":''}`]];
   await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
   const result=await f.recovery.tick(f.job,f.config,'owner/repo',1);
   expect(dirty?result?.state:result).toBe(dirty?'blocked':null);
   const home=JSON.parse(f.recovery.row(f.job).detail).verification[0].stdout.trim();
   expect(home.startsWith(f.tree+'/')).toBe(false);expect(existsSync(home)).toBe(false);
   expect(existsSync(join(f.tree,'.local/state/gh/device-id'))).toBe(false);
   expect(existsSync(join(f.tree,'unexpected-state'))).toBe(dirty);
  }finally{f.close();}
 }
},60000);
test('reserved conflict recovery blocks a permanent provider failure without Git mutations',async()=>{
 const f=await fixture();try{
 const snapshot=await reservedWithReadFailure(f);expect(f.recovery.row(f.job)).toMatchObject({state:'reserved',reason:null});
 const mark=f.commands.length,before=new RecoveryObservation(f.s).status(f.job);setSystemTime(new Date(before.next_read+1));
 const facts=async()=>{throw readFailure('github','recovery-facts','HTTP 401',1);};
 const result=await new ConflictRecovery(f.s,{...f.io,snapshot,facts} as any).tick(f.job,f.config,'owner/repo',1);
 expect(result?.state).toBe('blocked');expect(result?.reason).toContain('authentication');
 expect(f.sends()).toBe(0);expect(mutating(f.commands.slice(mark))).toHaveLength(0);
 const after=new RecoveryObservation(f.s).status(f.job);expect(after.failures).toBe(before.failures+1);expect(after.evidence.classification).toBe('authentication');
 expect(f.recovery.row(f.job)).toMatchObject({state:'reserved',reason:null});
 }finally{setSystemTime();f.close();}
},60000);
test('reserved conflict recovery keeps an untyped facts failure terminal without an observation',async()=>{
 const f=await fixture();try{
 const snapshot=await reservedWithReadFailure(f);
 const mark=f.commands.length,before=new RecoveryObservation(f.s).status(f.job);setSystemTime(new Date(before.next_read+1));
 const facts=async()=>{throw Error('Untyped facts failure');};
 const result=await new ConflictRecovery(f.s,{...f.io,snapshot,facts} as any).tick(f.job,f.config,'owner/repo',1);
 expect(result?.state).toBe('blocked');expect(result?.reason).toContain('Untyped facts failure');
 expect(f.recovery.row(f.job).reason).toContain('Untyped facts failure');
 const after=new RecoveryObservation(f.s).status(f.job);expect(after.failures).toBe(before.failures);expect(after.evidence).toEqual(before.evidence);
 expect(f.sends()).toBe(0);expect(mutating(f.commands.slice(mark))).toHaveLength(0);
 }finally{setSystemTime();f.close();}
},60000);
test('reserved conflict recovery defers a shared cooldown without recording a failure',async()=>{
 const f=await fixture();try{
 const snapshot=await reservedWithReadFailure(f);
 const status=new RecoveryObservation(f.s).status(f.job);setSystemTime(new Date(status.next_read+1));
 new RecoveryObservation(f.s).failed('other-job',readFailure('github','branch-read','HTTP 429\nRetry-After: 600\n',1));
 const mark=f.commands.length;
 const result=await new ConflictRecovery(f.s,{...f.io,snapshot} as any).tick(f.job,f.config,'owner/repo',1);
 expect(result).toMatchObject({state:'waiting_for_worker',send:false});expect(result.reason).toContain('deferred until');
 const after=new RecoveryObservation(f.s).status(f.job);expect(after.failures).toBe(status.failures);expect(after.evidence).toEqual(status.evidence);
 expect(f.recovery.row(f.job)).toMatchObject({state:'reserved',reason:null});
 expect(f.sends()).toBe(0);expect(mutating(f.commands.slice(mark))).toHaveLength(0);
 }finally{setSystemTime();f.close();}
},60000);
test('reserved manual preview is read-only and guards retain observation history',async()=>{
 const f=await fixture();let reads=0;let reader:Store|undefined;
 try{
 const snapshot=async()=>{if(++reads===3)throw readFailure('github','branch-read','HTTP 503',1);return f.io.snapshot();};
 await new ConflictRecovery(f.s,{...f.io,snapshot} as any).tick(f.job,f.config,'owner/repo',1);
 const row=f.recovery.row(f.job);expect(row.state).toBe('reserved');
 const before=f.s.db.query('SELECT * FROM recovery_observations WHERE job=?').get(f.job);
 const events=f.s.db.query('SELECT count(*) AS n FROM events').get();
 reader=Store.readonly(join(f.dir,'state.sqlite'));
 const preview=new ConflictRecovery(reader,f.io as any);
 await expect(preview.manualPreview(f.job,f.config)).rejects.toThrow('recorded conflict index required');
 expect(f.s.db.query('SELECT * FROM recovery_observations WHERE job=?').get(f.job)).toEqual(before);
 expect(f.s.db.query('SELECT count(*) AS n FROM events').get()).toEqual(events);
 setSystemTime(new Date((before as any).next_read+1));
 await f.recovery.guard(row,f.config);
 expect(f.s.db.query('SELECT * FROM recovery_observations WHERE job=?').get(f.job)).toEqual(before);
 expect(f.recovery.row(f.job)).toEqual(row);expect(f.sends()).toBe(0);
 }finally{setSystemTime();reader?.close();f.close();}
},60000);
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
},60000);
test('DEV-50 operator merge settles stale Git conflict but retains missing resolution receipt independently',async()=>{
 const f=await fixture();try{
  f.lose();await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  await f.git(f.tree,'add','app.txt');await f.git(f.tree,'commit','-m','Operator resolved merge');await f.git(f.tree,'push','origin',`HEAD:refs/heads/${f.branch}`);
  f.e.transcript.entries=[];f.e.transcript.turns=[];
  const before=JSON.stringify(f.recovery.row(f.job)),attempts=f.s.get(f.job).attempts;
  const preview=await f.recovery.publishedPreview(f.job,f.config,'merge','Patrick');
  expect(preview.evidence.message).toBe('uncertain');expect(JSON.stringify(f.recovery.row(f.job))).toBe(before);
  const result=await f.recovery.publishedConfirm(f.job,f.config,'merge','Patrick',preview.confirmation);
  expect(result.message).toBe('uncertain');expect(f.recovery.row(f.job).state).toBe('completed');
  expect((f.s.db.query('SELECT state FROM remediation').get() as any).state).toBe('delivery_uncertain');
  expect(f.s.get(f.job).attempts).toBe(attempts);expect(f.sends()).toBe(1);
  expect(worktreeReservation(f.s,f.job)).toBeFalsy();
  expect((f.s.db.query('SELECT state FROM review_targets').get() as any).state).toBe('waiting_for_ci');
  expect((await f.recovery.publishedConfirm(f.job,f.config,'merge','Patrick',preview.confirmation)).reused).toBe(true);
 }finally{f.close();}
},60000);
test('publication confirmation rejects remote/base changes and revoked approval after verification',async()=>{
 for(const change of ['head','base','approval']){
  const f=await fixture();try{
   f.lose();await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
   await f.git(f.tree,'add','app.txt');await f.git(f.tree,'commit','-m','Operator repair');await f.git(f.tree,'push','origin',`HEAD:refs/heads/${f.branch}`);
   const preview=await f.recovery.publishedPreview(f.job,f.config,'merge','human');
   const before=f.recovery.row(f.job),review=f.s.db.query('SELECT * FROM review_targets').get();
   const io={...f.io,verify:async()=>{
    if(change==='approval')f.s.db.query("UPDATE jobs SET approved_hash=NULL WHERE id=?").run(f.job);
    else{const tree=change==='base'?f.source:f.tree;await f.git(tree,'commit','--allow-empty','-m','Concurrent change');await f.git(tree,'push','origin',change==='base'?'main':`HEAD:refs/heads/${f.branch}`);}
    return {code:0,out:'ok',err:''};
   }};
   const expected={head:'Evidence changed during verification',base:'Required old/current base not included',approval:'Current unchanged execution approval'};
   await expect(new ConflictRecovery(f.s,io as any).publishedConfirm(f.job,f.config,'merge','human',preview.confirmation)).rejects.toThrow(expected[change]);
   expect(f.recovery.row(f.job)).toEqual(before);expect(f.s.db.query('SELECT * FROM review_targets').get()).toEqual(review);expect(f.sends()).toBe(1);
  }finally{f.close();}
 }
},60000);
test('DEV-16 separately authorized equivalent rebase settles uncertain Git update without new force authority',async()=>{
 const f=await fixture();try{
  const old=(await f.io.snapshot()).head;
  writeFileSync(join(f.source,'app.txt'),'feature=old\nsafety=old\n');await f.git(f.source,'add','.');await f.git(f.source,'commit','-m','Base separate safeguard');await f.git(f.source,'push','origin','main');
  const base=(await f.io.snapshot()).base;
  // Simulate a previously published operator rewrite with commit-tree/ref CAS.
  // No rebase, reset, or force-push is run by production or this test.
  await f.git(f.tree,'merge','--no-ff','-m','Operator merge',base);
  const tree=await f.git(f.tree,'rev-parse','HEAD^{tree}'),merged=await f.git(f.tree,'rev-parse','HEAD');
  const rewritten=await f.git(f.tree,'commit-tree',tree,'-p',base,'-m','Feature');
  await f.git(f.tree,'update-ref',`refs/heads/${f.branch}`,rewritten,merged);
  await f.git(f.remote,'fetch','--no-tags',f.tree,rewritten);
  await f.git(f.remote,'update-ref',`refs/heads/${f.branch}`,rewritten,old);
  new BranchUpdates(f.s);f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.job,old,base,'delivery_uncertain',1,'lost update');
  f.config.conflictRecovery.verification=[[process.execPath,'-e','process.exit(0)']];
  f.s.db.query("UPDATE review_targets SET state='blocked',reason='Security review is still required' WHERE job=?").run(f.job);
  await expect(f.recovery.publishedPreview(f.job,f.config,'merge','Patrick')).rejects.toThrow('rewritten');
  const preview=await f.recovery.publishedPreview(f.job,f.config,'authorized-rebase','Patrick');
  expect(preview.evidence.proofs[0].descendant).toBe(false);
  const before=f.s.get(f.job).attempts;
  await f.recovery.publishedConfirm(f.job,f.config,'authorized-rebase','Patrick',preview.confirmation);
  expect((f.s.db.query('SELECT state FROM branch_updates').get() as any).state).toBe('observed');
  expect(f.s.get(f.job).attempts).toBe(before);expect(f.sends()).toBe(0);
  expect((f.s.db.query('SELECT reason FROM review_targets').get() as any).reason).toContain('Security');
  expect((f.s.db.query('SELECT operations FROM git_grants').get() as any).operations).not.toContain('force');
 }finally{f.close();}
},60000);
test('operator merge supersedes an observation-only stale conflict without inventing an absent old head',async()=>{
 const f=await fixture();try{
  const old=(await f.io.snapshot()).head,base=(await f.io.snapshot()).base;
  await f.io.command(['git','merge','--no-ff','--no-commit',base],f.tree);f.resolve();
  await f.git(f.tree,'add','app.txt');await f.git(f.tree,'commit','-m','Operator merge');await f.git(f.tree,'push','origin',`HEAD:refs/heads/${f.branch}`);
  f.s.db.query("UPDATE review_targets SET state='blocked',reason='Feature branch has conflicts with base; human reconciliation required',head=NULL").run();
  await expect(f.recovery.publishedPreview(f.job,f.config,'merge','human')).rejects.toThrow('No superseded');
  f.s.db.query('UPDATE review_targets SET head=?').run(old);
  const preview=await f.recovery.publishedPreview(f.job,f.config,'merge','human');
  await f.recovery.publishedConfirm(f.job,f.config,'merge','human',preview.confirmation);
  expect((f.s.db.query('SELECT state FROM review_targets').get() as any).state).toBe('waiting_for_ci');expect(f.sends()).toBe(0);expect(f.s.get(f.job).attempts).toBe(0);
 }finally{f.close();}
},60000);
test('publication proof rejects detached/dirty/unpublished work, lifecycle and identity drift',async()=>{
 for(const kind of ['dirty','unpublished','closed','retargeted','fork','owner']){
  const f=await fixture();try{
   f.lose();await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
   await f.git(f.tree,'add','app.txt');await f.git(f.tree,'commit','-m','Repair');await f.git(f.tree,'push','origin',`HEAD:refs/heads/${f.branch}`);
   if(kind==='dirty')writeFileSync(join(f.tree,'extra'),'keep me');
   if(kind==='unpublished')await f.git(f.tree,'commit','--allow-empty','-m','Unpublished');
   if(kind==='owner')f.setOwners(['worker','another']);
   const io={...f.io,snapshot:async()=>({...await f.io.snapshot(),...kind==='closed'?{state:'closed'}:kind==='retargeted'?{baseBranch:'other'}:kind==='fork'?{headRepo:'fork/repo'}:{}})};
   const before=f.recovery.row(f.job),review=f.s.db.query('SELECT * FROM review_targets').get();
   const expected={dirty:'Dirty, unpublished or divergent local work',unpublished:'Dirty, unpublished or divergent local work',closed:'Target is not the owned open feature PR',retargeted:'Owned isolated delivery repository/base/worktree evidence mismatch',fork:'Target is not the owned open feature PR',owner:'Owned isolated delivery repository/base/worktree evidence mismatch'};
   await expect(new ConflictRecovery(f.s,io as any).publishedPreview(f.job,f.config,'merge','human')).rejects.toThrow(expected[kind]);
   expect(f.recovery.row(f.job)).toEqual(before);expect(f.s.db.query('SELECT * FROM review_targets').get()).toEqual(review);
  }finally{f.close();}
 }
},60000);
test('quoted Unicode conflict paths keep raw index identities through resolution and push',async()=>{
 const filename='café".md',f=await fixture(filename);try{
  await f.git(f.tree,'config','core.quotepath','true');
  expect((await f.recovery.tick(f.job,f.config,'owner/repo',1))?.stage).toBe('resolving');
  expect(JSON.parse(f.recovery.row(f.job).detail).conflicts).toEqual([filename]);
  f.resolve();expect(await f.recovery.tick(f.job,f.config,'owner/repo',1)).toBeNull();
  expect(readFileSync(join(f.tree,filename),'utf8')).toBe('feature=new\nsafety=new\n');
 }finally{f.close();}
},60000);
test('publication scope checks both source deletion and destination of a rename',async()=>{
 const f=await fixture();try{
  f.s.db.query('UPDATE implementation_dispatch SET paths=?').run(JSON.stringify(['app.txt','moved.txt']));
  f.lose();await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  await f.git(f.tree,'add','app.txt');await f.git(f.tree,'commit','-m','Operator merge');
  await f.git(f.tree,'config','diff.renames','true');await f.git(f.tree,'mv','safeguard.txt','moved.txt');await f.git(f.tree,'commit','-m','Rename outside scope');
  await f.git(f.tree,'push','origin',`HEAD:refs/heads/${f.branch}`);
  const b=await f.io.snapshot(),shown=await f.git(f.tree,'diff','--name-only',`${b.base}...${b.head}`);
  expect(shown).toContain('moved.txt');expect(shown).not.toContain('safeguard.txt');
  const before=f.recovery.row(f.job),review=f.s.db.query('SELECT * FROM review_targets').get();
  await expect(f.recovery.publishedPreview(f.job,f.config,'merge','human')).rejects.toThrow('safeguard.txt');
  expect(f.recovery.row(f.job)).toEqual(before);expect(f.s.db.query('SELECT * FROM review_targets').get()).toEqual(review);
 }finally{f.close();}
},60000);
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
},60000);
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
},60000);
test('durable database restart keeps missing-receipt reservation and does not replay',async()=>{
 const f=await fixture();try{
  f.lose();await f.recovery.tick(f.job,f.config,'owner/repo',1);
  const reopened=new Store(join(f.dir,'state.sqlite'));
  try{const r=new ConflictRecovery(reopened,f.io as any);await r.tick(f.job,f.config,'owner/repo',1);expect(r.row(f.job).state).toBe('resolving');expect(f.sends()).toBe(1);}finally{reopened.close();}
 }finally{f.close();}
},60000);
test('existing grants do not acquire merge authority; disabled and malformed policy refuse recovery',async()=>{
 const f=await fixture();try{
  f.l.grantGit(f.job,f.plan,featureGit,'human');await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('merge-base-feature');expect(f.s.get(f.job).attempts).toBe(0);
  expect(()=>validateConflictPolicy({...f.config.conflictRecovery,version:2})).toThrow();expect(()=>validateConflictPolicy({...f.config.conflictRecovery,verification:[]})).toThrow();
  await expect(f.recovery.tick(f.job,{...f.config,conflictRecovery:undefined},'owner/repo',1)).rejects.toThrow('enabled');
 }finally{f.close();}
},60000);
test('explicit base merge grant rejects missing/stale/unapproved jobs and preserves existing operations with named actor',async()=>{
 const f=await fixture();try{
  f.l.grantGit(f.job,f.plan,featureGit,'original operator');
  const before=f.s.db.query('SELECT * FROM git_grants WHERE job=?').get(f.job);
  expect(()=>f.l.grantBaseMerge(f.job,'stale','new operator')).toThrow();
  expect(f.s.db.query('SELECT * FROM git_grants WHERE job=?').get(f.job)).toEqual(before);
  f.s.db.query("UPDATE jobs SET approved_hash='revoked' WHERE id=?").run(f.job);
  expect(()=>f.l.grantBaseMerge(f.job,f.plan,'new operator')).toThrow('approval');
  f.s.db.query('UPDATE jobs SET approved_hash=? WHERE id=?').run(f.plan,f.job);
  expect(f.l.grantBaseMerge(f.job,f.plan,'new operator')).toMatchObject({mergePR:false,policyStillRequired:true});
  const grant=f.s.db.query('SELECT * FROM git_grants WHERE job=?').get(f.job) as any;
  expect(JSON.parse(grant.operations)).toEqual([...featureGit,'merge-base-feature']);expect(grant.actor).toBe('new operator');
  expect(f.commands.some(a=>a.includes('merge'))).toBe(false);
  f.s.db.query('DELETE FROM git_grants WHERE job=?').run(f.job);
  expect(()=>f.l.grantBaseMerge(f.job,f.plan,'human')).toThrow('Existing current scoped');
 }finally{f.close();}
},60000);
test('recovery commands sanitize inherited Git repository context for commands and verification',async()=>{
 const f=await fixture();const keys=['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  for(const key of keys)process.env[key]='/nonexistent-wrong-context';
  expect((await recoveryCommand(['git','rev-parse','--show-toplevel'],f.tree)).out.trim()).toBe(f.tree);
  const result=await recoveryCommand([process.execPath,'-e',`console.log(JSON.stringify(${JSON.stringify(keys)}.map(k=>process.env[k]??null)))`],f.tree);
  expect(JSON.parse(result.out)).toEqual(keys.map(()=>null));
 }finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}f.close();}
},60000);
test('marker inspection detects diff3 base and CRLF separators in literal conflict paths only',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);const r=f.recovery.row(f.job),d=JSON.parse(r.detail);
  for(const content of ['||||||| base\n','=======\r\n','<<<<<<< ours\n','>>>>>>> theirs\n']){
   writeFileSync(join(f.tree,'app.txt'),content);await f.git(f.tree,'add','app.txt');
   await expect(f.recovery.assertResolved(r,d)).rejects.toThrow();
  }
  writeFileSync(join(f.tree,'app.txt'),'resolved\n');await f.git(f.tree,'add','app.txt');
  writeFileSync(join(f.tree,'literal[1].txt'),'||||||| base\n');await f.git(f.tree,'add','literal[1].txt');
  const index=await f.recovery.index(r);
  await f.recovery.assertResolved(r,{...d,index,conflicts:['app.txt']});
  await expect(f.recovery.assertResolved(r,{index,conflicts:['literal[1].txt']})).rejects.toThrow();
  await f.recovery.assertResolved(r,{index,conflicts:[]});
 }finally{f.close();}
},60000);
test('verification allowlist excludes host secrets in automatic and manual recovery',async()=>{
 const keys=['ADLC_LINEAR_TOKEN','GH_TOKEN','GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY','UNLISTED_SECRET','NODE_OPTIONS'];
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  for(const key of keys)process.env[key]='sentinel-host-secret';
  // NODE_OPTIONS must also be absent: do not allow inherited runtime injection.
   const argv=[process.execPath,'-e',`const allowed=${JSON.stringify(['PATH','TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ','CI','HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','GH_CONFIG_DIR'])};const bad=Object.keys(process.env).filter(k=>!allowed.includes(k));if(bad.length)process.exit(17);console.log('isolated')`];
  for(const mode of ['automatic','manual']){
   const f=await fixture();try{
    f.config.conflictRecovery.verification=[argv];
    await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
    if(mode==='automatic')expect(await f.recovery.tick(f.job,f.config,'owner/repo',1)).toBeNull();
    else{
     const io={...f.io,command:async(args:string[],cwd:string)=>{const result=await f.io.command(args,cwd);if(args.includes('commit')&&args[0]==='git')throw Error('Lost commit receipt');return result;}};
     await new ConflictRecovery(f.s,io as any).tick(f.job,f.config,'owner/repo',1);
     await f.git(f.tree,'push','origin',`HEAD:refs/heads/${f.branch}`);
     const preview=await f.recovery.manualPreview(f.job,f.config);
     expect((await f.recovery.manualConfirm(f.job,f.config,preview.confirmation,'human')).state).toBe('completed');
    }
    const evidence=JSON.parse(f.recovery.row(f.job).detail).verification[0];
    expect(evidence.code).toBe(0);expect(evidence.stdout.trim()).toBe('isolated');
   }finally{f.close();}
  }
  // Verification named `git` still uses the allowlist, not the Git-only runner.
  const f=await fixture();try{
   const result=await verificationCommand(['git','-c',`alias.probe=!${process.execPath} -e 'process.exit(process.env.ADLC_LINEAR_TOKEN?18:0)'`,'probe'],f.tree);
   expect(result.code).toBe(0);
   const gitOnly=await recoveryCommand([process.execPath,'-e',"console.log(process.env.ADLC_LINEAR_TOKEN)"],f.tree);
   expect(gitOnly.out.trim()).toBe('sentinel-host-secret');
  }finally{f.close();}
 }finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
},60000);
test('base-side trailing whitespace does not reject a valid merged index',async()=>{
 const f=await fixture();try{
  writeFileSync(join(f.source,'app.txt'),'feature=old\nsafety=new  \n');
  await f.git(f.source,'add','app.txt');await f.git(f.source,'commit','-m','Base safety whitespace');await f.git(f.source,'push','origin','main');
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  writeFileSync(join(f.tree,'app.txt'),'feature=new\nsafety=new  \n');await f.git(f.tree,'add','app.txt');
  const r=f.recovery.row(f.job),d=JSON.parse(r.detail);
  expect(d.conflicts).toContain('app.txt');
  expect((await f.io.command(['git','diff','--cached','--check','--','app.txt'],f.tree)).code).not.toBe(0);
  await f.recovery.assertResolved(r,d);
 }finally{f.close();}
},60000);
test('post-commit validation failure retains exact merge SHA in recovery detail',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  const io={...f.io,command:async(args:string[],cwd:string)=>args.includes('--format=%P')?{code:1,out:'',err:'validation unavailable'}:f.io.command(args,cwd)};
  await new ConflictRecovery(f.s,io as any).tick(f.job,f.config,'owner/repo',1);
  expect(JSON.parse(f.recovery.row(f.job).detail).result).toBe(await f.git(f.tree,'rev-parse','HEAD'));
 }finally{f.close();}
},60000);
test('dirty, divergent, competing-owner, stale approval and pre-existing merge refuse before reservation',async()=>{
 const f=await fixture();try{
  f.setOwners(['worker','other']);await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('mismatch');f.setOwners(['worker']);
  writeFileSync(join(f.tree,'extra'),'dirty');await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('Dirty');rmSync(join(f.tree,'extra'));
  await f.git(f.tree,'commit','--allow-empty','-m','Unpublished');await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('divergent');
  f.s.db.query("UPDATE jobs SET approved_hash='stale' WHERE id=?").run(f.job);await expect(f.recovery.tick(f.job,f.config,'owner/repo',1)).rejects.toThrow('approval');expect(f.s.get(f.job).attempts).toBe(0);
 }finally{f.close();}
},60000);
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
},60000);
test('simultaneous polls reserve one intent and send once',async()=>{
 const f=await fixture();try{
  await Promise.allSettled([f.recovery.tick(f.job,f.config,'owner/repo',1),new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1)]);
  expect(f.sends()).toBe(1);expect(f.s.get(f.job).attempts).toBe(1);expect((f.s.db.query('SELECT count(*) AS n FROM conflict_recoveries').get() as any).n).toBe(1);
 }finally{f.close();}
},60000);
test('out-of-scope conflict preserves merge evidence and never sends or publishes',async()=>{
 const f=await fixture();try{
  f.s.db.query('UPDATE implementation_dispatch SET paths=? WHERE job=?').run(JSON.stringify(['other.txt']),f.job);
  const r=await f.recovery.tick(f.job,f.config,'owner/repo',1);expect(r?.reason).toContain('app.txt');expect(f.sends()).toBe(0);expect(await f.git(f.tree,'rev-parse','MERGE_HEAD')).toBe(f.recovery.row(f.job).base);
 }finally{f.close();}
},60000);
test('base changes before publication stop without rewriting or dropping merged work',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();await f.git(f.source,'commit','--allow-empty','-m','Concurrent base');await f.git(f.source,'push','origin','main');
  expect((await f.recovery.tick(f.job,f.config,'owner/repo',1))?.reason).toContain('changed');expect(f.sends()).toBe(1);
  expect(await f.git(f.tree,'rev-parse','MERGE_HEAD')).toBe(f.recovery.row(f.job).base);
 }finally{f.close();}
},60000);
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
},60000);
test('lost successful push response reconciles on restart without a second push',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  const io={...f.io,command:async(args:string[],cwd:string)=>{const result=await f.io.command(args,cwd);if(args[0]==='git'&&args[1]==='push')throw Error('Lost push response');return result;}};
  expect((await new ConflictRecovery(f.s,io as any).tick(f.job,f.config,'owner/repo',1))?.stage).toBe('pushing');
  const count=f.commands.filter(a=>a[1]==='push').length;
  expect(await new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1)).toBeNull();expect(f.commands.filter(a=>a[1]==='push').length).toBe(count);
  expect(f.recovery.row(f.job).state).toBe('completed');
 }finally{f.close();}
},60000);
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
},60000);
test('verification is fail-fast and never publishes a failed merged tree',async()=>{
 const f=await fixture();try{
  f.config.conflictRecovery.verification=[[process.execPath,'-e','process.exit(3)'],[process.execPath,'-e',"throw Error('must not run')"]];
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();const before=await f.git(f.remote,'rev-parse',`refs/heads/${f.branch}`);
  expect((await f.recovery.tick(f.job,f.config,'owner/repo',1))?.reason).toContain('Verification failed');expect(await f.git(f.remote,'rev-parse',`refs/heads/${f.branch}`)).toBe(before);
  expect(JSON.parse(f.recovery.row(f.job).detail).verification.length).toBe(1);
  expect(f.recovery.row(f.job).reason).not.toContain('process.exit');
  expect(f.recovery.row(f.job).reason).toContain('(3)');
  await new ConflictRecovery(f.s,f.io as any).tick(f.job,f.config,'owner/repo',1);expect(JSON.parse(f.recovery.row(f.job).detail).verification.length).toBe(1);
 }finally{f.close();}
},60000);
test('completion rechecks authorization and keeps the reservation when grants were revoked',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  const io={...f.io,command:async(args:string[],cwd:string)=>{const result=await f.io.command(args,cwd);if(args[0]==='git'&&args[1]==='push')throw Error('Lost push response');return result;}};
  await new ConflictRecovery(f.s,io as any).tick(f.job,f.config,'owner/repo',1);
  const r=f.recovery.row(f.job),d=JSON.parse(r.detail);
  expect(r.state).toBe('pushing');
  f.s.db.query('DELETE FROM git_grants WHERE job=?').run(f.job);
  expect(()=>f.recovery.complete(r,d,f.config)).toThrow('Current');
  expect(f.recovery.row(f.job).state).toBe('pushing');
  expect(JSON.parse(f.recovery.row(f.job).detail).result).toBe(d.result);
 }finally{f.close();}
},60000);
test('manual reconciliation cannot release a reservation revoked before completion',async()=>{
 const f=await fixture();try{
  await f.recovery.tick(f.job,f.config,'owner/repo',1);f.resolve();
  const io={...f.io,command:async(args:string[],cwd:string)=>{const result=await f.io.command(args,cwd);if(args.includes('commit')&&args[0]==='git')throw Error('Lost commit receipt');return result;}};
  await new ConflictRecovery(f.s,io as any).tick(f.job,f.config,'owner/repo',1);
  await f.git(f.tree,'push','origin',`HEAD:refs/heads/${f.branch}`);
  const preview=await f.recovery.manualPreview(f.job,f.config);
  const revoke={...f.io,command:async(args:string[],cwd:string)=>{const result=await f.io.command(args,cwd);if(args[0]==='git'&&args[1]==='write-tree')f.s.db.query('DELETE FROM git_grants WHERE job=?').run(f.job);return result;}};
  await expect(new ConflictRecovery(f.s,revoke as any).manualConfirm(f.job,f.config,preview.confirmation,'human')).rejects.toThrow('Current');
  expect(f.recovery.row(f.job).state).toBe('manual_verifying');
  expect(f.recovery.row(f.job).reason).toContain('Current');
 }finally{f.close();}
},60000);
test('remediation rechecks worktree reservation inside submission fence before routing or delivery',async()=>{
 const f=await fixture();try{
  const head=(await f.io.snapshot()).head;
  let sends=0;
  await expect(sendPilotRemediation(f.s,f.job,head,'[]','owner/repo',1,['CI'],undefined,[],{
   sessionEvidence:f.io.evidence as any,readBranchSnapshot:f.io.snapshot as any,
   worktreeIdentity:async()=>({tree:f.tree,branch:f.branch,head}),
   readiness:async()=>({head,clear:false,reasons:[]}) as any,
   submit:async fn=>{await f.recovery.tick(f.job,f.config,'owner/repo',1);return fn();},
   spawn:(()=>{sends++;throw Error('must not send');}) as any
  })).rejects.toThrow('reserved');
  expect(sends).toBe(0);expect(f.s.get(f.job).attempts).toBe(1);
 }finally{f.close();}
},60000);

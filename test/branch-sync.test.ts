import {test,expect,spyOn} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
import {recordReadiness} from '../src/readiness';
import {BranchUpdates,branchUpdateBinding,branchTransport,type BranchSnapshot} from '../src/branch-updates';
import {BranchSync,MAX_SYNC_MERGES} from '../src/branch-sync';
import {ReviewLoop} from '../src/review-loop';
import {command} from '../src/delivery-evidence';
import {turnBarrier} from '../src/turn-submission';
import {worktreeReservation,assertWorktreeAvailable,branchSyncRows} from '../src/worktree-reservation';

function fixture(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'adlc-branch-sync-'))),repo=join(dir,'repo'),tree=join(dir,'tree'),remote=join(dir,'remote.git');
 const git=(args:string[],cwd=repo)=>{const p=Bun.spawnSync(['git',...args],{cwd,env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.com'}});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString().trim();};
 git(['init','-b','main',repo],dir);writeFileSync(join(repo,'initial'),'initial');git(['add','.']);git(['commit','-m','initial']);
 git(['checkout','-b','producer']);writeFileSync(join(repo,'feature'),'feature');git(['add','.']);git(['commit','-m','feature']);const old=git(['rev-parse','HEAD']);
 git(['checkout','main']);writeFileSync(join(repo,'base'),'base');git(['add','.']);git(['commit','-m','base']);const base=git(['rev-parse','HEAD']);
 git(['checkout','producer']);git(['merge','--no-ff','main','-m','Update branch']);const target=git(['rev-parse','HEAD']);git(['checkout','main']);
 const s=new Store(join(dir,'state.db')),w=new Workflow(s,{} as any),id=s.enqueue('project','issue','spec'),p=new Planning(s),r=p.reserve(id,'ao');
 git(['branch',r.branch,old]);git(['worktree','add',tree,r.branch]);git(['clone','--bare',repo,remote]);git(['--git-dir',remote,'update-ref',`refs/heads/${r.branch}`,target]);git(['remote','add','origin',remote]);
 p.gate(id,'ao','worker',r.branch,tree);const hash=s.propose(id,'plan');recordReadiness(s,id,'plan\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->',hash,digest('spec'));
 s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);s.db.query('INSERT INTO planning_dispatch VALUES (?,?,?,?,?,?)').run(id,r.spec_hash,'awaiting_approval','worker',null,'message');
 w.approve(id,hash,'human',['src/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);new Lifecycle(s).adoptSupervised(id,{id:'worker',correlation:r.correlation,worktree:tree,controller:'running'});
 const c={linear:{projectId:'project'},githubRepo:'owner/repo'};
 let b:BranchSnapshot={head:target,base,branch:r.branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:true,behind:0};
 const transport={read:async()=>({...b}),update:async()=>{},contains:async(_repo:string,ancestor:string,head:string)=>git(['merge-base',ancestor,head])===ancestor};
 new BranchUpdates(s,transport);s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(id,old,base,'accepted',Date.now(),null);
 let idle=true,owners=['worker'],fetches=0,updates=0,loseFetch=false,loseUpdate=false,onFetch=()=>{};
 const inspect=async()=>({session:'worker',project:'ao',reserved:r.branch,worktree:tree,branch:git(['branch','--show-current'],tree),head:git(['rev-parse','HEAD'],tree),anchor:old,clean:!git(['status','--porcelain','--untracked-files=all'],tree),isolated:true,lineage:true,idle,completed:true,owners,candidates:[{repo:'owner/repo',pr:7,url:'https://github.com/owner/repo/pull/7',branch:r.branch,head:b.head,baseBranch:'main',defaultBranch:'main',fork:false,state:'open',draft:false}]});
 const run=async(args:string[],cwd?:string)=>{
  const argv=args.map(x=>x==='https://github.com/owner/repo.git'?remote:x);
  if(args.includes('fetch')){fetches++;onFetch();const out=await command(argv,cwd);if(loseFetch){loseFetch=false;throw Error('Fetch response lost');}return out;}
  if(args.includes('merge')){updates++;const out=await command(argv,cwd);if(loseUpdate){loseUpdate=false;throw Error('Fast-forward response lost');}return out;}
  return command(argv,cwd);
 };
 const barrier=turnBarrier(join(dir,'barrier'));
 const sync=()=>new BranchSync(s,transport,run,inspect,barrier.submit);
 return {s,id,c,b,old,base,target,tree,repo,remote,git,sync,inspect,transport,run,barrier,db:join(dir,'state.db'),setIdle:(v:boolean)=>idle=v,setOwners:(v:string[])=>owners=v,loseFetch:()=>loseFetch=true,loseUpdate:()=>loseUpdate=true,onFetch:(fn:()=>void)=>onFetch=fn,fetches:()=>fetches,updates:()=>updates,close:()=>{s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('exact ADLC merge fast-forwards the owned worktree once and completes both ledgers',async()=>{
 const f=fixture();try{
  new ReviewLoop(f.s);f.s.db.query('INSERT INTO custom_description_obligations VALUES (?,?)').run(f.id,'independent-body-blocker');
  f.s.db.query('INSERT INTO full_review_requests VALUES (?,?,?,?,?,?)').run(f.id,7,f.old,'body','delivery_uncertain',1);
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('updating_branch');
  expect(f.s.db.query('SELECT baseline_body_hash FROM custom_description_obligations').get()).toMatchObject({baseline_body_hash:'independent-body-blocker'});
  expect(f.s.db.query('SELECT state,head FROM full_review_requests').get()).toMatchObject({state:'delivery_uncertain',head:f.old});
  expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.target);expect(f.fetches()).toBe(1);expect(f.updates()).toBe(1);
  expect(f.s.db.query('SELECT state FROM branch_updates').get()).toMatchObject({state:'observed'});expect(worktreeReservation(f.s,f.id)).toBeUndefined();
  expect(await f.sync().ensure(f.id,f.c,'owner/repo',7)).toBeNull();expect(f.updates()).toBe(1);
 }finally{f.close();}
});
test('DEV-105: automatic polls maintain PR #56 despite stale review, base-only change, concurrency and restart',()=>{
 const home=mkdtempSync(join(tmpdir(),'adlc-maintenance-poll-'));
 try{
  const script=`
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store,digest} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
import {Workflow} from ${JSON.stringify(join(import.meta.dir,'../src/workflow.ts'))};
import {Planning} from ${JSON.stringify(join(import.meta.dir,'../src/planning.ts'))};
import {Lifecycle} from ${JSON.stringify(join(import.meta.dir,'../src/lifecycle.ts'))};
import {recordReadiness} from ${JSON.stringify(join(import.meta.dir,'../src/readiness.ts'))};
import {BranchUpdates,branchTransport} from ${JSON.stringify(join(import.meta.dir,'../src/branch-updates.ts'))};
import {BranchSync} from ${JSON.stringify(join(import.meta.dir,'../src/branch-sync.ts'))};
import {ReviewLoop} from ${JSON.stringify(join(import.meta.dir,'../src/review-loop.ts'))};
import {command} from ${JSON.stringify(join(import.meta.dir,'../src/delivery-evidence.ts'))};
import {turnBarrier} from ${JSON.stringify(join(import.meta.dir,'../src/turn-submission.ts'))};
import {createCLIPollTick} from ${JSON.stringify(join(import.meta.dir,'../src/cli.ts'))};
import {ActionWatchdog} from ${JSON.stringify(join(import.meta.dir,'../src/action-watchdog.ts'))};
${fixture.toString()}
const f=fixture();let now=Date.now(),requests=0,reviewReads=0;Date.now=()=>now;
const c={...f.c,branchUpdate:{enabled:true,authorizedBy:'human',maxUpdates:3}},blocker='PR head or description changed during custom-check collection';
f.s.db.exec('DELETE FROM branch_updates');f.b.head=f.old;f.b.behind=0;f.b.base=f.old;
// Provider adapter only: synchronization below still executes the real guarded Git path.
branchTransport.update=async()=>{requests++;f.b.head=f.target;f.b.behind=0;};
const original=BranchSync.prototype.ensure;BranchSync.prototype.ensure=function(...args){return original.apply(f.sync(),args);};
const io={readBranchSnapshot:f.transport.read,contains:f.transport.contains,worktreeIdentity:async()=>({tree:f.tree,branch:f.b.branch,head:f.git(['rev-parse','HEAD'],f.tree)}),sessionEvidence:async()=>({receiptObservation:{complete:true,observed:now},session:{id:'worker',projectId:'ao',branch:f.b.branch,isTerminated:false,prs:[{number:56,url:'https://github.com/owner/repo/pull/56'}]},transcript:{controller:'ready',entries:[],turns:[]}}),readiness:async()=>{reviewReads++;throw Error('Review should remain on its slow cadence');}};
// Match the recorded PR identity in the inspection fixture, without weakening its checks.
const inspect=f.inspect;f.inspect=async()=>{const facts=await inspect();facts.candidates[0].pr=56;facts.candidates[0].url='https://github.com/owner/repo/pull/56';return facts;};
f.sync=()=>new BranchSync(f.s,f.transport,f.run,f.inspect,f.barrier.submit);
let loop=new ReviewLoop(f.s,async()=>{throw Error('No review request');},io);loop.register(f.id,'owner/repo',56,['CI'],['src/**'],true);loop.record(f.id,{state:'blocked',head:f.old,reason:blocker});
const makeTick=()=>createCLIPollTick({config:c,store:f.s,reviewLoop:loop,workflow:{tick:async()=>[],implementation:()=>null},linearApprovals:{sync:async()=>[]},linearLifecycle:{sync:async()=>[]},features:{tickProject:async()=>[]},io:{poll:async()=>[],linearToken:()=>'',out:()=>{}}});
let tick=makeTick();await tick();if(requests!==0)throw Error('Unexpected update before base advances');
f.b.base=f.base;f.b.behind=2;now+=60000;const concurrent=await Promise.allSettled([tick(),tick()]);if(concurrent.filter(x=>x.status==='rejected').length!==1)throw Error('Expected concurrent poll fence rejection');
if(requests!==1)throw Error('Expected one guarded automatic update');
f.s=new Store(f.db);loop=new ReviewLoop(f.s,async()=>{throw Error('No review request');},io);tick=makeTick();await tick();now+=60000;await Promise.allSettled([tick(),tick()]);now+=60000;await tick();
if(f.git(['rev-parse','HEAD'],f.tree)!==f.target||f.updates()!==1||requests!==1||reviewReads!==0)throw Error('Automatic synchronization/deduplication failed');
if(loop.get(f.id).state!=='blocked'||loop.get(f.id).reason!==blocker)throw Error('Review blocker erased');
const status=loop.list()[0].maintenance;if(!status.schedule.next_check)throw Error('Missing maintenance cadence status');
// A genuine revoked inspect grant must stop even provider observation/mutation.
new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['push-feature'],'human');f.b.behind=2;now+=60000;await tick();
if(requests!==1||!loop.list()[0].maintenance.schedule.reason.includes('grant'))throw Error('Authorization guard bypassed');
console.log(JSON.stringify({requests,synchronizations:f.updates(),reviewReads}));f.s.close();f.close();`;
  const result=Bun.spawnSync([process.execPath,'-e',script],{env:{...process.env,HOME:home},stdout:'pipe',stderr:'pipe'});
  expect(result.stderr.toString()).toBe('');expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({requests:1,synchronizations:1,reviewReads:0});
 }finally{rmSync(home,{recursive:true,force:true});}
});
for(const lost of [false,true])test(`DEV-95 lifecycle: incomplete review survives update, synchronization and restart (lost response: ${lost})`,async()=>{
 const f=fixture(),blocker='CodeRabbit custom-check failure: pre-merge check table contains an unclassifiable row or missing status; obtain the complete supported bot summary';
 let requests=0,reads=0,evidenceHead=f.old;
 f.s.db.exec('DELETE FROM branch_updates');
 f.b.head=f.old;f.b.behind=1;
 const update=spyOn(branchTransport,'update').mockImplementation(async()=>{requests++;f.b.head=f.target;f.b.behind=0;if(lost)throw Error('Provider accepted update but response lost');});
 const original=BranchSync.prototype.ensure;
 const sync=spyOn(BranchSync.prototype,'ensure').mockImplementation(function(job,c,repo,pr){return original.call(f.sync(),job,c,repo,pr);});
 try{
  const session={receiptObservation:{complete:true,observed:Date.now()},session:{id:'worker',projectId:'ao',branch:f.b.branch,isTerminated:false,prs:[{number:7,url:'https://github.com/owner/repo/pull/7'}]},transcript:{controller:'ready',entries:[],turns:[]}};
  const io:any={readBranchSnapshot:f.transport.read,contains:f.transport.contains,worktreeIdentity:async()=>({tree:f.tree,branch:f.b.branch,head:f.git(['rev-parse','HEAD'],f.tree)}),sessionEvidence:async()=>({...session,receiptObservation:{complete:true,observed:Date.now()}}),readiness:async()=>{reads++;return {head:evidenceHead,clear:false,customCheckBlocker:blocker,reasons:[blocker],findings:[],failedChecks:[],pendingChecks:['CI'],missingChecks:[],coderabbitPending:true};}};
  let loop=new ReviewLoop(f.s,async()=>{throw Error('No review mutation');},io);loop.configureMetadataChecks('project',[]);loop.register(f.id,'owner/repo',7,['CI'],['src/**'],true);
  loop.record(f.id,{state:'blocked',head:f.old,reason:blocker});
  const policy={enabled:true,authorizedBy:'human',maxUpdates:3};
  expect((await loop.tick(f.id,policy,undefined,undefined,f.c)).state).toBe(lost?'blocked':'updating_branch');
  expect(requests).toBe(1);expect(reads).toBe(1);expect(loop.get(f.id).reason).toBe(blocker);
  // Restart evaluator, then run the real DEV-94 fast-forward path. Stale review
  // evidence for the predecessor cannot clear or bind to the resulting commit.
  loop=new ReviewLoop(f.s,async()=>{throw Error('No review mutation');},io);
  expect(await loop.tick(f.id,policy,undefined,undefined,f.c)).toMatchObject({state:'updating_branch',maintenance:{state:'completed'}});
  expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.target);expect(f.updates()).toBe(1);
  expect(loop.get(f.id)).toMatchObject({state:'blocked',reason:blocker});
  evidenceHead=f.target;
  expect((await loop.tick(f.id,policy,undefined,undefined,f.c)).state).toBe('blocked');
  expect(loop.get(f.id)).toMatchObject({state:'blocked',head:f.target,reason:blocker});
  expect(requests).toBe(1);expect(f.updates()).toBe(1);expect(reads).toBe(3);
 }finally{sync.mockRestore();update.mockRestore();f.close();}
});
test('synchronization keeps independent custom obligations and historical remediation evidence',async()=>{
 const f=fixture();try{
  new ReviewLoop(f.s);f.s.db.query('INSERT INTO custom_description_obligations VALUES (?,?)').run(f.id,'historical-body');
  f.s.db.query('INSERT INTO remediation VALUES (?,?,?,?,?)').run(f.id,f.old,'independent-finding',1,'completed');
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('updating_branch');
  expect(f.s.db.query('SELECT baseline_body_hash FROM custom_description_obligations').get()).toEqual({baseline_body_hash:'historical-body'});
  expect(f.s.db.query('SELECT head,state FROM remediation').get()).toEqual({head:f.old,state:'completed'});expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.close();}
});
test('active worker defers; dirty and locally committed trees are preserved',async()=>{
 const f=fixture();try{
  f.setIdle(false);expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('waiting_for_worker');expect(f.fetches()).toBe(0);f.setIdle(true);
  writeFileSync(join(f.tree,'local'),'local');expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('local edits');expect(f.fetches()).toBe(0);
  f.git(['add','.'],f.tree);f.git(['commit','-m','Local work'],f.tree);const local=f.git(['rev-parse','HEAD'],f.tree);
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('provenance');expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(local);
 }finally{f.close();}
});
for(const stage of ['fetch','update'])test(`restart reconciles lost ${stage} response without repeating fast-forward`,async()=>{
 const f=fixture();try{
  if(stage==='fetch')f.loseFetch();else f.loseUpdate();
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('blocked');expect(()=>assertWorktreeAvailable(f.s,f.id)).toThrow('reserved');
  const reopened=new Store(f.db);try{
   expect((await new BranchSync(reopened,f.transport,f.run,f.inspect,f.barrier.submit).ensure(f.id,f.c,'owner/repo',7))?.state).toBe('updating_branch');
  }finally{reopened.close();}
  expect(f.updates()).toBe(1);expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.target);
 }finally{f.close();}
});
test('request-time intent cannot be rebound to changed authorization',async()=>{
 const f=fixture();try{
  f.s.db.query('INSERT INTO branch_update_intents VALUES (?,?,?,?)').run(f.id,f.old,f.base,branchUpdateBinding(f.s,f.id,'owner/repo',7,f.b.branch));
  f.s.db.query("UPDATE git_grants SET actor='different authority' WHERE job=?").run(f.id);
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('Recorded branch update approval');expect(f.fetches()).toBe(0);expect(f.updates()).toBe(0);
 }finally{f.close();}
});
test('retained sync reservations fence worktree aliases and expose precise stage and reason',async()=>{
 const f=fixture();try{
  f.loseFetch();await f.sync().ensure(f.id,f.c,'owner/repo',7);
  expect(()=>assertWorktreeAvailable(f.s,'other-job',join(f.tree,'.'))).toThrow('branch synchronization');
  expect(branchSyncRows(f.s)[0]).toMatchObject({kind:'branch_sync',state:'fetching',reason:'Fetch response lost'});
 }finally{f.close();}
});
for(const change of ['base','head','approval','ownership'])test(`${change} race blocks before fast-forward`,async()=>{
 const f=fixture();try{
  f.onFetch(()=>{if(change==='base')f.b.base=f.old;if(change==='head')f.b.head=f.old;if(change==='approval')f.s.db.exec('DELETE FROM git_grants');if(change==='ownership')f.setOwners(['someone-else']);});
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('blocked');expect(f.updates()).toBe(0);expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.old);
 }finally{f.close();}
});
test('unrelated appended remote commits are not adopted despite containing both recorded inputs',async()=>{
 const f=fixture();try{
  f.git(['checkout','producer']);writeFileSync(join(f.repo,'unrelated'),'unrelated');f.git(['add','.']);f.git(['commit','-m','Unrelated update']);f.b.head=f.git(['rev-parse','HEAD']);f.git(['push',f.remote,`HEAD:refs/heads/${f.b.branch}`]);
   expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('two-parent');expect(f.updates()).toBe(0);
 }finally{f.close();}
});
test('concurrent polls share the submission fence and do not duplicate mutation',async()=>{
 const f=fixture();try{
  const outcomes=await Promise.allSettled([f.sync().ensure(f.id,f.c,'owner/repo',7),f.sync().ensure(f.id,f.c,'owner/repo',7)]);
  expect(outcomes.some(x=>x.status==='fulfilled'&&x.value?.state==='updating_branch')).toBe(true);expect(f.updates()).toBe(1);
 }finally{f.close();}
});

function externalFixture(){
 const f=fixture();f.s.db.exec('DELETE FROM branch_updates');
 new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['inspect','fetch','push-feature','open-pr','merge-base-feature'],'human');
 f.s.db.query('UPDATE implementation_dispatch SET paths=? WHERE job=?').run(JSON.stringify(['feature']),f.id);
 (f.c as any).conflictRecovery={baseBranch:'main'};
 const loop=new ReviewLoop(f.s);loop.register(f.id,'owner/repo',7,['CI'],['feature'],true);loop.record(f.id,{state:'waiting_for_review',head:f.old,reason:'Previously observed feature head'});
 f.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(f.old,f.id);
 return f;
}
for(const incident of ['DEV-64 / #52','DEV-67 / #53'])test(`${incident} isolated external base merge resynchronizes once without a receipt`,async()=>{
 const f=externalFixture();try{
  f.s.db.query("UPDATE review_targets SET state='ready_for_human',last_signature='stale' WHERE job=?").run(f.id);
  expect(await f.sync().ensure(f.id,f.c,'owner/repo',7)).toMatchObject({state:'updating_branch',maintenanceComplete:true});
  expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.target);expect(f.updates()).toBe(1);
  expect(f.s.db.query('SELECT state,last_signature FROM review_targets').get()).toMatchObject({state:'waiting_for_review',last_signature:null});
  expect(JSON.parse((f.s.db.query('SELECT proof FROM branch_syncs').get() as any).proof).source).toBe('external-base-merge');
  expect(f.s.db.query('SELECT count(*) AS n FROM branch_updates').get()).toMatchObject({n:0});
  expect(await f.sync().ensure(f.id,f.c,'owner/repo',7)).toBeNull();expect(f.updates()).toBe(1);expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.close();}
});
for(const stage of ['fetch','update'])test(`external merge retry after lost ${stage} response is idempotent`,async()=>{
 const f=externalFixture();try{
  if(stage==='fetch')f.loseFetch();else f.loseUpdate();
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('blocked');
  const reopened=new Store(f.db);try{expect((await new BranchSync(reopened,f.transport,f.run,f.inspect,f.barrier.submit).ensure(f.id,f.c,'owner/repo',7))?.maintenanceComplete).toBe(true);}finally{reopened.close();}
  expect(f.updates()).toBe(1);
 }finally{f.close();}
});
test('external merge defers active workers and preserves dirty work',async()=>{
 const f=externalFixture();try{
  f.setIdle(false);expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('waiting_for_worker');expect(f.fetches()).toBe(0);
  f.setIdle(true);writeFileSync(join(f.tree,'local'),'local');expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('local edits');expect(f.updates()).toBe(0);
 }finally{f.close();}
});
for(const change of ['head','base','approval','ownership','base-ref'])test(`external ${change} race preserves predecessor`,async()=>{
  const f=externalFixture();try{
   advanceExternal(f,2);
  f.onFetch(()=>{if(change==='head')f.b.head=f.old;if(change==='base')f.b.base=f.old;if(change==='approval')f.s.db.exec('DELETE FROM git_grants');if(change==='ownership')f.setOwners(['other']);if(change==='base-ref')f.git(['--git-dir',f.remote,'update-ref','refs/heads/main',f.old]);});
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('blocked');expect(f.updates()).toBe(0);expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.old);
 }finally{f.close();}
});
for(const missing of ['inspect','merge-base-feature'])test(`external merge requires current ${missing} grant`,async()=>{
 const f=externalFixture();try{
  const g=f.s.db.query('SELECT operations FROM git_grants WHERE job=?').get(f.id) as any;
  f.s.db.query('UPDATE git_grants SET operations=? WHERE job=?').run(JSON.stringify(JSON.parse(g.operations).filter((x:string)=>x!==missing)),f.id);
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain(missing);expect(f.fetches()).toBe(0);
 }finally{f.close();}
});
for(const invalid of ['independent-edit','appended-commit','wrong-base','scope','unverified-head','uncertain-receipt'])test(`external ${invalid} is rejected without fast-forward`,async()=>{
 const f=externalFixture();try{
  if(invalid==='independent-edit'){
   f.git(['checkout','producer']);writeFileSync(join(f.repo,'feature'),'independent edit');f.git(['add','.']);f.git(['commit','--amend','--no-edit']);f.b.head=f.git(['rev-parse','HEAD']);
  }
  if(invalid==='appended-commit'){
   f.git(['checkout','producer']);writeFileSync(join(f.repo,'extra'),'extra');f.git(['add','.']);f.git(['commit','-m','unrelated']);f.b.head=f.git(['rev-parse','HEAD']);
  }
  if(invalid==='wrong-base'){
   const tree=f.git(['rev-parse',`${f.target}^{tree}`]);f.b.head=f.git(['commit-tree',tree,'-p',f.old,'-p',f.target,'-m','Wrong second parent']);
  }
  if(invalid==='scope')f.s.db.query('UPDATE implementation_dispatch SET paths=? WHERE job=?').run(JSON.stringify(['src/**']),f.id);
  if(invalid==='unverified-head')f.s.db.query('UPDATE review_targets SET head=? WHERE job=?').run(f.base,f.id);
  if(invalid==='uncertain-receipt')f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,f.base,f.old,'delivery_uncertain',Date.now(),'unknown');
  f.git(['push',f.remote,`${f.b.head}:refs/heads/fixture-object`]);
  f.git(['--git-dir',f.remote,'update-ref',`refs/heads/${f.b.branch}`,f.b.head]);
  const result=await f.sync().ensure(f.id,f.c,'owner/repo',7);
  expect(result?.state).toBe('blocked');
  const reasons={'independent-edit':'independent feature edits','appended-commit':'two-parent','wrong-base':'second parent','scope':'approved scope','unverified-head':'previously verified','uncertain-receipt':'Unmatched recorded'};
  expect(result?.reason).toContain(reasons[invalid]);expect(f.updates()).toBe(0);expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.old);
 }finally{f.close();}
});
test('external synchronization defers if worker starts during fetch, then resumes without replay',async()=>{
 const f=externalFixture();try{
  f.onFetch(()=>f.setIdle(false));
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('waiting_for_worker');expect(f.updates()).toBe(0);
  f.setIdle(true);f.onFetch(()=>{});
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.maintenanceComplete).toBe(true);expect(f.updates()).toBe(1);
 }finally{f.close();}
});
test('external retry does not treat an already advanced local head as merge-tree proof',async()=>{
 const f=externalFixture();try{
  f.git(['checkout','producer']);writeFileSync(join(f.repo,'feature'),'independent edit');f.git(['add','.']);f.git(['commit','--amend','--no-edit']);f.b.head=f.git(['rev-parse','HEAD']);
  f.git(['push',f.remote,`${f.b.head}:refs/heads/fixture-object`]);f.git(['--git-dir',f.remote,'update-ref',`refs/heads/${f.b.branch}`,f.b.head]);
  f.loseFetch();expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.state).toBe('blocked');
  // Simulate external intervention after the persisted fetch intent. Restart
  // must still prove the tree instead of releasing the existing reservation.
  f.git(['merge','--ff-only',f.b.head],f.tree);
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('independent feature edits');
  expect(worktreeReservation(f.s,f.id)).toBeDefined();expect(f.updates()).toBe(0);
 }finally{f.close();}
});
test('historical completed update receipts do not block a later external merge',async()=>{
 const f=externalFixture();try{
  const initial=f.git(['rev-parse',`${f.old}^`]);
  f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,initial,initial,'observed',1,null);
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.maintenanceComplete).toBe(true);
  expect(f.s.db.query('SELECT state FROM branch_updates').get()).toMatchObject({state:'observed'});
 }finally{f.close();}
});

function advanceExternal(f:ReturnType<typeof externalFixture>,count=1){
 for(let i=0;i<count;i++){
  f.git(['checkout','main']);writeFileSync(join(f.repo,`base-${i}`),`base ${i}`);f.git(['add','.']);f.git(['commit','-m',`Base ${i}`]);f.b.base=f.git(['rev-parse','HEAD']);
  f.git(['checkout','producer']);f.git(['merge','--no-ff','main','-m',`External base merge ${i}`]);f.b.head=f.git(['rev-parse','HEAD']);
 }
 f.git(['push',f.remote,'main:refs/heads/main','producer:refs/heads/fixture-chain']);
 f.git(['--git-dir',f.remote,'update-ref',`refs/heads/${f.b.branch}`,f.b.head]);
}

for(const count of [0,2])for(const mixed of [false,true])test(`polling reconciles ${count+1} merges with ADLC receipt: ${mixed}`,async()=>{
 const f=externalFixture();let reads=0;
 if(mixed)f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,f.old,f.base,'accepted',Date.now(),null);
 advanceExternal(f,count);
 const session={receiptObservation:{complete:true,observed:Date.now()},session:{id:'worker',projectId:'ao',branch:f.b.branch,isTerminated:false,prs:[{number:7,url:'https://github.com/owner/repo/pull/7'}]},transcript:{controller:'ready',entries:[],turns:[]}};
 const original=BranchSync.prototype.ensure;
 const sync=spyOn(BranchSync.prototype,'ensure').mockImplementation(function(job,c,repo,pr){return original.call(f.sync(),job,c,repo,pr);});
 const io:any={readBranchSnapshot:f.transport.read,contains:f.transport.contains,worktreeIdentity:async()=>({tree:f.tree,branch:f.b.branch,head:f.git(['rev-parse','HEAD'],f.tree)}),sessionEvidence:async()=>({...session,receiptObservation:{complete:true,observed:Date.now()}}),readiness:async()=>{reads++;return {head:f.b.head,clear:false,customCheckBlocker:'Independent review gate',reasons:['Independent review gate'],findings:[],failedChecks:[],pendingChecks:['CI'],missingChecks:[],coderabbitPending:true};}};
 try{
  let loop=new ReviewLoop(f.s,async()=>{throw Error('No review mutation');},io);loop.configureMetadataChecks('project',[]);
  f.setIdle(false);
  expect((await loop.tick(f.id,undefined,undefined,undefined,f.c)).state).toBe('waiting_for_worker');
  expect(loop.get(f.id).head).toBe(f.old);expect(f.updates()).toBe(0);
  f.setIdle(true);f.loseUpdate();
  expect((await loop.tick(f.id,undefined,undefined,undefined,f.c)).state).toBe('blocked');
  expect(loop.get(f.id).head).toBe(f.old);
  loop=new ReviewLoop(f.s,async()=>{throw Error('No review mutation');},io);
  expect((await loop.tick(f.id,undefined,undefined,undefined,f.c)).maintenance?.state).toBe('completed');
  expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.b.head);expect(f.updates()).toBe(1);
  expect(loop.get(f.id)).toMatchObject({head:f.b.head,state:'blocked',reason:'Independent review gate'});
  expect(await f.sync().ensure(f.id,f.c,'owner/repo',7)).toBeNull();expect(reads).toBe(3);
  if(mixed)expect(f.s.db.query('SELECT state FROM branch_updates').get()).toMatchObject({state:'observed'});
 }finally{sync.mockRestore();f.close();}
});

for(const invalid of ['earlier-tree','rewritten','bound'])test(`consecutive external chain rejects ${invalid} history`,async()=>{
 const f=externalFixture();try{
  if(invalid==='earlier-tree'){
   f.git(['checkout','producer']);writeFileSync(join(f.repo,'feature'),'untrusted');f.git(['add','.']);f.git(['commit','--amend','--no-edit']);
  }
  if(invalid==='rewritten')f.git(['checkout','-B','producer','main']);
  advanceExternal(f,invalid==='bound'?MAX_SYNC_MERGES:2);
  const result=await f.sync().ensure(f.id,f.c,'owner/repo',7);
  expect(result?.state).toBe('blocked');expect(result?.reason).toContain('Unverified commit');expect(result?.reason).toContain('operator reconciliation');
  expect(f.git(['rev-parse','HEAD'],f.tree)).toBe(f.old);expect(f.updates()).toBe(0);
 }finally{f.close();}
},30000);

test('mixed chain rechecks authorization and base ref before fast-forward',async()=>{
 const f=externalFixture();try{
  f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,f.old,f.base,'accepted',Date.now(),null);
  advanceExternal(f,2);f.onFetch(()=>f.git(['--git-dir',f.remote,'update-ref','refs/heads/main',f.old]));
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('base ref changed');
  expect(f.updates()).toBe(0);expect(f.s.db.query('SELECT state FROM branch_updates').get()).toMatchObject({state:'accepted'});
 }finally{f.close();}
});

test('mixed chain rejects an unmatched receipt added during fetch',async()=>{
 const f=externalFixture();try{
  f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,f.old,f.base,'accepted',Date.now(),null);
  advanceExternal(f,2);
  f.onFetch(()=>f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,f.base,f.old,'delivery_uncertain',Date.now(),'unknown'));
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('Unmatched recorded update provenance');expect(f.updates()).toBe(0);
 }finally{f.close();}
});

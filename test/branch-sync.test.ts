import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
import {recordReadiness} from '../src/readiness';
import {BranchUpdates,branchUpdateBinding,type BranchSnapshot} from '../src/branch-updates';
import {BranchSync} from '../src/branch-sync';
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
  expect((await f.sync().ensure(f.id,f.c,'owner/repo',7))?.reason).toContain('exact recorded update merge');expect(f.updates()).toBe(0);
 }finally{f.close();}
});
test('concurrent polls share the submission fence and do not duplicate mutation',async()=>{
 const f=fixture();try{
  const outcomes=await Promise.allSettled([f.sync().ensure(f.id,f.c,'owner/repo',7),f.sync().ensure(f.id,f.c,'owner/repo',7)]);
  expect(outcomes.some(x=>x.status==='fulfilled'&&x.value?.state==='updating_branch')).toBe(true);expect(f.updates()).toBe(1);
 }finally{f.close();}
});

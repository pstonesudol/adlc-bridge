import {test,expect} from 'bun:test';
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {AO} from '../src/orchestrator';
import {recoveryTransport} from '../src/delivery-evidence';

const head='a'.repeat(40),anchor='b'.repeat(40);

function fixture(shared=false){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-evidence-')));
 const source=join(root,'source'),tree=shared?source:join(root,'worktree');
 mkdirSync(source);if(!shared)mkdirSync(tree);mkdirSync(join(root,'common'));
 const s=new Store(':memory:');new Workflow(s,{} as any);
 const id=s.enqueue('project','issue','spec'),p=new Planning(s),r=p.reserve(id,'ao');
 s.db.query("UPDATE planning_runs SET session_id='worker',worktree=? WHERE job=?").run(tree,id);
 s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?,?,?,?,?,?)').run(id,'a'.repeat(64),'worker','client','approved_pending','["src/**"]','supervised-host','human',null);
 const state:any={
  branch:r.branch,origin:'git@github.com:owner/repo.git',status:'',mergeBase:anchor,
  localHead:head,remoteHead:head,
  worktreeList:`worktree ${tree}\nbranch refs/heads/${r.branch}\n\nworktree ${source}\nbranch refs/heads/main`,
  slurp:[[{number:7}]],
  prDetail:{base:{repo:{full_name:'owner/repo',default_branch:'main'},ref:'main'},head:{ref:r.branch,sha:head,repo:{full_name:'owner/repo'}},html_url:'https://github.com/owner/repo/pull/7',number:7,state:'open',draft:false},
  inventory:{data:[{id:'worker',isTerminated:false}]},
  details:{worker:{session:{id:'worker',prs:[{state:'open',number:7,url:'https://github.com/owner/repo/pull/7'}]}}},
  evidence:{session:{id:'worker',projectId:'ao',branch:r.branch,isTerminated:false,prs:[{state:'open',number:7,url:'https://github.com/owner/repo/pull/7'}],activity:{state:'idle'}},transcript:{controller:'ready',entries:[{clientMessageId:'client',turnId:'turn'}],turns:[{id:'turn',state:'completed'}]}}
 };
 const calls:string[][]=[];
 const run=async(args:string[],cwd?:string)=>{
  calls.push(args);
  if(args[0]==='git'){
   const argv=args.slice(2),cmd=argv[0];
   if(cmd==='worktree')return state.worktreeList;
   if(cmd==='rev-parse'){
    if(argv.includes('--show-toplevel'))return cwd??tree;
    if(argv.includes('--git-common-dir'))return join(root,'common');
    if(argv[1]==='HEAD')return state.localHead;
    return anchor;
   }
   if(cmd==='branch')return state.branch;
   if(cmd==='remote')return state.origin;
   if(cmd==='merge-base')return state.mergeBase;
   if(cmd==='status')return state.status;
   if(cmd==='ls-remote')return `${state.remoteHead}\trefs/heads/${state.branch}`;
  }
  if(args[0]==='gh')return JSON.stringify(args.includes('--slurp')?state.slurp:state.prDetail);
  if(args[0]===AO){
   if(args[1]==='session'&&args[2]==='ls')return JSON.stringify(state.inventory);
   if(args[1]==='session'&&args[2]==='get')return JSON.stringify(state.details[args[3]]);
  }
  throw Error(`Unexpected collector command: ${args.join(' ')}`);
 };
 const inspect=()=>recoveryTransport(s,run,async()=>state.evidence).inspect(id,{repo:source,githubRepo:'owner/repo'});
 const cleanup=()=>{s.close();rmSync(root,{recursive:true,force:true});};
 return {s,id,root,source,tree,r,state,calls,run,inspect,cleanup};
}

test('collector parses complete isolated evidence and exact PR fields',async()=>{
 const f=fixture();try{
  const facts=await f.inspect();
  expect(facts).toMatchObject({session:'worker',project:'ao',reserved:f.r.branch,worktree:f.tree,branch:f.r.branch,head,anchor,clean:true,isolated:true,lineage:true,idle:true,completed:true,owners:['worker']});
  expect(facts.candidates).toHaveLength(1);expect(facts.candidates[0]).toEqual({repo:'owner/repo',pr:7,url:'https://github.com/owner/repo/pull/7',branch:f.r.branch,head,baseBranch:'main',defaultBranch:'main',fork:false,state:'open',draft:false});
  expect(f.calls.some(x=>x[0]==='gh'&&x.includes('--slurp'))).toBe(true);
 }finally{f.cleanup();}
});
test('collector reports a worktree that shares the source checkout as not isolated',async()=>{
 const f=fixture(true);try{
  const facts=await f.inspect();expect(facts.worktree).toBe(f.source);expect(facts.isolated).toBe(false);
 }finally{f.cleanup();}
});
test('collector reports an unregistered worktree as not isolated',async()=>{
 const f=fixture();try{
  f.state.worktreeList=`worktree ${f.source}\nbranch refs/heads/main`;
  expect((await f.inspect()).isolated).toBe(false);
 }finally{f.cleanup();}
});
test('collector reports dirty worktree output as unclean',async()=>{
 const f=fixture();try{
  f.state.status=' M src/a.ts';expect((await f.inspect()).clean).toBe(false);
 }finally{f.cleanup();}
});
test('collector reports missing reserved-branch ancestry',async()=>{
 const f=fixture();try{
  f.state.mergeBase='d'.repeat(40);expect((await f.inspect()).lineage).toBe(false);
 }finally{f.cleanup();}
});
test('collector rejects a remote feature ref that differs from the local head',async()=>{
 const f=fixture();try{
  f.state.remoteHead='c'.repeat(40);await expect(f.inspect()).rejects.toThrow('Local HEAD differs from exact remote feature ref');
 }finally{f.cleanup();}
});
test('collector rejects non-array --slurp pages',async()=>{
 const f=fixture();try{
  f.state.slurp={message:'Not Found'};await expect(f.inspect()).rejects.toThrow('Incomplete GitHub candidate inventory');
 }finally{f.cleanup();}
});
test('collector flags a pull request whose head repo is a fork',async()=>{
 const f=fixture();try{
  f.state.prDetail.head.repo.full_name='fork/repo';expect((await f.inspect()).candidates[0].fork).toBe(true);
 }finally{f.cleanup();}
});
test('collector finds every active owner and skips terminated sessions',async()=>{
 const f=fixture();try{
  f.state.inventory.data.push({id:'other',isTerminated:false},{id:'dead',isTerminated:true});
  f.state.details.other={session:{id:'other',prs:[{state:'open',url:'https://github.com/owner/repo/pull/7'}]}};
  f.state.details.dead={session:{id:'dead',prs:[{state:'open',url:'https://github.com/owner/repo/pull/7'}]}};
  expect((await f.inspect()).owners).toEqual(['worker','other']);
  expect(f.calls.some(x=>x[0]===AO&&x[3]==='dead')).toBe(false);
 }finally{f.cleanup();}
});
test('collector rejects an origin URL that differs from the configured repository',async()=>{
 const f=fixture();try{
  f.state.origin='git@github.com:other/repo.git';await expect(f.inspect()).rejects.toThrow('Worktree origin differs from configured repository');
 }finally{f.cleanup();}
});
test('claim always passes --no-takeover',async()=>{
 const f=fixture();try{
  const calls:string[][]=[],url='https://github.com/owner/repo/pull/7';
  await recoveryTransport(f.s,async(args:string[])=>{calls.push(args);return '';},async()=>f.state.evidence).claim('worker',url);
  expect(calls).toEqual([[AO,'session','claim-pr','worker',url,'--no-takeover','--json']]);
 }finally{f.cleanup();}
});
test('attached requires one open PR on a non-terminated session',async()=>{
 const f=fixture();try{
  const url='https://github.com/owner/repo/pull/7',t=()=>recoveryTransport(f.s,f.run,async()=>f.state.evidence),prs=f.state.evidence.session.prs;
  expect(await t().attached('worker',url)).toBe(true);
  prs.push({state:'open',number:7,url});expect(await t().attached('worker',url)).toBe(false);
  prs.pop();prs[0].state='closed';expect(await t().attached('worker',url)).toBe(false);
  prs[0].state='open';f.state.evidence.session.isTerminated=true;expect(await t().attached('worker',url)).toBe(false);
 }finally{f.cleanup();}
});

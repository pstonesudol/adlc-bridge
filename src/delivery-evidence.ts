import {realpathSync} from 'node:fs';
import {Store} from './core';
import {AO} from './orchestrator';
import {sessionEvidence} from './session-evidence';
import type {RecoveryTransport,DeliveryFacts} from './delivery-recovery';

async function command(args:string[],cwd?:string){
 const p=Bun.spawn(args,{cwd,stdout:'pipe',stderr:'pipe',timeout:30000});
 const [out,,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code!==0)throw Error(`Required evidence unavailable: ${args[0]} ${args[1]}`);return out.trim();
}
const json=async(args:string[])=>JSON.parse(await command(args));
const git=(cwd:string,...args:string[])=>command(['git','--no-optional-locks',...args],cwd);
function githubRepo(url:string){return /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];}
export async function worktreeIdentity(s:Store,job:string){
 const r=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
 if(!r?.worktree)throw Error('Registered isolated worktree evidence missing');
 const tree=realpathSync(r.worktree),top=realpathSync(await git(tree,'rev-parse','--show-toplevel'));
 if(tree!==top)throw Error('Registered worktree root mismatch');
 const branch=await git(tree,'branch','--show-current'),head=await git(tree,'rev-parse','HEAD');
 if(!branch||!/^[a-f0-9]{40,64}$/.test(head))throw Error('Attached worktree branch and full HEAD required');
 return {tree,branch,head};
}
export function recoveryTransport(s:Store):RecoveryTransport{return {
 async inspect(job,c){
  if(!/^[\w.-]+\/[\w.-]+$/.test(c.githubRepo??''))throw Error('Exact configured GitHub repository required');
  const d=s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any,r=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
  const e=await sessionEvidence(d.session_id),w=await worktreeIdentity(s,job),source=realpathSync(c.repo);
  if(e.session?.id!==d.session_id||e.session?.projectId!==r.project||e.session?.branch!==r.branch||e.session?.isTerminated!==false||!Array.isArray(e.session.prs))throw Error('Originating AO session identity mismatch');
  const trees=(await git(source,'worktree','list','--porcelain')).split('\n\n');
  const registered=trees.some(x=>x.split('\n').includes(`worktree ${w.tree}`)&&x.split('\n').includes(`branch refs/heads/${w.branch}`));
  const common=realpathSync(await git(w.tree,'rev-parse','--path-format=absolute','--git-common-dir'));
  const sourceCommon=realpathSync(await git(source,'rev-parse','--path-format=absolute','--git-common-dir'));
  if(githubRepo(await git(w.tree,'remote','get-url','origin'))!==c.githubRepo)throw Error('Worktree origin differs from configured repository');
  const anchor=await git(w.tree,'rev-parse',`refs/heads/${r.branch}^{commit}`);
  const lineage=(await git(w.tree,'merge-base',anchor,w.head))===anchor;
  const clean=!(await git(w.tree,'status','--porcelain','--untracked-files=all'));
  const receipt=e.transcript?.entries?.find((x:any)=>x.clientMessageId===d.client_id),turn=receipt&&e.transcript?.turns?.find((x:any)=>x.id===receipt.turnId);
  const idle=e.session.activity?.state==='idle'&&e.transcript?.controller==='ready'&&Array.isArray(e.transcript.turns)&&!e.transcript.turns.some((x:any)=>!['completed','failed','cancelled','interrupted'].includes(x.state));
  // Enumerate exact head ref, then read authoritative PR fields; names/titles
  // and worker messages are never ownership evidence. Paginate completely.
  const pages=await json(['gh','api','--paginate','--slurp',`repos/${c.githubRepo}/pulls?state=open&head=${encodeURIComponent(c.githubRepo.split('/')[0]+':'+w.branch)}&per_page=100`]);
  if(!Array.isArray(pages)||pages.some(x=>!Array.isArray(x)))throw Error('Incomplete GitHub candidate inventory');
  const candidates=[];
  for(const item of pages.flat()){
   const p=await json(['gh','api',`repos/${c.githubRepo}/pulls/${item.number}`]);
   candidates.push({repo:p.base?.repo?.full_name,pr:p.number,url:p.html_url,branch:p.head?.ref,head:p.head?.sha,baseBranch:p.base?.ref,defaultBranch:p.base?.repo?.default_branch,fork:p.head?.repo?.full_name!==c.githubRepo,state:p.state,draft:p.draft});
  }
  const remote=(await git(w.tree,'ls-remote','--refs','origin',`refs/heads/${w.branch}`)).split(/\s+/);
  const open=e.session.prs.filter((p:any)=>p.state==='open');
  if(open.length>1||open.some((p:any)=>!candidates.some(x=>x.url===p.url&&x.pr===p.number)))throw Error('Conflicting or duplicate attached worker PRs');
  if(remote.length!==2||remote[0]!==w.head||remote[1]!==`refs/heads/${w.branch}`)throw Error('Local HEAD differs from exact remote feature ref');
  const inventory=await json([AO,'session','ls','--all','--include-terminated','--json']);
  if(!Array.isArray(inventory.data))throw Error('Complete AO owner inventory unavailable');
  const owners:string[]=[];
  for(const row of inventory.data.filter((x:any)=>!x.isTerminated)){
   const detail=await json([AO,'session','get',row.id,'--json']);
   if(detail.session?.id!==row.id||!Array.isArray(detail.session.prs))throw Error('Incomplete AO ownership evidence');
   if(detail.session.prs.some((p:any)=>candidates.some(x=>x.url===p.url)))owners.push(row.id);
  }
  return {session:e.session.id,project:e.session.projectId,reserved:r.branch,worktree:w.tree,branch:w.branch,head:w.head,anchor,clean,isolated:w.tree!==source&&registered&&common===sourceCommon,lineage,idle,completed:turn?.state==='completed',owners,candidates} satisfies DeliveryFacts;
 },
 async claim(session,url){await command([AO,'session','claim-pr',session,url,'--no-takeover','--json']);},
 async attached(session,url){const e=await sessionEvidence(session);return !e.session.isTerminated&&e.session.prs?.filter((p:any)=>p.url===url&&p.state==='open').length===1;}
};}

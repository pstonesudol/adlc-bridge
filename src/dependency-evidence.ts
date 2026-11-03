import {realpathSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store,digest} from './core';
import {AO} from './orchestrator';
import {command,worktreeIdentity,type ProcessRunner} from './delivery-evidence';
import {sessionEvidence} from './session-evidence';
import {linearAPI,readLinearIssue,type LinearAPI} from './linear-api';
import {recoveryCommand} from './conflict-recovery';
import type {DependencyJob} from './dependency-policy';

export async function dependencyRelations(id:string,api:LinearAPI=linearAPI):Promise<string[]>{
 const result=new Set<string>(),seen=new Set<string>();let after:string|null=null;
 do{
  const b=await api('query($id:String!,$after:String){issue(id:$id){id inverseRelations(first:100,after:$after){nodes{type issue{id}}pageInfo{hasNextPage endCursor}}}}',{id,after});
  const p=b.issue?.inverseRelations;
  if(b.issue?.id!==id||!Array.isArray(p?.nodes)||typeof p.pageInfo?.hasNextPage!=='boolean')throw Error('Incomplete Linear dependency relations');
  for(const r of p.nodes){if(typeof r.type!=='string'||!r.issue?.id)throw Error('Invalid Linear dependency edge');if(r.type==='blocks')result.add(r.issue.id);}
  if(!p.pageInfo.hasNextPage)return [...result].sort();
  after=p.pageInfo.endCursor;if(!after||seen.has(after)||seen.size>=10)throw Error('Invalid or excessive dependency pagination');seen.add(after);
 }while(true);
}
export function dependencyIO(s:Store,run:ProcessRunner=command,api:LinearAPI=linearAPI){
 const gh=async(path:string)=>JSON.parse(await run(['gh','api',path]));
 const git=(tree:string,...args:string[])=>run(['git','--no-optional-locks',...args],tree);
 return {
  issue:(id:string)=>readLinearIssue(id,api),relations:(id:string)=>dependencyRelations(id,api),
  async provider(c:any,definition:DependencyJob){
   const repo=c.githubRepo,baseBranch=c.dependencyRecovery.baseBranch;
   const base=await gh(`repos/${repo}/branches/${encodeURIComponent(baseBranch)}`);
   if(base.name!==baseBranch||! /^[a-f0-9]{40,64}$/.test(base.commit?.sha??''))throw Error('Exact target base unavailable');
   const dependencies=[];
   for(const d of definition.prerequisites){
    const p=await gh(`repos/${repo}/pulls/${d.pr}`);
     if(p.number!==d.pr||p.html_url!==`https://github.com/${repo}/pull/${d.pr}`||p.base?.repo?.full_name!==repo||p.base?.ref!==baseBranch)throw Error(`Repository/base mismatch for ${d.ref}`);
     if(d.headSha&&p.head?.sha!==d.headSha)throw Error(`${d.ref}: reviewed prerequisite head changed; review contract and same-plan compatibility before updating pins`);
    if(p.merged!==true||!p.merged_at||p.state!=='closed'||! /^[a-f0-9]{40,64}$/.test(p.merge_commit_sha??''))throw Error(`${d.ref}: PR #${d.pr} is ${p.state}, not a verified merge; closed-unmerged/replaced PRs require reconciliation`);
    const compare=await gh(`repos/${repo}/compare/${p.merge_commit_sha}...${base.commit.sha}`);
    if(!['ahead','identical'].includes(compare.status)||compare.merge_base_commit?.sha!==p.merge_commit_sha)throw Error(`${d.ref}: merged changes are not included in target base`);
    const capabilities=[];
    for(const cap of d.capabilities){
     const f=await gh(`repos/${repo}/contents/${cap.path}?ref=${base.commit.sha}`);
     if(f.type!=='file'||f.path!==cap.path||f.encoding!=='base64'||typeof f.content!=='string'||f.size>1000000||digest(Buffer.from(f.content,'base64').toString('utf8'))!==cap.sha256)throw Error(`${d.ref}: required capability ${cap.path} missing or changed after merge`);
     capabilities.push(cap);
    }
    if(d.kind==='host-runtime')throw Error(`${d.ref}: installed host-runtime capability needs operator reconciliation; source merge is not installation proof`);
    dependencies.push({issue:d.issue,ref:d.ref,repo,pr:d.pr,merge:p.merge_commit_sha,capabilities});
   }
   return {repo,baseBranch,base:base.commit.sha,dependencies};
  },
  async facts(job:string,c:any){
   const p=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any,d=s.db.query('SELECT * FROM implementation_dispatch WHERE job=?').get(job) as any;
   const w=await worktreeIdentity(s,job,run),e=await sessionEvidence(d.session_id),source=realpathSync(c.repo);
   const inventory=JSON.parse(await run([AO,'session','ls','--all','--include-terminated','--json']));
   if(!Array.isArray(inventory.data))throw Error('Complete owner inventory required');
   const owners=inventory.data.filter((x:any)=>!x.isTerminated&&x.branch===w.branch).map((x:any)=>x.id).sort();
   const trees=(await git(w.tree,'worktree','list','--porcelain')).split('\n\n');
   const common=realpathSync(await git(w.tree,'rev-parse','--path-format=absolute','--git-common-dir'));
   const sourceCommon=realpathSync(await git(source,'rev-parse','--path-format=absolute','--git-common-dir'));
   const origin=await git(w.tree,'remote','get-url','origin');
   if(![`git@github.com:${c.githubRepo}.git`,`https://github.com/${c.githubRepo}.git`,`https://github.com/${c.githubRepo}`].includes(origin))throw Error('Exact origin repository required');
   for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','sequencer','rebase-apply','rebase-merge','index.lock'])if(existsSync(resolve(w.tree,await git(w.tree,'rev-parse','--git-path',name))))throw Error(`Ongoing Git operation ${name}; preserve work`);
   const remote=await git(w.tree,'ls-remote','--refs','origin',`refs/heads/${w.branch}`);
   if(remote&&remote!==`${w.head}\trefs/heads/${w.branch}`){
    const updates=s.db.query("SELECT name FROM sqlite_master WHERE name='dependency_updates'").get()?s.db.query('SELECT detail FROM dependency_updates WHERE job=?').all(job) as any[]:[];
    if(!updates.some(r=>{const x=JSON.parse(r.detail);return x.proof.auth.plan===s.get(job).plan_hash&&x.proof.provider.base===w.head&&x.facts.remote===remote;}))throw Error('Remote feature head differs; unpublished or divergent work needs reconciliation');
   }
   // We only need to establish absence: a single result of any lifecycle state
   // blocks. Never create a replacement for a closed or detached existing PR.
   const pages=await gh(`repos/${c.githubRepo}/pulls?state=all&head=${encodeURIComponent(c.githubRepo.split('/')[0]+':'+w.branch)}&per_page=1`);
   if(!Array.isArray(pages)||pages.length||(e.session.prs??[]).length)throw Error('Existing PR metadata requires handoff reconciliation, not dependency resume');
   const cont=s.db.query('SELECT * FROM continuations WHERE job=? ORDER BY id DESC LIMIT 1').get(job) as any;
   const entry=e.transcript?.entries?.find((x:any)=>x.clientMessageId===(cont?.client_id??d.client_id)),turn=entry&&e.transcript.turns?.find((t:any)=>t.id===entry.turnId);
   return {tree:w.tree,branch:w.branch,head:w.head,remote,session:e.session.id,project:e.session.projectId,
    clean:!(await git(w.tree,'status','--porcelain','--untracked-files=all')),
    isolated:source!==w.tree&&common===sourceCommon&&trees.filter(t=>t.split('\n').includes(`branch refs/heads/${w.branch}`)).length===1&&trees.some(t=>t.split('\n').includes(`worktree ${w.tree}`)&&t.split('\n').includes(`branch refs/heads/${w.branch}`)),owners,
    idle:e.session.isTerminated===false&&e.session.branch===p.branch&&e.session.activity?.state==='idle'&&e.transcript?.controller==='ready'&&Array.isArray(e.transcript.turns)&&e.transcript.turns.every((t:any)=>['completed','failed','cancelled','interrupted'].includes(t.state)),completed:turn?.state==='completed'};
  },
  async fetch(tree:string,baseBranch:string){const r=await recoveryCommand(['git','fetch','--no-tags','origin',`refs/heads/${baseBranch}`],tree);if(r.code)throw Error('Dependency fetch unavailable; preserve work');},
  async includes(tree:string,ancestor:string,head:string){return await git(tree,'merge-base',ancestor,head)===ancestor;},
  async capabilities(tree:string,head:string,definition:DependencyJob){for(const d of definition.prerequisites)for(const cap of d.capabilities){
   const mode=await git(tree,'ls-tree',head,'--',cap.path);
   const content=await recoveryCommand(['git','show',`${head}:${cap.path}`],tree);
   if(!/^100(644|755) blob /.test(mode)||content.code||content.out.length>1000000||digest(content.out)!==cap.sha256)throw Error(`Local capability ${cap.path} differs; manual reconciliation required`);
  }},
  async update(tree:string,base:string){const r=await recoveryCommand(['git','-c','core.hooksPath=/dev/null','merge','--ff-only','--no-edit',base],tree);if(r.code)throw Error('Non-fast-forward dependency update refused; preserve work for operator');},
 };
}
export type DependencyIO=ReturnType<typeof dependencyIO>;

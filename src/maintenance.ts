import {existsSync,realpathSync} from 'node:fs';
import {Store,digest} from './core';import {sessionEvidence} from './session-evidence';import {ProjectServices,registryPath} from './project-services';import {readFileSync} from 'node:fs';import {localAO} from './workflow-transport';import {ReviewLoop} from './review-loop';import {poll} from './linear';import {linearToken} from './credential';
async function gh(path:string){const p=Bun.spawn(['gh','api',path],{stdout:'pipe',stderr:'pipe'});const [out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code!==0)throw Error('GitHub inspection failed');return JSON.parse(out);}
export function assertIdle(e:any){if(!['ready','stopped'].includes(e.transcript?.controller)||!Array.isArray(e.transcript?.turns)||e.transcript.turns.some((t:any)=>!['completed','failed','interrupted','cancelled','recovered'].includes(t.state)))throw Error('Worker is active or activity is uncertain');}
export function assertCleanup(j:any,run:any,target:any,e:any,pr:any){
 if(j.state!=='done'||run.state!=='completed'||target.state!=='completed'||run.owner!=='orchestrator')throw Error('Only completed agent-owned jobs can be cleaned');
 if(e.session.id!==run.session_id||e.session.branch!==pr.head?.ref||!e.session.prs?.some((p:any)=>p.number===target.pr&&p.url===`https://github.com/${target.repo}/pull/${target.pr}`)||!pr.merged||pr.head?.repo?.full_name!==target.repo)throw Error('Merged PR and owned session must match');
 assertIdle(e);
}
function registrations(){const r=new Store(registryPath());try{return new ProjectServices(r).list();}finally{r.close();}}
export function configFor(s:Store,job:string,projects=registrations()){
 const p=projects.find(x=>x.linear_project===s.get(job).project);if(!p)throw Error('Registered project required');
 const c=JSON.parse(readFileSync(p.config,'utf8'));
 if(c.linear?.projectId!==p.linear_project||c.automation?.orchestratorProject!==p.project||typeof c.repo!=='string'||realpathSync(c.repo)!==p.repo)throw Error('Registered project configuration identity changed; reconcile before recovery');
 return c;
}
const maintenanceIO={registrations,sessionEvidence,gh,localAO,poll,linearToken,review:(s:Store)=>new ReviewLoop(s)};
export async function maintenance(s:Store,action:'recover'|'cleanup',job:string,apply=false,confirmation?:string,io=maintenanceIO){
 const j=s.get(job),run=s.db.query('SELECT * FROM runs WHERE job=?').get(job) as any,target=s.db.query('SELECT * FROM review_targets WHERE job=?').get(job) as any;
 if(!run||!target)throw Error('Existing run and PR target required; use recover-handoff for a missed initial handoff');
 const c=configFor(s,job,io.registrations());if(target.repo!==c.githubRepo)throw Error('Registered repository mismatch');
 const e=await io.sessionEvidence(run.session_id),pr=await io.gh(`repos/${target.repo}/pulls/${target.pr}`);
 const report={action,job,session:run.session_id,repo:target.repo,pr:target.pr,head:pr.head?.sha,base:pr.base?.sha,planHash:j.plan_hash,state:j.state,reviewState:target.state,reason:target.reason};
 if(action==='cleanup'){
  assertCleanup(j,run,target,e,pr);
  const tree=e.session.worktree??run.worktree;if(!tree||!existsSync(tree)||realpathSync(tree)===realpathSync(c.repo)||realpathSync(tree)!==realpathSync(run.worktree))throw Error('Verified isolated worktree required');
  const git=(args:string[])=>{const r=Bun.spawnSync(['/usr/bin/git','-C',tree,...args]);if(r.exitCode!==0)throw Error('Cannot verify worktree');return r.stdout.toString().trim();};
  if(git(['status','--porcelain','--untracked-files=all','--ignored']).length||git(['rev-parse','HEAD'])!==pr.head.sha)throw Error('Worktree has changes, ignored files or differs from merged PR head; preserved');
  const hash=digest(JSON.stringify(report));
  if(!apply)return {...report,confirmation:hash,preview:true,worktree:tree,note:'Apply terminates the idle completed session and asks Orchestrator to reclaim its clean worktree. History and GitHub branch are preserved by bridge; native Orchestrator controls workspace cleanup.'};
  if(confirmation!==hash)throw Error('Use the current preview confirmation hash; state may have changed');
  s.event(job,'cleanup_requested',JSON.stringify(report));
  const result=await io.localAO(`sessions/${encodeURIComponent(run.session_id)}/kill`,'POST',{});
  s.event(job,'cleanup_receipt',JSON.stringify(result));return {...report,result};
 }
 assertIdle(e);
 if(pr.state!=='open'||pr.head?.repo?.full_name!==target.repo||pr.head.ref!==e.session.branch)throw Error('Recovery requires the existing owned open PR');
 const rows=s.db.query("SELECT * FROM branch_updates WHERE job=? AND state='delivery_uncertain'").all(job) as any[];
 const proven=[];
 for(const row of rows){
  const [base,head]=await Promise.all([io.gh(`repos/${target.repo}/compare/${row.base}...${pr.head.sha}`),io.gh(`repos/${target.repo}/compare/${row.head}...${pr.head.sha}`)]);
  if(!['ahead','identical'].includes(base.status)||!['ahead','identical'].includes(head.status))throw Error('Uncertain branch update cannot be proven complete; no retry or state reset');
  proven.push({head:row.head,base:row.base});
 }
 const hash=digest(JSON.stringify({...report,proven}));if(!apply)return {...report,confirmation:hash,preview:true,provenBranchUpdates:proven,note:'Apply reconciles only proven completed branch updates, refreshes eligibility and reevaluates the existing review. It never resets attempts or resends uncertain dispatches.'};
 if(confirmation!==hash)throw Error('Use the current preview confirmation hash; state may have changed');
 for(const row of proven)s.db.query("UPDATE branch_updates SET state='observed',reason=NULL WHERE job=? AND head=? AND base=? AND state='delivery_uncertain'").run(job,row.head,row.base);
 s.event(job,'review_recovery_requested',JSON.stringify({...report,proven}));
 await io.poll(c,s,io.linearToken());const loop=io.review(s);loop.configureMetadataChecks(c.linear.projectId,c.prMetadataChecks??[]);return {...report,result:await loop.tick(job,c.branchUpdate)};
}

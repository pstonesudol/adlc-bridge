import {Store} from './core';
import {Lifecycle} from './lifecycle';
export type BranchPolicy={enabled:boolean;authorizedBy:string;maxUpdates:number|null};
export type BranchSnapshot={head:string;base:string;branch:string;baseBranch:string;defaultBranch:string;headRepo:string;baseRepo:string;state:string;draft:boolean;mergeable:boolean|null;behind:number};
export type BranchTransport={read(repo:string,pr:number):Promise<BranchSnapshot>;update(repo:string,pr:number,head:string):Promise<void>};
async function gh(args:string[]){const p=Bun.spawn(['gh',...args],{stdout:'pipe',stderr:'pipe',timeout:30000});const [out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code!==0)throw Error('GitHub branch operation failed; inspect before retry');return JSON.parse(out);}
export async function baseTip(repo:string,branch:string,read=gh){
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||typeof branch!=='string'||!branch||/[\s\x00-\x1f]/.test(branch))throw Error('Valid base repository and branch required');
 const b=await read(['api',`repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`]);
 if(b.ref!==`refs/heads/${branch}`||b.object?.type!=='commit'||!/^[a-f0-9]{40,64}$/.test(b.object.sha??''))throw Error('Incomplete current base ref');
 return b.object.sha as string;
}
export async function readBranchSnapshot(repo:string,pr:number,read=gh){
  const p=await read(['api',`repos/${repo}/pulls/${pr}`]);
  if(!/^[a-f0-9]{40,64}$/.test(p.head?.sha??'')||!/^[a-f0-9]{40,64}$/.test(p.base?.sha??''))throw Error('Incomplete branch identities');
  const currentBase=await baseTip(repo,p.base.ref,read);
  const b=await read(['api',`repos/${repo}/compare/${currentBase}...${p.head.sha}`]);
  if(!Number.isSafeInteger(b.behind_by)||b.behind_by<0)throw Error('Incomplete branch comparison');
  return {head:p.head.sha,base:currentBase,branch:p.head.ref,baseBranch:p.base.ref,defaultBranch:p.base.repo?.default_branch,headRepo:p.head.repo?.full_name,baseRepo:p.base.repo?.full_name,state:p.state,draft:p.draft,mergeable:p.mergeable,behind:b.behind_by};
 }
export const branchTransport:BranchTransport={
 read:readBranchSnapshot,
 async update(repo,pr,head){await gh(['api','--method','PUT',`repos/${repo}/pulls/${pr}/update-branch`,'-f',`expected_head_sha=${head}`]);}
};
export class BranchUpdates{
 constructor(public s:Store,public transport:BranchTransport=branchTransport){s.db.exec(`CREATE TABLE IF NOT EXISTS branch_updates(job TEXT NOT NULL REFERENCES jobs(id),head TEXT NOT NULL,base TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,reason TEXT,PRIMARY KEY(job,head,base));`);}
 async ensure(job:string,repo:string,pr:number,session:any,policy?:BranchPolicy){
  if(!policy?.enabled)return null;
  if(!policy.authorizedBy?.trim()||policy.maxUpdates!==null&&(!Number.isSafeInteger(policy.maxUpdates)||policy.maxUpdates<1||policy.maxUpdates>10))throw Error('Explicit branch update authorization and limit required');
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1)throw Error('Valid PR required');
  const l=new Lifecycle(this.s),j=l.current(job),run=l.run(job),grant=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
  if(!run||run.owner!=='orchestrator'||run.session_id!==session.session?.id||run.plan_hash!==j.plan_hash||!grant||grant.plan_hash!==j.plan_hash||!['fetch','push-feature'].every(op=>JSON.parse(grant.operations).includes(op)))throw Error('Existing approved feature branch execution required');
  const b=await this.transport.read(repo,pr);
  if(b.state!=='open'||b.draft||b.headRepo!==repo||b.baseRepo!==repo||b.branch!==session.session.branch||!b.defaultBranch||b.branch===b.defaultBranch||b.branch===b.baseBranch)throw Error('Branch update target is not the owned open feature PR');
  this.s.db.query("UPDATE branch_updates SET state='observed' WHERE job=? AND head!=? AND state='accepted'").run(job,b.head);
  const uncertain=this.s.db.query("SELECT 1 FROM branch_updates WHERE job=? AND state='delivery_uncertain' LIMIT 1").get(job);
  if(uncertain)return {state:'blocked',send:false,head:b.head,reason:'Earlier branch update outcome uncertain; inspect before recovery'};
  if(b.behind===0)return null;
  if(b.mergeable===false)return {state:'blocked',send:false,head:b.head,reason:'Feature branch has conflicts with base; human reconciliation required'};
  if(b.mergeable!==true)return {state:'updating_branch',send:false,head:b.head,reason:'Waiting for GitHub to determine branch mergeability'};
  if(session.transcript?.controller!=='ready'||session.transcript.turns?.some((t:any)=>['running','queued'].includes(t.state)))return {state:'waiting_for_worker',send:false,head:b.head,reason:'Branch is behind; wait for active worker before updating'};
  const row=this.s.db.query('SELECT * FROM branch_updates WHERE job=? AND head=? AND base=?').get(job,b.head,b.base) as any;
  if(row)return {state:row.reason||Date.now()-row.requested>=10*60*1000?'blocked':'updating_branch',send:false,head:b.head,reason:'Branch update already requested or uncertain; never resend for the same commit/base'};
  // Re-read before the mutation; GitHub also enforces expected_head_sha.
  const fresh=await this.transport.read(repo,pr);
  if(JSON.stringify(fresh)!==JSON.stringify(b))return {state:'updating_branch',send:false,head:fresh.head,reason:'Branch changed during inspection; recheck next poll'};
  l.current(job);
  const claim=this.s.db.transaction(()=>{
   const count=(this.s.db.query('SELECT count(*) AS n FROM branch_updates WHERE job=?').get(job) as any).n;
   if(policy.maxUpdates!==null&&count>=policy.maxUpdates)return 'limit';
   return this.s.db.query('INSERT OR IGNORE INTO branch_updates VALUES (?,?,?,?,?,?)').run(job,b.head,b.base,'delivery_uncertain',Date.now(),null).changes?'claimed':'existing';
  }).immediate();
  if(claim==='limit')return {state:'blocked',send:false,head:b.head,reason:'Automatic branch update limit reached; human inspection required'};
  if(claim!=='claimed')return {state:'updating_branch',send:false,head:b.head,reason:'Another poll reserved the branch update'};
  try{await this.transport.update(repo,pr,b.head);this.s.db.query("UPDATE branch_updates SET state='accepted' WHERE job=? AND head=? AND base=?").run(job,b.head,b.base);this.s.event(job,'feature_branch_update_requested',JSON.stringify({repo,pr,head:b.head,base:b.base,authorizedBy:policy.authorizedBy,mergePR:false}));}
  catch{this.s.db.query('UPDATE branch_updates SET reason=? WHERE job=? AND head=? AND base=?').run('API outcome uncertain; inspect conflicts, permissions and head before recovery',job,b.head,b.base);return {state:'blocked',send:false,head:b.head,reason:'Branch update failed or outcome uncertain; no automatic retry'};}
  return {state:'updating_branch',send:false,head:b.head,reason:'Feature branch update requested; new commit requires fresh CI and CodeRabbit clearance'};
 }
}

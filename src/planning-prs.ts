import {githubRead} from './provider-read';

export type PlanningPR={number:number;url:string;repo:string;branch:string;head:string;base:string;state:'open'};
export type PlanningPRInventory={repo:string;branch:string;complete:true;prs:PlanningPR[]};
/** Query the exact owned branch, not search-index or AO attachment absence.
 * An explicit terminal page and unique identities prove the bounded inventory. */
export async function readPlanningPRs(repo:string,branch:string,read=githubRead):Promise<PlanningPRInventory>{
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!branch||/[\s\x00-\x1f]/.test(branch))throw Error('Exact planning repository and branch required');
 const prs:PlanningPR[]=[],seen=new Set<number>();
 for(let page=1;page<=10;page++){
  const rows=await read(['api',`repos/${repo}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0]+':'+branch)}&per_page=100&page=${page}`]);
  if(!Array.isArray(rows)||rows.length>100)throw Error('Complete planning PR lookup required');
  for(const p of rows){
   if(!Number.isSafeInteger(p.number)||p.number<1||seen.has(p.number)||p.state!=='open'||p.html_url!==`https://github.com/${repo}/pull/${p.number}`||p.head?.repo?.full_name!==repo||p.base?.repo?.full_name!==repo||p.head.ref!==branch||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(p.head.sha??''))throw Error('Planning PR lookup identity incomplete or ambiguous');
   seen.add(p.number);prs.push({number:p.number,url:p.html_url,repo,branch,head:p.head.sha,base:repo,state:'open'});
  }
  if(rows.length<100)return {repo,branch,complete:true,prs};
 }
 throw Error('Planning PR lookup exceeds safe completeness bound');
}

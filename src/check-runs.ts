// Keep checks from distinct workflows/events separate. Only supersede an older
// run after GitHub's run and job identities have both been verified. The REST
// job ID is attempt-specific, not a stable logical-job ID. Keep distinct IDs
// separate: display names cannot establish identity across selective reruns.
export async function latestWorkflowChecks(repo:string,head:string,checks:any[],api:(path:string)=>Promise<any>){
 const groups=new Map<string,any[]>(),result:any[]=[];
 for(const c of checks){if(c.app?.slug!=='github-actions'||c.head_sha!==head){result.push(c);continue;}const g=groups.get(c.name)??[];g.push(c);groups.set(c.name,g);}
 const runs=new Map<string,any>();
 for(const group of groups.values()){
  if(group.length===1){result.push(group[0]);continue;}
  const verified=[];
  for(const c of group){
   const u=new URL(c.details_url),m=u.pathname.match(/\/actions\/runs\/(\d+)\/job\/(\d+)$/);
   if(u.hostname!=='github.com'||!u.pathname.startsWith(`/${repo}/actions/runs/`)||!m)throw Error('Ambiguous check provenance');
   if(!runs.has(m[1]))runs.set(m[1],await api(`repos/${repo}/actions/runs/${m[1]}`));const run=runs.get(m[1]);
   const job=await api(`repos/${repo}/actions/jobs/${m[2]}`);
   if(String(run.id)!==m[1]||run.repository?.full_name!==repo||run.head_sha!==head||!Number.isSafeInteger(run.workflow_id)||!Number.isSafeInteger(run.run_number)||!run.event||String(job.run_id)!==m[1]||String(job.id)!==m[2]||job.head_sha!==head||job.check_run_url!==`https://api.github.com/repos/${repo}/check-runs/${c.id}`||!Number.isSafeInteger(job.run_attempt))throw Error('Incomplete or mismatched check provenance');
   verified.push({check:c,workflow:`${run.workflow_id}:${run.event}:job:${job.id}`,number:run.run_number,attempt:job.run_attempt});
  }
  for(const workflow of new Set(verified.map(x=>x.workflow))){
   const same=verified.filter(x=>x.workflow===workflow),latest=[...same].sort((a,b)=>b.number-a.number||b.attempt-a.attempt)[0];
   result.push(...same.filter(x=>x.number===latest.number&&x.attempt===latest.attempt).map(x=>x.check));
  }
 }
 return result;
}

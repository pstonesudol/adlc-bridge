import {digest} from './core';
// Pinned reviewed producer bytes. Keep runtime packaging independent of patches/.
export const TRUSTED_WORKFLOW_DIGEST='8e8c0aa7b575cbb106854f04a7f6e389c8d0445da4fe7622d7f2be624b24f87e';

export const ATTESTATION_PREFIX='ADLC_METADATA_V1 ';
// Only logs fetched directly from a verified GitHub Actions job are evidence.
// Check output, PR text and arbitrary artifact URLs are never used.
export async function attestMetadataChecks(repo:string,pr:number,head:string,checks:any[],allowed:string[],api:(path:string)=>Promise<any>,logs:(path:string)=>Promise<string>){
 const rows:any[]=[];
 for(const c of checks){
  if(!allowed.includes(c.name)||c.app?.slug!=='github-actions'||c.head_sha!==head)continue;
  const row={name:c.name,checkId:c.id,sha:head,status:c.status,conclusion:c.conclusion,descriptionHash:null as string|null};rows.push(row);
  if(c.status!=='completed'||!['success','failure'].includes(c.conclusion))continue;
  try{
   const url=new URL(c.details_url),match=url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/);
   if(url.origin!=='https://github.com'||url.search||url.hash||!match||match[1]!==repo||!Number.isSafeInteger(c.id)||c.id<1)continue;
   const job=await api(`repos/${repo}/actions/jobs/${match[3]}`);
   if(String(job.id)!==match[3]||String(job.run_id)!==match[2]||job.head_sha!==head||job.name!==c.name||job.status!=='completed'||job.conclusion!==c.conclusion||job.check_run_url!==`https://api.github.com/repos/${repo}/check-runs/${c.id}`||!Number.isSafeInteger(job.run_attempt)||job.run_attempt<1)continue;
   const run=await api(`repos/${repo}/actions/runs/${job.run_id}/attempts/${job.run_attempt}`);
   if(run.id!==job.run_id||run.run_attempt!==job.run_attempt||run.event!=='pull_request_target'||run.repository?.full_name!==repo||run.head_sha!==head||run.check_suite_id!==c.check_suite?.id||!Number.isSafeInteger(run.check_suite_id)||run.status!=='completed'||!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(run.path??''))continue;
   if(!Array.isArray(run.pull_requests)||run.pull_requests.length!==1||run.pull_requests[0].number!==pr||run.pull_requests[0].head?.sha!==head||run.pull_requests[0].url!==`https://api.github.com/repos/${repo}/pulls/${pr}`)continue;
   const base=run.pull_requests[0].base?.sha;
   if(typeof base!=='string'||!/^[a-f0-9]{40}$/.test(base))continue;
   const source=await api(`repos/${repo}/contents/${run.path}?ref=${base}`);
   if(source.encoding!=='base64'||typeof source.content!=='string'||digest(Buffer.from(source.content,'base64').toString('utf8'))!==TRUSTED_WORKFLOW_DIGEST)continue;
   const raw=await logs(`repos/${repo}/actions/jobs/${job.id}/logs`);
   if(raw.length>2_000_000)continue;
   const lines=raw.split(/\r?\n/).map(line=>line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/,'' )).filter(line=>line.startsWith(ATTESTATION_PREFIX));
   if(lines.length!==1)continue;
   const a=JSON.parse(lines[0].slice(ATTESTATION_PREFIX.length));
   if(a.version!==1||a.repository!==repo||a.pr!==pr||a.head!==head||a.runId!==run.id||a.runAttempt!==run.run_attempt||a.workflow!==run.path||a.check!==c.name||a.result!==c.conclusion||typeof a.descriptionHash!=='string'||!/^[a-f0-9]{64}$/.test(a.descriptionHash))continue;
   row.descriptionHash=a.descriptionHash;
  }catch{ /* Missing logs, permission failures and malformed evidence fail closed. */ }
 }
 return rows;
}

// A description-only edit can leave checks for older descriptions on the same
// commit. Supersede only authenticated body-mismatched results, never unknowns
// or same-body duplicates/failures. The current body still requires evidence.
export function currentMetadataChecks(checks:any[],rows:any[],body:string){
 const hash=digest(body);
 return checks.filter(c=>!rows.some(r=>r.checkId===c.id&&r.name===c.name&&r.descriptionHash!==null&&r.descriptionHash!==hash));
}

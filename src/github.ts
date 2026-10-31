import {latestWorkflowChecks} from './check-runs';
import {templateCIFindings,templateSignature} from './pr-template-ci';
import {baseTip} from './branch-updates';
import { reviewGate, digest, type ReviewEvidence } from './core';

async function gh(args: string[]): Promise<any> {
  const p=Bun.spawn(['gh',...args],{stdout:'pipe',stderr:'pipe',timeout:30000});
  const [out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if(code!==0) throw Error(`GitHub read failed (${code})`);
  return JSON.parse(out);
}
async function pages(path: string, key?:string) {
  const data=await gh(['api','--paginate','--slurp',path]);
  if(!Array.isArray(data)) throw Error('Invalid GitHub pagination');
  return data.flatMap((p:any)=> {const items=key?p[key]:p;if(!Array.isArray(items))throw Error('Incomplete GitHub response');return items;});
}
export function effectiveBotReview(reviews:any[]) {
  return reviews.filter(r=>r.user?.login==='coderabbitai[bot]'&&['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state))
    .sort((a,b)=>Date.parse(a.submitted_at)-Date.parse(b.submitted_at)).at(-1);
}
export function metadataFindings(review:any,head:string,comments:any[]){
 if(review?.commit_id!==head||review?.state!=='CHANGES_REQUESTED'||!review.body?.includes('Pre-merge checks failed'))return [];
 const bot=comments.filter(c=>c.user?.login==='coderabbitai[bot]').sort((a,b)=>Date.parse(a.updated_at)-Date.parse(b.updated_at)).at(-1);
 const body=bot?.body??'';
 if(!/\|\s*Verification Evidence\s*\|[^\n]*!\[Error\]/i.test(body))return [];
 const match=body.match(/<summary><strong>Full details: Verification Evidence<\/strong><\/summary>([\s\S]*?)<\/details>/i);
 if(!match)return [];
 return [{kind:'pr_description',path:null,sha:head,body:match[1].replace(/<[^>]*>/g,'').trim().slice(0,10000)}];
}
export async function readiness(repo:string, number:number, required:string[],metadataChecks:string[]=[]) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number<1)throw Error('Valid owner/repository and PR number required');
  required=[...new Set([...required,...metadataChecks])];
  const base=`repos/${repo}`;
  const first=await gh(['api',`${base}/pulls/${number}`]);
  if(first.state!=='open')throw Error('PR is not open');
  const [rawChecks,reviews]=await Promise.all([pages(`${base}/commits/${first.head.sha}/check-runs?per_page=100`,'check_runs'),pages(`${base}/pulls/${number}/reviews?per_page=100`)]);
  const checks=await latestWorkflowChecks(repo,first.head.sha,rawChecks,path=>gh(['api',path]));
  const [owner,name]=repo.split('/'); let after:string|null=null;const cursors=new Set();let unresolved=0;
  const findings:any[]=[];
  do {
    const query=`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved isOutdated path comments(first:100){nodes{body author{login} originalCommit{oid}} pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}}}`;
    const args=['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${number}`];
    if(after)args.push('-f',`after=${after}`);
    const result=await gh(args);
    const threads=result.data?.repository?.pullRequest?.reviewThreads;
    if(result.errors || !threads?.pageInfo || !Array.isArray(threads.nodes))throw Error('Incomplete review threads');
    for(const t of threads.nodes){
      if(typeof t.isResolved!=='boolean')throw Error('Invalid review thread');
      if(!t.isResolved){
        unresolved++;
        if(!Array.isArray(t.comments?.nodes)||t.comments.pageInfo?.hasNextPage!==false)throw Error('Incomplete thread comments');
        for(const c of t.comments.nodes)if(c.author?.login==='coderabbitai' || c.author?.login==='coderabbitai[bot]'){
          if(!t.isOutdated&&c.originalCommit?.oid===first.head.sha)findings.push({path:t.path,body:c.body,sha:first.head.sha});
        }
      }
    }
    if(!threads.pageInfo.hasNextPage)break;
    after=threads.pageInfo.endCursor;
    if(!after || cursors.has(after))throw Error('Invalid thread cursor');cursors.add(after);
  }while(true);
  // A later COMMENTED review does not revoke an earlier approval. A real
  // change request or dismissal does; approval still must match the PR head.
  const latest=effectiveBotReview(reviews);
  if(latest?.state==='CHANGES_REQUESTED'&&latest.commit_id===first.head.sha){
    const comments=await pages(`${base}/issues/${number}/comments?per_page=100`);
    findings.push(...metadataFindings(latest,first.head.sha,comments));
  }
  const currentBase=await baseTip(repo,first.base.ref);
  const comparison=await gh(['api',`${base}/compare/${currentBase}...${first.head.sha}`]);
  if(!Number.isSafeInteger(comparison.behind_by)||comparison.behind_by<0)throw Error('Incomplete base branch comparison');
  const final=await gh(['api',`${base}/pulls/${number}`]);
  const evidence:ReviewEvidence={head:first.head.sha,observedHead:final.head.sha,required,
    checks:checks.map((c:any)=>({name:c.name,sha:c.head_sha,app:c.app?.slug,status:c.status,conclusion:c.conclusion})),
    review:latest?{sha:latest.commit_id,author:latest.user.login,state:latest.state}:null,
    unresolved,threadsComplete:true,checksComplete:true,reviewComplete:true};
  const gate=reviewGate(evidence);
  if(comparison.behind_by>0){gate.clear=false;gate.reasons.push('Feature branch is behind base');}
  if(final.base.ref!==first.base.ref||await baseTip(repo,final.base.ref)!==currentBase){gate.clear=false;gate.reasons.push('Base branch changed during review collection');}
  if(final.state!=='open' || final.draft || final.mergeable!==true){gate.clear=false;gate.reasons.push('PR closed, draft, conflicted or mergeability unknown');}
  const requiredChecks=checks.filter((c:any)=>required.includes(c.name)&&c.head_sha===first.head.sha&&c.app?.slug==='github-actions');
  const failedChecks=requiredChecks.filter((c:any)=>c.status==='completed'&&!['success','neutral','skipped'].includes(c.conclusion)).map((c:any)=>({name:c.name,conclusion:c.conclusion,url:c.details_url}));
  const pendingChecks=requiredChecks.filter((c:any)=>c.status!=='completed').map((c:any)=>c.name);
  const missingChecks=required.filter(n=>!requiredChecks.some((c:any)=>c.name===n));
  const metadataFindingsCI=await templateCIFindings(repo,first.head.sha,checks,metadataChecks,digest(final.body??''),path=>gh(['api',path]),async path=>{
   const p=Bun.spawn(['gh','api',path,'--allow-escape-sequences'],{stdout:'pipe',stderr:'pipe',timeout:30000});
   const [out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   if(code!==0)throw Error('Template-check logs unavailable');return out;
  });
  findings.push(...metadataFindingsCI);
  const botChecks=checks.filter((c:any)=>c.app?.slug==='coderabbitai'&&c.head_sha===first.head.sha);
  return {url:final.html_url,head:evidence.head,...gate,unresolved,findings,failedChecks,pendingChecks,missingChecks,
    botReviewSubmittedAt:latest?Date.parse(latest.submitted_at):null,templateSignature:templateSignature(checks,first.head.sha,metadataChecks),branchBehind:comparison.behind_by,base:currentBase,coderabbitPresent:botChecks.length>0||!!latest,coderabbitPending:botChecks.some((c:any)=>c.status!=='completed'),descriptionHash:digest(final.body??''),mergeEnabled:false};
}

// Observation only. This function cannot merge or modify a PR.
export async function prLifecycle(repo:string,pr:number){
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1)throw Error('Valid PR required');
 const b=await gh(['api',`repos/${repo}/pulls/${pr}`]);return {state:b.state,merged:b.merged===true};
}

import {latestWorkflowChecks,checkState} from './check-runs';
import {githubRead,ReadValidationError} from './provider-read';
import {templateLogReader} from './gh-logs';
import {templateCIFindings,templateSignature,metadataBodyCovered} from './pr-template-ci';
import {attestMetadataChecks,currentMetadataChecks} from './metadata-attestation';
import {baseTip} from './branch-updates';
import { reviewGate, digest, type ReviewEvidence } from './core';
import {BODY_VERSION_QUERY,customCheckEvidence} from './coderabbit-checks';
import {collectReviewSchedule} from './coderabbit-scheduling';
import {reviewerPolicy,authenticatedReviewer,invalidateExpiredReviewerFindings,type ReviewerConfig} from './reviewer-policy';
import {configuredReviewEvidence} from './github-reviewers';

async function gh(args: string[]): Promise<any> {
  return githubRead(args,'review-read');
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
const REVIEW_COMMENT_FIELDS='id body updatedAt author{login __typename ... on Bot{databaseId} ... on User{databaseId}} originalCommit{oid}';
const REVIEW_THREAD_FIELDS=`id isResolved isOutdated path line startLine comments(first:100){nodes{${REVIEW_COMMENT_FIELDS}}pageInfo{hasNextPage endCursor}}`;
export const REVIEW_THREADS_QUERY=`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{${REVIEW_THREAD_FIELDS}}pageInfo{hasNextPage endCursor}}}}}`;
export const REVIEW_THREAD_COMMENTS_QUERY=`query($id:ID!,$after:String){node(id:$id){... on ReviewThread{comments(first:100,after:$after){nodes{${REVIEW_COMMENT_FIELDS}}pageInfo{hasNextPage endCursor}}}}}`;
export type ReviewComment={id:string;login:string;bot:boolean;originalCommit:string|null;body:string;original?:any};
export type ReviewThread={id:string;path:string;line:number|null;startLine:number|null;isResolved:boolean;isOutdated:boolean;comments:ReviewComment[]};
export type ReviewFeedbackCandidate={threadId:string;path:string;line:number|null;commentIds:string[];commentsHash:string;body:string;originalCommit:string|null;outdated:false};
export type ReviewThreadSummary={unresolved:number;resolved:number;candidates:ReviewFeedbackCandidate[];stale:{threadId:string;path:string;commentIds:string[]}[];humanOnly:{threadId:string;path:string}[]};
// GitHub reserves the [bot] login suffix for app installations; a human
// account named "coderabbitai" is not the reviewer. Accept the legacy bot login
// only when GitHub itself reports the author as a Bot.
function reviewComment(node:any):ReviewComment{
 if(typeof node?.id!=='string'||!node.id)throw Error('Invalid review comment');
 // GitHub retains comments from deleted accounts with an explicit null author.
 const login=node.author===null?'':node.author?.login;
 if(typeof login!=='string'||(node.author!==null&&!login))throw Error('Invalid review comment author');
 const body=typeof node.body==='string'?node.body:'';
 return {id:node.id,login,bot:login==='coderabbitai[bot]'||login==='coderabbitai'&&node.author?.__typename==='Bot',originalCommit:typeof node.originalCommit?.oid==='string'?node.originalCommit.oid:null,body,original:node};
}
export function normalizeReviewThread(node:any,extra:any[]=[]):ReviewThread{
 if(typeof node?.id!=='string'||!node.id||typeof node.isResolved!=='boolean'||typeof node.isOutdated!=='boolean'||typeof node.path!=='string'||!node.path)throw Error('Invalid review thread');
 if(!Array.isArray(node.comments?.nodes)||!node.comments.pageInfo)throw Error('Incomplete thread comments');
 const seen=new Set<string>();const comments:ReviewComment[]=[];
 for(const raw of [...node.comments.nodes,...extra]){const c=reviewComment(raw);if(seen.has(c.id))continue;seen.add(c.id);comments.push(c);}
 return {id:node.id,path:node.path,line:Number.isSafeInteger(node.line)?node.line:null,startLine:Number.isSafeInteger(node.startLine)?node.startLine:null,isResolved:node.isResolved,isOutdated:node.isOutdated,comments};
}
// Resolution and outdated state are independent. An unresolved thread mapped to
// current code is a validation candidate even when its comments keep an older
// originalCommit; only an explicitly outdated thread is excluded as ambiguous.
export function reviewThreadEvidence(threads:ReviewThread[]):ReviewThreadSummary{
 const candidates:ReviewFeedbackCandidate[]=[],stale:ReviewThreadSummary['stale']=[],humanOnly:ReviewThreadSummary['humanOnly']=[];
 const resolved=threads.filter(t=>t.isResolved).length;
 const unresolved=threads.filter(t=>!t.isResolved);
 for(const t of unresolved){
  const bot=t.comments.filter(c=>c.bot);
  if(!bot.length){humanOnly.push({threadId:t.id,path:t.path});continue;}
  const commentIds=[...new Set(bot.map(c=>c.id))].sort();
  if(t.isOutdated){stale.push({threadId:t.id,path:t.path,commentIds});continue;}
  const commits=[...new Set(bot.map(c=>c.originalCommit).filter((x):x is string=>!!x))].sort();
  candidates.push({threadId:t.id,path:t.path,line:t.line,commentIds,commentsHash:digest(commentIds.join(',')),body:bot.map(c=>c.body).join('\n\n').slice(0,10000),originalCommit:commits.length===1?commits[0]:commits.length?commits.join(','):null,outdated:false});
 }
 candidates.sort((a,b)=>a.path===b.path?a.threadId.localeCompare(b.threadId):a.path.localeCompare(b.path));
 stale.sort((a,b)=>a.path===b.path?a.threadId.localeCompare(b.threadId):a.path.localeCompare(b.path));
 humanOnly.sort((a,b)=>a.path===b.path?a.threadId.localeCompare(b.threadId):a.path.localeCompare(b.path));
 return {unresolved:unresolved.length,resolved,candidates,stale,humanOnly};
}
export function reviewThreadFindings(summary:ReviewThreadSummary,head:string){
 return summary.candidates.map(c=>({source:'github-review',kind:'review_thread',threadId:c.threadId,path:c.path,line:c.line,body:c.body,sha:head,originalCommit:c.originalCommit,commentIds:c.commentIds,commentsHash:c.commentsHash,outdated:false}));
}
export function coderabbitRateLimited(checks:any[],head:string){
 return checks.some((c:any)=>c?.app?.slug==='coderabbitai'&&c.head_sha===head&&/rate[\s_-]?limit/i.test(`${c.output?.title??''} ${c.output?.summary??''} ${c.output?.text??''}`));
}
export function metadataFindings(...args:Parameters<typeof customCheckEvidence>){return customCheckEvidence(...args).findings;}
export function requiredCheckState(checks:any[],head:string,required:string[]){
 const current=latestWorkflowChecks(checks).filter(c=>required.includes(c.name)&&c.head_sha===head&&c.app?.slug==='github-actions');
 return {
  failedChecks:current.filter(c=>checkState(c)==='failure').map(c=>({id:c.id,sha:c.head_sha,name:c.name,conclusion:c.conclusion,url:c.details_url})),
  pendingChecks:[...new Set(current.filter(c=>checkState(c)==='pending'||current.filter(other=>other.name===c.name).length!==1).map(c=>c.name))],
  missingChecks:required.filter(n=>!current.some(c=>c.name===n))
 };
}
export async function readiness(repo:string, number:number, required:string[],metadataChecks:string[]=[],reviewers?:ReviewerConfig[]) {
  const reviewerConfiguration=reviewerPolicy(reviewers);
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number<1)throw Error('Valid owner/repository and PR number required');
  required=[...new Set([...required,...metadataChecks])];
  const base=`repos/${repo}`;
  const first=await gh(['api',`${base}/pulls/${number}`]);
  if(first.state!=='open')throw new ReadValidationError();
  const [rawChecks,reviews]=await Promise.all([pages(`${base}/commits/${first.head.sha}/check-runs?per_page=100`,'check_runs'),pages(`${base}/pulls/${number}/reviews?per_page=100`)]);
  let checks=latestWorkflowChecks(rawChecks);
  const [owner,name]=repo.split('/'); let after:string|null=null;const cursors=new Set();
  const threads:ReviewThread[]=[];
  const findings:any[]=[];
  do {
    const args=['api','graphql','-f',`query=${REVIEW_THREADS_QUERY}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${number}`];
    if(after)args.push('-f',`after=${after}`);
    const result=await gh(args);
    const page=result.data?.repository?.pullRequest?.reviewThreads;
    if(result.errors || !page?.pageInfo || !Array.isArray(page.nodes))throw Error('Incomplete review threads');
    for(const node of page.nodes){
      if(!Array.isArray(node?.comments?.nodes)||!node.comments.pageInfo)throw Error('Incomplete thread comments');
      const extra:any[]=[];let commentAfter:string|null=node.comments.pageInfo.endCursor??null;const commentCursors=new Set<string>();
      while(node.comments.pageInfo.hasNextPage){
        if(!commentAfter||commentCursors.has(commentAfter))throw Error('Invalid thread cursor');
        commentCursors.add(commentAfter);
        // Nested comment pagination is authoritative too: a truncated thread
        // can hide the reviewer comment that makes a carried thread actionable.
        const pageResult=await gh(['api','graphql','-f',`query=${REVIEW_THREAD_COMMENTS_QUERY}`,'-f',`id=${node.id}`,'-f',`after=${commentAfter}`]);
        const comments=pageResult.data?.node?.comments;
        if(pageResult.errors||!comments?.pageInfo||!Array.isArray(comments.nodes))throw Error('Incomplete thread comments');
        extra.push(...comments.nodes);
        node.comments.pageInfo=comments.pageInfo;
        commentAfter=comments.pageInfo.endCursor??null;
      }
      threads.push(normalizeReviewThread(node,extra));
    }
    if(!page.pageInfo.hasNextPage)break;
    after=page.pageInfo.endCursor;
    if(!after || cursors.has(after))throw Error('Invalid thread cursor');cursors.add(after);
  }while(true);
  const reviewThreadSummary=reviewThreadEvidence(threads);
  const unresolved=reviewThreadSummary.unresolved;
  // A later COMMENTED review does not revoke an earlier approval. A real
  // change request or dismissal does; approval still must match the PR head.
  const latest=effectiveBotReview(reviews);
  const comments=await pages(`${base}/issues/${number}/comments?per_page=100`);
  const reviewerEvidence=await configuredReviewEvidence(reviewerConfiguration,repo,first,threads,reviews,comments,gh);
  findings.push(...reviewerEvidence.findings);
  // Only authenticated CodeRabbit data may enter its existing custom gate.
  const trustedLatest=effectiveBotReview(reviewerEvidence.trustedReviews);
  let version:any;
  if(comments.some(c=>c.user?.login==='coderabbitai[bot]'&&(c.body??'').includes('<!-- pre_merge_checks_walkthrough_start -->'))){
   const result=await gh(['api','graphql','-f',`query=${BODY_VERSION_QUERY}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${number}`]);
   if(!result.errors)version=result.data?.repository?.pullRequest;
  }
  const currentBase=await baseTip(repo,first.base.ref);
  const comparison=await gh(['api',`${base}/compare/${currentBase}...${first.head.sha}`]);
  if(!Number.isSafeInteger(comparison.behind_by)||comparison.behind_by<0)throw Error('Incomplete base branch comparison');
  let final=await gh(['api',`${base}/pulls/${number}`]);
  const bodyEvidence=await attestMetadataChecks(repo,number,first.head.sha,checks,metadataChecks,path=>gh(['api',path]),templateLogReader());
  // Recheck after collecting evidence too: description edits do not change SHA.
  const observed=metadataChecks.length?await gh(['api',`${base}/pulls/${number}`]):final;
  const changed=first.body!==final.body||final.body!==observed.body||first.head.sha!==final.head.sha||first.head.sha!==observed.head.sha;
  if(changed)for(const row of bodyEvidence)row.descriptionHash=null;
  final=observed;
  checks=currentMetadataChecks(checks,bodyEvidence,final.body??'');
  const evidence:ReviewEvidence={head:first.head.sha,observedHead:final.head.sha,required,
    checks:checks.map((c:any)=>({id:c.id,started_at:c.started_at,completed_at:c.completed_at,name:c.name,sha:c.head_sha,app:c.app?.slug,status:c.status,conclusion:c.conclusion})),
    review:trustedLatest?{sha:trustedLatest.commit_id,author:trustedLatest.user.login,state:trustedLatest.state}:null,
    unresolved:threads.filter(t=>!t.isResolved&&!reviewerEvidence.ignoredThreadIds.includes(t.id)).length,threadsComplete:true,checksComplete:true,reviewComplete:true};
  const gate=reviewGate(evidence);
  const rabbit=reviewerConfiguration.find(r=>r.id==='coderabbit')!;
  const trustedComments=comments.filter(c=>authenticatedReviewer(rabbit,reviewerEvidence.trust.find(t=>t.reviewer==='coderabbit'),c.user?.id??null,c.user?.type));
  const custom=customCheckEvidence(trustedLatest,first.head.sha,trustedComments,{repo,pr:number,body:final.body??'',version,checks});
  if(reviewerEvidence.blockers.length){gate.clear=false;gate.reasons.push(...reviewerEvidence.blockers);}
  if(reviewerEvidence.findings.length||reviewerEvidence.pending.length){gate.clear=false;gate.reasons.push('Configured reviewer findings remain unresolved');}
  if(changed){custom.findings=[];custom.bodyReviewed=false;custom.blocker='PR head or description changed during custom-check collection';}
  findings.push(...custom.findings);
  if(custom.blocker||custom.findings.length){gate.clear=false;gate.reasons.push(custom.blocker??'Actionable CodeRabbit Verification Evidence failure');}
  if(comparison.behind_by>0){gate.clear=false;gate.reasons.push('Feature branch is behind base');}
  if(final.base.ref!==first.base.ref||await baseTip(repo,final.base.ref)!==currentBase){gate.clear=false;gate.reasons.push('Base branch changed during review collection');}
  if(final.state!=='open' || final.draft || final.mergeable!==true){gate.clear=false;gate.reasons.push('PR closed, draft, conflicted or mergeability unknown');}
   const {failedChecks,pendingChecks,missingChecks}=requiredCheckState(checks,first.head.sha,required);
    const currentBodyEvidence=bodyEvidence.filter(row=>checks.some(c=>c.id===row.checkId));
    const descriptionHash=digest(final.body??'');
    if(metadataChecks.length&&!metadataBodyCovered({head:first.head.sha,descriptionHash,metadataCheckEvidence:currentBodyEvidence},metadataChecks)){
     gate.clear=false;gate.reasons.push('Missing body-bound success evidence for every configured metadata check');
    }
    const metadataFindingsCI=await templateCIFindings(repo,first.head.sha,checks,metadataChecks,descriptionHash,path=>gh(['api',path]),templateLogReader(),currentBodyEvidence);
  findings.push(...metadataFindingsCI);
  const botChecks=checks.filter((c:any)=>c.app?.slug==='coderabbitai'&&c.head_sha===first.head.sha);
  const reviewSchedule=await collectReviewSchedule(repo,final,currentBase,comments,reviews,checks,gh);
  const scheduleFinal=await gh(['api',`${base}/pulls/${number}`]);
  if(scheduleFinal.head?.sha!==final.head.sha||scheduleFinal.base?.ref!==final.base.ref||scheduleFinal.body!==final.body||scheduleFinal.draft!==final.draft||scheduleFinal.state!=='open'||await baseTip(repo,final.base.ref)!==currentBase)reviewSchedule.blocker='CodeRabbit review unavailable: PR or base changed during configuration collection';
  if(reviewSchedule.blocker){gate.clear=false;gate.reasons.push(reviewSchedule.blocker);}
  if(final.head.sha!==first.head.sha){gate.clear=false;reviewSchedule.blocker='CodeRabbit review unavailable: head changed during collection';}
  invalidateExpiredReviewerFindings(reviewerEvidence);
  const actionable=new Set(reviewerEvidence.findings);
  for(let i=findings.length-1;i>=0;i--)if(findings[i].source==='github-review'&&!actionable.has(findings[i]))findings.splice(i,1);
  if(reviewerEvidence.trust.some(t=>t.reviewer==='coderabbit'&&!t.fresh))for(let i=findings.length-1;i>=0;i--)if(findings[i].source==='coderabbit-custom')findings.splice(i,1);
  for(const trust of reviewerEvidence.trust){if(!trust.fresh){gate.clear=false;gate.reasons.push(`Reviewer ${trust.reviewer}: trust evidence expired during collection; refresh before clearance`);}}
  return {url:final.html_url,head:evidence.head,...gate,unresolved,findings,failedChecks,pendingChecks,missingChecks,reviewerEvidence,
    reviewSchedule,requestComments:comments.map(c=>({id:c.id,body:c.body,created:c.created_at,author:c.user?.login})),
    descriptionVersion:version?.body===(final.body??'')&&version?.headRefOid===final.head.sha?digest(JSON.stringify([descriptionHash,version.createdAt,version.lastEditedAt])):null,
    coderabbitBodyReviewed:custom.bodyReviewed,customCheckBlocker:custom.blocker,reviewThreads:reviewThreadSummary,coderabbitRateLimited:coderabbitRateLimited(checks,first.head.sha),
     reviewEvidenceVersion:digest(JSON.stringify([trustedLatest,trustedComments.filter(c=>(c.body??'').includes('<!-- pre_merge_checks_walkthrough_start -->')).map(c=>[c.id,c.updated_at,c.body]),version,botChecks.map(c=>[c.id,c.head_sha,c.status,c.conclusion,c.started_at,c.completed_at])])),
    metadataCheckEvidence:currentBodyEvidence,
     botReviewSubmittedAt:latest?Date.parse(latest.submitted_at):null,templateSignature:templateSignature(checks,first.head.sha,metadataChecks),branchBehind:comparison.behind_by,base:currentBase,coderabbitPresent:botChecks.length>0||!!latest,coderabbitPending:botChecks.some((c:any)=>c.status!=='completed'),descriptionHash,mergeEnabled:false};
}

// Observation only. This function cannot merge or modify a PR.
export async function prLifecycle(repo:string,pr:number){
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1)throw Error('Valid PR required');
 const b=await gh(['api',`repos/${repo}/pulls/${pr}`]);return {state:b.state,merged:b.merged===true};
}

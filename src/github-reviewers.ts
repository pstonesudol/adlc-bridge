import {authenticatedReviewer,collectTrustedFeedback,reviewerApprovals,reviewerTrust,type GitHubReader,type NormalizedFeedback,type Reviewer} from './reviewer-policy';
import type {ReviewThread} from './github';

/** Generic GitHub adapter: standard submitted reviews and mapped review threads.
 * Bot summary/check text is not a review finding. Human issue/review comments are
 * requirements data, not commands. Custom provider APIs need separate adapters. */
export async function configuredReviewEvidence(policy:Reviewer[],repo:string,pr:any,threads:ReviewThread[],reviews:any[],comments:any[],read:GitHubReader){
 const actor=await read(['api','user']);
 if(!Number.isSafeInteger(actor?.id)||!Number.isSafeInteger(pr.user?.id))throw Error('Authenticated executing/PR author identity unavailable');
 const selfIds=[actor.id,pr.user.id];
 const feedback:NormalizedFeedback[]=[];
 const files=await read(['api','--paginate','--slurp',`repos/${repo}/pulls/${pr.number}/files?per_page=100`]);
 if(!Array.isArray(files)||files.some(p=>!Array.isArray(p))||files.flat().length!==pr.changed_files||files.flat().length>=3000)throw Error('Reviewer changed-path evidence incomplete');
 const inventory=files.flat();
 for(const t of threads){
  const file=inventory.find(f=>f.filename===t.path||f.previous_filename===t.path);
  for(const c of t.comments){
   const original=(c as any).original;
   feedback.push({id:c.id,threadId:t.id,body:c.body,userId:original?.author?.databaseId??null,type:original?.author?.__typename??'',login:c.login,path:t.path,previousPath:file?.previous_filename??null,line:t.line,originalCommit:c.originalCommit,outdated:t.isOutdated,resolved:t.isResolved,original});
  }
 }
 for(const r of reviews){
  if(!['COMMENTED','CHANGES_REQUESTED'].includes(r.state)||!r.body?.trim()||r.user?.type!=='User')continue;
  // Superseded/dismissed reviews do not resurrect their old summary bodies.
  if(reviews.some(v=>v.user?.id===r.user?.id&&['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(v.state)&&Date.parse(v.submitted_at)>Date.parse(r.submitted_at)))continue;
  feedback.push({id:String(r.id),threadId:`review:${r.id}`,body:r.body,userId:r.user?.id??null,type:r.user?.type,login:r.user?.login??'',path:null,line:null,originalCommit:r.commit_id??null,outdated:r.commit_id!==pr.head.sha,resolved:false,original:r});
 }
 for(const c of comments){
  // Bot issue comments generally contain summaries/control commands. No generic
  // adapter can infer actionable findings from those provider-specific formats.
  if(c.user?.type!=='User'||!c.body?.trim())continue;
  feedback.push({id:String(c.id),threadId:`comment:${c.id}`,body:c.body,userId:c.user.id,type:'User',login:c.user.login,path:null,line:null,originalCommit:pr.head.sha,outdated:false,resolved:false,original:c});
 }
 const trust=await reviewerTrust(policy,repo,read);
 const now=Date.now(),acknowledged:any[]=[];
 const active=feedback.filter(f=>{
  if(!f.threadId.startsWith('comment:')||f.type!=='User'||selfIds.includes(f.userId??-1))return true;
  if(!policy.some(r=>authenticatedReviewer(r,trust.find(t=>t.reviewer===r.id),f.userId,f.type,now)))return true;
  const substantive=reviews.filter(r=>r.user?.id===f.userId&&r.user?.type==='User'&&['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state)).sort((a,b)=>Date.parse(a.submitted_at)-Date.parse(b.submitted_at));
  const latest=substantive.at(-1),version=Date.parse(f.original.updated_at??f.original.created_at);
  if(substantive.some(r=>!Number.isFinite(Date.parse(r.submitted_at)))||substantive.some(r=>r.state!=='APPROVED'&&r.submitted_at===latest?.submitted_at))return true;
  // The same authenticated author's later, current-head explicit approval
  // acknowledges only preceding issue-comment versions. Edits, stale heads,
  // dismissal and subsequent change requests reopen the finding.
  if(latest?.state!=='APPROVED'||latest.commit_id!==pr.head.sha||!Number.isFinite(version)||!Number.isFinite(Date.parse(latest.submitted_at))||Date.parse(latest.submitted_at)<=version)return true;
  acknowledged.push({id:f.id,threadId:f.threadId,userId:f.userId,head:pr.head.sha,reviewId:latest.id,commentVersion:version,original:f.original,review:latest});return false;
 });
 const collected=collectTrustedFeedback(policy,trust,active,{repo,pr:pr.number,head:pr.head.sha,selfIds},now);
 const approvals=reviewerApprovals(policy,trust,reviews,pr.head.sha,selfIds,now);
 // Unknown/untrusted unresolved threads continue to block via the legacy gate.
 // Record the missing evidence without preventing unrelated eligible feedback.
 const blockers=[...approvals.blockers,...collected.pending.filter(p=>p.category==='unclassified').map(p=>`Reviewer ${p.reviewer}: unclassified finding ${p.id}; exact clarification required`)];
 const trustedReviews=reviews.filter(v=>policy.some(r=>authenticatedReviewer(r,trust.find(t=>t.reviewer===r.id),v.user?.id??null,v.user?.type,now)));
 return {...collected,acknowledged,approvals:approvals.status,blockers,trustedReviews};
}

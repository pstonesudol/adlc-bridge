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
 const now=Date.now(),collected=collectTrustedFeedback(policy,trust,feedback,{repo,pr:pr.number,head:pr.head.sha,selfIds},now);
 const approvals=reviewerApprovals(policy,trust,reviews,pr.head.sha,selfIds,now);
 // Unknown/untrusted unresolved threads continue to block via the legacy gate.
 // Record the missing evidence without preventing unrelated eligible feedback.
 const blockers=[...approvals.blockers,...collected.pending.filter(p=>p.category==='unclassified').map(p=>`Reviewer ${p.reviewer}: unclassified finding ${p.id}; exact clarification required`)];
 const trustedReviews=reviews.filter(v=>policy.some(r=>authenticatedReviewer(r,trust.find(t=>t.reviewer===r.id),v.user?.id??null,v.user?.type,now)));
 return {...collected,approvals:approvals.status,blockers,trustedReviews};
}

import {digest} from './core';

export const BODY_VERSION_QUERY='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){body headRefOid createdAt lastEditedAt}}}';
export function customCheckSection(body:string){
 const start='<!-- pre_merge_checks_walkthrough_start -->',end='<!-- pre_merge_checks_walkthrough_end -->';
 if(body.split(start).length!==2||body.split(end).length!==2||body.indexOf(end)<body.indexOf(start))return null;
 return body.split(start)[1].split(end)[0];
}
const bot=(user:any)=>user?.login==='coderabbitai[bot]'&&user?.type==='Bot'&&Number.isSafeInteger(user.id);
const time=(value:any)=>typeof value==='string'?Date.parse(value):NaN;
/** Relevance for remediation, NOT a CI attestation or an approval. A mutable
 * summary must belong to the same completed run as the current change request.
 * PR lastEditedAt is obtained from GitHub, never guessed from updated_at. */
export function customCheckEvidence(review:any,head:string,comments:any[],context?:{repo:string;pr:number;body:string;version:any;checks:any[]}){
 const empty={findings:[] as any[],blocker:null as string|null,bodyReviewed:false};
 const summaries=comments.filter(c=>bot(c.user)&&typeof c.body==='string'&&c.body.includes('<!-- pre_merge_checks_walkthrough_start -->'));
 if(!summaries.length)return review?.state==='CHANGES_REQUESTED'&&/Pre-merge checks failed/i.test(review.body??'')?{...empty,blocker:'CodeRabbit custom-check details are missing; obtain the complete current bot summary'}:empty;
 // Never choose a random newer bot reply or silently fall back to an old summary.
 if(summaries.length!==1)return {...empty,blocker:'CodeRabbit custom-check summary provenance is ambiguous'};
 const summary=summaries[0],section=customCheckSection(summary.body);
 if(!section)return {...empty,blocker:'CodeRabbit custom-check section is incomplete'};
 const errors=section.split('\n').filter(l=>/^\s*\|/.test(l)&&/!\[Error\]/i.test(l));
 const blocked=(reason:string)=>({...empty,blocker:errors.length?`CodeRabbit custom-check failure: ${reason}`:null});
 if(context?.checks.some(c=>c.app?.slug==='coderabbitai'&&c.head_sha===head&&c.status!=='completed'))return empty;
 if(!context||!bot(review?.user)||review.user.id!==summary.user.id||!['APPROVED','CHANGES_REQUESTED'].includes(review.state)||review.commit_id!==head||!Number.isSafeInteger(review.id)||!Number.isSafeInteger(summary.id))return blocked('current bot review provenance is unavailable');
 const {repo,pr,version,checks,body}=context;
 if(version?.headRefOid!==head||version.body!==body||!Number.isFinite(time(version.createdAt))||!(version.lastEditedAt===null||Number.isFinite(time(version.lastEditedAt))))return blocked('current description version is unavailable');
 const runs=checks.filter(c=>c.app?.slug==='coderabbitai'&&c.head_sha===head&&c.name==='CodeRabbit');
 if(runs.length!==1)return blocked('review run is ambiguous');
 const run=runs[0],start=time(run.started_at),end=time(run.completed_at),submitted=time(review.submitted_at),edited=time(summary.updated_at);
 if(run.status!=='completed'||!Number.isSafeInteger(run.id)||![start,end,submitted,edited].every(Number.isFinite)||end<start||submitted<start||submitted>end||edited<start||edited>end||time(version.lastEditedAt??version.createdAt)>start)return blocked('summary or description changed outside the current completed review run');
 const recentStart='<!-- recent_review_start -->',recentEnd='<!-- recent_review_end -->';
 const recent=summary.body.split(recentStart).length===2&&summary.body.split(recentEnd).length===2&&summary.body.indexOf(recentEnd)>summary.body.indexOf(recentStart)?summary.body.split(recentStart)[1].split(recentEnd)[0]:null;
 const commits=recent?[...recent.matchAll(/\*\*Commit\*\*:\s*\[[^\]]+\]\(<https:\/\/github\.com\/([^/]+\/[^/]+)\/commit\/([a-f0-9]{40})>\)/g)]:[];
 if(commits.length!==1||commits[0][1]!==repo||commits[0][2]!==head||summary.issue_url!==`https://api.github.com/repos/${repo}/issues/${pr}`)return blocked('summary run does not identify this PR and head');
 if(!errors.length)return {...empty,bodyReviewed:true}; // Not approval: the explicit review gate still applies.
 if(review.state!=='CHANGES_REQUESTED'||!/Pre-merge checks failed/i.test(review.body??''))return blocked('custom errors contradict the current review');
 if(errors.length!==1||!/^\s*\|\s*Verification Evidence\s*\|/i.test(errors[0]))return blocked('an unsupported custom check requires a scoped decision');
 const marker=/<summary>\s*<strong>Full details: Verification Evidence<\/strong>\s*<\/summary>/ig;
 const matches=[...section.matchAll(marker)];
 if(matches.length!==1)return blocked('full Verification Evidence explanation/resolution is missing or ambiguous');
 const tail=section.slice(matches[0].index!+matches[0][0].length);
 let depth=0,endDetails=-1;
 for(const tag of tail.matchAll(/<\/?details\b[^>]*>/ig)){
  if(/^<\/details/i.test(tag[0])){if(depth===0){endDetails=tag.index!;break;}depth--;}
  else depth++;
 }
 const details=endDetails<0?'':tail.slice(0,endDetails).trim();
 if(!details||details.length>60000||/(?:\u2026|\.\.\.|\[(?:truncated|incomplete)\])(?:\s*<\/[^>]+>|\s*\*\*)*\s*$/i.test(details)||!details.replace(/<[^>]*>/g,'').trim()||! /\*\*Explanation\*\*/i.test(details)||! /\*\*Resolution\*\*/i.test(details))return blocked('full Verification Evidence explanation/resolution is missing or truncated');
 const descriptionHash=digest(body),evidenceHash=digest(JSON.stringify([review.id,summary.id,summary.updated_at,summary.body,run.id,head,descriptionHash]));
 return {blocker:null,bodyReviewed:true,findings:[{source:'coderabbit-custom',kind:'pr_description',path:null,sha:head,descriptionHash,reviewId:review.id,commentId:summary.id,checkId:run.id,evidenceHash,body:`${errors[0]}\n\n${details}`} ]};
}

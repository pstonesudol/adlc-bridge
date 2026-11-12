import {Store,digest} from './core';
import {RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';
import {providerEvidence} from './provider-read';
import {transient} from './recovery-observation';
import {cooldownPolicy,type CooldownPolicy} from './coderabbit-cooldowns';

export type Severity='info'|'low'|'medium'|'high'|'critical';
export type ReviewerIdentity={userId:number;type:'Bot'|'User';login?:string};
export type ReviewerConfig={id:string;adapter:'github-review'|'coderabbit';identity?:ReviewerIdentity;
 membership?:{kind:'collaborators'}|{kind:'team';organization:string;slug:string};
 enabled?:boolean;remediate?:boolean;approvalRequired?:boolean;minimumSeverity?:Severity;
 includePaths?:string[];excludePaths?:string[];requestReview?:boolean;reviewMode?:'regular'|'full';cooldown?:number;retryLimit?:number;rateLimit?:Partial<CooldownPolicy>};
export type Reviewer=ReviewerConfig&{enabled:boolean;remediate:boolean;approvalRequired:boolean;requestReview:boolean;reviewMode:'regular'|'full';cooldown:number;retryLimit:number};
export const BOT_IDENTITIES={coderabbit:{userId:136622811,type:'Bot' as const,login:'coderabbitai[bot]'},codex:{userId:199175422,type:'Bot' as const,login:'chatgpt-codex-connector[bot]'}};
const levels:Severity[]=['info','low','medium','high','critical'];
export const MAX_REVIEW_BODY_BYTES=32*1024,MAX_WORKER_FINDINGS_BYTES=64*1024,MAX_REMEDIATION_PROMPT_BYTES=96*1024;
export class ReviewerPayloadTooLarge extends Error{constructor(part:string){super(`Reviewer feedback exceeds ${part} size limit; operator inspection required. No findings were truncated.`);}}
export function assertRemediationPromptSize(prompt:string){if(Buffer.byteLength(prompt,'utf8')>MAX_REMEDIATION_PROMPT_BYTES)throw new ReviewerPayloadTooLarge('complete worker prompt');}
/** Only the transport copy is compacted; validation/receipts retain originals. */
export function workerFindingsPayload(findings:any[]):string{
 const compact=findings.map(f=>{
  if(f.source!=='github-review')return f;
  if(typeof f.body==='string'&&Buffer.byteLength(f.body,'utf8')>MAX_REVIEW_BODY_BYTES)throw new ReviewerPayloadTooLarge('grouped review body');
  return {...f,...(Array.isArray(f.provenance)?{provenance:f.provenance.map((p:any)=>({reviewer:p.reviewer,commentId:p.commentId,userId:p.userId,originalHash:digest(JSON.stringify(p.original??null))}))}:{})};
 });
 const payload=JSON.stringify(compact);if(Buffer.byteLength(payload,'utf8')>MAX_WORKER_FINDINGS_BYTES)throw new ReviewerPayloadTooLarge('worker findings batch');return payload;
}
const defaults:ReviewerConfig[]=[{id:'coderabbit',adapter:'coderabbit',identity:BOT_IDENTITIES.coderabbit,approvalRequired:true,requestReview:true},{id:'codex',adapter:'github-review',identity:BOT_IDENTITIES.codex}];
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
const fail=(id:string,message:string):never=>{throw Error(`reviewers ${id}: ${message}`);};
function paths(value:any,id:string):string[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>100||value.some(p=>typeof p!=='string'||!p||p.length>256||p.startsWith('/')||p.split('/').includes('..')||!/^[\w./*? -]+$/.test(p)))fail(id,'paths must be bounded repository-relative globs (no traversal, braces or negation)');
 return [...new Set(value)] as string[];
}
/** Adding advisory reviewers never replaces built-in clearance obligations. */
export function reviewerPolicy(value:unknown):Reviewer[]{
 if(value!==undefined&&(!Array.isArray(value)||value.length>32))fail('configuration','expected at most 32 reviewer entries');
 const declared=(value??[]) as any[],ids=new Set<string>();
 for(const r of declared){if(!object(r)||typeof r.id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(r.id)||ids.has(r.id))fail('configuration','unique lowercase reviewer IDs required');ids.add(r.id);}
 const merged=[...defaults.map(d=>({...d,...declared.find(r=>r.id===d.id)})),...declared.filter(r=>!defaults.some(d=>d.id===r.id))];
 return merged.map((r:any):Reviewer=>{
  const id=r.id;
   const keys=['id','adapter','identity','membership','enabled','remediate','approvalRequired','minimumSeverity','includePaths','excludePaths','requestReview','reviewMode','cooldown','retryLimit','rateLimit'];
  if(Object.keys(r).some(k=>!keys.includes(k)))fail(id,'unsupported option');
  if(!['github-review','coderabbit'].includes(r.adapter))fail(id,`unsupported adapter ${r.adapter}; custom Graphite/Claude APIs are not supported`);
  for(const k of ['enabled','remediate','approvalRequired','requestReview'])if(r[k]!==undefined&&typeof r[k]!=='boolean')fail(id,`${k} must be boolean`);
  if(!!r.identity===!!r.membership)fail(id,'select exactly one stable identity or human membership selector');
  if(r.identity){const i=r.identity;
   if(!object(i)||Object.keys(i).some(k=>!['userId','type','login'].includes(k))||!Number.isSafeInteger(i.userId)||i.userId<1||!['Bot','User'].includes(i.type)||i.login!==undefined&&(typeof i.login!=='string'||!i.login||i.login.length>100))fail(id,'identity requires a positive immutable GitHub userId and Bot/User type; login is descriptive only');
  }
  if(r.membership){const m=r.membership;if(!object(m)||!['collaborators','team'].includes(m.kind)||Object.keys(m).some(k=>!(m.kind==='team'?['kind','organization','slug']:['kind']).includes(k))||m.kind==='team'&&(!/^[\w.-]+$/.test(m.organization??'')||!/^[\w.-]+$/.test(m.slug??'')))fail(id,'invalid human membership selector');}
  const p={...r,enabled:r.enabled??true,remediate:r.remediate??true,approvalRequired:r.approvalRequired??false,requestReview:r.requestReview??false,reviewMode:r.reviewMode??'regular',cooldown:r.cooldown??60000,retryLimit:r.retryLimit??3,includePaths:paths(r.includePaths,id),excludePaths:paths(r.excludePaths,id)} as Reviewer;
  if(!p.enabled&&p.approvalRequired)fail(id,'enabled=false with approvalRequired=true would bypass clearance; reviewed policy change required');
  if(p.minimumSeverity!==undefined&&!levels.includes(p.minimumSeverity))fail(id,'unsupported minimumSeverity');
   if(!['regular','full'].includes(p.reviewMode))fail(id,'reviewMode must be regular or full');
   if(r.rateLimit!==undefined){if(p.adapter!=='coderabbit'||!object(r.rateLimit))fail(id,'rateLimit requires CodeRabbit options');cooldownPolicy(r.rateLimit);}
  if(!Number.isSafeInteger(p.cooldown)||p.cooldown<60000||p.cooldown>86400000)fail(id,'cooldown must be milliseconds from 60000 to 86400000');
  if(!Number.isSafeInteger(p.retryLimit)||p.retryLimit<1||p.retryLimit>3)fail(id,'retryLimit must be from 1 to 3; cannot increase shared budget');
  if(p.adapter!=='coderabbit'&&(p.requestReview||r.reviewMode!==undefined||r.cooldown!==undefined||r.retryLimit!==undefined))fail(id,'requestReview/reviewMode/cooldown/retryLimit require the CodeRabbit request adapter');
  if(p.adapter==='coderabbit'&&(p.id!=='coderabbit'||p.identity?.userId!==BOT_IDENTITIES.coderabbit.userId||p.identity?.type!=='Bot'))fail(id,'CodeRabbit adapter is bound to its pinned bot identity');
  if(p.id==='coderabbit'&&(!p.enabled||p.adapter!=='coderabbit'))fail(id,'existing CodeRabbit clearance policy cannot be weakened');
  return p;
 });
}
export function reviewerPolicyView(value:unknown){return {reviewers:reviewerPolicy(value).map(r=>({...r,role:r.approvalRequired?'required':'advisory',supported:true,requestAdapter:r.adapter==='coderabbit'?'coderabbit':null})),unknownSeverity:'eligible unless filtered; retained as unclassified when filtered',pathless:'eligible without filters; otherwise unclassified',precedence:'exclude before include; evaluate both rename paths',adoption:'new approved-plan binding; active policy changes block until a new reviewed plan',branchProtection:'Not modified; bridge clearance is independent of GitHub branch protection'};}
export function ensureReviewerStore(s:Store){s.db.exec(`CREATE TABLE IF NOT EXISTS reviewer_policy(job TEXT PRIMARY KEY,plan TEXT NOT NULL,configuration TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS reviewer_observations(job TEXT PRIMARY KEY,head TEXT NOT NULL,observed INTEGER NOT NULL,evidence TEXT NOT NULL);`);}
const canonicalPolicy=(value:unknown)=>JSON.stringify(value,(_key,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function bindReviewerPolicy(s:Store,job:string,value:unknown){
 ensureReviewerStore(s);const configuration=canonicalPolicy(reviewerPolicy(value)),plan=s.get(job).plan_hash;
 return s.db.transaction(()=>{const old=s.db.query('SELECT * FROM reviewer_policy WHERE job=?').get(job) as any;
  if(old&&canonicalPolicy(JSON.parse(old.configuration))!==configuration&&old.plan===plan)throw Error('Reviewer policy changed during approved work; a fresh reviewed plan is required; existing obligations retained');
  s.db.query('INSERT INTO reviewer_policy VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET plan=excluded.plan,configuration=excluded.configuration').run(job,plan,configuration);
  return JSON.parse(configuration) as Reviewer[];
 }).immediate();
}
export function boundReviewerPolicy(s:Store,job:string):Reviewer[]{
 const row=s.db.query("SELECT name FROM sqlite_master WHERE name='reviewer_policy'").get()?s.db.query('SELECT * FROM reviewer_policy WHERE job=?').get(job) as any:null;
 if(row&&row.plan!==s.get(job).plan_hash)throw Error('Reviewer policy belongs to an older approval; refresh policy before collection');
 return row?JSON.parse(row.configuration):reviewerPolicy(undefined);
}
export function reviewerInput(policy:Reviewer[]):ReviewerConfig[]{return policy.map(r=>{const c={...r};if(c.adapter!=='coderabbit'){delete (c as any).reviewMode;delete (c as any).cooldown;delete (c as any).retryLimit;}return c;});}
export type TrustEvidence={reviewer:string;observed:number;ids:number[];blocker:string|null};
export type GitHubReader=(args:string[])=>Promise<any>;
/** Each evaluation re-reads membership; cached evidence never grants trust. */
export async function reviewerTrust(policy:Reviewer[],repo:string,read:GitHubReader,now=Date.now):Promise<TrustEvidence[]>{
 const result:TrustEvidence[]=[];
 for(const r of policy){
  if(!r.enabled)continue;
  const observed=now();let ids:number[]=[];let blocker:string|null=null;
  try{
   if(r.identity){const u=await read(['api',`user/${r.identity.userId}`]);if(u.id!==r.identity.userId||u.type!==r.identity.type||typeof u.login!=='string'||!u.login||r.identity.login&&u.login!==r.identity.login)throw Error('identity renamed, deleted or mismatched');
    if(u.type==='User'){const permission=await read(['api',`repos/${repo}/collaborators/${encodeURIComponent(u.login)}/permission`]);if(permission.user?.id!==u.id||!['read','triage','write','maintain','admin'].includes(permission.permission))throw Error('repository access revoked');}
    ids=[u.id];}
   else{
    const m=r.membership!;const path=m.kind==='team'?`orgs/${m.organization}/teams/${m.slug}/members`:`repos/${repo}/collaborators`;
    if(m.kind==='team'){const team=await read(['api',`orgs/${m.organization}/teams/${m.slug}/repos/${repo}`,'-H','Accept: application/vnd.github.v3.repository+json']);if(team?.full_name!==repo||team.permissions?.pull!==true)throw Error('team repository access unavailable');}
    let complete=false;
    for(let page=1;page<=100;page++){
     const users=await read(['api',`${path}?per_page=100&page=${page}`]);
     if(!Array.isArray(users)||users.some(u=>!Number.isSafeInteger(u.id)||typeof u.login!=='string'||!['User','Bot'].includes(u.type)))throw Error('invalid membership evidence');
     ids.push(...users.filter(u=>u.type==='User'&&(m.kind==='team'||u.permissions?.pull===true)).map(u=>u.id));
     if(users.length<100){complete=true;break;}
    }
    if(!complete)throw Error('membership pagination exceeds bound');
   }
   if(now()-observed>RECEIPT_FRESHNESS_MS)throw Error('membership evidence expired during collection');
   }catch(error){
    // The enclosing observation read owns shared backoff. A successful-looking
    // partial collection would discard its typed cooldown and permit early
    // retries, so transient failures must abort without granting any trust.
    const evidence=providerEvidence(error);if(evidence&&transient(evidence))throw error;
    ids=[];blocker=`Reviewer ${r.id}: fresh identity/membership evidence unavailable or mismatched; no trust granted`;
   }
  result.push({reviewer:r.id,observed,ids:[...new Set(ids)],blocker});
 }
 return result;
}
export type NormalizedFeedback={id:string;threadId:string;body:string;userId:number|null;type:string;login:string;path:string|null;previousPath?:string|null;line:number|null;originalCommit:string|null;outdated:boolean;resolved:boolean;severity?:Severity;original:any};
export function authenticatedReviewer(r:Reviewer,e:TrustEvidence|undefined,userId:number|null,type:string,now=Date.now()){
 return !!(r.enabled&&e&&!e.blocker&&now>=e.observed&&now-e.observed<=RECEIPT_FRESHNESS_MS&&userId&&e.ids.includes(userId)&&(r.identity?r.identity.type===type:type==='User'));
}
export function reviewFindingTrustFresh(f:any,evidence:any,now=Date.now()):boolean{
 return Array.isArray(f.provenance)&&f.provenance.length>0&&f.provenance.every((p:any)=>{
  const trust=evidence?.trust?.find((t:any)=>t.reviewer===p.reviewer);
  return trust&&!trust.blocker&&Number.isSafeInteger(trust.observed)&&now>=trust.observed&&now-trust.observed<=RECEIPT_FRESHNESS_MS&&trust.ids?.includes(p.userId);
 });
}
/** Re-fence after slow metadata/scheduling IO, not just before collection. */
export function invalidateExpiredReviewerFindings(evidence:any,now=Date.now()){
 for(const trust of evidence.trust){
  trust.fresh=Number.isSafeInteger(trust.observed)&&now>=trust.observed&&now-trust.observed<=RECEIPT_FRESHNESS_MS;
  if(!trust.fresh){const reason=`Reviewer ${trust.reviewer}: trust evidence expired during collection; refresh before clearance or remediation`;evidence.blockers??=[];if(!evidence.blockers.includes(reason))evidence.blockers.push(reason);}
 }
 const expired=evidence.findings.filter((f:any)=>!reviewFindingTrustFresh(f,evidence,now));
 evidence.findings=evidence.findings.filter((f:any)=>!expired.includes(f));
 for(const f of expired)evidence.pending.push({reviewer:f.provenance?.map((p:any)=>p.reviewer).join(', ')??'unknown',threadId:f.threadId,id:f.threadId,path:f.path,category:'trust-expired',reason:'Reviewer trust expired or unavailable; refresh before remediation',original:f.provenance});
 return evidence;
}
export function feedbackEligibility(r:Reviewer,f:NormalizedFeedback):'eligible'|'excluded'|'unclassified'{
 const includes=r.includePaths??[],excludes=r.excludePaths??[];
 const paths=[f.path,f.previousPath].filter((p):p is string=>typeof p==='string'&&p.length>0);
 if(paths.some(path=>excludes.some(glob=>new Bun.Glob(glob).match(path))))return 'excluded';
 if(includes.length&&paths.length&&!paths.some(path=>includes.some(glob=>new Bun.Glob(glob).match(path))))return 'excluded';
 if((includes.length||excludes.length)&&!paths.length)return 'unclassified';
 if(r.minimumSeverity&&!f.severity)return 'unclassified';
 if(r.minimumSeverity&&levels.indexOf(f.severity!)<levels.indexOf(r.minimumSeverity))return 'excluded';
 return 'eligible';
}
export function collectTrustedFeedback(policy:Reviewer[],trust:TrustEvidence[],feedback:NormalizedFeedback[],context:{repo:string;pr:number;head:string;selfIds:number[]},now=Date.now()){
 const findings:any[]=[],pending:any[]=[],excluded:any[]=[];const seen=new Map<string,any>();
 for(const f of feedback){
  // The executing account is established by authenticated /user evidence, so
  // actual bridge control comments are already excluded as self output. A
  // marker inside another reviewer's body is task data, not bridge provenance.
  if(f.resolved||!f.body.trim()||context.selfIds.includes(f.userId??-1))continue;
  const sources=policy.filter(r=>authenticatedReviewer(r,trust.find(e=>e.reviewer===r.id),f.userId,f.type,now));
  for(const r of sources){
   const eligibility=feedbackEligibility(r,f);
   if(f.outdated||!r.remediate){pending.push({reviewer:r.id,id:f.id,threadId:f.threadId,path:f.path,category:f.outdated?'stale':'remediation-disabled',reason:f.outdated?'Outdated applicability requires clarification':'Remediation disabled',original:f.original});continue;}
   if(eligibility!=='eligible'){const item={reviewer:r.id,id:f.id,threadId:f.threadId,path:f.path,category:eligibility,reason:`Feedback ${eligibility}`,original:f.original};(eligibility==='excluded'?excluded:pending).push(item);continue;}
   // Equivalence is deliberately exact and location-bound; no semantic guessing.
   const key=digest(JSON.stringify([f.threadId,f.path,f.line,f.body]));
   const provenance={reviewer:r.id,commentId:f.id,userId:f.userId,original:f.original};
   const prior=seen.get(key);if(prior){prior.provenance.push(provenance);prior.commentIds.push(f.id);continue;}
   const finding={source:'github-review',kind:'review_thread',threadId:f.threadId,commentIds:[f.id],repo:context.repo,pr:context.pr,sha:context.head,path:f.path,previousPath:f.previousPath??null,line:f.line,body:f.body,originalCommit:f.originalCommit,outdated:false,severity:f.severity??null,provenance:[provenance]};
   seen.set(key,finding);findings.push(finding);
  }
 }
 const groups=new Map<string,any>();
 for(const f of findings){const p=groups.get(f.threadId);if(!p)groups.set(f.threadId,{...f});else{p.body+='\n\n'+f.body;p.commentIds.push(...f.commentIds);p.provenance.push(...f.provenance);}}
 for(const f of groups.values()){
  f.commentIds=[...new Set(f.commentIds)].sort();
  f.commentsHash=digest(JSON.stringify(f.provenance.map((p:any)=>[p.reviewer,p.commentId,p.original.body,p.original.originalCommit??p.original.commit_id]).sort((a:any,b:any)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))));
 }
 // A raw unresolved thread may be ignored only if every substantive comment
 // was authenticated and excluded under every matching policy. Unknown authors,
 // mixed eligible feedback, stale state and disabled remediation remain blockers.
 const ignoredThreadIds=[...new Set(excluded.map(e=>e.threadId))].filter(threadId=>feedback.filter(f=>f.threadId===threadId&&!f.resolved&&f.body.trim()&&!context.selfIds.includes(f.userId??-1)).every(f=>{
  const sources=policy.filter(r=>authenticatedReviewer(r,trust.find(e=>e.reviewer===r.id),f.userId,f.type,now));
  return !f.outdated&&sources.length>0&&sources.every(r=>r.remediate&&feedbackEligibility(r,f)==='excluded');
 }));
 return {findings:[...groups.values()],pending,excluded,ignoredThreadIds,trust:trust.map(e=>({...e,fresh:now>=e.observed&&now-e.observed<=RECEIPT_FRESHNESS_MS})),policy:policy.map(r=>({id:r.id,enabled:r.enabled,remediate:r.remediate,approvalRequired:r.approvalRequired,requestReview:r.requestReview})),observed:now};
}
export function reviewerApprovals(policy:Reviewer[],trust:TrustEvidence[],reviews:any[],head:string,selfIds:number[],now=Date.now()){
 const blockers:string[]=[],status:any[]=[];
 for(const r of policy){
  if(!r.enabled)continue;const e=trust.find(e=>e.reviewer===r.id);
  // Optional approval is not permission to forget an existing change request
  // during an identity/membership outage. Process other trusted sources, but
  // fail clearance closed until this enabled source can be observed safely.
  if(e?.blocker)blockers.push(e.blocker);
  else if(!e||now<e.observed||now-e.observed>RECEIPT_FRESHNESS_MS)blockers.push(`Reviewer ${r.id}: fresh identity/membership evidence required before clearance`);
  const authenticated=reviews.filter(v=>!selfIds.includes(v.user?.id)&&authenticatedReviewer(r,e,v.user?.id??null,v.user?.type,now));
  const members=new Map<number,any>();
  for(const v of authenticated.filter(v=>['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(v.state)).sort((a,b)=>Date.parse(a.submitted_at)-Date.parse(b.submitted_at)))members.set(v.user.id,v);
  const changes=[...members.values()].filter(v=>v.state==='CHANGES_REQUESTED');
  const approved=[...members.values()].some(v=>v.state==='APPROVED'&&v.commit_id===head);
  if(changes.length)blockers.push(`Reviewer ${r.id}: changes requested (${changes.map(v=>v.id).join(', ')})`);
  if(r.approvalRequired&&!approved)blockers.push(`Reviewer ${r.id}: explicit current-head approval required`);
  status.push({reviewer:r.id,approvalRequired:r.approvalRequired,approved,changesRequested:changes.map(v=>({id:v.id,head:v.commit_id,body:v.body,original:v}))});
 }
 return {blockers,status};
}

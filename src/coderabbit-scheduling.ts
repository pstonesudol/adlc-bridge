import {digest,Store} from './core';
import {assertObservationFence} from './observation-fence';
import {randomUUID} from 'node:crypto';
import {CodeRabbitCooldowns,type CooldownPolicy} from './coderabbit-cooldowns';

export const REVIEW_GRACE_MS=5*60*1000, REVIEW_TIMEOUT_MS=30*60*1000;
export type ReviewMode='regular'|'full';
export const reviewCommand=(mode:ReviewMode)=>mode==='full'?'@coderabbitai full review':'@coderabbitai review';
export const reviewRequestMarker=(repo:string,pr:number,head:string)=>`<!-- adlc-coderabbit-request:${digest(JSON.stringify([repo,pr,head]))} -->`;
export const reviewRequestBody=(mode:ReviewMode,marker='')=>`${reviewCommand(mode)}${marker?'\n\n'+marker:''}`;
/** Evidence shapes are reported explicitly. A skipped, neutral or stale result is
 * never clearance; it only decides whether one bounded fresh review is supported. */
export type ReviewClassification='current-review'|'pending-current-run'|'stale-submitted-review'|'current-head-skipped'|'no-review-no-run'|'provider-error'|'rate-limited'|'intentional-pause'|'explicit-opt-out'|'configuration-gap';
export type ReviewEvidence={
 classification:ReviewClassification;
 recoverable:boolean;
 review:{id:any;state:string;commit:string;submittedAt:number|null;stale:boolean}|null;
 check:{id:any;name:string;status:string;conclusion:string|null;startedAt:number|null;completedAt:number|null}|null;
 runs:number;
 reviewedCommits:number;
 pauseThreshold:number;
 incremental:boolean;
};
export type ReviewSchedule={head:string;signature:string;blocker:string|null;incremental:boolean;quotaIdentity?:string;evidence?:ReviewEvidence;requestPolicy?:{requestReview:boolean;reviewMode:ReviewMode;cooldown:number;retryLimit:number;rateLimit?:Partial<CooldownPolicy>}};
class ScheduleGap extends Error{}
const gap=(message:string)=>{throw new ScheduleGap(message);};
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v)?v:gap('configuration must be a mapping');
const list=(v:any)=>v===undefined?[]:Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length>0&&x.length<=200)?v:gap('invalid scheduling list');
const bool=(v:any,fallback:boolean)=>v===undefined?fallback:typeof v==='boolean'?v:gap('invalid scheduling boolean');
const bot=(v:any)=>v?.user?.login==='coderabbitai[bot]'&&v.user.type==='Bot';
const submitted=['APPROVED','CHANGES_REQUESTED','DISMISSED'] as const;
const time=(value:any)=>typeof value==='string'?Date.parse(value):NaN;
const ordered=(a:any,b:any)=>(time(a.submitted_at)||0)-(time(b.submitted_at)||0);
const action=(text:string)=>`Safe next action: ${text}.`;
export function parseReviewConfig(text:string){
 if(!text||text.length>256000)gap('missing or oversized configuration');
 const config=object(Bun.YAML.parse(text)),reviews=object(config.reviews??{}),auto=object(reviews.auto_review??{});
 if(config.inheritance!==undefined&&config.inheritance!==false)gap('inherited configuration cannot be established from repository YAML alone');
 const known=['enabled','description_keyword','auto_incremental_review','auto_pause_after_reviewed_commits','ignore_title_keywords','labels','drafts','base_branches','ignore_usernames'];
 if(Object.keys(auto).some(k=>!known.includes(k)))gap('unsupported automatic-review setting');
 const pause=auto.auto_pause_after_reviewed_commits??5;
 if(!Number.isSafeInteger(pause)||pause<0)gap('invalid auto-pause threshold');
 if(auto.description_keyword!==undefined&&typeof auto.description_keyword!=='string')gap('invalid description keyword');
 return {enabled:bool(auto.enabled,true),incremental:bool(auto.auto_incremental_review,true),drafts:bool(auto.drafts,false),pause,
  labels:list(auto.labels),branches:list(auto.base_branches),titles:list(auto.ignore_title_keywords),users:list(auto.ignore_usernames),paths:list(reviews.path_filters)};
}
function pathMatch(path:string,pattern:string){
 // Unsupported constructs are an evidence gap, never an optimistic match.
 if(!/^[\w./*?@! -]+$/.test(pattern)||pattern.includes('..')||pattern.startsWith('/'))gap('unsupported path filter syntax');
 return new Bun.Glob(pattern).match(path);
}
function reviewEvidence(head:string,reviews:any[],checks:any[]):ReviewEvidence{
 const latest=reviews.filter(bot).filter(r=>submitted.includes(r.state)).sort(ordered).at(-1)??null;
 const current=!!latest&&latest.commit_id===head;
 const runs=checks.filter(c=>c.app?.slug==='coderabbitai'&&c.head_sha===head);
 const named=runs.filter(c=>c.name==='CodeRabbit');
 const run=named.length===1?named[0]:runs.length===1?runs[0]:null;
 return {classification:'no-review-no-run',recoverable:true,
  review:latest?{id:latest.id,state:String(latest.state),commit:String(latest.commit_id??''),submittedAt:Number.isFinite(time(latest.submitted_at))?time(latest.submitted_at):null,stale:!current}:null,
  check:run?{id:run.id,name:String(run.name??''),status:String(run.status??''),conclusion:run.conclusion??null,startedAt:Number.isFinite(time(run.started_at))?time(run.started_at):null,completedAt:Number.isFinite(time(run.completed_at))?time(run.completed_at):null}:null,
  runs:runs.length,
  reviewedCommits:new Set(reviews.filter(bot).map(r=>r.commit_id).filter((x:any)=>typeof x==='string'&&x.length>0)).size,
  pauseThreshold:0,incremental:false};
}
export function deriveReviewSchedule(input:{head:string;headText:string;baseText:string;identity:any;pr:any;defaultBranch:string;files:any[];comments:any[];reviews:any[];checks:any[]}):ReviewSchedule{
 const {head,headText,baseText,pr,files,comments,reviews,checks}=input;
 const signature=digest(JSON.stringify([input.identity,headText,baseText,pr.draft,pr.title,pr.body,pr.base?.ref,pr.labels,files,comments.map(c=>[c.id,c.updated_at,c.body]),reviews.map(r=>[r.id,r.commit_id,r.state])]));
 const evidence=reviewEvidence(head,reviews,checks);
 const runs=checks.filter(c=>c.app?.slug==='coderabbitai'&&c.head_sha===head);
 const output=runs.map(c=>`${c.output?.title??''} ${c.output?.summary??''} ${c.output?.text??''}`).join('\n');
 let incremental=false;
  const result=(blocker:string|null,classification:ReviewClassification,recoverable:boolean):ReviewSchedule=>({head,signature,blocker,incremental,quotaIdentity:Number.isSafeInteger(pr.user?.id)?`github-user:${pr.user.id}`:undefined,evidence:{...evidence,classification,recoverable,incremental}});
 const fail=(message:string,classification:ReviewClassification)=>result(`CodeRabbit review unavailable: ${message}`,classification,false);
 try{
  const c=parseReviewConfig(headText);parseReviewConfig(baseText);incremental=c.incremental;
  evidence.pauseThreshold=c.pause;evidence.incremental=incremental;
  if(headText!==baseText)return fail(`head/base configuration differs; trusted base policy must be reconciled before clearance; ${action('reconcile .coderabbit.yaml between the PR head and trusted base')}`,'configuration-gap');
  if(!c.enabled)return fail(`automatic review explicitly disabled; no speculative override; ${action('re-enable reviews.auto_review.enabled in .coderabbit.yaml, or ask a human to review the PR')}`,'explicit-opt-out');
  if(pr.draft&&!c.drafts)return fail(`draft excluded by configuration; ${action('mark the PR ready for review')}`,'explicit-opt-out');
  if(c.titles.some((k:string)=>(pr.title??'').toLowerCase().includes(k.toLowerCase())))return fail(`title intentionally excluded by ignore_title_keywords; ${action('remove the ignored title keyword from the PR title')}`,'explicit-opt-out');
  if(c.users.includes(pr.user?.login))return fail(`author intentionally excluded by ignore_usernames; ${action('ask an eligible author to open the PR')}`,'explicit-opt-out');
  if(typeof pr.body!=='string'&&pr.body!==null)return fail('PR description unavailable; retry the provider read','configuration-gap');
  if(/@coderabbitai\s+(?:ignore|pause)\b/i.test(pr.body??''))return fail(`PR description explicitly opts out; ${action("remove the '@coderabbitai ignore' or '@coderabbitai pause' instruction")}`,'explicit-opt-out');
  if(!Array.isArray(pr.labels)||pr.labels.some((l:any)=>typeof l?.name!=='string'))return fail('labels unavailable; retry the provider read','configuration-gap');
  const labels=pr.labels.map((l:any)=>l.name),positive=c.labels.filter((l:string)=>!l.startsWith('!'));
  if(c.labels.some((l:string)=>l.startsWith('!')&&labels.includes(l.slice(1)))||positive.length&&!positive.some((l:string)=>labels.includes(l)))return fail(`labels intentionally exclude review; ${action('adjust the PR labels to satisfy reviews.auto_review.labels')}`,'explicit-opt-out');
  const branches=c.branches.map((p:string)=>{if(p.length>100||/[()[\]{}+\\]/.test(p))gap('unsupported base-branch expression');return new RegExp(p);});
  if(pr.base?.ref!==input.defaultBranch&&!branches.some((p:RegExp)=>p.test(pr.base?.ref??'')))return fail(`base branch excluded by configuration; ${action('retarget the PR to the default branch or an allowed base')}`,'explicit-opt-out');
  if(!files.length||files.some(f=>typeof f.filename!=='string'))return fail('changed-file evidence unavailable; retry the provider read','configuration-gap');
  const paths=files.flatMap(f=>[f.filename,...(f.previous_filename?[f.previous_filename]:[])]);
  // Validate every filter even if an earlier include/exclude would short circuit.
  for(const p of c.paths)pathMatch('validation',p.startsWith('!')?p.slice(1):p);
  const includes=c.paths.filter((p:string)=>!p.startsWith('!')),excludes=c.paths.filter((p:string)=>p.startsWith('!')).map((p:string)=>p.slice(1));
  if(!paths.some(path=>(!includes.length||includes.some((p:string)=>pathMatch(path,p)))&&!excludes.some((p:string)=>pathMatch(path,p))))return fail(`all changed paths intentionally excluded by reviews.path_filters; ${action('include a changed path covered by the configured path filter')}`,'explicit-opt-out');
  const commands=comments.filter(c=>typeof c.body==='string'&&/^@coderabbitai\s+(pause|resume|ignore)\s*$/im.test(c.body)).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
  const command=commands.at(-1);
  if(command&&!/^@coderabbitai\s+resume\s*$/im.test(command.body)){const ignore=/ignore/i.test(command.body);return fail(`explicit ${ignore?'ignore':'pause'} command; no automatic resume; ${action("post '@coderabbitai resume' in the PR, then run 'adlc tick-review'")}`,ignore?'explicit-opt-out':'intentional-pause');}
  if(evidence.reviewedCommits>=evidence.pauseThreshold&&evidence.pauseThreshold>0&&!(evidence.review&&!evidence.review.stale)&&!runs.some(c=>c.status!=='completed'))return fail(`auto-pause threshold reached (${evidence.reviewedCommits} reviewed commits >= auto_pause_after_reviewed_commits=${evidence.pauseThreshold}); the provider intentionally paused automatic review; ${action("post one '@coderabbitai review' manually if another review is intended, or raise/remove auto_pause_after_reviewed_commits")}`,'intentional-pause');
 }catch(error){return fail(`${error instanceof ScheduleGap?error.message:'malformed YAML (payload omitted)'}; no speculative request or clearance`,'configuration-gap');}
 const current=evidence.review&&!evidence.review.stale;
 // A current submitted review is judged by the explicit review gate, never by
 // this scheduler. A stale review is historical: it can never clear the gate,
 // and it cannot supply custom-check evidence for a newer head.
 if(current)return result(null,'current-review',false);
 const autoPause=/auto[-\s]?pause|paus(?:e|ed)\s+(?:after|once)\s+[^.\n]*commit/i.test(output);
 if(!autoPause&&/review\s+(?:has been\s+)?paused|paused\s+(?:automatic\s+)?review|intentional(?:ly)?\s+(?:skip|pause)/i.test(output))return fail(`provider reports an intentional review pause; ${action("post '@coderabbitai resume' in the PR, then run 'adlc tick-review'")}`,'intentional-pause');
 if(/automatic\s+review\s+(?:is\s+)?disabled|auto[-\s]?reviews?\s+(?:are\s+|is\s+)?disabled/i.test(output))return fail(`provider reports automatic review disabled; ${action('re-enable reviews.auto_review.enabled in .coderabbit.yaml')}`,'explicit-opt-out');
 if(runs.length>1)return fail(`multiple current-head CodeRabbit runs (${runs.map(c=>c.id).join(', ')}) cannot identify one authoritative result; ${action('inspect those runs and re-run tick-review')}`,'provider-error');
 if(/rate[\s_-]?limit/i.test(output))return result(null,'rate-limited',true);
 if(runs.some(c=>c.status!=='completed'))return result(null,'pending-current-run',false);
 if(evidence.review)return result(null,'stale-submitted-review',true);
 if(runs.some(c=>c.status==='completed'&&['skipped','neutral'].includes(c.conclusion)))return result(null,'current-head-skipped',true);
 if(runs.some(c=>c.status==='completed'&&['failure','timed_out','cancelled','action_required','startup_failure'].includes(c.conclusion)))return result(null,'provider-error',true);
 return result(null,'no-review-no-run',true);
}
/** Exact terminal evidence for a bounded request that did not become a current
 * review. The reason always names the head, the check/review identities, the
 * effective configuration and one safe next action; never "ambiguous". */
export function reviewEscalationReason(input:{repo:string;pr:number;head:string;schedule:ReviewSchedule;attempts:number;requestState:string;retryAt?:number|null;mode?:ReviewMode}):string{
 const {repo,pr,head,schedule,attempts,requestState,retryAt}=input,e=schedule.evidence;
 const check=e?.check?`check ${e.check.id} '${e.check.name}' ${e.check.status}/${e.check.conclusion??'no conclusion'}`:e?.runs?`${e.runs} current-head CodeRabbit runs`:'no current-head CodeRabbit run';
 const review=e?.review?`review ${e.review.id} at ${e.review.commit} (${e.review.state}${e.review.stale?', stale':''})`:'no submitted CodeRabbit review';
 const configuration=`auto_incremental_review=${e?.incremental??schedule.incremental}, auto_pause_after_reviewed_commits=${e?.pauseThreshold??'unknown'}, reviewed commits=${e?.reviewedCommits??'unknown'}`;
 const evidence=`head ${head}; ${check}; ${review}; ${configuration}; ${attempts} request attempt(s), state ${requestState}, requested mode ${input.mode??'regular'}${retryAt?`; provider limit resets ${new Date(retryAt).toISOString()}`:''}`;
 if(e?.classification==='rate-limited')return `CodeRabbit review unavailable: ${evidence}; the provider is rate limiting review requests. Safe next action: wait for the provider limit to reset, then run 'adlc tick-review' (do not post another review request).`;
 if(e?.classification==='provider-error')return `CodeRabbit review unavailable: ${evidence}; the provider run did not complete normally. Safe next action: inspect ${e.check?`run ${e.check.id}`:'the CodeRabbit runs'}, then run 'adlc tick-review'.`;
 return `CodeRabbit review unavailable: ${evidence}; no current-head CodeRabbit review exists. Safe next action: inspect the review request/result on https://github.com/${repo}/pull/${pr}, then run 'adlc tick-review'. Regular review may skip an already-reviewed commit or description-only edit; whole-PR reassessment requires an explicit operator '@coderabbitai full review' request, never automatic escalation.`;
}

/** One receipt per repository/PR/head, shared across jobs and restarts. Reserving
 * before I/O makes lost responses non-replayable. Only confirmed rejection can
 * transition back to a sendable state. */
export function reviewProviderHold(s:Store):any{
 if(!s.db.query("SELECT 1 FROM sqlite_master WHERE name='coderabbit_provider_holds'").get())return null;
 return s.db.query("SELECT * FROM coderabbit_provider_holds WHERE provider='coderabbit'").get()??null;
}
export function reviewProviderHoldPreview(s:Store,job:string){
 const j=s.get(job),hold=reviewProviderHold(s);if(!hold)return {state:'clear',provider:'coderabbit',mutationReplay:false};
 if(hold.job!==job)throw Error(`Inspect provider hold with its original job ${hold.job}`);
 return {state:'inspection_required',hold,confirmation:digest(JSON.stringify([hold,j.id,j.plan_hash,j.approved_hash,j.state])),mutationReplay:false};
}
export class ReviewRequests{
 cooldowns:CodeRabbitCooldowns;
 constructor(public s:Store,public now=Date.now){s.db.exec(`CREATE TABLE IF NOT EXISTS coderabbit_requests(repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,job TEXT NOT NULL,signature TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,requested INTEGER NOT NULL,next_attempt INTEGER NOT NULL,evidence TEXT,PRIMARY KEY(repo,pr,head));
 CREATE TABLE IF NOT EXISTS coderabbit_waits(repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,signature TEXT NOT NULL,started INTEGER NOT NULL,PRIMARY KEY(repo,pr,head));
   CREATE TABLE IF NOT EXISTS coderabbit_request_attempts(repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,attempt INTEGER NOT NULL,signature TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,evidence TEXT,next_attempt INTEGER NOT NULL,PRIMARY KEY(repo,pr,head,attempt));
   CREATE TABLE IF NOT EXISTS coderabbit_provider_holds(provider TEXT PRIMARY KEY,id TEXT NOT NULL,job TEXT NOT NULL,repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL);`);
  // Every pre-mode request used full review. Keep its command and budget across
  // upgrade; mode is evidence, never part of the per-head deduplication key.
  s.db.transaction(()=>{
   for(const table of ['coderabbit_requests','coderabbit_request_attempts']){
    const columns=s.db.query(`PRAGMA table_info(${table})`).all() as any[];
    if(!columns.some(c=>c.name==='mode'))s.db.exec(`ALTER TABLE ${table} ADD COLUMN mode TEXT NOT NULL DEFAULT 'full' CHECK(mode IN ('regular','full'))`);
   }
   }).immediate();this.cooldowns=new CodeRabbitCooldowns(s,now);
   // Upgrade known legacy throttle episodes conservatively. Existing accepted
   // and uncertain receipts remain non-replayable, and old retries are not free.
   s.db.transaction(()=>{
    for(const key of s.db.query("SELECT DISTINCT repo,pr FROM coderabbit_requests WHERE state='rate_limited'").all() as any[]){
     if(this.cooldowns.get(key.repo,key.pr))continue;
     const rows=s.db.query('SELECT * FROM coderabbit_requests WHERE repo=? AND pr=? ORDER BY requested DESC').all(key.repo,key.pr) as any[];
     const audit=s.db.query("SELECT MIN(requested) AS started FROM coderabbit_request_attempts WHERE repo=? AND pr=? AND state='rate_limited'").get(key.repo,key.pr) as any;
     const started=Math.min(now(),audit?.started??Math.min(...rows.map(r=>r.requested))),attempts=rows.reduce((n,r)=>n+Math.max(0,r.attempts-1),0),deadline=started+24*60*60000;
     const reset=Math.max(...rows.filter(r=>r.state==='rate_limited').map(r=>r.next_attempt)),next=reset>0?reset+5*60000:started+60*60000;
     s.db.query('INSERT INTO coderabbit_cycles(repo,pr,cycle,head,started,deadline,attempts,limit_attempts,state,next_action,reliable) VALUES (?,?,1,?,?,?,?,6,?,?,?)').run(key.repo,key.pr,rows[0].head,started,deadline,attempts,now()>=deadline||attempts>=6?'exhausted':'waiting',next,Number(reset>0));
    }
   }).immediate();}
 receipts(repo:string,pr:number){return (this.s.db.query('SELECT * FROM coderabbit_requests WHERE repo=? AND pr=?').all(repo,pr) as any[]).map(r=>{let delivered:any;try{delivered=JSON.parse(r.evidence??'null');}catch{}return {...r,comment_id:delivered?.id};});}
 reconcileThrottle(repo:string,pr:number){
  assertObservationFence();this.s.db.transaction(()=>{
   const c=this.cooldowns.get(repo,pr);if(!c||c.state==='completed')return;
   const evidence=this.s.db.query('SELECT * FROM coderabbit_throttle_evidence WHERE repo=? AND pr=? AND cycle=?').all(repo,pr,c.cycle) as any[];
   for(const row of evidence){const e=JSON.parse(row.evidence);if(!e.request||e.request.startsWith('query:')||e.kind==='already-reviewed')continue;
    const r=this.get(repo,pr,e.head);if(!r||e.request!==`${r.head}:${r.attempts}`||!['accepted','rate_limited'].includes(r.state)||e.at+1000<r.requested)continue;
    this.s.db.query("UPDATE coderabbit_requests SET state='rate_limited',next_attempt=? WHERE repo=? AND pr=? AND head=? AND state IN ('accepted','rate_limited')").run(c.next_action,repo,pr,e.head);
    // Delivery remains accepted in the attempt audit; provider rejection is
    // additional evidence, never a rewrite of the successful delivery receipt.
    this.s.db.query("UPDATE full_review_requests SET state='rate_limited' WHERE pr=? AND head=? AND job IN (SELECT job FROM review_targets WHERE repo=? AND pr=?) AND state='accepted'").run(pr,e.head,repo,pr);
   }
  }).immediate();
 }
  get(repo:string,pr:number,head:string):any{return this.s.db.query('SELECT * FROM coderabbit_requests WHERE repo=? AND pr=? AND head=?').get(repo,pr,head);}
  providerHold(){return reviewProviderHold(this.s);}
  holdForInspection(job:string,repo:string,pr:number,head:string){
   assertObservationFence();return this.s.db.transaction(()=>{
    if(!this.s.db.query("SELECT 1 FROM coderabbit_requests WHERE repo=? AND pr=? AND head=? AND job=? AND state='delivery_uncertain'").get(repo,pr,head,job))throw Error('Original uncertain request required for provider hold');
    const changed=this.s.db.query('INSERT OR IGNORE INTO coderabbit_provider_holds VALUES (?,?,?,?,?,?,?,?)').run('coderabbit',randomUUID(),job,repo,pr,head,'Provider rate-limit reset cannot be safely represented; operator inspection required',this.now()).changes;
    if(changed)this.s.event(job,'coderabbit_provider_hold_recorded',JSON.stringify(this.providerHold()));
    return this.providerHold();
   }).immediate();
  }
  reconcileProviderHold(job:string,confirmation:string,human:string){
   assertObservationFence();if(!human?.trim()||human.length>200)throw Error('Named human inspection required');
   return this.s.db.transaction(()=>{
    const j=this.s.get(job);if(j.state!=='approved'||!j.actor||!j.plan||j.plan_hash!==j.approved_hash||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan])))throw Error('Current approved hold-source job required');
    const preview=reviewProviderHoldPreview(this.s,job);
    if(preview.state!=='inspection_required'||!confirmation||preview.confirmation!==confirmation)throw Error('Provider hold changed; inspect a fresh reconciliation preview');
    const changed=this.s.db.query("DELETE FROM coderabbit_provider_holds WHERE provider='coderabbit' AND id=? AND job=?").run(preview.hold.id,job).changes;
    if(changed!==1)throw Error('Provider hold changed before reconciliation');
    this.s.event(job,'coderabbit_provider_hold_reconciled',JSON.stringify({hold:preview.hold,human:human.trim(),mutationReplay:false}));
    return {state:'provider_hold_cleared',provider:'coderabbit',mutationReplay:false,originalRequest:'retained; uncertain receipts and budgets unchanged'};
   }).immediate();
  }
 wait(repo:string,pr:number,schedule:ReviewSchedule){
  assertObservationFence();const {head,signature}=schedule;
  this.s.db.query('INSERT INTO coderabbit_waits VALUES (?,?,?,?,?) ON CONFLICT(repo,pr,head) DO UPDATE SET signature=excluded.signature,started=excluded.started WHERE signature!=excluded.signature').run(repo,pr,head,signature,this.now());
  return this.s.db.query('SELECT started FROM coderabbit_waits WHERE repo=? AND pr=? AND head=?').get(repo,pr,head) as {started:number};
 }
 claim(job:string,repo:string,pr:number,schedule:ReviewSchedule){
   assertObservationFence();if(schedule.blocker||schedule.evidence?.recoverable===false||schedule.requestPolicy?.requestReview===false)return false;
   return this.s.db.transaction(()=>{
   if(this.providerHold())return false;
   // A new head/PR cannot evade a verified provider reset or an uncertain
   // request for this PR. This embargo shares the existing durable ledger.
    // Legacy HTTP evidence is plain text. Bot-rejected deliveries retain their
    // JSON comment receipt; they must not embargo unrelated developer quotas.
    const embargo=this.s.db.query("SELECT MAX(next_attempt) AS reset FROM coderabbit_requests WHERE state='rate_limited' AND NOT json_valid(evidence)").get() as any;
    if(embargo?.reset>this.now())return false;
    if(schedule.quotaIdentity){const shared=this.s.db.query("SELECT MAX(next_action) AS reset FROM coderabbit_cycles WHERE scope=? AND state!='completed'").get(schedule.quotaIdentity) as any;if(shared?.reset>this.now())return false;}
   if(this.s.db.query("SELECT 1 FROM coderabbit_requests WHERE repo=? AND pr=? AND state='delivery_uncertain'").get(repo,pr))return false;
   // Existing metadata-review receipts also consume this head's accepted/uncertain
   // request budget. This upgrade must not replay requests from old databases.
   const legacy=this.s.db.query("SELECT r.state FROM full_review_requests r JOIN review_targets t ON t.job=r.job AND t.pr=r.pr WHERE t.repo=? AND r.pr=? AND r.head=? AND r.state IN ('accepted','delivery_uncertain') LIMIT 1").get(repo,pr,schedule.head);
   if(legacy)return false;
    const cycle=this.cooldowns.get(repo,pr);
    const p=schedule.requestPolicy,mode=cycle&&cycle.state!=='completed'?'regular':p?.reviewMode??'regular',limit=cycle&&cycle.state!=='completed'?Number.MAX_SAFE_INTEGER:Math.min(3,p?.retryLimit??3),cooldown=Math.max(60000,p?.cooldown??60000);
    const prior=this.get(repo,pr,schedule.head);if(prior&&(prior.attempts>=limit||this.now()<Math.max(prior.next_attempt,prior.requested+cooldown)))return false;
    if(prior&&prior.state!=='rate_limited')return false;
    if(!this.cooldowns.reserve(repo,pr,schedule.head))return false;
   const changed=!!this.s.db.query(`INSERT INTO coderabbit_requests(repo,pr,head,job,signature,state,attempts,requested,next_attempt,evidence,mode) VALUES (?,?,?,?,?,'delivery_uncertain',1,?,0,NULL,?) ON CONFLICT(repo,pr,head) DO UPDATE SET state='delivery_uncertain',signature=excluded.signature,attempts=attempts+1,requested=excluded.requested,evidence=NULL,mode=excluded.mode WHERE state='rate_limited' AND next_attempt<=? AND attempts<?`).run(repo,pr,schedule.head,job,schedule.signature,this.now(),mode,this.now(),limit).changes;
   if(changed){const r=this.get(repo,pr,schedule.head);this.s.db.query('INSERT INTO coderabbit_request_attempts(repo,pr,head,attempt,signature,state,requested,evidence,next_attempt,mode) VALUES (?,?,?,?,?,?,?,?,?,?)').run(repo,pr,schedule.head,r.attempts,schedule.signature,r.state,r.requested,null,0,r.mode);}
   return changed;
  }).immediate();
 }
 settle(repo:string,pr:number,head:string,state:'accepted'|'rate_limited',evidence:string,retryAt?:number){
  assertObservationFence();this.s.db.transaction(()=>{
   const next=state==='rate_limited'?Math.max(this.now()+60000,Number.isSafeInteger(retryAt)?retryAt!:this.now()+REVIEW_TIMEOUT_MS):0;
   const changed=this.s.db.query("UPDATE coderabbit_requests SET state=?,evidence=?,next_attempt=? WHERE repo=? AND pr=? AND head=? AND state='delivery_uncertain'").run(state,evidence,next,repo,pr,head).changes;
   if(changed){const r=this.get(repo,pr,head);this.s.db.query('UPDATE coderabbit_request_attempts SET state=?,evidence=?,next_attempt=? WHERE repo=? AND pr=? AND head=? AND attempt=?').run(state,evidence,next,repo,pr,head,r.attempts);}
  }).immediate();
 }
}

export class ReviewRateLimit extends Error{constructor(public retryAt?:number){super('CodeRabbit review request rejected by rate limit');}}
export class ReviewResetUnrepresentable extends Error{constructor(){super('CodeRabbit provider reset cannot be safely represented; operator inspection required before retry');}}
export const CONFIG_QUERY='query($owner:String!,$name:String!,$hy:String!,$hm:String!,$by:String!,$bm:String!){repository(owner:$owner,name:$name){defaultBranchRef{name} hy:object(expression:$hy){... on Blob{oid text}} hm:object(expression:$hm){... on Blob{oid text}} by:object(expression:$by){... on Blob{oid text}} bm:object(expression:$bm){... on Blob{oid text}}}}';

export async function collectReviewSchedule(repo:string,pr:any,base:string,comments:any[],reviews:any[],checks:any[],read:(args:string[])=>Promise<any>):Promise<ReviewSchedule>{
 const head=pr.head.sha;
 const invalid=(detail:string)=>({head,signature:digest(JSON.stringify([head,base,detail])),incremental:false,blocker:`CodeRabbit review unavailable: ${detail}; no speculative request or clearance`,evidence:{classification:'configuration-gap' as const,recoverable:false,review:null,check:null,runs:0,reviewedCommits:0,pauseThreshold:0,incremental:false}});
 if(pr.head.repo?.full_name!==repo)return invalid('fork configuration provenance requires reconciliation');
 const [owner,name]=repo.split('/');
 const query=CONFIG_QUERY;
 const result=await read(['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-f',`hy=${head}:.coderabbit.yaml`,'-f',`hm=${head}:.coderabbit.yml`,'-f',`by=${base}:.coderabbit.yaml`,'-f',`bm=${base}:.coderabbit.yml`]);
 const r=result.data?.repository;
 if(result.errors||!r?.defaultBranchRef?.name)return invalid('configuration revision evidence incomplete');
 if([r.hy,r.hm].filter(Boolean).length!==1||[r.by,r.bm].filter(Boolean).length!==1)return invalid('missing or competing YAML filenames at head/base');
 const h=r.hy??r.hm,b=r.by??r.bm;
 if(typeof h.text!=='string'||typeof b.text!=='string'||!h.oid||!b.oid)return invalid('configuration blob evidence incomplete');
 const pages=await read(['api','--paginate','--slurp',`repos/${repo}/pulls/${pr.number}/files?per_page=100`]);
 if(!Array.isArray(pages)||pages.some(p=>!Array.isArray(p)))return invalid('changed-file pagination incomplete');
 const files=pages.flat();if(files.length!==pr.changed_files||files.length>=3000)return invalid('changed-file inventory incomplete');
 return deriveReviewSchedule({head,headText:h.text,baseText:b.text,identity:[repo,pr.number,base,h.oid,b.oid,r.hy?'yaml':'yml',r.by?'yaml':'yml'],pr,defaultBranch:r.defaultBranchRef.name,files,comments,reviews,checks});
}

import {digest,Store} from './core';
import {assertObservationFence} from './observation-fence';

export const REVIEW_GRACE_MS=5*60*1000, REVIEW_TIMEOUT_MS=30*60*1000;
export type ReviewSchedule={head:string;signature:string;blocker:string|null;incremental:boolean};
class ScheduleGap extends Error{}
const gap=(message:string)=>{throw new ScheduleGap(message);};
const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v)?v:gap('configuration must be a mapping');
const list=(v:any)=>v===undefined?[]:Array.isArray(v)&&v.every(x=>typeof x==='string'&&x.length>0&&x.length<=200)?v:gap('invalid scheduling list');
const bool=(v:any,fallback:boolean)=>v===undefined?fallback:typeof v==='boolean'?v:gap('invalid scheduling boolean');
const bot=(v:any)=>v?.user?.login==='coderabbitai[bot]'&&v.user.type==='Bot';
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
export function deriveReviewSchedule(input:{head:string;headText:string;baseText:string;identity:any;pr:any;defaultBranch:string;files:any[];comments:any[];reviews:any[];checks:any[]}):ReviewSchedule{
 const {head,headText,baseText,pr,files,comments,reviews,checks}=input;
 const signature=digest(JSON.stringify([input.identity,headText,baseText,pr.draft,pr.title,pr.body,pr.base?.ref,pr.labels,files,comments.map(c=>[c.id,c.updated_at,c.body]),reviews.map(r=>[r.id,r.commit_id,r.state])]));
 let incremental=false;
 try{
  const c=parseReviewConfig(headText);parseReviewConfig(baseText);incremental=c.incremental;
  if(headText!==baseText)gap('head/base configuration differs; trusted base policy must be reconciled before clearance');
  if(!c.enabled)gap('automatic review explicitly disabled; no speculative override');
  if(pr.draft&&!c.drafts)gap('draft excluded by configuration');
  if(c.titles.some((k:string)=>(pr.title??'').toLowerCase().includes(k.toLowerCase())))gap('title intentionally excluded');
  if(c.users.includes(pr.user?.login))gap('author intentionally excluded');
  if(typeof pr.body!=='string'&&pr.body!==null)gap('PR description unavailable');
  if(/@coderabbitai\s+(?:ignore|pause)\b/i.test(pr.body??''))gap('PR description explicitly opts out');
  if(!Array.isArray(pr.labels)||pr.labels.some((l:any)=>typeof l?.name!=='string'))gap('labels unavailable');
  const labels=pr.labels.map((l:any)=>l.name),positive=c.labels.filter((l:string)=>!l.startsWith('!'));
  if(c.labels.some((l:string)=>l.startsWith('!')&&labels.includes(l.slice(1)))||positive.length&&!positive.some((l:string)=>labels.includes(l)))gap('labels intentionally exclude review');
  const branches=c.branches.map((p:string)=>{if(p.length>100||/[()[\]{}+\\]/.test(p))gap('unsupported base-branch expression');return new RegExp(p);});
  if(pr.base?.ref!==input.defaultBranch&&!branches.some((p:RegExp)=>p.test(pr.base?.ref??'')))gap('base branch excluded by configuration');
  if(!files.length||files.some(f=>typeof f.filename!=='string'))gap('changed-file evidence unavailable');
  const paths=files.flatMap(f=>[f.filename,...(f.previous_filename?[f.previous_filename]:[])]);
  // Validate every filter even if an earlier include/exclude would short circuit.
  for(const p of c.paths)pathMatch('validation',p.startsWith('!')?p.slice(1):p);
  const includes=c.paths.filter((p:string)=>!p.startsWith('!')),excludes=c.paths.filter((p:string)=>p.startsWith('!')).map((p:string)=>p.slice(1));
  if(!paths.some(path=>(!includes.length||includes.some((p:string)=>pathMatch(path,p)))&&!excludes.some((p:string)=>pathMatch(path,p))))gap('all changed paths intentionally excluded');
  const commands=comments.filter(c=>typeof c.body==='string'&&/^@coderabbitai\s+(pause|resume|ignore)\s*$/im.test(c.body)).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
  if(commands.length&&!/^@coderabbitai\s+resume\s*$/im.test(commands.at(-1).body))gap('explicit pause/ignore command; no automatic resume');
  const reviewed=new Set(reviews.filter(bot).map(r=>r.commit_id).filter(Boolean));
  if(c.pause>0&&reviewed.size>=c.pause)gap('auto-pause threshold may be reached; explicit provider pause evidence required');
  const output=checks.filter(c=>c.app?.slug==='coderabbitai'&&c.head_sha===head).map(c=>`${c.output?.title??''} ${c.output?.summary??''} ${c.output?.text??''}`).join('\n');
  if(/review.*paused|paused.*review|intentional(?:ly)?.*skip|auto.review.*disabled|draft.*skip|skip.*draft/i.test(output))gap('provider reports intentional skip or pause');
  if(/review skipped/i.test(output)&&!(c.incremental===false&&/incremental.*(?:disabled|not enabled)/i.test(output)))gap('provider reports a skip with no supported automatic-incremental explanation');
  return {head,signature,blocker:null,incremental};
 }catch(error){return {head,signature,incremental,blocker:`CodeRabbit review unavailable: ${error instanceof ScheduleGap?error.message:'malformed YAML (payload omitted)'}; no speculative request or clearance`};}
}

/** One receipt per repository/PR/head, shared across jobs and restarts. Reserving
 * before I/O makes lost responses non-replayable. Only confirmed rejection can
 * transition back to a sendable state. */
export class ReviewRequests{
 constructor(public s:Store,public now=Date.now){s.db.exec(`CREATE TABLE IF NOT EXISTS coderabbit_requests(repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,job TEXT NOT NULL,signature TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,requested INTEGER NOT NULL,next_attempt INTEGER NOT NULL,evidence TEXT,PRIMARY KEY(repo,pr,head));
 CREATE TABLE IF NOT EXISTS coderabbit_waits(repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,signature TEXT NOT NULL,started INTEGER NOT NULL,PRIMARY KEY(repo,pr,head));
 CREATE TABLE IF NOT EXISTS coderabbit_request_attempts(repo TEXT NOT NULL,pr INTEGER NOT NULL,head TEXT NOT NULL,attempt INTEGER NOT NULL,signature TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,evidence TEXT,next_attempt INTEGER NOT NULL,PRIMARY KEY(repo,pr,head,attempt));`);}
 get(repo:string,pr:number,head:string):any{return this.s.db.query('SELECT * FROM coderabbit_requests WHERE repo=? AND pr=? AND head=?').get(repo,pr,head);}
 wait(repo:string,pr:number,schedule:ReviewSchedule){
  assertObservationFence();const {head,signature}=schedule;
  this.s.db.query('INSERT INTO coderabbit_waits VALUES (?,?,?,?,?) ON CONFLICT(repo,pr,head) DO UPDATE SET signature=excluded.signature,started=excluded.started WHERE signature!=excluded.signature').run(repo,pr,head,signature,this.now());
  return this.s.db.query('SELECT started FROM coderabbit_waits WHERE repo=? AND pr=? AND head=?').get(repo,pr,head) as {started:number};
 }
 claim(job:string,repo:string,pr:number,schedule:ReviewSchedule){
  assertObservationFence();if(schedule.blocker)return false;
  return this.s.db.transaction(()=>{
   // Existing metadata-review receipts also consume this head's accepted/uncertain
   // request budget. This upgrade must not replay requests from old databases.
   const legacy=this.s.db.query("SELECT r.state FROM full_review_requests r JOIN review_targets t ON t.job=r.job AND t.pr=r.pr WHERE t.repo=? AND r.pr=? AND r.head=? AND r.state IN ('accepted','delivery_uncertain') LIMIT 1").get(repo,pr,schedule.head);
   if(legacy)return false;
   const changed=!!this.s.db.query(`INSERT INTO coderabbit_requests VALUES (?,?,?,?,?,'delivery_uncertain',1,?,0,NULL) ON CONFLICT(repo,pr,head) DO UPDATE SET state='delivery_uncertain',signature=excluded.signature,attempts=attempts+1,requested=excluded.requested,evidence=NULL WHERE state='rate_limited' AND next_attempt<=? AND attempts<3`).run(repo,pr,schedule.head,job,schedule.signature,this.now(),this.now()).changes;
   if(changed){const r=this.get(repo,pr,schedule.head);this.s.db.query('INSERT INTO coderabbit_request_attempts VALUES (?,?,?,?,?,?,?,?,?)').run(repo,pr,schedule.head,r.attempts,schedule.signature,r.state,r.requested,null,0);}
   return changed;
  }).immediate();
 }
 settle(repo:string,pr:number,head:string,state:'accepted'|'rate_limited',evidence:string,retryAt?:number){
  assertObservationFence();this.s.db.transaction(()=>{
   const next=state==='rate_limited'?Math.max(this.now()+60000,Number.isSafeInteger(retryAt)?Math.min(retryAt!,this.now()+86400000):this.now()+REVIEW_TIMEOUT_MS):0;
   const changed=this.s.db.query("UPDATE coderabbit_requests SET state=?,evidence=?,next_attempt=? WHERE repo=? AND pr=? AND head=? AND state='delivery_uncertain'").run(state,evidence,next,repo,pr,head).changes;
   if(changed){const r=this.get(repo,pr,head);this.s.db.query('UPDATE coderabbit_request_attempts SET state=?,evidence=?,next_attempt=? WHERE repo=? AND pr=? AND head=? AND attempt=?').run(state,evidence,next,repo,pr,head,r.attempts);}
  }).immediate();
 }
}

export class ReviewRateLimit extends Error{constructor(public retryAt?:number){super('CodeRabbit review request rejected by rate limit');}}
export const CONFIG_QUERY='query($owner:String!,$name:String!,$hy:String!,$hm:String!,$by:String!,$bm:String!){repository(owner:$owner,name:$name){defaultBranchRef{name} hy:object(expression:$hy){... on Blob{oid text}} hm:object(expression:$hm){... on Blob{oid text}} by:object(expression:$by){... on Blob{oid text}} bm:object(expression:$bm){... on Blob{oid text}}}}';

export async function collectReviewSchedule(repo:string,pr:any,base:string,comments:any[],reviews:any[],checks:any[],read:(args:string[])=>Promise<any>):Promise<ReviewSchedule>{
 const head=pr.head.sha;
 const invalid=(detail:string)=>({head,signature:digest(JSON.stringify([head,base,detail])),incremental:false,blocker:`CodeRabbit review unavailable: ${detail}; no speculative request or clearance`});
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

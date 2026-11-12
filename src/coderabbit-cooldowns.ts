import {Store,digest} from './core';
import {assertObservationFence} from './observation-fence';
import {BOT_IDENTITIES} from './reviewer-policy';

// Published GitHub app identity, not a display-name match. Identity changes fail
// closed until reviewed. https://api.github.com/apps/coderabbitai
export const CODERABBIT_APP_ID=347564;
export const RATE_QUERY='@coderabbitai rate limit';
export function cycleExtensionPreview(s:Store,repo:string,pr:number){
 const c=s.db.query("SELECT 1 FROM sqlite_master WHERE name='coderabbit_cycles'").get()?s.db.query('SELECT * FROM coderabbit_cycles WHERE repo=? AND pr=? ORDER BY cycle DESC LIMIT 1').get(repo,pr) as any:null;
 if(!c||c.state!=='exhausted')throw Error('Exhausted review cycle required');
 return {cycle:c,confirmation:digest(JSON.stringify(c)),mutationReplay:false};
}
export type CooldownPolicy={buffer:number;fallback:number;maxDelay:number;jitter:number;retryLimit:number;window:number};
export const DEFAULT_COOLDOWN:CooldownPolicy={buffer:5*60000,fallback:60*60000,maxDelay:120*60000,jitter:0.05,retryLimit:6,window:24*60*60000};
export function cooldownPolicy(value?:Partial<CooldownPolicy>):CooldownPolicy{
 const p={...DEFAULT_COOLDOWN,...value};
 if(Object.keys(p).some(k=>!Object.keys(DEFAULT_COOLDOWN).includes(k)))throw Error('Unsupported CodeRabbit rateLimit option');
 for(const key of ['buffer','fallback','maxDelay','retryLimit','window'] as const)if(!Number.isSafeInteger(p[key])||p[key]<=0)throw Error(`Invalid CodeRabbit rateLimit ${key}`);
 if(p.buffer>60*60000||p.fallback>p.maxDelay||p.maxDelay>24*60*60000||p.retryLimit>6||p.window>24*60*60000||!Number.isFinite(p.jitter)||p.jitter<0||p.jitter>0.2)throw Error('CodeRabbit rateLimit exceeds bounded policy');
 return p;
}
export const trustedRabbit=(c:any)=>c?.user?.id===BOT_IDENTITIES.coderabbit.userId&&c.user.type==='Bot'&&c.user.login==='coderabbitai[bot]';
const stamp=(s:any)=>typeof s==='string'?Date.parse(s):NaN;
// Do not search examples, quoted text, code, or arbitrary prose for instructions.
function providerText(body:any):string|null{
 if(typeof body!=='string'||body.length>128000)return null;
 const text=body.replace(/<!--[^]*?-->/g,'').trim();
 if(/^ {0,3}(?:`{3}|~{3})/m.test(text)||/<(?:blockquote|pre|code)\b/i.test(text))return null;
 return text.split('\n').filter(line=>!/^\s*>/.test(line)).join('\n');
}
export type ThrottleEvidence={id:string;version:string;at:number;head:string;request?:string;reset:number|null;timing:string;guidance?:string;scope?:string;kind?:'already-reviewed'};
const guidance=(text:string)=>text.split(/\n|(?<=[.!?])\s+/).filter(s=>/available (?:in|at|after)|retry (?:after|in|at)|try again in/i.test(s)).map(s=>s.trim()).join('\n');
const resultLead=(text:string)=>text.replace(/^(?:<details>\s*|<summary>Action not completed<\/summary>\s*|<dl>\s*|<dd>\s*|<br\s*\/?>\s*)*/i,'').trim().replace(/^#{1,6}\s+/,'');
export type RabbitObservation={repo:string;pr:number;head:string;comments:any[];checks:any[];author?:{id:number;login:string};observed:number};
function resetTime(text:string,at:number):number|null{
 const relative=[...text.matchAll(/(?:next (?:included )?review (?:will be |is )?available in|try again in|retry (?:after|in))\s+(\d+)\s*(seconds?|minutes?|hours?)/ig)];
 const absolute=[...text.matchAll(/(?:next (?:included )?review (?:will be |is )?available (?:at|after)|retry at)\s+(\d{4}-\d\d-\d\dT[\d:.]+Z)/ig)];
 const values=[...relative.map(m=>at+Number(m[1])*({s:1000,m:60000,h:3600000}[m[2][0].toLowerCase()]!)),...absolute.map(m=>Date.parse(m[1]))];
 if(relative.some(m=>/^\s*(?:and\s+)?\d+\s*(?:seconds?|minutes?|hours?)/i.test(text.slice(m.index!+m[0].length))))return null;
 return values.length===1&&Number.isSafeInteger(values[0])&&values[0]>=at&&values[0]<=8640000000000000?values[0]:null;
}
/** A reply needs an explicit head, a pinned current-head run, or a unique
 * preceding command receipt. Mere proximity to a user comment is not enough. */
export function throttleEvidence(o:RabbitObservation,receipts:any[],query?:any):ThrottleEvidence[]{
 const result:ThrottleEvidence[]=[];
 const runs=o.checks.filter(c=>c.app?.id===CODERABBIT_APP_ID&&c.app?.slug==='coderabbitai'&&c.head_sha===o.head&&Number.isSafeInteger(c.id));
 for(const c of runs){
  const text=providerText([c.output?.title,c.output?.summary,c.output?.text].filter(Boolean).join('\n')),at=stamp(c.completed_at??c.started_at);
   if(!text||!/^(?:Review rate limited|Rate limit (?:exceeded|reached))\b/i.test(c.output?.title??'')||!Number.isFinite(at)||at>o.observed)continue;
  const request=receipts.filter(r=>r.head===o.head&&stamp(c.started_at)+1000>=r.requested&&at+1000>=r.requested).sort((a,b)=>b.requested-a.requested)[0];
  result.push({id:`check:${c.id}`,version:digest(JSON.stringify([c.completed_at,c.output])),at,head:o.head,request:request?`${request.head}:${request.attempts}`:undefined,reset:resetTime(text,at),timing:text,guidance:guidance(text)});
 }
 for(const c of o.comments){
  if(!trustedRabbit(c)||!Number.isSafeInteger(c.id)||c.issue_url!==`https://api.github.com/repos/${o.repo}/issues/${o.pr}`)continue;
  const text=providerText(c.body),created=stamp(c.created_at),edited=stamp(c.updated_at);
   const lead=text?resultLead(text):'',already=/^(?:All commits (?:have |were )?already (?:been )?reviewed\b|No new commits to review\b|Nothing to review\b)/i.test(lead);
   if(!text||!Number.isFinite(created)||!Number.isFinite(edited)||created>edited||edited>o.observed||!already&&!/^(?:Review rate limited\.?|Your included review limit is currently reached\b|You're currently rate limited\b)/i.test(lead))continue;
  const commands=o.comments.filter(x=>typeof x.body==='string'&&/^@coderabbitai (?:full review|review|rate limit)(?:\s|$)/.test(x.body)&&stamp(x.created_at)<=created&&x.id<c.id).sort((a,b)=>stamp(b.created_at)-stamp(a.created_at)||b.id-a.id);
  const prior=commands[0];
  const receipt=receipts.find(r=>String(r.comment_id)===String(prior?.id)&&r.requested<=created+1000&&created-r.requested<=30*60000);
  const queryBound=query&&String(query.comment_id)===String(prior?.id)&&query.requested<=created+1000&&created-query.requested<=24*60*60000;
  const commits=[...text.matchAll(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/commit\/([a-f0-9]{40})\b/g)];
  const headBound=commits.length===1&&commits[0][1]===o.repo&&commits[0][2]===o.head;
  const runBound=runs.some(r=>stamp(r.started_at)<=edited&&stamp(r.completed_at)>=edited);
  if(!receipt&&!queryBound&&!headBound&&!runBound)continue;
  // First versions have a reliable creation baseline. Edited relative guidance
  // is ambiguous on first observation; the ledger may retain an earlier baseline.
  const reset=created===edited||!/available in|retry (?:after|in)|try again in/i.test(text)?resetTime(text,created):null;
  // Quota is per developer. Widen scope only when the authenticated provider
  // explicitly names the PR author and the GitHub immutable author ID is known.
   const scope=o.author&&Number.isSafeInteger(o.author.id)&&o.author.id>0&&typeof o.author.login==='string'&&new RegExp(`\\b(?:developer|account) @${o.author.login.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(text)?`github-user:${o.author.id}`:undefined;
  result.push({id:`comment:${c.id}`,version:digest(JSON.stringify([c.updated_at,c.body])),at:created,head:receipt?.head??o.head,request:receipt?`${receipt.head}:${receipt.attempts}`:queryBound?`query:${query.episode}`:undefined,reset,timing:text,guidance:guidance(text),scope,kind:already?'already-reviewed':undefined});
 }
 return result;
}

/** Shared SQLite ledger: cycle identity is PR-scoped, never head/job-scoped. */
export class CodeRabbitCooldowns{
 constructor(public s:Store,public now=Date.now,public random=Math.random){s.db.exec(`
 CREATE TABLE IF NOT EXISTS coderabbit_cycles(repo TEXT NOT NULL,pr INTEGER NOT NULL,cycle INTEGER NOT NULL,head TEXT NOT NULL,started INTEGER NOT NULL,deadline INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,limit_attempts INTEGER NOT NULL,state TEXT NOT NULL,next_action INTEGER NOT NULL,episode INTEGER NOT NULL DEFAULT 1,reliable INTEGER NOT NULL DEFAULT 0,scope TEXT,PRIMARY KEY(repo,pr,cycle));
 CREATE TABLE IF NOT EXISTS coderabbit_throttle_evidence(repo TEXT NOT NULL,pr INTEGER NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,cycle INTEGER NOT NULL,observed INTEGER NOT NULL,at INTEGER NOT NULL,retry_at INTEGER NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(repo,pr,id,version));
 CREATE TABLE IF NOT EXISTS coderabbit_queries(repo TEXT NOT NULL,pr INTEGER NOT NULL,cycle INTEGER NOT NULL,episode INTEGER NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,body TEXT NOT NULL,comment_id TEXT,author_id INTEGER,retry_after INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(repo,pr,cycle,episode));
 CREATE TABLE IF NOT EXISTS coderabbit_cycle_extensions(repo TEXT NOT NULL,pr INTEGER NOT NULL,cycle INTEGER NOT NULL,created INTEGER NOT NULL,human TEXT NOT NULL,previous TEXT NOT NULL,PRIMARY KEY(repo,pr,cycle,created));`);
  if(!(s.db.query('PRAGMA table_info(coderabbit_queries)').all() as any[]).some(c=>c.name==='retry_after'))s.db.exec('ALTER TABLE coderabbit_queries ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0');
 }
 get(repo:string,pr:number):any{return this.s.db.query('SELECT * FROM coderabbit_cycles WHERE repo=? AND pr=? ORDER BY cycle DESC LIMIT 1').get(repo,pr);}
 query(c:any):any{return this.s.db.query('SELECT * FROM coderabbit_queries WHERE repo=? AND pr=? AND cycle=? AND episode=?').get(c.repo,c.pr,c.cycle,c.episode);}
 observe(o:RabbitObservation,receipts:any[],config?:Partial<CooldownPolicy>){
  assertObservationFence();const p=cooldownPolicy(config);
  return this.s.db.transaction(()=>{
   let c=this.get(o.repo,o.pr);const evidence=throttleEvidence(o,receipts,c?this.query(c):null);
   for(const e of evidence){
    if(this.s.db.query('SELECT 1 FROM coderabbit_throttle_evidence WHERE repo=? AND pr=? AND id=? AND version=?').get(o.repo,o.pr,e.id,e.version))continue;
    // Historical evidence cannot open or mutate a later cycle. A cooldown is
    // conservative evidence, never a license to replay an unbound request.
    const prior=this.s.db.query('SELECT * FROM coderabbit_throttle_evidence WHERE repo=? AND pr=? AND id=? ORDER BY observed LIMIT 1').get(o.repo,o.pr,e.id) as any;
    if(c&&e.at+1000<c.started&&!prior||this.now()-e.at>24*60*60000)continue;
    if(!c||c.state==='completed'){
     if(e.kind==='already-reviewed')continue;
     if(c&&e.at<=c.next_action)continue;
     this.s.db.query("INSERT INTO coderabbit_cycles(repo,pr,cycle,head,started,deadline,limit_attempts,state,next_action) VALUES (?,?,?,?,?,?,?,'waiting',?)").run(o.repo,o.pr,(c?.cycle??0)+1,o.head,this.now(),this.now()+p.window,p.retryLimit,this.now());c=this.get(o.repo,o.pr);
    }
    const sameTiming=prior&&JSON.parse(prior.evidence).guidance===e.guidance;
    const reliable=e.reset!==null&&e.reset>this.now()&&e.reset+p.buffer<=8640000000000000;
    const fallback=Math.min(p.maxDelay,p.fallback*2**Math.min(c.attempts,1)*(1+p.jitter*this.random()));
    const retry=sameTiming?prior.retry_at:reliable?e.reset!+p.buffer:this.now()+Math.ceil(fallback);
    this.s.db.query('INSERT INTO coderabbit_throttle_evidence VALUES (?,?,?,?,?,?,?,?,?)').run(o.repo,o.pr,e.id,e.version,c.cycle,this.now(),e.at,retry,JSON.stringify(e));
    // Unrelated edits cannot restart a wait episode or extend its clock. New
    // throttle outcomes after an actual reserved retry start the next episode.
    const fresh=!prior;
    const latest=receipts.filter(r=>['accepted','delivery_uncertain'].includes(r.state)).sort((a,b)=>b.requested-a.requested)[0];
    const outcomeBound=!latest||e.request===`${latest.head}:${latest.attempts}`;
    if(e.kind==='already-reviewed'&&outcomeBound)this.s.db.query("UPDATE coderabbit_cycles SET state='already_reviewed' WHERE repo=? AND pr=? AND cycle=?").run(o.repo,o.pr,c.cycle);
    else if(c.state==='requesting'&&fresh&&outcomeBound)this.s.db.query("UPDATE coderabbit_cycles SET state='waiting',episode=episode+1,reliable=0 WHERE repo=? AND pr=? AND cycle=?").run(o.repo,o.pr,c.cycle);
    const keepReliable=c.reliable&&c.next_action>this.now()&&fresh&&c.state!=='requesting'&&!reliable;
    if((fresh||!sameTiming)&&!keepReliable)this.s.db.query("UPDATE coderabbit_cycles SET next_action=?,reliable=?,scope=COALESCE(?,scope) WHERE repo=? AND pr=? AND cycle=?").run(reliable&&!c.reliable?retry:Math.max(c.next_action,retry),Number(reliable),e.scope??null,o.repo,o.pr,c.cycle);
    c=this.get(o.repo,o.pr);
   }
   if(c&&c.state!=='completed'){
    if(c.state==='already_reviewed'&&c.head!==o.head)this.s.db.query("UPDATE coderabbit_cycles SET state='waiting' WHERE repo=? AND pr=? AND cycle=?").run(o.repo,o.pr,c.cycle);
    this.s.db.query('UPDATE coderabbit_cycles SET head=? WHERE repo=? AND pr=? AND cycle=?').run(o.head,o.repo,o.pr,c.cycle);
    c=this.get(o.repo,o.pr);
    if(this.now()>=c.deadline||c.attempts>=c.limit_attempts&&c.state==='waiting')this.s.db.query("UPDATE coderabbit_cycles SET state='exhausted' WHERE repo=? AND pr=? AND cycle=?").run(o.repo,o.pr,c.cycle);
   }
   return this.get(o.repo,o.pr);
  }).immediate();
 }
 effectiveRetry(c:any){
  const shared=c.scope?(this.s.db.query("SELECT MAX(next_action) AS retry FROM coderabbit_cycles WHERE scope=? AND state!='completed'").get(c.scope) as any)?.retry:0;
  return Math.max(c.next_action,shared??0,this.query(c)?.retry_after??0);
 }
 http(repo:string,pr:number,head:string,attempt:number,retryAt?:number,config?:Partial<CooldownPolicy>){
  assertObservationFence();const p=cooldownPolicy(config);this.s.db.transaction(()=>{
   let c=this.get(repo,pr);
   if(!c||c.state==='completed'){this.s.db.query("INSERT INTO coderabbit_cycles(repo,pr,cycle,head,started,deadline,limit_attempts,state,next_action) VALUES (?,?,?,?,?,?,?,'waiting',?)").run(repo,pr,(c?.cycle??0)+1,head,this.now(),this.now()+p.window,p.retryLimit,this.now());c=this.get(repo,pr);}
    const next=retryAt&&Number.isSafeInteger(retryAt)?Math.max(this.now(),retryAt)+p.buffer:this.now()+Math.ceil(Math.min(p.maxDelay,p.fallback*2**Math.min(c.attempts,1)*(1+p.jitter*this.random())));
   const id=`http:${head}:${attempt}`;
   const changed=this.s.db.query('INSERT OR IGNORE INTO coderabbit_throttle_evidence VALUES (?,?,?,?,?,?,?,?,?)').run(repo,pr,id,id,c.cycle,this.now(),this.now(),next,JSON.stringify({id,head,request:`${head}:${attempt}`,transport:'github',reset:retryAt??null})).changes;
   if(changed)this.s.db.query("UPDATE coderabbit_cycles SET head=?,state='waiting',episode=episode+?,reliable=?,next_action=MAX(next_action,?) WHERE repo=? AND pr=? AND cycle=?").run(head,c.state==='requesting'?1:0,Number(!!retryAt),next,repo,pr,c.cycle);
  }).immediate();
 }
 reason(c:any){return c.state==='already_reviewed'?`CodeRabbit review unavailable: provider already reviewed head ${c.head}; no repeated regular requests. Inspect the existing review and metadata gates; whole-PR reassessment requires explicit operator full review.`:c.state==='exhausted'?`CodeRabbit review unavailable: rate-limit retry cycle ${c.cycle} exhausted (${c.attempts}/${c.limit_attempts} retries; deadline ${new Date(c.deadline).toISOString()}). Preview extend-review-cycle JOB, then confirm with a named human; receipts, cooldown and uncertainty remain intact.`:`CodeRabbit rate limited; next retry at ${new Date(this.effectiveRetry(c)).toISOString()}`;}
 claimQuery(c:any){
  assertObservationFence();return this.s.db.transaction(()=>{
  const fresh=this.get(c.repo,c.pr);
  if(!fresh||fresh.cycle!==c.cycle||fresh.episode!==c.episode||fresh.state!=='waiting'||fresh.reliable||this.now()>=fresh.deadline)return null;
  const body=`${RATE_QUERY}\n\n<!-- adlc-coderabbit-availability:${digest(JSON.stringify([c.repo,c.pr,c.cycle,c.episode]))} -->`;
   const changed=this.s.db.query("INSERT OR IGNORE INTO coderabbit_queries(repo,pr,cycle,episode,state,requested,body) VALUES (?,?,?,?,'delivery_uncertain',?,?)").run(c.repo,c.pr,c.cycle,c.episode,this.now(),body).changes;
  return changed?this.query(c):null;
  }).immediate();
 }
 chatThrottle(q:any,retryAt?:number){
  assertObservationFence();const retry=Number.isSafeInteger(retryAt)&&retryAt!<=8640000000000000?retryAt!:0;
  this.s.db.query("UPDATE coderabbit_queries SET state='chat_throttled',retry_after=MAX(retry_after,?) WHERE repo=? AND pr=? AND cycle=? AND episode=? AND state='delivery_uncertain'").run(retry,q.repo,q.pr,q.cycle,q.episode);
 }
 settleQuery(q:any,comment:any){
   assertObservationFence();if(comment?.body!==q.body||!Number.isSafeInteger(comment.id)||!Number.isSafeInteger(comment.user?.id)||!Number.isFinite(stamp(comment.created_at))||stamp(comment.created_at)+1000<q.requested) return false;
  return !!this.s.db.query("UPDATE coderabbit_queries SET state='delivered',comment_id=?,author_id=? WHERE repo=? AND pr=? AND cycle=? AND episode=? AND state='delivery_uncertain'").run(String(comment.id),comment.user.id,q.repo,q.pr,q.cycle,q.episode).changes;
 }
 reserve(repo:string,pr:number,head:string){
  assertObservationFence();const c=this.get(repo,pr);if(!c||c.state==='completed')return true;
  if(c.state!=='waiting'||c.head!==head||this.now()<this.effectiveRetry(c)||this.now()>=c.deadline||c.attempts>=c.limit_attempts)return false;
  const q=this.query(c);if(q?.state==='delivery_uncertain')return false;
  return !!this.s.db.query("UPDATE coderabbit_cycles SET state='requesting',attempts=attempts+1 WHERE repo=? AND pr=? AND cycle=? AND state='waiting'").run(repo,pr,c.cycle).changes;
 }
 complete(repo:string,pr:number,head:string){assertObservationFence();this.s.db.query("UPDATE coderabbit_cycles SET state='completed',next_action=? WHERE repo=? AND pr=? AND head=? AND state!='completed'").run(this.now(),repo,pr,head);}
 extendPreview(repo:string,pr:number){return cycleExtensionPreview(this.s,repo,pr);}
 extend(repo:string,pr:number,confirmation:string,human:string){
  assertObservationFence();return this.s.db.transaction(()=>{const v=this.extendPreview(repo,pr);if(v.confirmation!==confirmation||!human.trim()||human.length>200)throw Error('Fresh cycle confirmation and named human required');
   this.s.db.query('INSERT INTO coderabbit_cycle_extensions VALUES (?,?,?,?,?,?)').run(repo,pr,v.cycle.cycle,this.now(),human.trim(),JSON.stringify(v.cycle));
   this.s.db.query("UPDATE coderabbit_cycles SET state='waiting',deadline=?,limit_attempts=limit_attempts+6 WHERE repo=? AND pr=? AND cycle=?").run(this.now()+24*60*60000,repo,pr,v.cycle.cycle);
   return {state:'extended',mutationReplay:false,receipts:'retained',cycle:this.get(repo,pr)};
  }).immediate();
 }
}

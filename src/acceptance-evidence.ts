import {Store,digest} from './core';
import {assertObservationFence} from './observation-fence';

export type AcceptanceCheck={id:string;kind:'check'|'responsive'|'live-content';definition:string;viewports?:string[];environment?:string;verifier?:string[]};
export type DraftPolicy={enabled:boolean;repository:string;operators:string[];integrations:string[];checks:AcceptanceCheck[];maxAgeMs?:number};
/** A host-installed callback, never a property that JSON/ticket text can forge. */
export const CURRENT_DRAFT_POLICY=Symbol('current trusted draft project policy');
export function bindDraftConfig<T extends object>(c:T,read:()=>any):T{
 const fingerprint=(v:any)=>digest(JSON.stringify([v.repo,v.githubRepo,v.linear?.projectId,v.linear?.teamId,v.automation?.orchestratorProject,v.approval,v.draftPromotion,v.requiredChecks]));
 const expected=fingerprint(c);
 Object.defineProperty(c,CURRENT_DRAFT_POLICY,{value:()=>{
  let current;try{current=read();}catch{throw Error('Trusted draft project policy unavailable; reload before any effect');}
  if(fingerprint(current)!==expected)throw Error('Trusted draft project policy changed; reload before any effect');
 }});
 return c;
}
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=2000&&!/[\x00-\x1f]/.test(v);
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(text)&&new Set(v).size===v.length;
function keys(v:any,names:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!names.includes(k)))throw Error('Unknown draft promotion/evidence field');}
export function validateDraftPolicy(p:any,repo:unknown):asserts p is DraftPolicy|undefined{
 if(p===undefined)return;
 keys(p,['enabled','repository','operators','integrations','checks','maxAgeMs']);
 if(typeof p.enabled!=='boolean'||!text(p.repository)||p.repository!==repo||!strings(p.operators)||!strings(p.integrations)||!Array.isArray(p.checks)||!p.checks.length||p.checks.length>100)throw Error('Explicit repository-bound draft promotion policy, issuers and acceptance checks required');
 if(p.maxAgeMs!==undefined&&(!Number.isSafeInteger(p.maxAgeMs)||p.maxAgeMs<1))throw Error('Positive draft evidence freshness limit required');
 const ids=new Set();
 for(const c of p.checks){
  keys(c,['id','kind','definition','viewports','environment','verifier']);
  if(!text(c.id)||ids.has(c.id)||!text(c.definition)||!['check','responsive','live-content'].includes(c.kind))throw Error('Unique defined acceptance checks required');
  ids.add(c.id);
  if(c.kind==='responsive'&&(!strings(c.viewports)||!c.viewports.length)||c.kind!=='responsive'&&c.viewports!==undefined)throw Error('Explicit responsive viewport coverage required');
  if(c.kind==='live-content'&&(!text(c.environment)||c.verifier!==undefined&&(!strings(c.verifier)||!c.verifier.length||!c.verifier[0].startsWith('/')))||c.kind!=='live-content'&&(c.environment!==undefined||c.verifier!==undefined))throw Error('Live check requires environment and an optional explicit absolute verifier argv');
 }
}
export type AcceptanceRecord={repository:string;pr:number;head:string;check:string;definitionHash:string;passed:boolean;issuer:string;observed:number;reference:string;viewports?:string[];environment?:string;revision?:string};
export type DraftBinding={job:string;plan:string;spec:string;revision:string|null;dispatch:string;session:string;worktree:string;branch:string;repo:string;pr:number;head:string;authorization:string};
export const checkHash=(c:AcceptanceCheck)=>digest(JSON.stringify(c));
const exists=(s:Store,t:string)=>!!s.db.query("SELECT name FROM sqlite_master WHERE name=?").get(t);
/** Call inside the caller's immediate reservation transaction. All delivery
 * engines share this exclusion without clearing or repairing one another. */
export function assertDeliveryUnreserved(s:Store,job:string,own:'adoption'|'continuation'|'promotion'){
 if(own!=='adoption'&&exists(s,'delivery_adoptions')&&s.db.query("SELECT 1 FROM delivery_adoptions WHERE job=? AND state IN ('reserved','claim_uncertain')").get(job))throw Error('Delivery adoption already reserved or uncertain; reconcile before continuation/promotion');
 if(own!=='continuation'&&exists(s,'continuations')&&s.db.query("SELECT 1 FROM continuations WHERE job=? AND state IN ('reserved','delivery_uncertain','delivery_accepted')").get(job))throw Error('Continuation already reserved or in flight; reconcile before adoption/promotion');
 if(own!=='promotion'&&exists(s,'draft_promotions')&&s.db.query("SELECT 1 FROM draft_promotions WHERE job=? AND state='uncertain'").get(job))throw Error('Draft promotion reserved or uncertain; reconcile before adoption/continuation');
}
/** Separate from CI and review clearance. References are opaque, never fetched. */
export class AcceptanceEvidence{
 constructor(public s:Store,public now=Date.now){}
 install(){
  this.s.db.exec(`CREATE TABLE IF NOT EXISTS acceptance_evidence(id TEXT PRIMARY KEY,job TEXT NOT NULL REFERENCES jobs(id),binding TEXT NOT NULL,check_id TEXT NOT NULL,record TEXT NOT NULL,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS draft_deliveries(job TEXT PRIMARY KEY REFERENCES jobs(id),plan_hash TEXT NOT NULL,binding TEXT NOT NULL,detail TEXT NOT NULL,reason TEXT NOT NULL,observed INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS draft_promotions(job TEXT NOT NULL REFERENCES jobs(id),binding TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(job,binding));`);
 }
 record(b:DraftBinding,p:DraftPolicy,r:AcceptanceRecord,principal:{kind:'operator'|'integration';id:string}){
  validateDraftPolicy(p,b.repo);
  keys(r,['repository','pr','head','check','definitionHash','passed','issuer','observed','reference','viewports','environment','revision']);
  const c=p.checks.find(c=>c.id===r.check),issuers=principal.kind==='operator'?p.operators:principal.kind==='integration'?p.integrations:[];
  if(!issuers.includes(principal.id)||r.issuer!==principal.id)throw Error('Acceptance issuer is not explicitly trusted for this project');
  if(!c||r.repository!==b.repo||r.pr!==b.pr||r.head!==b.head||r.definitionHash!==checkHash(c)||typeof r.passed!=='boolean'||!text(r.reference)||!Number.isSafeInteger(r.observed)||r.observed>this.now()||r.observed<1)throw Error('Exact current acceptance check, head, definition, time and evidence reference required');
  if(c.kind==='responsive'&&(!strings(r.viewports)||c.viewports!.some(v=>!r.viewports!.includes(v))))throw Error(`Acceptance ${c.id}: missing required viewports`);
  if(c.kind==='live-content'&&(r.environment!==c.environment||!text(r.revision)))throw Error(`Acceptance ${c.id}: exact environment and content revision/digest required`);
  this.install();
  const binding=JSON.stringify(b),record=JSON.stringify({...r,issuerKind:principal.kind}),id=digest(JSON.stringify([binding,record]));
  this.s.db.query('INSERT OR IGNORE INTO acceptance_evidence VALUES (?,?,?,?,?,?)').run(id,b.job,binding,c.id,record,this.now());
  this.s.event(b.job,'acceptance_evidence_recorded',JSON.stringify({id,check:c.id,issuer:principal.id,kind:principal.kind}));
  return {id,check:c.id,definitionHash:checkHash(c),recorded:true};
 }
 async blockers(b:DraftBinding,p:DraftPolicy|undefined,verify:(c:AcceptanceCheck,r:AcceptanceRecord)=>Promise<boolean>){
  if(!p)return ['Draft promotion is disabled; configure explicit repository-bound policy and required acceptance checks'];
  validateDraftPolicy(p,b.repo);
  const policy=JSON.stringify(p);
  const blockers:string[]=p.enabled?[]:['Draft promotion is disabled by trusted project configuration'];
  const read=()=>exists(this.s,'acceptance_evidence')?this.s.db.query('SELECT record FROM acceptance_evidence WHERE job=? AND binding=? ORDER BY at DESC,rowid DESC').all(b.job,JSON.stringify(b)) as any[]:[];
  const rows=read(),selected:AcceptanceRecord[]=[];
  for(const c of p.checks){
   // A later failure supersedes a prior pass; never search backwards for green.
   const r=rows.map(row=>JSON.parse(row.record) as AcceptanceRecord).find(r=>r.check===c.id&&r.definitionHash===checkHash(c));
   if(!r){blockers.push(`Acceptance ${c.id}: missing current-head/current-definition evidence`);continue;}
   selected.push(r);
   const issuers=(r as any).issuerKind==='operator'?p.operators:(r as any).issuerKind==='integration'?p.integrations:[];
   if(!issuers.includes(r.issuer)){blockers.push(`Acceptance ${c.id}: issuer no longer trusted`);continue;}
   if(!r.passed){blockers.push(`Acceptance ${c.id}: verification failed`);continue;}
   if(r.observed>this.now()||p.maxAgeMs!==undefined&&this.now()-r.observed>p.maxAgeMs){blockers.push(`Acceptance ${c.id}: evidence stale`);continue;}
   if(c.kind==='responsive'&&c.viewports!.some(v=>!r.viewports?.includes(v)))blockers.push(`Acceptance ${c.id}: missing required viewports`);
   if(c.kind==='live-content'){
    let current=false;try{current=!!c.verifier&&r.environment===c.environment&&!!r.revision&&await verify(c,r);}catch{/* Unavailable is not a pass. */}
    if(!current)blockers.push(`Acceptance ${c.id}: current live content revision cannot be verified`);
   }
  }
  if(JSON.stringify(read())!==JSON.stringify(rows)||JSON.stringify(p)!==policy)blockers.push('Acceptance evidence or policy changed during verification; reevaluate');
  if(selected.some(r=>r.observed>this.now()||p.maxAgeMs!==undefined&&this.now()-r.observed>p.maxAgeMs)&&!blockers.some(b=>b.includes('stale')))blockers.push('Acceptance evidence became stale during verification');
  return blockers;
 }
 observe(b:DraftBinding,reasons:string[]){
  this.install();
  const old=this.s.db.query('SELECT binding,reason FROM draft_deliveries WHERE job=?').get(b.job) as any;
  // Preserve the blocker version while unchanged. A fresh read is not a new
  // blocker instance and must not produce a Linear notice on every poll.
  if(old?.binding===digest(JSON.stringify(b))&&old.reason===reasons.join('; '))return;
  this.s.db.query('INSERT INTO draft_deliveries VALUES (?,?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET plan_hash=excluded.plan_hash,binding=excluded.binding,detail=excluded.detail,reason=excluded.reason,observed=excluded.observed').run(b.job,b.plan,digest(JSON.stringify(b)),JSON.stringify(b),reasons.join('; '),this.now());
  if(old?.binding!==digest(JSON.stringify(b)))this.s.event(b.job,'draft_delivery_observed',JSON.stringify(b));
 }
}
export type PromotionFacts={binding:DraftBinding;draft:boolean;blockers:string[]};
/** At most one mutation attempt for the same job/PR. An uncertain attempt
 * survives restart and is settled only by authoritative ready-state evidence. */
export async function promoteDraft(s:Store,p:DraftPolicy|undefined,inspect:()=>Promise<PromotionFacts>,promote:(b:DraftBinding)=>Promise<void>){
 const evidence=new AcceptanceEvidence(s),first=await inspect();
 if(first.blockers.length)return {ready:false,blockers:first.blockers};
 if(!p?.enabled)return {ready:false,blockers:['Draft promotion is disabled']};
 const fingerprint=digest(JSON.stringify([first.binding,p])),same=(f:PromotionFacts)=>digest(JSON.stringify([f.binding,p]))===fingerprint;
 evidence.install();
 if(!first.draft){
  s.db.query("UPDATE draft_promotions SET state='promoted' WHERE job=? AND binding=? AND state='uncertain'").run(first.binding.job,fingerprint);
  return {ready:true,blockers:[]};
 }
 const prior=(s.db.query('SELECT state,detail FROM draft_promotions WHERE job=?').all(first.binding.job) as any[]).find(r=>{const b=JSON.parse(r.detail);return b.repo===first.binding.repo&&b.pr===first.binding.pr;});
 if(prior)return {ready:false,blockers:[`Draft promotion ${prior.state}; reconcile provider ready state, never replay promotion`]};
 const fresh=await inspect();
 if(!same(fresh)||fresh.blockers.length||!fresh.draft)return {ready:!fresh.draft&&same(fresh)&&fresh.blockers.length===0,blockers:fresh.blockers.length?fresh.blockers:['Draft promotion evidence changed; reevaluate']};
 assertObservationFence();
 const reserved=s.db.transaction(()=>{
  assertDeliveryUnreserved(s,first.binding.job,'promotion');
  const pending=(s.db.query('SELECT detail FROM draft_promotions WHERE job=?').all(first.binding.job) as any[]).some(r=>{const b=JSON.parse(r.detail);return b.repo===first.binding.repo&&b.pr===first.binding.pr;});
  if(pending)return {changes:0};
  return s.db.query("INSERT OR IGNORE INTO draft_promotions VALUES (?,?,'uncertain',?)").run(first.binding.job,fingerprint,JSON.stringify(first.binding));
 }).immediate();
 if(reserved.changes)try{await promote(first.binding);}catch{/* Do not retry an uncertain mutation. */}
 const after=await inspect();
 if(!same(after)||after.blockers.length||after.draft)return {ready:false,blockers:after.blockers.length?after.blockers:['Draft promotion uncertain or head changed; reconcile without replay']};
 const settled=s.db.query("UPDATE draft_promotions SET state='promoted' WHERE job=? AND binding=? AND state='uncertain'").run(first.binding.job,fingerprint);
 if(settled.changes)s.event(first.binding.job,'draft_promoted',JSON.stringify(first.binding));
 return {ready:true,blockers:[]};
}

/** Only explicitly trusted project configuration supplies the executable/argv.
 * No shell, evidence-reference fetching, credentials or user-supplied commands. */
export async function verifyLiveContent(c:AcceptanceCheck,r:AcceptanceRecord){
 if(!c.verifier)return false;
 const child=Bun.spawn(c.verifier,{stdin:'ignore',stdout:'pipe',stderr:'pipe',timeout:30000,env:{PATH:'/usr/bin:/bin',ADLC_EVIDENCE_ENVIRONMENT:c.environment!}});
 const [out,,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0||out.length>16000)return false;
 try{const live=JSON.parse(out);return live.environment===c.environment&&live.revision===r.revision;}catch{return false;}
}

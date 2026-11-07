import {AO} from './orchestrator';
import {readFailure,malformed,ProviderReadError} from './provider-read';
import {Store,digest} from './core';
import {recordReadiness} from './readiness';
import {RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';

// Receipt evidence is valid only while the whole collection remains fresh. Bound
// each page by the remaining window so a hung page cannot outlive the evidence.
class TurnStateChanged extends Error{}
const TURN_CONSISTENCY_ATTEMPTS=3;
export async function sessionEvidence(session:string,spawn=Bun.spawn,freshnessMs=RECEIPT_FRESHNESS_MS){
 if(!/^[a-zA-Z0-9_-]+$/.test(session))throw Error('Session ID required');
 if(!Number.isSafeInteger(freshnessMs)||freshnessMs<1)throw Error('Positive receipt freshness window required');
 for(let attempt=0;attempt<TURN_CONSISTENCY_ATTEMPTS;attempt++){
  try{return await collectSessionEvidence(session,spawn,freshnessMs);}catch(cause){
   // Pages may legitimately carry different page-local turns. Only a turn whose
   // own evidence changed is retried; persistent drift stays fail-closed.
   if(cause instanceof TurnStateChanged){if(attempt+1<TURN_CONSISTENCY_ATTEMPTS)continue;throw malformed('orchestrator','session-evidence',cause);}
   if(cause instanceof ProviderReadError)throw cause;
   throw readFailure('orchestrator','session-evidence','unknown',undefined,cause);
  }
 }
 throw malformed('orchestrator','session-evidence',new Error('Turn state changed during transcript pagination; refresh evidence'));
}
async function collectSessionEvidence(session:string,spawn:typeof Bun.spawn,freshnessMs:number){
 const started=Date.now(),deadline=started+freshnessMs;let before:number|undefined,first:any;const entries:any[]=[];const turns=new Map<string,{value:any,hash:string}>();let sawTurns=false;
 for(let page=0;page<100;page++){
 const remaining=deadline-Date.now();if(remaining<1)throw readFailure('orchestrator','session-evidence','timeout');
 const p=spawn([AO,'session','get',session,'--transcript','100','--json','--cap','0',...(before===undefined?[]:['--before',String(before)])],{stdout:'pipe',stderr:'pipe',timeout:Math.min(30000,remaining)});
 const [text,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(Date.now()>=deadline)throw readFailure('orchestrator','session-evidence','timeout');
 if(code!==0)throw readFailure('orchestrator','session-evidence',p.signalCode==='SIGTERM'?'timeout':err,code);
 let r;try{r=JSON.parse(text);}catch(cause){throw malformed('orchestrator','session-evidence',cause);}
 if(r.session?.id!==session||!Array.isArray(r.transcript?.entries))throw malformed('orchestrator','session-evidence');
 if(!first)first=r;
 // Reconcile turns by identity: a page-local turn is additive, while the same
 // turn carrying different evidence means the transcript moved under us.
 if(Array.isArray(r.transcript.turns)){
  sawTurns=true;
  for(const t of r.transcript.turns){
   const key=String(t?.id),hash=JSON.stringify(t),prior=turns.get(key);
   if(prior&&prior.hash!==hash)throw new TurnStateChanged(`Turn ${key} changed during transcript pagination; refresh evidence`);
   if(!prior)turns.set(key,{value:t,hash});
  }
 }
 const batch=r.transcript.entries;
 if(batch.some((x:any)=>!Number.isSafeInteger(x.sequence)||(before!==undefined&&x.sequence>=before))||new Set(batch.map((x:any)=>x.sequence)).size!==batch.length)throw malformed('orchestrator','session-evidence',new Error('Invalid transcript pagination sequence'));
 entries.unshift(...batch);
 if(r.transcript.hasMoreBefore===false||r.transcript.hasMoreBefore===undefined&&batch.length<100){first.transcript.entries=entries;if(sawTurns)first.transcript.turns=[...turns.values()].map(x=>x.value);first.receiptObservation={observed:started,complete:true};return first;}
 if(!batch.length)throw malformed('orchestrator','session-evidence',new Error('Transcript page has no pagination cursor'));
 before=Math.min(...batch.map((x:any)=>x.sequence));
 }
 throw malformed('orchestrator','session-evidence',new Error('Transcript pagination limit reached; receipt evidence incomplete'));
}
// Capturing an agent plan never approves it. The caller selects a concrete entry;
// human approval remains bound to the specification+plan hash in Store.approve.
export function capturePlan(s:Store,job:string,r:any,sequence:number,expectRevision?:string|null){
 const reservation=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
 const j=s.get(job);
 if(!reservation||reservation.spec_hash!==digest(j.spec)||reservation.project!==r.session?.projectId||reservation.branch!==r.session?.branch||reservation.session_id&&reservation.session_id!==r.session?.id)throw Error('Planning reservation does not match session');
 const entry=r.transcript?.entries?.find((e:any)=>e.sequence===sequence);
 if(!entry||entry.kind!=='message'||entry.role!=='assistant'||entry.origin!=='provider'||entry.streaming||!entry.text?.trim())throw Error('Completed assistant plan entry required');
 if(j.plan===entry.text&&j.plan_hash===digest(JSON.stringify([j.spec,entry.text])))return {hash:j.plan_hash,approved:j.state==='approved',session:r.session.id,sequence,readiness:recordReadiness(s,job,entry.text,j.plan_hash,digest(j.spec))};
 if(j.state!=='awaiting_plan')throw Error('Existing plan requires explicit reconciliation before replacement');
 return s.db.transaction(()=>{
 const hash=s.propose(job,entry.text,expectRevision);
 s.db.query("UPDATE planning_runs SET session_id=?,state='plan_captured' WHERE job=?").run(r.session.id,job);
 s.event(job,'plan_captured_from_orchestrator',JSON.stringify({session:r.session.id,sequence,hash}));
 const readiness=recordReadiness(s,job,entry.text,hash,digest(j.spec));
 s.event(job,'plan_readiness_recorded',JSON.stringify({hash,state:readiness.state,valid:readiness.valid,source:readiness.source}));
 return {hash,approved:false,session:r.session.id,sequence,readiness};
 })();
}

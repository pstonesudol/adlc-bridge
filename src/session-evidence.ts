import {AO} from './orchestrator';
import {Store,digest} from './core';
import {recordReadiness} from './readiness';
import {RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';

// Receipt evidence is valid only while the whole collection remains fresh. Bound
// each page by the remaining window so a hung page cannot outlive the evidence.
export async function sessionEvidence(session:string,spawn=Bun.spawn,freshnessMs=RECEIPT_FRESHNESS_MS){
 if(!/^[a-zA-Z0-9_-]+$/.test(session))throw Error('Session ID required');
 if(!Number.isSafeInteger(freshnessMs)||freshnessMs<1)throw Error('Positive receipt freshness window required');
 const started=Date.now(),deadline=started+freshnessMs;let before:number|undefined,first:any;const entries:any[]=[];
 for(let page=0;page<100;page++){
 const remaining=deadline-Date.now();if(remaining<1)throw Error('Transcript collection exceeded freshness deadline; receipt evidence incomplete');
 const p=spawn([AO,'session','get',session,'--transcript','100','--json','--cap','0',...(before===undefined?[]:['--before',String(before)])],{stdout:'pipe',stderr:'pipe',timeout:Math.min(30000,remaining)});
 const [text,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(Date.now()>=deadline)throw Error('Transcript collection exceeded freshness deadline; receipt evidence incomplete');
 if(code!==0)throw Error('Orchestrator session inspection failed');
 const r=JSON.parse(text);
 if(r.session?.id!==session||!Array.isArray(r.transcript?.entries))throw Error('Invalid session evidence');
 if(!first)first=r;
 if(JSON.stringify(r.transcript.turns)!==JSON.stringify(first.transcript.turns))throw Error('Turn state changed during transcript pagination; refresh evidence');
 const batch=r.transcript.entries;
 if(batch.some((x:any)=>!Number.isSafeInteger(x.sequence)||(before!==undefined&&x.sequence>=before))||new Set(batch.map((x:any)=>x.sequence)).size!==batch.length)throw Error('Invalid transcript pagination sequence');
 entries.unshift(...batch);
 if(batch.length<100){first.transcript.entries=entries;first.receiptObservation={observed:started,complete:true};return first;}
 before=Math.min(...batch.map((x:any)=>x.sequence));
 }
 throw Error('Transcript pagination limit reached; receipt evidence incomplete');
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

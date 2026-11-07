import {Store,digest} from './core';
import {ReceiptReconciliation,evaluateReceipt,RECEIPT_FRESHNESS_MS} from './receipt-reconciliation';

export type LivenessClass='alive'|'busy'|'idle_no_delivery'|'stuck'|'terminated'|'unknown';
export type LivenessEvidence={classification:LivenessClass;session:string;worktree:string|null;branch:string|null;turn:string|null;turnState:string|null;progress:string;since:number;observed:number;recoveryAttempts:number};
const has=(s:Store,name:string)=>!!s.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function livenessStatus(s:Store,job:string):LivenessEvidence|null{
 if(!has(s,'worker_liveness'))return null;
 try{return JSON.parse((s.db.query('SELECT evidence FROM worker_liveness WHERE job=?').get(job) as any)?.evidence??'null');}catch{return null;}
}
// Elapsed silence is only a diagnosis, never proof that a send failed or that
// an active turn can safely be replaced. Persist identifiers/codes, not prose.
export function observeLiveness(s:Store,job:string,e:any,head:string,windowMs:number,now=Date.now()):LivenessEvidence{
 const run=s.db.query('SELECT * FROM runs WHERE job=?').get(job) as any;
 const reservation=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
 const turns=e?.transcript?.turns,entries=e?.transcript?.entries,observed=e?.receiptObservation?.observed;
 const states=['queued','running','completed','failed','cancelled','interrupted'];
 const valid=e?.session?.id===run?.session_id&&run?.owner==='orchestrator'&&run.plan_hash===s.get(job).plan_hash&&reservation?.session_id===run.session_id&&reservation.branch===e.session.branch&&typeof reservation.worktree==='string'&&!!reservation.worktree&&reservation.worktree===run.worktree&&(e.session.projectId===undefined||e.session.projectId===reservation.project)&&Array.isArray(turns)&&Array.isArray(entries)&&e.receiptObservation?.complete===true&&Number.isSafeInteger(observed)&&observed<=now&&now-observed<=RECEIPT_FRESHNESS_MS&&turns.every((t:any)=>typeof t?.id==='string'&&states.includes(t.state))&&new Set(turns.map((t:any)=>t.id)).size===turns.length;
 const last=valid?(turns.find((t:any)=>t.id===entries.at(-1)?.turnId)??turns.at(-1)):null;
 const progress=digest(JSON.stringify([run?.session_id,run?.plan_hash,reservation?.worktree,reservation?.branch,head,e?.transcript?.controller,valid?turns:null,valid?entries:null]));
 const prior=livenessStatus(s,job),since=prior?.progress===progress?prior.since:now;
 const active=valid&&turns.some((t:any)=>['running','queued'].includes(t.state));
 const pending=has(s,'remediation')?s.db.query("SELECT 1 FROM remediation WHERE job=? AND head=? AND state='delivery_uncertain'").get(job,head):null;
 const receipts=new ReceiptReconciliation(s).list(job).filter(r=>r.session===run?.session_id&&r.plan===run?.plan_hash&&r.spec===digest(s.get(job).spec)&&r.state!=='completed'&&evaluateReceipt(r,e,now).state!=='completed');
 let classification:LivenessClass='unknown';
 if(valid&&e.session.isTerminated===true)classification='terminated';
 else if(valid&&e.session.isTerminated===false&&['ready','running'].includes(e.transcript.controller)){
  if(active||e.transcript.controller!=='ready')classification=now-since>=windowMs?'stuck':'busy';
  else classification=pending||receipts.length?'idle_no_delivery':'alive';
 }
 const result:LivenessEvidence={classification,session:run?.session_id??'',worktree:reservation?.worktree??null,branch:reservation?.branch??null,turn:last?.id??null,turnState:last?.state??null,progress,since,observed:now,recoveryAttempts:prior?.session===run?.session_id?prior.recoveryAttempts:0};
 s.db.exec('CREATE TABLE IF NOT EXISTS worker_liveness(job TEXT PRIMARY KEY REFERENCES jobs(id),evidence TEXT NOT NULL)');
 s.db.query('INSERT INTO worker_liveness VALUES (?,?) ON CONFLICT(job) DO UPDATE SET evidence=excluded.evidence').run(job,JSON.stringify(result));
 return result;
}
export function livenessStop(e:LivenessEvidence,windowMs:number,now=Date.now()){
 const identity=`session ${e.session}; worktree ${e.worktree??'unknown'}; branch ${e.branch??'unknown'}; last turn ${e.turn??'none'} (${e.turnState??'unknown'})`;
 if(e.classification==='terminated')return {state:'blocked',send:false,reason:`Worker terminated: ${identity}; human must inspect original ownership before adoption or replacement; never resurrect`};
 if(e.classification==='unknown')return {state:'blocked',send:false,reason:`Worker liveness unknown: ${identity}; refresh authoritative owner and turn evidence; no send`};
 if(e.classification==='stuck')return {state:'blocked',send:false,reason:`Worker stuck: ${identity}; native resume unavailable; elapsed silence cannot exclude an in-flight turn; human inspection required`};
 if(e.classification==='busy')return {state:'waiting_for_worker',send:false,reason:'Worker busy; bounded liveness observation; no steering of queued or running turns'};
 if(e.classification==='idle_no_delivery')return {state:now-e.since>=windowMs?'needs_reconciliation':'waiting_for_worker',send:false,reason:`Worker idle without delivery: ${identity}; inspect original delivery receipts; absence never authorizes resend`};
 return null;
}

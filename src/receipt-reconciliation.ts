import {Store,digest} from './core';

export type DeliveryBinding={job:string;plan:string;spec:string;session:string;client:string;attempt:string};
export type DeliveryState='reserved'|'accepted'|'queued'|'running'|'completed'|'failed'|'cancelled'|'unknown';
export type ReceiptCode='session_mismatch'|'observation_stale_or_incomplete'|'transcript_missing'|'client_receipt_conflict'|'receipt_absent'|'client_accepted_unconfirmed'|'turn_missing_or_conflict'|'turn_state_unknown'|'turn_queued'|'turn_running'|'turn_completed'|'turn_failed'|'turn_cancelled'|'binding_mismatch'|'turn_identity_conflict'|'observation_out_of_order'|'terminal_contradiction'|'concurrent_update';
export const RECEIPT_FRESHNESS_MS=120000;
export function evaluateReceipt(binding:DeliveryBinding,e:any,now=Date.now()){
 const observed=e?.receiptObservation?.observed;
 const age=Number.isFinite(observed)?now-observed:null;
 const result=(state:DeliveryState,code:ReceiptCode,reason:string,turn:string|null=null)=>({state,code,reason,turn,observed:observed??null,ageMs:age,client:binding.client,attempt:binding.attempt});
 if(e?.session?.id!==binding.session)return result('unknown','session_mismatch','Session identity mismatch; inspect the original worker');
 if(!e.receiptObservation?.complete||age===null||age<0||age>RECEIPT_FRESHNESS_MS)return result('unknown','observation_stale_or_incomplete','Incomplete or stale receipt inventory; refresh the original worker transcript');
 const entries=e.transcript?.entries,turns=e.transcript?.turns;
 if(!Array.isArray(entries)||!Array.isArray(turns))return result('unknown','transcript_missing','Missing authoritative transcript or turns');
 const matches=entries.filter((x:any)=>x.clientMessageId===binding.client);
 if(matches.length!==1)return matches.length?result('unknown','client_receipt_conflict','Contradictory client-message receipts; inspect original dispatch'):result('unknown','receipt_absent','Exact client-message receipt absent; never resend');
 const entry=matches[0];
 if(!entry.turnId)return result('accepted','client_accepted_unconfirmed','Accepted message has no provider turn confirmation; wait without resending');
 const matched=turns.filter((x:any)=>x.id===entry.turnId);
 if(matched.length!==1)return result('unknown','turn_missing_or_conflict','Missing or contradictory turn receipt; refresh without resending');
 const turn=matched[0];
 if(!['queued','running','completed','failed','cancelled','interrupted'].includes(turn.state))return result('unknown','turn_state_unknown','Unrecognized provider turn state; inspect without resending');
 const state=turn.state==='interrupted'?'cancelled':turn.state;
 return result(state,`turn_${state}` as ReceiptCode,state==='completed'?'Delivery completed; outcome and current-head review gates still apply':state==='queued'||state==='running'?`Exact turn ${state}; waiting for existing worker`:`Exact turn ${state}; explicit recovery required`,turn.id);
}

// A separate ledger records delivery facts, never implementation success. Legacy
// attempts without a reservation cannot acquire an invented historical binding.
export class ReceiptReconciliation{
 constructor(public s:Store){}
 install(){this.s.db.exec(`CREATE TABLE IF NOT EXISTS delivery_receipts(client TEXT PRIMARY KEY,job TEXT NOT NULL,plan TEXT NOT NULL,spec TEXT NOT NULL,session TEXT NOT NULL,attempt TEXT NOT NULL,state TEXT NOT NULL,turn TEXT,observed INTEGER,reason TEXT);`);}
 reserve(b:DeliveryBinding){this.install();this.s.db.query("INSERT OR IGNORE INTO delivery_receipts(client,job,plan,spec,session,attempt,state) VALUES (?,?,?,?,?,?,'reserved')").run(b.client,b.job,b.plan,b.spec,b.session,b.attempt);const old=this.get(b.client);if(['job','plan','spec','session','attempt'].some(k=>old[k]!==b[k as keyof DeliveryBinding]))throw Error('Delivery reservation identity mismatch');}
 get(client:string):any{return this.s.db.query("SELECT name FROM sqlite_master WHERE name='delivery_receipts'").get()?this.s.db.query('SELECT * FROM delivery_receipts WHERE client=?').get(client):null;}
 list(job?:string):any[]{if(!this.s.db.query("SELECT name FROM sqlite_master WHERE name='delivery_receipts'").get())return [];const rows=(job?this.s.db.query('SELECT * FROM delivery_receipts WHERE job=?').all(job):this.s.db.query('SELECT * FROM delivery_receipts').all()) as any[];return rows.map(r=>({...r,ageMs:r.observed===null?null:Date.now()-r.observed}));}
 accepted(client:string){this.s.db.query("UPDATE delivery_receipts SET state='accepted' WHERE client=? AND state='reserved'").run(client);}
 inspect(b:DeliveryBinding,e:any,persist=true){
  const previous=this.get(b.client),j=this.s.get(b.job);
  let result=evaluateReceipt(b,e);
  if(previous?.state==='accepted'&&result.code==='receipt_absent')result={...result,state:'accepted',reason:'Host accepted send; provider confirmation delayed; wait without resending'};
  if(!previous||['job','plan','spec','session','attempt'].some(k=>previous[k]!==b[k as keyof DeliveryBinding])||j.plan_hash!==b.plan||digest(j.spec)!==b.spec)result={...result,state:'unknown',code:'binding_mismatch',reason:'Missing or changed dispatch binding; inspect original attempt without replay'};
  if(previous?.turn&&result.turn&&previous.turn!==result.turn)result={...result,state:'unknown',code:'turn_identity_conflict',reason:'Conflicting native turn identity; inspect original attempt'};
  if(previous?.observed&&result.observed&&previous.observed>result.observed)result={...result,state:'unknown',code:'observation_out_of_order',reason:'Out-of-order receipt observation; refresh before proceeding'};
  if(['completed','failed','cancelled'].includes(previous?.state)&&result.state!==previous.state)result={...result,state:'unknown',code:'terminal_contradiction',reason:'Contradictory terminal receipt; preserve original evidence and inspect'};
  if(persist&&previous&&result.state!=='unknown')this.s.db.transaction(()=>{
   const changed=this.s.db.query('UPDATE delivery_receipts SET state=?,turn=COALESCE(turn,?),observed=?,reason=? WHERE client=? AND state=? AND observed IS ?').run(result.state,result.turn,result.observed,result.reason,b.client,previous.state,previous.observed);
   if(changed.changes&&(previous.state!==result.state||previous.turn!==result.turn))this.s.event(b.job,'delivery_receipt_reconciled',JSON.stringify({...b,...result}));
   if(!changed.changes)result={...result,state:'unknown',code:'concurrent_update',reason:'Concurrent receipt update; refresh before proceeding'};
  }).immediate();
  return result;
 }
}

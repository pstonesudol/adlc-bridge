import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {ReceiptReconciliation,evaluateReceipt} from '../src/receipt-reconciliation';
import {sessionEvidence} from '../src/session-evidence';
import {ProviderReadError} from '../src/provider-read';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(){
 const s=new Store(':memory:'),job=s.enqueue('project','issue','spec'),plan=s.propose(job,'plan');
 const b={job,plan,spec:digest('spec'),session:'worker',client:'exact-message',attempt:'remediation:1'};
 const ledger=new ReceiptReconciliation(s);ledger.reserve(b);
 const e:any={session:{id:'worker'},receiptObservation:{complete:true,observed:Date.now()},transcript:{entries:[{clientMessageId:b.client,turnId:'native-turn'}],turns:[{id:'native-turn',state:'running'}]}};
 return {s,b,ledger,e};
}
for(const state of ['queued','running','completed','failed','cancelled'])test(`exact ${state} receipt, duplicate reconciliation and read-only preview`,()=>{
 const {s,b,ledger,e}=fixture();try{
  e.transcript.turns[0].state=state;
  expect(ledger.inspect(b,e,false).state).toBe(state);expect(ledger.get(b.client).state).toBe('reserved');
  expect(ledger.inspect(b,e).state).toBe(state);expect(new ReceiptReconciliation(s).inspect(b,e).state).toBe(state);
  expect(ledger.get(b.client).turn).toBe('native-turn');expect(s.get(b.job).attempts).toBe(0);
 }finally{s.close();}
});
for(const scenario of ['session','client','missing','duplicate','turn','stale','future','incomplete','plan','spec'])test(`uncertain ${scenario} never settles delivery`,()=>{
 const {s,b,ledger,e}=fixture();try{
  if(scenario==='session')e.session.id='other';
  if(scenario==='client')e.transcript.entries[0].clientMessageId='similar';
  if(scenario==='missing')e.transcript.entries=[];
  if(scenario==='duplicate')e.transcript.entries.push({...e.transcript.entries[0]});
  if(scenario==='turn')e.transcript.turns=[];
  if(scenario==='stale')e.receiptObservation.observed-=120001;
  if(scenario==='future')e.receiptObservation.observed+=10000;
  if(scenario==='incomplete')e.receiptObservation.complete=false;
  if(scenario==='plan')b.plan='different';
  if(scenario==='spec')s.enqueue('project','issue','changed');
  expect(ledger.inspect(b,e).state).toBe('unknown');expect(ledger.get(b.client).state).toBe('reserved');
 }finally{s.close();}
});
test('host acceptance is not provider completion; lost send reply can reconcile running',()=>{
 const {s,b,ledger,e}=fixture();try{
  ledger.accepted(b.client);const empty=structuredClone(e);empty.transcript.entries=[];
  expect(ledger.inspect(b,empty).state).toBe('accepted');
  expect(ledger.inspect(b,e).state).toBe('running');
  e.transcript.entries[0].turnId='another';e.transcript.turns[0].id='another';
  expect(ledger.inspect(b,e).state).toBe('unknown');expect(ledger.get(b.client).turn).toBe('native-turn');
 }finally{s.close();}
});
test('competing update after the previous read forces unknown without a duplicate audit event',()=>{
 const {s,b,ledger,e}=fixture();try{
  ledger.accepted(b.client);const read=ledger.get.bind(ledger);let exchanged=false;
  ledger.get=(client:string)=>{const row=read(client);if(!exchanged){exchanged=true;s.db.query("UPDATE delivery_receipts SET state='running',turn='native-turn',observed=?,reason='competing' WHERE client=?").run(e.receiptObservation.observed,b.client);}return row;};
  const before=s.db.query("SELECT count(*) AS n FROM events WHERE job=? AND kind='delivery_receipt_reconciled'").get(b.job) as any;
  expect(ledger.inspect(b,e)).toMatchObject({state:'unknown',code:'concurrent_update'});
  const after=s.db.query("SELECT count(*) AS n FROM events WHERE job=? AND kind='delivery_receipt_reconciled'").get(b.job) as any;
  expect(after.n).toBe(before.n);expect(ledger.get(b.client).state).toBe('running');
 }finally{s.close();}
});
test('late nonterminal and contradictory terminal receipts do not erase cancellation',()=>{
 const {s,b,ledger,e}=fixture();try{
  e.transcript.turns[0].state='cancelled';ledger.inspect(b,e);
  for(const state of ['running','completed']){e.transcript.turns[0].state=state;expect(ledger.inspect(b,e).state).toBe('unknown');}
  expect(ledger.get(b.client).state).toBe('cancelled');
 }finally{s.close();}
});
test('accepted entry without a native turn is not execution',()=>{
 const {s,b,e}=fixture();try{delete e.transcript.entries[0].turnId;expect(evaluateReceipt(b,e).state).toBe('accepted');}finally{s.close();}
});
test('unexpected spawn and stream failures are unknown without interpreting their messages',async()=>{
 for(const mode of ['spawn','stream']){
 const cause=new Error('Invalid pagination timeout freshness deadline ETIMEDOUT');
 const spawn=(()=>{if(mode==='spawn')throw cause;return {stdout:new ReadableStream({start(controller){controller.error(cause);}}),stderr:new Response('').body,exited:Promise.resolve(0)};}) as typeof Bun.spawn;
 try{await sessionEvidence('worker',spawn);throw Error('Expected failure');}
 catch(error){expect(error).toBeInstanceOf(ProviderReadError);expect((error as ProviderReadError).evidence.classification).toBe('unknown');expect((error as Error).cause).toBe(cause);}
 }
});
test('collector exhausts sequence pages before proving receipt completeness',async()=>{
 const calls:string[][]=[];
 const spawn=((args:string[])=>{calls.push(args);const page=calls.length===1?Array.from({length:100},(_,i)=>({sequence:i+2})): [{sequence:1,clientMessageId:'exact'}];return {stdout:new Response(JSON.stringify({session:{id:'worker'},transcript:{entries:page,turns:[]}})).body,stderr:new Response('').body,exited:Promise.resolve(0)};}) as typeof Bun.spawn;
 const e=await sessionEvidence('worker',spawn);expect(e.transcript.entries).toHaveLength(101);expect(calls[1]).toContain('--before');expect(calls[1].at(-1)).toBe('2');expect(e.receiptObservation.complete).toBe(true);
});
test('collector rejects repeated cursor evidence',async()=>{
 const spawn=(()=>({stdout:new Response(JSON.stringify({session:{id:'worker'},transcript:{entries:Array.from({length:100},(_,i)=>({sequence:i+1})),turns:[]}})).body,stderr:new Response('').body,exited:Promise.resolve(0)})) as typeof Bun.spawn;
 await expect(sessionEvidence('worker',spawn)).rejects.toThrow('orchestrator session-evidence: malformed');
});
test('collector rejects a final page returned after the whole freshness deadline',async()=>{
 let options:any;const spawn=((_args:string[],opts:any)=>{options=opts;return {stdout:new Response(JSON.stringify({session:{id:'worker'},transcript:{entries:[{sequence:1}],turns:[]}})).body,stderr:new Response('').body,exited:Bun.sleep(20).then(()=>0)};}) as typeof Bun.spawn;
 await expect(sessionEvidence('worker',spawn,5)).rejects.toThrow('orchestrator session-evidence: timeout');expect(options.timeout).toBeLessThanOrEqual(5);
});
test('restart and competing store observations retain exact attempt and terminal evidence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-test-')),path=join(dir,'state.sqlite');
 let s=new Store(path);let other:Store|undefined;
 try{
  const job=s.enqueue('project','issue','spec'),plan=s.propose(job,'plan'),b={job,plan,spec:digest('spec'),session:'worker',client:'client',attempt:'continuation:1'};
  new ReceiptReconciliation(s).reserve(b);s.close();s=new Store(path);other=new Store(path);
  const e={session:{id:'worker'},receiptObservation:{complete:true,observed:Date.now()},transcript:{entries:[{clientMessageId:'client',turnId:'native'}],turns:[{id:'native',state:'completed'}]}};
  expect(new ReceiptReconciliation(s).inspect(b,e).state).toBe('completed');
  expect(new ReceiptReconciliation(other).inspect(b,e).state).toBe('completed');
  e.receiptObservation.observed-=1;
  expect(new ReceiptReconciliation(other).inspect(b,e).state).toBe('unknown');
  expect(new ReceiptReconciliation(s).get('client')).toMatchObject({state:'completed',attempt:'continuation:1',turn:'native'});
 }finally{other?.close();s.close();rmSync(dir,{recursive:true,force:true});}
});

import {AO} from './orchestrator';
import {Store,digest} from './core';

export async function sessionEvidence(session:string,spawn=Bun.spawn){
 if(!/^[a-zA-Z0-9_-]+$/.test(session))throw Error('Session ID required');
 const p=spawn([AO,'session','get',session,'--transcript','100','--json','--cap','0'],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [text,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code!==0)throw Error('Orchestrator session inspection failed');
 const r=JSON.parse(text);
 if(r.session?.id!==session||!Array.isArray(r.transcript?.entries))throw Error('Invalid session evidence');
 return r;
}
// Capturing an agent plan never approves it. The caller selects a concrete entry;
// human approval remains bound to the specification+plan hash in Store.approve.
export function capturePlan(s:Store,job:string,r:any,sequence:number){
 const reservation=s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
 const j=s.get(job);
 if(!reservation||reservation.spec_hash!==digest(j.spec)||reservation.project!==r.session?.projectId||reservation.branch!==r.session?.branch||reservation.session_id&&reservation.session_id!==r.session?.id)throw Error('Planning reservation does not match session');
 const entry=r.transcript?.entries?.find((e:any)=>e.sequence===sequence);
 if(!entry||entry.kind!=='message'||entry.role!=='assistant'||entry.origin!=='provider'||entry.streaming||!entry.text?.trim())throw Error('Completed assistant plan entry required');
 if(j.plan===entry.text&&j.plan_hash===digest(JSON.stringify([j.spec,entry.text])))return {hash:j.plan_hash,approved:j.state==='approved',session:r.session.id,sequence};
 if(j.state!=='awaiting_plan')throw Error('Existing plan requires explicit reconciliation before replacement');
 return s.db.transaction(()=>{
 const hash=s.propose(job,entry.text);
 s.db.query("UPDATE planning_runs SET session_id=?,state='plan_captured' WHERE job=?").run(r.session.id,job);
 s.event(job,'plan_captured_from_orchestrator',JSON.stringify({session:r.session.id,sequence,hash}));
 return {hash,approved:false,session:r.session.id,sequence};
 })();
}

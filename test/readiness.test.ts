import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {assessPlan,assessWorkerReceipt,recordReadiness,readinessFor,recordResolution,activeResolution,readinessBinding} from '../src/readiness';

const receipt=(value:any)=>`Plan body.\n\n<!-- ADLC_PLAN_STATUS ${JSON.stringify(value)} -->`;

test('actionable ready plan with ordinary risks stays ready',()=>{
 const result=assessPlan(receipt({version:1,readiness:'ready',questions:[],dependencies:[],risks:['Flaky staging test']}));
 expect(result.valid).toBe(true);expect(result.state).toBe('ready');expect(result.risks).toEqual(['Flaky staging test']);
});
test('the final readiness marker wins when an agent quotes the instruction example',()=>{
 const plan='Example: <!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready|needs-input"} -->\n\n'+receipt({version:1,readiness:'ready',questions:[],dependencies:[],risks:[]});
 expect(assessPlan(plan).valid).toBe(true);expect(assessPlan(plan).state).toBe('ready');
});
test('missing product identifier and security decisions are validated blocking questions',()=>{
 const product=assessPlan(receipt({version:1,readiness:'needs-input',questions:[{id:'q1',question:'Which stable product/listing identifier should be renamed?',kind:'requirement'}],dependencies:[],risks:[]}));
 expect(product.valid).toBe(true);expect(product.state).toBe('needs-input');
 const security=assessPlan(receipt({version:1,readiness:'needs-input',questions:[{id:'q1',question:'May we proceed without Cloudflare Access changes?',kind:'security-scope'}],dependencies:[],risks:[]}));
 expect(security.valid).toBe(true);expect(security.questions[0].kind).toBe('security-scope');
});
test('blocked dependency requires and preserves references',()=>{
 const result=assessPlan(receipt({version:1,readiness:'blocked-by-dependency',questions:[],dependencies:[{ref:'DEV-9',reason:'Approved sourcing wording'}],risks:[]}));
 expect(result.valid).toBe(true);expect(result.state).toBe('blocked-by-dependency');expect(result.dependencies[0].ref).toBe('DEV-9');
 expect(assessPlan(receipt({version:1,readiness:'blocked-by-dependency',questions:[],dependencies:[],risks:[]})).valid).toBe(false);
});
test('malformed, contradictory or missing readiness fails closed',()=>{
 for(const value of [
  {version:2,readiness:'ready'},
  {version:1,readiness:'ready',questions:[{id:'q1',question:'Unresolved'}],dependencies:[],risks:[]},
  {version:1,readiness:'needs-input',questions:[],dependencies:[],risks:[]},
  {version:1,readiness:'needs-input',questions:[{id:'q1',question:'',kind:'requirement'}],dependencies:[],risks:[]},
  {version:1,readiness:'needs-input',questions:[{id:'q1',question:'ok',kind:'unknown'}],dependencies:[],risks:[]},
 ])expect(assessPlan(receipt(value)).valid).toBe(false);
 expect(assessPlan('Plan with no receipt').valid).toBe(false);
 expect(assessPlan('<!-- ADLC_PLAN_STATUS {not json} -->').valid).toBe(false);
});
test('legacy plan text questions are quoted but never treated as actionable',()=>{
 const result=assessPlan('Plan.\n\n### Risks and questions\n- Missing approved copy from DEV-9\n- Confirm security scope\n');
 expect(result.valid).toBe(false);expect(result.state).toBe('needs-input');expect(result.source).toBe('plan-text');
 expect(result.questions.map(q=>q.question)).toEqual(['Missing approved copy from DEV-9','Confirm security scope']);
 expect(assessPlan('Plan.\n\n### Questions\n- None\n').state).toBe('invalid');
});
test('worker receipts require an outcome and concrete evidence',()=>{
 const needs=assessWorkerReceipt('<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"needs-input","questions":[{"id":"w1","question":"Which listing?","kind":"requirement"}],"dependencies":[]} -->');
 expect(needs.valid).toBe(true);expect(needs.receipt?.outcome).toBe('needs-input');
 expect(assessWorkerReceipt('<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"needs-input","questions":[]} -->').valid).toBe(false);
 expect(assessWorkerReceipt('<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"pr-handoff"} -->').valid).toBe(true);
 expect(assessWorkerReceipt('No receipt').valid).toBe(false);
});
test('resolutions are bound to the current plan, specification and readiness evidence',()=>{
 const s=new Store(':memory:'),id=s.enqueue('p','i','spec');
 const plan='Plan.\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"needs-input","questions":[{"id":"q1","question":"Which SKU?","kind":"requirement"}],"dependencies":[],"risks":[]} -->';
 const hash=s.propose(id,plan),readiness=recordReadiness(s,id,plan,hash,digest('spec'));
 expect(readiness.state).toBe('needs-input');expect(readinessFor(s,id)?.plan_hash).toBe(hash);
 recordResolution(s,id,'human-answer','Alice','SKU-42');
 const resolved=activeResolution(s,id);expect(resolved.detail).toBe('SKU-42');
 s.db.query('UPDATE plan_readiness SET questions=? WHERE job=?').run(JSON.stringify([{id:'q1',question:'Different question',kind:'security-scope'}]),id);
 expect(readinessBinding(s,id)).not.toBe(resolved.binding);
 expect(activeResolution(s,id)).toBeNull();s.close();
});

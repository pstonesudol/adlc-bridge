import {test,expect} from 'bun:test';import {latestWorkflowChecks} from '../src/check-runs';
import {reviewGate} from '../src/core';
const repo='owner/repo',head='a'.repeat(40);
function check(id:number,run:number){return {id,name:'PR body structure',head_sha:head,app:{slug:'github-actions'},details_url:`https://github.com/${repo}/actions/runs/${run}/job/${id}`,status:'completed',conclusion:id===1?'failure':'success'};}
test('distinct attempt-specific job IDs cannot prove cross-run logical identity even in the same workflow and event',async()=>{
  const checks=[check(1,10),check(2,11)];expect(latestWorkflowChecks(checks)).toBe(checks);expect(latestWorkflowChecks(checks).map(x=>x.id)).toEqual([1,2]);
});
test('same check names in distinct workflows or events remain ambiguous instead of hiding failure',async()=>{
  const checks=[{...check(1,10),workflow:5,event:'push'},{...check(2,11),workflow:6,event:'pull_request'}];expect(latestWorkflowChecks(checks)).toBe(checks);
});
test('unverifiable job metadata and foreign URLs retain the raw failure instead of throwing on unrelated provenance',()=>{
  for(const changed of [{head_sha:'old'},{details_url:'https://evil.test/o/actions/runs/11/job/2'},{details_url:'not a URL'}]){const checks=[check(1,10),{...check(2,11),...changed}];expect(latestWorkflowChecks(checks)).toBe(checks);expect(checks[0].conclusion).toBe('failure');}
});
test('same-run attempts retain every distinct job ID instead of guessing logical identity from names',async()=>{
 for(const conclusion of ['success','failure']){
  const older={...check(1,10),conclusion:conclusion==='success'?'failure':'success'},newer={...check(2,10),conclusion};
   for(const checks of [[older,newer],[newer,older]])expect(latestWorkflowChecks(checks)).toBe(checks);
 }
});
test('newest run failure or pending status is not hidden by an older result',async()=>{
 for(const current of [{status:'completed',conclusion:'failure'},{status:'in_progress',conclusion:null}]){
    const newer={...check(2,11),...current},checks=[{...check(1,10),conclusion:'success'},newer];expect(latestWorkflowChecks(checks)).toBe(checks);
 }
});
test('selectively rerunning one of two same-name jobs cannot hide the other failure or clear readiness',async()=>{
  const checks=[check(1,10),check(2,10),check(3,10)];
 for(const input of [checks,[...checks].reverse()]){
   const kept=latestWorkflowChecks(input);expect(kept).toBe(input);expect(kept.some(c=>c.id===1&&c.conclusion==='failure')).toBe(true);
   const bot={name:'CodeRabbit',sha:head,app:'coderabbitai',status:'completed',conclusion:'success'};
   const evidence={head,observedHead:head,required:['PR body structure'],checks:[...kept.map(c=>({name:c.name,sha:c.head_sha,app:c.app.slug,status:c.status,conclusion:c.conclusion})),bot],review:{sha:head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true};
   expect(reviewGate(evidence)).toEqual({clear:false,reasons:['Required check not clear: PR body structure']});
   expect(reviewGate({...evidence,checks:[evidence.checks.find(c=>c.app==='github-actions'&&c.conclusion==='success')!,bot]}).clear).toBe(true);
 }
});
test('unrequired unverifiable duplicate checks do not block otherwise clear readiness',()=>{
 const raw=[{...check(1,10),name:'unrequired',details_url:'not a URL'},{...check(2,11),name:'unrequired',details_url:'https://foreign.test/'}];
 const kept=latestWorkflowChecks(raw);expect(kept).toBe(raw);
 expect(reviewGate({head,observedHead:head,required:['CI'],checks:[...kept.map(c=>({name:c.name,sha:c.head_sha,app:c.app.slug,status:c.status,conclusion:c.conclusion})),{name:'CI',sha:head,app:'github-actions',status:'completed',conclusion:'success'},{name:'CodeRabbit',sha:head,app:'coderabbitai',status:'completed',conclusion:'success'}],review:{sha:head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true})).toEqual({clear:true,reasons:[]});
});

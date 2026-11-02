import {test,expect} from 'bun:test';import {latestWorkflowChecks} from '../src/check-runs';
import {reviewGate} from '../src/core';
const repo='owner/repo',head='a'.repeat(40);
function check(id:number,run:number){return {id,name:'PR body structure',head_sha:head,app:{slug:'github-actions'},details_url:`https://github.com/${repo}/actions/runs/${run}/job/${id}`,status:'completed',conclusion:id===1?'failure':'success'};}
function gate(raw:any[]){return reviewGate({head,observedHead:head,required:['PR body structure'],checks:[...latestWorkflowChecks(raw).map(c=>({name:c.name,sha:c.head_sha,app:c.app.slug,status:c.status,conclusion:c.conclusion})),{name:'CodeRabbit',sha:head,app:'coderabbitai',status:'completed',conclusion:'success'}],review:{sha:head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true});}
test('required-check ambiguity blocks readiness even when all duplicate results succeed',()=>{
 const passing={...check(1,10),conclusion:'success'};
 for(const second of [check(2,10),check(2,11),{...check(2,11),details_url:'not a URL'}])for(const raw of [[passing,second],[second,passing]])expect(gate(raw)).toEqual({clear:false,reasons:['Required check not clear: PR body structure']});
 expect(gate([passing])).toEqual({clear:true,reasons:[]});
});
test('stale, wrong-app, failing and pending results cannot satisfy a required readiness check',()=>{
 for(const only of [check(1,10),{...check(2,10),head_sha:'old'},{...check(2,10),app:{slug:'other'}},{...check(2,10),status:'in_progress',conclusion:null}])expect(gate([only])).toEqual({clear:false,reasons:['Required check not clear: PR body structure']});
});
test('selectively rerunning one of two same-name jobs cannot hide the other failure or clear readiness',async()=>{
  const checks=[check(1,10),check(2,10),check(3,10)];
 for(const input of [checks,[...checks].reverse()]){
    const kept=latestWorkflowChecks(input);
   const bot={name:'CodeRabbit',sha:head,app:'coderabbitai',status:'completed',conclusion:'success'};
   const evidence={head,observedHead:head,required:['PR body structure'],checks:[...kept.map(c=>({name:c.name,sha:c.head_sha,app:c.app.slug,status:c.status,conclusion:c.conclusion})),bot],review:{sha:head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true};
   expect(reviewGate(evidence)).toEqual({clear:false,reasons:['Required check not clear: PR body structure']});
   expect(reviewGate({...evidence,checks:[evidence.checks.find(c=>c.app==='github-actions'&&c.conclusion==='success')!,bot]}).clear).toBe(true);
 }
});
test('unrequired unverifiable duplicate checks do not block otherwise clear readiness',()=>{
 const raw=[{...check(1,10),name:'unrequired',details_url:'not a URL'},{...check(2,11),name:'unrequired',details_url:'https://foreign.test/'}];
 const kept=latestWorkflowChecks(raw);
 expect(reviewGate({head,observedHead:head,required:['CI'],checks:[...kept.map(c=>({name:c.name,sha:c.head_sha,app:c.app.slug,status:c.status,conclusion:c.conclusion})),{name:'CI',sha:head,app:'github-actions',status:'completed',conclusion:'success'},{name:'CodeRabbit',sha:head,app:'coderabbitai',status:'completed',conclusion:'success'}],review:{sha:head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true})).toEqual({clear:true,reasons:[]});
});

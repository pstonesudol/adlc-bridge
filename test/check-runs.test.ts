import {test,expect} from 'bun:test';import {latestWorkflowChecks} from '../src/check-runs';
import {reviewGate} from '../src/core';
const repo='owner/repo',head='a'.repeat(40);
function check(id:number,run:number){return {id,name:'PR body structure',head_sha:head,app:{slug:'github-actions'},details_url:`https://github.com/${repo}/actions/runs/${run}/job/${id}`,status:'completed',conclusion:id===1?'failure':'success'};}
function api(workflows:Record<number,number>={10:5,11:5},events:Record<number,string>={10:'pull_request',11:'pull_request'},attempts:Record<number,number>={1:1,2:1},sameRun=false){return async(path:string)=>{const n=Number(path.split('/').at(-1));if(path.includes('/runs/'))return {id:n,repository:{full_name:repo},head_sha:head,workflow_id:workflows[n],run_number:n,event:events[n]};return {id:n,run_id:sameRun?10:n===1?10:11,head_sha:head,check_run_url:`https://api.github.com/repos/${repo}/check-runs/${n}`,run_attempt:attempts[n]};};}
test('distinct attempt-specific job IDs cannot prove cross-run logical identity even in the same workflow and event',async()=>{
  const result=await latestWorkflowChecks(repo,head,[check(1,10),check(2,11)],api());expect(result.map(x=>x.id)).toEqual([1,2]);
});
test('same check names in distinct workflows or events remain ambiguous instead of hiding failure',async()=>{
 expect((await latestWorkflowChecks(repo,head,[check(1,10),check(2,11)],api({10:5,11:6}))).length).toBe(2);
 expect((await latestWorkflowChecks(repo,head,[check(1,10),check(2,11)],api(undefined,{10:'push',11:'pull_request'}))).length).toBe(2);
});
test('forged job identities and foreign URLs cannot supersede a failed check',async()=>{
 await expect(latestWorkflowChecks(repo,head,[check(1,10),check(2,11)],async p=>({...await api()(p),head_sha:'old'}))).rejects.toThrow('provenance');
 await expect(latestWorkflowChecks(repo,head,[check(1,10),{...check(2,11),details_url:'https://evil.test/o/actions/runs/11/job/2'}],api())).rejects.toThrow('provenance');
});
test('same-run attempts retain every distinct job ID instead of guessing logical identity from names',async()=>{
 for(const conclusion of ['success','failure']){
  const older={...check(1,10),conclusion:conclusion==='success'?'failure':'success'},newer={...check(2,10),conclusion};
   for(const checks of [[older,newer],[newer,older]])expect(await latestWorkflowChecks(repo,head,checks,api(undefined,undefined,{1:1,2:2},true))).toEqual(checks);
 }
});
test('newest run failure or pending status is not hidden by an older result',async()=>{
 for(const current of [{status:'completed',conclusion:'failure'},{status:'in_progress',conclusion:null}]){
   const newer={...check(2,11),...current},checks=[{...check(1,10),conclusion:'success'},newer];expect(await latestWorkflowChecks(repo,head,checks,api())).toEqual(checks);
 }
});
test('selectively rerunning one of two same-name jobs cannot hide the other failure or clear readiness',async()=>{
 const checks=[check(1,10),check(2,10),check(3,10)],read=api(undefined,undefined,{1:1,2:1,3:2},true);
 for(const input of [checks,[...checks].reverse()]){
  const kept=await latestWorkflowChecks(repo,head,input,read);expect(kept).toEqual(input);expect(kept.some(c=>c.id===1&&c.conclusion==='failure')).toBe(true);
  expect(reviewGate({head,observedHead:head,required:['PR body structure'],checks:kept.map(c=>({name:c.name,sha:c.head_sha,app:c.app.slug,status:c.status,conclusion:c.conclusion})),review:{sha:head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true}).clear).toBe(false);
 }
});

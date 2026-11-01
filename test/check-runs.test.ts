import {test,expect} from 'bun:test';import {latestWorkflowChecks} from '../src/check-runs';
const repo='owner/repo',head='a'.repeat(40);
function check(id:number,run:number){return {id,name:'PR body structure',head_sha:head,app:{slug:'github-actions'},details_url:`https://github.com/${repo}/actions/runs/${run}/job/${id}`,status:'completed',conclusion:id===1?'failure':'success'};}
function api(workflows:Record<number,number>={10:5,11:5},events:Record<number,string>={10:'pull_request',11:'pull_request'},attempts:Record<number,number>={1:1,2:1},sameRun=false){return async(path:string)=>{const n=Number(path.split('/').at(-1));if(path.includes('/runs/'))return {id:n,repository:{full_name:repo},head_sha:head,workflow_id:workflows[n],run_number:n,event:events[n]};return {id:n,run_id:sameRun?10:n===1?10:11,head_sha:head,check_run_url:`https://api.github.com/repos/${repo}/check-runs/${n}`,run_attempt:attempts[n]};};}
test('successful rerun supersedes old failure only within the same verified workflow and event',async()=>{
 const result=await latestWorkflowChecks(repo,head,[check(1,10),check(2,11)],api());expect(result.map(x=>x.id)).toEqual([2]);
});
test('same check names in distinct workflows or events remain ambiguous instead of hiding failure',async()=>{
 expect((await latestWorkflowChecks(repo,head,[check(1,10),check(2,11)],api({10:5,11:6}))).length).toBe(2);
 expect((await latestWorkflowChecks(repo,head,[check(1,10),check(2,11)],api(undefined,{10:'push',11:'pull_request'}))).length).toBe(2);
});
test('forged job identities and foreign URLs cannot supersede a failed check',async()=>{
 await expect(latestWorkflowChecks(repo,head,[check(1,10),check(2,11)],async p=>({...await api()(p),head_sha:'old'}))).rejects.toThrow('provenance');
 await expect(latestWorkflowChecks(repo,head,[check(1,10),{...check(2,11),details_url:'https://evil.test/o/actions/runs/11/job/2'}],api())).rejects.toThrow('provenance');
});
test('same-run attempt ordering retains the newest passing or failing attempt',async()=>{
 for(const conclusion of ['success','failure']){
  const older={...check(1,10),conclusion:conclusion==='success'?'failure':'success'},newer={...check(2,10),conclusion};
  for(const checks of [[older,newer],[newer,older]])expect(await latestWorkflowChecks(repo,head,checks,api(undefined,undefined,{1:1,2:2},true))).toEqual([newer]);
 }
});
test('newest run failure or pending status is not hidden by an older result',async()=>{
 for(const current of [{status:'completed',conclusion:'failure'},{status:'in_progress',conclusion:null}]){
  const newer={...check(2,11),...current};expect(await latestWorkflowChecks(repo,head,[{...check(1,10),conclusion:'success'},newer],api())).toEqual([newer]);
 }
});

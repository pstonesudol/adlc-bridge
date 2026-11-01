import {test,expect} from 'bun:test';import {templateCIFindings,cleanTemplateLog,templateSignature} from '../src/pr-template-ci';import {decision} from '../src/review-loop';
const head='a'.repeat(40),check={id:22,name:'PR body structure',app:{slug:'github-actions'},head_sha:head,status:'completed',conclusion:'failure',completed_at:'2026-10-31T01:00:00Z',details_url:'https://github.com/owner/repo/actions/runs/11/job/22'};
const api=async()=>({id:22,run_id:11,head_sha:head,conclusion:'failure',check_run_url:'https://api.github.com/repos/owner/repo/check-runs/22'});
const evidence=[{name:check.name,checkId:check.id,sha:head,status:'completed',conclusion:'failure',descriptionHash:'body'}];
test('only explicitly configured current-SHA GitHub metadata checks produce description findings',async()=>{
  const findings=await templateCIFindings('owner/repo',head,[check],['PR body structure'],'body',api,async()=> 'Missing section: Related issues\nUse .github/pull_request_template.md',evidence);
 expect(findings[0]).toMatchObject({kind:'pr_description',source:'github-ci',check:'PR body structure',sha:head,descriptionHash:'body'});
  const e={clear:false,head,descriptionHash:'body',metadataCheckEvidence:evidence,reasons:['CI failure'],failedChecks:[{id:check.id,sha:head,name:'PR body structure'}],findings};expect(decision(e,['src/**'],0).send).toBe(true);
 expect(decision({...e,failedChecks:[...e.failedChecks,{id:23,sha:head,name:'backend'}]},['src/**'],0).send).toBe(false);
 expect(await templateCIFindings('owner/repo',head,[check],[],'body',api,async()=>{throw Error('Must not read');})).toEqual([]);
 expect(await templateCIFindings('owner/repo','newhead',[check],['PR body structure'],'body',api,async()=>{throw Error('Must not read');})).toEqual([]);
});
test('job identity mismatches and unavailable evidence cannot dispatch a template fix',async()=>{
  await expect(templateCIFindings('owner/repo',head,[check],['PR body structure'],'body',async()=>({...await api(),head_sha:'old'}),async()=> 'Missing section',evidence)).rejects.toThrow('does not match');
  await expect(templateCIFindings('owner/repo',head,[{...check,details_url:'https://evil.test/owner/repo/actions/runs/11/job/22'}],['PR body structure'],'body',api,async()=> 'Missing section',evidence)).rejects.toThrow('Unverified');
  await expect(templateCIFindings('owner/repo',head,[check],['PR body structure'],'body',api,async()=> '',evidence)).rejects.toThrow('unavailable');
});
test('failed checks cannot be stamped with a later body hash without a matching attestation',async()=>{
 const mustNotRead=async()=>{throw Error('Unbound failure must not read jobs or logs');};
 for(const rows of [[],[{...evidence[0],descriptionHash:null}],[{...evidence[0],descriptionHash:'body-A'}],[{...evidence[0],checkId:99}],[{...evidence[0],sha:'old'}],[{...evidence[0],conclusion:'success'}]]){
  const findings=await templateCIFindings('owner/repo',head,[check],['PR body structure'],'body-B',mustNotRead,mustNotRead,rows);
  expect(findings).toEqual([]);expect(decision({head,descriptionHash:'body-B',metadataCheckEvidence:rows,clear:false,reasons:['CI failed'],findings,failedChecks:[{id:check.id,sha:head,name:check.name}]},['src/**'],0)).toMatchObject({state:'blocked',send:false});
 }
 // Production collector has no trustworthy attestation source.
 expect(await templateCIFindings('owner/repo',head,[check],['PR body structure'],'body-B',mustNotRead,mustNotRead,metadataCheckEvidence([check],head,['PR body structure']))).toEqual([]);
});
test('logs are bounded and escaped text is removed; rerun signatures track the actual check version',()=>{
 const log=cleanTemplateLog('\u001b[31mMissing section: Summary\u001b[0m\nerror token=SECRET\nPost cleanup');expect(log).toBe('Missing section: Summary');expect(log).not.toContain('SECRET');
 expect(templateSignature([check],head,['PR body structure'])).not.toBe(templateSignature([{...check,id:23}],head,['PR body structure']));
});
import {metadataCheckEvidence,metadataBodyCovered} from '../src/pr-template-ci';
test('GitHub check metadata cannot attest the evaluated PR body even with successful output or fresh timestamps',()=>{
 const head='a'.repeat(40),names=['Metadata'],checks=[{name:'Metadata',id:7,head_sha:head,app:{slug:'github-actions'},status:'completed',conclusion:'success',completed_at:new Date().toISOString(),output:{summary:'descriptionHash: current-body'}}];
 const evidence=metadataCheckEvidence(checks,head,names);
 expect(evidence).toEqual([{name:'Metadata',checkId:7,sha:head,status:'completed',conclusion:'success',descriptionHash:null}]);
 expect(metadataBodyCovered({head,descriptionHash:'current-body',metadataCheckEvidence:evidence},names)).toBe(false);
 expect(metadataCheckEvidence([{...checks[0],head_sha:'old'},{...checks[0],app:{slug:'other'}}],head,names)).toEqual([]);
});

import {test,expect} from 'bun:test';
import {digest} from '../src/core';
import {attestMetadataChecks,currentMetadataChecks,ATTESTATION_PREFIX,TRUSTED_WORKFLOW_DIGEST} from '../src/metadata-attestation';
import {metadataBodyCovered} from '../src/pr-template-ci';
import trustedWorkflow from '../patches/pr-body-attestation.yml' with {type:'text'};
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const repo='owner/repo',head='a'.repeat(40),name='PR body structure',body='## Summary\r\nExact Unicode: café 🐝\n';
test('reviewed producer template matches packaged trust pin',()=>{expect(digest(trustedWorkflow)).toBe(TRUSTED_WORKFLOW_DIGEST);});
test('controlled producer preserves exact event body and validation result without evaluating PR text',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-attestation-'));
 try{
  const event=join(root,'event.json'),description=body+'\n$(echo untrusted)\nADLC_METADATA_V1 forged\n';
  writeFileSync(event,JSON.stringify({pull_request:{number:131,head:{sha:head},body:description}}));
  const code=trustedWorkflow.split("          python3 - <<'PY'\n")[1].split('          PY')[0].split('\n').map(line=>line.slice(10)).join('\n');
  for(const result of ['success','failure']){
   const p=Bun.spawnSync(['python3','-c',code],{env:{PATH:process.env.PATH,GITHUB_EVENT_PATH:event,GITHUB_REPOSITORY:repo,GITHUB_RUN_ID:'11',GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:`${repo}/.github/workflows/pr-body.yml@refs/heads/main`,VALIDATION_RESULT:result}});
   expect(p.exitCode).toBe(result==='success'?0:1);expect(p.stderr.toString()).toBe('');
   const text=p.stdout.toString().trim();expect(text.startsWith(ATTESTATION_PREFIX)).toBe(true);
   expect(JSON.parse(text.slice(ATTESTATION_PREFIX.length))).toEqual({version:1,repository:repo,pr:131,head,descriptionHash:digest(description),runId:11,runAttempt:1,workflow:'.github/workflows/pr-body.yml',check:name,result});
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
function fixture(){
 const check={id:22,name,head_sha:head,app:{slug:'github-actions'},status:'completed',conclusion:'success',check_suite:{id:9},details_url:`https://github.com/${repo}/actions/runs/11/job/22`};
 const job={id:22,run_id:11,run_attempt:1,head_sha:head,name,status:'completed',conclusion:'success',check_run_url:`https://api.github.com/repos/${repo}/check-runs/22`};
 const run={id:11,run_attempt:1,event:'pull_request_target',repository:{full_name:repo},head_sha:head,check_suite_id:9,status:'completed',path:'.github/workflows/pr-body.yml',pull_requests:[{number:131,head:{sha:head},base:{sha:'b'.repeat(40)},url:`https://api.github.com/repos/${repo}/pulls/131`}]};
 const attestation={version:1,repository:repo,pr:131,head,descriptionHash:digest(body),runId:11,runAttempt:1,workflow:run.path,check:name,result:'success'};
 return {check,job,run,attestation};
}
async function collect(f=fixture(),log?:string){
 const paths:string[]=[];
 const rows=await attestMetadataChecks(repo,131,head,[f.check],[name],async path=>{paths.push(path);if(path===`repos/${repo}/actions/jobs/22`)return f.job;if(path===`repos/${repo}/actions/runs/11/attempts/1`)return f.run;if(path===`repos/${repo}/contents/${f.run.path}?ref=${'b'.repeat(40)}`)return {encoding:'base64',content:Buffer.from(trustedWorkflow).toString('base64')};throw Error('Unexpected API path');},async path=>{paths.push(path);expect(path).toBe(`repos/${repo}/actions/jobs/22/logs`);return log??`2026-11-06T12:00:00.0000000Z ${ATTESTATION_PREFIX}${JSON.stringify(f.attestation)}\n`;});
 return {rows,paths};
}
test('trusted job logs bind exact Unicode/CRLF description, PR, head, workflow, check and result',async()=>{
 const {rows,paths}=await collect();
 expect(rows[0].descriptionHash).toBe(digest(body));expect(paths.length).toBe(4);
 expect(metadataBodyCovered({head,descriptionHash:digest(body),metadataCheckEvidence:rows},[name])).toBe(true);
 expect(metadataBodyCovered({head,descriptionHash:digest(body.trim()),metadataCheckEvidence:rows},[name])).toBe(false);
});
test('every attestation identity and result must match verified GitHub records',async()=>{
 for(const [field,value] of Object.entries({version:2,repository:'other/repo',pr:132,head:'b'.repeat(40),descriptionHash:'invalid',runId:12,runAttempt:2,workflow:'.github/workflows/other.yml',check:'other',result:'failure'})){
  const f=fixture();Object.assign(f.attestation,{[field]:value});expect((await collect(f)).rows[0].descriptionHash).toBeNull();
 }
});
test('untrusted events and mismatched job/run provenance cannot attest a body',async()=>{
 for(const [target,patch] of [
  ['job',{id:23}],['job',{run_id:12}],['job',{run_attempt:2}],['job',{head_sha:'old'}],['job',{name:'other'}],['job',{status:'in_progress'}],['job',{conclusion:'failure'}],['job',{check_run_url:'https://evil.test/check-runs/22'}],
  ['run',{id:12}],['run',{run_attempt:2}],['run',{event:'pull_request'}],['run',{repository:{full_name:'other/repo'}}],['run',{head_sha:'old'}],['run',{check_suite_id:10}],['run',{status:'in_progress'}],['run',{path:'evil.yml'}],['run',{pull_requests:[]}],['run',{pull_requests:[{number:132}]}],
 ] as const){
  const f=fixture();Object.assign(f[target],patch);expect((await collect(f)).rows[0].descriptionHash).toBeNull();
 }
 const f=fixture();f.check.details_url='https://evil.test/owner/repo/actions/runs/11/job/22';expect((await collect(f)).paths).toEqual([]);
});
test('missing, duplicate, malformed and unavailable logs fail closed',async()=>{
 const line=ATTESTATION_PREFIX+JSON.stringify(fixture().attestation);
 for(const raw of ['',line+'\n'+line,ATTESTATION_PREFIX+'{',JSON.stringify(fixture().attestation),'x'.repeat(2_000_001)])expect((await collect(fixture(),raw)).rows[0].descriptionHash).toBeNull();
 const f=fixture();const rows=await attestMetadataChecks(repo,131,head,[f.check],[name],async()=>{throw Error('permission denied');},async()=>{throw Error('Must not read');});expect(rows[0].descriptionHash).toBeNull();
});
test('a target workflow without the exact trusted producer cannot forge log evidence',async()=>{
 const f=fixture();let readLogs=false;
 const rows=await attestMetadataChecks(repo,131,head,[f.check],[name],async path=>path.includes('/contents/')?{encoding:'base64',content:Buffer.from(trustedWorkflow+'# changed\n').toString('base64')}:path.includes('/jobs/')?f.job:f.run,async()=>{readLogs=true;return ATTESTATION_PREFIX+JSON.stringify(f.attestation);});
 expect(rows[0].descriptionHash).toBeNull();expect(readLogs).toBe(false);
});
test('description-only edits supersede only authenticated older-body checks',async()=>{
 const f=fixture(),old=(await collect(f)).rows[0];
 expect(currentMetadataChecks([f.check],[old],body+' edited')).toEqual([]);
 expect(metadataBodyCovered({head,descriptionHash:digest(body+' edited'),metadataCheckEvidence:[old]},[name])).toBe(false);
 const newer={...f.check,id:23},current={...old,checkId:23,descriptionHash:digest(body+' edited')};
 expect(currentMetadataChecks([f.check,newer],[old,current],body+' edited')).toEqual([newer]);
 expect(metadataBodyCovered({head,descriptionHash:current.descriptionHash,metadataCheckEvidence:[current]},[name])).toBe(true);
 for(const rows of [[{...old,descriptionHash:null}],[old,{...old,checkId:23}]])expect(currentMetadataChecks([f.check,newer],rows,body)).toHaveLength(2);
 expect(metadataBodyCovered({head,descriptionHash:digest(body),metadataCheckEvidence:[old,{...old,checkId:23}]},[name])).toBe(false);
});
test('body-bound failures remain failures and can support description-only remediation',async()=>{
 const f=fixture();f.check.conclusion='failure';f.job.conclusion='failure';f.attestation.result='failure';
 const {rows}=await collect(f);expect(rows[0].descriptionHash).toBe(digest(body));expect(metadataBodyCovered({head,descriptionHash:digest(body),metadataCheckEvidence:rows},[name])).toBe(false);
});

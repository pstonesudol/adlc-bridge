import {test,expect} from 'bun:test';
import {customCheckEvidence} from '../src/coderabbit-checks';
import {decision} from '../src/review-loop';
import {customFixture} from './coderabbit-fixture';
test('PR108 regression: green run plus custom Verification Evidence error is scoped remediation, never approval',()=>{
 const f=customFixture(),e=f.evidence();
 expect(e.blocker).toBeNull();expect(e.findings).toHaveLength(1);
 expect(e.findings[0]).toMatchObject({source:'coderabbit-custom',kind:'pr_description',path:null,sha:f.head,reviewId:10,commentId:20,checkId:30});
 expect(e.findings[0].body).toContain('**Resolution**');expect(e.findings[0].body).toContain('historical');
 expect(decision({...e,clear:false,reasons:['Explicit latest-SHA CodeRabbit approval missing'],failedChecks:[]},['src/**'],0)).toMatchObject({state:'remediation_pending',send:true});
 expect(decision({...e,clear:false,failedChecks:[],findings:[...e.findings,{path:'outside/file.ts'}]},['src/**'],0).send).toBe(false);
});
test('warnings and old walkthrough NEEDS_EVIDENCE prose do not become failing custom checks',()=>{
 for(const status of ['Warning','Passed']){const f=customFixture();f.comments[0].body=f.comments[0].body.replace('![Error]','!['+status+']');f.review.state='APPROVED';expect(f.evidence()).toMatchObject({blocker:null,findings:[],bodyReviewed:true});}
});
for(const change of ['missing-commit','malformed-commit','edited-summary','edited-body','unknown-body','spoof-review','spoof-comment','wrong-pr','missing-details','truncated-details','duplicate-summary','ambiguous-run','stale-section','pending-run'])test(`custom evidence fails closed: ${change}`,()=>{
 const f=customFixture();
 if(change==='missing-commit')delete (f.review as any).commit_id;
 if(change==='malformed-commit')f.review.commit_id='';
 if(change==='edited-summary')f.comments[0].updated_at='2026-11-01T01:03:00Z';
 if(change==='edited-body')f.context.version.lastEditedAt='2026-11-01T01:01:00Z';
 if(change==='unknown-body')(f.context as any).version=undefined;
 if(change==='spoof-review')f.review.user={...f.review.user,type:'User'};
 if(change==='spoof-comment')f.comments[0].user={...f.comments[0].user,type:'User'};
 if(change==='wrong-pr')f.comments[0].issue_url='https://api.github.com/repos/owner/repo/issues/2';
 if(change==='missing-details')f.comments[0].body=f.comments[0].body.replace('Full details: Verification Evidence','Unrelated details');
 if(change==='truncated-details')f.comments[0].body=f.comments[0].body.replace('Never invent results.','Truncated…');
 if(change==='duplicate-summary')f.comments.push({...f.comments[0],id:21});
 if(change==='ambiguous-run')f.context.checks.push({...f.context.checks[0],id:31});
 if(change==='stale-section')f.comments[0].body=f.comments[0].body.replace('<!-- pre_merge_checks_walkthrough_end -->','');
 if(change==='pending-run')f.context.checks[0].status='in_progress';
 expect(f.evidence().findings).toEqual([]);if(change==='pending-run')expect(f.evidence().blocker).toBeNull();else expect(f.evidence().blocker).toBeTruthy();
});
test('a known stale-head bot review waits for the current-head run rather than becoming a custom blocker',()=>{
 const f=customFixture();f.review.commit_id='b'.repeat(40);f.context.checks=[];
 const e=f.evidence();expect(e).toEqual({findings:[],blocker:null,bodyReviewed:false});
 expect(decision({...e,customCheckBlocker:e.blocker,clear:false,reasons:['Explicit latest-SHA CodeRabbit approval missing'],failedChecks:[],pendingChecks:[],missingChecks:[]},['src/**'],0)).toMatchObject({state:'waiting_for_coderabbit',send:false});
 expect(customCheckEvidence(f.review,f.head,f.comments).blocker).toBeTruthy();
});
test('unrelated newer bot command replies never replace the summary; edits change evidence identity',()=>{
 const f=customFixture(),original=f.evidence().findings[0];
 f.comments.push({...f.comments[0],id:21,body:'Full review finished.',updated_at:'2026-11-01T01:02:01Z'});
 expect(f.evidence().findings[0]).toEqual(original);
 f.comments[0].body=f.comments[0].body.replace('Never invent results.','Preserve exact observed results.');
 expect(f.evidence().findings[0].evidenceHash).not.toBe(original.evidenceHash);
 expect(customCheckEvidence(f.review,f.head,f.comments)).toMatchObject({findings:[]});
});
test('full nested resolution details are retained rather than silently cut at an inner details tag',()=>{
 const f=customFixture();f.comments[0].body=f.comments[0].body.replace('Never invent results.','<details><summary>Commands</summary>Exact commands required.</details> Preserve historical checks and report runtime limitations.');
 expect(f.evidence().findings[0].body).toContain('Preserve historical checks and report runtime limitations.');
});
for(const text of ['Run `go test ./...` and record the result.','The log output was truncated; inspect the complete artifact before reporting.','Compare old...new results, then record current-head verification.'])test(`complete details allow ordinary text: ${text}`,()=>{
 const f=customFixture();f.comments[0].body=f.comments[0].body.replace('Never invent results.',text);
 const result=f.evidence();expect(result.blocker).toBeNull();expect(result.findings).toHaveLength(1);expect(result.findings[0].body).toContain(text);
});
for(const ending of ['Incomplete…','Incomplete...','**Incomplete…**','**Incomplete...**','[truncated]','[incomplete]','[TRUNCATED]','<dl><dd>Incomplete… </dd> </dl>','<p>Incomplete... </p>','<p><strong>Incomplete…</strong></p>'])test(`trailing truncation marker still fails closed: ${ending}`,()=>{
 const f=customFixture();f.comments[0].body=f.comments[0].body.replace('Never invent results.',ending);
 expect(f.evidence().findings).toEqual([]);expect(f.evidence().blocker).toContain('missing or truncated');
});

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
for(const status of ['Error','Warning','Passed'])test(`table rows after full details fail closed: ${status}`,()=>{
 const f=customFixture();
 f.comments[0].body=f.comments[0].body.replace('<!-- pre_merge_checks_walkthrough_end -->',`| Unsupported check | ![${status}](status.svg) | Extra result after details |\n<!-- pre_merge_checks_walkthrough_end -->`);
 const e=f.evidence();expect(e.findings).toEqual([]);expect(e.bodyReviewed).toBe(false);expect(e.blocker).toContain('table continues after full details');
 expect(decision({...e,customCheckBlocker:e.blocker,clear:false,failedChecks:[],findings:[{path:'src/fix.ts',body:'unrelated'}]},['src/**'],0)).toMatchObject({state:'blocked',send:false});
});
test('table rows nested inside full details also remain ambiguous instead of being dropped',()=>{
 const f=customFixture();f.comments[0].body=f.comments[0].body.replace('Never invent results.','Never invent results.\n| Another check | ![Error](error.svg) | Unsupported error |');
 expect(f.evidence()).toMatchObject({findings:[],bodyReviewed:false});expect(f.evidence().blocker).toContain('table continues after full details');
});
for(const [open,close] of [['```text','```'],['~~~console','~~~'],['````','`````'],['   ```text','   ```']])test(`complete fenced pipe output is not a check table: ${open}`,()=>{
 const f=customFixture(),output=`${open}\n| tests | passed |\n${close}`;
 f.comments[0].body=f.comments[0].body.replace('Never invent results.',`Observed output:\n${output}\nNever invent results.`);
 const e=f.evidence();expect(e.blocker).toBeNull();expect(e.findings).toHaveLength(1);expect(e.findings[0].body).toContain(output);
});
for(const close of ['```','~~~','``'])test(`table detection resumes after a fence or rejects an incomplete fence: ${close}`,()=>{
 const f=customFixture();f.comments[0].body=f.comments[0].body.replace('Never invent results.',`Observed output:\n\x60\x60\x60text\n| tests | passed |\n${close}\n| Unsupported check | ![Error](error.svg) | Outside or uncertain fence |`);
 expect(f.evidence()).toMatchObject({findings:[],bodyReviewed:false});expect(f.evidence().blocker).toBeTruthy();
});
for(const marker of ['~~~','```'])test(`HTML comments cannot open fences that hide check rows: ${marker}`,()=>{
 const f=customFixture(),payload=`<!--\n${marker}\n-->\n| Unsupported check | ![Error](error.svg) | Must not be hidden |\n<!--\n${marker}\n-->`;
 f.comments[0].body=f.comments[0].body.replace('Never invent results.',payload);
 const e=f.evidence();expect(e).toMatchObject({findings:[],bodyReviewed:false});expect(e.blocker).toContain('markup is ambiguous');
 expect(decision({...e,customCheckBlocker:e.blocker,clear:false,failedChecks:[],findings:[{path:'src/fix.ts',body:'unrelated'}]},['src/**'],0)).toMatchObject({state:'blocked',send:false});
});
test('HTML comment text inside complete fenced output stays literal output',()=>{
 const f=customFixture(),output='```text\n<!--\n~~~\n-->\n| tests | passed |\n```';
 f.comments[0].body=f.comments[0].body.replace('Never invent results.',`Observed output:\n${output}\nNever invent results.`);
 expect(f.evidence().blocker).toBeNull();expect(f.evidence().findings[0].body).toContain(output);
});
for(const status of ['![Failed](error.svg)','Error','![Error]()','![Error](error.svg) ![Passed](passed.svg)',''])test(`unclassifiable custom status blocks unrelated remediation: ${status}`,()=>{
 const f=customFixture();f.comments[0].body=f.comments[0].body.replace('![Error](error.svg)',status);
 const e=f.evidence();expect(e.findings).toEqual([]);expect(e.bodyReviewed).toBe(false);expect(e.blocker).toContain('unclassifiable');
 expect(decision({...e,customCheckBlocker:e.blocker,clear:false,failedChecks:[],findings:[{path:'src/fix.ts',body:'unrelated'}]},['src/**'],0)).toMatchObject({state:'blocked',send:false});
});
test('malformed check row is blocked while recognized other-check errors retain their handling',()=>{
 const malformed=customFixture();malformed.comments[0].body=malformed.comments[0].body.replace('| Verification Evidence |','Verification Evidence |');
 expect(malformed.evidence().blocker).toContain('unclassifiable');
 const other=customFixture();other.comments[0].body=other.comments[0].body.replace('| Verification Evidence |','| Migration Safety |');
 expect(other.evidence()).toMatchObject({findings:[],bodyReviewed:false});expect(other.evidence().blocker).toContain('unsupported custom check');
 for(const status of ['Warning','Passed']){
  const f=customFixture();f.comments[0].body=f.comments[0].body.replace('| Verification Evidence |','| Migration Safety |').replace('![Error]','!['+status+']');
  expect(f.evidence()).toMatchObject({findings:[],blocker:null,bodyReviewed:true});
 }
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
 f.comments[0].body=f.comments[0].body.replace(f.head,f.review.commit_id);
 const e=f.evidence();expect(e).toEqual({findings:[],blocker:null,bodyReviewed:false});
 expect(decision({...e,customCheckBlocker:e.blocker,clear:false,reasons:['Explicit latest-SHA CodeRabbit approval missing'],failedChecks:[],pendingChecks:[],missingChecks:[]},['src/**'],0)).toMatchObject({state:'waiting_for_coderabbit',send:false});
 expect(customCheckEvidence(f.review,f.head,f.comments).blocker).toBeTruthy();
});
test('a valid stale summary waits for exactly one pending current-head run',()=>{
 const f=customFixture();f.review.commit_id='b'.repeat(40);
 f.comments[0].body=f.comments[0].body.replace(f.head,f.review.commit_id);
 f.context.checks[0].status='in_progress';
 expect(f.evidence()).toEqual({findings:[],blocker:null,bodyReviewed:false});
 f.context.checks.push({...f.context.checks[0],id:31});
 expect(f.evidence()).toMatchObject({findings:[],bodyReviewed:false});expect(f.evidence().blocker).toBeTruthy();
 f.context.checks.pop();f.context.checks[0].status='completed';
 expect(f.evidence().blocker).toBeTruthy();
});
for(const length of [39,...Array.from({length:23},(_,i)=>i+41),64,65])test(`unsupported commit length ${length} fails closed rather than becoming stale evidence`,()=>{
 const f=customFixture();f.review.commit_id='b'.repeat(length);f.context.checks=[];
 expect(f.evidence().findings).toEqual([]);expect(f.evidence().blocker).toBeTruthy();
});
for(const state of ['current-summary','missing-summary-head','edited-old-summary','completed-current-run','pending-current-run'])test(`stale review cannot discard ambiguous/current evidence: ${state}`,()=>{
 const f=customFixture();f.review.commit_id='b'.repeat(40);
 if(state!=='completed-current-run'&&state!=='pending-current-run')f.context.checks=[];
 if(state==='pending-current-run')f.context.checks[0].status='in_progress';
 if(state==='missing-summary-head')f.comments[0].body=f.comments[0].body.replace('**Commit**','**Unknown**');
 if(state==='edited-old-summary'){
  f.comments[0].body=f.comments[0].body.replace(f.head,f.review.commit_id);
  f.comments[0].updated_at='2026-11-01T01:03:00Z';
 }
 // Current summary contains an unsupported error: it must not be skipped just
 // because the effective review still refers to the previous head.
 f.comments[0].body=f.comments[0].body.replace('| Verification Evidence |','| Unsupported check |');
 const e=f.evidence();expect(e.findings).toEqual([]);expect(e.blocker).toBeTruthy();
 expect(decision({...e,customCheckBlocker:e.blocker,clear:false,reasons:[],failedChecks:[],findings:[{path:'src/fix.ts',body:'unrelated fix'}]},['src/**'],0)).toMatchObject({state:'blocked',send:false});
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

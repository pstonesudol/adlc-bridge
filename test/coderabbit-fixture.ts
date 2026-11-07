import {customCheckEvidence} from '../src/coderabbit-checks';
export function customFixture(){
 const head='a'.repeat(40),user={id:136622811,login:'coderabbitai[bot]',type:'Bot'};
 const review={id:10,user,state:'CHANGES_REQUESTED',commit_id:head,submitted_at:'2026-11-01T01:02:00Z',body:'Pre-merge checks failed. Please resolve the failing checks before merging.'};
 const comments=[{id:20,user,issue_url:'https://api.github.com/repos/owner/repo/issues/1',created_at:'2026-10-31T01:00:00Z',updated_at:'2026-11-01T01:01:59Z',body:`<!-- recent_review_start -->
- **Commit**: [aaaaaaa](<https://github.com/owner/repo/commit/${head}>)
<!-- recent_review_end -->
Historical walkthrough: NEEDS_EVIDENCE on an older head.
<!-- pre_merge_checks_walkthrough_start -->
| Check name | Status | Explanation |
| Verification Evidence | ![Error](error.svg) | Missing exact TypeScript/frontend-test commands and browser evidence |
<details><summary><strong>Full details: Verification Evidence</strong></summary>
**Explanation**
The successful GitHub CI and CodeRabbit run are not evidence of local checks on the current head. Prior tests were historical.
**Resolution**
Inspect current-head CI and session artifacts. Record exact TypeScript and frontend-test commands, working directory/runtime, observed results, and mobile/desktop browser evidence. Never invent results.
</details>
<!-- pre_merge_checks_walkthrough_end -->`}];
 const context={repo:'owner/repo',pr:1,body:'Original PR description',version:{body:'Original PR description',headRefOid:head,createdAt:'2026-10-31T00:00:00Z',lastEditedAt:'2026-11-01T00:59:00Z'},checks:[{id:30,name:'CodeRabbit',head_sha:head,app:{slug:'coderabbitai'},status:'completed',conclusion:'success',started_at:'2026-11-01T01:00:00Z',completed_at:'2026-11-01T01:02:02Z'}]};
 return {head,review,comments,context,evidence:()=>customCheckEvidence(review,head,comments,context)};
}
/** PR #30 shape: the current-head run completed `skipped` while the only bot
 * review is CHANGES_REQUESTED on an earlier commit. */
export function pr30CustomFixture(){
 const head='371f36b47194ee754aaa354bd64e1942625ac6f8',stale='82855a5877ac91d9b7b87f95d3228112f562099e',user={id:136622811,login:'coderabbitai[bot]',type:'Bot'};
 const review={id:5810360982,user,state:'CHANGES_REQUESTED',commit_id:stale,submitted_at:'2026-11-07T05:41:15Z',body:'**Actionable comments posted: 4**'};
 const comments=[{id:6702871552,user,issue_url:'https://api.github.com/repos/owner/repo/issues/30',created_at:'2026-11-07T05:34:34Z',updated_at:'2026-11-07T14:39:51Z',body:`<!-- pre_merge_checks_walkthrough_start -->
| Check name | Status | Explanation | Resolution |
| Verification Evidence | ![Inconclusive](inconclusive.svg) | The description gives commands and results. | Provide attributable current-head CI results. |
<!-- pre_merge_checks_walkthrough_end -->`}];
 const context={repo:'owner/repo',pr:30,body:'PR #30 description',version:{body:'PR #30 description',headRefOid:head,createdAt:'2026-11-07T05:34:19Z',lastEditedAt:null},checks:[{id:128433345849,name:'CodeRabbit',head_sha:head,app:{slug:'coderabbitai'},status:'completed',conclusion:'skipped',started_at:'2026-11-07T14:39:52Z',completed_at:'2026-11-07T14:39:52Z'}]};
 return {head,stale,review,comments,context,evidence:()=>customCheckEvidence(review,head,comments,context)};
}

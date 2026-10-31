import {test,expect} from 'bun:test';
import {effectiveBotReview,metadataFindings} from '../src/github';
test('informational reviews preserve approval while later change requests supersede it',()=>{
 const approval={user:{login:'coderabbitai[bot]'},state:'APPROVED',commit_id:'head',submitted_at:'2026-10-31T01:00:00Z'};
 const comment={...approval,state:'COMMENTED',submitted_at:'2026-10-31T02:00:00Z'};
 expect(effectiveBotReview([approval,comment])).toEqual(approval);
 const changes={...approval,state:'CHANGES_REQUESTED',submitted_at:'2026-10-31T03:00:00Z'};
 expect(effectiveBotReview([changes,approval,comment])).toEqual(changes);
 expect(effectiveBotReview([{...approval,user:{login:'other'}}])).toBeUndefined();
});
test('failed verification evidence is metadata-only and tied to current bot change request',()=>{
 const review={state:'CHANGES_REQUESTED',commit_id:'head',body:'Pre-merge checks failed.'};
 const comments=[{user:{login:'coderabbitai[bot]'},updated_at:'2026-10-31T01:00:00Z',body:'| Verification Evidence | ![Error](error.svg) | Missing exact commands |\n<summary><strong>Full details: Verification Evidence</strong></summary><p>List exact verified commands.</p></details>'}];
 expect(metadataFindings(review,'head',comments)[0]).toMatchObject({kind:'pr_description',path:null,sha:'head'});
 expect(metadataFindings(review,'newhead',comments)).toEqual([]);
 expect(metadataFindings({...review,state:'COMMENTED'},'head',comments)).toEqual([]);
 expect(metadataFindings(review,'head',[{...comments[0],user:{login:'other'}}])).toEqual([]);
});

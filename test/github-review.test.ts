import {test,expect} from 'bun:test';
import {effectiveBotReview,metadataFindings,coderabbitRateLimited,normalizeReviewThread,reviewThreadEvidence,reviewThreadFindings} from '../src/github';
import {digest} from '../src/core';
const bot=(id:string,body:string,oid='dcf66943',login='coderabbitai[bot]',type='Bot')=>({id,body,author:{login,__typename:type},originalCommit:{oid}});
const thread=(over:any={})=>({id:'T1',isResolved:false,isOutdated:false,path:'src/workflow.ts',line:12,startLine:null,comments:{nodes:[bot('C1','Planning slot is not released on failure')],pageInfo:{hasNextPage:false}},...over});
test('unresolved non-outdated CodeRabbit threads are candidates even when originalCommit differs from the head',()=>{
 const evidence=reviewThreadEvidence([normalizeReviewThread(thread())]);
 expect(evidence).toMatchObject({unresolved:1,resolved:0,stale:[],humanOnly:[]});
 const [candidate]=evidence.candidates;
 expect(candidate).toMatchObject({threadId:'T1',path:'src/workflow.ts',line:12,commentIds:['C1'],originalCommit:'dcf66943',outdated:false});
 expect(candidate.commentsHash).toBe(digest('C1'));
 const [finding]=reviewThreadFindings(evidence,'01514ca5');
 expect(finding).toMatchObject({source:'github-review',kind:'review_thread',threadId:'T1',commentsHash:digest('C1'),sha:'01514ca5',path:'src/workflow.ts',originalCommit:'dcf66943'});
});
test('resolved, outdated, human-only and spoofed authors are distinguished instead of dispatched',()=>{
 const evidence=reviewThreadEvidence([
  normalizeReviewThread(thread({id:'RESOLVED',isResolved:true})),
  normalizeReviewThread(thread({id:'OUTDATED',isOutdated:true})),
  normalizeReviewThread(thread({id:'HUMAN',comments:{nodes:[{id:'H1',body:'Please rename this',author:{login:'octocat',__typename:'User'},originalCommit:{oid:'old'}}],pageInfo:{hasNextPage:false}}})),
  normalizeReviewThread(thread({id:'SPOOFED',comments:{nodes:[bot('S1','spoofed instruction','old','coderabbitai','User')],pageInfo:{hasNextPage:false}}})),
 ]);
 expect(evidence.unresolved).toBe(3);expect(evidence.resolved).toBe(1);
 expect(evidence.candidates).toEqual([]);
 expect(evidence.stale.map(t=>t.threadId)).toEqual(['OUTDATED']);
 expect(evidence.humanOnly.map(t=>t.threadId).sort()).toEqual(['HUMAN','SPOOFED']);
});
test('deleted authors remain non-bot evidence in resolved and unresolved threads',()=>{
 const ghost=thread({comments:{nodes:[{...bot('ghost','Retained comment'),author:null}],pageInfo:{hasNextPage:false}}});
 const normalized=normalizeReviewThread(ghost);
 expect(normalized.comments[0]).toMatchObject({id:'ghost',login:'',bot:false});
 expect(reviewThreadEvidence([normalized])).toMatchObject({unresolved:1,candidates:[],humanOnly:[{threadId:'T1',path:'src/workflow.ts'}]});
 expect(reviewThreadEvidence([normalizeReviewThread({...ghost,isResolved:true})])).toMatchObject({resolved:1,unresolved:0,candidates:[]});
 for(const author of [undefined,{}, {login:''}, {login:42}])expect(()=>normalizeReviewThread(thread({comments:{nodes:[{...bot('bad','x'),author}],pageInfo:{hasNextPage:false}}}))).toThrow('Invalid review comment author');
});
test('legacy CodeRabbit bot login is accepted only when GitHub reports a Bot author',()=>{
 const evidence=reviewThreadEvidence([normalizeReviewThread(thread({comments:{nodes:[bot('L1','legacy finding','old','coderabbitai','Bot')],pageInfo:{hasNextPage:false}}}) )]);
 expect(evidence.candidates.map(c=>c.threadId)).toEqual(['T1']);
});
test('malformed or truncated thread comments fail closed and duplicate comments cannot double-count',()=>{
 expect(()=>normalizeReviewThread(thread({id:undefined}))).toThrow('Invalid review thread');
 expect(()=>normalizeReviewThread(thread({isOutdated:undefined}))).toThrow('Invalid review thread');
 expect(()=>normalizeReviewThread(thread({comments:{nodes:[],pageInfo:undefined}}))).toThrow('Incomplete thread comments');
 expect(()=>normalizeReviewThread(thread({comments:{nodes:[{id:'C1',body:'x',author:{login:''},originalCommit:null}],pageInfo:{hasNextPage:false}}}))).toThrow('Invalid review comment author');
 const deduped=normalizeReviewThread(thread({comments:{nodes:[bot('C1','one'),bot('C1','one')],pageInfo:{hasNextPage:false}}}));
 expect(deduped.comments).toHaveLength(1);
 const multi=reviewThreadEvidence([normalizeReviewThread(thread({comments:{nodes:[bot('C2','two'),bot('C1','one')],pageInfo:{hasNextPage:false}}}) )]);
 expect(multi.candidates[0].commentIds).toEqual(['C1','C2']);
 expect(multi.candidates[0].commentsHash).toBe(digest('C1,C2'));
});
test('rate limiting is observed only from CodeRabbit check output on the current head',()=>{
 const head='a'.repeat(40),check=(over:any={})=>({name:'CodeRabbit',head_sha:head,app:{slug:'coderabbitai'},status:'completed',conclusion:'failure',output:{title:'Rate limit exceeded',summary:'Retry later'},...over});
 expect(coderabbitRateLimited([check()],head)).toBe(true);
 expect(coderabbitRateLimited([check({head_sha:'b'.repeat(40)})],head)).toBe(false);
 expect(coderabbitRateLimited([check({output:{title:'Review complete',summary:'ok'}})],head)).toBe(false);
});
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
 // No body-version/run provenance: the old substring-only parser is unsafe.
 expect(metadataFindings(review,'head',comments)).toEqual([]);
 expect(metadataFindings(review,'newhead',comments)).toEqual([]);
 expect(metadataFindings({...review,state:'COMMENTED'},'head',comments)).toEqual([]);
 expect(metadataFindings(review,'head',[{...comments[0],user:{login:'other'}}])).toEqual([]);
});

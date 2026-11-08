import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {reviewerPolicy,reviewerInput,reviewerTrust,authenticatedReviewer,feedbackEligibility,collectTrustedFeedback,reviewerApprovals,bindReviewerPolicy,boundReviewerPolicy,BOT_IDENTITIES,type NormalizedFeedback} from '../src/reviewer-policy';
import {configuredReviewEvidence} from '../src/github-reviewers';
import {normalizeReviewThread} from '../src/github';
import {RECEIPT_FRESHNESS_MS} from '../src/receipt-reconciliation';
import {ReviewLoop} from '../src/review-loop';
import {ReviewRequests} from '../src/coderabbit-scheduling';
import {decision} from '../src/review-loop';
const now=Date.now();
const policy=()=>reviewerPolicy(undefined);
const trusts=()=>policy().map(r=>({reviewer:r.id,observed:now,ids:[r.identity!.userId],blocker:null}));
const context={repo:'o/r',pr:1,head:'a'.repeat(40),selfIds:[9]};
const finding=(over:any={}):NormalizedFeedback=>({id:'C1',threadId:'T1',body:'Missing ownership guard',userId:BOT_IDENTITIES.codex.userId,type:'Bot',login:'chatgpt-codex-connector[bot]',path:'src/a.ts',line:4,originalCommit:'older',outdated:false,resolved:false,original:{id:'C1',body:'Missing ownership guard'},...over});
test('example reviewer ingestion/remediation stays disabled until operator opt-in',async()=>{
 const example=await Bun.file(new URL('../config/project.example.json',import.meta.url)).json();
 expect(reviewerPolicy(example.reviewers).find(r=>r.id==='codex')).toMatchObject({enabled:false,remediate:false,approvalRequired:false,requestReview:false});
});
test('defaults keep CodeRabbit required and Codex advisory with no request adapter',()=>{
 expect(policy()).toMatchObject([{id:'coderabbit',approvalRequired:true,requestReview:true},{id:'codex',approvalRequired:false,requestReview:false}]);
 expect(reviewerPolicy(reviewerInput(policy()))).toEqual(policy());
 for(const over of [{adapter:'claude'},{requestReview:true},{reviewMode:'full'},{cooldown:60000},{retryLimit:2},{enabled:false,approvalRequired:true},{minimumSeverity:'urgent'},{includePaths:['../secret']},{excludePaths:['/absolute']},{identity:{login:'fake',type:'Bot'}},{unknown:true}])expect(()=>reviewerPolicy([{id:'codex',...over}])).toThrow();
 expect(()=>reviewerPolicy([{id:'coderabbit',approvalRequired:false}])).toThrow('cannot be weakened');
});
test('authenticated Codex feedback retains originals, source and head; spoofed, stale, self and control content excluded',()=>{
 const result=collectTrustedFeedback(policy(),trusts(),[finding()],context,now);
 expect(result.findings).toHaveLength(1);expect(result.findings[0]).toMatchObject({source:'github-review',repo:'o/r',pr:1,sha:context.head,originalCommit:'older',provenance:[{reviewer:'codex',userId:199175422,original:finding().original}]});
 for(const over of [{userId:1},{type:'User'},{resolved:true},{userId:9},{body:'<!-- adlc-control:x -->'},{body:''}])expect(collectTrustedFeedback(policy(),trusts(),[finding(over)],context,now).findings).toEqual([]);
 expect(collectTrustedFeedback(policy(),trusts(),[finding()],context,now+RECEIPT_FRESHNESS_MS+1).findings).toEqual([]);
 expect(collectTrustedFeedback(policy(),trusts(),[finding({outdated:true})],context,now).pending[0].category).toBe('stale');
});
test('unknown severity, pathless, rename exclusion and deleted paths do not silently clear findings',()=>{
 const r=policy()[1];expect(feedbackEligibility(r,finding({path:null}))).toBe('eligible');
 expect(feedbackEligibility({...r,minimumSeverity:'high'},finding())).toBe('unclassified');
 expect(feedbackEligibility({...r,minimumSeverity:'high'},finding({severity:'low'}))).toBe('excluded');
 expect(feedbackEligibility({...r,includePaths:['src/**']},finding({path:null}))).toBe('unclassified');
 expect(feedbackEligibility({...r,includePaths:['src/**'],excludePaths:['old/**']},finding({previousPath:'old/a.ts'}))).toBe('excluded');
 expect(feedbackEligibility(r,finding({path:'deleted/file.ts'}))).toBe('eligible');
});
test('path and severity exclusions retain provenance without blocking pending feedback',()=>{
 for(const [options,over] of [[{excludePaths:['src/**']},{}],[{includePaths:['test/**']},{}],[{minimumSeverity:'high'},{severity:'low'}]] as any[]){
  const p=reviewerPolicy([{id:'codex',...options}]);
  const result=collectTrustedFeedback(p,trusts(),[finding(over)],context,now);
  expect(result.findings).toEqual([]);expect(result.pending).toEqual([]);
  expect(result.excluded).toMatchObject([{id:'C1',category:'excluded',original:finding().original}]);
  expect(result.ignoredThreadIds).toEqual(['T1']);
  expect(decision({clear:true,findings:[],failedChecks:[],reviewerEvidence:result},['src/**'],0).state).toBe('ready_for_human');
 }
});
test('exclusions do not hide unclassified, stale, disabled, mixed or untrusted feedback and never approve reviews',()=>{
 const p=reviewerPolicy([{id:'codex',excludePaths:['src/**'],minimumSeverity:'high',approvalRequired:true}]);
 for(const over of [{outdated:true},{path:null},{path:'test/a.ts'}]){
  const result=collectTrustedFeedback(p,trusts(),[finding(over)],context,now);
  expect(result.pending).toHaveLength(1);expect(result.ignoredThreadIds).toEqual([]);
  expect(decision({clear:false,findings:[],failedChecks:[],reviewerEvidence:result},['src/**'],0).state).toBe('blocked');
 }
 const disabled=collectTrustedFeedback(reviewerPolicy([{id:'codex',excludePaths:['src/**'],remediate:false}]),trusts(),[finding()],context,now);
 expect(disabled.pending[0].category).toBe('remediation-disabled');expect(disabled.ignoredThreadIds).toEqual([]);
 const mixed=collectTrustedFeedback(p,trusts(),[finding(),finding({id:'C2',path:'test/a.ts',severity:'critical'})],context,now);
 expect(mixed.findings).toHaveLength(1);expect(mixed.ignoredThreadIds).toEqual([]);
 const unknown=collectTrustedFeedback(p,trusts(),[finding(),finding({id:'C2',userId:1})],context,now);
 expect(unknown.ignoredThreadIds).toEqual([]);
 expect(reviewerApprovals(p,trusts(),[],context.head,[],now).blockers).toContain('Reviewer codex: explicit current-head approval required');
 expect(reviewerApprovals(p,trusts(),[{id:42,user:{id:199175422,type:'Bot'},state:'CHANGES_REQUESTED',commit_id:context.head,submitted_at:new Date(now).toISOString()}],context.head,[],now).blockers).toContain('Reviewer codex: changes requested (42)');
});
test('edited bodies change durable identity, exact duplicates retain provenance and distinct findings survive',()=>{
 const collect=(fs:NormalizedFeedback[])=>collectTrustedFeedback(policy(),trusts(),fs,context,now).findings;
 const first=collect([finding()])[0];
 expect(collect([finding({body:'Different fix',original:{body:'Different fix'}})])[0].commentsHash).not.toBe(first.commentsHash);
 const duplicate=collect([finding(),finding({id:'C2',original:{id:'C2',body:finding().body}})]);
 expect(duplicate).toHaveLength(1);expect(duplicate[0].provenance).toHaveLength(2);expect(duplicate[0].body).toBe(finding().body);
 expect(duplicate[0].commentIds).toEqual(['C1','C2']);
 expect(collect([finding(),finding({threadId:'T2',body:'Distinct fix'})])).toHaveLength(2);
});
test('advisory observation failures block clearance without granting trust or requiring approval',()=>{
 const p=reviewerPolicy([{id:'human',adapter:'github-review',identity:{userId:3,type:'User'}}]);
 const review={id:42,user:{id:3,type:'User'},state:'CHANGES_REQUESTED',body:'Fix ownership',commit_id:context.head,submitted_at:new Date(now).toISOString()};
 const fresh=[...trusts(),{reviewer:'human',observed:now,ids:[3],blocker:null}];
 expect(reviewerApprovals(p,fresh,[review],context.head,[],now).blockers).toContain('Reviewer human: changes requested (42)');
 const failure='Reviewer human: fresh identity/membership evidence unavailable or mismatched; no trust granted';
 const unavailable=[...trusts(),{reviewer:'human',observed:now,ids:[],blocker:failure}];
 const failed=reviewerApprovals(p,unavailable,[review],context.head,[],now);
 expect(failed.blockers).toContain(failure);
 expect(failed.blockers.some(b=>b.includes('human: explicit current-head approval'))).toBe(false);
 expect(failed.status.find(s=>s.reviewer==='human')).toMatchObject({approved:false,changesRequested:[]});
 for(const evidence of [trusts(),[...trusts(),{reviewer:'human',observed:now-RECEIPT_FRESHNESS_MS-1,ids:[3],blocker:null}]])expect(reviewerApprovals(p,evidence,[review],context.head,[],now).blockers).toContain('Reviewer human: fresh identity/membership evidence required before clearance');
 const recovered=reviewerApprovals(p,fresh,[],context.head,[],now);
 expect(recovered.blockers.some(b=>b.startsWith('Reviewer human:'))).toBe(false);
});
test('approval is per reviewer/member/current head; comments and dismissal never approve',()=>{
 const p=reviewerPolicy([{id:'human',adapter:'github-review',membership:{kind:'collaborators'},approvalRequired:true}]);
 const trust=[...trusts(),{reviewer:'human',observed:now,ids:[3,4],blocker:null}];
 const review=(over:any={})=>({id:1,user:{id:3,type:'User'},state:'APPROVED',commit_id:context.head,submitted_at:'2026-11-07T00:00:00Z',...over});
 expect(reviewerApprovals(p,trust,[review()],context.head,[],now).status.find(s=>s.reviewer==='human').approved).toBe(true);
 for(const over of [{state:'COMMENTED'},{state:'DISMISSED'},{commit_id:'old'},{user:{id:99,type:'User'}}])expect(reviewerApprovals(p,trust,[review(over)],context.head,[],now).status.find(s=>s.reviewer==='human').approved).toBe(false);
 expect(reviewerApprovals(p,trust,[review(),review({id:2,user:{id:4,type:'User'},state:'CHANGES_REQUESTED',commit_id:'old'})],context.head,[],now).blockers.some(b=>b.includes('changes requested'))).toBe(true);
 expect(reviewerApprovals(policy(),trusts(),[],context.head,[],now).blockers.some(b=>b.includes('codex'))).toBe(false);
});
test('fresh bounded membership excludes bots, revoked members and incomplete/renamed identity evidence',async()=>{
 const p=reviewerPolicy([{id:'humans',adapter:'github-review',membership:{kind:'collaborators'}}]);
 let revoked=false;const read=async(args:string[])=>{
  const path=args[1];if(path.startsWith('user/')){const id=Number(path.split('/')[1]);return {id,type:'Bot',login:id===136622811?'coderabbitai[bot]':'chatgpt-codex-connector[bot]'};}
  if(path.endsWith('page=1'))return Array.from({length:100},(_,i)=>({id:i+1,login:`human${i}`,type:'User',permissions:{pull:true}}));
  return revoked?[]:[{id:999,login:'last',type:'User',permissions:{pull:true}},{id:1000,login:'bot',type:'Bot',permissions:{pull:true}}];
 };
 const t=await reviewerTrust(p,'o/r',read,()=>now);expect(t.at(-1)!.ids).toContain(999);expect(t.at(-1)!.ids).not.toContain(1000);
 revoked=true;expect((await reviewerTrust(p,'o/r',read,()=>now)).at(-1)!.ids).not.toContain(999);
 const renamed=await reviewerTrust(policy(),'o/r',async args=>({id:Number(args[1].split('/')[1]),type:'Bot',login:'spoofed'}),()=>now);
 expect(renamed.every(t=>t.blocker&&t.ids.length===0)).toBe(true);
 const missing=await reviewerTrust(p,'o/r',async()=>{throw Error('403');},()=>now);expect(missing.at(-1)!.ids).toEqual([]);
});
test('policy drift fails closed across restarts until a new reviewed plan binding',()=>{
 const s=new Store(':memory:'),job=s.enqueue('p','i','spec');const h=s.propose(job,'plan');s.approve(job,h,'human');
 bindReviewerPolicy(s,job,undefined);expect(boundReviewerPolicy(s,job)).toEqual(policy());
 expect(()=>bindReviewerPolicy(s,job,[{id:'codex',remediate:false}])).toThrow('fresh reviewed plan');
 const next=s.propose(job,'new plan');s.approve(job,next,'human');bindReviewerPolicy(s,job,[{id:'codex',remediate:false}]);expect(boundReviewerPolicy(s,job)[1].remediate).toBe(false);s.close();
});
test('generic adapter ingests authenticated Codex thread without treating bot summary as approval',async()=>{
 const p=policy(),bot=BOT_IDENTITIES.codex;
 const t=normalizeReviewThread({id:'T1',isResolved:false,isOutdated:false,path:'src/a.ts',line:1,comments:{nodes:[{id:'C1',body:'Fix guard',author:{login:bot.login,__typename:'Bot',databaseId:bot.userId},originalCommit:{oid:'old'}}],pageInfo:{hasNextPage:false}}});
 const result=await configuredReviewEvidence(p,'o/r',{number:1,user:{id:8},head:{sha:context.head},changed_files:1},[t],[{id:4,user:{id:bot.userId,type:'Bot'},state:'COMMENTED',body:'Looks good',commit_id:context.head}],[],async args=>{
  if(args[1]==='user')return {id:9};if(args.includes('--paginate'))return [[{filename:'src/a.ts',status:'modified'}]];
  const id=Number(args[1].split('/')[1]);return {id,type:'Bot',login:id===bot.userId?bot.login:BOT_IDENTITIES.coderabbit.login};
 });
 expect(result.findings).toHaveLength(1);expect(result.findings[0].provenance[0].reviewer).toBe('codex');expect(result.approvals.find(s=>s.reviewer==='codex').approved).toBe(false);
});
for(const scenario of ['unapproved','approved','edited','stale-head','dismissed','changes-requested','other-author','unverified','missing-time','invalid-review-time','ambiguous-time'])test(`human issue-comment acknowledgement: ${scenario}`,async()=>{
 const p=reviewerPolicy([{id:'human',adapter:'github-review',identity:{userId:3,type:'User'}}]);
 const pr={number:1,user:{id:8},head:{sha:context.head},changed_files:1};
 const comment:any={id:10,body:'Fix ownership',user:{id:3,type:'User',login:'human'},created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:01:00Z'};
 const approval:any={id:42,user:{id:3,type:'User',login:'human'},state:'APPROVED',commit_id:context.head,submitted_at:'2026-11-01T00:02:00Z'};
 let reviews:any[]=scenario==='unapproved'?[]:[approval];
 if(scenario==='edited')comment.updated_at='2026-11-01T00:03:00Z';
 if(scenario==='stale-head')approval.commit_id='older';
 if(scenario==='other-author')approval.user.id=4;
 if(scenario==='missing-time'){delete comment.created_at;delete comment.updated_at;}
 if(scenario==='invalid-review-time')approval.submitted_at='invalid';
 if(scenario==='ambiguous-time')reviews.push({...approval,id:44,state:'DISMISSED'});
 if(['dismissed','changes-requested'].includes(scenario))reviews.push({...approval,id:43,state:scenario==='dismissed'?'DISMISSED':'CHANGES_REQUESTED',submitted_at:'2026-11-01T00:03:00Z'});
 const read=async(args:string[])=>{
  const path=args[1];if(path==='user')return {id:9};if(args.includes('--paginate'))return [[{filename:'src/a.ts'}]];
  if(path==='user/3'){if(scenario==='unverified')throw Error('unavailable');return {id:3,type:'User',login:'human'};}
  if(path.endsWith('/permission'))return {user:{id:3},permission:'write'};
  const id=Number(path.split('/')[1]);return {id,type:'Bot',login:id===136622811?'coderabbitai[bot]':'chatgpt-codex-connector[bot]'};
 };
 const collect=()=>configuredReviewEvidence(p,'o/r',pr,[],reviews,[comment],read);
 const result=await collect();
 if(scenario==='approved'){
  expect(result.findings).toEqual([]);expect(result.acknowledged).toMatchObject([{threadId:'comment:10',reviewId:42,userId:3,head:context.head,original:comment}]);
  expect((await collect()).acknowledged).toHaveLength(1);
  expect(result.blockers.some(b=>b.startsWith('Reviewer human:'))).toBe(false);
 }else if(scenario==='unverified'){expect(result.acknowledged).toEqual([]);expect(result.blockers).toContain('Reviewer human: fresh identity/membership evidence unavailable or mismatched; no trust granted');}
 else{expect(result.acknowledged).toEqual([]);expect(result.findings.some(f=>f.threadId==='comment:10')).toBe(true);}
});
test('a provider reset beyond 24 hours cannot be truncated into an early global retry',()=>{
 const s=new Store(':memory:');new ReviewLoop(s);const job=s.enqueue('p','i','spec');let clock=1000;
 const schedule={head:'head',signature:'configuration',blocker:null,incremental:false},requests=new ReviewRequests(s,()=>clock),reset=clock+3*86400000;
 expect(requests.claim(job,'o/r',1,schedule)).toBe(true);requests.settle('o/r',1,'head','rate_limited','verified provider reset',reset);
 expect(requests.get('o/r',1,'head').next_attempt).toBe(reset);
 clock+=86400001;expect(requests.claim(job,'o/r',1,schedule)).toBe(false);expect(requests.claim(job,'other/repo',2,{...schedule,head:'another-head'})).toBe(false);
 clock=reset+1;expect(requests.claim(job,'o/r',1,schedule)).toBe(true);s.close();
});
test('request overrides use shared durable receipts and cannot evade resets across heads',()=>{
 const s=new Store(':memory:');new ReviewLoop(s);const job=s.enqueue('p','i','spec');let clock=1000;
 const requests=new ReviewRequests(s,()=>clock),schedule={head:'head1',signature:'configuration',blocker:null,incremental:false};
 const p={requestReview:false,reviewMode:'full' as const,cooldown:600000,retryLimit:2};
 expect(requests.claim(job,'o/r',1,{...schedule,requestPolicy:p})).toBe(false);
 p.requestReview=true;expect(requests.claim(job,'o/r',1,{...schedule,requestPolicy:p})).toBe(true);
 expect(requests.get('o/r',1,'head1').mode).toBe('full');
 expect(requests.claim(job,'o/r',1,{...schedule,head:'head2',requestPolicy:p})).toBe(false);
 requests.settle('o/r',1,'head1','rate_limited','HTTP 429',200000);
 expect(requests.claim(job,'o/r',2,{...schedule,head:'head2',requestPolicy:p})).toBe(false);
 clock=200001;expect(requests.claim(job,'o/r',1,{...schedule,requestPolicy:p})).toBe(false);
 clock=601001;expect(requests.claim(job,'o/r',1,{...schedule,requestPolicy:p})).toBe(true);
 requests.settle('o/r',1,'head1','rate_limited','HTTP 429',700000);
 clock=2000000;expect(requests.claim(job,'o/r',1,{...schedule,requestPolicy:p})).toBe(false);
 expect(requests.get('o/r',1,'head1').attempts).toBe(2);s.close();
});

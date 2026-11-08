import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {ReviewLoop,postFullReview,postCodeRabbitReview} from '../src/review-loop';
import {deriveReviewSchedule,parseReviewConfig,ReviewRequests,collectReviewSchedule,ReviewRateLimit,reviewEscalationReason} from '../src/coderabbit-scheduling';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const yaml=(incremental=false)=>`reviews:\n  auto_review:\n    enabled: true\n    auto_incremental_review: ${incremental}\n    auto_pause_after_reviewed_commits: 0\n  path_filters: ['!dist/**']\n`;
test('publication defaults to regular review; whole-PR reassessment requires explicit full selection',async()=>{
 const calls:string[][]=[];
 const spawn:any=(args:string[])=>{calls.push(args);return {stdout:new Response('{}').body,stderr:new Response('').body,exited:Promise.resolve(0)};};
 await postCodeRabbitReview('owner/repo',19,'marker',spawn);
 await postFullReview('owner/repo',19,'marker',spawn);
 expect(calls[0]).toContain('body=@coderabbitai review\n\nmarker');
 expect(calls[0]).not.toContain('body=@coderabbitai full review\n\nmarker');
 expect(calls[1]).toContain('body=@coderabbitai full review\n\nmarker');
});
test('only protocol-confirmed throttling permits a new request attempt',async()=>{
 for(const publish of [postCodeRabbitReview,postFullReview])for(const status of [429,403,500]){
  const out=`HTTP/2 ${status}\r\nRetry-After: 120\r\n\r\n${JSON.stringify({message:status===500?'server error':'API rate limit exceeded'})}`;
  const spawn:any=()=>({stdout:new Response(out).body,stderr:new Response('').body,exited:Promise.resolve(1)});
  let failure:any;try{await publish('owner/repo',19,'marker',spawn);}catch(e){failure=e;}
  expect(failure instanceof ReviewRateLimit).toBe(status!==500);
  if(status===500)expect(failure.message).toContain('uncertain');
 }
});
const HEAD='371f36b47194ee754aaa354bd64e1942625ac6f8',STALE='82855a5877ac91d9b7b87f95d3228112f562099e';
const configured=(pause:number,incremental:boolean,drafts=false)=>`reviews:\n  auto_review:\n    enabled: true\n    auto_incremental_review: ${incremental}\n    auto_pause_after_reviewed_commits: ${pause}\n    drafts: ${drafts}\n  path_filters: ['!dist/**']\n`;
const botReview=(id:number,commit:string,state='CHANGES_REQUESTED',submitted='2026-11-07T05:41:15Z')=>({id,user:{login:'coderabbitai[bot]',type:'Bot'},state,commit_id:commit,submitted_at:submitted});
const skippedRun=(over:any={})=>({id:128433345849,name:'CodeRabbit',app:{slug:'coderabbitai'},head_sha:HEAD,status:'completed',conclusion:'skipped',started_at:'2026-11-07T14:39:52Z',completed_at:'2026-11-07T14:39:52Z',output:{title:'Review skipped',summary:'',text:''},...over});
function pr30(options:{pause?:number;incremental?:boolean;drafts?:boolean;draft?:boolean;reviews?:any[];checks?:any[];body?:string;title?:string;comments?:any[]}={}){
 const i=input(),pause=options.pause??2,incremental=options.incremental??false;
 i.head=HEAD;i.headText=i.baseText=configured(pause,incremental,options.drafts??false);
 i.pr={...i.pr,draft:options.draft??false,title:options.title??'feat: recover skipped reviews',body:options.body??'Verification evidence',labels:[],base:{ref:'main'},user:{login:'author'}};
 i.reviews=options.reviews??[botReview(5810360982,STALE)];
 i.checks=options.checks??[skippedRun()];
 i.comments=options.comments??[];
 return i;
}
test('PR #30 shape classifies a stale CHANGES_REQUESTED and skipped current-head run as recoverable',()=>{
 const schedule=deriveReviewSchedule(pr30());
 expect(schedule.blocker).toBeNull();
 expect(schedule.evidence).toMatchObject({classification:'stale-submitted-review',recoverable:true,review:{id:5810360982,state:'CHANGES_REQUESTED',commit:STALE,stale:true},check:{id:128433345849,status:'completed',conclusion:'skipped'},runs:1,reviewedCommits:1,pauseThreshold:2,incremental:false});
});
test('auto_pause 0 vs 2 and auto_incremental_review true vs false are classified separately',()=>{
 const two=[botReview(2,STALE,'CHANGES_REQUESTED','2026-11-07T05:41:15Z'),botReview(1,'c'.repeat(40),'COMMENTED','2026-11-07T05:00:00Z')];
 const unlimited=deriveReviewSchedule(pr30({pause:0,reviews:two}));
 expect(unlimited).toMatchObject({blocker:null,incremental:false,evidence:{classification:'stale-submitted-review',recoverable:true,reviewedCommits:2,pauseThreshold:0}});
 const oneCommit=deriveReviewSchedule(pr30({pause:2}));
 expect(oneCommit.blocker).toBeNull();
 const paused=deriveReviewSchedule(pr30({pause:2,reviews:two}));
 expect(paused.blocker).toContain('auto-pause threshold reached');
 expect(paused.evidence).toMatchObject({classification:'intentional-pause',recoverable:false,reviewedCommits:2,pauseThreshold:2});
 const automatic=deriveReviewSchedule(pr30({incremental:true}));
 expect(automatic).toMatchObject({blocker:null,incremental:true,evidence:{classification:'stale-submitted-review'}});
 expect(deriveReviewSchedule(pr30({incremental:false})).incremental).toBe(false);
});
test('draft and explicit ignore/pause are reported as provider intent, never overridden',()=>{
 const draft=deriveReviewSchedule(pr30({draft:true}));
 expect(draft.blocker).toContain('draft excluded by configuration');
 expect(draft.evidence).toMatchObject({classification:'explicit-opt-out',recoverable:false});
 expect(deriveReviewSchedule(pr30({draft:true,drafts:true})).blocker).toBeNull();
 const paused=deriveReviewSchedule(pr30({comments:[{body:'@coderabbitai pause',created_at:'2026-11-07T06:00:00Z'}]}));
 expect(paused.blocker).toContain('explicit pause command');
 expect(paused.evidence).toMatchObject({classification:'intentional-pause',recoverable:false});
 const ignored=deriveReviewSchedule(pr30({comments:[{body:'@coderabbitai ignore',created_at:'2026-11-07T06:00:00Z'}]}));
 expect(ignored.blocker).toContain('explicit ignore command');
 expect(ignored.evidence).toMatchObject({classification:'explicit-opt-out',recoverable:false});
 const bodyOptOut=deriveReviewSchedule(pr30({body:'@coderabbitai pause'}));
 expect(bodyOptOut.blocker).toContain('PR description explicitly opts out');
 expect(bodyOptOut.evidence).toMatchObject({classification:'explicit-opt-out',recoverable:false});
 const resumed=deriveReviewSchedule(pr30({comments:[{body:'@coderabbitai pause',created_at:'2026-11-07T06:00:00Z'},{body:'@coderabbitai resume',created_at:'2026-11-07T07:00:00Z'}]}));
 expect(resumed.blocker).toBeNull();
});
test('provider auto-pause wording stays recoverable until the configured threshold is reached',()=>{
 const auto=deriveReviewSchedule(pr30({checks:[skippedRun({output:{title:'Review skipped',summary:'Auto-pause after 2 reviewed commits',text:'Reviews paused after 2 reviewed commits'}})]}));
 expect(auto.blocker).toBeNull();expect(auto.evidence).toMatchObject({classification:'stale-submitted-review',recoverable:true,reviewedCommits:1,pauseThreshold:2});
 const explicit=deriveReviewSchedule(pr30({checks:[skippedRun({output:{title:'Review paused',summary:'A maintainer paused reviews for this PR.',text:''}})]}));
 expect(explicit.blocker).toContain('intentional review pause');
 expect(explicit.evidence).toMatchObject({classification:'intentional-pause',recoverable:false});
});
test('no review, current-head skip, rate limit and provider error keep distinct evidence classes',()=>{
 const none=deriveReviewSchedule(pr30({reviews:[],checks:[]}));
 expect(none.evidence).toMatchObject({classification:'no-review-no-run',recoverable:true,review:null,check:null,runs:0});
 const skipped=deriveReviewSchedule(pr30({reviews:[]}));
 expect(skipped.evidence).toMatchObject({classification:'current-head-skipped',recoverable:true,check:{id:128433345849,conclusion:'skipped'}});
 const limited=deriveReviewSchedule(pr30({reviews:[],checks:[skippedRun({conclusion:'failure',output:{title:'Rate limit exceeded',summary:'Retry later',text:''}})]}));
 expect(limited).toMatchObject({blocker:null,evidence:{classification:'rate-limited',recoverable:true}});
 const failed=deriveReviewSchedule(pr30({reviews:[],checks:[skippedRun({conclusion:'failure',output:{title:'Review failed',summary:'',text:''}})]}));
 expect(failed.evidence).toMatchObject({classification:'provider-error',recoverable:true});
});
test('terminal escalation names the head, exact check/review IDs, configuration and one safe action',()=>{
 const schedule=deriveReviewSchedule(pr30());
 const reason=reviewEscalationReason({repo:'owner/repo',pr:19,head:HEAD,schedule,attempts:1,requestState:'accepted'});
 expect(reason).toContain(`head ${HEAD}`);
 expect(reason).toContain('check 128433345849');
 expect(reason).toContain('review 5810360982');
 expect(reason).toContain(`at ${STALE}`);
 expect(reason).toContain('auto_pause_after_reviewed_commits=2');
 expect(reason).toContain('reviewed commits=1');
 expect(reason).toContain('requested mode regular');
 expect(reason).toContain('never automatic escalation');
 expect(reason).not.toContain('ambiguous');
 const limited=deriveReviewSchedule(pr30({reviews:[],checks:[skippedRun({conclusion:'failure',output:{title:'Rate limit exceeded',summary:'',text:''}})]}));
 const retryAt=Date.now()+120000,rateReason=reviewEscalationReason({repo:'owner/repo',pr:19,head:HEAD,schedule:limited,attempts:3,requestState:'rate_limited',retryAt});
 expect(rateReason).toContain('provider is rate limiting');
 expect(rateReason).toContain(new Date(retryAt).toISOString());
 expect(rateReason).toContain('do not post another review request');
});
const input=()=>({head:'a'.repeat(40),headText:yaml(),baseText:yaml(),identity:['owner/repo',19],pr:{title:'DEV-33 regression',body:'Verification evidence',draft:false,labels:[],base:{ref:'main'},user:{login:'author'}},defaultBranch:'main',files:[{filename:'src/a.ts'}],comments:[] as any[],reviews:[] as any[],checks:[] as any[]});
test('DEV-33/PR19 disabled incremental mode and automatic incremental mode derive different expectations',()=>{
 expect(deriveReviewSchedule(input())).toMatchObject({incremental:false,blocker:null});
 const i=input();i.headText=i.baseText=yaml(true);expect(deriveReviewSchedule(i)).toMatchObject({incremental:true,blocker:null});
 expect(parseReviewConfig('reviews: {}')).toMatchObject({enabled:true,incremental:true,drafts:false,pause:5});
});
test('head/base drift and missing, malformed, inherited and ambiguous scheduling fail closed',()=>{
 for(const text of ['', 'reviews: [', 'inheritance: true', 'reviews:\n  auto_review:\n    enabled: yes', 'reviews:\n  auto_review:\n    unknown_setting: true']){
  const i=input();i.headText=i.baseText=text;expect(deriveReviewSchedule(i).blocker).toContain('CodeRabbit review unavailable:');
 }
 const i=input();i.headText=yaml(true);expect(deriveReviewSchedule(i).blocker).toContain('head/base configuration differs');
});
test('draft, title, label, branch, author, path and pause eligibility never becomes clearance',()=>{
 const variants=[{draft:true},{title:'WIP change'},{labels:[{name:'wip'}]},{base:{ref:'other'}},{user:{login:'ignored'}},{body:'@coderabbitai ignore'}];
 for(const change of variants){const i=input();Object.assign(i.pr,change);i.headText=i.baseText=yaml()+`    \n`;if(change.title)i.headText=i.baseText=yaml().replace('    enabled: true','    enabled: true\n    ignore_title_keywords: [WIP]');if(change.labels)i.headText=i.baseText=yaml().replace('    enabled: true','    enabled: true\n    labels: ["!wip"]');if(change.user)i.headText=i.baseText=yaml().replace('    enabled: true','    enabled: true\n    ignore_usernames: [ignored]');expect(deriveReviewSchedule(i).blocker).not.toBeNull();}
 const i=input();i.files=[{filename:'dist/a.js'}];expect(deriveReviewSchedule(i).blocker).not.toBeNull();
 i.files=[{filename:'src/a.ts'}];i.comments=[{body:'@coderabbitai pause',created_at:'2026-01-01T00:00:00Z'}];expect(deriveReviewSchedule(i).blocker).not.toBeNull();
 i.comments.push({body:'@coderabbitai resume',created_at:'2026-01-02T00:00:00Z'});expect(deriveReviewSchedule(i).blocker).toBeNull();
 i.headText=i.baseText=yaml().replace('auto_pause_after_reviewed_commits: 0','auto_pause_after_reviewed_commits: 1');i.reviews=[{user:{login:'coderabbitai[bot]',type:'Bot'},commit_id:'old'}];expect(deriveReviewSchedule(i).blocker).not.toBeNull();
});
test('configuration collector pins all YAML lookups to GitHub head/base and rejects competing filenames',async()=>{
 const i=input(),pr={...i.pr,number:19,head:{sha:i.head,repo:{full_name:'owner/repo'}},changed_files:1};const calls:string[][]=[];
 const repository:any={defaultBranchRef:{name:'main'},hy:{oid:'headblob',text:yaml()},hm:null,by:{oid:'baseblob',text:yaml()},bm:null};
 const read=async(args:string[])=>{calls.push(args);return args[1]==='graphql'?{data:{repository}}:[i.files];};
 expect((await collectReviewSchedule('owner/repo',pr,'b'.repeat(40),[],[],[],read)).blocker).toBeNull();
 expect(calls[0]).toContain(`hy=${i.head}:.coderabbit.yaml`);expect(calls[0]).toContain(`by=${'b'.repeat(40)}:.coderabbit.yaml`);
 repository.hm={oid:'second',text:yaml()};expect((await collectReviewSchedule('owner/repo',pr,'b'.repeat(40),[],[],[],read)).blocker).toContain('competing');
 repository.hm=null;pr.changed_files=2;expect((await collectReviewSchedule('owner/repo',pr,'b'.repeat(40),[],[],[],read)).blocker).toContain('inventory incomplete');
});
test('durable per-repository/head dedupe survives reopening, uncertain delivery and cooldown',()=>{
 const dir=mkdtempSync(join(tmpdir(),'review-requests-')),path=join(dir,'state.sqlite');let s=new Store(path);new ReviewLoop(s);let now=1000;
 try{
  const job=s.enqueue('p','i','spec'),schedule=deriveReviewSchedule(input());let requests=new ReviewRequests(s,()=>now);
  expect(requests.claim(job,'owner/repo',19,schedule)).toBe(true);expect(requests.claim(job,'owner/repo',19,schedule)).toBe(false);
  s.close();s=new Store(path);requests=new ReviewRequests(s,()=>now);expect(requests.claim(job,'owner/repo',19,schedule)).toBe(false);
  requests.settle('owner/repo',19,schedule.head,'rate_limited','confirmed rejection',61000);expect(requests.claim(job,'owner/repo',19,schedule)).toBe(false);
  now=61001;expect(requests.claim(job,'owner/repo',19,schedule)).toBe(true);requests.settle('owner/repo',19,schedule.head,'accepted','comment 42');
  expect(s.db.query('SELECT state FROM coderabbit_request_attempts ORDER BY attempt').all()).toEqual([{state:'rate_limited'},{state:'accepted'}]);
  now+=86400000;expect(requests.claim(job,'owner/repo',19,{...schedule,signature:'config-changed'})).toBe(false);
  expect(requests.claim(job,'owner/second',19,schedule)).toBe(true);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('pre-mode shared receipts migrate as full without replay; a confirmed rejected retry becomes regular without resetting budget',()=>{
 for(const state of ['accepted','delivery_uncertain','rate_limited']){
  const s=new Store(':memory:');new ReviewLoop(s);const job=s.enqueue('p','i','spec'),schedule=deriveReviewSchedule(input());
  try{
   s.db.exec('ALTER TABLE coderabbit_requests DROP COLUMN mode; ALTER TABLE coderabbit_request_attempts DROP COLUMN mode');
   s.db.query('INSERT INTO coderabbit_requests VALUES (?,?,?,?,?,?,1,?,0,?)').run('owner/repo',19,schedule.head,job,schedule.signature,state,1,'old evidence');
   s.db.query('INSERT INTO coderabbit_request_attempts VALUES (?,?,?,?,?,?,?,?,?)').run('owner/repo',19,schedule.head,1,schedule.signature,state,1,'old evidence',0);
   const requests=new ReviewRequests(s,()=>100000);
   expect(requests.get('owner/repo',19,schedule.head)).toMatchObject({mode:'full',state,attempts:1});
   expect(requests.claim(job,'owner/repo',19,schedule)).toBe(state==='rate_limited');
   if(state==='rate_limited'){
    expect(requests.get('owner/repo',19,schedule.head)).toMatchObject({mode:'regular',attempts:2});
    expect(s.db.query('SELECT mode FROM coderabbit_request_attempts ORDER BY attempt').all()).toEqual([{mode:'full'},{mode:'regular'}]);
   }else expect(requests.get('owner/repo',19,schedule.head).mode).toBe('full');
   new ReviewRequests(s); // migration is repeatable
  }finally{s.close();}
 }
});

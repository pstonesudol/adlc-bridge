import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {ReviewLoop,postFullReview} from '../src/review-loop';
import {deriveReviewSchedule,parseReviewConfig,ReviewRequests,collectReviewSchedule,ReviewRateLimit} from '../src/coderabbit-scheduling';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const yaml=(incremental=false)=>`reviews:\n  auto_review:\n    enabled: true\n    auto_incremental_review: ${incremental}\n    auto_pause_after_reviewed_commits: 0\n  path_filters: ['!dist/**']\n`;
test('only protocol-confirmed throttling permits a new request attempt',async()=>{
 for(const status of [429,403,500]){
  const out=`HTTP/2 ${status}\r\nRetry-After: 120\r\n\r\n${JSON.stringify({message:status===500?'server error':'API rate limit exceeded'})}`;
  const spawn:any=()=>({stdout:new Response(out).body,stderr:new Response('').body,exited:Promise.resolve(1)});
  let failure:any;try{await postFullReview('owner/repo',19,'marker',spawn);}catch(e){failure=e;}
  expect(failure instanceof ReviewRateLimit).toBe(status!==500);
  if(status===500)expect(failure.message).toContain('uncertain');
 }
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

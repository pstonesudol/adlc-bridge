import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {CodeRabbitCooldowns,throttleEvidence,cooldownPolicy,cooldownDue,CODERABBIT_APP_ID,DEFAULT_COOLDOWN} from '../src/coderabbit-cooldowns';
import {ReviewLoop} from '../src/review-loop';
import {ReviewRequests,reviewRequestBody,reviewRequestMarker} from '../src/coderabbit-scheduling';
import {BOT_IDENTITIES,reviewerPolicy} from '../src/reviewer-policy';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const HEAD='a'.repeat(40),OTHER='b'.repeat(40),T=Date.parse('2026-11-11T12:00:00Z');
const iso=(n:number)=>new Date(n).toISOString();
const user={id:136622811,login:'coderabbitai[bot]',type:'Bot'};
const run=(over:any={})=>({id:123,app:{id:CODERABBIT_APP_ID,slug:'coderabbitai'},head_sha:HEAD,status:'completed',conclusion:'success',started_at:iso(T-1000),completed_at:iso(T),output:{title:'Review rate limited',summary:'',text:''},...over});
const observation=(repo='pstonesudol/adlc-bridge',over:any={})=>({repo,pr:38,head:HEAD,comments:[],checks:[run()],observed:T,...over});
const reply=(repo:string,body:string,over:any={})=>({id:99,user,issue_url:`https://api.github.com/repos/${repo}/issues/38`,created_at:iso(T),updated_at:iso(T),body,...over});
const boundReply=(repo:string,body:string,over:any={})=>reply(repo,`${body}\nhttps://github.com/${repo}/commit/${HEAD}`,over);

for(const repo of ['pstonesudol/adlc-bridge','pstonesudol/honeysummer'])test(`${repo}: authenticated automatic throttle uses one durable query and fallback`,()=>{
 const s=new Store(':memory:');let now=T;const ledger=new CodeRabbitCooldowns(s,()=>now,()=>0);
 try{
  let c=ledger.observe(observation(repo),[]);expect(c.next_action).toBe(T+60*60000);expect(c.attempts).toBe(0);
  const q=ledger.claimQuery(c);expect(q.body).toStartWith('@coderabbitai rate limit\n');expect(ledger.claimQuery(c)).toBeNull();
  expect(ledger.reserve(repo,38,HEAD)).toBe(false);now=c.next_action+1;
  expect(ledger.reserve(repo,38,HEAD)).toBe(false); // uncertain query isn't a send license
  expect(ledger.settleQuery(q,{id:42,body:q.body,user:{id:7},created_at:iso(T)})).toBe(true);
  expect(ledger.reserve(repo,38,HEAD)).toBe(true);expect(ledger.reserve(repo,38,HEAD)).toBe(false);
  expect(ledger.get(repo,38).attempts).toBe(1);
 }finally{s.close();}
});
test('user text, quoted guidance, wrong bot/app/repository/head and malformed evidence cannot trigger recovery',()=>{
 const o=observation();
 for(const checks of [[run({app:{id:1,slug:'coderabbitai'}})],[run({head_sha:OTHER})],[run({completed_at:'invalid'})]])expect(throttleEvidence({...o,checks},[])).toEqual([]);
 for(const c of [boundReply(o.repo,'Review rate limited.',{user:{...user,id:7}}),boundReply(o.repo,'> Review rate limited.'),boundReply(o.repo,'```\nReview rate limited.\n```'),boundReply(o.repo,'Review rate limited.',{issue_url:'https://api.github.com/repos/other/repo/issues/38'})])expect(throttleEvidence({...o,checks:[],comments:[c]},[])).toEqual([]);
 expect(throttleEvidence({...o,checks:[],comments:[reply(o.repo,'Review rate limited.')]},[])).toEqual([]);
 for(const text of ['<blockquote>\nReview rate limited.\n</blockquote>','   ```\nReview rate limited.\n   ```','Example provider wording:\nReview rate limited.'])expect(throttleEvidence({...o,checks:[],comments:[boundReply(o.repo,text)]},[])).toEqual([]);
});
for(const missing of [undefined,null])test(`missing command and receipt IDs cannot bind throttle evidence (${missing})`,()=>{
 const o=observation(),receipts=[{head:HEAD,attempts:1,state:'accepted',requested:T,comment_id:missing}],query={episode:1,requested:T,comment_id:missing};
 for(const commands of [[],[{id:missing,body:'@coderabbitai review',created_at:iso(T-1000)}]]){
  expect(throttleEvidence({...o,checks:[],comments:[...commands,reply(o.repo,'Review rate limited.')]},receipts,query)).toEqual([]);
  const independentlyBound=throttleEvidence({...o,checks:[],comments:[...commands,boundReply(o.repo,'Review rate limited.')]},receipts,query);
  expect(independentlyBound).toHaveLength(1);expect(independentlyBound[0].request).toBeUndefined();
 }
});
test('unbound bot reply cannot settle a requesting cycle or reject a marker-only accepted receipt',()=>{
 const s=new Store(':memory:');new ReviewLoop(s);let now=T;const requests=new ReviewRequests(s,()=>now),job=s.enqueue('p','i','spec'),o=observation();
 const schedule={head:HEAD,signature:'config',blocker:null,incremental:false};
 try{
  expect(requests.claim(job,o.repo,o.pr,schedule)).toBe(true);
  requests.settle(o.repo,o.pr,HEAD,'accepted',JSON.stringify({id:41}));
  let c=requests.cooldowns.observe(o,requests.receipts(o.repo,o.pr));requests.reconcileThrottle(o.repo,o.pr);
  const q=requests.cooldowns.claimQuery(c);requests.cooldowns.settleQuery(q,{id:42,body:q.body,user:{id:7},created_at:iso(now)});
  now=c.next_action+1;expect(requests.claim(job,o.repo,o.pr,schedule)).toBe(true);
  requests.settle(o.repo,o.pr,HEAD,'accepted',reviewRequestMarker(o.repo,o.pr,HEAD));
  c=requests.cooldowns.get(o.repo,o.pr);expect(c.state).toBe('requesting');
  const before={attempts:c.attempts,episode:c.episode,next_action:c.next_action};now+=1000;
  const unrelated={...o,observed:now,checks:[],comments:[reply(o.repo,'Review rate limited.',{created_at:iso(now),updated_at:iso(now)})]};
  expect(throttleEvidence(unrelated,requests.receipts(o.repo,o.pr))).toEqual([]);
  requests.cooldowns.observe(unrelated,requests.receipts(o.repo,o.pr));requests.reconcileThrottle(o.repo,o.pr);
  expect(requests.cooldowns.get(o.repo,o.pr)).toMatchObject({...before,state:'requesting'});
  expect(requests.get(o.repo,o.pr,HEAD)).toMatchObject({state:'accepted',attempts:2});
  expect(s.db.query('SELECT count(*) AS n FROM coderabbit_throttle_evidence').get()).toEqual({n:1});
 }finally{s.close();}
});
test('explicit timing beats fallback with a positive buffer; edited versions never restart the relative baseline',()=>{
 const s=new Store(':memory:');let now=T;const l=new CodeRabbitCooldowns(s,()=>now,()=>0),o=observation();
 try{
  let c=l.observe(o,[]);const q=l.claimQuery(c);l.settleQuery(q,{id:10,body:q.body,user:{id:7},created_at:iso(T)});
  now+=60000;const command={id:10,body:q.body,created_at:iso(T)},response=reply(o.repo,"You're currently rate limited under our Fair Usage Limits Policy. Your next review will be available in 22 minutes.",{created_at:iso(now),updated_at:iso(now)});
  c=l.observe({...o,observed:now,comments:[command,response]},[]);
  expect(c.next_action).toBe(now+27*60000);expect(c.reliable).toBe(1);
  const reset=c.next_action;now+=60000;
  c=l.observe({...o,observed:now,comments:[command,{...response,updated_at:iso(now),body:response.body+'\nAn unrelated note.'}]},[]);
  expect(c.next_action).toBe(reset);expect(l.claimQuery(c)).toBeNull();
  expect(s.db.query('SELECT count(*) AS n FROM coderabbit_throttle_evidence').get()).toEqual({n:3});
 }finally{s.close();}
});
test('edited-on-first-observation or malformed relative timing uses a conservative fallback',()=>{
 const s=new Store(':memory:'),l=new CodeRabbitCooldowns(s,()=>T,()=>1),o=observation();
 try{
  const c=l.observe({...o,checks:[],comments:[boundReply(o.repo,'Review rate limited. Your next review will be available in 2 minutes.',{created_at:iso(T-60000),updated_at:iso(T)})]},[]);
  expect(c.reliable).toBe(0);expect(c.next_action).toBe(T+Math.ceil(DEFAULT_COOLDOWN.fallback*1.05));
  expect(throttleEvidence({...o,checks:[],comments:[boundReply(o.repo,'Review rate limited. Retry after potatoes.')]},[])[0].reset).toBeNull();
 }finally{s.close();}
});
test('delivered review plus fresh bound bot rejection becomes retryable without rewriting accepted delivery history',()=>{
 const s=new Store(':memory:');new ReviewLoop(s);let now=T;const requests=new ReviewRequests(s,()=>now),job=s.enqueue('p','i','spec');
 const schedule={head:HEAD,signature:'config',blocker:null,incremental:false};
 try{
  expect(requests.claim(job,'pstonesudol/adlc-bridge',38,schedule)).toBe(true);
  requests.settle('pstonesudol/adlc-bridge',38,HEAD,'accepted',JSON.stringify({id:41}));
  const command={id:41,body:reviewRequestBody('regular',reviewRequestMarker('pstonesudol/adlc-bridge',38,HEAD)),created_at:iso(T)};
  now+=1000;const body='<!-- coderabbit-ai-generated:v1 -->\n<details>\n<summary>Action not completed</summary>\nReview rate limited.\n\n> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits.\n</details>';
  const o=observation(undefined,{observed:now,checks:[],comments:[command,reply('pstonesudol/adlc-bridge',body,{created_at:iso(now),updated_at:iso(now)})]});
  const c=requests.cooldowns.observe(o,requests.receipts(o.repo,o.pr));requests.reconcileThrottle(o.repo,o.pr);
  expect(requests.get(o.repo,o.pr,HEAD).state).toBe('rate_limited');
  expect(s.db.query('SELECT state FROM coderabbit_request_attempts').get()).toEqual({state:'accepted'});
  const q=requests.cooldowns.claimQuery(c);requests.cooldowns.settleQuery(q,{id:42,body:q.body,user:{id:7},created_at:iso(now)});
  now=c.next_action+1;expect(requests.claim(job,o.repo,o.pr,schedule)).toBe(true);
  expect(requests.get(o.repo,o.pr,HEAD)).toMatchObject({state:'delivery_uncertain',attempts:2,mode:'regular'});
 }finally{s.close();}
});
test('check-bound rejection of a plain-text accepted marker is not a global HTTP embargo',()=>{
 const s=new Store(':memory:');new ReviewLoop(s);const requests=new ReviewRequests(s,()=>T),job=s.enqueue('p','i','spec'),other=s.enqueue('q','other','spec'),o=observation();
 const schedule={head:HEAD,signature:'config',blocker:null,incremental:false},marker=reviewRequestMarker(o.repo,o.pr,HEAD);
 try{
  expect(requests.claim(job,o.repo,o.pr,schedule)).toBe(true);requests.settle(o.repo,o.pr,HEAD,'accepted',marker);
  requests.cooldowns.observe(o,requests.receipts(o.repo,o.pr));requests.reconcileThrottle(o.repo,o.pr);
  expect(requests.get(o.repo,o.pr,HEAD)).toMatchObject({state:'rate_limited',evidence:marker});
  expect(requests.claim(other,'pstonesudol/honeysummer',39,{...schedule,head:OTHER})).toBe(true);
  expect(s.db.query('SELECT state FROM coderabbit_request_attempts WHERE repo=? AND pr=?').get(o.repo,o.pr)).toEqual({state:'accepted'});
 }finally{s.close();}
});
test('new heads, duplicate observations and restarts do not reset cycle or query budgets',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-rabbit-cycle-')),path=join(dir,'state.sqlite');let s=new Store(path),now=T;
 try{
  let l=new CodeRabbitCooldowns(s,()=>now,()=>0),o=observation(),c=l.observe(o,[]),q=l.claimQuery(c);l.settleQuery(q,{id:42,body:q.body,user:{id:7},created_at:iso(T)});
  const deadline=c.deadline;now=c.next_action+1;expect(l.reserve(o.repo,o.pr,HEAD)).toBe(true);
  s.close();s=new Store(path);l=new CodeRabbitCooldowns(s,()=>now,()=>0);
  c=l.observe({...o,head:OTHER,observed:now},[]);expect(c).toMatchObject({head:OTHER,attempts:1,deadline,state:'requesting'});
  expect(l.reserve(o.repo,o.pr,OTHER)).toBe(false);expect(l.claimQuery(c)).toBeNull();
  const next=l.observe({...o,head:OTHER,observed:now,checks:[run({id:124,head_sha:OTHER,started_at:iso(now),completed_at:iso(now)})]},[]);
  expect(next).toMatchObject({attempts:1,episode:2,state:'waiting',deadline});expect(next.next_action).toBe(now+120*60000);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('six retry attempts exhaust a durable PR cycle; extension is bound, human-only and retains history',()=>{
 const s=new Store(':memory:');let now=T;const l=new CodeRabbitCooldowns(s,()=>now,()=>0),o=observation();
 try{
  let c=l.observe({...o,checks:[run({output:{title:'Review rate limited',summary:'Retry after 1 minute.'}})]},[]);
  for(let i=0;i<6;i++){
   now=c.next_action+1;expect(l.reserve(o.repo,o.pr,HEAD)).toBe(true);
   now++;c=l.observe({...o,observed:now,checks:[run({id:200+i,started_at:iso(now),completed_at:iso(now),output:{title:'Review rate limited',summary:'Retry after 1 minute.'}})]},[]);
  }
  expect(c.state).toBe('exhausted');expect(l.reason(c)).toContain('extend-review-cycle');expect(l.reserve(o.repo,o.pr,HEAD)).toBe(false);
  const preview=l.extendPreview(o.repo,o.pr);expect(()=>l.extend(o.repo,o.pr,'wrong','human')).toThrow();expect(()=>l.extend(o.repo,o.pr,preview.confirmation,'')).toThrow();
  l.extend(o.repo,o.pr,preview.confirmation,'Operator');expect(l.get(o.repo,o.pr)).toMatchObject({attempts:6,limit_attempts:12,state:'waiting'});
  expect(s.db.query('SELECT count(*) AS n FROM coderabbit_cycle_extensions').get()).toEqual({n:1});
 }finally{s.close();}
});
test('24-hour deadline stops waiting even if provider reset is later; completion defines a later cycle boundary',()=>{
 const s=new Store(':memory:');let now=T;const l=new CodeRabbitCooldowns(s,()=>now,()=>0),o=observation();
 try{
  l.http(o.repo,o.pr,HEAD,1,T+48*60*60000);now+=24*60*60000;
  expect(l.observe({...o,observed:now,checks:[]},[]).state).toBe('exhausted');expect(l.reserve(o.repo,o.pr,HEAD)).toBe(false);
  l.complete(o.repo,o.pr,HEAD);now++;
  const c=l.observe({...o,observed:now,checks:[run({id:999,started_at:iso(now),completed_at:iso(now)})]},[]);
  expect(c).toMatchObject({cycle:2,attempts:0,state:'waiting'});
 }finally{s.close();}
});
test('shared quota requires explicit provider identity evidence; same credentials alone never widen it',()=>{
 const s=new Store(':memory:');let now=T;const l=new CodeRabbitCooldowns(s,()=>now,()=>0),author={id:7,login:'developer'},o=observation();
 try{
  const a=l.observe({...o,author,checks:[],comments:[boundReply(o.repo,'Review rate limited. Developer @developer. Retry after 60 minutes.')]},[]);
  expect(a.scope).toBe('github-user:7');now++;
  const other='pstonesudol/honeysummer',b=l.observe(observation(other,{author,observed:now,checks:[],comments:[boundReply(other,'Review rate limited. Developer @developer. Retry after 120 minutes.',{created_at:iso(now),updated_at:iso(now)})]}),[]);
  expect(l.effectiveRetry(a)).toBe(b.next_action);
  const separate=l.observe({...o,pr:39,observed:now},[]);expect(separate.scope).toBeNull();expect(l.effectiveRetry(separate)).toBe(separate.next_action);
 }finally{s.close();}
});
test('cooldown configuration is bounded and opt-in to preserve existing approved policy bindings',()=>{
 expect(reviewerPolicy(undefined)[0].rateLimit).toBeUndefined();expect(cooldownPolicy({fallback:30*60000}).fallback).toBe(30*60000);
 for(const p of [{buffer:0},{retryLimit:7},{window:25*60*60000},{jitter:0.5},{fallback:121*60000}])expect(()=>cooldownPolicy(p)).toThrow();
 expect(()=>reviewerPolicy([{id:'coderabbit',rateLimit:{retryLimit:7}}])).toThrow();
});
test('changed edited relative guidance falls back, unrelated edits retain timing and absolute resets remain usable',()=>{
 const s=new Store(':memory:');let now=T;const l=new CodeRabbitCooldowns(s,()=>now,()=>0),o=observation();
 try{
  let response=boundReply(o.repo,'Review rate limited. Your next review will be available in 2 minutes.');
  let c=l.observe({...o,checks:[],comments:[response]},[]);expect(c.next_action).toBe(T+7*60000);
  now+=60000;response={...response,updated_at:iso(now),body:response.body.replace('2 minutes','30 minutes')};
  c=l.observe({...o,observed:now,checks:[],comments:[response]},[]);expect(c.reliable).toBe(0);expect(c.next_action).toBe(now+60*60000);
  const fallback=c.next_action;
  for(const note of ['An unrelated note.','Another unrelated note.']){
   now+=60000;response={...response,updated_at:iso(now),body:response.body+'\n'+note};
   c=l.observe({...o,observed:now,checks:[],comments:[response]},[]);expect(c.next_action).toBe(fallback);
  }
  const absolute=boundReply(o.repo,`Review rate limited. Retry at ${iso(now+120*60000)}`,{id:100,created_at:iso(now),updated_at:iso(now+1)});
  const absoluteReset=now+125*60000;
  now++;c=l.observe({...o,observed:now,checks:[],comments:[absolute]},[]);expect(c.reliable).toBe(1);expect(c.next_action).toBe(absoluteReset);
 }finally{s.close();}
});
for(const scenario of ['accepted','uncertain','stale-run','future-run'])test(`new-head authenticated throttle coalesces only a known delivered request: ${scenario}`,()=>{
 const s=new Store(':memory:');new ReviewLoop(s);let now=T;const requests=new ReviewRequests(s,()=>now),job=s.enqueue('p','i','spec'),o=observation();
 const schedule={head:HEAD,signature:'config',blocker:null,incremental:true};
 try{
  expect(requests.claim(job,o.repo,o.pr,schedule)).toBe(true);requests.settle(o.repo,o.pr,HEAD,'accepted',JSON.stringify({id:41}));
  let c=requests.cooldowns.observe(o,requests.receipts(o.repo,o.pr));requests.reconcileThrottle(o.repo,o.pr);
  const deadline=c.deadline,q=requests.cooldowns.claimQuery(c);requests.cooldowns.settleQuery(q,{id:42,body:q.body,user:{id:7},created_at:iso(now)});
  now=c.next_action+1;expect(requests.claim(job,o.repo,o.pr,schedule)).toBe(true);
  if(scenario!=='uncertain')requests.settle(o.repo,o.pr,HEAD,'accepted',JSON.stringify({id:43}));
  const requested=now;now+=1000;
  const pushed={...o,head:OTHER,observed:now,checks:[run({id:124,head_sha:OTHER,started_at:iso(scenario==='stale-run'?requested-10000:scenario==='future-run'?now+60000:now),completed_at:iso(now)})]};
  c=requests.cooldowns.observe(pushed,requests.receipts(o.repo,o.pr));
  expect(c).toMatchObject({head:OTHER,attempts:1,deadline,state:scenario==='accepted'?'waiting':'requesting'});
  if(scenario==='accepted'){
   expect(c.episode).toBe(2);const nextQuery=requests.cooldowns.claimQuery(c);requests.cooldowns.settleQuery(nextQuery,{id:44,body:nextQuery.body,user:{id:7},created_at:iso(now)});
   now=c.next_action+1;expect(requests.claim(job,o.repo,o.pr,{...schedule,head:OTHER})).toBe(true);
   expect(requests.cooldowns.get(o.repo,o.pr)).toMatchObject({attempts:2,deadline});
   expect(requests.get(o.repo,o.pr,HEAD).state).toBe('accepted');
  }else expect(requests.claim(job,o.repo,o.pr,{...schedule,head:OTHER})).toBe(false);
 }finally{s.close();}
});
test('provider inspection hold prevents even reserving an availability query',()=>{
 const s=new Store(':memory:');const loop=new ReviewLoop(s),requests=loop.requests,holder=s.enqueue('p','i','spec');
 try{
  expect(requests.claim(holder,'holder/repo',1,{head:HEAD,signature:'config',blocker:null,incremental:false})).toBe(true);
  const hold=requests.holdForInspection(holder,'holder/repo',1,HEAD),at=Date.now(),o=observation(undefined,{observed:at,checks:[run({completed_at:iso(at)})]});
  const c=requests.cooldowns.observe(o,[]);expect(requests.cooldowns.claimQuery(c)).toBeNull();
  expect(requests.providerHold().id).toBe(hold.id);expect(s.db.query('SELECT count(*) AS n FROM coderabbit_queries').get()).toEqual({n:0});
 }finally{s.close();}
});
test('chat HTTP cooldown is persisted separately without a review attempt or repeat query',()=>{
 const s=new Store(':memory:'),l=new CodeRabbitCooldowns(s,()=>T,()=>0),o=observation();
 try{const c=l.observe(o,[]),q=l.claimQuery(c);l.chatThrottle(q,T+4*60*60000);
  expect(l.effectiveRetry(c)).toBe(T+4*60*60000);expect(l.get(o.repo,o.pr).attempts).toBe(0);expect(l.claimQuery(c)).toBeNull();
 }finally{s.close();}
});
test('availability-query HTTP reset blocks other PR reviews and queries across projects and restarts without charging review attempts',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-query-transport-')),path=join(root,'state.sqlite');let s=new Store(path),now=T;
 try{
  new ReviewLoop(s);let requests=new ReviewRequests(s,()=>now);const job=s.enqueue('p','one','spec'),other=s.enqueue('q','two','spec'),o=observation();
  const first=requests.cooldowns.observe(o,[]),query=requests.cooldowns.claimQuery(first),reset=T+4*60*60000;
  requests.cooldowns.chatThrottle(query,reset);
  const schedule={head:OTHER,signature:'config',blocker:null,incremental:false};
  expect(requests.claim(other,'pstonesudol/honeysummer',39,schedule)).toBe(false);
  expect(s.db.query('SELECT count(*) AS n FROM coderabbit_requests').get()).toEqual({n:0});
  const second=requests.cooldowns.observe(observation('pstonesudol/honeysummer',{pr:39,head:OTHER,checks:[run({id:124,head_sha:OTHER})]}),[]);
  expect(requests.cooldowns.effectiveRetry(second)).toBe(reset);expect(requests.cooldowns.claimQuery(second)).toBeNull();
  s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since,state,reason) VALUES (?,?,?,?,?,?,?,?)').run(other,second.repo,second.pr,'["CI"]','["src/**"]',now,'waiting_for_coderabbit','CodeRabbit rate limited; next retry at '+iso(reset));
  expect(cooldownDue(s,other,now)).toBe(reset);
  // Finishing the query's PR must not clear a transport reset for the token.
  requests.cooldowns.complete(o.repo,o.pr,HEAD);
  expect(requests.cooldowns.get(o.repo,o.pr).attempts).toBe(0);expect(s.get(job).attempts).toBe(0);
  s.close();s=new Store(path);requests=new ReviewRequests(s,()=>now);
  now=reset-1;
  expect(requests.claim(other,'pstonesudol/honeysummer',39,schedule)).toBe(false);
  expect(requests.cooldowns.claimQuery(second)).toBeNull();expect(s.db.query('SELECT count(*) AS n FROM coderabbit_queries').get()).toEqual({n:1});
  expect(requests.cooldowns.get(second.repo,second.pr)).toMatchObject({attempts:0,deadline:second.deadline});
  now=reset+1;const next=requests.cooldowns.claimQuery(second);expect(next).not.toBeNull();
  requests.cooldowns.settleQuery(next,{id:125,body:next.body,user:{id:7},created_at:iso(now)});
  expect(requests.claim(other,'pstonesudol/honeysummer',39,schedule)).toBe(true);
  expect(requests.cooldowns.get(o.repo,o.pr).attempts).toBe(0);expect(s.get(other).attempts).toBe(0);
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});
test('an authenticated already-reviewed refusal blocks futile regular requests in the same cycle',()=>{
 const s=new Store(':memory:');let now=T;const l=new CodeRabbitCooldowns(s,()=>now,()=>0),o=observation();
 try{
  let c=l.observe(o,[]);const q=l.claimQuery(c);l.settleQuery(q,{id:10,body:q.body,user:{id:7},created_at:iso(T)});
  now=c.next_action+1;l.reserve(o.repo,o.pr,HEAD);
  const command={id:50,body:'@coderabbitai review',created_at:iso(now)};now++;
  c=l.observe({...o,observed:now,checks:[],comments:[command,reply(o.repo,'Nothing to review. All commits have already been reviewed.',{created_at:iso(now),updated_at:iso(now)})]},[{head:HEAD,attempts:1,requested:now-1,comment_id:50,state:'accepted'}]);
  expect(c.state).toBe('already_reviewed');expect(l.reserve(o.repo,o.pr,HEAD)).toBe(false);expect(l.reason(c)).toContain('no repeated regular requests');
 }finally{s.close();}
});

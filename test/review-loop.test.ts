import {test,expect,setSystemTime,spyOn} from 'bun:test';
import {readFailure,ReadValidationError} from '../src/provider-read';
import {RecoveryObservation,ObservationDeferred} from '../src/recovery-observation';
import {ObservationLeaseLost} from '../src/observation-fence';
import {decision,ReviewLoop,postCodeRabbitReview} from '../src/review-loop';
import {Store,reviewGate,digest} from '../src/core';
import {ReceiptReconciliation} from '../src/receipt-reconciliation';
import {ConflictRecovery} from '../src/conflict-recovery';
import {BranchSync} from '../src/branch-sync';
import {branchTransport} from '../src/branch-updates';
import {requiredCheckState} from '../src/github';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
import {sendPilotRemediation} from '../src/pilot';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {turnBarrier} from '../src/turn-submission';
import {DEFAULT_REMEDIATION_POLICY} from '../src/remediation';
import {customFixture} from './coderabbit-fixture';
import {ReviewRateLimit} from '../src/coderabbit-scheduling';
import {RECEIPT_FRESHNESS_MS} from '../src/receipt-reconciliation';
import {reviewerPolicy,reviewerApprovals,collectTrustedFeedback,bindReviewerPolicy,BOT_IDENTITIES} from '../src/reviewer-policy';
const pending=()=>({clear:false,reasons:['CodeRabbit absent'],failedChecks:[],findings:[]});
test('missing reviewer approvals stay in CI/review/rate-limit waits; hard obligations still block',()=>{
 const missing='Reviewer coderabbit: explicit current-head approval required';
 const e={...pending(),reasons:[missing],reviewerEvidence:{blockers:[missing],pending:[]}};
 expect(decision({...e,pendingChecks:['CI']},['src/**'],0).state).toBe('waiting_for_ci');
 expect(decision(e,['src/**'],0).state).toBe('waiting_for_coderabbit');
 expect(decision({...e,coderabbitRateLimited:true},['src/**'],0)).toMatchObject({state:'waiting_for_coderabbit',reason:'CodeRabbit rate limited; wait for the provider limit to reset'});
 expect(decision(e,['src/**'],30*60*1000).state).toBe('blocked');
 for(const reason of ['Reviewer human: changes requested (42)','Reviewer human: fresh identity/membership evidence required before clearance'])expect(decision({...e,reviewerEvidence:{blockers:[missing,reason],pending:[]}},['src/**'],0)).toMatchObject({state:'blocked',reason});
});
test('missing/pending review waits then blocks; never becomes success or spends an attempt',()=>{
 expect(decision(pending(),['a'],0).state).toBe('waiting_for_coderabbit');
 expect(decision(pending(),['a'],30*60*1000)).toMatchObject({state:'blocked',send:false});
 expect(decision({...pending(),clear:true},['a'],0).state).toBe('ready_for_human');
});
test('only current actionable findings within ticket file scope are sent to the worker',()=>{
 expect(decision({...pending(),findings:[{path:'a',body:'fix'}]},['a'],0).send).toBe(true);
 expect(decision({...pending(),findings:[{path:'backend/secrets.py',body:'fix'}]},['a'],0)).toMatchObject({state:'blocked',send:false});
 expect(decision({...pending(),failedChecks:[{name:'backend'}]},['a'],0).send).toBe(false);
 expect(decision({...pending(),findings:[{kind:'pr_description',path:null,body:'exact verification commands'}]},['a'],0).send).toBe(true);
});
test('review registration is restart-safe and cannot silently change PR or scope',()=>{
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('p','i','spec'),r=p.reserve(id,'project');
 p.gate(id,'project','session',r.branch,'/worktree');const hash=s.propose(id,'plan');s.approve(id,hash,'human');
 new Lifecycle(s).adoptSupervised(id,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
 const loop=new ReviewLoop(s);loop.register(id,'owner/repo',1,['CI'],['a'],true);
 expect(loop.register(id,'owner/repo',1,['CI'],['a'],true).pr).toBe(1);
 expect(()=>loop.register(id,'owner/repo',2,['CI'],['a'],true)).toThrow();expect(loop.list().length).toBe(1);s.close();
});


test('CI waits are distinct from CodeRabbit waits; no approval is inferred',()=>{
 expect(decision({...pending(),pendingChecks:['CI']},['a'],0).state).toBe('waiting_for_ci');
 expect(decision({...pending(),missingChecks:['CI']},['a'],0).state).toBe('waiting_for_ci');
});

test('full review requests survive lost replies without duplicate comments',async()=>{
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('p','i','spec'),r=p.reserve(id,'project');
 p.gate(id,'project','session',r.branch,'/worktree');const hash=s.propose(id,'plan');s.approve(id,hash,'human');
 new Lifecycle(s).adoptSupervised(id,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
 let calls=0;const loop=new ReviewLoop(s,async()=>{calls++;throw Error('Reply lost');},{readiness:async()=>({head:'sha',descriptionHash:'body',reviewSchedule:{head:'sha',signature:'config',blocker:null,incremental:false}}) as any});loop.configureMetadataChecks('p',[]);loop.register(id,'owner/repo',1,['CI'],['a'],true);
 await expect(loop.requestReview(id,loop.get(id).pr,'sha','body')).rejects.toThrow('lost');
 expect(await loop.requestReview(id,loop.get(id).pr,'sha','body')).toBe(false);expect(calls).toBe(1);
 expect((s.db.query('SELECT state FROM full_review_requests').get() as any).state).toBe('delivery_uncertain');s.close();
});

test('one project service cannot select another project’s PR targets',()=>{
 const s=new Store(':memory:'),p=new Planning(s),loop=new ReviewLoop(s);
 for(const project of ['a','b']){const id=s.enqueue(project,'issue','spec'),r=p.reserve(id,project);p.gate(id,project,project,r.branch,`/${project}`);const hash=s.propose(id,'plan');s.approve(id,hash,'human');new Lifecycle(s).adoptSupervised(id,{id:project,correlation:r.correlation,worktree:`/${project}`,controller:'running'});loop.register(id,'owner/repo',project==='a'?1:2,['CI'],['src/**'],true);}
 expect(loop.list('a').map(t=>t.pr)).toEqual([1]);expect(loop.list('b').map(t=>t.pr)).toEqual([2]);expect(loop.list().length).toBe(2);s.close();
});

function templateFixture(){
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('project','issue','spec'),r=p.reserve(id,'ao');p.gate(id,'ao','session',r.branch,'/worktree');const hash=s.propose(id,'plan');s.approve(id,hash,'human');const l=new Lifecycle(s);l.grantGit(id,hash,['open-pr'],'human');l.adoptSupervised(id,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
 const head='a'.repeat(40),e:any={clear:false,reasons:['PR body structure failed'],head,descriptionHash:'old-body',templateSignature:'old-check',findings:[{kind:'pr_description',source:'github-ci',check:'PR body structure',checkId:1,descriptionHash:'old-body',sha:head}],failedChecks:[{id:1,sha:head,name:'PR body structure'}],pendingChecks:[],missingChecks:[],coderabbitPending:false,coderabbitPresent:true,metadataCheckEvidence:[{name:'PR body structure',checkId:1,sha:head,status:'completed',conclusion:'failure',descriptionHash:'old-body'}]};
 const session:any={receiptObservation:{complete:true,observed:Date.now()},session:{id:'session',branch:r.branch,isTerminated:false,prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',entries:[],turns:[]}};let sends=0,reviews=0;
  const io:any={readBranchSnapshot:async()=>({head,base:'b'.repeat(40),branch:r.branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:true,behind:0}),worktreeIdentity:async()=>({tree:'/worktree',branch:r.branch,head}),readiness:async()=>e,sessionEvidence:async()=>{session.receiptObservation={complete:true,observed:Date.now()};return session;},submit:async(operation:any)=>operation(),spawn:(args:string[])=>{
  sends++;const handle=args[args.indexOf('--client-message-id')+1],turnId=`fix-${sends}`;
  session.transcript.entries.push({clientMessageId:handle,turnId});session.transcript.turns.push({id:turnId,state:'running'});
  return {stdout:new Response('{}').body,stderr:new Response('').body,exited:Promise.resolve(0)};
 }};
 const loop=new ReviewLoop(s,async()=>{reviews++;},{readBranchSnapshot:io.readBranchSnapshot,worktreeIdentity:io.worktreeIdentity,readiness:io.readiness,sessionEvidence:io.sessionEvidence,disableNativeFeedback:async()=>({}),sendPilotRemediation:(...args:any[])=>sendPilotRemediation(...args as Parameters<typeof sendPilotRemediation>,io)} as any);
 e.reviewSchedule={head,signature:'config',blocker:null,incremental:false};
 loop.configureMetadataChecks('project',['PR body structure']);loop.register(id,'owner/repo',1,['CI'],['src/**'],true);
 loop.requests.wait('owner/repo',1,e.reviewSchedule);s.db.query('UPDATE coderabbit_waits SET started=?').run(Date.now()-6*60*1000);
 return {s,id,head,e,session,loop,io,sends:()=>sends,reviews:()=>reviews};
}
test('DEV-95: behind-base maintenance retains an independent incomplete CodeRabbit review',async()=>{
 const f=templateFixture(),blocker='CodeRabbit custom-check failure: pre-merge check table contains an unclassifiable row or missing status; obtain the complete supported bot summary';
 let updates=0,reads=0;
 const update=spyOn(branchTransport,'update').mockImplementation(async()=>{updates++;});
 try{
  new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash!,['inspect','fetch','push-feature','open-pr'],'human');
  f.loop.io.readBranchSnapshot=async()=>({...await f.io.readBranchSnapshot(),behind:1});
  f.e.customCheckBlocker=blocker;f.e.findings=[];f.e.failedChecks=[];f.e.pendingChecks=[];f.e.missingChecks=[];
  f.loop.io.readiness=async()=>{reads++;return f.e;};
  f.loop.record(f.id,{state:'blocked',send:false,head:f.head,reason:blocker});
  expect(await f.loop.tick(f.id,{enabled:true,authorizedBy:'human',maxUpdates:3})).toMatchObject({state:'updating_branch',send:false});
  expect(updates).toBe(1);expect(reads).toBe(1);
  expect(f.loop.get(f.id)).toMatchObject({state:'blocked',reason:blocker});
  expect(f.loop.list()[0].maintenance).toMatchObject({state:'updating_branch',head:f.head});
  // A new loop over the same durable state cannot resend or erase the blocker.
  const restarted=new ReviewLoop(f.s,async()=>{throw Error('No request');},f.loop.io);
  await restarted.tick(f.id,{enabled:true,authorizedBy:'human',maxUpdates:3});
  expect(updates).toBe(1);expect(restarted.get(f.id).reason).toBe(blocker);
 }finally{update.mockRestore();f.s.close();}
});
for(const guard of ['active','conflicts','identity','budget','cooldown'])test(`DEV-95 lifecycle retains ${guard} guard with incomplete review evidence`,async()=>{
 const f=templateFixture(),blocker='CodeRabbit custom-check failure: incomplete supported summary';let updates=0;
 const update=spyOn(branchTransport,'update').mockImplementation(async()=>{updates++;});
 try{
  new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash!,['inspect','fetch','push-feature','open-pr'],'human');
  f.loop.io.readBranchSnapshot=async()=>({...await f.io.readBranchSnapshot(),behind:1,mergeable:guard==='conflicts'?false:true,headRepo:guard==='identity'?'unknown/repo':'owner/repo'});
  f.e.customCheckBlocker=blocker;f.e.findings=[];f.e.failedChecks=[];f.e.pendingChecks=[];f.e.missingChecks=[];
  f.loop.record(f.id,{state:'blocked',send:false,head:f.head,reason:blocker});
  if(guard==='active')f.session.transcript.turns.push({id:'active',state:'running'});
  if(guard==='budget'){
   // Create the existing bounded delivery ledger, not a new maintenance budget.
   const {BranchUpdates}=await import('../src/branch-updates');new BranchUpdates(f.s);
   f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,'c'.repeat(40),'d'.repeat(40),'observed',Date.now(),null);
  }
  if(guard==='cooldown')new RecoveryObservation(f.s).failed(f.id,readFailure('github','review','HTTP 429 rate limit',1).evidence);
  const result=await f.loop.tick(f.id,{enabled:true,authorizedBy:'human',maxUpdates:1});
  expect(result.send).toBe(false);expect(updates).toBe(0);expect(result.state).not.toBe('ready_for_human');
  if(guard!=='identity')expect(f.loop.get(f.id)).toMatchObject({state:'blocked',reason:blocker});
 }finally{update.mockRestore();f.s.close();}
});
test('a stale local head reaches synchronization before any review remediation dispatch',async()=>{
 const f=templateFixture();const sync=spyOn(BranchSync.prototype,'ensure').mockResolvedValue({state:'waiting_for_worker',send:false,head:f.head,reason:'Synchronization awaits quiescence'});
 try{
  f.loop.io.worktreeIdentity=async()=>({tree:'/worktree',branch:f.session.session.branch,head:'c'.repeat(40)});
  expect(await f.loop.tick(f.id,undefined,DEFAULT_REMEDIATION_POLICY,undefined,{})).toMatchObject({state:'waiting_for_worker',send:false});
  expect(sync).toHaveBeenCalledTimes(1);expect(f.sends()).toBe(0);expect(f.reviews()).toBe(0);
 }finally{sync.mockRestore();f.s.close();}
});
test('the final remediation submit gate rejects a stale local head without spending an attempt',async()=>{
 const f=templateFixture();try{
  f.io.worktreeIdentity=async()=>({tree:'/worktree',branch:f.session.session.branch,head:'c'.repeat(40)});
  await expect(sendPilotRemediation(f.s,f.id,f.head,JSON.stringify(f.e.findings),'owner/repo',1,['CI'],DEFAULT_REMEDIATION_POLICY,['PR body structure'],f.io)).rejects.toThrow('Worktree and remote PR HEAD differ');
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.s.close();}
});
test('resolved passing CI duplicates reach human review without requests or remediation',async()=>{
 const f=templateFixture();try{
  f.loop.configureMetadataChecks('project',[]);
  const check=(id:number,conclusion:string)=>({id,name:'CI',head_sha:f.head,app:{slug:'github-actions'},status:'completed',conclusion,started_at:'2026-11-07T14:45:00Z',completed_at:`2026-11-07T14:45:0${id}Z`});
  const raw=[check(1,'cancelled'),check(2,'success'),check(3,'success'),{...check(4,'success'),name:'CodeRabbit',app:{slug:'coderabbitai'}}];
  const gate=reviewGate({head:f.head,observedHead:f.head,required:['CI'],checks:raw.map(c=>({...c,sha:c.head_sha,app:c.app.slug})),review:{sha:f.head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true});
  Object.assign(f.e,gate,requiredCheckState(raw,f.head,['CI']),{findings:[]});
  expect(gate.clear).toBe(true);
  expect(await f.loop.tick(f.id)).toMatchObject({state:'ready_for_human',send:false,mergeEnabled:false});
  expect(f.reviews()).toBe(0);expect(f.sends()).toBe(0);
  expect(f.s.db.query('SELECT * FROM full_review_requests').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{f.s.close();}
});
for(const conflict of [false,true])for(const state of ['unknown','running'])test(`${conflict?'conflict recovery':'ordinary remediation'} ${state} receipt points to its supported operator interface`,async()=>{
 const f=templateFixture();try{
  const j=f.s.get(f.id),client=conflict?'conflict-message':`adlc-fix-${f.id.slice(0,12)}-1`;
  f.s.db.query("INSERT INTO remediation VALUES (?,?,?,1,'delivery_uncertain')").run(f.id,f.head,'finding');
  if(conflict){
   new ConflictRecovery(f.s).install();
   // A settled recovery may still retain a delivery requiring reconciliation.
   f.s.db.query('INSERT INTO conflict_recoveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('recovery',f.id,j.plan_hash,'/worktree','session','owner/repo',1,f.session.session.branch,'main',f.head,'b'.repeat(40),'{}','completed',client,1,'{}',null,Date.now());
  }
  const ledger=new ReceiptReconciliation(f.s);
  ledger.reserve({job:f.id,plan:j.plan_hash,spec:digest(j.spec),session:'session',client,attempt:'remediation:1'});
  if(state==='running'){
   f.session.transcript.entries=[{clientMessageId:client,turnId:'turn'}];
   f.session.transcript.turns=[{id:'turn',state:'running'}];
  }
  const result=await f.loop.tick(f.id);
  expect(result).toMatchObject({state:state==='unknown'?'needs_reconciliation':'waiting_for_worker',send:false,delivery:{state,code:state==='unknown'?'receipt_absent':'turn_running'}});
  expect(result.reason).toContain(conflict?`adlc recovery-preview ${f.id} CONFIG`:`adlc receipt-reconcile ${f.id} CONFIG 1`);
  expect(result.reason).not.toContain(conflict?'receipt-reconcile':'recovery-preview');
  expect(f.s.db.query('SELECT state FROM remediation WHERE job=?').get(f.id)).toEqual({state:'delivery_uncertain'});
  expect(f.sends()).toBe(0);expect(f.reviews()).toBe(0);
 }finally{f.s.close();}
});
// Inject an attested collector response for success-path tests. The production
// GitHub collector currently cannot supply this and returns a null body hash.
function bodyEvidence(e:any,names=['PR body structure']){return names.map((name,i)=>({name,checkId:i+2,sha:e.head,status:'completed',conclusion:'success',descriptionHash:e.descriptionHash}));}
test('missing current-head review gets one request after grace, retries only confirmed throttling, then blocks specifically',async()=>{
 const f=templateFixture();try{
  Object.assign(f.e,{findings:[],failedChecks:[],reasons:['Explicit latest-SHA CodeRabbit approval missing'],coderabbitPresent:false});f.loop.configureMetadataChecks('project',[]);
  f.s.db.query('UPDATE coderabbit_waits SET started=?').run(Date.now());
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.reviews()).toBe(0);
  f.s.db.query('UPDATE coderabbit_waits SET started=?').run(Date.now()-6*60*1000);
  let calls=0;f.loop.postReview=async()=>{if(++calls===1)throw new ReviewRateLimit(Date.now()+60000);};
  await f.loop.tick(f.id);await f.loop.tick(f.id);expect(calls).toBe(1);
  f.s.db.query('UPDATE coderabbit_requests SET next_attempt=0,requested=?').run(Date.now()-60001);await Promise.all([f.loop.tick(f.id),f.loop.tick(f.id)]);expect(calls).toBe(2);
  await f.loop.tick(f.id);expect(calls).toBe(2);
  f.s.db.query('UPDATE coderabbit_requests SET requested=?').run(Date.now()-31*60*1000);
  const escalated=await f.loop.tick(f.id);
  expect(escalated).toMatchObject({state:'blocked',send:false});
  expect(escalated.reason).toContain(`head ${'a'.repeat(40)}`);
  expect(escalated.reason).toContain('requested mode regular');
  expect(escalated.reason).toContain('never automatic escalation');
  expect(escalated.reason).not.toContain('ambiguous');
 }finally{f.s.close();}
});
for(const extra of ['missing-coderabbit','required-human','advisory-trust-failure'])test(`automatic requests distinguish missing approval from other reviewer obligations: ${extra}`,async()=>{
 const f=templateFixture();try{
  const now=Date.now(),p=reviewerPolicy(undefined),trust=p.map(r=>({reviewer:r.id,observed:now,ids:[r.identity!.userId],blocker:null}));
  const obligations=reviewerApprovals(p,trust,[],f.head,[],now);
  const blockers=[...obligations.blockers,...(extra==='required-human'?['Reviewer human: explicit current-head approval required']:extra==='advisory-trust-failure'?['Reviewer codex: fresh identity/membership evidence unavailable or mismatched; no trust granted']:[])];
  Object.assign(f.e,{findings:[],failedChecks:[],reasons:['Explicit latest-SHA CodeRabbit approval missing',...blockers],reviewerEvidence:{blockers,pending:[]},coderabbitPresent:false});
  f.loop.configureMetadataChecks('project',[]);
  const result=await f.loop.tick(f.id);
  expect(f.reviews()).toBe(extra==='missing-coderabbit'?1:0);
  expect(result.send).toBe(false);expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
function pr30Schedule(head:string){
 return {head,signature:`pr30-${head}`,blocker:null,incremental:false,evidence:{classification:'stale-submitted-review',recoverable:true,review:{id:5810360982,state:'CHANGES_REQUESTED',commit:'b'.repeat(40),submittedAt:Date.now()-10000,stale:true},check:{id:128433345849,name:'CodeRabbit',status:'completed',conclusion:'skipped',startedAt:Date.now()-1000,completedAt:Date.now()},runs:1,reviewedCommits:1,pauseThreshold:2,incremental:false}} as any;
}
function pr30LoopFixture(){
 const f=templateFixture();
 f.loop.configureMetadataChecks('project',[]);
 const schedule=pr30Schedule(f.head);f.e.reviewSchedule=schedule;
 Object.assign(f.e,{findings:[],failedChecks:[],pendingChecks:[],missingChecks:[],coderabbitPending:false,coderabbitPresent:true,customCheckBlocker:null,clear:false,reasons:['CodeRabbit check not clear','Explicit latest-SHA CodeRabbit approval missing'],botReviewSubmittedAt:Date.now()-10000});
 f.loop.requests.wait('owner/repo',1,schedule);f.s.db.query('UPDATE coderabbit_waits SET started=?').run(Date.now()-6*60*1000);
 return f;
}
for(const current of [false,true])test(`CodeRabbit ${current?'current':'stale'} change request preserves bounded scheduling guard`,async()=>{
 const f=pr30LoopFixture();try{
  const blockers=['Reviewer coderabbit: explicit current-head approval required','Reviewer coderabbit: changes requested (5810360982)'];
  f.e.reasons.push(...blockers);
  f.e.reviewerEvidence={blockers,pending:[]};
  if(current){f.e.reviewSchedule.evidence.review.stale=false;f.e.reviewSchedule.evidence.review.commit=f.head;f.e.reviewSchedule.evidence.recoverable=false;}
  const result=await f.loop.tick(f.id);
  if(current){expect(result).toMatchObject({state:'blocked',send:false});expect(f.loop.get(f.id).state).toBe('blocked');}
  else expect(result).toMatchObject({state:'waiting_for_coderabbit',send:false});
  expect(f.reviews()).toBe(current?0:1);expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
for(const failure of [false,true])test(`full review mode is accurate in request audit and ${failure?'uncertain':'accepted'} reasons`,async()=>{
 const f=pr30LoopFixture();try{
  const config=[{id:'coderabbit',reviewMode:'full'}];bindReviewerPolicy(f.s,f.id,config);
  let mode:string|undefined,reservation='';f.loop.postReview=async(_repo,_pr,_marker,_spawn,requestedMode)=>{mode=requestedMode;reservation=f.loop.get(f.id).reason;if(failure)throw Error('lost reply');};
  if(failure){await expect(f.loop.tick(f.id,undefined,DEFAULT_REMEDIATION_POLICY,undefined,{reviewers:config})).rejects.toThrow('lost reply');expect(f.loop.get(f.id).reason).toContain('full review request');}
  else{expect((await f.loop.tick(f.id,undefined,DEFAULT_REMEDIATION_POLICY,undefined,{reviewers:config})).reason).toContain('Full CodeRabbit review requested');const event=f.s.db.query("SELECT detail FROM events WHERE job=? AND kind='coderabbit_review_requested'").get(f.id) as any;expect(JSON.parse(event.detail).mode).toBe('full');}
  expect(mode).toBe('full');expect(reservation).toContain('Full review request');
 }finally{f.s.close();}
});
test('PR #30 shape requests one fresh review, survives concurrent ticks and a restart without duplication',async()=>{
 const f=pr30LoopFixture();try{
  const first=await f.loop.tick(f.id);
  expect(first).toMatchObject({state:'waiting_for_coderabbit',send:false});
  expect(first.reason).not.toContain('ambiguous');expect(f.reviews()).toBe(1);
  expect(f.s.db.query('SELECT attempts,state FROM coderabbit_requests').get()).toEqual({attempts:1,state:'accepted'});
  await Promise.all([f.loop.tick(f.id),f.loop.tick(f.id)]);await f.loop.tick(f.id);
  expect(f.reviews()).toBe(1);
  expect(f.s.db.query('SELECT attempts,state FROM coderabbit_requests').get()).toEqual({attempts:1,state:'accepted'});
  // A restarted loop reads the same durable accepted receipt and never reposts.
  const restarted=new ReviewLoop(f.s,async()=>{throw Error('must not repost');},f.loop.io as any);
  restarted.configureMetadataChecks('project',[]);restarted.register(f.id,'owner/repo',1,['CI'],['src/**'],true);
  expect((await restarted.tick(f.id)).state).toBe('waiting_for_coderabbit');
  expect(f.reviews()).toBe(1);
 }finally{f.s.close();}
});
test('a skipped or neutral current-head check never clears the gate',()=>{
 for(const conclusion of ['skipped','neutral'])expect(reviewGate({head:'a'.repeat(40),observedHead:'a'.repeat(40),required:['CI'],checks:[{name:'CodeRabbit',sha:'a'.repeat(40),app:'coderabbitai',status:'completed',conclusion},{name:'CI',sha:'a'.repeat(40),app:'github-actions',status:'completed',conclusion:'success'}],review:{sha:'a'.repeat(40),author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true}).clear).toBe(false);
});
test('a provider rate limit is reported with exact evidence and is not requested blindly',async()=>{
 const f=pr30LoopFixture();try{
  const evidence=(f.e.reviewSchedule as any).evidence;evidence.classification='rate-limited';evidence.recoverable=true;
  const result=await f.loop.tick(f.id);
  expect(result).toMatchObject({state:'waiting_for_coderabbit',send:false});expect(f.reviews()).toBe(0);
  expect(result.reason).toContain(`head ${f.head}`);expect(result.reason).toContain('check 128433345849');
  expect(result.reason).toContain('provider is rate limiting');expect(result.reason).not.toContain('ambiguous');
  f.s.db.query('UPDATE coderabbit_waits SET started=?').run(Date.now()-31*60*1000);
  const bounded=await f.loop.tick(f.id);
  expect(bounded).toMatchObject({state:'blocked',send:false});expect(bounded.reason).toContain('provider is rate limiting');
 }finally{f.s.close();}
});
test('a current CHANGES_REQUESTED review never spends a fresh request',async()=>{
 const f=pr30LoopFixture();try{
  const evidence=(f.e.reviewSchedule as any).evidence;
  evidence.classification='current-review';evidence.recoverable=false;evidence.review={id:10,state:'CHANGES_REQUESTED',commit:f.head,submittedAt:Date.now()-1000,stale:false};
  const result=await f.loop.tick(f.id);
  expect(result).toMatchObject({state:'waiting_for_coderabbit',send:false});expect(f.reviews()).toBe(0);
  expect(result.reason).not.toContain('identity, head, configuration');
 }finally{f.s.close();}
});
test('an uncertain PR #30 request is reconciled before any retry',async()=>{
 const f=pr30LoopFixture();try{
  let posts=0,marker='';f.loop.postReview=async(_repo,_pr,value)=>{posts++;marker=value??'';throw Error('reply lost');};
  await expect(f.loop.tick(f.id)).rejects.toThrow('reply lost');
  expect(f.loop.get(f.id).state).toBe('needs_reconciliation');
  expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');
  expect(posts).toBe(1);
  f.e.requestComments=[{id:42,author:'operator',body:`@coderabbitai review\n\n${marker}`,created:new Date(Date.now()+1000).toISOString()}];
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
  expect(posts).toBe(1);
 }finally{f.s.close();}
});
test('automatic incremental mode waits without manual requests and configuration drift blocks even clear evidence',async()=>{
 const f=templateFixture();try{
  Object.assign(f.e,{findings:[],failedChecks:[],reasons:['CodeRabbit absent']});f.loop.configureMetadataChecks('project',[]);f.e.reviewSchedule.incremental=true;
  await f.loop.tick(f.id);expect(f.reviews()).toBe(0);
  f.e.clear=true;f.e.reviewSchedule.blocker='CodeRabbit review unavailable: head/base policy differs';expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.reviews()).toBe(0);
 }finally{f.s.close();}
});
test('configuration revalidation prevents posting after policy changes',async()=>{
 const f=templateFixture();try{
  Object.assign(f.e,{findings:[],failedChecks:[],reasons:['CodeRabbit absent']});f.loop.configureMetadataChecks('project',[]);
  const expected={...f.e,reviewSchedule:{...f.e.reviewSchedule}};f.e.reviewSchedule.signature='changed';
  expect(await f.loop.requestReview(f.id,1,f.head,f.e.descriptionHash,expected)).toBe(false);expect(f.reviews()).toBe(0);expect(f.loop.get(f.id).state).toBe('blocked');
 }finally{f.s.close();}
});
test('matching marked comment reconciles uncertain request without replay or inferring approval',async()=>{
 const f=templateFixture();try{
  Object.assign(f.e,{findings:[],failedChecks:[],reasons:['CodeRabbit absent']});f.loop.configureMetadataChecks('project',[]);
  let marker='',posts=0;f.loop.postReview=async(_repo,_pr,value)=>{posts++;marker=value??'';throw Error('lost');};
  await expect(f.loop.tick(f.id)).rejects.toThrow('lost');
  f.e.requestComments=[{id:42,author:'operator',body:`@coderabbitai review\n\n${marker}`,created:new Date(Date.now()+1000).toISOString()}];
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(posts).toBe(1);
  expect(f.loop.requests.get('owner/repo',1,f.head).state).toBe('accepted');expect(f.e.clear).toBe(false);
 }finally{f.s.close();}
});
test('new regular receipts reject a full-command match, while pre-mode uncertain full receipts reconcile without replay',async()=>{
 for(const legacy of [false,true]){
  const f=pr30LoopFixture();try{
   let marker='',posts=0;f.loop.postReview=async(_repo,_pr,value)=>{marker=value??'';posts++;throw Error('lost');};
   await expect(f.loop.tick(f.id)).rejects.toThrow('lost');
   if(legacy){
    // Simulate an old database that sent full review before modes existed.
    f.s.db.exec('ALTER TABLE coderabbit_requests DROP COLUMN mode; ALTER TABLE coderabbit_request_attempts DROP COLUMN mode');
    f.loop=new ReviewLoop(f.s,f.loop.postReview,f.loop.io);
   }
   const comment=(command:string)=>[{id:42,author:'operator',body:`@coderabbitai ${command}\n\n${marker}`,created:new Date(Date.now()+1000).toISOString()}];
   f.e.requestComments=comment(legacy?'review':'full review');
   expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');
   f.e.requestComments=comment(legacy?'full review':'review');
   expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
   expect(f.loop.requests.get('owner/repo',1,f.head)).toMatchObject({mode:legacy?'full':'regular',state:'accepted',attempts:1});
   expect(f.loop.list()[0].reviewRequest.mode).toBe(legacy?'full':'regular');
   expect(posts).toBe(1);expect(f.e.clear).toBe(false);
  }finally{f.s.close();}
 }
});
test('code and metadata remediation publish one regular command only after the batch completes',async()=>{
 for(const metadata of [false,true]){
  const f=templateFixture();try{
   if(!metadata){
    f.loop.configureMetadataChecks('project',[]);
    new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['commit','push-feature'],'human');
    f.e.findings=[{path:'src/one.ts',body:'fix one',sha:f.head},{path:'src/two.ts',body:'fix two',sha:f.head}];f.e.failedChecks=[];
   }
   const commands:string[][]=[];
   const spawn:any=(args:string[])=>{commands.push(args);return {stdout:new Response('{}').body,stderr:new Response('').body,exited:Promise.resolve(0)};};
   f.loop.postReview=async(repo,pr,marker)=>postCodeRabbitReview(repo,pr,marker,spawn);
   expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');
   await f.loop.tick(f.id);expect(commands).toHaveLength(0);expect(f.sends()).toBe(1);
   f.session.transcript.turns[0].state='completed';
   if(metadata)f.e.descriptionHash='batch-description';
   else{
    f.e.head='c'.repeat(40);f.e.reviewSchedule={...f.e.reviewSchedule,head:f.e.head,signature:'batch-completed'};
    f.loop.io.readBranchSnapshot=async()=>({...await f.io.readBranchSnapshot(),head:f.e.head});
    f.loop.io.worktreeIdentity=async()=>({...await f.io.worktreeIdentity(),head:f.e.head});
    f.loop.requests.wait('owner/repo',1,f.e.reviewSchedule);f.s.db.query('UPDATE coderabbit_waits SET started=?').run(Date.now()-6*60*1000);
   }
   Object.assign(f.e,{findings:[],failedChecks:[],reasons:['Explicit latest-SHA CodeRabbit approval missing'],metadataCheckEvidence:bodyEvidence(f.e)});
   expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
   await Promise.all([f.loop.tick(f.id),f.loop.tick(f.id)]);
   expect(commands).toHaveLength(1);
   expect(commands[0].find(a=>a.startsWith('body='))).toStartWith('body=@coderabbitai review\n\n<!-- adlc-coderabbit-request:');
   expect(f.loop.requests.get('owner/repo',1,f.e.head)).toMatchObject({mode:'regular',attempts:1,state:'accepted'});
   expect(f.e.clear).toBe(false);
  }finally{f.s.close();}
 }
});
test('accepted legacy body receipts consume the head budget across description changes',async()=>{
 const f=pr30LoopFixture();try{
  f.s.db.query('INSERT INTO full_review_requests VALUES (?,?,?,?,?,?)').run(f.id,1,f.head,'earlier-body','accepted',Date.now());
  expect(await f.loop.requestReview(f.id,1,f.head,f.e.descriptionHash)).toBe(false);
  expect(f.reviews()).toBe(0);expect(f.loop.requests.get('owner/repo',1,f.head)).toBeNull();
 }finally{f.s.close();}
});
function customLoopFixture(){
 const f=templateFixture(),custom=customFixture();
 f.loop.configureMetadataChecks('project',[]);
 Object.assign(f.e,{...custom.evidence(),descriptionVersion:'version-original',descriptionHash:custom.evidence().findings[0].descriptionHash,failedChecks:[],reasons:['Explicit latest-SHA CodeRabbit approval missing'],coderabbitBodyReviewed:true});
 f.loop.setVerification(f.id,{version:1,mode:'host',steps:[{cwd:'.',argv:['bun','test']}]});
 return f;
}
test('custom Verification Evidence goes to the existing worker once, uses configured checks and gates the edited description',async()=>{
 const f=customLoopFixture();try{
  let prompt='';const spawn=f.io.spawn;f.io.spawn=(args:string[])=>{prompt=args[args.indexOf('--message')+1];return spawn(args);};
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});
  expect(prompt).toContain('current-head CI');expect(prompt).toContain('["bun","test"]');expect(prompt).toContain('working directory');expect(prompt).toContain('ADLC_WORKER_STATUS');expect(prompt).toContain('Do not modify application files');
  await f.loop.tick(f.id);expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
  f.session.transcript.turns[0].state='completed';Object.assign(f.e,{descriptionHash:'edited-body',findings:[],coderabbitBodyReviewed:false,customCheckBlocker:'CodeRabbit custom-check failure: description changed outside the run'});
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
  await Promise.all([f.loop.tick(f.id),f.loop.tick(f.id)]);expect(f.reviews()).toBe(1);expect(f.sends()).toBe(1);
  // Same-head approval alone cannot clear a new body. These are mocked collector
  // results, not a fabricated production CI attestation.
  Object.assign(f.e,{clear:true,customCheckBlocker:null,botReviewSubmittedAt:Date.now()+10000});
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
  f.e.coderabbitBodyReviewed=true;expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
  expect(f.reviews()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
 }finally{f.s.close();}
});
test('a custom-check blocker without an obligation or wait baseline requests a fresh review',async()=>{
 const f=customLoopFixture();try{
  const reason='CodeRabbit custom-check failure: description changed after the bot review';
  Object.assign(f.e,{descriptionHash:'edited-before-remediation',findings:[],coderabbitBodyReviewed:false,customCheckBlocker:reason,reasons:[reason],botReviewSubmittedAt:Date.now()-10000});
  expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_coderabbit',send:false,reason:'Regular CodeRabbit review requested for current commit and description'});
  expect(f.reviews()).toBe(1);expect(f.sends()).toBe(0);
  expect(f.s.db.query('SELECT * FROM full_review_requests WHERE job=?').all(f.id)).toHaveLength(1);
  // A poll before the bot starts must not publish the pre-request blocker.
  const pending=await f.loop.tick(f.id);
  expect(pending.state).toBe('waiting_for_coderabbit');expect(pending.reason.startsWith('CodeRabbit custom-check')).toBe(false);
  expect(f.reviews()).toBe(1);expect(f.sends()).toBe(0);
  f.e.botReviewSubmittedAt=Date.now()+10000;
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason});
 }finally{f.s.close();}
});
test('a fresh custom-check blocker on the first tick after an edit does not request another review',async()=>{
 const f=customLoopFixture();try{
  await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';
  const reason='CodeRabbit custom-check failure: pre-merge row is unclassifiable';
  Object.assign(f.e,{descriptionHash:'edited-body',findings:[],coderabbitBodyReviewed:false,customCheckBlocker:reason,reasons:[reason],botReviewSubmittedAt:Date.now()+10000});
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason});
  expect(f.reviews()).toBe(0);expect(f.sends()).toBe(1);
  expect(f.s.db.query('SELECT * FROM full_review_requests WHERE job=?').all(f.id)).toHaveLength(0);
 }finally{f.s.close();}
});
test('fresh custom-check blockers retain their reason after a description edit; stale and pending reviews wait',async()=>{
 const f=customLoopFixture();try{
  await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';
  const reason='CodeRabbit custom-check failure: pre-merge row is unclassifiable';
  Object.assign(f.e,{descriptionHash:'edited-body',findings:[],coderabbitBodyReviewed:false,customCheckBlocker:reason,botReviewSubmittedAt:0});
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.reviews()).toBe(1);
  Object.assign(f.e,{botReviewSubmittedAt:Date.now()+10000,coderabbitPending:true});
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
  f.e.coderabbitPending=false;
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason});
  expect(f.reviews()).toBe(1);expect(f.sends()).toBe(1);
 }finally{f.s.close();}
});
test('custom finding is revalidated at dispatch; edits cannot spend an attempt or send stale instructions',async()=>{
 const f=customLoopFixture();try{
  let reads=0;f.io.readiness=async()=>{if(++reads===2)f.e.findings=[{...f.e.findings[0],evidenceHash:'changed'}];return f.e;};
  await expect(f.loop.tick(f.id)).rejects.toThrow('Custom-check evidence');expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.s.close();}
});
test('custom finding is rejected at dispatch when the description changes after the poll',async()=>{
 const f=customLoopFixture();try{
  let reads=0;f.io.readiness=async()=>{if(++reads===2)f.e.descriptionHash='edited-before-dispatch';return f.e;};
  await expect(f.loop.tick(f.id)).rejects.toThrow('Custom-check evidence');expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
  expect(f.s.db.query('SELECT * FROM custom_description_obligations').all()).toEqual([]);
 }finally{f.s.close();}
});
test('receipt-sourced failure is blocked while an unrecovered continuation exists',async()=>{
 const f=templateFixture();try{
  f.s.db.exec('CREATE TABLE IF NOT EXISTS worker_outcomes(job TEXT PRIMARY KEY,plan_hash TEXT,session_id TEXT,outcome TEXT,reason TEXT,questions TEXT,dependencies TEXT,source TEXT,confidence TEXT,first_observed INTEGER,grace_deadline INTEGER,observed INTEGER,discovery TEXT); CREATE TABLE IF NOT EXISTS continuations(id INTEGER PRIMARY KEY,job TEXT,plan_hash TEXT,state TEXT)');
  const hash=f.s.get(f.id).plan_hash;
  f.s.db.query('INSERT INTO continuations VALUES (?,?,?,?)').run(1,f.id,hash,'failed');
  f.s.db.query('INSERT INTO worker_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.id,hash,'session','failed','Continuation failed','[]','[]','receipt','high',Date.now(),null,Date.now(),null);
  expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(f.sends()).toBe(0);
  f.s.db.query("UPDATE continuations SET state='recovered' WHERE job=?").run(f.id);
  expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');expect(f.sends()).toBe(1);
 }finally{f.s.close();}
});
test('durable failed continuation blocks delivery-evidence failures; stale outcomes do not outlive recovery',async()=>{
 const f=templateFixture();try{
  f.s.db.exec('CREATE TABLE IF NOT EXISTS worker_outcomes(job TEXT PRIMARY KEY,plan_hash TEXT,session_id TEXT,outcome TEXT,reason TEXT,questions TEXT,dependencies TEXT,source TEXT,confidence TEXT,first_observed INTEGER,grace_deadline INTEGER,observed INTEGER,discovery TEXT); CREATE TABLE IF NOT EXISTS continuations(id INTEGER PRIMARY KEY,job TEXT,plan_hash TEXT,state TEXT)');
  const hash=f.s.get(f.id).plan_hash;
  f.s.db.query('INSERT INTO continuations VALUES (?,?,?,?)').run(1,f.id,hash,'failed');
  f.s.db.query('INSERT INTO worker_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.id,hash,'session','failed','Delivery evidence unavailable','[]','[]','delivery-evidence','high',Date.now(),null,Date.now(),null);
  expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(f.sends()).toBe(0);
  f.s.db.query("UPDATE continuations SET state='recovered' WHERE job=?").run(f.id);
  f.s.db.query("UPDATE worker_outcomes SET source='continuation' WHERE job=?").run(f.id);
  expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');expect(f.sends()).toBe(1);
 }finally{f.s.close();}
});
test('failed continuation outcome blocks review dispatch until durable recovery settles it',async()=>{
 const f=templateFixture();try{
  f.s.db.exec('CREATE TABLE IF NOT EXISTS worker_outcomes(job TEXT PRIMARY KEY,plan_hash TEXT,session_id TEXT,outcome TEXT,reason TEXT,questions TEXT,dependencies TEXT,source TEXT,confidence TEXT,first_observed INTEGER,grace_deadline INTEGER,observed INTEGER,discovery TEXT); CREATE TABLE IF NOT EXISTS continuations(id INTEGER PRIMARY KEY,job TEXT,plan_hash TEXT,state TEXT)');
  const j=f.s.get(f.id),hash=j.plan_hash;
  f.s.db.query('INSERT INTO continuations VALUES (?,?,?,?)').run(1,f.id,hash,'failed');
  f.s.db.query('INSERT INTO worker_outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.id,hash,'session','failed','Continuation failed','[]','[]','continuation','high',Date.now(),null,Date.now(),null);
  expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(f.sends()).toBe(0);
  f.s.db.query("UPDATE continuations SET state='recovered' WHERE job=?").run(f.id);
  expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');expect(f.sends()).toBe(1);
 }finally{f.s.close();}
});
test('custom verification runtime prerequisites are requested through the existing worker, not guessed',async()=>{
 const f=customLoopFixture();try{
  f.loop.setVerification(f.id,{version:1,mode:'container',steps:[{cwd:'src',argv:['node','--test']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['src']}});
  let prompt='';const spawn=f.io.spawn;f.io.spawn=(args:string[])=>{prompt=args[args.indexOf('--message')+1];return spawn(args);};
  expect((await f.loop.tick(f.id)).send).toBe(true);expect(prompt).toContain('STOP before container verification');expect(prompt).toContain('ADLC_DISCOVERY');expect(prompt).toContain('never guess a --runtime path');
 }finally{f.s.close();}
});
test('custom description review reservation survives lost receipts and subsequent description versions',async()=>{
 const f=customLoopFixture();try{
  await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';
  Object.assign(f.e,{descriptionHash:'edited',descriptionVersion:'edit-2',findings:[],coderabbitBodyReviewed:false});
  let requests=0;f.loop.postReview=async()=>{requests++;throw Error('lost reply');};
  await expect(f.loop.tick(f.id)).rejects.toThrow('lost reply');
  f.e.descriptionVersion='edit-3';expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');
  expect(requests).toBe(1);expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
 }finally{f.s.close();}
});
test('a fresh custom failure after an edit uses the same durable attempt ceiling',async()=>{
 const f=customLoopFixture();try{
  const policy={...DEFAULT_REMEDIATION_POLICY,maxAttempts:1};
  await f.loop.tick(f.id,undefined,policy);f.session.transcript.turns[0].state='completed';
  Object.assign(f.e,{descriptionHash:'edited',descriptionVersion:'edit-2',findings:[{...f.e.findings[0],descriptionHash:'edited',evidenceHash:'fresh-review'}]});
  expect(await f.loop.tick(f.id,undefined,policy)).toMatchObject({state:'blocked',send:false});
  expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
 }finally{f.s.close();}
});
test('second branch read failure invalidates stale readiness and enters durable read backoff',async()=>{
 const f=templateFixture();try{
  f.s.db.query("UPDATE review_targets SET state='ready_for_human' WHERE job=?").run(f.id);
  let reads=0;const original=f.loop.io.readBranchSnapshot;
  f.loop.io.readBranchSnapshot=async(...args)=>{if(++reads===2)throw Error('provider unavailable');return original(...args);};
  const config={conflictRecovery:{enabled:true}};
  expect((await f.loop.tick(f.id,undefined,undefined,undefined,config)).state).toBe('blocked');
  expect((f.loop.get(f.id)).state).toBe('blocked');
  await f.loop.tick(f.id,undefined,undefined,undefined,config);expect(reads).toBe(2);expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.s.close();}
});
test('closed PR readiness validation remains actionable without a read failure budget',async()=>{
 const f=templateFixture();try{
 f.loop.io.readiness=async()=>{throw new ReadValidationError();};
 for(let n=0;n<2;n++){
 expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason:'PR is not open; inspect PR state before further review.'});
 expect(new RecoveryObservation(f.s).status(f.id)).toBeNull();expect(f.sends()).toBe(0);
 }
 }finally{f.s.close();}
});
test('later read deferrals, including wrapped ancestry errors, remain waiting without failures',async()=>{
 for(const stage of ['snapshot','ensure','readiness','accepted']){
 const f=templateFixture();const original=RecoveryObservation.prototype.read;
 // Identify the intended call site from the read callback itself; a provider-only
 // or call-count signal cannot distinguish these GitHub reads.
 const target:{[stage:string]:[string,number]}={snapshot:['readBranchSnapshot',2],ensure:['readBranchSnapshot',2],readiness:['readiness',1],accepted:['contains',1]};
 const [kind,wanted]=target[stage],seen:Record<string,number>={};
 const spy=spyOn(RecoveryObservation.prototype,'read').mockImplementation(async function(job,provider,read:any){
 const source=String(read),at=source.includes('readiness')?'readiness':source.includes('contains')?'contains':source.includes('sessionEvidence')?'sessionEvidence':'readBranchSnapshot';
 seen[at]=(seen[at]??0)+1;
 if(at===kind&&seen[at]===wanted)throw new ObservationDeferred(Date.now()+1000);
 return original.call(this,job,provider,read);
 });
 try{
 if(stage==='accepted'){
 const {BranchUpdates}=await import('../src/branch-updates');new BranchUpdates(f.s);
 f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,'c'.repeat(40),'b'.repeat(40),'accepted',1,null);
 const snapshot=f.loop.io.readBranchSnapshot;f.loop.io.readBranchSnapshot=async(...args)=>({...await snapshot(...args),behind:1,mergeable:false});
 f.loop.io.contains=async()=>{throw Error('Unexpected ancestry provider read');};
 }
 const config=stage==='snapshot'||stage==='accepted'?{conflictRecovery:{enabled:true}}:undefined;
 const result=await f.loop.tick(f.id,undefined,undefined,undefined,config);
 expect(result).toMatchObject({state:'waiting_for_worker',send:false});expect(result.reason).toContain('deferred until');
 expect(seen[kind]).toBe(wanted);
 // A deferral must stop the tick before any later provider read (notably readiness).
 if(stage!=='readiness')expect(seen.readiness??0).toBe(0);
 expect(new RecoveryObservation(f.s).status(f.id)).toBeNull();expect(f.sends()).toBe(0);
 }finally{spy.mockRestore();f.s.close();}
 }
});
test('expired job lease fences a paused tick after a newer tick completes',async()=>{
 const f=templateFixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let reads=0;
 try{
 const old={...f.e,head:'c'.repeat(40),clear:true,failedChecks:[],findings:[]};
 f.loop.io.readiness=async()=>{if(++reads===1){await gate;return old;}return {...f.e,clear:true,failedChecks:[],findings:[]};};
 const first=f.loop.tick(f.id);while(reads===0)await Promise.resolve();
 setSystemTime(new Date(Date.now()+60*60*1000+1));
 await f.loop.tick(f.id);const newer={...f.loop.get(f.id)};release();
 expect(await first).toMatchObject({state:'waiting_for_worker',send:false});expect(f.loop.get(f.id)).toEqual(newer);expect(newer.head).not.toBe(old.head);expect(f.sends()).toBe(0);
 }finally{release?.();setSystemTime();f.s.close();}
});
test('branch updates bound unknown mergeability without conflict recovery',async()=>{
 const f=templateFixture();try{
 new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['open-pr','fetch','push-feature'],'human');
 const original=f.loop.io.readBranchSnapshot;f.loop.io.readBranchSnapshot=async(...args)=>({...await original(...args),behind:1,mergeable:null});
 for(let n=1;n<=6;n++){
 expect((await f.loop.tick(f.id,{enabled:true,authorizedBy:'human',maxUpdates:3})).state).toBe(n===6?'blocked':'updating_branch');setSystemTime(new Date(Date.now()+60001));
 }
 expect(new RecoveryObservation(f.s).status(f.id)).toBeNull();expect(f.s.get(f.id).attempts).toBe(0);expect(f.sends()).toBe(0);
 }finally{setSystemTime();f.s.close();}
});
test('branch-only ticks preserve readiness failure history',async()=>{
 const f=templateFixture();try{
 let branchOnly=false;const original=f.loop.io.readBranchSnapshot;
 f.loop.io.readBranchSnapshot=async(...args)=>({...await original(...args),behind:branchOnly?1:0,mergeable:branchOnly?null:true});
 f.loop.io.readiness=async()=>{throw readFailure('github','review-read','HTTP 503');};
 const config={conflictRecovery:{enabled:true}};
 await f.loop.tick(f.id,undefined,undefined,undefined,config);
 let row=f.s.db.query('SELECT failures,next_read FROM recovery_observations').get() as any;expect(row.failures).toBe(1);setSystemTime(new Date(row.next_read+1));
 branchOnly=true;expect((await f.loop.tick(f.id,undefined,undefined,undefined,config)).state).toBe('updating_branch');
 expect((f.s.db.query('SELECT failures FROM recovery_observations').get() as any).failures).toBe(1);
 setSystemTime(new Date(Date.now()+60001));branchOnly=false;await f.loop.tick(f.id,undefined,undefined,undefined,config);
 row=f.s.db.query('SELECT failures FROM recovery_observations').get() as any;expect(row.failures).toBe(2);expect(f.sends()).toBe(0);
 }finally{setSystemTime();f.s.close();}
});
test('six accepted ancestry read failures recover automatically without manual database edits',async()=>{
 const f=templateFixture();try{
  const l=new Lifecycle(f.s);l.grantGit(f.id,f.s.get(f.id).plan_hash,['open-pr','fetch','push-feature'],'human');
  new (await import('../src/branch-updates')).BranchUpdates(f.s);
  f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,'c'.repeat(40),'b'.repeat(40),'accepted',1,null);
  let reads=0;f.loop.io.contains=async()=>{reads++;throw readFailure('github','ancestry','HTTP 503');};
  const c={conflictRecovery:{enabled:true}},p={enabled:true,authorizedBy:'human',maxUpdates:3};
  for(let n=1;n<=6;n++){
   expect((await f.loop.tick(f.id,p,undefined,undefined,c)).state).toBe('waiting_for_worker');
   expect((f.s.db.query('SELECT failures FROM recovery_observations').get() as any).failures).toBe(n);
   await f.loop.tick(f.id,p,undefined,undefined,c);expect(reads).toBe(n);
   const row=f.s.db.query('SELECT next_read FROM recovery_observations').get() as any;setSystemTime(new Date(row.next_read+1));
  }
  f.loop.io.contains=async()=>true;f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];
  expect((await f.loop.tick(f.id,p,undefined,undefined,c)).state).toBe('waiting_for_ci');
  expect(f.s.db.query('SELECT * FROM recovery_observations').get()).toBeNull();
  expect(f.s.get(f.id).attempts).toBe(0);expect(f.sends()).toBe(0);
 }finally{setSystemTime();f.s.close();}
});
test('identity failures retain specific hints and do not consume provider read retries',async()=>{
 for(const kind of ['session','local','repository','authorization']){
  const f=templateFixture();try{
   const original=f.loop.io.readBranchSnapshot;
   if(kind==='session')f.session.session.prs=[];
   if(kind==='local')f.loop.io.worktreeIdentity=async()=>({tree:'/worktree',branch:'wrong',head:f.head});
   if(kind==='repository')f.loop.io.readBranchSnapshot=async(...args)=>({...await original(...args),headRepo:'fork/repo'});
   const expected={session:'Target/session mismatch',local:'Blocked — branch mismatch',repository:'Target is not the owned open feature PR'};
   for(let n=0;n<7;n++){
    if(kind==='authorization')await expect(f.loop.tick(f.id,{enabled:true,authorizedBy:'human',maxUpdates:3},undefined,undefined,{conflictRecovery:{enabled:true}})).rejects.toThrow('approved feature branch execution');
    else expect((await f.loop.tick(f.id,undefined,undefined,undefined,{conflictRecovery:{enabled:true}})).reason).toContain(expected[kind]);
   }
   expect(f.s.db.query('SELECT * FROM recovery_observations').all()).toEqual([]);expect(f.s.get(f.id).attempts).toBe(0);
  }finally{f.s.close();}
 }
});
test('scoped remediation combines persisted project verification with current delivery and budget safeguards',async()=>{
 const f=templateFixture();try{
  f.loop.setVerification(f.id,{version:1,mode:'host',steps:[{cwd:'.',argv:['bun','test']}]});
  new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['open-pr','commit','push-feature'],'human');
  f.e.failedChecks=[];f.e.findings=[{path:'src/fix.ts',body:'Fix the scoped defect',sha:f.head}];
  let prompt='';const original=f.io.spawn;f.io.spawn=(args:string[])=>{prompt=args[args.indexOf('--message')+1];return original(args);};
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});
  expect(prompt).toContain('execution mode: host');expect(prompt).toContain('["bun","test"]');expect(prompt).toContain('Budget:');expect(f.s.get(f.id).attempts).toBe(1);expect(f.sends()).toBe(1);
 }finally{f.s.close();}
});
test('container remediation receives persisted host runtime paths and clears them when withdrawn',async()=>{
 const f=templateFixture();try{
  const v:any={version:1,mode:'container',steps:[{cwd:'.',argv:['node','--test']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['src']}},context={projectConfig:'/trusted/project.json',runtimeConfig:'/trusted/runtime.json',bun:'/trusted/bun',cli:'/trusted/installed/src/cli.ts'};
  f.loop.setVerification(f.id,v,context);new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['open-pr','commit','push-feature'],'human');f.e.failedChecks=[];f.e.findings=[{path:'src/fix.ts',body:'Fix scoped code',sha:f.head}];
  let prompt='';const original=f.io.spawn;f.io.spawn=(args:string[])=>{prompt=args[args.indexOf('--message')+1];return original(args);};
  await f.loop.tick(f.id);expect(prompt).toContain(JSON.stringify([context.bun,context.cli,'verification',context.projectConfig,'/worktree','--run','--runtime',context.runtimeConfig]));expect(prompt).not.toContain('STOP before container verification');
  f.loop.setVerification(f.id,v);expect(f.s.db.query('SELECT * FROM review_verification_runtime WHERE job=?').all(f.id)).toEqual([]);
 }finally{f.s.close();}
});
function failureEvidence(e:any){return e.findings.map((f:any)=>({name:f.check,checkId:f.checkId,sha:f.sha,status:'completed',conclusion:'failure',descriptionHash:f.descriptionHash}));}
test('initial clear metadata checks cannot bypass body evidence without a preexisting wait',async()=>{
 const f=templateFixture();try{
  f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];f.e.botReviewSubmittedAt=Date.now()+1000;
  expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_ci',send:false,reason:'Missing body-bound success evidence for every configured metadata check'});const rows=f.s.db.query('SELECT * FROM metadata_waits').all();expect(rows).toHaveLength(1);
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_ci');expect(f.s.db.query('SELECT * FROM metadata_waits').all()).toEqual(rows);expect(f.reviews()).toBe(0);expect(f.sends()).toBe(0);
  f.s.db.query('UPDATE metadata_waits SET started=?').run(Date.now()-5*60*1000-1);expect((await f.loop.tick(f.id)).state).toBe('blocked');
  f.e.metadataCheckEvidence=bodyEvidence(f.e);expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
 }finally{f.s.close();}
});
test('readiness collection continues without open-pr permission when automatic updates are disabled',async()=>{
 const f=templateFixture();try{
  new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['fetch','push-feature'],'human');f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];f.e.metadataCheckEvidence=bodyEvidence(f.e);
  expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
test('missing body evidence does not prevent scoped code remediation with a configured metadata policy',async()=>{
 for(const deliveredDescription of [false,true]){const f=templateFixture();try{
  if(deliveredDescription){await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';f.e.descriptionHash='delivered-description';}
  new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['open-pr','commit','push-feature'],'human');
  f.e.clear=false;f.e.failedChecks=[];f.e.findings=[{path:'src/fix.ts',body:'Fix the scoped defect',sha:f.head}];delete f.e.metadataCheckEvidence;
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});expect(f.sends()).toBe(deliveredDescription?2:1);expect(f.reviews()).toBe(0);
  if(deliveredDescription){expect(f.s.db.query('SELECT * FROM metadata_waits').all()).toHaveLength(1);expect(f.s.db.query('SELECT * FROM description_delivery_gates').all()).toHaveLength(1);}
  // Remediation is allowed, not readiness: after the finding clears, missing
  // attestation must still block even an otherwise-clear old approval.
  f.session.transcript.turns.at(-1).state='completed';f.e.findings=[];f.e.clear=true;f.e.botReviewSubmittedAt=Date.now()+1000;expect((await f.loop.tick(f.id)).state).toBe('waiting_for_ci');
 }finally{f.s.close();}}
});
test('body-evidence remediation bypass still rejects findings outside the approved scope',async()=>{
 const f=templateFixture();try{
  f.e.failedChecks=[];f.e.findings=[{path:'outside/file.ts',body:'Out-of-scope change',sha:f.head}];delete f.e.metadataCheckEvidence;
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false});expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
test('an empty metadata policy skips wait creation and ignores historical metadata waits',async()=>{
 const f=templateFixture();try{
  f.loop.configureMetadataChecks('project',[]);f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];delete f.e.metadataCheckEvidence;
  expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');expect(f.s.db.query('SELECT * FROM metadata_waits').all()).toEqual([]);
  f.s.db.query('INSERT INTO metadata_waits VALUES (?,?,?,?,?)').run(f.id,f.head,'previous-body','previous-check',Date.now());const rows=f.s.db.query('SELECT * FROM metadata_waits').all();
  expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');expect(f.s.db.query('SELECT * FROM metadata_waits').all()).toEqual(rows);expect(f.reviews()).toBe(0);expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
test('removing metadata policy cannot bypass an uncertain description send or its fresh-review obligation',async()=>{
 const f=templateFixture();try{
  await f.loop.tick(f.id);f.loop.configureMetadataChecks('project',[]);f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];f.e.botReviewSubmittedAt=Date.now()+1000;
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_worker');expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'delivery_uncertain'});
  f.session.transcript.turns[0].state='completed';expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'delivery_uncertain'});
  f.e.descriptionHash='edited-after-policy-removal';f.e.botReviewSubmittedAt=Date.now()-1000;
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'completed'});expect(f.s.db.query('SELECT * FROM metadata_waits').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM description_delivery_gates').all()).toHaveLength(1);await f.loop.tick(f.id);expect(f.reviews()).toBe(1);expect(f.sends()).toBe(1);
  f.loop.configureMetadataChecks('project',['Alternative']);f.e.metadataCheckEvidence=bodyEvidence(f.e,['Alternative']);expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');f.loop.configureMetadataChecks('project',[]);
  f.e.botReviewSubmittedAt=Date.now()+1000;expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
  f.e.descriptionHash='another-body';f.e.botReviewSubmittedAt=Date.now()-1000;expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.reviews()).toBe(1);
 }finally{f.s.close();}
});
test('clearing metadata policy after delivery reconciliation still requires review of the delivered description',async()=>{
 const f=templateFixture();try{
  await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';f.e.descriptionHash='delivered-body';f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];f.e.botReviewSubmittedAt=Date.now()-1000;
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_ci');f.loop.configureMetadataChecks('project',[]);
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.sends()).toBe(1);expect(f.reviews()).toBe(1);
  f.e.botReviewSubmittedAt=Date.now()+1000;expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
 }finally{f.s.close();}
});
test('pilot rejects matching check identities and findings when failure body attestation is missing or stale',async()=>{
 for(const invalid of ['missing','null','old-body','identity','success']){const f=templateFixture();try{
  const finding=f.e.findings[0];
  if(invalid==='missing')delete f.e.metadataCheckEvidence;
  else{const evidence=f.e.metadataCheckEvidence[0];if(invalid==='null')evidence.descriptionHash=null;if(invalid==='old-body')evidence.descriptionHash='earlier-body';if(invalid==='identity')evidence.checkId=999;if(invalid==='success')evidence.conclusion='success';}
  expect((await f.loop.tick(f.id)).state).toBe('blocked');
  await expect(sendPilotRemediation(f.s,f.id,f.head,JSON.stringify([finding]),'owner/repo',1,['CI'],undefined,['PR body structure'],f.io)).rejects.toThrow('body-bound evidence unavailable');
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{f.s.close();}}
});
test('metadata success requires body-bound evidence for every configured check, not timestamps or a clear review',async()=>{
 const names=['PR body structure','Verification'];
 for(const invalid of ['missing','empty','partial','null','stale','head','identity','pending','neutral','duplicate']){const f=templateFixture();try{
  f.loop.configureMetadataChecks('project',names);f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];f.e.botReviewSubmittedAt=Date.now()+1000;
  f.s.db.query('INSERT INTO metadata_waits VALUES (?,?,?,?,?)').run(f.id,f.head,f.e.descriptionHash,f.e.templateSignature,Date.now());
  const rows:any[]=bodyEvidence(f.e,names);f.e.metadataCheckEvidence=rows;
  if(invalid==='missing')delete f.e.metadataCheckEvidence;
  if(invalid==='empty')f.e.metadataCheckEvidence=[];
  if(invalid==='partial')rows.pop();
  if(invalid==='null')rows[1].descriptionHash=null;
  if(invalid==='stale')rows[1].descriptionHash='previous-body';
  if(invalid==='head')rows[1].sha='old-head';
  if(invalid==='identity')rows[1].checkId=undefined;
  if(invalid==='pending')rows[1].status='in_progress';
  if(invalid==='neutral')rows[1].conclusion='neutral';
  if(invalid==='duplicate')rows.push({...rows[0]});
  expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_ci',send:false});expect(f.reviews()).toBe(0);expect(f.sends()).toBe(0);
  f.s.db.query('UPDATE metadata_waits SET started=?').run(Date.now()-5*60*1000-1);expect((await f.loop.tick(f.id)).state).toBe('blocked');
  f.e.metadataCheckEvidence=bodyEvidence(f.e,names);expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
 }finally{f.s.close();}}
});
test('real template remediation persists baselines, sends once, waits for CI and reevaluates CodeRabbit',async()=>{
 const f=templateFixture(),{s,id,loop,session,e}=f;try{
 await loop.tick(id);expect(f.sends()).toBe(1);await loop.tick(id);expect(f.sends()).toBe(1);
 expect(s.db.query('SELECT kind,baseline_body_hash FROM remediation_context').get()).toEqual({kind:'pr_description',baseline_body_hash:'old-body'});expect(s.db.query('SELECT signature FROM metadata_baselines').get()).toEqual({signature:'old-check'});expect(s.db.query('SELECT state FROM remediation').get()).toEqual({state:'delivery_uncertain'});
 session.transcript.turns[0].state='completed';e.descriptionHash='new-body';await loop.tick(id);
 expect((await loop.tick(id)).state).toBe('waiting_for_ci');expect(f.sends()).toBe(1);
  e.failedChecks=[];e.findings=[];e.templateSignature='passed-check';e.metadataCheckEvidence=bodyEvidence(e);expect((await loop.tick(id)).state).toBe('waiting_for_coderabbit');expect(f.reviews()).toBe(1);await loop.tick(id);expect(f.reviews()).toBe(1);expect(f.sends()).toBe(1);
 e.clear=true;e.botReviewSubmittedAt=Date.now()+1000;expect((await loop.tick(id)).state).toBe('ready_for_human');expect(f.sends()).toBe(1);
 }finally{s.close();}
});
test('same-head B-to-C edits retain the metadata gate and require C evidence plus a fresh review',async()=>{
 const f=templateFixture();try{
  const started=Date.now()-1000;f.e.descriptionHash='body-B';
  f.s.db.query('INSERT INTO metadata_waits VALUES (?,?,?,?,?)').run(f.id,f.head,'body-B',f.e.templateSignature,started);
  f.e.failedChecks=[];f.e.findings=[];f.e.clear=true;f.e.botReviewSubmittedAt=started+1;f.e.metadataCheckEvidence=bodyEvidence(f.e);
  expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
  f.e.descriptionHash='body-C';expect((await f.loop.tick(f.id)).state).toBe('waiting_for_ci');expect(f.reviews()).toBe(0);expect(f.sends()).toBe(0);
  const current=f.s.db.query('SELECT * FROM metadata_waits WHERE job=? AND head=? AND body=?').get(f.id,f.head,'body-C') as any;
  expect(current.started).toBeGreaterThan(started);expect(current.signature).toBe(f.e.templateSignature);
  f.e.clear=false;f.e.reasons=['CodeRabbit approval missing'];await f.loop.tick(f.id);expect(f.reviews()).toBe(0);
  f.e.metadataCheckEvidence=bodyEvidence(f.e);expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');await f.loop.tick(f.id);expect(f.reviews()).toBe(1);
  f.e.clear=true;expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');f.e.botReviewSubmittedAt=Date.now()+1000;expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');expect(f.sends()).toBe(0);
  // Reverting to an earlier body must not revive its old wait/review clock.
  f.e.descriptionHash='body-B';f.e.metadataCheckEvidence=bodyEvidence(f.e);f.e.botReviewSubmittedAt=current.started;
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');
  const reverted=f.s.db.query('SELECT started FROM metadata_waits WHERE job=? AND head=? AND body=?').get(f.id,f.head,'body-B') as any;expect(reverted.started).toBeGreaterThan(current.started);
 }finally{f.s.close();}
});
test('same-head description edits preserve stale failure suppression but allow fresh metadata failure remediation',async()=>{
 const f=templateFixture();try{
  await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';f.e.descriptionHash='body-B';await f.loop.tick(f.id);
  f.e.descriptionHash='body-C';expect((await f.loop.tick(f.id)).state).toBe('waiting_for_ci');expect(f.sends()).toBe(1);expect(f.reviews()).toBe(0);
  f.e.templateSignature='fresh-C-failure';f.e.findings[0].descriptionHash='body-C';f.e.findings[0].checkId=2;f.e.failedChecks[0].id=2;f.e.metadataCheckEvidence=failureEvidence(f.e);
  expect((await f.loop.tick(f.id)).state).toBe('remediation_pending');expect(f.sends()).toBe(2);expect(f.reviews()).toBe(0);
 }finally{f.s.close();}
});
test('real pilot remediation rejects stale description, check identity and SHA before reserving or sending',async()=>{
 for(const changed of [{descriptionHash:'changed'},{checkId:2},{sha:'changed'}]){const f=templateFixture();try{const findings=JSON.stringify([{...f.e.findings[0],...changed}]);await expect(sendPilotRemediation(f.s,f.id,f.head,findings,'owner/repo',1,['CI'],undefined,['PR body structure'],f.io)).rejects.toThrow('Template failure changed');expect(f.sends()).toBe(0);expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);}finally{f.s.close();}}
});
test('template wait blocks at five minutes without spending another attempt',async()=>{
 const f=templateFixture();try{await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';f.e.descriptionHash='new-body';await f.loop.tick(f.id);f.s.db.query('UPDATE metadata_waits SET started=?').run(Date.now()-5*60*1000-1);expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.sends()).toBe(1);}finally{f.s.close();}
});
test('fresh failing check allows bounded remediation instead of a stale CI wait',async()=>{
 const f=templateFixture();try{
  for(let attempt=1;attempt<=5;attempt++){
    await f.loop.tick(f.id);expect(f.sends()).toBe(attempt);f.session.transcript.turns.at(-1).state='completed';f.e.descriptionHash=`body-${attempt}`;f.e.findings=[{...f.e.findings[0],descriptionHash:f.e.descriptionHash,checkId:attempt+1}];f.e.failedChecks[0].id=attempt+1;f.e.metadataCheckEvidence=failureEvidence(f.e);
   await f.loop.tick(f.id);f.e.templateSignature=`check-${attempt}`;
  }
  await f.loop.tick(f.id);expect(f.sends()).toBe(5);expect(f.s.get(f.id).attempts).toBe(5);
 }finally{f.s.close();}
});
test('CodeRabbit reevaluation blocks after thirty minutes without duplicate review requests',async()=>{
   const f=templateFixture();try{await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';f.e.descriptionHash='new-body';await f.loop.tick(f.id);f.e.failedChecks=[];f.e.findings=[];f.e.metadataCheckEvidence=bodyEvidence(f.e);expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');const elapsed=Date.now()-30*60*1000-1;f.s.db.query('UPDATE full_review_requests SET requested=?').run(elapsed);f.s.db.query('UPDATE metadata_waits SET started=?').run(elapsed);f.s.db.query('UPDATE description_delivery_gates SET started=?').run(elapsed);expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.reviews()).toBe(1);expect(f.sends()).toBe(1);}finally{f.s.close();}
});
test('metadata remediation preserves the configured budget after base-branch integration',async()=>{
 const f=templateFixture(),policy={maxAttempts:2,maxNoProgress:5,window:'job' as const};try{
  for(let attempt=1;attempt<=2;attempt++){
    await f.loop.tick(f.id,undefined,policy);expect(f.sends()).toBe(attempt);f.session.transcript.turns.at(-1).state='completed';f.e.descriptionHash=`budget-body-${attempt}`;f.e.findings=[{...f.e.findings[0],descriptionHash:f.e.descriptionHash,checkId:attempt+1}];f.e.failedChecks[0].id=attempt+1;f.e.metadataCheckEvidence=failureEvidence(f.e);
   await f.loop.tick(f.id,undefined,policy);f.e.templateSignature=`budget-check-${attempt}`;
  }
  expect((await f.loop.tick(f.id,undefined,policy)).state).toBe('blocked');expect(f.sends()).toBe(2);expect(f.s.get(f.id).attempts).toBe(2);
 }finally{f.s.close();}
});
test('missing or malformed metadata policy fails closed before provider inspection',async()=>{
 const f=templateFixture();try{
  let reads=0;f.loop.io.sessionEvidence=async()=>{reads++;return f.session;};f.s.db.exec('DELETE FROM metadata_check_policy');
  await expect(f.loop.tick(f.id)).rejects.toThrow('metadata-check policy required');expect(reads).toBe(0);expect(f.sends()).toBe(0);
  f.s.db.query('INSERT INTO metadata_check_policy VALUES (?,?)').run('project','"not an array"');await expect(f.loop.tick(f.id)).rejects.toThrow('metadata check names');expect(reads).toBe(0);
 }finally{f.s.close();}
});
test('concurrent ticks retain their explicitly supplied check policy despite shared policy replacement or caller mutation',async()=>{
 const f=templateFixture();try{
  f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),seen:any[]=[];
  f.loop.io.sessionEvidence=async()=>{await gate;return f.session;};f.loop.io.readiness=async(_repo,_pr,required,metadata)=>{seen.push({required,metadata});return f.e;};
  const checks=['Strict metadata'],strict=f.loop.tick(f.id,undefined,undefined,{project:'project',checks}),empty=f.loop.tick(f.id,undefined,undefined,{project:'project',checks:[]});
  const before={...f.loop.get(f.id)};
  expect(await empty).toMatchObject({state:'waiting_for_worker',send:false});expect(seen).toEqual([]);expect(f.loop.get(f.id)).toEqual(before);expect(f.sends()).toBe(0);
  checks.length=0;f.loop.configureMetadataChecks('project',[]);release();await strict;
  expect(seen).toEqual([{required:['CI','Strict metadata'],metadata:['Strict metadata']}]);expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
test('same-name failures require matching check-run identity and head for remediation or metadata waiting',async()=>{
 const f=templateFixture();try{
  for(const altered of [{id:2},{sha:'old'},{id:undefined}])expect(decision({...f.e,failedChecks:[{...f.e.failedChecks[0],...altered}]},['src/**'],0)).toMatchObject({state:'blocked',send:false});
  f.e.failedChecks.push({...f.e.failedChecks[0],id:2});expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.sends()).toBe(0);
  f.e.failedChecks.pop();f.s.db.query('INSERT INTO metadata_waits VALUES (?,?,?,?,?)').run(f.id,f.head,f.e.descriptionHash,f.e.templateSignature,Date.now());
  f.e.findings[0].checkId=2;expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
test('a metadata policy from another project cannot override a job policy',async()=>{
 const f=templateFixture();try{let reads=0;f.loop.io.sessionEvidence=async()=>{reads++;return f.session;};await expect(f.loop.tick(f.id,undefined,undefined,{project:'foreign',checks:[]})).rejects.toThrow('job project');expect(reads).toBe(0);expect(f.sends()).toBe(0);expect(f.loop.metadataChecks(f.id)).toEqual(['PR body structure']);}finally{f.s.close();}
});
test('metadata wait requires a post-update approval even if all current-head checks and the old approval are clear',async()=>{
 const f=templateFixture();try{
  const started=Date.now();f.s.db.query('INSERT INTO metadata_waits VALUES (?,?,?,?,?)').run(f.id,f.head,f.e.descriptionHash,f.e.templateSignature,started);
   f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];f.e.botReviewSubmittedAt=started-1000;f.e.metadataCheckEvidence=bodyEvidence(f.e);
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.reviews()).toBe(1);expect(f.sends()).toBe(0);
  f.e.botReviewSubmittedAt=Date.now()+1000;expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
 }finally{f.s.close();}
});
test('a description edit creates its review gate before considering an old clear approval',async()=>{
 const f=templateFixture();try{
   await f.loop.tick(f.id);f.session.transcript.turns[0].state='completed';f.e.descriptionHash='edited-body';f.e.failedChecks=[];f.e.findings=[];f.e.clear=true;f.e.botReviewSubmittedAt=Date.now()-1000;f.e.metadataCheckEvidence=bodyEvidence(f.e);
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.s.db.query('SELECT * FROM metadata_waits').all()).toHaveLength(1);expect(f.sends()).toBe(1);expect(f.reviews()).toBe(1);
 }finally{f.s.close();}
});
test('pilot remediation uses the same submission barrier as shutdown and never spawns through a held fence',async()=>{
 const home=mkdtempSync(join(tmpdir(),'adlc-pilot-fence-'));try{
  const child=Bun.spawnSync([process.execPath,join(import.meta.dir,'pilot-barrier-fixture.ts')],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_DB:join(home,'unused.sqlite')}});
  expect(child.exitCode).toBe(0);const result=JSON.parse(child.stdout.toString());expect(result.rejection).toContain('in progress');expect(result.sends).toBe(0);expect(result.attempts).toBe(0);expect(result.rows).toEqual([]);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('an attempted pilot send preserves uncertainty and its consumed budget when spawning fails',async()=>{
 const f=templateFixture();try{f.io.spawn=()=>{throw Error('spawn receipt lost');};await expect(f.loop.tick(f.id)).rejects.toThrow('receipt lost');expect(f.s.get(f.id).attempts).toBe(1);expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'delivery_uncertain'});}finally{f.s.close();}
});
test('remediation send uses a bounded timeout and keeps a failed receipt uncertain without resending',async()=>{
 const f=templateFixture(),state=mkdtempSync(join(tmpdir(),'adlc-remediation-timeout-')),turns=turnBarrier(state);let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  let options:any,sends=0,started!:()=>void;const spawned=new Promise<void>(resolve=>started=resolve);f.io.submit=turns.submit;
  f.io.spawn=(_args:any,opts:any)=>{sends++;options=opts;child=Bun.spawn([process.execPath,'-e','await Bun.sleep(60000)'],{...opts,timeout:200,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:state}});started();return child;};
  const delivery=f.loop.tick(f.id);await spawned;expect(child!.exitCode).toBeNull();await expect(turnBarrier(state).run(async()=>{})).rejects.toThrow('in progress');
  await delivery;expect(child!.exitCode).not.toBe(0);expect(child!.signalCode).toBe('SIGTERM');await turnBarrier(state).run(async()=>{});
  expect(options).toEqual({stdout:'pipe',stderr:'pipe',timeout:30000});expect(f.s.get(f.id).attempts).toBe(1);expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'delivery_uncertain'});
  expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(sends).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}f.s.close();rmSync(state,{recursive:true,force:true});}
});
test('metadata review cannot bypass delivery worktree identity when branch updates are disabled',async()=>{
 const f=templateFixture();try{
  f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];f.loop.io.worktreeIdentity=async()=>({tree:'/worktree',branch:'unexpected',head:f.head});
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false});expect(f.loop.get(f.id).reason).toContain('branch mismatch');expect(f.sends()).toBe(0);expect(f.reviews()).toBe(0);
 }finally{f.s.close();}
});
test('failed or ambiguous active-session evidence replaces a previously ready review with blocked state',async()=>{
 for(const evidence of [async()=>{throw Error('evidence refresh failed');},async()=>({session:{isTerminated:undefined}})]){
  const f=templateFixture();try{
   f.loop.record(f.id,{state:'ready_for_human',send:false,head:f.head});f.loop.io.sessionEvidence=evidence as any;
   expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.loop.get(f.id).state).toBe('blocked');expect(f.sends()).toBe(0);
  }finally{f.s.close();}
 }
});
test('readiness collection failure replaces stale ready state with a durable send-disabled blocker',async()=>{
 const f=templateFixture();try{
  f.loop.record(f.id,{state:'ready_for_human',send:false,head:f.head});f.loop.io.readiness=async()=>{throw Error('GitHub readiness unavailable');};
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason:'GitHub readiness unavailable'});expect(f.loop.get(f.id)).toMatchObject({state:'blocked',reason:'GitHub readiness unavailable'});expect(f.sends()).toBe(0);expect(f.reviews()).toBe(0);
 }finally{f.s.close();}
});
test('late review records preserve completed targets and do not emit stale state changes',()=>{
 const f=templateFixture();try{
  f.loop.record(f.id,{state:'completed',send:false,head:f.head,reason:'Merge observed'});const target=f.loop.get(f.id),events=f.s.db.query('SELECT count(*) AS n FROM events').get();
  expect(f.loop.record(f.id,{state:'blocked',send:false,reason:'Late provider failure'})).toEqual({state:'completed',send:false,head:target.head,reason:'Merge observed'});expect(f.loop.get(f.id)).toEqual(target);expect(f.s.db.query('SELECT count(*) AS n FROM events').get()).toEqual(events);
 }finally{f.s.close();}
});
test('readiness failure arriving after completion cannot reopen the target',async()=>{
 const f=templateFixture();try{
  let target:any,events:any;f.loop.io.readiness=async()=>{f.loop.record(f.id,{state:'completed',send:false,head:f.head,reason:'Concurrent merge observed'});target=f.loop.get(f.id);events=f.s.db.query('SELECT count(*) AS n FROM events').get();throw Error('Late readiness failure');};
  expect(await f.loop.tick(f.id)).toMatchObject({state:'completed',send:false,reason:'Concurrent merge observed'});expect(f.loop.get(f.id)).toEqual(target);expect(f.s.db.query('SELECT count(*) AS n FROM events').get()).toEqual(events);expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
test('successful review collection after concurrent completion cannot overwrite it or send remediation',async()=>{
 for(const clear of [false,true]){const f=templateFixture();try{
  let target:any,events:any;f.loop.io.readiness=async()=>{f.s.db.exec("UPDATE jobs SET state='done';UPDATE runs SET state='completed';");f.loop.record(f.id,{state:'completed',send:false,head:f.head,reason:'Concurrent merge observed'});target=f.loop.get(f.id);events=f.s.db.query('SELECT count(*) AS n FROM events').get();return {...f.e,clear};};
  expect(await f.loop.tick(f.id)).toMatchObject({state:'completed',send:false});expect(f.loop.get(f.id)).toEqual(target);expect(f.s.db.query('SELECT count(*) AS n FROM events').get()).toEqual(events);expect(f.sends()).toBe(0);expect(f.reviews()).toBe(0);expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{f.s.close();}}
});
test('a late GitHub review-request receipt preserves the completed target and its newer head',async()=>{
 const f=templateFixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 try{
  f.e.findings=[];f.e.failedChecks=[];f.e.reasons=['CodeRabbit review absent'];f.e.metadataCheckEvidence=bodyEvidence(f.e);f.loop.postReview=async()=>{entered();await gate;};
  const pending=f.loop.tick(f.id);await started;const newer='b'.repeat(40);f.s.db.exec("UPDATE jobs SET state='done';UPDATE runs SET state='completed';");f.s.db.query("UPDATE review_targets SET state='completed',head=?,reason='Merge observed' WHERE job=?").run(newer,f.id);
  const target=f.loop.get(f.id),changes=f.s.db.query("SELECT count(*) AS n FROM events WHERE kind='review_state_changed'").get();release();expect(await pending).toEqual({state:'completed',send:false,head:newer,reason:'Merge observed'});expect(f.loop.get(f.id)).toEqual(target);expect(f.s.db.query("SELECT count(*) AS n FROM events WHERE kind='review_state_changed'").get()).toEqual(changes);expect(f.sends()).toBe(0);
  const events=f.s.db.query('SELECT count(*) AS n FROM events').get();expect(await f.loop.tick(f.id)).toMatchObject({state:'completed',send:false,head:newer});expect(await f.loop.requestReview(f.id,f.loop.get(f.id).pr,newer,'later-body')).toBe(false);expect(f.s.db.query('SELECT count(*) AS n FROM events').get()).toEqual(events);
 }finally{release?.();f.s.close();}
});
test('completed same-head remediation persists the guarded blocked decision',async()=>{
 const f=templateFixture();try{
  new Lifecycle(f.s).grantGit(f.id,f.s.get(f.id).plan_hash,['commit','push-feature'],'human');
  f.e.findings=[{kind:'code',path:'src/a.ts',message:'Fix the scoped defect'}];f.e.failedChecks=[];
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});
  f.session.transcript.turns[0].state='completed';
  const reason='Worker completed remediation without a new commit or metadata change; inspect before retry';
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason});
  expect(f.loop.get(f.id)).toMatchObject({state:'blocked',reason,pr:1});
  expect(f.sends()).toBe(1);
 }finally{f.s.close();}
});
test('remediation reconciliation cannot write an old PR decision to a rebound target',async()=>{
 const f=templateFixture();try{
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});
  let rebound:any;const snapshot=f.loop.io.readBranchSnapshot;
  f.loop.io.readBranchSnapshot=async(...args:any[])=>{
   const result=await (snapshot as any)(...args);
   f.s.db.query("UPDATE review_targets SET pr=2,state='waiting_for_review',reason=NULL,head=NULL,last_signature=NULL WHERE job=?").run(f.id);
   rebound=f.loop.get(f.id);
   return result;
  };
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason:'Review target rebound to another PR during evaluation; re-evaluate evidence'});
  expect(f.loop.get(f.id)).toEqual(rebound);
  expect(f.sends()).toBe(1);
 }finally{f.s.close();}
});
test('a review request for an unregistered PR posts nothing',async()=>{
 const f=templateFixture();try{
  const calls:any[]=[];f.loop.postReview=async(...args:any[])=>{calls.push(args);};
  const registered=f.loop.get(f.id).pr;
  expect(await f.loop.requestReview(f.id,registered+1,f.head,'body')).toBe(false);
  expect(calls).toHaveLength(0);
  expect(f.s.db.query('SELECT * FROM full_review_requests WHERE job=?').all(f.id)).toHaveLength(0);
  expect(f.loop.get(f.id).pr).toBe(registered);
  // The registered PR still requests normally.
  f.e.findings=[];f.e.failedChecks=[];
  expect(await f.loop.requestReview(f.id,registered,f.head,f.e.descriptionHash)).toBe(true);
  expect(calls[0].slice(0,2)).toEqual(['owner/repo',registered]);
  expect(calls[0][2]).toContain('adlc-coderabbit-request:');
 }finally{f.s.close();}
});
test('a target rebound during a tick keeps the old PR decision unwritten',async()=>{
 const f=templateFixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 try{
  f.e.findings=[];f.e.failedChecks=[];f.e.reasons=['CodeRabbit review absent'];f.e.metadataCheckEvidence=bodyEvidence(f.e);
  f.loop.postReview=async()=>{entered();await gate;};
  const pending=f.loop.tick(f.id);await started;
  const original=f.loop.get(f.id);
  f.s.db.query('UPDATE review_targets SET pr=? WHERE job=?').run(original.pr+1,f.id);
  release();
  expect(await pending).toMatchObject({state:'blocked',reason:'Review target rebound to another PR during evaluation; re-evaluate evidence'});
  expect(f.loop.get(f.id)).toMatchObject({pr:original.pr+1,head:original.head});
 }finally{release?.();f.s.close();}
});
test('a legacy uncertain receipt for the current target blocks a duplicate request',async()=>{
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('project','issue','spec'),r=p.reserve(id,'ao');p.gate(id,'ao','session',r.branch,'/worktree');
 const hash=s.propose(id,'plan');s.approve(id,hash,'human');new Lifecycle(s).adoptSupervised(id,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
 let posts=0;try{
  new ReviewLoop(s);
  s.db.query("INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head_since) VALUES (?,?,?,?,?,?,?)").run(id,'owner/repo',7,'["CI"]','["src/**"]',0,1);
  s.db.exec('DROP TABLE full_review_requests; CREATE TABLE full_review_requests(job TEXT NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,PRIMARY KEY(job,head,body_hash))');
  s.db.query('INSERT INTO full_review_requests VALUES (?,?,?,?,?)').run(id,'sha','body','delivery_uncertain',1);
  const loop=new ReviewLoop(s);loop.postReview=async()=>{posts++;};
  expect(s.db.query('SELECT pr FROM full_review_requests WHERE job=?').get(id)).toEqual({pr:7});
  expect(await loop.requestReview(id,7,'sha','body')).toBe(false);
  expect(posts).toBe(0);
 }finally{s.close();}
});
test('legacy review-request receipts are migrated under an unknown PR key',()=>{
 const s=new Store(':memory:');
 s.db.exec('CREATE TABLE full_review_requests(job TEXT NOT NULL,head TEXT NOT NULL,body_hash TEXT NOT NULL,state TEXT NOT NULL,requested INTEGER NOT NULL,PRIMARY KEY(job,head,body_hash))');
 s.db.exec("CREATE TABLE review_targets(job TEXT PRIMARY KEY,repo TEXT NOT NULL,pr INTEGER NOT NULL,required_checks TEXT NOT NULL,allowed_paths TEXT NOT NULL,remediate INTEGER NOT NULL DEFAULT 0,head TEXT,state TEXT NOT NULL DEFAULT 'waiting_for_review',reason TEXT,head_since INTEGER NOT NULL,last_signature TEXT,updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
 s.db.query('INSERT INTO full_review_requests VALUES (?,?,?,?,?)').run('job','sha','body','accepted',1);
 try{
  // A registered target supplies its PR for the migrated receipt.
  s.db.query("INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,remediate,head_since) VALUES ('job','owner/repo',7,'[\"CI\"]','[\"src/**\"]',0,1)").run();
  new ReviewLoop(s);
  expect(s.db.query('SELECT * FROM full_review_requests').all()).toEqual([{job:'job',pr:7,head:'sha',body_hash:'body',state:'accepted',requested:1}]);
  // The same head/body can now hold a receipt for a different PR.
  s.db.query('INSERT INTO full_review_requests VALUES (?,?,?,?,?,?)').run('job',3,'sha','body','delivery_uncertain',2);
  expect(s.db.query('SELECT pr FROM full_review_requests WHERE job=? ORDER BY pr').all('job')).toEqual([{pr:3},{pr:7}]);
 }finally{s.close();}
});
test('failed review requests revoke stale ready state but retain their reservation and never post twice',async()=>{
 for(const edited of [false,true]){const f=templateFixture();try{
  f.loop.configureMetadataChecks('project',[]);f.e.clear=edited;f.e.failedChecks=[];f.e.findings=[];f.e.reasons=['CodeRabbit review absent'];f.e.botReviewSubmittedAt=Date.now()-1000;
  if(edited)f.s.db.query('INSERT INTO description_delivery_gates VALUES (?,?,?,?)').run(f.id,f.head,'previous-body',Date.now()-1000);
  f.loop.record(f.id,{state:'ready_for_human',send:false,head:f.head,reason:'Previously approved'});let requests=0;
  f.loop.postReview=async()=>{requests++;expect(f.loop.get(f.id).state).toBe('needs_reconciliation');throw Error('GitHub request receipt lost');};
  await expect(f.loop.tick(f.id)).rejects.toThrow('receipt lost');expect(f.loop.get(f.id).state).toBe('needs_reconciliation');
  expect(f.s.db.query('SELECT state FROM full_review_requests').get()).toEqual({state:'delivery_uncertain'});expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(f.loop.get(f.id).state).toBe('needs_reconciliation');expect(requests).toBe(1);expect(f.sends()).toBe(0);
  f.e.clear=true;f.e.botReviewSubmittedAt=Date.now()+1000;expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(requests).toBe(1);
  // Simulate explicit reconciliation of the delivery receipt, not a resend.
  f.s.db.query("UPDATE full_review_requests SET state='accepted'").run();f.s.db.query("UPDATE coderabbit_requests SET state='accepted'").run();expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');expect(requests).toBe(1);
 }finally{f.s.close();}}
});
test('a late failed review request cannot reopen a concurrently completed target',async()=>{
 const f=templateFixture();try{
  f.e.findings=[];f.e.failedChecks=[];
  let terminal:any;f.loop.postReview=async()=>{f.loop.record(f.id,{state:'completed',send:false,head:f.head,reason:'Merge observed'});terminal=f.loop.get(f.id);throw Error('Late GitHub failure');};
  await expect(f.loop.requestReview(f.id,f.loop.get(f.id).pr,f.head,f.e.descriptionHash)).rejects.toThrow('Late GitHub failure');expect(f.loop.get(f.id)).toEqual(terminal);expect(f.s.db.query('SELECT state FROM full_review_requests').get()).toEqual({state:'delivery_uncertain'});
 }finally{f.s.close();}
});
test('a concurrently reserved review request cannot be downgraded to a normal wait by either request branch',async()=>{
 for(const edited of [false,true]){const f=templateFixture();try{
  f.loop.configureMetadataChecks('project',[]);f.e.clear=edited;f.e.failedChecks=[];f.e.findings=[];f.e.reasons=['CodeRabbit review absent'];f.e.botReviewSubmittedAt=Date.now()-1000;
  if(edited)f.s.db.query('INSERT INTO description_delivery_gates VALUES (?,?,?,?)').run(f.id,f.head,'previous-body',Date.now()-1000);
  f.loop.record(f.id,{state:'ready_for_human',send:false,head:f.head});f.loop.requestReview=async()=>{f.s.db.query('INSERT INTO full_review_requests VALUES (?,?,?,?,?,?)').run(f.id,f.loop.get(f.id).pr,f.head,f.e.descriptionHash,'delivery_uncertain',Date.now());return false;};
  expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(f.loop.get(f.id).state).toBe('needs_reconciliation');expect(f.sends()).toBe(0);expect(f.reviews()).toBe(0);
 }finally{f.s.close();}}
});
test('description edits cannot escape same-head review-request uncertainty or trigger another post',async()=>{
 const f=templateFixture();try{
  f.loop.configureMetadataChecks('project',[]);f.e.failedChecks=[];f.e.findings=[];f.e.reasons=['CodeRabbit review absent'];const originalBody=f.e.descriptionHash;let posts=0;
  f.loop.postReview=async()=>{posts++;throw Error('Lost request receipt');};
  await expect(f.loop.tick(f.id)).rejects.toThrow('Lost request receipt');f.e.descriptionHash='edited-body';
  for(const clear of [false,true]){f.e.clear=clear;f.e.botReviewSubmittedAt=Date.now()+1000;expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(f.loop.get(f.id).state).toBe('needs_reconciliation');}
  expect(await f.loop.requestReview(f.id,f.loop.get(f.id).pr,f.head,f.e.descriptionHash)).toBe(false);expect(posts).toBe(1);expect(f.s.db.query('SELECT * FROM full_review_requests').all()).toHaveLength(1);
  // Even a separately accepted receipt for the new body cannot mask the old
  // same-head uncertain delivery. Every outstanding receipt must be reconciled.
  f.s.db.query('INSERT INTO full_review_requests VALUES (?,?,?,?,?,?)').run(f.id,f.loop.get(f.id).pr,f.head,f.e.descriptionHash,'accepted',Date.now());expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');
  f.s.db.query("UPDATE full_review_requests SET state='accepted' WHERE job=? AND head=? AND body_hash=?").run(f.id,f.head,originalBody);f.s.db.query("UPDATE coderabbit_requests SET state='accepted'").run();expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');expect(posts).toBe(1);expect(f.sends()).toBe(0);
 }finally{f.s.close();}
});
// #4/#5-shaped carried-forward thread: unresolved, mapped to current code, but
// its comment keeps the original commit from an earlier push.
function threadFixture(){
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('project','issue','spec'),r=p.reserve(id,'ao');p.gate(id,'ao','session',r.branch,'/worktree');const hash=s.propose(id,'plan');s.approve(id,hash,'human');const l=new Lifecycle(s);l.grantGit(id,hash,['commit','push-feature'],'human');l.adoptSupervised(id,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
 const head='a'.repeat(40),candidate={threadId:'T1',path:'src/workflow.ts',line:12,commentIds:['C1'],commentsHash:'d'.repeat(64),body:'Planning slot is not released on failure',originalCommit:'dcf66943',outdated:false};
 const finding={source:'github-review',kind:'review_thread',threadId:'T1',path:'src/workflow.ts',line:12,body:candidate.body,sha:head,originalCommit:'dcf66943',commentIds:['C1'],commentsHash:'d'.repeat(64),outdated:false};
 const e:any={clear:false,reasons:['Unresolved or unknown findings'],head,descriptionHash:'body',templateSignature:'sig',findings:[finding],failedChecks:[],pendingChecks:[],missingChecks:[],coderabbitPending:false,coderabbitPresent:true,coderabbitRateLimited:false,metadataCheckEvidence:[],reviewThreads:{unresolved:1,resolved:0,candidates:[candidate],stale:[],humanOnly:[]}};
 const session:any={receiptObservation:{complete:true,observed:Date.now()},session:{id:'session',branch:r.branch,isTerminated:false,prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',entries:[],turns:[]}};let sends=0,reviews=0;
 const io:any={readBranchSnapshot:async()=>({head,base:'b'.repeat(40),branch:r.branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:true,behind:0}),worktreeIdentity:async()=>({tree:'/worktree',branch:r.branch,head}),readiness:async()=>({...e,findings:e.findings.map((f:any)=>({...f})),reviewThreads:{...e.reviewThreads,candidates:e.reviewThreads.candidates.map((c:any)=>({...c}))}}),sessionEvidence:async()=>session,submit:async(operation:any)=>operation(),spawn:(args:string[])=>{
  sends++;const handle=args[args.indexOf('--client-message-id')+1],turnId=`fix-${sends}`;
  session.transcript.entries.push({clientMessageId:handle,turnId});session.transcript.turns.push({id:turnId,state:'running'});
  return {stdout:new Response('{}').body,stderr:new Response('').body,exited:Promise.resolve(0)};
 }};
 const loop=new ReviewLoop(s,async()=>{reviews++;},{readBranchSnapshot:io.readBranchSnapshot,worktreeIdentity:io.worktreeIdentity,readiness:io.readiness,sessionEvidence:io.sessionEvidence,disableNativeFeedback:async()=>({}),sendPilotRemediation:(...args:any[])=>sendPilotRemediation(...args as Parameters<typeof sendPilotRemediation>,io)} as any);
 loop.configureMetadataChecks('project',[]);loop.register(id,'owner/repo',1,['CI'],['src/**'],true);
 return {s,id,head,e,session,loop,io,candidate,sends:()=>sends,reviews:()=>reviews};
}
for(const stage of ['initial','final'])test(`expired reviewer membership at ${stage} delivery refresh cannot reserve or send remediation`,async()=>{
 const f=threadFixture();try{
  f.e.findings[0].provenance=[{reviewer:'codex',userId:199175422,original:{body:f.e.findings[0].body}}];
  f.e.reviewerEvidence={trust:[{reviewer:'codex',observed:Date.now(),ids:[199175422],blocker:null}]};
  let reads=0;const base=f.io.readiness;
  f.io.readiness=async(...args:any[])=>{const e=await base(...args);if(++reads===(stage==='initial'?1:2))e.reviewerEvidence={trust:[{reviewer:'codex',observed:Date.now()-RECEIPT_FRESHNESS_MS-1,ids:[199175422],blocker:null}]};return e;};
  await expect(sendPilotRemediation(f.s,f.id,f.head,JSON.stringify(f.e.findings),'owner/repo',1,['CI'],DEFAULT_REMEDIATION_POLICY,[],f.io)).rejects.toThrow('Review feedback trust expired or unavailable');
  expect(reads).toBe(stage==='initial'?1:2);expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{f.s.close();}
});
test('pathless review data cannot authorize an automatic remediation send or consume a reservation',async()=>{
 const f=threadFixture();try{
  f.e.findings[0].path=null;
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason:'Review findings require concrete approved paths before automatic remediation'});
  await expect(sendPilotRemediation(f.s,f.id,f.head,JSON.stringify(f.e.findings),'owner/repo',1,['CI'],DEFAULT_REMEDIATION_POLICY,[],f.io)).rejects.toThrow('require concrete approved paths');
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{f.s.close();}
});
test('identical CodeRabbit bodies preserve all legacy receipt IDs across restart without another remediation',async()=>{
 const f=threadFixture();try{
  const p=reviewerPolicy(undefined),now=Date.now(),trust=p.map(r=>({reviewer:r.id,observed:now,ids:[r.identity!.userId],blocker:null}));
  const feedback=['C1','C2'].map(id=>({id,threadId:'T1',body:'Fix the ownership guard',userId:BOT_IDENTITIES.coderabbit.userId,type:'Bot',login:'coderabbitai[bot]',path:'src/workflow.ts',line:12,originalCommit:'old',outdated:false,resolved:false,original:{id,body:'Fix the ownership guard'}}));
  f.e.findings=collectTrustedFeedback(p,trust,feedback,{repo:'owner/repo',pr:1,head:f.head,selfIds:[]},now).findings;
  expect(f.e.findings[0].commentIds).toEqual(['C1','C2']);
  f.s.db.query('INSERT INTO review_feedback(job,thread_id,comments_hash,path,head,attempt) VALUES (?,?,?,?,?,?)').run(f.id,'T1',digest('C1,C2'),'src/workflow.ts',f.head,1);
  for(const loop of [f.loop,new ReviewLoop(f.s,async()=>{},f.loop.io)]){
   const result=await loop.tick(f.id);expect(result).toMatchObject({state:'blocked',send:false});expect(result.reason).toContain('carried-forward already sent');
  }
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.s.close();}
});
test('carried-forward review thread dispatches exactly one provenance-bound remediation',async()=>{
 const f=threadFixture();try{
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});
  expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
  expect(f.s.db.query('SELECT thread_id,comments_hash,path,head,attempt,state FROM review_feedback').get()).toEqual({thread_id:'T1',comments_hash:f.candidate.commentsHash,path:'src/workflow.ts',head:f.head,attempt:1,state:'dispatched'});
  expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'delivery_uncertain'});
  // Uncertain delivery is reconciled, never resent.
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_worker');expect(f.sends()).toBe(1);
  // Worker completes and pushes. The same thread remains unresolved and mapped,
  // so it is not sent again; a human must confirm the current code.
  f.session.transcript.turns[0].state='completed';const newer='c'.repeat(40);f.e.head=newer;f.e.findings[0].sha=newer;
  const result=await f.loop.tick(f.id);expect(result).toMatchObject({state:'blocked',send:false});
  expect(f.loop.get(f.id).reason).toContain('human decision');expect(f.loop.get(f.id).reason).toContain('carried-forward already sent for verification');
  expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
  // Dispositions are durable: a restarted loop reads the same identity.
  const restarted=new ReviewLoop(f.s,async()=>{},f.loop.io as any);
  expect((await restarted.tick(f.id)).state).toBe('blocked');expect(f.sends()).toBe(1);
 }finally{f.s.close();}
});
test('a stale CHANGES_REQUESTED review still surfaces its unresolved thread for remediation',async()=>{
 const f=threadFixture();try{
  const schedule=pr30Schedule(f.head);schedule.evidence.review={id:10,state:'CHANGES_REQUESTED',commit:'b'.repeat(40),submittedAt:Date.now()-1000,stale:true};
  f.e.reviewSchedule=schedule;
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});
  expect(f.sends()).toBe(1);expect(f.reviews()).toBe(0);
 }finally{f.s.close();}
});
for(const missing of ['initial','withdrawn','invalid'])test(`container remediation validates context before reservation/feedback claim: ${missing}`,async()=>{
 const f=threadFixture();try{
  const verification:any={version:1,mode:'container',steps:[{cwd:'.',argv:['node','--test']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['src']}};
  const context={projectConfig:'/trusted/project.json',runtimeConfig:'/trusted/runtime.json',bun:'/trusted/bun',cli:'/trusted/installed/src/cli.ts'};
  f.loop.setVerification(f.id,verification,missing==='initial'?undefined:context);
  new Lifecycle(f.s).recordRemediationPolicy(f.id,DEFAULT_REMEDIATION_POLICY);
  const budget=()=>f.s.db.query('SELECT consumed,extensions,no_progress,last_head,last_findings_hash,last_attempt,stop_reason FROM remediation_budget').all(),before=budget();
  const submit=f.io.submit;f.io.submit=async(operation:any)=>{
   if(missing==='withdrawn')f.loop.setVerification(f.id,verification);
   if(missing==='invalid')f.s.db.query('UPDATE review_verification_runtime SET context=? WHERE job=?').run(JSON.stringify({...context,cli:'relative/cli.ts'}),f.id);
   return submit(operation);
  };
  if(missing==='invalid')await expect(f.loop.tick(f.id)).rejects.toThrow('Validated absolute verification context paths required');
  else expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason:expect.stringContaining('requires validated runtime context')});
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
  expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM review_feedback').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM remediation_context').all()).toEqual([]);
  expect(budget()).toEqual(before);
  // The same unchanged head/findings can be retried after supplying context.
  f.io.submit=submit;f.loop.setVerification(f.id,verification,context);let prompt='';const spawn=f.io.spawn;
  f.io.spawn=(args:string[])=>{prompt=args[args.indexOf('--message')+1];return spawn(args);};
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});
  expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
  expect(f.s.db.query('SELECT state FROM remediation').all()).toEqual([{state:'delivery_uncertain'}]);
  expect(f.s.db.query('SELECT thread_id,attempt FROM review_feedback').all()).toEqual([{thread_id:'T1',attempt:1}]);
  expect(prompt).toContain(JSON.stringify([context.bun,context.cli,'verification',context.projectConfig,'/worktree','--run','--runtime',context.runtimeConfig]));
 }finally{f.s.close();}
});
test('metadata-only remediation does not require container runtime context',async()=>{
 const f=templateFixture();try{
  f.loop.setVerification(f.id,{version:1,mode:'container',steps:[{cwd:'.',argv:['node','--test']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['src']}});
  expect(await f.loop.tick(f.id)).toMatchObject({state:'remediation_pending',send:true});
  expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
 }finally{f.s.close();}
});
test('a pre-send lease rejection releases the unsent remediation attempt for a later retry',async()=>{
 const f=threadFixture();try{
  const findings=JSON.stringify(f.e.findings),before=f.s.get(f.id).attempts;
  await expect(sendPilotRemediation(f.s,f.id,f.head,findings,'owner/repo',1,['CI'],undefined,[],{...f.io,spawn:()=>{throw new ObservationLeaseLost(false);}})).rejects.toBeInstanceOf(ObservationLeaseLost);
  expect(f.s.get(f.id).attempts).toBe(before);
  expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM review_feedback').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM delivery_receipts').all()).toEqual([]);
  expect(f.s.db.query('SELECT consumed,no_progress,last_attempt FROM remediation_budget WHERE job=?').get(f.id)).toMatchObject({consumed:0,no_progress:0,last_attempt:null});
  expect(f.s.db.query("SELECT kind FROM events WHERE kind='remediation_released_unsent'").get()).not.toBeNull();
  const retried=await sendPilotRemediation(f.s,f.id,f.head,findings,'owner/repo',1,['CI'],undefined,[],f.io);
  expect(retried).toMatchObject({state:'delivery_uncertain',attempt:1});expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
 }finally{f.s.close();}
});
test('a possible post-send lease loss keeps delivery uncertainty',async()=>{
 const f=threadFixture();try{
  const findings=JSON.stringify(f.e.findings);
  await expect(sendPilotRemediation(f.s,f.id,f.head,findings,'owner/repo',1,['CI'],undefined,[],{...f.io,spawn:()=>{throw new ObservationLeaseLost(true);}})).rejects.toBeInstanceOf(ObservationLeaseLost);
  expect(f.s.db.query('SELECT state FROM remediation').all()).toEqual([{state:'delivery_uncertain'}]);
  expect(f.s.get(f.id).attempts).toBe(1);
  expect(f.s.db.query('SELECT attempt FROM review_feedback').all()).toEqual([{attempt:1}]);
 }finally{f.s.close();}
});
test('a duplicate remediation reservation never spawns a second worker for the same feedback',async()=>{
 const f=threadFixture();try{
  const findings=JSON.stringify(f.e.findings);
  const first=await sendPilotRemediation(f.s,f.id,f.head,findings,'owner/repo',1,['CI'],undefined,[],f.io);
  expect(first.state).toBe('delivery_uncertain');expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
  f.session.transcript.turns[0].state='completed';
  const second=await sendPilotRemediation(f.s,f.id,f.head,findings,'owner/repo',1,['CI'],undefined,[],f.io);
  expect(second).toMatchObject({reused:true,state:'delivery_uncertain'});expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
 }finally{f.s.close();}
});
test('outdated and human-only unresolved threads block immediately without another full review',async()=>{
 const f=threadFixture();try{
  f.e.findings=[];f.e.reviewThreads={unresolved:2,resolved:0,candidates:[],stale:[{threadId:'T2',path:'src/old.ts',commentIds:['C9']}],humanOnly:[{threadId:'H1',path:'src/human.ts'}]};
  const result=await f.loop.tick(f.id);
  expect(result).toMatchObject({state:'blocked',send:false});
  expect(result.reason).toContain('1 human-only');expect(result.reason).toContain('1 outdated or ambiguous');
  expect(result.reason).toContain('src/human.ts');expect(result.reason).toContain('src/old.ts');
  expect(f.sends()).toBe(0);expect(f.reviews()).toBe(0);
 }finally{f.s.close();}
});
test('a carried thread outside the approved file scope is blocked before delivery',async()=>{
 const f=threadFixture();try{
  f.e.findings[0].path='backend/secrets.py';
  expect(await f.loop.tick(f.id)).toMatchObject({state:'blocked',send:false,reason:'Review findings exceed approved file scope'});
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.s.close();}
});
test('a head change between collection and delivery rejects the stale authorization',async()=>{
 const f=threadFixture();try{
  let calls=0;const base=f.io.readiness;const changed=async(...args:any[])=>{calls++;const result=await base(...args);return calls===1?result:{...result,head:'c'.repeat(40)};};f.io.readiness=changed;f.loop.io.readiness=changed;
  await expect(f.loop.tick(f.id)).rejects.toThrow('Current uncleared PR head required');
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{f.s.close();}
});
test('a changed reviewer-comment set at the same head rejects stale feedback provenance',async()=>{
 const f=threadFixture();try{
  let calls=0;const base=f.io.readiness;const changed=async(...args:any[])=>{calls++;const result=await base(...args);if(calls===1)return result;return {...result,findings:[{...result.findings[0],commentsHash:'e'.repeat(64)}]};};f.io.readiness=changed;f.loop.io.readiness=changed;
  await expect(f.loop.tick(f.id)).rejects.toThrow('Review feedback changed');
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
 }finally{f.s.close();}
});
test('head drift reported during collection rejects delivery before spending budget',async()=>{
 const f=threadFixture();try{
  f.e.reasons=['Head changed'];
  await expect(sendPilotRemediation(f.s,f.id,f.head,JSON.stringify(f.e.findings),'owner/repo',1,['CI'],undefined,[],f.io)).rejects.toThrow('Current uncleared PR head required');
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
 }finally{f.s.close();}
});
for(const change of ['head','resolved','body','ambiguous','authorization'])test(`submission revalidates after awaited work: ${change}`,async()=>{
 const f=threadFixture();try{
  const findings=JSON.stringify(f.e.findings);
  f.io.submit=async(operation:any)=>{
   if(change==='head')f.e.head='c'.repeat(40);
   if(change==='resolved')f.e.findings=[];
   if(change==='body')f.e.findings[0].body='Edited comment, same stable ID';
   if(change==='ambiguous')f.e.findings.push({...f.e.findings[0]});
   if(change==='authorization')f.s.db.exec('DELETE FROM git_grants');
   return operation();
  };
  await expect(sendPilotRemediation(f.s,f.id,f.head,findings,'owner/repo',1,['CI'],undefined,[],f.io)).rejects.toThrow(change==='head'?'Current uncleared PR head required':change==='authorization'?'Current scoped GitHub authorization required':'Review feedback changed');
  expect(f.sends()).toBe(0);expect(f.s.get(f.id).attempts).toBe(0);
  expect(f.s.db.query('SELECT * FROM remediation').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM review_feedback').all()).toEqual([]);
 }finally{f.s.close();}
});
test('overlapping batches atomically reject a previously claimed thread without budget consumption',async()=>{
 const f=threadFixture();try{
  const first=JSON.stringify(f.e.findings);
  await sendPilotRemediation(f.s,f.id,f.head,first,'owner/repo',1,['CI'],undefined,[],f.io);
  f.session.transcript.turns[0].state='completed';
  f.s.db.exec("UPDATE remediation SET state='completed'");
  const before=f.s.db.query('SELECT * FROM remediation_budget').all();
  // New batch orders an unclaimed identity before the overlap. Both its claim
  // and the attempt/budget must roll back, not just the conflicting INSERT.
  f.e.findings.unshift({...f.e.findings[0],threadId:'T2',commentsHash:'e'.repeat(64)});
  await expect(sendPilotRemediation(f.s,f.id,f.head,JSON.stringify(f.e.findings),'owner/repo',1,['CI'],undefined,[],f.io)).rejects.toThrow('Review feedback already claimed');
  expect(f.sends()).toBe(1);expect(f.s.get(f.id).attempts).toBe(1);
  expect(f.s.db.query('SELECT * FROM remediation_budget').all()).toEqual(before);
  expect(f.s.db.query('SELECT * FROM remediation').all()).toHaveLength(1);
  expect(f.s.db.query('SELECT thread_id FROM review_feedback').all()).toEqual([{thread_id:'T1'}]);
 }finally{f.s.close();}
});
test('rate limiting and residual human decisions are distinct from remediation and waiting on a timeout',()=>{
 expect(decision({...pending(),coderabbitRateLimited:true},['a'],0)).toMatchObject({state:'waiting_for_coderabbit',send:false,reason:'CodeRabbit rate limited; wait for the provider limit to reset'});
 const remaining={category:'human',threadId:'H1',path:'src/human.ts'};
 expect(decision({...pending(),remainingFeedback:[remaining]},['a'],0)).toMatchObject({state:'blocked',send:false});
 expect(decision({...pending(),remainingFeedback:[remaining]},['a'],0).reason).toContain('human decision');
});

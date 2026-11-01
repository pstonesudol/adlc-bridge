import {test,expect} from 'bun:test';
import {decision,ReviewLoop} from '../src/review-loop';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
import {sendPilotRemediation} from '../src/pilot';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {turnBarrier} from '../src/turn-submission';
const pending=()=>({clear:false,reasons:['CodeRabbit absent'],failedChecks:[],findings:[]});
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
 let calls=0;const loop=new ReviewLoop(s,async()=>{calls++;throw Error('Reply lost');});loop.register(id,'owner/repo',1,['CI'],['a'],true);
 await expect(loop.requestReview(id,'sha','body')).rejects.toThrow('lost');
 expect(await loop.requestReview(id,'sha','body')).toBe(false);expect(calls).toBe(1);
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
 const session:any={session:{id:'session',branch:r.branch,isTerminated:false,prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',entries:[],turns:[]}};let sends=0,reviews=0;
 const io:any={readBranchSnapshot:async()=>({head,base:'b'.repeat(40),branch:r.branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:true,behind:0}),worktreeIdentity:async()=>({tree:'/worktree',branch:r.branch,head}),readiness:async()=>e,sessionEvidence:async()=>session,submit:async(operation:any)=>operation(),spawn:(args:string[])=>{
  sends++;const handle=args[args.indexOf('--client-message-id')+1],turnId=`fix-${sends}`;
  session.transcript.entries.push({clientMessageId:handle,turnId});session.transcript.turns.push({id:turnId,state:'running'});
  return {stdout:new Response('{}').body,stderr:new Response('').body,exited:Promise.resolve(0)};
 }};
 const loop=new ReviewLoop(s,async()=>{reviews++;},{readBranchSnapshot:io.readBranchSnapshot,worktreeIdentity:io.worktreeIdentity,readiness:io.readiness,sessionEvidence:io.sessionEvidence,disableNativeFeedback:async()=>({}),sendPilotRemediation:(...args:any[])=>sendPilotRemediation(...args as Parameters<typeof sendPilotRemediation>,io)} as any);
 loop.configureMetadataChecks('project',['PR body structure']);loop.register(id,'owner/repo',1,['CI'],['src/**'],true);
 return {s,id,head,e,session,loop,io,sends:()=>sends,reviews:()=>reviews};
}
// Inject an attested collector response for success-path tests. The production
// GitHub collector currently cannot supply this and returns a null body hash.
function bodyEvidence(e:any,names=['PR body structure']){return names.map((name,i)=>({name,checkId:i+2,sha:e.head,status:'completed',conclusion:'success',descriptionHash:e.descriptionHash}));}
function failureEvidence(e:any){return e.findings.map((f:any)=>({name:f.check,checkId:f.checkId,sha:f.sha,status:'completed',conclusion:'failure',descriptionHash:f.descriptionHash}));}
test('initial clear metadata checks cannot bypass body evidence without a preexisting wait',async()=>{
 const f=templateFixture();try{
  f.e.clear=true;f.e.failedChecks=[];f.e.findings=[];f.e.botReviewSubmittedAt=Date.now()+1000;
  expect(await f.loop.tick(f.id)).toMatchObject({state:'waiting_for_ci',send:false});const rows=f.s.db.query('SELECT * FROM metadata_waits').all();expect(rows).toHaveLength(1);
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_ci');expect(f.s.db.query('SELECT * FROM metadata_waits').all()).toEqual(rows);expect(f.reviews()).toBe(0);expect(f.sends()).toBe(0);
  f.s.db.query('UPDATE metadata_waits SET started=?').run(Date.now()-5*60*1000-1);expect((await f.loop.tick(f.id)).state).toBe('blocked');
  f.e.metadataCheckEvidence=bodyEvidence(f.e);expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
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
  expect((await f.loop.tick(f.id)).state).toBe('needs_reconciliation');expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'delivery_uncertain'});
  f.session.transcript.turns[0].state='completed';expect((await f.loop.tick(f.id)).state).toBe('blocked');expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'delivery_uncertain'});
  f.e.descriptionHash='edited-after-policy-removal';f.e.botReviewSubmittedAt=Date.now()-1000;
  expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.s.db.query('SELECT state FROM remediation').get()).toEqual({state:'completed'});expect(f.s.db.query('SELECT * FROM metadata_waits').all()).toEqual([]);
  expect(f.s.db.query('SELECT * FROM description_delivery_gates').all()).toHaveLength(1);await f.loop.tick(f.id);expect(f.reviews()).toBe(1);expect(f.sends()).toBe(1);
  f.loop.configureMetadataChecks('project',['Alternative']);f.e.metadataCheckEvidence=bodyEvidence(f.e,['Alternative']);expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');f.loop.configureMetadataChecks('project',[]);
  f.e.botReviewSubmittedAt=Date.now()+1000;expect((await f.loop.tick(f.id)).state).toBe('ready_for_human');
  f.e.descriptionHash='another-body';f.e.botReviewSubmittedAt=Date.now()-1000;expect((await f.loop.tick(f.id)).state).toBe('waiting_for_coderabbit');expect(f.reviews()).toBe(2);
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
  checks.length=0;f.loop.configureMetadataChecks('project',[]);release();await Promise.all([strict,empty]);
  expect(seen).toEqual([{required:['CI','Strict metadata'],metadata:['Strict metadata']},{required:['CI'],metadata:[]}]);expect(f.sends()).toBe(0);
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
  const events=f.s.db.query('SELECT count(*) AS n FROM events').get();expect(await f.loop.tick(f.id)).toMatchObject({state:'completed',send:false,head:newer});expect(await f.loop.requestReview(f.id,newer,'later-body')).toBe(false);expect(f.s.db.query('SELECT count(*) AS n FROM events').get()).toEqual(events);
 }finally{release?.();f.s.close();}
});
test('failed review requests revoke stale ready state but retain their reservation and never post twice',async()=>{
 for(const edited of [false,true]){const f=templateFixture();try{
  f.loop.configureMetadataChecks('project',[]);f.e.clear=edited;f.e.failedChecks=[];f.e.findings=[];f.e.reasons=['CodeRabbit review absent'];f.e.botReviewSubmittedAt=Date.now()-1000;
  if(edited)f.s.db.query('INSERT INTO description_delivery_gates VALUES (?,?,?,?)').run(f.id,f.head,'previous-body',Date.now()-1000);
  f.loop.record(f.id,{state:'ready_for_human',send:false,head:f.head,reason:'Previously approved'});let requests=0;
  f.loop.postReview=async()=>{requests++;expect(f.loop.get(f.id).state).toBe('needs_reconciliation');throw Error('GitHub request receipt lost');};
  await expect(f.loop.tick(f.id)).rejects.toThrow('receipt lost');expect(f.loop.get(f.id).state).toBe('needs_reconciliation');
  expect(f.s.db.query('SELECT state FROM full_review_requests').get()).toEqual({state:'delivery_uncertain'});expect((await f.loop.tick(f.id)).state).not.toBe('ready_for_human');expect(requests).toBe(1);expect(f.sends()).toBe(0);
 }finally{f.s.close();}}
});
test('a late failed review request cannot reopen a concurrently completed target',async()=>{
 const f=templateFixture();try{
  let terminal:any;f.loop.postReview=async()=>{f.loop.record(f.id,{state:'completed',send:false,head:f.head,reason:'Merge observed'});terminal=f.loop.get(f.id);throw Error('Late GitHub failure');};
  await expect(f.loop.requestReview(f.id,f.head,f.e.descriptionHash)).rejects.toThrow('Late GitHub failure');expect(f.loop.get(f.id)).toEqual(terminal);expect(f.s.db.query('SELECT state FROM full_review_requests').get()).toEqual({state:'delivery_uncertain'});
 }finally{f.s.close();}
});

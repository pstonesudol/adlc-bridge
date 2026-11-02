import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../src/core';import {Planning} from '../src/planning';import {Lifecycle} from '../src/lifecycle';import {ReviewLoop} from '../src/review-loop';import {turnBarrier} from '../src/turn-submission';
async function remaining(reader:ReadableStreamDefaultReader<Uint8Array>){
 const decoder=new TextDecoder();let text='';try{for(;;){const {done,value}=await reader.read();if(done)return text+decoder.decode();text+=decoder.decode(value,{stream:true});}}finally{reader.releaseLock();}
}

for(const signal of ['SIGINT','SIGTERM'] as const)for(const fail of [false,true])test(`tick-review drains ${fail?'failed':'successful'} receipt on ${signal}, retaining delivery uncertainty`,async()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'adlc-review-signal-'))),state=join(home,'Library/Application Support/ADLC Bridge'),db=join(home,'state.sqlite'),repo=join(home,'repo'),config=join(home,'project.json'),preload=join(home,'providers.ts');
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  mkdirSync(repo);const uuid='00000000-0000-0000-0000-000000000001',head='a'.repeat(40);
  writeFileSync(config,JSON.stringify({version:1,name:'Fixture',repo,githubRepo:'owner/repo',requiredChecks:['CI'],prMetadataChecks:[],linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid},verification:{version:1,mode:'host',steps:[{cwd:'.',argv:['bun','test']}]}}));
  const s=new Store(db),p=new Planning(s),job=s.enqueue(uuid,'issue','spec'),r=p.reserve(job,'ao');p.gate(job,'ao','session',r.branch,'/worktree');const hash=s.propose(job,'plan');s.approve(job,hash,'human');const lifecycle=new Lifecycle(s);lifecycle.grantGit(job,hash,['commit','push-feature'],'human');lifecycle.adoptSupervised(job,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
  const loop=new ReviewLoop(s);loop.configureMetadataChecks(uuid,[]);loop.register(job,'owner/repo',1,['CI'],['src/**'],true);s.close();
  // Preload replaces only provider/worker I/O. Run the actual CLI command,
  // ReviewLoop, pilot reservation/reconciliation and production submission fence.
  writeFileSync(preload,`
import {ReviewLoop} from ${JSON.stringify(join(import.meta.dir,'../src/review-loop.ts'))};
import {sendPilotRemediation} from ${JSON.stringify(join(import.meta.dir,'../src/pilot.ts'))};
const head=${JSON.stringify(head)},branch=${JSON.stringify(r.branch)};
const finding={source:'github-review',kind:'review_thread',threadId:'T1',commentsHash:'d'.repeat(64),path:'src/fix.ts',body:'Fix the scoped defect',sha:head};
const session={session:{id:'session',branch,isTerminated:false,prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',entries:[],turns:[]}};
let sends=0;
const providers={readBranchSnapshot:async()=>({head,base:'b'.repeat(40),branch,baseBranch:'main',defaultBranch:'main',headRepo:'owner/repo',baseRepo:'owner/repo',state:'open',draft:false,mergeable:true,behind:0}),worktreeIdentity:async()=>({tree:'/worktree',branch,head}),sessionEvidence:async()=>session,readiness:async()=>({head,clear:false,reasons:['Unresolved or unknown findings'],descriptionHash:'body',templateSignature:'sig',findings:[finding],failedChecks:[],pendingChecks:[],missingChecks:[],coderabbitPending:false,coderabbitPresent:true}),spawn:()=>{
 console.log('send-ready:'+ ++sends);
 const exited=new Response(Bun.stdin.stream()).text().then(()=>{if(${fail})throw Error('mock receipt failure');return 0;});
 return {stdout:new Response('{}').body,stderr:new Response('').body,exited};
}};
const tick=ReviewLoop.prototype.tick;
ReviewLoop.prototype.tick=async function(...args){this.io={...this.io,...providers,disableNativeFeedback:async()=>({}),sendPilotRemediation:(...a)=>sendPilotRemediation(...a,providers)};return tick.apply(this,args);};
`);
  child=Bun.spawn([process.execPath,'--preload',preload,join(import.meta.dir,'../src/cli.ts'),'tick-review',job,config],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_DB:db},timeout:10000});
  const stdout=(child.stdout as ReadableStream<Uint8Array>).getReader(),ready=await stdout.read();expect(new TextDecoder().decode(ready.value)).toBe('send-ready:1\n');
  const rows=()=>{const read=Store.readonly(db);try{return {attempts:read.get(job).attempts,delivery:read.db.query('SELECT attempt,state FROM remediation').all(),feedback:read.db.query('SELECT thread_id,attempt,state FROM review_feedback').all()};}finally{read.close();}};
  const before=rows();expect(before).toEqual({attempts:1,delivery:[{attempt:1,state:'delivery_uncertain'}],feedback:[{thread_id:'T1',attempt:1,state:'dispatched'}]});
  const stderr=(child.stderr as ReadableStream<Uint8Array>).getReader();let notices='';
  for(let i=0;i<2;i++){
   child.kill(signal);const notice=await stderr.read(),text=new TextDecoder().decode(notice.value);notices+=text;
   expect(notice.done).toBe(false);expect(text).toContain(`${signal}: waiting for the in-flight review tick`);expect(child.exitCode).toBeNull();
   expect(existsSync(join(state,'turn-submission.lock'))).toBe(true);
   await expect(turnBarrier(state).run(async()=>{})).rejects.toThrow('in progress');expect(rows()).toEqual(before);
  }
  (child.stdin as any).end();
  const [out,err,code]=await Promise.all([remaining(stdout),remaining(stderr),child.exited]);
  expect(code).toBe(signal==='SIGINT'?130:143);expect(child.signalCode).toBeNull();expect(notices.split('waiting').length-1).toBe(2);
  if(fail){expect(err).toContain('mock receipt failure');expect(out).toBe('');}
  else{expect(err).toBe('');expect(JSON.parse(out)).toMatchObject({state:'remediation_pending',send:true,delivery:{state:'delivery_uncertain'}});}
  expect(rows()).toEqual(before);expect(existsSync(join(state,'turn-submission.lock'))).toBe(false);await turnBarrier(state).run(async()=>{});
  // A fresh process cannot resend the uncertain delivery after interruption.
  const retry=Bun.spawnSync([process.execPath,'--preload',preload,join(import.meta.dir,'../src/cli.ts'),'tick-review',job,config],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_DB:db},stdout:'pipe',stderr:'pipe',timeout:5000});
  expect(retry.exitCode).toBe(0);expect(retry.stderr.toString()).toBe('');expect(JSON.parse(retry.stdout.toString())).toMatchObject({state:'needs_reconciliation',send:false});expect(rows()).toEqual(before);
 }finally{if(child&&child.exitCode===null){(child.stdin as any).end();await child.exited;}rmSync(home,{recursive:true,force:true});}
},15000);

test('review-tick signal listeners are scoped and errors keep normal fence cleanup',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'adlc-review-signal-scope-')));
 try{
  const script=`import {runCLIReviewTick} from ${JSON.stringify(join(import.meta.dir,'../src/cli.ts'))};import {turnBarrier} from ${JSON.stringify(join(import.meta.dir,'../src/turn-submission.ts'))};
const listeners=()=>['SIGINT','SIGTERM'].map(s=>process.listenerCount(s)),before=listeners();const result=await runCLIReviewTick(async()=>42),normal=listeners();const error=Error('fixture failure');let sameError=false;try{await runCLIReviewTick(async()=>{throw error;});}catch(e){sameError=e===error;}const failed=listeners();await turnBarrier().run(async()=>{});console.log(JSON.stringify({before,result,normal,failed,sameError}));`;
  const child=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home},stdout:'pipe',stderr:'pipe'});
  expect(child.exitCode).toBe(0);expect(child.stderr.toString()).toBe('');const result=JSON.parse(child.stdout.toString());expect(result.result).toBe(42);expect(result.sameError).toBe(true);expect(result.normal).toEqual(result.before);expect(result.failed).toEqual(result.before);
 }finally{rmSync(home,{recursive:true,force:true});}
});

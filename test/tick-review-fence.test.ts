import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';

test('manual tick-review cannot change verification/policy during a poll or submission pause, and resumes after release',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'adlc-review-fence-')));
 try{
  const cli=join(import.meta.dir,'../src/cli.ts');
  const script=`
import {createCLIPollTick} from ${JSON.stringify(cli)};
import {turnBarrier} from ${JSON.stringify(join(import.meta.dir,'../src/turn-submission.ts'))};
import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};
import {Planning} from ${JSON.stringify(join(import.meta.dir,'../src/planning.ts'))};
import {Lifecycle} from ${JSON.stringify(join(import.meta.dir,'../src/lifecycle.ts'))};
import {ReviewLoop} from ${JSON.stringify(join(import.meta.dir,'../src/review-loop.ts'))};
import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const home=${JSON.stringify(home)},cli=${JSON.stringify(cli)},db=join(home,'state.sqlite'),repo=join(home,'repo'),project=join(home,'manual.json'),runtime=join(home,'manual-runtime.json'),uuid='00000000-0000-0000-0000-000000000001';mkdirSync(repo);
const verification={version:1,mode:'container',steps:[{cwd:'.',argv:['node','--test']}],container:{image:'sha256:'+'a'.repeat(64),inputs:['src']}};
const context={projectConfig:'/poll/project.json',runtimeConfig:'/poll/runtime.json',bun:'/poll/bun',cli:'/poll/src/cli.ts'};
const config={version:1,name:'Fixture',repo,githubRepo:'owner/repo',requiredChecks:['CI'],prMetadataChecks:['manual metadata'],linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid},verification:{...verification,steps:[{cwd:'.',argv:['node','--test','manual']} ]}};
writeFileSync(project,JSON.stringify(config));writeFileSync(runtime,JSON.stringify({version:1,platform:'launchd',projectConfig:project,controller:'/manual/src/cli.ts',workingDirectory:repo,tools:Object.fromEntries(['bun','ao','git','gh'].map(k=>[k,{path:'/manual/'+k,version:'1.0.0'}])),service:{label:'local.adlc.fixture',path:join(home,'staged.plist'),interval:60,runAtLoad:false,stdout:join(home,'out'),stderr:join(home,'err')}}));
const s=new Store(db),p=new Planning(s),job=s.enqueue(uuid,'issue','spec'),r=p.reserve(job,'ao');p.gate(job,'ao','session',r.branch,'/worktree');const hash=s.propose(job,'plan');s.approve(job,hash,'human');new Lifecycle(s).adoptSupervised(job,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
const loop=new ReviewLoop(s);loop.configureMetadataChecks(uuid,['poll metadata']);loop.register(job,'owner/repo',1,['CI'],['src/**'],true,verification,context);loop.record(job,{state:'completed',send:false,reason:'fixture terminal target'});
const snapshot=()=>JSON.stringify({verification:s.db.query('SELECT * FROM review_verification').all(),runtime:s.db.query('SELECT * FROM review_verification_runtime').all(),policy:s.db.query('SELECT * FROM metadata_check_policy').all(),target:loop.get(job),attempts:s.get(job).attempts});
const manual=()=>{const result=Bun.spawnSync([process.execPath,cli,'tick-review',job,project,'--runtime',runtime],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_DB:db},stdout:'pipe',stderr:'pipe'});return {code:result.exitCode,out:result.stdout.toString(),err:result.stderr.toString()};};
let release,enter;const waiting=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
const tick=createCLIPollTick({config:{...config,prMetadataChecks:['poll metadata'],verification,verificationContext:context},store:s,reviewLoop:loop,workflow:{tick:async()=>[]},linearApprovals:{sync:async()=>[]},linearLifecycle:{sync:async()=>{enter();await gate;return [];}},features:{tickProject:async()=>[]},io:{poll:async()=>0,linearToken:()=>'',out:()=>{}}});
const pending=tick();await waiting;const before=snapshot(),overlap=manual(),afterOverlap=snapshot();release();await pending;
turnBarrier().pause();const pausedBefore=snapshot(),paused=manual(),afterPause=snapshot();turnBarrier().resume();
// The real command now acquires the released fence, writes its own settings and
// observes the terminal fixture target without contacting providers.
const resumed=manual(),finalVerification=JSON.parse(s.db.query('SELECT configuration FROM review_verification WHERE job=?').get(job).configuration),finalRuntime=JSON.parse(s.db.query('SELECT context FROM review_verification_runtime WHERE job=?').get(job).context);
console.log(JSON.stringify({overlap,paused,resumed,overlapUnchanged:before===afterOverlap,pauseUnchanged:pausedBefore===afterPause,finalVerification,finalRuntime,policy:JSON.parse(s.db.query('SELECT checks FROM metadata_check_policy WHERE project=?').get(uuid).checks)}));s.close();`;
  const p=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home},stdout:'pipe',stderr:'pipe',timeout:15000});
  expect(p.exitCode).toBe(0);expect(p.stderr.toString()).toBe('');const result=JSON.parse(p.stdout.toString());
  expect(result.overlap.code).toBe(1);expect(result.overlap.err).toContain('in progress');expect(result.overlapUnchanged).toBe(true);
  expect(result.paused.code).toBe(1);expect(result.paused.err).toContain('paused');expect(result.pauseUnchanged).toBe(true);
  expect(result.resumed.code).toBe(0);expect(JSON.parse(result.resumed.out)).toMatchObject({state:'completed',send:false});
  expect(result.finalVerification.steps[0].argv).toEqual(['node','--test','manual']);expect(result.finalRuntime.cli).toBe('/manual/src/cli.ts');expect(result.policy).toEqual(['manual metadata']);
 }finally{rmSync(home,{recursive:true,force:true});}
});

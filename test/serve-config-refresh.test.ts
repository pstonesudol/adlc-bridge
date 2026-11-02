import {test,expect} from 'bun:test';import {mkdtempSync,rmSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('serve ticks reload validated verification and runtime context; invalid config and changed project identity fail before mutations',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'adlc-serve-reload-')));
 try{
  const script=`
import {createCLIPollTick} from ${JSON.stringify(join(import.meta.dir,'../src/cli.ts'))};import {withVerificationContext} from ${JSON.stringify(join(import.meta.dir,'../src/setup.ts'))};
import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};import {ReviewLoop} from ${JSON.stringify(join(import.meta.dir,'../src/review-loop.ts'))};
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
const root=${JSON.stringify(home)},repo=join(root,'repo'),path=join(root,'project.json'),runtime=join(root,'runtime.json');mkdirSync(repo);const uuid='00000000-0000-0000-0000-000000000001';
let c={version:1,name:'Fixture',repo,githubRepo:'owner/repo',requiredChecks:['CI'],automation:{orchestratorProject:'project'},linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid},verification:{version:1,mode:'host',steps:[{cwd:'.',argv:['bun','test']}]}};
let r={version:1,platform:'launchd',projectConfig:path,controller:'/trusted/old/src/cli.ts',workingDirectory:root,tools:Object.fromEntries(['bun','ao','git','gh'].map(k=>[k,{path:'/trusted/'+k,version:'1.4.2'}])),service:{label:'local.adlc.fixture',path:join(root,'staged.plist'),interval:60,runAtLoad:false,stdout:join(root,'out'),stderr:join(root,'err')}};
const save=()=>{writeFileSync(path,JSON.stringify(c));writeFileSync(runtime,JSON.stringify(r));};save();const load=()=>withVerificationContext(JSON.parse(readFileSync(path,'utf8')),path,runtime);
const s=new Store(':memory:'),loop=new ReviewLoop(s),job=s.enqueue(uuid,'issue','spec'),observed=[];let polls=0;
const tick=createCLIPollTick({config:load(),loadConfig:load,store:s,reviewLoop:{configureMetadataChecks:()=>{},register:()=>{throw Error('Unexpected registration');},list:()=>[{job}],setVerification:(...args)=>loop.setVerification(...args),tick:async()=>({})},workflow:{tick:async()=>[],implementation:()=>{}},linearApprovals:{sync:async()=>[]},linearLifecycle:{sync:async()=>[]},features:{tickProject:async()=>[]},io:{poll:async()=>{polls++;return 0;},linearToken:()=>'',out:()=>{}}});
const capture=()=>{const v=s.db.query('SELECT configuration FROM review_verification WHERE job=?').get(job),ctx=s.db.query('SELECT context FROM review_verification_runtime WHERE job=?').get(job);observed.push({argv:v?JSON.parse(v.configuration).steps[0].argv:null,cli:ctx?JSON.parse(ctx.context).cli:null});};
await tick();capture();c.verification.steps[0].argv=['bun','test','--coverage'];r.controller='/trusted/new/src/cli.ts';save();await tick();capture();delete c.verification;save();await tick();capture();
c.verification={version:99,mode:'host',steps:[{cwd:'.',argv:['bun']}]};save();let invalid='';try{await tick();}catch(e){invalid=e.message;}delete c.verification;c.repo=join(root,'other');mkdirSync(c.repo);save();let identity='';try{await tick();}catch(e){identity=e.message;}
console.log(JSON.stringify({observed,polls,invalid,identity}));s.close();`;
  const p=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home},stdout:'pipe',stderr:'pipe'});
  expect(p.exitCode).toBe(0);expect(p.stderr.toString()).toBe('');const result=JSON.parse(p.stdout.toString());
  expect(result.observed).toEqual([{argv:['bun','test'],cli:'/trusted/old/src/cli.ts'},{argv:['bun','test','--coverage'],cli:'/trusted/new/src/cli.ts'},{argv:null,cli:null}]);expect(result.polls).toBe(3);expect(result.invalid).toContain('verification');expect(result.identity).toContain('Project identity changed');
 }finally{rmSync(home,{recursive:true,force:true});}
});

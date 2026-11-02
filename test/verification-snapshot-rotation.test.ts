import {test,expect} from 'bun:test';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,cpSync,appendFileSync} from 'node:fs';import {join,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';import {snapshot} from '../src/install';
test('verification follows the executing owner-pinned snapshot through rotation/rollback without editing runtime JSON',()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'adlc-verify-rotation-')));
 try{
  const state=join(home,'Library/Application Support/ADLC Bridge'),versions=join(state,'versions'),source=join(home,'source'),repo=join(home,'repo'),project=join(home,'project.json'),runtime=join(home,'runtime.json');mkdirSync(repo);
  const old=snapshot(resolve(import.meta.dir,'..'),versions);cpSync(dirname(dirname(old.cli)),source,{recursive:true});appendFileSync(join(source,'README.md'),'\nfixture new snapshot\n');const next=snapshot(source,versions);
  const uuid='00000000-0000-0000-0000-000000000001';writeFileSync(project,JSON.stringify({version:1,name:'Fixture',repo,requiredChecks:['CI'],linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid}}));
  writeFileSync(runtime,JSON.stringify({version:1,platform:'launchd',projectConfig:project,controller:old.cli,workingDirectory:repo,tools:Object.fromEntries(['bun','ao','git','gh'].map(k=>[k,{path:'/trusted/'+k,version:'1.4.2'}])),service:{label:'local.adlc.fixture',path:join(home,'staged.plist'),interval:60,runAtLoad:false,stdout:join(home,'out'),stderr:join(home,'err')}}));const bytes=readFileSync(runtime),oldCLI=readFileSync(old.cli);
  const pin=(cli:string)=>writeFileSync(join(state,'installation.json'),JSON.stringify({source,cli}),{mode:0o600});
  const runner=(cli:string)=>{const script=`import {withVerificationContext} from ${JSON.stringify(join(dirname(cli),'setup.ts'))};import {readFileSync} from 'node:fs';console.log(JSON.stringify(withVerificationContext(JSON.parse(readFileSync(${JSON.stringify(project)},'utf8')),${JSON.stringify(project)},${JSON.stringify(runtime)}).verificationContext.cli));`;const p=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home},stdout:'pipe',stderr:'pipe'});expect(p.exitCode).toBe(0);return JSON.parse(p.stdout.toString());};
  pin(old.cli);expect(runner(old.cli)).toBe(old.cli);pin(next.cli);rmSync(old.cli);expect(runner(next.cli)).toBe(next.cli);expect(readFileSync(runtime)).toEqual(bytes);
  writeFileSync(old.cli,oldCLI);pin(old.cli);expect(runner(old.cli)).toBe(old.cli);expect(readFileSync(runtime)).toEqual(bytes);
 }finally{rmSync(home,{recursive:true,force:true});}
});

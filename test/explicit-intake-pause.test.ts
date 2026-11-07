import {test,expect} from 'bun:test';
import {mkdtempSync,realpathSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../src/core';
import {ProjectServices} from '../src/project-services';
import {FeaturePlanning} from '../src/feature-planning';
import {ReviewLoop} from '../src/review-loop';
import {setProjectIntakePaused,turnBarrier} from '../src/turn-submission';

test('explicit intake and delivery commands honor project pauses inside the submission fence',async()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'explicit-intake-pause-')));
 try{
  const db=join(home,'state.sqlite'),state=join(home,'Library/Application Support/ADLC Bridge'),config=join(home,'project.json'),input=join(home,'input.txt'),calls=join(home,'provider-calls'),preload=join(home,'provider-stub.ts'),uuid='00000000-0000-0000-0000-000000000001';
  const c={version:1,name:'fixture',repo:home,githubRepo:'owner/repo',requiredChecks:['CI'],automation:{orchestratorProject:'paused-project'},linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid}};
  writeFileSync(config,JSON.stringify(c));writeFileSync(input,'Bounded fixture requirements');
  writeFileSync(preload,`import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(calls)},'fetch');throw Error('fixture forbids provider access');};`);
  const s=new Store(db);new ProjectServices(s).register(config);const job=s.enqueue(uuid,'original','specification');
  new FeaturePlanning(s,{} as any);s.db.query('INSERT INTO feature_plans(id,project,requirements,target,repo,route,state,max_tickets) VALUES (?,?,?,?,?,?,?,?)').run('feature',uuid,'{}','{}',home,'{}','planning',1);
  s.db.query('INSERT INTO feature_agents(plan,role,name,client_id,state) VALUES (?,?,?,?,?)').run('feature','architecture','fixture','fixture-client','reserved');
  new ReviewLoop(s);s.db.query('INSERT INTO review_targets(job,repo,pr,required_checks,allowed_paths,head_since) VALUES (?,?,?,?,?,?)').run(job,'owner/repo',1,'["CI"]','["src/**"]',0);s.close();
  const env={HOME:home,PATH:process.env.PATH??'/usr/bin:/bin',ADLC_DB:db,ADLC_LINEAR_TOKEN:'fixture-token',ADLC_AO_PATH:join(home,'nonexistent-daemon')};
  const run=(...args:string[])=>Bun.spawnSync([process.execPath,'--preload',preload,join(import.meta.dir,'../src/cli.ts'),...args],{env,timeout:10000});
  setProjectIntakePaused('paused-project',true,state);
  const commands=[['ingest',uuid,'new-issue',input],['ingest','paused-project','new-issue',input],['dependency-resume',job,config,'a'.repeat(64)],['feature-start',config,input],['feature-step','feature'],['tick-review',job,config]];
  await turnBarrier(state).run(async()=>{
   for(const command of commands){const r=run(...command);expect(r.exitCode).toBe(1);expect(r.stderr.toString()).toContain('in progress');expect(r.stderr.toString()).not.toContain('intentionally paused');}
  });
  for(const command of commands){const r=run(...command);expect(r.exitCode).toBe(1);expect(r.stderr.toString()).toContain('Project intake is intentionally paused');expect(existsSync(calls)).toBe(false);expect(existsSync(join(state,'turn-submission.lock'))).toBe(false);}
  const after=Store.readonly(db);try{
   expect(after.list()).toHaveLength(1);expect(after.db.query('SELECT state FROM feature_agents').all()).toEqual([{state:'reserved'}]);expect(after.db.query('SELECT * FROM feature_leases').all()).toEqual([]);
   for(const table of ['continuations','dependency_updates','remediation','spec_replans'])if(after.db.query('SELECT name FROM sqlite_master WHERE name=?').get(table))expect(after.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
  }finally{after.close();}
  // Other projects and read-only diagnostics stay available while this project
  // is stopped. No provider is consulted for either local operation.
  const other=run('ingest','unregistered-other-project','other-issue',input);expect(other.exitCode).toBe(0);expect(JSON.parse(other.stdout.toString()).id).toBeTruthy();
  expect(run('feature-show','feature').exitCode).toBe(0);expect(run('dependency-status').exitCode).toBe(0);expect(existsSync(calls)).toBe(false);
  // A replanning confirmation may deliver a new turn, unlike a preview or
  // receipt-only recovery. Stub only its evidence, not the production guard.
  const script=`import {Store} from ${JSON.stringify(join(import.meta.dir,'../src/core.ts'))};import {SpecRecovery} from ${JSON.stringify(join(import.meta.dir,'../src/spec-recovery.ts'))};
const s=new Store(${JSON.stringify(db)}),r=new SpecRecovery(s,{});r.preview=async()=>({proof:{},confirmation:'proof'});let error='';try{await r.reconcile(${JSON.stringify(job)},${JSON.stringify(c)},'proof');}catch(e){error=e.message;}const preview=await r.reconcile(${JSON.stringify(job)},${JSON.stringify(c)});console.log(JSON.stringify({error,preview:preview.confirmation,deliveries:s.db.query('SELECT * FROM spec_replans').all()}));s.close();`;
  const replanning=Bun.spawnSync([process.execPath,'-e',script],{env,timeout:10000});expect(replanning.exitCode).toBe(0);expect(JSON.parse(replanning.stdout.toString())).toMatchObject({error:expect.stringContaining('intentionally paused'),preview:'proof',deliveries:[]});
 }finally{rmSync(home,{recursive:true,force:true});}
});

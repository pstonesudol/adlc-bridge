import {test,expect} from 'bun:test';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../src/core';
import {setProjectIntakePaused,turnBarrier} from '../src/turn-submission';

test('resume-job checks the configured project pause inside the fence before polling or continuing',async()=>{
 const home=realpathSync(mkdtempSync(join(tmpdir(),'resume-project-pause-')));
 try{
  const db=join(home,'state.sqlite'),state=join(home,'Library/Application Support/ADLC Bridge'),config=join(home,'project.json'),preload=join(home,'provider-stub.ts'),calls=join(home,'provider-calls');
  const uuid='00000000-0000-0000-0000-000000000001';
  writeFileSync(config,JSON.stringify({version:1,name:'pause fixture',repo:home,requiredChecks:['CI'],automation:{orchestratorProject:'paused-project'},linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid}}));
  // If polling is reached, record it locally and fail without contacting any
  // provider. No real credentials, daemon, workers, or services are used.
  writeFileSync(preload,`import {appendFileSync} from 'node:fs';globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(calls)},'fetch');throw Error('fixture provider read reached');};`);
  const store=new Store(db),job=store.enqueue(uuid,'issue','{"identifier":"DEV-43"}'),before=store.get(job);store.close();
  const run=(grouped=false)=>Bun.spawnSync([process.execPath,'--preload',preload,join(import.meta.dir,'../src/cli.ts'),...(grouped?['jobs','resume']:['resume-job']),job,config],{env:{HOME:home,PATH:process.env.PATH??'/usr/bin:/bin',ADLC_DB:db,ADLC_LINEAR_TOKEN:'fixture-token',ADLC_AO_PATH:join(home,'no-daemon')},timeout:10000});
  setProjectIntakePaused('paused-project',true,state);
  await turnBarrier(state).run(async()=>{
   const blocked=run();expect(blocked.exitCode).toBe(1);expect(blocked.stderr.toString()).toContain('in progress');expect(blocked.stderr.toString()).not.toContain('intentionally paused');
  });
  for(const grouped of [false,true]){
   const paused=run(grouped);expect(paused.exitCode).toBe(1);expect(paused.stderr.toString()).toContain('Project intake is intentionally paused');expect(existsSync(calls)).toBe(false);
   expect(existsSync(join(state,'turn-submission.lock'))).toBe(false);
  }
  const after=Store.readonly(db);try{expect(after.get(job)).toEqual(before);expect(after.db.query('SELECT * FROM continuations').all()).toEqual([]);expect(after.list()).toHaveLength(1);}finally{after.close();}
  // An unrelated project pause must not prevent this project's polling path.
  setProjectIntakePaused('other-project',true,state);setProjectIntakePaused('paused-project',false,state);
  const unpaused=run();expect(unpaused.exitCode).toBe(1);expect(unpaused.stderr.toString()).toContain('fixture provider read reached');expect(readFileSync(calls,'utf8')).toBe('fetch');
 }finally{rmSync(home,{recursive:true,force:true});}
});

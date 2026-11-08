import {test,expect} from 'bun:test';
import {controlManagedLifecycle,LifecycleFailure,workerOwnership,featureWorkerProject,liveLifecycleOps,checkpointDatabase,parseProcesses,descendants,type LifecycleOps,type LifecycleOptions,type Worker,type Inventory} from '../src/managed-lifecycle';
import {Database} from 'bun:sqlite';
import {parseLifecycle,lifecycleCLI} from '../src/lifecycle-cli';
import {Store} from '../src/core';
import {ProjectServices} from '../src/project-services';
import {turnBarrier,projectIntakePaused,setProjectIntakePaused,assertProjectIntakeEnabled} from '../src/turn-submission';
import {withStackLock} from '../src/stack-control';
import {mkdtempSync,rmSync,existsSync,writeFileSync,statSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
test('real WAL checkpoint flushes uncheckpointed frames and preserves readable data',()=>{
 const root=mkdtempSync(join(tmpdir(),'managed-checkpoint-')),path=join(root,'state.sqlite'),db=new Database(path,{create:true});
 try{
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); PRAGMA wal_checkpoint(TRUNCATE)');
  db.query('INSERT INTO evidence VALUES (?)').run('durable');
  // Keep the writer open: closing its last connection would checkpoint for us.
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(32);
  const result=checkpointDatabase(path);
  expect(result?.busy).toBe(0);expect(result!.log).toBeGreaterThan(0);expect(result!.checkpointed).toBe(result!.log);
  const reader=new Database(path,{readonly:true,create:false});
  try{expect(reader.query('SELECT value FROM evidence').get()).toEqual({value:'durable'});}finally{reader.close();}
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('missing checkpoint database is a no-op and creates no files',()=>{
 const root=mkdtempSync(join(tmpdir(),'managed-checkpoint-missing-')),path=join(root,'missing.sqlite');
 try{
  expect(checkpointDatabase(path)).toBeUndefined();
  for(const file of [path,`${path}-wal`,`${path}-shm`])expect(existsSync(file)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('real busy WAL checkpoint aborts lifecycle and preserves backend and workers',async()=>{
 const root=mkdtempSync(join(tmpdir(),'managed-checkpoint-busy-')),path=join(root,'state.sqlite'),db=new Database(path,{create:true});let reader:Database|undefined;
 try{
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); PRAGMA wal_checkpoint(TRUNCATE)');
  reader=new Database(path,{readonly:true,create:false});reader.exec('BEGIN');reader.query('SELECT * FROM evidence').all();
  db.query('INSERT INTO evidence VALUES (?)').run('pending');
  const f=fixture();f.ops.checkpoint=async()=>{checkpointDatabase(path);};
  await expect(apply(f,'restart',{all:true,timeout:2})).rejects.toThrow('Durable checkpoint busy; backend preserved');
  expect(f.paused()).toBe(true);expect(f.calls).not.toContain('exit:one-1');expect(f.calls).not.toContain('backend:stop');expect(f.calls).not.toContain('backend:start');
  reader.exec('ROLLBACK');expect(checkpointDatabase(path)?.busy).toBe(0);
 }finally{reader?.close();db.close();rmSync(root,{recursive:true,force:true});}
});
const worker=(extra:Partial<Worker>={}):Worker=>({session:'one-1',project:'one',branch:'adlc/work',owned:true,exited:false,busy:false,reason:'owned',...extra});
function fixture(){
 const calls:string[]=[];let clock=0,paused=false,backend=true;let workers=[worker()];
 const inventory:Inventory={workers,children:[{pid:42,ppid:1,started:'start'}],complete:true,externalProcesses:'Not controlled'};
 const ops:LifecycleOps={
  turns:{run:async f=>f(),submit:async f=>f(),isPaused:()=>paused,pause:()=>{paused=true;calls.push('pause');},resume:()=>{paused=false;calls.push('resume');}},
  projects:async()=>[{project:'one'},{project:'two'}],project:async(a,id,p)=>{calls.push(`${a}:${id}:${p}`);return {project:id,loaded:a!=='stop'};},
  backend:async()=>({ready:backend,loaded:backend,managed:true}),backendStart:async()=>{calls.push('backend:start');backend=true;},backendStop:async()=>{calls.push('backend:stop');backend=false;},
  inventory:async()=>({...inventory,workers}),exit:async w=>{calls.push(`exit:${w.session}`);workers=workers.map(x=>x.session===w.session?{...x,exited:true,busy:false}:x);},
  checkpoint:async()=>{calls.push('checkpoint');},processesRemain:async()=>[],now:()=>clock,sleep:async ms=>{clock+=ms;}
 };
 return {ops,calls,inventory,setWorkers:(w:Worker[])=>workers=w,paused:()=>paused};
}
async function apply(f:ReturnType<typeof fixture>,action:'stop'|'restart',o:LifecycleOptions){const p=await controlManagedLifecycle(action,o,f.ops);f.calls.length=0;return controlManagedLifecycle(action,{...o,apply:true,confirm:p.confirm},f.ops);}
test('project stop preserves workers and backend; all-stack pause persists its fence',async()=>{
 const f=fixture();await controlManagedLifecycle('stop',{project:'one',timeout:1},f.ops);expect(f.calls).toEqual(['stop:one:false','checkpoint']);expect(f.paused()).toBe(false);
 const g=fixture();g.ops.inventory=async()=>{throw Error('backend unavailable');};await controlManagedLifecycle('stop',{all:true,mode:'pause',timeout:1},g.ops);expect(g.calls).toEqual(['pause','stop:one:true','stop:two:true','checkpoint']);expect(g.paused()).toBe(true);
});
test('disruptive preview has no mutations and exact confirmation is required before pause',async()=>{
 const f=fixture(),o={all:true,mode:'workers' as const,timeout:2};const p=await controlManagedLifecycle('stop',o,f.ops);expect(f.calls).toEqual([]);expect(p.preview).toBe(true);
 f.setWorkers([worker({session:'different'})]);await expect(controlManagedLifecycle('stop',{...o,apply:true,confirm:p.confirm},f.ops)).rejects.toThrow('stale');expect(f.calls).toEqual([]);
});
test('restart --all --preview returns a confirmation hash without mutations',async()=>{
 const f=fixture();
 const result=await lifecycleCLI('restart',['--all','--preview'],'unused',async(action,options)=>controlManagedLifecycle(action,options,f.ops));
 expect(result.preview).toBe(true);expect(result.confirm).toMatch(/^[a-f0-9]{64}$/);expect(f.calls).toEqual([]);expect(f.paused()).toBe(false);
});
test('isolated CLI restart preview emits a confirmation hash without creating state',()=>{
 const root=mkdtempSync(join(tmpdir(),'managed-restart-preview-'));try{
  const db=join(root,'missing.sqlite'),ao=join(root,'fixture-ao');
  // No live daemon or service control: this fixture accepts only a status read.
  writeFileSync(ao,`#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['status','--json']))process.exit(99);\nconsole.log(JSON.stringify({state:'not_running'}));\n`,{mode:0o700});
  const r=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'restart','--all','--preview','--json'],{env:{HOME:root,PATH:process.env.PATH,ADLC_DB:db,ADLC_AO_PATH:ao},timeout:10000});
  expect(r.exitCode).toBe(0);const result=JSON.parse(r.stdout.toString());
  expect(result.preview).toBe(true);expect(result.confirm).toMatch(/^[a-f0-9]{64}$/);
  expect(existsSync(db)).toBe(false);expect(existsSync(join(root,'Library/Application Support/ADLC Bridge'))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('confirmation cannot interrupt a later turn in the same session',async()=>{
 const f=fixture(),o={project:'one',mode:'workers' as const,timeout:1};f.setWorkers([worker({turns:['old']})]);const p=await controlManagedLifecycle('stop',o,f.ops);f.setWorkers([worker({turns:['old','new'],busy:true})]);await expect(controlManagedLifecycle('stop',{...o,apply:true,confirm:p.confirm},f.ops)).rejects.toThrow('stale');expect(f.calls).toEqual([]);
});
test('all stop exits idle owned workers, checkpoints, then stops backend and verifies children',async()=>{
 const f=fixture();const r=await apply(f,'stop',{all:true,timeout:2});expect(f.calls).toEqual(['pause','stop:one:true','stop:two:true','checkpoint','exit:one-1','checkpoint','backend:stop']);expect(r).toMatchObject({complete:true,children:[],backend:{ready:false}});
});
test('shared idle session preserves backend, even when it belongs to the selected project',async()=>{
 const f=fixture();f.setWorkers([worker(),worker({session:'manual',owned:false})]);await expect(apply(f,'stop',{all:true,timeout:1})).rejects.toThrow('Shared/unowned');expect(f.calls).toContain('exit:one-1');expect(f.calls).not.toContain('exit:manual');expect(f.calls).not.toContain('backend:stop');
});
test('default stop never interrupts active work and explicit workers exits only selected owners',async()=>{
 const f=fixture();f.setWorkers([worker({busy:true})]);await expect(apply(f,'stop',{all:true,timeout:1})).rejects.toThrow('active or queued');expect(f.calls).not.toContain('exit:one-1');
 const g=fixture();g.setWorkers([worker({busy:true}),worker({session:'two-1',project:'two',busy:true})]);await apply(g,'stop',{project:'one',mode:'workers',timeout:1});expect(g.calls).toContain('exit:one-1');expect(g.calls).not.toContain('exit:two-1');expect(g.calls).not.toContain('backend:stop');
});
test('drain waits for authorized queued work, then exits idle workers without new sends',async()=>{
 const f=fixture();f.setWorkers([worker({busy:true})]);let reads=0;const original=f.ops.inventory;f.ops.inventory=async()=>{if(++reads===4)f.setWorkers([worker()]);return original();};await apply(f,'stop',{project:'one',mode:'drain',timeout:1});expect(reads).toBeGreaterThanOrEqual(4);expect(f.calls).toContain('exit:one-1');
});
test('drain timeout reports remaining workers, leaves intake paused, and never escalates',async()=>{
 const f=fixture();f.setWorkers([worker({busy:true})]);let error:any;try{await apply(f,'stop',{all:true,mode:'drain',timeout:1});}catch(e){error=e;}
 expect(error).toBeInstanceOf(LifecycleFailure);expect(error.message).toContain('timeout');expect(error.result.workers[0].busy).toBe(true);expect(f.paused()).toBe(true);expect(f.calls.some(x=>x.startsWith('exit:'))).toBe(false);expect(f.calls).not.toContain('backend:stop');
});
test('expired lock acquisition budget cannot pause intake or start services',async()=>{
 for(const action of ['stop','start'] as const){
  const f=fixture();f.ops.turns.run=async operation=>{await f.ops.sleep(1000);return operation();};
  await expect(controlManagedLifecycle(action,{all:true,mode:action==='stop'?'pause':undefined,timeout:1},f.ops,1000)).rejects.toThrow('Lifecycle timeout');
  expect(f.calls).toEqual([]);expect(f.paused()).toBe(false);
 }
 // The default controller budget is also captured before fence acquisition.
 const f=fixture();f.ops.turns.run=async operation=>{await f.ops.sleep(1000);return operation();};await expect(controlManagedLifecycle('stop',{all:true,mode:'pause',timeout:1},f.ops)).rejects.toThrow('Lifecycle timeout');expect(f.calls).toEqual([]);
});
test('late drain lock acquisition consumes the original deadline without renewing it',async()=>{
 const f=fixture(),o={all:true,mode:'drain' as const,timeout:1};f.setWorkers([worker({busy:true})]);const preview=await controlManagedLifecycle('stop',o,f.ops);
 f.ops.turns.run=async operation=>{await f.ops.sleep(900);return operation();};
 await expect(controlManagedLifecycle('stop',{...o,apply:true,confirm:preview.confirm},f.ops,1000)).rejects.toThrow('Lifecycle timeout');
 expect(f.ops.now()).toBe(1000);expect(f.paused()).toBe(true);expect(f.calls).not.toContain('exit:one-1');expect(f.calls).not.toContain('backend:stop');
});
test('inventory observation cannot consume the remaining deadline then pause intake',async()=>{
 const f=fixture(),o={all:true,mode:'workers' as const,timeout:1};const preview=await controlManagedLifecycle('stop',o,f.ops),inventory=f.ops.inventory;
 f.ops.inventory=async()=>{await f.ops.sleep(1000);return inventory();};
 await expect(controlManagedLifecycle('stop',{...o,apply:true,confirm:preview.confirm},f.ops,1000)).rejects.toThrow('Lifecycle timeout');expect(f.calls).toEqual([]);expect(f.paused()).toBe(false);
});
test('new workers and ownership changes during final reads prevent backend shutdown',async()=>{
 for(const changed of [worker({session:'new'}),worker({owned:false})]){
  const f=fixture();let reads=0;const original=f.ops.inventory;f.ops.inventory=async()=>{if(++reads===3)f.setWorkers([changed]);return original();};await expect(apply(f,'stop',{all:true,timeout:1})).rejects.toThrow();expect(f.calls).not.toContain('backend:stop');
 }
});
test('process identity verification does not confuse unload with shutdown',async()=>{
 const f=fixture();f.ops.processesRemain=async p=>p;await expect(apply(f,'stop',{all:true,timeout:1})).rejects.toThrow('observed child processes remain');
 expect(parseProcesses('12 1 Mon Nov 2 12:00:00 2026\n13 12 Mon Nov 2 12:01:00 2026')).toHaveLength(2);
 expect(descendants([{pid:1,ppid:0,started:'a'},{pid:2,ppid:1,started:'b'},{pid:3,ppid:8,started:'c'}],1).map(x=>x.pid)).toEqual([1,2]);expect(()=>parseProcesses('garbage')).toThrow();
});
test('restart starts dependency first after a verified stop, without resuming or replacing sessions',async()=>{
 const f=fixture();const r=await apply(f,'restart',{all:true,mode:'drain',timeout:2});expect(r.complete).toBe(true);expect(r.note).toContain('restarted');expect(r.children).toBeNull();expect(f.calls).toEqual(['pause','stop:one:true','stop:two:true','checkpoint','exit:one-1','checkpoint','backend:stop','pause','backend:start','start:one:true','start:two:true','resume']);
});
test('partial start retains global pause, reports outcomes and never claims complete',async()=>{
 const f=fixture();f.ops.project=async(a,id)=>{f.calls.push(`${a}:${id}`);if(id==='two')throw Error('launch failed');return {project:id,loaded:true};};let e:any;try{await controlManagedLifecycle('start',{all:true,timeout:1},f.ops);}catch(error){e=error;}expect(e.result.complete).toBe(false);expect(e.result.services).toHaveLength(1);expect(f.paused()).toBe(true);
});
test('project start checks dependencies and preserves other projects after a global stop',async()=>{
 const f=fixture();f.ops.turns.pause();f.calls.length=0;f.ops.holdProject=async id=>{f.calls.push(`hold:${id}`);};
 await controlManagedLifecycle('start',{project:'one',timeout:1},f.ops);expect(f.calls).toEqual(['hold:two','start:one:false','resume']);expect(f.paused()).toBe(false);
 const g=fixture();let ready=false;g.ops.backend=async()=>({ready,loaded:ready,managed:true});g.ops.backendStart=async()=>{g.calls.push('backend:start');ready=true;};
 await controlManagedLifecycle('start',{project:'one',timeout:1},g.ops);expect(g.calls).toEqual(['backend:start','start:one:false']);
 const h=fixture();h.ops.turns.pause();h.calls.length=0;h.ops.holdProject=async()=>{throw Error('pause persistence failed');};await expect(controlManagedLifecycle('start',{project:'one',timeout:1},h.ops)).rejects.toThrow('pause persistence failed');expect(h.paused()).toBe(true);expect(h.calls).toEqual([]);
});
test('status collects separate partial diagnostics and does not mutate',async()=>{
 const f=fixture();f.ops.inventory=async()=>{throw Error('API unavailable');};const r=await controlManagedLifecycle('status',{all:true,timeout:1},f.ops);expect(r.complete).toBe(false);expect(r.backend.ready).toBe(true);expect(r.errors).toContainEqual({resource:'workers/processes',message:'API unavailable'});expect(f.calls.every(x=>x.startsWith('service-status:'))).toBe(true);
});
test('ownership binds native session/branch to durable worktree and controller, never a name or project alone',()=>{
 const s=new Store(':memory:');try{
  s.db.exec('CREATE TABLE planning_runs(job TEXT,session_id TEXT,project TEXT,branch TEXT,worktree TEXT); CREATE TABLE runs(job TEXT,session_id TEXT,worktree TEXT,owner TEXT)');
  s.db.query('INSERT INTO planning_runs VALUES (?,?,?,?,?)').run('j','one-1','one','adlc/work','/tree');
  const x={id:'one-1',kind:'worker',projectId:'one',branch:'adlc/work'};expect(workerOwnership(s,x)).toBe(true);expect(workerOwnership(s,{...x,branch:'main'})).toBe(false);expect(workerOwnership(s,x,'/other')).toBe(false);expect(workerOwnership(s,{...x,kind:'orchestrator'})).toBe(false);
  s.db.query('INSERT INTO runs VALUES (?,?,?,?)').run('j','one-1','/tree','human');expect(workerOwnership(s,x)).toBe(false);
 }finally{s.close();}
});
test('parser validates all lifecycle options before any I/O',async()=>{
 expect(parseLifecycle('stop',['--all','--drain','--timeout','120','--temporary','--json'])).toEqual({all:true,mode:'drain',timeout:120,persistent:false});
 for(const args of [['--all','one'],['one','--project','one'],['--drain','--workers'],['--timeout','--all'],['--timeout','0'],['--all','--all'],['--force'],['--disable-login','--temporary'],['--confirm','bad']])expect(()=>parseLifecycle('stop',args)).toThrow();
 expect(()=>parseLifecycle('status',['--workers'])).toThrow();expect(()=>parseLifecycle('start',['--apply'])).toThrow();expect(()=>parseLifecycle('restart',['--pause'])).toThrow();
 let calls=0;await expect(lifecycleCLI('stop',['--force'],'unused',async()=>{calls++;return {};})).rejects.toThrow();expect(calls).toBe(0);
});
test('grouped lifecycle JSON and flat legacy text usage errors do not create state',()=>{
 const root=mkdtempSync(join(tmpdir(),'managed-cli-'));try{
  const cli=join(import.meta.dir,'../src/cli.ts'),db=join(root,'missing.sqlite');
  for(const args of [['services','stop','--workers','--drain'],['stop','--all','--force'],['restart','--timeout','0'],['status','--all','--apply'],['start','--all','--project','one']]){
   const r=Bun.spawnSync([process.execPath,cli,...args,'--json'],{env:{HOME:root,PATH:process.env.PATH,ADLC_DB:db}});expect(r.exitCode).toBe(2);
   if(args[0]==='services')expect(JSON.parse(r.stderr.toString())).toMatchObject({schemaVersion:1,error:{code:2}});
   else{expect(r.stderr.toString()).not.toContain('schemaVersion');expect(()=>JSON.parse(r.stderr.toString())).toThrow();}
   expect(existsSync(db)).toBe(false);
  }
  const r=Bun.spawnSync([process.execPath,cli,'services','restart','--help'],{env:{HOME:root,PATH:process.env.PATH,ADLC_DB:db}});expect(r.exitCode).toBe(0);expect(r.stdout.toString()).toContain('--apply --confirm HASH');expect(r.stdout.toString()).toContain('--drain');expect(existsSync(join(root,'Library/Application Support/ADLC Bridge'))).toBe(false);expect(existsSync(db)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('flat lifecycle success stays unwrapped and operational errors omit grouped result data',()=>{
 const root=mkdtempSync(join(tmpdir(),'lifecycle-contract-'));try{
  const config=join(root,'project.json'),db=join(root,'state.sqlite'),uuid='00000000-0000-0000-0000-000000000001';
  writeFileSync(config,JSON.stringify({version:1,name:'fixture',repo:root,requiredChecks:['CI'],automation:{orchestratorProject:'one'},linear:{projectId:uuid,teamId:uuid,readyStateId:uuid,readyLabelId:uuid}}));
  const store=new Store(db);new ProjectServices(store).register(config);store.close();
  const run=(...args:string[])=>Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),...args],{env:{HOME:root,PATH:process.env.PATH,ADLC_DB:db,ADLC_AO_PATH:join(root,'nonexistent-daemon')},timeout:10000});
  const flat=run('stop','one','--preview','--json'),grouped=run('services','stop','one','--preview','--json');expect(flat.exitCode).toBe(0);expect(grouped.exitCode).toBe(0);
  expect(JSON.parse(flat.stdout.toString())).toMatchObject({preview:true,scope:'project'});expect(JSON.parse(flat.stdout.toString()).schemaVersion).toBeUndefined();expect(JSON.parse(grouped.stdout.toString())).toMatchObject({schemaVersion:1,command:'services',data:{preview:true,scope:'project'}});
  // The nonexistent fixture AO path fails before any launchctl operation.
  for(const json of [false,true]){
   const failure=run('start','one',...(json?['--json']:[]));expect(failure.exitCode).toBe(1);expect(failure.stderr.toString()).not.toContain('schemaVersion');expect(failure.stderr.toString()).not.toContain('"scope"');expect(failure.stderr.toString()).not.toContain('"services"');
  }
  const failure=run('services','start','one','--json');expect(failure.exitCode).toBe(1);expect(JSON.parse(failure.stderr.toString())).toMatchObject({schemaVersion:1,error:{code:1,result:{action:'start',complete:false}}});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('repeated stop and start do not re-exit an already exited worker or replace it',async()=>{
 const f=fixture();await apply(f,'stop',{project:'one',mode:'workers',timeout:1});f.calls.length=0;await apply(f,'stop',{project:'one',mode:'workers',timeout:1});expect(f.calls.filter(x=>x.startsWith('exit:'))).toEqual([]);
 await controlManagedLifecycle('start',{project:'one',timeout:1},f.ops);await controlManagedLifecycle('start',{project:'one',timeout:1},f.ops);expect(f.calls.filter(x=>x==='start:one:false')).toHaveLength(2);
});
test('children reparented during agent exit remain tracked after backend shutdown',async()=>{
 const f=fixture();let seen:any[]=[];const inventory=f.ops.inventory;
 f.ops.inventory=async()=>{const i=await inventory();return {...i,children:i.workers[0].exited?[]:i.children};};f.ops.processesRemain=async p=>{seen=p;return p;};
 await expect(apply(f,'stop',{all:true,timeout:1})).rejects.toThrow('observed child processes remain');expect(seen).toContainEqual({pid:42,ppid:1,started:'start'});
});
test('real locks serialize controls with polls and durable project pause survives a new barrier instance',async()=>{
 const root=mkdtempSync(join(tmpdir(),'managed-fence-'));try{
  const turns=turnBarrier(root);let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const sending=turns.submit(async()=>{entered();await gate;});await started;
  const f=fixture();f.ops.turns=turns;await expect(controlManagedLifecycle('stop',{project:'one',timeout:1},f.ops)).rejects.toThrow('in progress');expect(f.calls).toEqual([]);release();await sending;
  await withStackLock(root,async()=>{await expect(withStackLock(root,async()=>{})).rejects.toThrow('Another stack control');});expect(existsSync(join(root,'stack-control.lock'))).toBe(false);
  setProjectIntakePaused('one',true,root);expect(projectIntakePaused('one',root)).toBe(true);expect(()=>assertProjectIntakeEnabled('one',root)).toThrow('intentionally paused');expect(()=>assertProjectIntakeEnabled('two',root)).not.toThrow();
  await turnBarrier(root).run(async()=>{setProjectIntakePaused('one',false,root);});expect(projectIntakePaused('one',root)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('feature ownership requires recorded session and client receipt; human handoff wins',()=>{
 const s=new Store(':memory:');try{
  s.db.exec('CREATE TABLE feature_plans(id TEXT,project TEXT,route TEXT); CREATE TABLE feature_agents(plan TEXT,session TEXT,name TEXT,client_id TEXT,state TEXT); CREATE TABLE ownership(session_id TEXT,owner TEXT)');
  s.db.query('INSERT INTO feature_plans VALUES (?,?,?)').run('f','one','{"harness":"codex"}');s.db.query('INSERT INTO feature_agents VALUES (?,?,?,?,?)').run('f','feature-1','reviewer','client','running');
  const e={session:{id:'feature-1',kind:'worker',displayName:'reviewer',harness:'codex'},transcript:{entries:[{clientMessageId:'client'}]}};
  expect(featureWorkerProject(s,e)).toBe('one');expect(featureWorkerProject(s,{...e,transcript:{entries:[]}})).toBeUndefined();s.db.query('INSERT INTO ownership VALUES (?,?)').run('feature-1','human');expect(featureWorkerProject(s,e)).toBeUndefined();
 }finally{s.close();}
});
test('native shared sessions are reported without reading unrelated transcripts; pagination fails closed',async()=>{
 const root=mkdtempSync(join(tmpdir(),'managed-inventory-'));try{
  let page:any={sessions:[{id:'manual',projectId:'other',isTerminated:false,kind:'orchestrator',activity:{state:'idle'}}]};let transcriptReads=0;
  const ops=liveLifecycleOps({all:true,timeout:2},join(root,'absent.sqlite'),root,Date.now()+2000,{trust:()=>true,list:async()=>page,evidence:async()=>{transcriptReads++;throw Error('must not inspect unrelated transcript');},run:async args=>({code:0,stderr:'',stdout:args[0]==='/bin/ps'?'42 1 Mon Nov 2 12:00:00 2026':JSON.stringify({state:'ready',port:3001,pid:42,executablePath:'/trusted'})})});
  const i=await ops.inventory();expect(i.workers[0]).toMatchObject({owned:false,exited:false,project:'other'});expect(transcriptReads).toBe(0);expect(existsSync(join(root,'absent.sqlite'))).toBe(false);
  page={...page,nextCursor:'more'};await expect(ops.inventory()).rejects.toThrow('incomplete');page={sessions:[page.sessions[0],page.sessions[0]]};await expect(ops.inventory()).rejects.toThrow('Duplicate');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('live adapter uses native inventory and exit receipts without signaling other processes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'managed-native-')),path=join(root,'s.sqlite');try{
  const s=new Store(path);s.db.exec('CREATE TABLE planning_runs(job TEXT,session_id TEXT,project TEXT,branch TEXT,worktree TEXT)');s.db.query('INSERT INTO planning_runs VALUES (?,?,?,?,?)').run('j','one-1','one','adlc/work','/tree');s.close();
  let exited=false;const calls:string[][]=[];
  const e=()=>({session:{id:'one-1',kind:'worker',projectId:'one',branch:'adlc/work',isTerminated:false,activity:{state:exited?'exited':'idle'}},transcript:{controller:exited?'stopped':'ready',turns:[],entries:[]}});
  const ops=liveLifecycleOps({project:'one',mode:'workers',timeout:5},path,root,Date.now()+5000,{trust:()=>true,list:async()=>({sessions:[e().session]}),evidence:async()=>e(),run:async args=>{
   calls.push(args);let data:any;
   if(args[1]==='status')data={state:'ready',executablePath:'/trusted',pid:42,port:3001};
   else if(args[1]==='session'&&args[2]==='exit-agent'){exited=true;data={ok:true,sessionId:'one-1'};}
   else if(args[0]==='/bin/ps')return {stdout:'42 1 Mon Nov 2 12:00:00 2026\n43 42 Mon Nov 2 12:01:00 2026',stderr:'',code:0};
   else throw Error('Unexpected command: '+args.join(' '));return {stdout:JSON.stringify(data),stderr:'',code:0};
  }});
  const before=await ops.inventory();expect(before.workers[0]).toMatchObject({owned:true,busy:false,exited:false});await ops.exit(before.workers[0]);expect((await ops.inventory()).workers[0].exited).toBe(true);
  expect(calls.filter(x=>x.includes('exit-agent'))).toHaveLength(1);expect(calls.some(x=>x.includes('kill')||x.includes('resume-agent'))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});

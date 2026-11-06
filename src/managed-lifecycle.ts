import {existsSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {Store,digest} from './core';
import {AO} from './orchestrator';
import {appState} from './install-state';
import {registryPath,readDefinition} from './project-services';
import {registeredProjects,serviceControl} from './service-control';
import {command,daemonStatus,liveStackOps,withStackLock} from './stack-control';
import {trustedDaemon} from './daemon-runtime';
import {sessionEvidence} from './session-evidence';
import {OperatorError} from './operator-cli';
import {turnBarrier,TurnSubmissionBlocked,projectIntakePaused,setProjectIntakePaused,type TurnBarrier} from './turn-submission';

export type LifecycleAction='start'|'stop'|'restart'|'status';
export type LifecycleOptions={project?:string;all?:boolean;mode?:'pause'|'drain'|'workers';timeout:number;persistent?:boolean;preview?:boolean;apply?:boolean;confirm?:string};
export type Worker={session:string;project:string;branch?:string;worktree?:string;turns?:string[];owned:boolean;exited:boolean;busy:boolean;reason:string};
export type ProcessIdentity={pid:number;ppid:number;started:string};
export type Inventory={workers:Worker[];children:ProcessIdentity[];complete:boolean;externalProcesses:string};
export type LifecycleOps={
 turns:TurnBarrier;
 projects():Promise<{project:string}[]>;
 project(action:'start'|'stop'|'service-status',id:string,persistent:boolean):Promise<any>;
 holdProject?(id:string):Promise<void>;
 backend():Promise<any>;backendStart():Promise<void>;backendStop():Promise<void>;
 inventory():Promise<Inventory>;exit(worker:Worker):Promise<void>;checkpoint():Promise<void>;
 processesRemain(previous:ProcessIdentity[]):Promise<ProcessIdentity[]>;
 now():number;sleep(ms:number):Promise<unknown>;
};
export class LifecycleFailure extends Error{constructor(message:string,public result:any){super(message);}}
export function lifecycleConfirmation(action:LifecycleAction,o:LifecycleOptions,ids:string[],inventory:Inventory,includeTurns=true){
 return digest(JSON.stringify({action,projects:[...ids].sort(),all:!!o.all,mode:o.mode??null,persistent:o.persistent??!!o.all,timeout:o.timeout,
  // Activity may finish naturally after preview. Identity/ownership must not change.
  workers:inventory.workers.map(w=>[w.session,w.project,w.branch,w.worktree,w.owned,includeTurns?[...(w.turns??[])].sort():null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))}));
}
export async function controlManagedLifecycle(action:LifecycleAction,o:LifecycleOptions,ops:LifecycleOps){
 const entries=await ops.projects(),ids=o.all?entries.map(x=>x.project):o.project?[o.project]:entries.length===1?[entries[0].project]:[];
 if(!ids.length&&!o.all)throw new OperatorError('Specify a registered project or --all; no project was selected',entries.length?4:3);
 if(ids.some(id=>!entries.some(e=>e.project===id)))throw new OperatorError('Unknown project; use adlc projects',3);
 const persistent=o.persistent??!!o.all;
 const result:any={scope:o.all?'all':'project',projects:ids,action,mode:o.mode??(action==='start'?'start':action==='restart'?'restart':o.all?'shutdown':'pause'),persistent,globalIntakePaused:ops.turns.isPaused(),services:[],workers:null,children:null,inventoryComplete:false,errors:[],resume:'Existing sessions are preserved. Exited/interrupted workers require explicit approved job recovery; no resume or send is performed.'};
 const tracked=new Map<string,ProcessIdentity>();
 const scoped=(i:Inventory)=>i.workers.filter(w=>w.owned&&ids.includes(w.project));
 const observe=async()=>{const i=await ops.inventory();for(const p of i.children)tracked.set(`${p.pid}:${p.started}`,p);result.workers=scoped(i);result.sharedOrExternal=i.workers.filter(w=>!w.owned||!ids.includes(w.project));result.children=i.children;result.observedAt=ops.now();result.externalProcesses=i.externalProcesses;result.inventoryComplete=i.complete;return i;};
 if(action==='status'){
  for(const id of ids)try{result.services.push(await ops.project('service-status',id,persistent));}catch(e){result.errors.push({project:id,message:message(e)});}
  try{result.backend=await ops.backend();}catch(e){result.errors.push({resource:'backend',message:message(e)});}
  try{await observe();}catch(e){result.inventoryComplete=false;result.errors.push({resource:'workers/processes',message:message(e)});}
  result.complete=!result.errors.length&&result.inventoryComplete===true;return result;
 }
 const disruptive=action==='restart'||action==='stop'&&o.mode!=='pause'&&(!!o.all||!!o.mode);
 if(o.preview||disruptive&&!o.apply){
  const i=disruptive?await observe():{workers:[],children:[],complete:true,externalProcesses:'Not inspected'};
  result.preview=true;result.confirm=lifecycleConfirmation(action,o,ids,i);result.note=disruptive?'Preview only. Re-run the same options with --apply --confirm HASH. Changed worker ownership/identity requires a new preview.':'Preview only. Re-run without --preview to start or pause coordination; no worker interruption is performed.';return result;
 }
 return ops.turns.run(async()=>{
  const deadline=ops.now()+o.timeout*1000;
  const time=()=>{if(ops.now()>=deadline)throw Error('Lifecycle timeout; remaining resources are reported. No force escalation was attempted');};
  let confirmed:string|undefined;const allowedTurns=new Map<string,Set<string>>();
  const read=async()=>{time();const i=await observe();if(!i.complete)throw Error('Worker/process inventory incomplete; backend preserved');if(confirmed&&(lifecycleConfirmation(action,o,ids,i,false)!==confirmed||i.workers.some(w=>(w.turns??[]).some(t=>!allowedTurns.get(w.session)?.has(t)))))throw Error('Worker inventory, ownership or turns changed; preview again; backend preserved');return i;};
  const wait=async(test:()=>Promise<boolean>)=>{for(;;){time();if(await test())return;await ops.sleep(Math.min(200,Math.max(1,deadline-ops.now())));}};
  try{
   if(disruptive){const i=await read();if(!o.confirm||o.confirm!==lifecycleConfirmation(action,o,ids,i))throw Error('Confirmation missing or stale; preview the exact action again');confirmed=lifecycleConfirmation(action,o,ids,i,false);for(const w of i.workers)allowedTurns.set(w.session,new Set(w.turns??[]));}
   const start=async()=>{
    time();
    let releaseGlobal=false;
    if(o.all){ops.turns.pause();await ops.backendStart();const b=await ops.backend();result.backend=b;if(!b.managed||!b.ready)throw Error('Managed backend readiness/compatibility unverified; intake remains paused');}
    else{
     if(ops.turns.isPaused()){
      if(!ops.holdProject)throw Error('Cannot preserve other project pauses; global intake remains paused');
      for(const p of entries)if(!ids.includes(p.project)){time();await ops.holdProject(p.project);}
      releaseGlobal=true;
     }
     let b=await ops.backend();if(!b.ready){await ops.backendStart();b=await ops.backend();}
     result.backend=b;if(!b.ready)throw Error('Backend readiness/compatibility unverified; project intake was not started');
    }
    for(const id of ids){time();result.services.push(await ops.project('start',id,persistent));}
    if(o.all||releaseGlobal)ops.turns.resume();
   };
   if(action==='start'){await start();result.globalIntakePaused=ops.turns.isPaused();result.complete=true;return result;}
   if(o.all)ops.turns.pause();
   for(const id of ids){time();result.services.push(await ops.project('stop',id,persistent));}
   const workers=action==='restart'||o.mode==='workers'||o.mode==='drain'||o.all&&o.mode!=='pause';
   if(workers){
    let i=await read();
    const selected=()=>scoped(i).filter(w=>!w.exited);
    if(o.mode==='drain')await wait(async()=>{i=await read();return selected().every(w=>!w.busy);});
    if(o.mode!=='workers'&&selected().some(w=>w.busy))throw Error('Intake paused; active or queued workers remain. Use --drain or preview explicit --workers interruption');
    await ops.checkpoint();time();
    const initial=new Set(i.workers.map(w=>w.session));
    for(const w of selected()){
     time();const latest=await read(),current=scoped(latest).find(x=>x.session===w.session);
     if(latest.workers.some(x=>!initial.has(x.session)))throw Error('New session appeared during shutdown; preview again');
     if(!current||!current.owned)throw Error('Worker ownership changed; remaining workers preserved');
     if(o.mode!=='workers'&&current.busy)throw Error('Worker became active during shutdown; preserved');
     if(!current.exited)await ops.exit(current);
    }
    await wait(async()=>{i=await read();if(i.workers.some(x=>!initial.has(x.session)))throw Error('New session appeared during shutdown; backend preserved');return scoped(i).every(w=>w.exited);});
    if(o.all){
     if(i.workers.some(w=>!w.owned&&!w.exited))throw Error('Shared/unowned sessions remain; owned workers stopped but backend preserved');
     const b=await ops.backend();result.backend=b;if(!b.managed)throw Error('Backend is not bridge-managed; preserved');
     await ops.checkpoint();time();
     // Last inventory under the fence. Never equate launchd unload with exit.
     i=await read();if(i.workers.some(w=>!w.exited))throw Error('Worker activity changed before backend shutdown; preserved');
     await ops.backendStop();time();result.backend=await ops.backend();
     const remaining=await ops.processesRemain([...tracked.values()]);result.children=remaining;
     if(result.backend.loaded||result.backend.ready||remaining.length)throw Error('Shutdown incomplete; managed backend or observed child processes remain');
    }else await ops.checkpoint();
   }else await ops.checkpoint();
   if(action==='restart'){
    result.shutdown={backend:result.backend,remainingObservedChildren:result.children};
    await start();result.children=null;result.childrenAfterRestart='Not re-inventoried; use services status. The new backend and intake are running.';
   }
   result.globalIntakePaused=ops.turns.isPaused();result.complete=true;result.note=action==='restart'?'Selected coordination restarted; exited workers remain preserved and are not automatically resumed.':o.all&&o.mode!=='pause'?'Managed stack shutdown verified for observed processes. Unrelated apps/windows and detached external processes are not controlled.':'Selected coordination stopped; unrelated services and workers are preserved.';return result;
  }catch(e){result.globalIntakePaused=ops.turns.isPaused();result.complete=false;result.errors.push({message:message(e)});throw new LifecycleFailure(message(e),result);}
 });
}
const message=(e:unknown)=>e instanceof Error?e.message:'Lifecycle evidence unavailable';

// Public native sessions expose ID/project/branch, not absolute workspace paths.
// Bind those to the durable reservation/worktree; never infer ownership from a
// project or ADLC-looking name. Human handoff wins.
export function workerOwnership(s:Store,session:any,expectedWorktree?:string){
 const has=(name:string)=>!!s.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(!has('planning_runs'))return false;
 const rows=s.db.query('SELECT * FROM planning_runs WHERE session_id=?').all(session.id) as any[];
 if(rows.length!==1)return false;
 const r=rows[0];
 if(session.kind!=='worker'||typeof r.worktree!=='string'||!r.worktree.startsWith('/')||r.project!==session.projectId||r.branch!==session.branch||expectedWorktree!==undefined&&expectedWorktree!==r.worktree)return false;
 const run=has('runs')?s.db.query('SELECT * FROM runs WHERE job=?').get(r.job) as any:null;
 if(run&&(run.owner!=='orchestrator'||run.session_id!==session.id||run.worktree!==r.worktree))return false;
 if(has('ownership')){const owner=s.db.query('SELECT * FROM ownership WHERE session_id=?').get(session.id) as any;if(owner&&owner.owner!=='orchestrator')return false;}
 return true;
}
export function featureWorkerProject(s:Store,e:any):string|undefined{
 const has=(name:string)=>!!s.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
 const x=e.session;
 if(x.kind!=='worker'||x.projectId||!has('feature_agents')||!has('feature_plans'))return;
 if(has('ownership')){const owner=s.db.query('SELECT * FROM ownership WHERE session_id=?').get(x.id) as any;if(owner&&owner.owner!=='orchestrator')return;}
 const rows=s.db.query('SELECT a.*,p.project,p.route FROM feature_agents a JOIN feature_plans p ON p.id=a.plan WHERE a.session=?').all(x.id) as any[];
 if(rows.length!==1)return;const r=rows[0];let route:any;try{route=JSON.parse(r.route);}catch{return;}
 if(x.displayName!==r.name||x.harness!==route.harness)return;
 // No name-based adoption: a recorded session plus its exact dispatch receipt
 // is required. Pre-delivery configuration is also an owned recorded session.
 if(r.state!=='configuring'&&!e.transcript.entries.some((entry:any)=>entry.clientMessageId===r.client_id))return;
 return r.project;
}
export function parseProcesses(text:string):ProcessIdentity[]{
 const rows=text.trim()?text.trim().split('\n'):[];
 return rows.map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);if(!m)throw Error('Process inventory malformed');return {pid:Number(m[1]),ppid:Number(m[2]),started:m[3].trim()};});
}
export function descendants(rows:ProcessIdentity[],root:number){
 const seen=new Set([root]);let changed=true;
 while(changed){changed=false;for(const r of rows)if(seen.has(r.ppid)&&!seen.has(r.pid)){seen.add(r.pid);changed=true;}}
 return rows.filter(r=>seen.has(r.pid));
}
async function processInventory(run=command){const r=await run(['/bin/ps','-axo','pid=,ppid=,lstart=']);if(r.code!==0)throw Error('Cannot inspect process inventory');return parseProcesses(r.stdout);}
type LifecycleIO={run?:typeof command;evidence?:typeof sessionEvidence;trust?:typeof trustedDaemon;list?:(port:number,timeout:number)=>Promise<any>};
export function liveLifecycleOps(o:LifecycleOptions,path=registryPath(),state=appState(),deadline=Date.now()+o.timeout*1000,io:LifecycleIO={}):LifecycleOps{
 const turns=turnBarrier(state);
 const remaining=()=>{const ms=deadline-Date.now();if(ms<1)throw Error('Lifecycle timeout; no force escalation was attempted');return ms;};
 const run:typeof command=args=>(io.run??command)(args,Bun.spawn,Math.min(30000,remaining()));
 const evidence=(id:string)=>(io.evidence??sessionEvidence)(id,Bun.spawn,Math.min(120000,remaining()));
 const stack=()=>liveStackOps(true,turns,o.persistent??!!o.all,run,remaining);
 const store=<T>(fn:(s:Store)=>T)=>{const s=existsSync(path)?Store.readonly(path):new Store(':memory:');try{return fn(s);}finally{s.close();}};
 const projects=()=>registeredProjects(true,undefined,path,readDefinition,true);
 const verified=async()=>{const b=daemonStatus(await run([AO,'status','--json']));if(b.ready&&!(io.trust??trustedDaemon)(b.executablePath))throw Error('Untrusted backend; preserved');return b;};
 const list=io.list??(async(port:number,timeout:number)=>{const r=await fetch(`http://127.0.0.1:${port}/api/v1/sessions`,{signal:AbortSignal.timeout(timeout)});if(!r.ok)throw Error('Native session inventory unavailable');return r.json();});
 const inventory=async():Promise<Inventory>=>{
  const b=await verified();
  if(!b.ready)return {workers:[],children:[],complete:false,externalProcesses:'Daemon unavailable: worker and detached-process state unknown; no all-stopped claim is possible'};
  // Use the native unpaged read model; the CLI's list projection can discard
  // NextCursor. Any unexpected pagination is incomplete evidence, never empty.
  const listing=await list(b.port,Math.min(10000,remaining()));
  if(!Array.isArray(listing.sessions)||listing.nextCursor)throw Error('Session inventory incomplete');
  if(new Set(listing.sessions.map((x:any)=>x.id)).size!==listing.sessions.length)throw Error('Duplicate session inventory; refresh before shutdown');
  const workers:Worker[]=[];
  for(const row of listing.sessions){
   if(typeof row.id!=='string'||! /^[\w-]+$/.test(row.id))throw Error('Invalid session identity');
   if(row.isTerminated===true)continue;
   if(row.isTerminated!==false)throw Error('Unknown session lifecycle state');
   const recorded=store(s=>workerOwnership(s,row)||!!s.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_agents'").get()&&!!s.db.query('SELECT session FROM feature_agents WHERE session=?').get(row.id));
   if(!recorded){workers.push({session:row.id,project:row.projectId??'',branch:row.branch,owned:false,exited:row.activity?.state==='exited',busy:row.activity?.state!=='exited',reason:'Shared, human-owned, or unverified session; preserved'});continue;}
   const e=await evidence(row.id),x=e.session;
   if(x.id!==row.id||x.projectId!==row.projectId||x.isTerminated!==false)throw Error('Session changed during inventory');
   const feature=store(s=>featureWorkerProject(s,e)),owned=store(s=>workerOwnership(s,x))||!!feature;
   if(!Array.isArray(e.transcript?.turns))throw Error('Queued work inventory unavailable');
   if(e.transcript.turns.some((t:any)=>typeof t.id!=='string'||!t.id))throw Error('Native turn identity unavailable');
   const busy=e.transcript.turns.some((t:any)=>!['completed','recovered','interrupted','failed','cancelled'].includes(t.state))||!(x.activity?.state==='idle'&&e.transcript.controller==='ready'||x.activity?.state==='exited'&&e.transcript.controller==='stopped');
   const worktree=owned&&!feature?store(s=>(s.db.query('SELECT worktree FROM planning_runs WHERE session_id=?').get(x.id) as any)?.worktree):undefined;
   workers.push({session:x.id,project:feature??x.projectId??'',branch:x.branch,worktree,turns:e.transcript.turns.map((t:any)=>t.id),owned,exited:x.activity?.state==='exited'&&e.transcript.controller==='stopped',busy,reason:owned?(busy?'Active, queued, or unknown work':'Durable bridge ownership verified'):'Shared, human-owned, or unverified session; preserved'});
  }
  if(!Number.isSafeInteger(b.pid)||b.pid<1)throw Error('Daemon PID unavailable');
  return {workers,children:descendants(await processInventory(run),b.pid),complete:true,externalProcesses:'Only observed daemon descendants are tracked (PID and start time). Detached/unrelated processes are not controlled or proven stopped.'};
 };
 return {turns,projects,
  holdProject:async id=>{
   await serviceControl('service-status',id,turns,{statePath:path,run:args=>run(['/bin/launchctl',...args])});
   setProjectIntakePaused(id,true,state);
  },
  project:async(action,id,persistent)=>{
   if(action==='stop'){
    // Validate identity/definition before writing a durable intake choice.
    await serviceControl('service-status',id,turns,{statePath:path,run:args=>run(['/bin/launchctl',...args])});
    setProjectIntakePaused(id,true,state);
   }
   const result=await serviceControl(action,id,turns,{statePath:path,run:args=>run(['/bin/launchctl',...args])});
   if(action==='start')setProjectIntakePaused(id,false,state);
   if(action==='stop'&&persistent){const p=(await projects()).find(x=>x.project===id);if(!p)throw Error('Project registration changed');const r=await run(['/bin/launchctl','disable',`gui/${process.getuid()}/${p.label}`]);if(r.code!==0)throw Error('Intake stopped but disabling login startup failed');}
   return {...result,intakePaused:projectIntakePaused(id,state)};
  },
  backend:async()=>{if(o.all)return stack().backend();const b=await verified();return {...b,managed:false,note:'Project scope never changes the shared backend'};},
  backendStart:()=>stack().backendStart(),backendStop:()=>stack().backendStop(),inventory,
  exit:async worker=>{
   const b=await verified();if(!b.ready)throw Error('Backend unavailable; worker exit not attempted');
   const current=await evidence(worker.session);if(!store(s=>workerOwnership(s,current.session,worker.worktree)||featureWorkerProject(s,current)===worker.project))throw Error('Worker ownership changed; exit not sent');
   if(!Array.isArray(current.transcript?.turns)||current.transcript.turns.some((t:any)=>!(worker.turns??[]).includes(t.id)))throw Error('New or unverified turn appeared; worker exit not sent');
   if(o.mode!=='workers'&&(current.session.activity?.state!=='idle'||current.transcript?.controller!=='ready'||!Array.isArray(current.transcript?.turns)||current.transcript.turns.some((t:any)=>!['completed','recovered','interrupted','failed','cancelled'].includes(t.state))))throw Error('Worker activity changed; non-interrupting exit not sent');
   const r=await run([AO,'session','exit-agent',worker.session,...(current.session.projectId?['--project',worker.project]:[]),'--json']);if(r.code!==0)throw Error(`Worker ${worker.session} exit failed or uncertain; inspect the original session, never retry by replacement`);
   const receipt=JSON.parse(r.stdout);if(receipt.ok!==true||receipt.sessionId!==worker.session)throw Error('Worker exit acknowledgement invalid; inspect original session');
  },
  checkpoint:async()=>{remaining();if(!existsSync(path))return;const db=new Database(path,{create:false});try{const r=db.query('PRAGMA wal_checkpoint(FULL)').get() as any;if(r?.busy)throw Error('Durable checkpoint busy; backend preserved');}finally{db.close();}},
  processesRemain:async previous=>{const rows=await processInventory(run);return previous.filter(p=>rows.some(r=>r.pid===p.pid&&r.started===p.started));},
  now:Date.now,sleep:ms=>Bun.sleep(ms)
 };
}
export async function managedLifecycle(action:LifecycleAction,o:LifecycleOptions,path=registryPath(),state=appState()){
 if(process.platform!=='darwin')throw Error('Managed lifecycle controls require macOS');
 const deadline=Date.now()+o.timeout*1000;
 const run=()=>controlManagedLifecycle(action,o,liveLifecycleOps(o,path,state,deadline));
 if(action==='status'||o.preview||!o.apply&&(action==='restart'||action==='stop'&&o.mode!=='pause'&&(o.all||o.mode)))return run();
 // A busy tick is not interrupted. Drain may wait for its receipt/fence to
 // settle, but never removes stale locks or assumes delivery was rolled back.
 for(;;){try{return await withStackLock(state,run);}catch(e){if(!(e instanceof TurnSubmissionBlocked)||o.mode!=='drain'||Date.now()>=deadline)throw e;await Bun.sleep(100);}}
}

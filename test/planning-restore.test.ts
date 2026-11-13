import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,digest} from '../src/core';
import {Planning} from '../src/planning';
import {Workflow} from '../src/workflow';
import {SpecRecovery} from '../src/spec-recovery';
import {PlanningRestore,planningRestore,consumePlanningRestore,restoreRepository,verifiedRestoreRegistry} from '../src/planning-restore';
import {latestRevision} from '../src/spec-revisions';
import {featureGit} from '../src/approval-policy';
import {PreSendFailure} from '../src/pre-send';
import {worktreeReservation} from '../src/worktree-reservation';
import {createWorkflowTransport} from '../src/workflow-transport';
import {planningPRFixture} from './planning-pr-fixture';

const ready='<!-- ADLC_PLAN_SCOPE {"version":1,"paths":["src/example.ts"]} -->\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->';
const config:any={repo:'/repo',githubRepo:'owner/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},automation:{planningEnabled:true,orchestratorProject:'project'},requiredChecks:['CI']};
function fixture(path=':memory:'){
 const s=new Store(path),spec=(description:string)=>JSON.stringify({identifier:'DEV-91',title:'Task',description}),job=s.enqueue('p','issue',spec('v1'));
 let restores=0;const sends:any[]=[];
 const t:any={evidence:async()=>e,worktree:async()=>({branch:p.branch,head:'a'.repeat(40),tree:'/worktree'}),disableFeedback:async()=>{},sendImplementation:async(session:string,text:string,clientId:string)=>sends.push({session,text,clientId})};
 const w=new Workflow(s,t),planning=new Planning(s),p=planning.reserve(job,'project');planning.gate(job,'project','owner',p.branch,'/worktree');
 s.db.query("INSERT INTO planning_dispatch VALUES (?,?,'planning_finished','owner',NULL,'initial')").run(job,digest(s.get(job).spec));
 s.propose(job,'Old plan\n'+ready);s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(job);
 const edit=(text:string)=>s.enqueue('p','issue',spec(text));edit('v2');
 const e:any={session:{id:'owner',projectId:'project',branch:p.branch,isTerminated:true,activity:{state:'exited'},prs:[]},receiptObservation:{complete:true,observed:Date.now()},transcript:{controller:'stopped',turns:[{id:'plan',state:'completed'}],entries:[{kind:'message',role:'assistant',origin:'provider',streaming:false,sequence:1,turnId:'plan',text:`<!-- ADLC_PLAN_READY:${p.correlation} -->\nOld plan`}]}};
 const issue:any={id:'issue',...JSON.parse(s.get(job).spec),project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}};
 const recovery=new SpecRecovery(s,w,async()=>issue,async fn=>fn());
 t.planningPRs=planningPRFixture(()=>e);
 const repository:any={tree:'/worktree',branch:p.branch,head:'a'.repeat(40),source:'/repo',common:'/repo/.git',repo:'owner/repo',prs:[],dirty:digest('dirty preserved')};
 const inspect:any=async()=>repository;
 const restore=new PlanningRestore(s,w,recovery,inspect,async fn=>fn());
 const gate=(session='owner',project='project',branch=p.branch,tree='/worktree',repo=repository,c=config)=>consumePlanningRestore(s,job,c,session,project,branch,tree,repo);
 t.restorePlan=async()=>{restores++;gate();e.session.isTerminated=false;e.session.activity.state='idle';e.transcript.controller='ready';};
 return {s,w,p,job,e,issue,restore,recovery,repository,gate,edit,sends,get restores(){return restores;}};
}
test('DEV-91 archived planning_finished owner restores in place, then replans and requires fresh approval',async()=>{
 const f=fixture();try{
  await expect(f.recovery.preview(f.job,config)).rejects.toThrow('identity changed');
  expect((await f.w.reconcilePlanning(f.job,config)).state).toBe('planning_finished');
  const before={p:f.s.db.query('SELECT * FROM planning_runs').get(),revision:latestRevision(f.s,f.job),job:f.s.get(f.job)};
  const preview=await f.restore.preview(f.job,config);expect(preview.action).toBe('restore_planning_owner');
  expect(planningRestore(f.s,f.job)).toBeNull();
  await f.restore.reconcile(f.job,config,preview.confirmation);
  expect(f.restores).toBe(1);expect(f.sends).toHaveLength(0);expect(planningRestore(f.s,f.job).state).toBe('setup_consumed');
  expect(f.s.db.query('SELECT * FROM planning_runs').get()).toEqual(before.p);expect(f.s.get(f.job)).toEqual(before.job);expect(latestRevision(f.s,f.job)).toEqual(before.revision);
  expect(worktreeReservation(f.s,f.job)?.planningRestore).toBe(true);
  await expect(f.recovery.preview(f.job,config)).rejects.toThrow('Worktree reserved');
  expect((await f.restore.reconcile(f.job,config,preview.confirmation)).action).toBe('planning_owner_restored');
  expect(worktreeReservation(f.s,f.job)).toBeUndefined();
  const revised=await f.recovery.preview(f.job,config);await f.recovery.reconcile(f.job,config,revised.confirmation);
  expect(f.sends).toHaveLength(1);expect(f.sends[0].session).toBe('owner');expect(f.sends[0].text).toContain('Do not edit files');expect(f.sends[0].text).toContain('merge, deploy');
  const d=f.s.db.query('SELECT * FROM spec_replans').get() as any;
  f.e.transcript.entries.push({clientMessageId:d.client_id,turnId:'replan',sequence:2},{kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'replan',sequence:3,text:`<!-- ADLC_REVISED_PLAN:${d.revision} -->\nRevised plan\n${ready}`});f.e.transcript.turns.push({id:'replan',state:'completed'});
  await f.recovery.capture(f.job,config);expect(f.s.get(f.job)).toMatchObject({state:'awaiting_approval',approved_hash:null});
  f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);
  expect(f.s.get(f.job).state).toBe('approved');expect(f.w.implementation(f.job).session_id).toBe('owner');
  expect(featureGit).not.toContain('merge');expect(featureGit).not.toContain('deploy');
 }finally{f.s.close();}
});

for(const invalid of ['session','project','branch','worktree','head','origin','common','source','dirty','config','requirements','dispatch','planning'])test(`DEV-91 exact setup authorization rejects ${invalid} and never widens ordinary planning`,async()=>{
 const f=fixture();try{
  f.w.t.restorePlan=async()=>{};const preview=await f.restore.preview(f.job,config);await f.restore.reconcile(f.job,config,preview.confirmation);
  const repository={...f.repository},c=structuredClone(config);
  if(['head','common','source','dirty'].includes(invalid))repository[invalid]='other';
  if(invalid==='origin')repository.repo='other/repo';
  if(invalid==='config')c.approval={enabled:false};
  if(invalid==='requirements')f.edit('v3');
  if(invalid==='dispatch')f.s.db.query("UPDATE planning_dispatch SET client_id='other'").run();
  if(invalid==='planning')f.s.db.query("UPDATE planning_runs SET session_id='other'").run();
  expect(()=>f.gate(invalid==='session'?'other':'owner',invalid==='project'?'other':'project',invalid==='branch'?'other':f.p.branch,invalid==='worktree'?'/other':'/worktree',repository,c)).toThrow('identity/spec changed');
  expect(planningRestore(f.s,f.job).state).toBe('reserved');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('DEV-91 setup authorization is one-use even for exact identity',async()=>{
 const f=fixture();try{const p=await f.restore.preview(f.job,config);await f.restore.reconcile(f.job,config,p.confirmation);expect(()=>f.gate()).toThrow('No unused');expect(f.restores).toBe(1);}finally{f.s.close();}
});

for(const invalid of ['session','project','branch','live','unknown-activity','controller','turn','missing-turns','missing-receipts','incomplete','stale','future','dispatch','Linear','requirements','repository-pr','repository-worktree'])test(`DEV-91 preview fails closed for ${invalid}`,async()=>{
 const f=fixture();try{
  if(['session','project','branch'].includes(invalid))f.e.session[{session:'id',project:'projectId',branch:'branch'}[invalid]!]='other';
  if(invalid==='live')f.e.session.isTerminated=false;
  if(invalid==='unknown-activity')delete f.e.session.activity;
  if(invalid==='controller')f.e.transcript.controller='ready';
  if(invalid==='turn')f.e.transcript.turns[0].state='running';
  if(invalid==='missing-turns')f.e.transcript.turns=[];
  if(invalid==='missing-receipts')f.e.transcript.entries=[];
  if(invalid==='incomplete')f.e.receiptObservation.complete=false;
  if(invalid==='stale')f.e.receiptObservation.observed=Date.now()-120001;
  if(invalid==='future')f.e.receiptObservation.observed=Date.now()+10000;
  if(invalid==='dispatch')f.s.db.query("UPDATE planning_dispatch SET session_id='other'").run();
  if(invalid==='Linear')f.issue.state.id='not-eligible';
  if(invalid==='requirements')f.issue.description='new requirements';
  if(invalid==='repository-pr')f.repository.prs=[{url:'https://github.com/owner/repo/pull/1'}];
  if(invalid==='repository-worktree')f.repository.tree='/other';
  await expect(f.restore.preview(f.job,config)).rejects.toThrow();expect(planningRestore(f.s,f.job)).toBeNull();expect(f.restores).toBe(0);
 }finally{f.s.close();}
});
test('DEV-91 changed requirements invalidate a confirmation before native restore',async()=>{
 const f=fixture();try{const p=await f.restore.preview(f.job,config);f.edit('v3');f.issue.description='v3';await expect(f.restore.reconcile(f.job,config,p.confirmation)).rejects.toThrow('preview changed');expect(f.restores).toBe(0);expect(planningRestore(f.s,f.job)).toBeNull();}finally{f.s.close();}
});
test('DEV-91 failed/uncertain native restore stays fenced and is never replayed',async()=>{
 const f=fixture();let calls=0;try{
  f.w.t.restorePlan=async()=>{calls++;throw Error('timeout');};const p=await f.restore.preview(f.job,config);
  await f.restore.reconcile(f.job,config,p.confirmation);expect(planningRestore(f.s,f.job).state).toBe('reserved');
  expect((await f.restore.preview(f.job,config)).action).toBe('reconcile_planning_restore');
  await expect(f.restore.reconcile(f.job,config,p.confirmation)).rejects.toThrow();expect(calls).toBe(1);expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('DEV-91 authoritative pre-launch failure permits only a fresh separately bound attempt and preserves history',async()=>{
 const f=fixture();try{
  f.w.t.restorePlan=async()=>{throw new PreSendFailure('not launched');};const first=await f.restore.preview(f.job,config);await f.restore.reconcile(f.job,config,first.confirmation);
  expect(planningRestore(f.s,f.job).state).toBe('not_sent');const next=await f.restore.preview(f.job,config);expect(next.confirmation).not.toBe(first.confirmation);
  await expect(f.restore.reconcile(f.job,config,first.confirmation)).rejects.toThrow('preview changed');await f.restore.reconcile(f.job,config,next.confirmation);
  expect(f.s.db.query('SELECT count(*) AS n FROM planning_restores').get()).toEqual({n:2});
 }finally{f.s.close();}
});
test('DEV-91 concurrent confirmations reserve once and an uncertain reply can settle from evidence after restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'planning-restore-')),path=join(dir,'state.db'),f=fixture(path);let calls=0;
 try{
  f.w.t.restorePlan=async()=>{calls++;f.gate();f.e.session.isTerminated=false;f.e.session.activity.state='idle';f.e.transcript.controller='ready';throw Error('reply lost');};
  const p=await f.restore.preview(f.job,config);
  await Promise.allSettled([f.restore.reconcile(f.job,config,p.confirmation),f.restore.reconcile(f.job,config,p.confirmation)]);
  expect(calls).toBe(1);expect(f.s.db.query('SELECT count(*) AS n FROM planning_restores').get()).toEqual({n:1});
  const reader=Store.readonly(path);try{const before=readFileSync(path),r=new PlanningRestore(reader,new Workflow(reader,f.w.t,undefined,true),f.recovery,f.restore.inspect,async fn=>fn());await r.preview(f.job,config);expect(readFileSync(path)).toEqual(before);}finally{reader.close();}
  const restarted=new Store(path);try{
   const w=new Workflow(restarted,f.w.t),recovery=new SpecRecovery(restarted,w,f.recovery.issue,async fn=>fn()),r=new PlanningRestore(restarted,w,recovery,f.restore.inspect,async fn=>fn());
   if(planningRestore(restarted,f.job).state!=='restored')expect((await r.reconcile(f.job,config,p.confirmation)).action).toBe('planning_owner_restored');
   expect(planningRestore(restarted,f.job).state).toBe('restored');expect(calls).toBe(1);
  }finally{restarted.close();}
 }finally{f.s.close();rmSync(dir,{recursive:true,force:true});}
});
test('DEV-91 transport restores only the exact session/project and makes no send/spawn request',async()=>{
 const commands:string[][]=[];
 const spawn:any=(args:string[])=>{commands.push(args);return {stdout:new Response('').body,stderr:new Response('').body,exited:Promise.resolve(0)};};
 const t=createWorkflowTransport(async fn=>fn(),spawn,async()=>{throw Error('Unexpected API request');});
 await t.restorePlan!('owner','project');expect(commands).toHaveLength(1);expect(commands[0].slice(1)).toEqual(['session','restore','owner','--project','project']);
});

for(const invalid of ['none','session','project','workspace','kind','source','competing-owner','missing-workspace'])test(`DEV-91 native registry exact identity: ${invalid}`,()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'restore-registry-'))),source=join(root,'source'),tree=join(root,'tree'),other=join(root,'other');
 mkdirSync(source);mkdirSync(tree);mkdirSync(other);const db=new Database(':memory:');
 try{
  db.exec('CREATE TABLE projects(id TEXT,path TEXT,archived_at TEXT); CREATE TABLE sessions(id TEXT,project_id TEXT,workspace_path TEXT,kind TEXT,is_terminated INTEGER)');
  db.query('INSERT INTO projects VALUES (?,?,NULL)').run('project',invalid==='source'?other:source);
  db.query('INSERT INTO sessions VALUES (?,?,?,?,1)').run(invalid==='session'?'other':'owner',invalid==='project'?'other':'project',invalid==='workspace'?other:invalid==='missing-workspace'?'':tree,invalid==='kind'?'orchestrator':'worker');
  if(invalid==='competing-owner')db.query("INSERT INTO sessions VALUES ('competing','other',?,'worker',0)").run(tree);
  const check=()=>verifiedRestoreRegistry(db,'project','owner',source,tree);
  if(invalid==='none')expect(check).not.toThrow();else expect(check).toThrow();
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

for(const invalid of ['none','valid-pr','origin','common','registration','competing-worker','competing-pr','unattached-pr','fork','inventory','PR-inventory'])test(`DEV-91 repository/ownership inspection: ${invalid}`,async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'restore-repository-'))),source=join(root,'source'),tree=join(root,'tree'),common=join(root,'common'),other=join(root,'other');
 for(const path of [source,tree,common,other])mkdirSync(path);
 const f=fixture();let registryCalls=0;
 try{
  f.s.db.query('UPDATE planning_runs SET worktree=? WHERE job=?').run(tree,f.job);
  const pr={number:1,html_url:'https://github.com/owner/repo/pull/1',head:{repo:{full_name:invalid==='fork'?'fork/repo':'owner/repo'},ref:f.p.branch,sha:'a'.repeat(40)},base:{repo:{full_name:'owner/repo'}},state:'open'};
  if(['valid-pr','competing-pr','fork'].includes(invalid))f.e.session.prs=[{number:1,url:pr.html_url,state:'open'}];
  const runner:any=async(args:string[],cwd?:string)=>{
   if(args[0]==='git'){
    if(args.includes('--show-toplevel'))return tree;
    if(args.includes('--show-current'))return f.p.branch;
    if(args.at(-1)==='HEAD')return 'a'.repeat(40);
    if(args.includes('--git-common-dir'))return invalid==='common'&&cwd===tree?other:common;
    if(args.includes('worktree'))return invalid==='registration'?'':`worktree ${tree}\nbranch refs/heads/${f.p.branch}\n`;
    if(args.includes('remote'))return invalid==='origin'?'git@github.com:wrong/repo.git':'git@github.com:owner/repo.git';
    if(args.includes('--git-path'))return join(root,'absent-operation',args.at(-1)!);
    if(args.includes('status'))return ' M preserved-local-work';
   }
   if(args[1]==='session'&&args[2]==='ls')return JSON.stringify(invalid==='inventory'?{}:{data:[{id:'owner'},...['competing-worker','competing-pr'].includes(invalid)?[{id:'competing'}]:[]]});
   if(args[1]==='session'&&args[2]==='get')return JSON.stringify({session:args[3]==='owner'?f.e.session:{id:'competing',projectId:'project',branch:invalid==='competing-worker'?f.p.branch:'another',isTerminated:false,prs:invalid==='competing-pr'?[{url:pr.html_url}]:[]}});
   if(args[0]==='gh')return JSON.stringify(invalid==='PR-inventory'?{}:[['valid-pr','competing-pr','unattached-pr','fork'].includes(invalid)?[pr]:[]]);
   throw Error('Unexpected inspection command');
  };
  const inspect=()=>restoreRepository(f.s,f.job,{...config,repo:source},runner,()=>{registryCalls++;});
  if(['none','valid-pr'].includes(invalid)){expect(await inspect()).toMatchObject({tree,source,common,repo:'owner/repo',dirty:digest(' M preserved-local-work')});expect(registryCalls).toBe(1);}
  else await expect(inspect()).rejects.toThrow();
 }finally{f.s.close();rmSync(root,{recursive:true,force:true});}
});
for(const invalid of ['missing','duplicate','failed','other-session'])test(`DEV-91 retained implementation delivery rejects ${invalid}`,async()=>{
 const f=fixture();try{
  f.s.db.query("INSERT INTO implementation_dispatch VALUES (?, 'old-plan', ?, 'prior-client','accepted','[]','supervised-host','human',NULL)").run(f.job,invalid==='other-session'?'other':'owner');
  if(invalid!=='missing'){
   f.e.transcript.entries.push({clientMessageId:'prior-client',turnId:'impl',sequence:2});f.e.transcript.turns.push({id:'impl',state:invalid==='failed'?'failed':'completed'});
   if(invalid==='duplicate')f.e.transcript.entries.push({clientMessageId:'prior-client',turnId:'impl',sequence:3});
  }
  await expect(f.restore.preview(f.job,config)).rejects.toThrow();expect(planningRestore(f.s,f.job)).toBeNull();
 }finally{f.s.close();}
});
for(const invalid of ['requirements','history','active-turn','PR','policy'])test(`DEV-91 post-reservation ${invalid} never settles or replays`,async()=>{
 const f=fixture();try{
  const p=await f.restore.preview(f.job,config);await f.restore.reconcile(f.job,config,p.confirmation);
  if(invalid==='requirements'){f.edit('v3');f.issue.description='v3';}
  if(invalid==='history')f.e.transcript.entries=[];
  if(invalid==='active-turn')f.e.transcript.turns.push({id:'new',state:'running'});
  if(invalid==='PR')f.repository.prs=[{url:'https://github.com/owner/repo/pull/2'}];
  const c=invalid==='policy'?{...config,approval:{enabled:false}}:config;
  await expect(f.restore.reconcile(f.job,c,p.confirmation)).rejects.toThrow();expect(planningRestore(f.s,f.job).state).toBe('setup_consumed');expect(f.restores).toBe(1);expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('DEV-91 restore honors planning capacity and uncertain restores retain the slot',async()=>{
 const f=fixture();try{
  const second=f.s.enqueue('p','other','other spec'),p=new Planning(f.s).reserve(second,'project');
  f.s.db.query("INSERT INTO planning_dispatch VALUES (?,?,'planning','other',NULL,'other-client')").run(second,p.spec_hash);
  const c={...config,automation:{...config.automation,maxPlanning:1}},preview=await f.restore.preview(f.job,c);
  await expect(f.restore.reconcile(f.job,c,preview.confirmation)).rejects.toThrow('concurrency limit');expect(f.restores).toBe(0);
  f.s.db.query("UPDATE planning_dispatch SET state='planning_finished' WHERE job=?").run(second);
  f.w.t.restorePlan=async()=>{throw Error('uncertain');};await f.restore.reconcile(f.job,c,preview.confirmation);
  const third=f.s.enqueue('p','third','third spec');
  await expect(f.w.startPlanning(third,c)).rejects.toThrow('concurrency limit');expect(f.sends).toHaveLength(0);
 }finally{f.s.close();}
});
test('DEV-91 archived preview is read-only and a lost restore reply settles only from retained evidence after reopening',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'restore-reopen-')),path=join(dir,'state.db'),f=fixture(path);let calls=0;
 try{
  f.s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const bytes=readFileSync(path),reader=Store.readonly(path);
  let preview:any;
  try{
   const w=new Workflow(reader,f.w.t,undefined,true),recovery=new SpecRecovery(reader,w,f.recovery.issue,async fn=>fn());
   preview=await new PlanningRestore(reader,w,recovery,f.restore.inspect,async fn=>fn()).preview(f.job,config);
  }finally{reader.close();}
  expect(readFileSync(path)).toEqual(bytes);expect(planningRestore(f.s,f.job)).toBeNull();
  f.w.t.restorePlan=async()=>{calls++;f.gate();f.e.session.isTerminated=false;f.e.session.activity.state='idle';f.e.transcript.controller='ready';throw Error('reply lost');};
  await f.restore.reconcile(f.job,config,preview.confirmation);expect(planningRestore(f.s,f.job).state).toBe('setup_consumed');
  const reopened=new Store(path);try{
   const w=new Workflow(reopened,f.w.t),recovery=new SpecRecovery(reopened,w,f.recovery.issue,async fn=>fn()),restore=new PlanningRestore(reopened,w,recovery,f.restore.inspect,async fn=>fn());
   expect((await restore.reconcile(f.job,config,preview.confirmation)).action).toBe('planning_owner_restored');expect(calls).toBe(1);expect(f.sends).toHaveLength(0);
  }finally{reopened.close();}
 }finally{f.s.close();rmSync(dir,{recursive:true,force:true});}
});

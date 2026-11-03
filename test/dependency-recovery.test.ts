import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {DependencyRecovery} from '../src/dependency-recovery';
import {validateDependencies} from '../src/dependency-policy';
import {dependencyRelations,dependencyIO} from '../src/dependency-evidence';
import {assertWorktreeAvailable} from '../src/worktree-reservation';
import {LinearBlockers} from '../src/linear-blockers';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root='11111111-1111-1111-1111-111111111111',one='22222222-2222-2222-2222-222222222222',two='33333333-3333-3333-3333-333333333333';
const old='a'.repeat(40),base='b'.repeat(40);
async function fixture(){
 const s=new Store(':memory:'),sends:any[]=[];let e:any,head=old,merged=0,updates=0,fetches=0,lose=false,receipt=true;
 const issue={id:root,identifier:'DEV-19',title:'Implement',description:'Two prerequisites',project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}};
 const c:any={repo:'/repo',githubRepo:'owner/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},requiredChecks:['CI'],automation:{planningEnabled:true,orchestratorProject:'project'}};
 const t:any={
  async startPlan(r:any){const row=s.db.query('SELECT job FROM planning_runs WHERE branch=?').get(r.branch) as any;new Planning(s).gate(row.job,r.project,'session',r.branch,'/worktrees/session');e={session:{id:'session',projectId:r.project,branch:r.branch,isTerminated:false,prs:[]},transcript:{controller:'ready',entries:[],turns:[]}};return {id:'session'};},
 async findPlans(){return [e.session];},async evidence(){e.receiptObservation={complete:true,observed:Date.now()};return e;},async disableFeedback(){},async worktree(){return {branch:e.session.branch,head};},
  async sendImplementation(session:string,prompt:string,clientId:string){sends.push({session,prompt,clientId});if(receipt){const id=`turn-${sends.length}`;e.transcript.entries.push({sequence:sends.length*10,kind:'message',role:'user',clientMessageId:clientId,turnId:id});e.transcript.turns.push({id,state:'running'});}if(lose)throw Error('lost receipt');},
 };
 const w=new Workflow(s,t),job=s.enqueue('p',root,JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description}));
 await w.tick(c);const p=new Planning(s).get(job);
 e.transcript={controller:'ready',entries:[{sequence:1,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'plan',text:`<!-- ADLC_PLAN_READY:${p.correlation} -->\nImplement.\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[]} -->`}],turns:[{id:'plan',state:'completed'}]};
 await w.tick(c);w.approve(job,s.get(job).plan_hash,'Patrick',['src/**','test/**'],'supervised-host',['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);
 await w.executeApproved(job,c);
 s.db.query('UPDATE git_grants SET operations=? WHERE job=?').run(JSON.stringify(['inspect','fetch','worktree','branch','commit','push-feature','open-pr','merge-base-feature']),job);
 e.transcript.turns.at(-1).state='completed';e.transcript.entries.push({sequence:11,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'turn-1',text:'<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"blocked-dependency","questions":[],"dependencies":[{"ref":"DEV-15"},{"ref":"DEV-18"}]} -->'});
 await w.executionStatus(job,e,c);
 c.dependencyRecovery={enabled:true,baseBranch:'main',jobs:[{issue:root,planHash:s.get(job).plan_hash,specHash:digest(s.get(job).spec),prerequisites:[{issue:one,ref:'DEV-15',repo:'owner/repo',pr:3,kind:'source',capabilities:[{path:'src/verification.ts',sha256:'c'.repeat(64)}]},{issue:two,ref:'DEV-18',repo:'owner/repo',pr:6,kind:'source',capabilities:[{path:'src/readiness.ts',sha256:'d'.repeat(64)}]}]}]};
 const io:any={
  async issue(id:string){return id===root?issue:{id,identifier:id===one?'DEV-15':'DEV-18'};},
  async relations(id:string){return id===root?[one,two]:[];},
  async provider(){if(merged<2)throw Error(`Only ${merged}/2 prerequisites merged`);return {repo:'owner/repo',baseBranch:'main',base,dependencies:c.dependencyRecovery.jobs[0].prerequisites};},
  async facts(){return {tree:'/worktrees/session',branch:e.session.branch,head,remote:'',session:'session',project:'project',clean:true,isolated:true,idle:true,completed:true,owners:['session']};},
  async fetch(){fetches++;},async includes(){return true;},async capabilities(){},async update(){updates++;head=base;},
 };
 const r=new DependencyRecovery(s,w,io,async fn=>fn());
 return {s,w,r,c,job,e,sends,io,issue,setMerged:(n:number)=>merged=n,setHead:(v:string)=>head=v,setLost:(v:boolean,hasReceipt=true)=>{lose=v;receipt=hasReceipt;},updates:()=>updates,fetches:()=>fetches};
}
test('DEV-19: first merge waits; second verifies/updates and sends exactly once to original session',async()=>{
 const f=await fixture();try{
  f.setMerged(1);expect((await f.r.tick(f.job,f.c)).state).toBe('waiting_for_dependencies');expect(f.updates()).toBe(0);expect(f.sends).toHaveLength(1);
  f.setMerged(2);const result=await f.r.tick(f.job,f.c);expect(result.reason).toBe('continuation_delivery_accepted');expect(result.state).toBe('resumed');expect(f.updates()).toBe(1);expect(f.sends).toHaveLength(2);expect(f.sends[1].session).toBe('session');expect(f.sends[1].prompt).not.toContain('A named human (verified');
  await f.r.tick(f.job,f.c);expect(f.sends).toHaveLength(2);expect(f.updates()).toBe(1);
  expect(f.s.db.query('SELECT count(*) n FROM remediation').get()).toEqual({n:0});
 }finally{f.s.close();}
});
test('read-only preview has no reservation or Git mutation and binds confirmation',async()=>{
 const f=await fixture();try{f.setMerged(2);const p=await f.r.preview(f.job,f.c);expect(p.mode).toBe('preview_only');expect(f.r.rows()).toEqual([]);expect(f.fetches()).toBe(0);expect((await f.r.tick(f.job,f.c,'0'.repeat(64))).reason).toContain('preview changed');expect(f.updates()).toBe(0);}finally{f.s.close();}
});
test('concurrent polls reserve only one update and continuation',async()=>{
 const f=await fixture();try{f.setMerged(2);await Promise.all([f.r.tick(f.job,f.c),f.r.tick(f.job,f.c)]);expect(f.updates()).toBe(1);expect(f.sends.length).toBe(2);}finally{f.s.close();}
});
for(const scenario of ['capability','provider','dirty','shared','divergent','cycle','spec','approval','queued','runtime','grant','base-change','unmapped'])test(`${scenario} blocks without continuation`,async()=>{
 const f=await fixture();try{
  f.setMerged(2);const facts=f.r.io.facts;
  if(scenario==='capability')f.r.io.capabilities=async()=>{throw Error('Missing capability');};
  if(scenario==='provider')f.r.io.provider=async()=>{throw Error('Rate limited/provider unavailable');};
  if(scenario==='dirty')f.r.io.facts=async(...a)=>({...await facts(...a),clean:false});
  if(scenario==='shared')f.r.io.facts=async(...a)=>({...await facts(...a),owners:['session','other']});
  if(scenario==='queued')f.r.io.facts=async(...a)=>({...await facts(...a),idle:false});
  if(scenario==='divergent')f.r.io.includes=async()=>false;
  if(scenario==='cycle')f.r.io.relations=async(id)=>id===root?[one]:[root];
  if(scenario==='unmapped')f.r.io.relations=async(id)=>id===root?['44444444-4444-4444-4444-444444444444']:[];
  if(scenario==='spec')f.s.db.query('UPDATE jobs SET spec=? WHERE id=?').run('changed',f.job);
  if(scenario==='approval')f.s.db.query('UPDATE jobs SET approved_hash=NULL WHERE id=?').run(f.job);
  if(scenario==='runtime')f.s.db.query('UPDATE implementation_dispatch SET runtime=? WHERE job=?').run('unsupported',f.job);
  if(scenario==='grant')f.s.db.query('UPDATE git_grants SET operations=? WHERE job=?').run('[]',f.job);
  if(scenario==='base-change'){const update=f.r.io.update;f.r.io.update=async(...a)=>{await update(...a);f.r.io.provider=async()=>({repo:'owner/repo',baseBranch:'main',base:'e'.repeat(40),dependencies:[]});};}
  expect((await f.r.tick(f.job,f.c)).state).toBe('waiting_for_dependencies');expect(f.sends).toHaveLength(1);
  expect(f.updates()).toBe(scenario==='base-change'?1:0);
  const active=f.r.status().updates.filter((r:any)=>['reserved','fetching','updating'].includes(r.state));
  expect(active.length).toBe(['capability','divergent','base-change'].includes(scenario)?1:0);
 }finally{f.s.close();}
});
test('failed fetch stays fenced until confirmed changed-base supersession with identical owned HEAD',async()=>{
 const f=await fixture();try{
  f.setMerged(2);const fetch=f.r.io.fetch;f.r.io.fetch=async()=>{throw Error('fetch unavailable');};
  await f.r.tick(f.job,f.c);expect(f.updates()).toBe(0);expect(()=>assertWorktreeAvailable(f.s,f.job)).toThrow('reserved');
  const provider=f.r.io.provider;f.r.io.provider=async(...a)=>({...await provider(...a),base:'e'.repeat(40)});
  await f.r.tick(f.job,f.c);expect(f.updates()).toBe(0);expect(f.r.status().updates[0].state).toBe('fetching');
  f.r.io.fetch=fetch;f.r.io.update=async(_tree,base)=>{f.setHead(base);};
  const p=await f.r.preview(f.job,f.c);expect((await f.r.tick(f.job,f.c,p.confirmation)).state).toBe('resumed');
  expect(f.r.status().updates.some((r:any)=>r.state==='superseded')).toBe(true);expect(()=>assertWorktreeAvailable(f.s,f.job)).not.toThrow();
 }finally{f.s.close();}
});
test('changed HEAD prevents supersession of an interrupted fetch',async()=>{
 const f=await fixture();try{
  f.setMerged(2);f.r.io.fetch=async()=>{throw Error('fetch failed');};await f.r.tick(f.job,f.c);
  const provider=f.r.io.provider;f.r.io.provider=async(...a)=>({...await provider(...a),base:'e'.repeat(40)});f.setHead('f'.repeat(40));
  const p=await f.r.preview(f.job,f.c);expect((await f.r.tick(f.job,f.c,p.confirmation)).reason).toContain('HEAD changed');expect(f.r.status().updates[0].state).toBe('fetching');expect(f.updates()).toBe(0);
 }finally{f.s.close();}
});
test('one failed dependency notice does not prevent another job notice',async()=>{
 const f=await fixture();try{
  await f.r.tick(f.job,f.c);const other=f.s.enqueue('p','other','other');f.s.propose(other,'plan');
  f.s.db.query('INSERT INTO dependency_waits VALUES (?,?,?,?,?)').run(other,f.s.get(other).plan_hash,'waiting_for_dependencies','wait','{}');
  const calls:string[]=[];
  const results=await f.r.notices({...f.c,blockerSync:{enabled:true}}, {leave:async(job:string)=>{calls.push(job);if(job===f.job)throw Error('uncertain notice');},retract:async()=>{}} as any);
  expect(calls).toEqual([f.job,other]);expect(results[0].state).toBe('blocked');expect(results[1].state).toBe('posted');
 }finally{f.s.close();}
});
test('crash after Git update reconciles exact HEAD without repeating update',async()=>{
 const f=await fixture();try{f.setMerged(2);const update=f.r.io.update;f.r.io.update=async(...a)=>{await update(...a);throw Error('crash after update');};await f.r.tick(f.job,f.c);expect(()=>assertWorktreeAvailable(f.s,f.job)).toThrow('reserved');f.r.io.update=update;expect((await f.r.tick(f.job,f.c)).state).toBe('resumed');expect(f.updates()).toBe(1);}finally{f.s.close();}
});
test('crash before Git update never blindly replays updating stage',async()=>{
 const f=await fixture();try{f.setMerged(2);f.r.io.update=async()=>{throw Error('crash before update');};await f.r.tick(f.job,f.c);expect((await f.r.tick(f.job,f.c)).reason).toContain('Updated HEAD');expect(f.sends).toHaveLength(1);}finally{f.s.close();}
});
for(const receipt of [true,false])test(`lost provider acceptance, receipt=${receipt}: never resend across coordinator restart`,async()=>{
 const f=await fixture();try{
  f.setMerged(2);f.setLost(true,receipt);expect((await f.r.tick(f.job,f.c)).state).toBe('delivery_uncertain');
  const restarted=new DependencyRecovery(f.s,f.w,f.r.io,async fn=>fn());await restarted.tick(f.job,f.c);expect(f.sends).toHaveLength(2);
  if(receipt){f.e.transcript.turns.at(-1).state='completed';await f.w.executionStatus(f.job,f.e,f.c);expect((await restarted.tick(f.job,f.c)).state).toBe('resumed');}
 }finally{f.s.close();}
});
test('Linear dependency edges paginate and reject repeated cursors',async()=>{
 let calls=0;expect(await dependencyRelations(root,async(_q,v)=>({issue:{id:root,inverseRelations:{nodes:[{type:'blocks',issue:{id:++calls===1?one:two}}],pageInfo:{hasNextPage:!v.after,endCursor:'cursor'}}}}))).toEqual([one,two]);
 await expect(dependencyRelations(root,async()=>({issue:{id:root,inverseRelations:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'same'}}}}))).rejects.toThrow('pagination');
});
test('policy rejects cycles, duplicate PR mappings and unsafe capability paths',async()=>{
 const f=await fixture();try{const p=f.c.dependencyRecovery.jobs[0];p.prerequisites[0].capabilities[0].path='../secret';expect(()=>validateDependencies(f.c)).toThrow('capability');p.prerequisites[0].capabilities[0].path='src/x.ts';p.prerequisites[0].issue=root;expect(()=>validateDependencies(f.c)).toThrow('cycle');}finally{f.s.close();}
});
test('provider proof requires exact merge inclusion and capability bytes, never Done alone',async()=>{
 const f=await fixture();try{
  const def=f.c.dependencyRecovery.jobs[0];for(const d of def.prerequisites)d.capabilities=[{path:'src/a.ts',sha256:digest('contract\n')}];
  let merged=true,content='contract\n',included=true;
  const io=dependencyIO(f.s,async args=>{const path=args.at(-1)!;return JSON.stringify(path.includes('/branches/')?{name:'main',commit:{sha:base}}:path.includes('/pulls/')?{number:Number(path.split('/').at(-1)),html_url:`https://github.com/owner/repo/pull/${path.split('/').at(-1)}`,merged,merged_at:'date',state:merged?'closed':'open',merge_commit_sha:old,base:{repo:{full_name:'owner/repo'},ref:'main'}}:path.includes('/compare/')?{status:included?'ahead':'diverged',merge_base_commit:{sha:old}}:{type:'file',path:'src/a.ts',encoding:'base64',content:Buffer.from(content).toString('base64'),size:content.length});});
  expect((await io.provider(f.c,def)).base).toBe(base);merged=false;await expect(io.provider(f.c,def)).rejects.toThrow('verified merge');merged=true;included=false;await expect(io.provider(f.c,def)).rejects.toThrow('not included');included=true;content='wrong';await expect(io.provider(f.c,def)).rejects.toThrow('capability');content='contract\n';def.prerequisites[0].kind='host-runtime';await expect(io.provider(f.c,def)).rejects.toThrow('operator reconciliation');
 }finally{f.s.close();}
});
test('deduplicated dependency/resolution notices share publisher and retain waiting label',async()=>{
 const f=await fixture();try{
   const comments:any[]=[],label=one;let labelWrites=0;f.c.blockerSync={enabled:true,labelId:label};
  const blockers=new LinearBlockers(f.s,async(q,v)=>{
   if(q.includes('commentCreate')){const comment={...v.input,createdAt:'2026-11-02T00:00:00Z'};comments.push(comment);return {commentCreate:{success:true,comment}};}
   if(q.includes('comments(first:100'))return {issue:{id:root,comments:{nodes:comments,pageInfo:{hasNextPage:false}}}};
    if(q.includes('issueUpdate')){labelWrites++;f.issue.labels.nodes=v.added?[...f.issue.labels.nodes,{id:label}]:f.issue.labels.nodes.filter(l=>l.id!==label);return {issueUpdate:{success:true,issue:f.issue}};}
   return {issue:f.issue};
  });
  await f.r.tick(f.job,f.c);await f.r.notices(f.c,blockers);await f.r.notices(f.c,blockers);await blockers.sync(f.c);
  expect(comments).toHaveLength(1);expect(comments[0].body).toContain('Waiting for dependencies');expect(f.issue.labels.nodes.some(l=>l.id===label)).toBe(true);
  f.setMerged(2);await f.r.tick(f.job,f.c);await f.r.notices(f.c,blockers);await f.r.tick(f.job,f.c);await f.r.notices(f.c,blockers);
   expect(comments).toHaveLength(2);expect(f.issue.labels.nodes.some(l=>l.id===label)).toBe(false);
   for(const outcome of ['needs_input','failed','uncertain','needs_reconciliation']){
    f.s.db.query('UPDATE worker_outcomes SET outcome=? WHERE job=?').run(outcome,f.job);
    await blockers.sync(f.c);const before=labelWrites,notices=comments.length;
    for(let i=0;i<2;i++){await f.r.notices(f.c,blockers);await blockers.sync(f.c);}
    expect(f.issue.labels.nodes.some(l=>l.id===label)).toBe(true);expect(labelWrites).toBe(before);expect(comments).toHaveLength(notices);
   }
 }finally{f.s.close();}
});
test('resumed dependency wait retains blocked label for a later worker blocker',async()=>{
 const f=await fixture();try{
  const comments:any[]=[],label=one;let labelWrites=0;f.c.blockerSync={enabled:true,labelId:label};
  const blockers=new LinearBlockers(f.s,async(q,v)=>{
   if(q.includes('commentCreate')){const comment={...v.input,createdAt:'2026-11-02T00:00:00Z'};comments.push(comment);return {commentCreate:{success:true,comment}};}
   if(q.includes('comments(first:100'))return {issue:{id:root,comments:{nodes:comments,pageInfo:{hasNextPage:false}}}};
   if(q.includes('issueUpdate')){labelWrites++;f.issue.labels.nodes=v.added?[...f.issue.labels.nodes,{id:label}]:f.issue.labels.nodes.filter(l=>l.id!==label);return {issueUpdate:{success:true,issue:f.issue}};}
   return {issue:f.issue};
  });
  await f.r.tick(f.job,f.c);await f.r.notices(f.c,blockers);
  expect(f.issue.labels.nodes.some(l=>l.id===label)).toBe(true);
  f.s.db.query("UPDATE dependency_waits SET state='resumed' WHERE job=?").run(f.job);
  f.s.db.query("UPDATE worker_outcomes SET outcome='blocked_dependency' WHERE job=?").run(f.job);
  const before=labelWrites;
  await f.r.notices(f.c,blockers);const beforeSyncComments=comments.length;
  await blockers.sync(f.c);
  expect(f.issue.labels.nodes.some(l=>l.id===label)).toBe(true);
  expect(labelWrites).toBe(before);
  expect(comments).toHaveLength(beforeSyncComments);
 }finally{f.s.close();}
});
test('explicit confirmation reconciles interrupted pre-update Git stage, automatic poll does not',async()=>{
 const f=await fixture();try{f.setMerged(2);const update=f.r.io.update;f.r.io.update=async()=>{throw Error('interrupted');};await f.r.tick(f.job,f.c);f.r.io.update=update;expect((await f.r.tick(f.job,f.c)).state).toBe('waiting_for_dependencies');const p=await f.r.preview(f.job,f.c);expect((await f.r.tick(f.job,f.c,p.confirmation)).state).toBe('resumed');expect(f.updates()).toBe(1);}finally{f.s.close();}
});
test('scope changes during update stop continuation and preserve updated work',async()=>{
 const f=await fixture();try{f.setMerged(2);const update=f.r.io.update;f.r.io.update=async(...a)=>{await update(...a);f.s.db.query('UPDATE implementation_dispatch SET paths=? WHERE job=?').run('["src/only.ts"]',f.job);};expect((await f.r.tick(f.job,f.c)).state).toBe('waiting_for_dependencies');expect(f.sends).toHaveLength(1);expect(f.updates()).toBe(1);}finally{f.s.close();}
});
test('real temporary Git fast-forward preserves branch and validates exact capability bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-dependency-git-')),s=new Store(':memory:');
 const git=(...args:string[])=>{const p=Bun.spawnSync(['git',...args],{cwd:dir,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},stdout:'pipe',stderr:'pipe'});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString().trim();};
 try{
  git('init','-b','fixture-base');mkdirSync(join(dir,'src'));writeFileSync(join(dir,'src/a.ts'),'old\n');git('add','.');git('commit','-m','fixture old');const original=git('rev-parse','HEAD');
  writeFileSync(join(dir,'src/a.ts'),'contract\n');git('add','.');git('commit','-m','fixture capability');const target=git('rev-parse','HEAD');git('checkout','-b','fixture-feature',original);
  const io=dependencyIO(s),definition:any={prerequisites:[{capabilities:[{path:'src/a.ts',sha256:digest('contract\n')}]}]};
  expect(await io.includes(dir,original,target)).toBe(true);await io.capabilities(dir,target,definition);await io.update(dir,target);
  expect(git('branch','--show-current')).toBe('fixture-feature');expect(git('rev-parse','HEAD')).toBe(target);expect(git('status','--porcelain')).toBe('');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('exhausted remediation budget blocks without consuming or resetting attempts',async()=>{
 const f=await fixture();try{
  f.setMerged(2);
  f.s.db.query("INSERT INTO remediation_budget(job,configured_max_attempts,configured_max_no_progress,consumed,extensions,no_progress,stop_reason) VALUES (?,5,5,5,0,2,'attempts_exhausted')").run(f.job);
  const before=f.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(f.job);
  expect((await f.r.tick(f.job,f.c)).reason).toContain('remediation_budget');expect(f.sends).toHaveLength(1);expect(f.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(f.job)).toEqual(before);
 }finally{f.s.close();}
});
test('worker blocking again after completed continuation requires no-progress reconciliation',async()=>{
 const f=await fixture();try{
  f.setMerged(2);await f.r.tick(f.job,f.c);f.e.transcript.turns.at(-1).state='completed';f.e.transcript.entries.push({sequence:21,kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'turn-2',text:'<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"blocked-dependency","questions":[],"dependencies":[{"ref":"DEV-15"}]} -->'});
  await f.w.executionStatus(f.job,f.e,f.c);expect((await f.r.tick(f.job,f.c)).reason).toContain('no progress');expect(f.sends).toHaveLength(2);
 }finally{f.s.close();}
});
test('crash after continuation intent reservation never retries missing provider receipt',async()=>{
 const f=await fixture();try{
  f.setMerged(2);f.setLost(true,false);await f.r.tick(f.job,f.c);f.s.db.query("UPDATE continuations SET state='reserved'").run();await f.r.tick(f.job,f.c);expect(f.sends).toHaveLength(2);expect(f.r.rows()[0].state).toBe('delivery_uncertain');
 }finally{f.s.close();}
});
test('restart after provider acceptance reconciles pre-saved ready status without resend',async()=>{
 const f=await fixture();try{
  f.setMerged(2);await f.r.tick(f.job,f.c);f.s.db.query("UPDATE dependency_waits SET state='ready'").run();await f.w.executionStatus(f.job,f.e,f.c);
  const restarted=new DependencyRecovery(f.s,f.w,f.r.io,async fn=>fn());expect((await restarted.sync(f.c))[0].state).toBe('resumed');expect(f.sends).toHaveLength(2);
 }finally{f.s.close();}
});

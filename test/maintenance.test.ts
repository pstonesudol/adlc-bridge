import {test,expect} from 'bun:test';import {assertIdle,assertCleanup} from '../src/maintenance';
import {maintenance} from '../src/maintenance';import {Store} from '../src/core';import {Planning} from '../src/planning';import {Lifecycle} from '../src/lifecycle';import {ReviewLoop} from '../src/review-loop';import {BranchUpdates} from '../src/branch-updates';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const e=()=>({session:{id:'worker',branch:'adlc/feature',prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',turns:[{state:'completed'}]}});
test('maintenance refuses queued or unknown turns and missing controller evidence',()=>{expect(()=>assertIdle(e())).not.toThrow();expect(()=>assertIdle({...e(),transcript:{controller:'ready',turns:[{state:'queued'}]}})).toThrow('active');expect(()=>assertIdle({})).toThrow('uncertain');});
test('cleanup requires observed completion, exact session, owned PR and actual merge',()=>{const j={state:'done'},r={state:'completed',owner:'orchestrator',session_id:'worker'},t={state:'completed',repo:'owner/repo',pr:1},pr={merged:true,head:{ref:'adlc/feature',repo:{full_name:'owner/repo'}}};expect(()=>assertCleanup(j,r,t,e(),pr)).not.toThrow();expect(()=>assertCleanup(j,r,t,e(),{...pr,merged:false})).toThrow('Merged');expect(()=>assertCleanup(j,{...r,session_id:'other'},t,e(),pr)).toThrow('match');expect(()=>assertCleanup({state:'approved'},r,t,e(),pr)).toThrow('completed');});
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'adlc-maintenance-'))),repo=join(root,'repo'),tree=join(root,'tree');mkdirSync(repo);mkdirSync(tree);
 const git=(...args:string[])=>{const r=Bun.spawnSync(['/usr/bin/git','-C',tree,...args]);if(r.exitCode)throw Error(r.stderr.toString());return r.stdout.toString().trim();};
 git('init','-q');writeFileSync(join(tree,'.gitignore'),'ignored\n');git('add','.gitignore');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');const head=git('rev-parse','HEAD');
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('linear','issue','spec'),r=p.reserve(id,'ao');p.gate(id,'ao','worker',r.branch,tree);const hash=s.propose(id,'plan');s.approve(id,hash,'human');new Lifecycle(s).adoptSupervised(id,{id:'worker',correlation:r.correlation,worktree:tree,controller:'running'});new ReviewLoop(s).register(id,'owner/repo',1,['CI'],['src/**']);new BranchUpdates(s);
 const config=join(root,'config.json'),c={linear:{projectId:'linear'},automation:{orchestratorProject:'ao'},repo,githubRepo:'owner/repo'};writeFileSync(config,JSON.stringify(c));
 const evidence={...e(),session:{...e().session,branch:r.branch,worktree:tree}};const pr:any={state:'open',merged:false,head:{sha:head,ref:r.branch,repo:{full_name:'owner/repo'}},base:{sha:'base'}};
 const writes:string[]=[];let proven=true;
 const io:any={registrations:()=>[{project:'ao',linear_project:'linear',repo,config}],sessionEvidence:async()=>evidence,gh:async(path:string)=>path.includes('/compare/')?{status:proven?'ahead':'diverged'}:pr,
  localAO:async()=>{writes.push('kill');return {};},poll:async()=>{writes.push('poll');},linearToken:()=>'',review:()=>({configureMetadataChecks:()=>writes.push('policy'),tick:async()=>{writes.push('tick');return {};}})};
 return {s,id,tree,root,config,c,pr,io,writes,unproven:()=>proven=false,done:()=>{s.db.exec("UPDATE jobs SET state='done';UPDATE runs SET state='completed';UPDATE review_targets SET state='completed';");pr.merged=true;pr.state='closed';},close:()=>{s.close();rmSync(root,{recursive:true,force:true});}};
}
test('maintenance preview and stale confirmation never perform external or durable writes',async()=>{
 const f=fixture();try{
  const before=f.s.db.query('SELECT count(*) AS n FROM events').get();const preview=await maintenance(f.s,'recover',f.id,false,undefined,f.io);expect(preview.preview).toBe(true);
  await expect(maintenance(f.s,'recover',f.id,true,'stale',f.io)).rejects.toThrow('confirmation');expect(f.writes).toEqual([]);expect(f.s.db.query('SELECT count(*) AS n FROM events').get()).toEqual(before);
  f.done();const cleanup=await maintenance(f.s,'cleanup',f.id,false,undefined,f.io);expect(cleanup.preview).toBe(true);await expect(maintenance(f.s,'cleanup',f.id,true,'stale',f.io)).rejects.toThrow('confirmation');expect(f.writes).toEqual([]);
 }finally{f.close();}
});
test('cleanup rejects dirty and ignored files even with a previously valid confirmation',async()=>{
 for(const file of ['dirty','ignored']){const f=fixture();try{f.done();const preview=await maintenance(f.s,'cleanup',f.id,false,undefined,f.io);writeFileSync(join(f.tree,file),'preserve');await expect(maintenance(f.s,'cleanup',f.id,true,preview.confirmation,f.io)).rejects.toThrow('preserved');expect(f.writes).toEqual([]);expect(readFileSync(join(f.tree,file),'utf8')).toBe('preserve');}finally{f.close();}}
});
test('recovery refuses changed Linear, repository or Orchestrator registration before reading providers',async()=>{
 for(const change of [{linear:{projectId:'other'}},{repo:'/'},{automation:{orchestratorProject:'other'}}]){const f=fixture();try{writeFileSync(f.config,JSON.stringify({...f.c,...change}));f.io.gh=async()=>{throw Error('provider must not be read');};await expect(maintenance(f.s,'recover',f.id,true,'any',f.io)).rejects.toThrow('identity changed');expect(f.writes).toEqual([]);}finally{f.close();}}
});
test('uncertain recovery changes only proven rows after exact confirmation and preserves attempt budgets',async()=>{
 const f=fixture();try{
  f.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(f.id,'old','base','delivery_uncertain',1,'lost');f.s.db.query('UPDATE jobs SET attempts=4 WHERE id=?').run(f.id);
  const preview=await maintenance(f.s,'recover',f.id,false,undefined,f.io);expect(preview.provenBranchUpdates).toEqual([{head:'old',base:'base'}]);expect(f.writes).toEqual([]);
  await maintenance(f.s,'recover',f.id,true,preview.confirmation,f.io);expect(f.writes).toEqual(['poll','policy','tick']);expect(f.s.db.query('SELECT state FROM branch_updates').get()).toEqual({state:'observed'});expect(f.s.get(f.id).attempts).toBe(4);
 }finally{f.close();}
 const g=fixture();try{g.s.db.query('INSERT INTO branch_updates VALUES (?,?,?,?,?,?)').run(g.id,'old','base','delivery_uncertain',1,'lost');g.unproven();await expect(maintenance(g.s,'recover',g.id,true,'any',g.io)).rejects.toThrow('cannot be proven');expect(g.writes).toEqual([]);expect(g.s.db.query('SELECT state FROM branch_updates').get()).toEqual({state:'delivery_uncertain'});}finally{g.close();}
});

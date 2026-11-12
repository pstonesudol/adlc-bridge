import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,statSync,existsSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core';
import {jobBlockers,redact,safeOutput} from '../src/operator-evidence';
import {explainJob,watchJob,diagnosticExport,scopedEvents} from '../src/operator-jobs';
import {jobViews} from '../src/operator-cli';
import {LinearBlockers} from '../src/linear-blockers';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'operator-jobs-')),path=join(root,'state.sqlite'),s=new Store(path),job=s.enqueue('project','issue',JSON.stringify({identifier:'DEV-35',description:'PRIVATE SOURCE'})),hash=s.propose(job,'PRIVATE PLAN');
 s.db.exec('CREATE TABLE planning_runs(job TEXT,session_id TEXT,project TEXT,branch TEXT); CREATE TABLE implementation_dispatch(job TEXT,session_id TEXT,state TEXT,plan_hash TEXT); CREATE TABLE recovery_observations(job TEXT,failures INTEGER,reason TEXT,next_read INTEGER);');
 s.db.query('INSERT INTO planning_runs VALUES (?,?,?,?)').run(job,'session','native-project','reserved');
 s.db.query('INSERT INTO implementation_dispatch VALUES (?,?,?,?)').run(job,'session','delivery_uncertain',hash);
 s.db.query('INSERT INTO recovery_observations VALUES (?,?,?,?)').run(job,2,JSON.stringify({provider:'github',classification:'server',timestamp:123}),1000);
 s.event(job,'synthetic_secret','Bearer syntheticsecret lin_api_syntheticsecret password=private');s.close();
 return {root,path,job,hash,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('all independent blockers survive active worker observation and cleared read stop',async()=>{
 const f=fixture();try{
  const before=readFileSync(f.path),view=await explainJob(f.path,'project',f.job,async()=>({session:{id:'session',projectId:'native-project',branch:'reserved',activity:{state:'working'}},transcript:{controller:'ready',turns:[{id:'turn',state:'running'}]},receiptObservation:{observed:123}}));
  expect(view.worker.activity).toBe('running');expect(view.blockers.map(b=>b.code)).toEqual(['approval_required','implementation_dispatch:delivery_uncertain','observation']);expect(view.primary?.code).toBe('approval_required');expect(readFileSync(f.path)).toEqual(before);
  const s=new Store(f.path);s.db.query('DELETE FROM recovery_observations').run();s.close();
  expect(jobViews(f.path)[0].blockers.map(b=>b.code)).toEqual(['approval_required','implementation_dispatch:delivery_uncertain']);
 }finally{f.close();}
});
test('changed requirements plus failed reads remain explicit; identity mismatch is unknown',async()=>{
 const f=fixture();try{
  const s=new Store(f.path);s.enqueue('project','issue',JSON.stringify({identifier:'DEV-35',description:'revised'}));s.close();
  expect(jobViews(f.path)[0].blockers.map(b=>b.code)).toContain('requirements_changed');expect(jobViews(f.path)[0].blockers.map(b=>b.code)).toContain('observation');
  const view=await explainJob(f.path,'project',f.job,async()=>({session:{id:'wrong'},transcript:{turns:[]}}));expect(view.worker.activity).toBe('unknown');expect(view.unknowns[0]).toContain('identity changed');
 }finally{f.close();}
});
test('watch suppresses unchanged output, backs off, detects log transitions and cancels gracefully',async()=>{
 const abort=new AbortController(),delays:number[]=[],seen:any[]=[];let count=0;
 await watchJob(async()=>({version:'same',state:'blocked',worker:{activity:'idle'},log:{events:[{seq:++count>3?2:1}]}}),v=>seen.push(v),abort.signal,{sleep:async ms=>{delays.push(ms);if(count===5)abort.abort();},maxPolls:10});
 expect(seen).toHaveLength(2);expect(delays).toEqual([1000,2000,4000,1000,2000]);
 await watchJob(async()=>{throw Error('should not read');},()=>{},abort.signal);
});
test('diagnostic preview never writes; export contains metadata only, safe permissions and bounded scope',()=>{
 const f=fixture();try{
  const state=join(f.root,'application'),before=readFileSync(f.path),preview=diagnosticExport(f.path,'project',false,state);
  expect(existsSync(state)).toBe(false);expect(preview.output).toContain('/diagnostics/');
  const written=diagnosticExport(f.path,'project',true,state,'test'),text=readFileSync(written.output,'utf8');
  for(const secret of ['PRIVATE','syntheticsecret','lin_api_','password='])expect(text).not.toContain(secret);
  expect(statSync(written.output).mode&0o777).toBe(0o600);expect(statSync(join(state,'diagnostics')).mode&0o777).toBe(0o700);expect(readFileSync(f.path)).toEqual(before);
  const logs=JSON.stringify(scopedEvents(f.path,'project',f.job));expect(logs).toContain('synthetic_secret');expect(logs).not.toContain('syntheticsecret');
  const other=diagnosticExport(f.path,'other',true,state);expect(JSON.parse(readFileSync(other.output,'utf8')).jobs).toEqual([]);
 }finally{f.close();}
});
test('diagnostic symlink output/directory are refused, never followed',()=>{
 const f=fixture();try{
  const state=join(f.root,'application');mkdirSync(state,{mode:0o700});symlinkSync(f.root,join(state,'diagnostics'));
  expect(()=>diagnosticExport(f.path,'project',true,state)).toThrow('non-symlink');
 }finally{f.close();}
});
test('redaction handles nested secrets, auth headers and large JSON without corrupting envelopes',()=>{
 expect(redact('Bearer private ghp_private password=private https://user:private@example.com')).not.toContain('private');
 const result=safeOutput({token:'private',rows:Array(100).fill('x'.repeat(500))});expect(result.token).toBe('[REDACTED]');expect(result.rows).toHaveLength(100);
});
test('Linear notice uses CLI blocker set and current approval wording without clearing secondary gates',async()=>{
 const f=fixture();try{
  const s=new Store(f.path),comments:any[]=[];
  const api=async(query:string,variables:any)=>{
   if(query.includes('commentCreate')){const comment={...variables.input,createdAt:new Date().toISOString()};comments.push(comment);return {commentCreate:{success:true,comment}};}
   if(query.includes('comments('))return {issue:{id:'issue',comments:{nodes:comments,pageInfo:{hasNextPage:false}}}};
   return {issue:{id:'issue',identifier:'DEV-35',project:{id:'project'},team:{id:'team'},labels:{nodes:[],pageInfo:{hasNextPage:false}}}};
  };
  const publisher=new LinearBlockers(s,api),c={linear:{projectId:'project',teamId:'team'},blockerSync:{enabled:true,labelId:'00000000-0000-0000-0000-000000000001'}},outcome={plan_hash:f.hash,outcome:'needs_reconciliation',questions:'[]',dependencies:'[]'};
  await publisher.leave(f.job,outcome,c,{applyLabel:false});await publisher.leave(f.job,outcome,c,{applyLabel:false});expect(comments).toHaveLength(1);
  for(const b of jobBlockers(s,f.job).blockers)expect(comments[0].body).toContain(b.code);
  expect(comments[0].body).toContain('no valid approval token');s.close();
 }finally{f.close();}
});
test('clearing a provider read stop cannot retract unresolved approval',async()=>{
 const f=fixture();try{
  const s=new Store(f.path);s.db.query('DELETE FROM recovery_observations').run();let calls=0;
  const publisher=new LinearBlockers(s,async()=>{calls++;throw Error('No provider mutation permitted');});
  const result=await publisher.retract(f.job,{linear:{projectId:'project',teamId:'team'},blockerSync:{enabled:true}});
  expect(result.state).toBe('retained');expect(result.blockers).toContain('approval_required');expect(calls).toBe(0);s.close();
 }finally{f.close();}
});
test('new CLI inspection paths are JSON/read-only and unsafe applies are rejected',()=>{
 const f=fixture();try{
  const cli=join(import.meta.dir,'../src/cli.ts'),run=(...args:string[])=>Bun.spawnSync([process.execPath,cli,'jobs',...args],{env:{PATH:process.env.PATH,HOME:f.root,ADLC_DB:f.path}}),before=readFileSync(f.path);
  for(const verb of ['logs','reconcile']){const r=run(verb,'DEV-35','--project','project','--json');expect(r.exitCode).toBe(0);expect(JSON.parse(r.stdout.toString()).schemaVersion).toBe(1);}
  expect(run('reconcile','DEV-35','--project','project','--apply').exitCode).toBe(1);expect(run('logs','DEV-35','--apply').exitCode).toBe(2);expect(readFileSync(f.path)).toEqual(before);
 }finally{f.close();}
});
test('concurrent reconcile refreshes cannot dispatch, reset approval or mutate the source',async()=>{
 const f=fixture();try{
  const cli=join(import.meta.dir,'../src/cli.ts'),env={PATH:process.env.PATH,HOME:f.root,ADLC_DB:f.path,ADLC_AO_PATH:join(f.root,'no-daemon')},args=['jobs','reconcile','DEV-35','--project','project','--json'];
  const preview=Bun.spawnSync([process.execPath,cli,...args],{env});expect(preview.exitCode).toBe(0);const confirmation=JSON.parse(preview.stdout.toString()).data.confirmation,before=readFileSync(f.path);
  const run=async()=>{const p=Bun.spawn([process.execPath,cli,...args,'--apply','--confirm',confirmation],{env,stdout:'pipe',stderr:'pipe'});const [text,error,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {text,error,code};};
  const results=await Promise.all([run(),run()]);expect(results.some(r=>r.code===0)).toBe(true);
  for(const r of results)if(r.code===0)expect(JSON.parse(r.text).data).toMatchObject({continued:false,refreshed:true});else expect(r.code).toBe(1);
  expect(readFileSync(f.path)).toEqual(before);
 }finally{f.close();}
});

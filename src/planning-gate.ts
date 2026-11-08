import {Store} from './core';
import {tryVerifiedCoordinator} from './coordinator-gate';
import {Planning} from './planning';
import {consumePlanningRestore,restoreRepository} from './planning-restore';
import {assertCurrentPlanningRequirements} from './spec-recovery';
import {join} from 'node:path';
import {homedir} from 'node:os';

// Runs as a host setup hook before any model starts. Only the reserved branch
// and issue can launch; other sessions retain a failing startup gate.
import {realpathSync as realpath} from 'node:fs';
import {readFileSync} from 'node:fs';
async function gate(){
  if(process.env.ADLC_WORKFLOW_CONFIG){
    const c=JSON.parse(readFileSync(process.env.ADLC_WORKFLOW_CONFIG,'utf8'));
    const project=c.automation?.orchestratorProject;
    if(!c.automation?.planningEnabled||!project)throw Error('Automatic planning not enabled for project');
    const cwd=realpath(process.cwd()),source=realpath(c.repo);
    if(cwd===source||realpath(process.env.AO_SOURCE_TREE_PATH??'')!==source||realpath(process.env.AO_WORKTREE_PATH??'')!==cwd)throw Error('Unverified planning worktree');
    const p=Bun.spawn(['/usr/bin/git','branch','--show-current'],{cwd,stdout:'pipe',stderr:'pipe'});
    const [branch,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    if(code!==0)throw Error('Cannot verify branch');
    const dataRoot=join(homedir(),'.ao','data');
    if(tryVerifiedCoordinator(project,source,cwd,dataRoot)){
      const common=async(path:string)=>{
        const p=Bun.spawn(['/usr/bin/git','rev-parse','--path-format=absolute','--git-common-dir'],{cwd:path,stdout:'pipe',stderr:'pipe'});
        const [out,code]=await Promise.all([new Response(p.stdout).text(),p.exited]);
        if(code!==0)throw Error('Cannot verify coordinator repository');return realpath(out.trim());
      };
      if(await common(cwd)!==await common(source))throw Error('Coordinator repository mismatch');
      console.log('ADLC: verified project coordinator admitted; ticket workers retain their planning and implementation gates');return;
    }
    const s=new Store(join(homedir(),'Library','Application Support','ADLC Bridge','state.sqlite'));
    try{
      new Planning(s);
      if(s.db.query("SELECT name FROM sqlite_master WHERE name='planning_restores'").get()){
       const restore=s.db.query("SELECT p.job,p.session_id FROM planning_runs p JOIN planning_restores r ON r.job=p.job WHERE p.project=? AND p.branch=? AND r.state='reserved'").all(project,branch.trim()) as any[];
       if(restore.length){
        if(restore.length!==1)throw Error('Ambiguous planning restore authorization');
        const repository=await restoreRepository(s,restore[0].job,c);
        await assertCurrentPlanningRequirements(s,restore[0].job,c);
        consumePlanningRestore(s,restore[0].job,c,restore[0].session_id,project,branch.trim(),cwd,repository);
        console.log('ADLC: exact one-use planning-only restore admitted; revised planning and configured approval remain required');return;
       }
      }
      const r=s.db.query("SELECT p.job FROM planning_runs p JOIN planning_dispatch d ON p.job=d.job JOIN jobs j ON j.id=p.job WHERE p.project=? AND p.branch=? AND j.project=? AND d.state='dispatch_uncertain'").get(project,branch.trim(),c.linear.projectId) as any;
      if(!r)throw Error('No durable planning dispatch authorizes this branch');
      new Planning(s).gate(r.job,project,null,branch.trim(),cwd);
      console.log('ADLC: reserved planning stage admitted; implementation requires a separate human approval');return;
    }finally{s.close();}
  }
  const job=process.env.ADLC_PLANNING_JOB,project=process.env.ADLC_PLANNING_PROJECT;
  if(!job||!project)throw Error('ADLC planning reservation environment missing');
  const cwd=realpath(process.cwd());
  const p=Bun.spawn(['/usr/bin/git','branch','--show-current'],{cwd,stdout:'pipe',stderr:'pipe'});
  const [branch,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if(code!==0)throw Error('Cannot verify worktree branch');
  const source=process.env.ADLC_SOURCE_TREE;
  if(!source)throw Error('ADLC_SOURCE_TREE is required for the direct planning gate');
  const root=realpath(source),tree=realpath(process.env.AO_SOURCE_TREE_PATH??source);
  if(cwd===root)throw Error('Primary checkout may not be used for agent planning');
  if(tree!==root||realpath(process.env.AO_WORKTREE_PATH??'')!==cwd)throw Error('Unverified source/worktree context');
  const s=new Store(join(homedir(),'Library','Application Support','ADLC Bridge','state.sqlite'));
  try{new Planning(s).gate(job,project,null,branch.trim(),cwd);console.log('ADLC: authorized planning stage in a separate worktree; implementation remains gated');}finally{s.close();}
}
gate().catch(e=>{console.error(e instanceof Error?e.message:'Planning gate failed');process.exitCode=78;});

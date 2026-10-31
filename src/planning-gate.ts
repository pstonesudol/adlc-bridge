import {Store} from './core';
import {Planning} from './planning';
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
    const s=new Store(join(homedir(),'Library','Application Support','ADLC Bridge','state.sqlite'));
    try{
      new Planning(s);
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
  try{new Planning(s).gate(job,project,null,branch.trim(),cwd);console.log('ADLC: authorized DEV-8 planning stage in a separate worktree; implementation remains gated');}finally{s.close();}
}
gate().catch(e=>{console.error(e instanceof Error?e.message:'Planning gate failed');process.exitCode=78;});

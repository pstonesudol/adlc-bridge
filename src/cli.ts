#!/usr/bin/env bun
import {installBridge} from './install';
import {maintenance} from './maintenance';
import {installRuntime} from './runtime-install';
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {Store} from './core';
import {ApprovalPolicyStore} from './approval-policy';
import {serviceControl,registeredProjects} from './service-control';
import {stackControl} from './stack-control';
import {initWizard} from './init';
import {poll,validate,requiredCheckNames,metadataCheckNames} from './linear';
import {Bridge,inspectAO,handoffChecklist} from './orchestrator';
import {readiness} from './github';
import {linearToken,tokenPath} from './credential';
import {Lifecycle} from './lifecycle';
import {runtimeCheck} from './runtime';
import {containerCheck} from './container-check';
import {sessionEvidence,capturePlan} from './session-evidence';
import {adoptPilot,observePilot} from './pilot';
import {ReviewLoop} from './review-loop';
import {disableNativeFeedback} from './ao-policy';
import {TaskRouting,loadOpenChamber,selectRoute} from './task-routing';
import {FeaturePlanning} from './feature-planning';
import {featureAgents} from './feature-transport';
import {FeaturePublish} from './feature-publish';
import {LinearLifecycle} from './linear-lifecycle';
import {LinearApprovals} from './linear-approvals';
import {Workflow} from './workflow';
import {liveTransport,installWorkflowHook} from './workflow-transport';
import {remediationPolicy} from './remediation';

const [command='help',...a]=process.argv.slice(2);
const out=(x:unknown)=>console.log(JSON.stringify(x,null,2));
const req=(x:string|undefined,n:string)=>{if(!x)throw Error(`${n} required`);return x;};
const db=process.env.ADLC_DB??join(homedir(),'Library','Application Support','ADLC Bridge','state.sqlite');
async function main(){
  if(['recover','cleanup'].includes(command)){const s=new Store(db);try{return out(await maintenance(s,command as 'recover'|'cleanup',req(a[0],'Job'),a.includes('--apply'),a.includes('--confirm')?req(a[a.indexOf('--confirm')+1],'Confirmation hash'):undefined));}finally{s.close();}}
  if(command==='install')return out(await installBridge(a.includes('--apply'),undefined,a.includes('--bin')?req(a[a.indexOf('--bin')+1],'Launcher path'):undefined));
  if(command==='install-runtime')return out(await installRuntime(req(a.includes('--binary')?a[a.indexOf('--binary')+1]:undefined,'--binary PATH'),a.includes('--apply')));
  if(['start','stop','status'].includes(command)&&a.includes('--all')){if(a.length!==1)throw Error('Use --all without a project ID or other options');return out(await stackControl(command as 'start'|'stop'|'status'));}
  if(['start','stop','service-status'].includes(command))return out(await serviceControl(command,a[0]));
  if(command==='projects')return out(await registeredProjects());
  if(command==='help')return console.log(`ADLC Bridge 0.6 — Agent Orchestrator + OpenChamber
  recover JOB | cleanup JOB           inspect guarded recovery or completed cleanup
    [--apply --confirm HASH]           apply only the exact inspected state
  install [--apply] [--bin PATH]        preview or install stable bridge snapshot
  install-runtime --binary PATH [--apply]
                                       register reproducibly built Orchestrator daemon
  start --all | stop --all | status --all
                                       full background stack; stop requires idle workers
  projects                             list registered project services
  start [PROJECT] | stop [PROJECT]      control one project; ID required if multiple
  service-status [PROJECT]             inspect one or all project services
  feature-start CONFIG REQUIREMENTS_FILE [--title TITLE] [--no-source]
                                       parallel feature planning; no Linear writes
  feature-show ID | feature-list        review proposed ticket batch and dependencies
  feature-step ID                      reconcile planning progress once
  feature-edit ID DRAFT_JSON            revise draft and invalidate batch approval
  feature-approve ID HASH HUMAN [--acknowledge-questions]
  feature-publish ID                   create only the approved Backlog ticket batch
  feature-cancel ID                    stop owned planning agents; preserve created issues
  doctor | ao-status | ao-projects | ao-agents | ao-sessions
  auth-linear                          hidden local key entry (owner-only file)
  routing CONFIG [TASK_FILE]           show OpenChamber routes or preview task classification
  setup-workflow CONFIG                install registry-aware Orchestrator startup gate
  approvals                            list plans waiting for approval
  show-plan JOB                        show captured plan and approval hash
  approve-job JOB HASH HUMAN --paths FILES --git feature-pr --runtime supervised-host
                                       approve plan + feature Git scope once; queue execution
  runtime-check                        credential-free local container probe
  container-check WORKTREE             isolated frontend lint/types/tests
  init [ABSOLUTE_REPO] [--config PATH]  guided local setup with explicit opt-ins
  init ABSOLUTE_REPO --preview          inspect repository, no writes
  status                               durable queue and dispatch intents
  ingest PROJECT ISSUE SPEC_FILE        local ingestion
  plan JOB PLAN_FILE                    submit plan
  capture-plan JOB SESSION SEQUENCE     capture a specific Orchestrator plan; no approval
  adopt-pilot JOB SESSION               reconcile existing supervised worker only
  observe-pilot JOB OWNER/REPO PR CONFIG persist latest-SHA review evidence
  recover-handoff JOB CONFIG           reconnect an existing authorized worker PR
  register-review JOB REPO PR CONFIG    register bounded review target
  review-status                        show CI/review waits, blockers and remediation budget
  tick-review JOB                      check CI/review; send bounded in-scope fixes
  extend-budget JOB CONFIG HUMAN ADDITIONAL HEAD [--confirm HASH] [--reason TEXT]
                                       preview or apply an audited exhausted-budget extension
  approve-plan JOB HASH HUMAN           record current plan approval
  prepare JOB AO_PROJECT_ID             persist spawn preview; never executes
  poll CONFIG                          one intake, planning, execution and review tick
  serve CONFIG                         workflow tick every 60 seconds
  readiness OWNER/REPO PR CONFIG        read latest-SHA CI/CodeRabbit gate
  handoff WORKTREE                      print OpenChamber handoff checklist
No arbitrary send, merge, push, deploy or existing-credential-copy command exists.
Registered approved review targets can request bounded in-scope fixes from their existing worker.`);
  if(command==='auth-linear'){
    const p=Bun.spawn(['python3',join(import.meta.dir,'auth-linear.py')],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});
    if(await p.exited!==0)throw Error('Credential entry did not complete');return;
  }
  if(command==='routing'){
    const c=JSON.parse(readFileSync(req(a[0],'Config'),'utf8'));if(!c.routing)throw Error('OpenChamber routing is not configured for this project');
    const snapshot=await loadOpenChamber(c.routing);
    if(a[1]){let answer=null;try{answer=await snapshot.classify(readFileSync(a[1],'utf8'));}catch{}return out(selectRoute(snapshot.config,answer,answer?undefined:'classifier-unavailable'));}
    return out({source:join(c.routing.dataDir,'routing.json'),harness:c.routing.harness,projectEnabled:c.routing.enabled,enabled:snapshot.config.enabled,minConfidence:snapshot.config.minConfidence,fallback:snapshot.config.fallback,categories:snapshot.config.categories.map(x=>({id:x.id,enabled:x.enabled,model:x.model,effort:x.variant,agent:x.agent}))});
  }
  if(command==='setup-workflow')return out(await installWorkflowHook(req(a[0],'Config')));
  if(command==='container-check'){const r=await containerCheck(req(a[0],'Worktree'));out(r);if(!r.passed)process.exitCode=1;return;}
  if(command==='runtime-check')return out(await runtimeCheck());
  if(command.startsWith('ao-'))return out(await inspectAO(({ 'ao-status':'status','ao-projects':'projects','ao-agents':'agents','ao-sessions':'sessions'} as any)[command]?? (()=>{throw Error('Unknown command');})()));
  if(command==='doctor')return out({bun:Bun.version,aoInstalled:existsSync('/Applications/Agent Orchestrator.app'),codex:!!Bun.which('codex'),opencode:!!Bun.which('opencode'),gh:!!Bun.which('gh'),linearTokenConfigured:!!process.env.ADLC_LINEAR_TOKEN||existsSync(tokenPath),executionEnabled:false});
  if(command==='init'){if(!a.includes('--preview'))return out(await initWizard(a[0]?.startsWith('--')?undefined:a[0],a));const repo=realpathSync(req(a[0],'Repository'));return out({repo,mode:'preview_only',existing:['AGENTS.md','.coderabbit.yaml','.github/workflows'].filter(x=>existsSync(join(repo,x))),controller:'Agent Orchestrator',interactive:'OpenChamber',executionEnabled:false});}
  if(command==='handoff')return out(handoffChecklist(req(a[0],'Worktree')));
  if(command==='readiness'){const c=JSON.parse(readFileSync(req(a[2],'Config'),'utf8')),required=requiredCheckNames(c.requiredChecks),metadata=metadataCheckNames(c.prMetadataChecks);return out(await readiness(req(a[0],'Repository'),Number(a[1]),[...new Set([...required,...metadata])],metadata));}
  if(command.startsWith('feature-')){
    const s=new Store(db),features=new FeaturePlanning(s,featureAgents);try{
      if(command==='feature-start'){
        const config=JSON.parse(readFileSync(req(a[0],'Config'),'utf8'));validate(config);
        const ti=a.indexOf('--title'),title=ti>=0?req(a[ti+1],'Title'):'Feature plan';
        const created=await features.create(config,readFileSync(req(a[1],'Requirements file'),'utf8'),title,a.includes('--no-source'));out(created);return out(await features.tick(created.id,config.featurePlanning?.maxAgents));
      }
      if(command==='feature-list')return out(features.list());
      const id=req(a[0],'Feature ID');
      if(command==='feature-show')return out(features.show(id));
      if(command==='feature-step')return out(await features.tick(id));
      if(command==='feature-edit')return out(features.setDraft(id,JSON.parse(readFileSync(req(a[1],'Draft file'),'utf8'))));
      if(command==='feature-approve')return out(features.approve(id,req(a[1],'Hash'),req(a[2],'Human'),a.includes('--acknowledge-questions')));
      if(command==='feature-publish')return out(await new FeaturePublish(s,features).publish(id));
      if(command==='feature-cancel')return out(await features.cancel(id));
      throw Error('Unknown feature command');
    }finally{s.close();}
  }
  if(command==='status'&&!existsSync(db))return out({jobs:[],intents:[],executionEnabled:false});
  if(!['approvals','review-status','recover-handoff','status','show-plan','approve-job','ingest','plan','capture-plan','adopt-pilot','observe-pilot','register-review','tick-review','extend-budget','approve-plan','prepare','poll','serve'].includes(command))throw Error('Unknown command');
  const c=['poll','serve'].includes(command)?JSON.parse(readFileSync(req(a[0],'Config'),'utf8')):null;if(c)validate(c);
  const s=new Store(db);const bridge=new Bridge(s);const lifecycle=new Lifecycle(s);const reviewLoop=new ReviewLoop(s);const workflow=new Workflow(s,liveTransport);const features=new FeaturePlanning(s,featureAgents);const linearLifecycle=new LinearLifecycle(s);const linearApprovals=new LinearApprovals(s,workflow);
  try{
    if(command==='approvals')return out((s.db.query("SELECT j.id,j.spec,j.plan_hash,d.reason FROM jobs j LEFT JOIN planning_dispatch d ON d.job=j.id WHERE j.state='awaiting_approval'").all() as any[]).map(j=>{let issue=null;try{issue=JSON.parse(j.spec).identifier;}catch{}return {job:j.id,issue,hash:j.plan_hash,requiresHumanPlanApproval:new ApprovalPolicyStore(s).requiresManual(j.id),reason:j.reason,linearNotice:s.db.query('SELECT comment_id,state,reason FROM plan_approval_notices WHERE job=? ORDER BY rowid DESC LIMIT 1').get(j.id)};}));
    if(command==='review-status')return out(reviewLoop.list().map(t=>({...t,remediation:lifecycle.budgetSummary(t.job)})));
    if(command==='status')return out({jobs:s.list().map(j=>({...j,remediation:lifecycle.budgetSummary(j.id)})),intents:bridge.intents(),runs:lifecycle.summary(),reviews:reviewLoop.list(),workflow:workflow.status(),features:features.list(),featureIntakeBlocks:s.db.query('SELECT * FROM feature_intake_blocks').all(),newWorkerDispatch:'per-project policy; plan-approval-required tickets wait for explicit human approval'});
    if(command==='recover-handoff'){
      const config=JSON.parse(readFileSync(req(a[1],'Config'),'utf8'));validate(config);
      await poll(config,s,linearToken());
      const stage=await workflow.recoverHandoff(req(a[0],'Job'),config);
      await disableNativeFeedback(stage.session);
      reviewLoop.register(stage.job,config.githubRepo,stage.pr.number,config.requiredChecks,JSON.parse(workflow.implementation(stage.job).paths),true);
      return out(stage);
    }
    if(command==='show-plan'){const j=s.get(req(a[0],'Job'));return out({job:j.id,state:j.state,hash:j.plan_hash,plan:j.plan,requiresHumanPlanApproval:new ApprovalPolicyStore(s).requiresManual(j.id),routing:new TaskRouting(s).list(j.id)});}
    if(command==='approve-job'){
      const option=(flag:string)=>{const i=a.indexOf(flag);if(i<0)throw Error(`${flag} required`);return req(a[i+1],flag);};
      if(option('--git')!=='feature-pr')throw Error('Only feature-pr Git scope is supported; merge/deploy are forbidden');
      return out(workflow.approve(req(a[0],'Job'),req(a[1],'Hash'),req(a[2],'Human'),option('--paths').split(','),option('--runtime'),['inspect','fetch','worktree','branch','commit','push-feature','open-pr']));
    }
    if(command==='register-review'){
      const job=req(a[0],'Job'),config=JSON.parse(readFileSync(req(a[3],'Config'),'utf8'));
      const run=lifecycle.run(job);if(!run)throw Error('Existing approved run required');
      await disableNativeFeedback(run.session_id);
      if(!Array.isArray(config.reviewAllowedPaths)||config.reviewAllowedPaths.length===0)throw Error('Explicit reviewAllowedPaths required');
      return out(reviewLoop.register(job,req(a[1],'Repository'),Number(a[2]),config.requiredChecks,config.reviewAllowedPaths,true));
    }
    if(command==='tick-review'&&a[1]){
      const config=JSON.parse(readFileSync(req(a[1],'Config'),'utf8'));validate(config);
      reviewLoop.configureMetadataChecks(config.linear.projectId,config.prMetadataChecks??[]);
      return out(await reviewLoop.tick(req(a[0],'Job'),config.branchUpdate,remediationPolicy(config.remediation)));
    }
    if(command==='tick-review'){const job=req(a[0],'Job');return out(await reviewLoop.tick(job,undefined,lifecycle.budgetPolicy(job)));}
    if(command==='extend-budget'){
      const config=JSON.parse(readFileSync(req(a[1],'Config'),'utf8'));validate(config);
      const flag=(name:string)=>{const i=a.indexOf(name);return i<0?undefined:req(a[i+1],name);};
      return out(lifecycle.extendRemediationBudget(req(a[0],'Job'),{
        actor:req(a[2],'Human operator'),additional:Number(req(a[3],'Additional budget')),head:req(a[4],'Current PR head'),
        policy:remediationPolicy(config.remediation),confirm:flag('--confirm'),reason:flag('--reason'),
      }));
    }
    if(command==='adopt-pilot')return out(await adoptPilot(s,req(a[0],'Job'),req(a[1],'Session')));
    if(command==='observe-pilot'){const config=JSON.parse(readFileSync(req(a[3],'Config'),'utf8'));validate(config);return out(await observePilot(s,req(a[0],'Job'),req(a[1],'Repository'),Number(a[2]),config.requiredChecks,config.prMetadataChecks??[]));}
    if(command==='capture-plan')return out(capturePlan(s,req(a[0],'Job'),await sessionEvidence(req(a[1],'Session')),Number(a[2])));
    if(command==='ingest')return out({id:s.enqueue(req(a[0],'Project'),req(a[1],'Issue'),readFileSync(req(a[2],'Specification file'),'utf8'))});
    if(command==='plan')return out({hash:s.propose(req(a[0],'Job'),readFileSync(req(a[1],'Plan file'),'utf8'))});
    if(command==='approve-plan'){s.approve(req(a[0],'Job'),req(a[1],'Hash'),req(a[2],'Human'));return out({approved:true,executionEnabled:false});}
    if(command==='prepare')return out(bridge.prepare(req(a[0],'Job'),req(a[1],'Orchestrator project')));
    const tick=async()=>{
      reviewLoop.configureMetadataChecks(c.linear.projectId,c.prMetadataChecks??[]);
      const remediation=remediationPolicy(c!.remediation);
      out(await poll(c,s,linearToken()));
      const stages=await workflow.tick(c);if(stages.length)out({workflow:stages});
      const planApprovals=await linearApprovals.sync(c);if(planApprovals.length)out({planApprovals});
      for(const stage of stages){
        if(stage.state==='pr_handoff'&&stage.pr){
          const url=new URL(stage.pr.url),match=url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
          if(url.hostname!=='github.com'||!match||match[1]!==c.githubRepo)throw Error('PR handoff is outside configured GitHub repository');
          const delivery=workflow.implementation(stage.job);
          reviewLoop.register(stage.job,c.githubRepo,Number(match[2]),c.requiredChecks,JSON.parse(delivery.paths),true);
        }
      }
      const linearUpdates=await linearLifecycle.sync(c);if(linearUpdates.length)out({linearStatuses:linearUpdates});
      const featureUpdates=await features.tickProject(c);if(featureUpdates.length)out({features:featureUpdates});
      for(const target of reviewLoop.list(c.linear.projectId) as any[]){
        if(target.state==='completed')continue;
        try{out({job:target.job,review:await reviewLoop.tick(target.job,c!.branchUpdate,remediation)});}catch(e){console.error(e instanceof Error?e.message:'Review tick failed');}
      }
    };if(command==='poll')return await tick();
    let stop=false;process.on('SIGTERM',()=>stop=true);process.on('SIGINT',()=>stop=true);
    while(!stop){try{await tick();}catch(e){console.error(e instanceof Error?e.message:'Poll failed');}for(let i=0;i<60&&!stop;i++)await Bun.sleep(1000);}
  }finally{s.close();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'ADLC failed');process.exitCode=1;});

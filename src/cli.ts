#!/usr/bin/env bun
import {installBridge} from './install';
import {maintenance} from './maintenance';
import {installRuntime} from './runtime-install';
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {Store} from './core';
import {ApprovalPolicyStore} from './approval-policy';
import {serviceControl,registeredProjects} from './service-control';
import {stackControl} from './stack-control';
import {initWizard} from './init';
import {poll,validate,requiredCheckNames,metadataCheckNames} from './linear';
import {setupPreview,writeSetupService,sanitizedSetup,validateRuntime,withVerificationContext} from './setup';
import {verificationInstructions,runVerification} from './verification';
import {serveLoop} from './project-settings';
import {Bridge,inspectAO,handoffChecklist} from './orchestrator';
import {readiness} from './github';
import {linearToken,tokenPath} from './credential';
import {Lifecycle} from './lifecycle';
import {Planning} from './planning';
import {runtimeCheck} from './runtime';
import {containerCheck} from './container-check';
import {sessionEvidence,capturePlan} from './session-evidence';
import {adoptPilot,observePilot} from './pilot';
import {ReviewLoop,reviewDisplay} from './review-loop';
import {disableNativeFeedback} from './ao-policy';
import {TaskRouting,loadOpenChamber,selectRoute} from './task-routing';
import {FeaturePlanning} from './feature-planning';
import {featureAgents} from './feature-transport';
import {FeaturePublish} from './feature-publish';
import {LinearLifecycle} from './linear-lifecycle';
import {LinearApprovals} from './linear-approvals';
import {Workflow} from './workflow';
import {LinearBlockers} from './linear-blockers';
import {LinearClarifications} from './linear-clarifications';
import {readinessFor,recordResolution,assertApprovalReadiness} from './readiness';
import {liveTransport,installWorkflowHook} from './workflow-transport';
import {remediationPolicy} from './remediation';
import {acknowledgePoll,runPollTick} from './poll-process';
import {withTurnSubmission} from './turn-submission';
import {DeliveryRecovery} from './delivery-recovery';
import {recoveryTransport} from './delivery-evidence';
import {ConflictRecovery} from './conflict-recovery';
import {recoveryRows} from './worktree-reservation';
import {RecoveryObservation} from './recovery-observation';
import {migrateController} from './controller-migration';
import {DependencyRecovery} from './dependency-recovery';
import {SpecRecovery} from './spec-recovery';
import {revisionStatus,latestRevision,assertCapturedRevision} from './spec-revisions';
import {groups,operatorHelp,OperatorError,resolveJob,jobViews,humanJobs} from './operator-cli';
import {modernCommand,dispatchOperator} from './operator-dispatch';
import {projectEntries,selectProject} from './operator-discovery';

let [command='help',...a]=process.argv.slice(2);
const requested=command,json=a.includes('--json'),modern=modernCommand(command,a),grouped=modern||!!groups[command]&&(a.length>0||command!=='projects')&&!(command==='projects'&&a.length===1&&a[0]==='--json')&&(command!=='routing'||['show','preview','--help','-h'].includes(a[0]));
let groupHelp='';
let project:string|undefined;
const out=(x:unknown)=>console.log(JSON.stringify(grouped&&json?{schemaVersion:1,command:requested,data:x}:x,null,2));
const req=(x:string|undefined,n:string)=>{if(!x)throw grouped?new OperatorError(`${n} required; use ${requested} --help`):Error(`${n} required`);return x;};
// Ordinary intake edits are not blocking; every active revision needs reconciliation.
const blockingRevision=(r:any)=>!!r&&r.state!=='preplanning';
export function authorizeBaseMerge(lifecycle:Pick<Lifecycle,'grantBaseMerge'>,args:string[]){
 if(args.length!==3||args.some(v=>!v.trim()||v.trim().startsWith('-')))throw Error('Use authorize-base-merge JOB HASH HUMAN with exactly three positional arguments');
 return lifecycle.grantBaseMerge(args[0],args[1],args[2]);
}
const db=process.env.ADLC_DB??join(homedir(),'Library','Application Support','ADLC Bridge','state.sqlite');
function projectConfiguration(path:string){
 const i=a.indexOf('--runtime'),runtime=i>=0?req(a[i+1],'Runtime config'):process.env.ADLC_VERIFICATION_RUNTIME_CONFIG;
 if(runtime?.startsWith('--'))throw Error('--runtime requires a runtime configuration path');
 return withVerificationContext(JSON.parse(readFileSync(path,'utf8')),path,runtime);
}
export async function runCLIReviewTick<T>(operation:()=>Promise<T>):Promise<T>{
 let interrupted:'SIGINT'|'SIGTERM'|undefined;
 const defer=(signal:'SIGINT'|'SIGTERM')=>{interrupted??=signal;console.error(`${signal}: waiting for the in-flight review tick to settle before releasing the submission fence`);};
 const onINT=()=>defer('SIGINT'),onTERM=()=>defer('SIGTERM');
 process.on('SIGINT',onINT);process.on('SIGTERM',onTERM);
 try{return await withTurnSubmission(operation);}
 finally{
  // Never cancel delivery, clear uncertainty, or unlock before the operation's
  // normal receipt/error handling and the submission fence's finally settle.
  process.off('SIGINT',onINT);process.off('SIGTERM',onTERM);
  if(interrupted)process.exitCode=interrupted==='SIGINT'?130:143;
 }
}
export function createCLIPollTick(context:{config:any;loadConfig?:()=>any;store:Store;reviewLoop:Pick<ReviewLoop,'configureMetadataChecks'|'register'|'list'|'tick'|'setVerification'>;workflow:Pick<Workflow,'tick'|'implementation'>;linearApprovals:Pick<LinearApprovals,'sync'>;linearLifecycle:Pick<LinearLifecycle,'sync'>;features:Pick<FeaturePlanning,'tickProject'>;blockers?:Pick<LinearBlockers,'sync'|'retract'>;clarifications?:Pick<LinearClarifications,'sync'>&Partial<Pick<LinearClarifications,'preflight'>>;io?:{poll:typeof poll;linearToken:typeof linearToken;out:typeof out}}){
 const {config:startup,loadConfig,store:s,reviewLoop,workflow,linearApprovals,linearLifecycle,features,blockers,clarifications,io={poll,linearToken,out}}=context;
 const identity=(c:any)=>JSON.stringify([realpathSync(c.repo),c.linear.projectId,c.linear.teamId,c.automation?.orchestratorProject,c.githubRepo]);
 const initialIdentity=loadConfig?identity(startup):undefined;
 return async()=>runPollTick(async()=>{
  const c=loadConfig?loadConfig():startup;
  if(loadConfig){validate(c);if(identity(c)!==initialIdentity)throw Error('Project identity changed during serve; explicit restart/reconciliation required');}
  reviewLoop.configureMetadataChecks(c.linear.projectId,c.prMetadataChecks??[]);
  const remediation=remediationPolicy(c.remediation);
  io.out(await io.poll(c,s,io.linearToken()));
  await clarifications?.preflight?.(c);
  const stages=await workflow.tick(c);if(stages.length)io.out({workflow:stages});
  if(c.dependencyRecovery?.enabled){const dependencies=new DependencyRecovery(s,workflow as Workflow);io.out({dependencies:await dependencies.sync(c)});if(blockers)io.out({dependencyNotices:await dependencies.notices(c,blockers as LinearBlockers)});}
  const clarificationUpdates=clarifications?await clarifications.sync(c):[];if(clarificationUpdates.length)io.out({clarifications:clarificationUpdates});
  const planApprovals=await linearApprovals.sync(c);if(planApprovals.length)io.out({planApprovals});
  for(const stage of stages){
   if(stage.state==='pr_handoff'&&stage.pr){
    const url=new URL(stage.pr.url),match=url.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
    if(url.hostname!=='github.com'||!match||match[1]!==c.githubRepo)throw Error('PR handoff is outside configured GitHub repository');
    const delivery=workflow.implementation(stage.job);
    reviewLoop.register(stage.job,c.githubRepo,Number(match[2]),c.requiredChecks,JSON.parse(delivery.paths),true,c.verification,c.verificationContext);
   }
  }
  const linearUpdates=await linearLifecycle.sync(c);if(linearUpdates.length)io.out({linearStatuses:linearUpdates});
  const blockerUpdates=blockers?await blockers.sync(c):[];if(blockerUpdates.length)io.out({linearBlockers:blockerUpdates});
  const featureUpdates=await features.tickProject(c);if(featureUpdates.length)io.out({features:featureUpdates});
  for(const target of reviewLoop.list(c.linear.projectId) as any[]){
   reviewLoop.setVerification(target.job,c.verification,c.verificationContext);
   if(target.state==='completed')continue;
   try{io.out({job:target.job,review:await reviewLoop.tick(target.job,c.branchUpdate,remediation,{project:c.linear.projectId,checks:c.prMetadataChecks??[]},c)});}catch(e){console.error(e instanceof Error?e.message:'Review tick failed');}
  }
 });
}
async function main(){
   if(command==='help'||a.includes('--help')||a.includes('-h')){groupHelp=operatorHelp(command==='help'?a[0]:groups[command]?command:undefined);command='help';}
   else if(modern)return dispatchOperator(command,a,db);
   else if(grouped){
    const verbs=groups[command],verb=a.shift();
    if(!verb||!verbs[verb])throw new OperatorError(`Unknown ${command} command. Use ${command} --help.`);
    command=verbs[verb];
    a=a.filter(x=>x!=='--json');
    const pi=a.indexOf('--project');if(pi>=0){if(requested!=='jobs')throw new OperatorError('--project is supported only for jobs in legacy aliases; use the documented positional service project');project=a[pi+1];if(!project||project.startsWith('-'))throw new OperatorError('--project requires a project ID');a.splice(pi,2);}
    if(project){const entries=projectEntries(db);if(entries.length)project=selectProject(entries,project).linear_project;}
    const minimum:Record<string,number>={'show-plan':1,'approve-job':3,recover:1,cleanup:1,'resume-job':2};
    if(minimum[command]&&a.filter(x=>!x.startsWith('-')).length<minimum[command])throw new OperatorError(`Missing arguments; use ${requested} --help`);
    if(command.startsWith('@')){
     if(a.some(x=>x.startsWith('-'))||a.length>1||command==='@list'&&a.length||command==='@lookup'&&!a.length)throw new OperatorError('Use jobs list | status [JOB/TICKET] | lookup JOB/TICKET [--project PROJECT] [--json]');
     const jobs=jobViews(db,project,a[0]);
     return json?out({jobs}):console.log(humanJobs(jobs));
    }
    if(requested==='jobs'&&a[0]&&!['approvals','dependency-status','review-status'].includes(verb))a[0]=resolveJob(db,a[0],project);
    if(requested==='jobs'&&command==='show-plan'){
     if(a.length!==1)throw new OperatorError('Use jobs show-plan JOB/TICKET [--project PROJECT]');
     const store=Store.readonly(db);try{const j=store.get(a[0]);return out({job:j.id,state:j.state,hash:j.plan_hash,plan:j.plan});}finally{store.close();}
    }
    if(requested==='jobs'&&['approvals','review-status'].includes(command)){
     if(a.length)throw new OperatorError('This inspection takes no positional arguments');
     if(!existsSync(db))return out([]);
     const store=Store.readonly(db);try{
      if(command==='approvals')return out(store.db.query("SELECT id AS job,project,plan_hash AS hash,reason FROM jobs WHERE state='awaiting_approval' AND (? IS NULL OR project=?)").all(project??null,project??null));
      return out(store.db.query("SELECT name FROM sqlite_master WHERE name='review_targets'").get()?store.db.query('SELECT t.* FROM review_targets t JOIN jobs j ON j.id=t.job WHERE (? IS NULL OR j.project=?)').all(project??null,project??null):[]);
     }finally{store.close();}
    }
   }
  if(command==='bind-controller'){
   const i=a.indexOf('--confirm');return out(await migrateController(req(a[0],'Project'),req(a[1],'Controller'),a.includes('--apply'),i>=0?req(a[i+1],'Confirmation hash'):undefined));
  }
  if(['recover','cleanup'].includes(command)){const s=new Store(db);try{return out(await maintenance(s,command as 'recover'|'cleanup',req(a[0],'Job'),a.includes('--apply'),a.includes('--confirm')?req(a[a.indexOf('--confirm')+1],'Confirmation hash'):undefined));}finally{s.close();}}
  if(command==='install'){
    const bin=a.includes('--bin')?req(a[a.indexOf('--bin')+1],'Launcher path'):undefined;
    if(bin?.startsWith('-'))throw Error('--bin requires a launcher path, not an option');
    if(bin!==undefined&&!isAbsolute(bin))throw Error('--bin requires an absolute launcher path');
    return out(await installBridge(a.includes('--apply'),undefined,bin));
  }
  if(command==='install-runtime')return out(await installRuntime(req(a.includes('--binary')?a[a.indexOf('--binary')+1]:undefined,'--binary PATH'),a.includes('--apply')));
  if(['start','stop','status'].includes(command)&&a.includes('--all')){if(a.length!==1)throw Error('Use --all without a project ID or other options');return out(await stackControl(command as 'start'|'stop'|'status'));}
  if(command==='setup'){
    const c=JSON.parse(readFileSync(req(a[0],'Project config'),'utf8')),r=JSON.parse(readFileSync(req(a[1],'Runtime config'),'utf8'));
    if(a.includes('--export'))return out(sanitizedSetup(c,r));
    if(a.includes('--write-service'))return out(writeSetupService(c,r,realpathSync(a[1]),realpathSync(a[0])));
    const preview=setupPreview(c,r,undefined,realpathSync(a[1]),realpathSync(a[0]));out(preview);if(!preview.passed)process.exitCode=1;return;
  }
  if(command==='verification'){
    const c=projectConfiguration(req(a[0],'Config'));validate(c);
    if(!a.includes('--run'))return console.log(verificationInstructions(c.verification,c.verificationContext));
    if(!c.verification)throw Error('Project verification is not configured');
    let docker;
    if(c.verification.mode==='container'){
      if(!c.verificationContext)throw Error('Container verification requires --runtime RUNTIME_JSON');
      const runtime=JSON.parse(readFileSync(c.verificationContext.runtimeConfig,'utf8'));validateRuntime(runtime);
      if(realpathSync(runtime.projectConfig)!==realpathSync(a[0]))throw Error('Runtime configuration belongs to a different project config');
      docker=runtime.tools.docker;
    }
    const result=await runVerification(req(a[1],'Explicit worktree'),c.verification,Bun.spawn,{docker,projectRepo:c.repo});out(result);if(!result.passed)process.exitCode=1;return;
  }
  if(['start','stop','service-status','service-config'].includes(command)){
    if(a.slice(1).some(x=>x!=='--apply')||(a.includes('--apply')&&command!=='service-config'))throw Error('Unsupported service option');
    return out(await serviceControl(command,a[0],a.includes('--apply')));
  }
  if(command==='projects')return out(await registeredProjects(true));
   if(command==='help')return console.log(groupHelp+`ADLC Bridge 0.6 — Agent Orchestrator + OpenChamber
  recover JOB                         inspect guarded recovery
    [--apply --confirm HASH]           apply only the exact inspected state
  cleanup JOB                         inspect completed cleanup (preview-only)
  install [--apply] [--bin PATH]        preview or install stable bridge snapshot
  install-runtime --binary PATH [--apply]
                                       register reproducibly built Orchestrator daemon
  start --all | stop --all | status --all
                                       full background stack; stop requires idle workers
  projects                             list registered project services
  bind-controller PROJECT CONTROLLER   preview verified missing-identity migration
    [--apply --confirm HASH]            bind only the currently inspected identity; no activation
  setup PROJECT_JSON RUNTIME_JSON       read-only prerequisite/service preview
    [--write-service]                   create staged definition only; no activation
    [--export]                          print sanitized, disabled setup template
  verification CONFIG [WORKTREE]        instructions; --run requires worktree
    --runtime RUNTIME_JSON              required for container execution; pins Docker
  poll/serve/tick-review/register-review also accept --runtime RUNTIME_JSON
                                       trusted reference supplied to verification workers
  start [PROJECT] | stop [PROJECT]      control one project; ID required if multiple
  service-status [PROJECT]             inspect one or all project services
  service-config PROJECT [--apply]     preview interval update; apply reloads loaded service
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
reconcile-preview CONFIG              read-only blocker/outcome preview for existing workers
spec-reconcile JOB CONFIG [--confirm HASH] preview/authorize same-owner planning only after a spec edit
  dependency-preview JOB CONFIG        read-only dependency/base/capability evidence
  dependency-resume JOB CONFIG HASH    confirm unchanged evidence using existing continuation
  dependency-status                    durable waits, failed evidence and next action
  resolve-plan JOB --source SOURCE --human NAME --answer TEXT
                                       record a human answer or satisfied dependency; no resume
  resume-job JOB CONFIG                 resume the existing needs-input worker after verified resolution
  adopt-pilot JOB SESSION               reconcile existing supervised worker only
  observe-pilot JOB OWNER/REPO PR CONFIG persist latest-SHA review evidence
   recover-handoff JOB CONFIG [--confirm HASH]  read-only preview; confirm exact proposal
  recovery-status                      read-only conflict stages, evidence and blockers
  recovery-preview JOB CONFIG          read-only conflict eligibility preview
  retry-observation JOB                rearm read-only provider checks; never replay mutation
  reconcile-publication JOB CONFIG SOURCE HUMAN [--confirm HASH]
                                       inspect/confirm proven published Git intent only
  reconcile-conflict JOB CONFIG        read-only published-merge reconciliation preview
    [--confirm HASH --human NAME]      verify and release only proven completed recovery
  authorize-base-merge JOB HASH HUMAN  explicitly add merge-base-feature to current job grant
  register-review JOB REPO PR CONFIG    register bounded review target
  rebind-review-target JOB REPO PR     reconcile a revised handoff recorded on another PR
  review-status                        show CI/review waits, blockers and remediation budget
  tick-review JOB CONFIG               same identity and branch policy as periodic review
  extend-budget JOB CONFIG HUMAN ADDITIONAL HEAD [--confirm HASH] [--reason TEXT]
                                       preview or apply an audited exhausted-budget extension
  approve-plan JOB HASH HUMAN           record current plan approval
  prepare JOB AO_PROJECT_ID             persist spawn preview; never executes
  poll CONFIG                          one intake, planning, execution and review tick
  serve CONFIG                         sequential ticks at configured interval (default 60s)
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
   if(command==='spec-reconcile'){
    if(a.length!==2&&!(a.length===4&&a[2]==='--confirm'&&/^[a-f0-9]{64}$/.test(a[3])))throw Error('Use spec-reconcile JOB CONFIG [--confirm HASH]');
    const config=projectConfiguration(a[1]);validate(config);
    if(!existsSync(db))throw Error('Existing database required');
    const store=new Store(db,a.length===2);
    try{return out(await new SpecRecovery(store,new Workflow(store,liveTransport,undefined,a.length===2)).reconcile(a[0],config,a[3]));}finally{store.close();}
   }
   if(['dependency-preview','dependency-resume','dependency-status'].includes(command)){
    if(!existsSync(db))throw Error('Existing database required');
    const applying=command==='dependency-resume';
    if(command==='dependency-status'&&a.length||command==='dependency-preview'&&a.length!==2||applying&&(a.length!==3||!/^[a-f0-9]{64}$/.test(a[2])))throw Error('Use dependency-status, dependency-preview JOB CONFIG, or dependency-resume JOB CONFIG HASH');
    const store=new Store(db,!applying);
    try{
     const workflow=new Workflow(store,liveTransport,undefined,!applying),dependencies=new DependencyRecovery(store,workflow);
     if(command==='dependency-status')return out(dependencies.status());
     const config=projectConfiguration(req(a[1],'Config'));validate(config);
     return out(applying?await dependencies.tick(a[0],config,a[2]):await dependencies.preview(a[0],config));
    }finally{store.close();}
   }
   if(!['approvals','review-status','recover-handoff','recovery-status','recovery-preview','retry-observation','reconcile-publication','reconcile-conflict','authorize-base-merge','status','show-plan','approve-job','ingest','plan','capture-plan','adopt-pilot','observe-pilot','register-review','rebind-review-target','tick-review','extend-budget','approve-plan','prepare','poll','serve','reconcile-preview','resolve-plan','resume-job'].includes(command))throw Error('Unknown command');
  const c=['poll','serve'].includes(command)?projectConfiguration(req(a[0],'Config')):['reconcile-preview','resume-job'].includes(command)?JSON.parse(readFileSync(req(a[command==='reconcile-preview'?0:1],'Config'),'utf8')):null;if(c)validate(c);
    if(command==='reconcile-publication'){
     if(a.length!==4&&!(a.length===6&&a[4]==='--confirm'))throw Error('Use reconcile-publication JOB CONFIG SOURCE HUMAN [--confirm HASH]');
     const config=JSON.parse(readFileSync(a[1],'utf8'));validate(config);
     const store=new Store(db,a.length===4);try{const recovery=new ConflictRecovery(store);return out(a.length===4?await recovery.publishedPreview(a[0],config,a[2] as any,a[3]):await recovery.publishedConfirm(a[0],config,a[2] as any,a[3],a[5]));}finally{store.close();}
    }
    if(command==='reconcile-conflict'){
     if(a.length!==2&&!(a.length===6&&a[2]==='--confirm'&&a[4]==='--human'))throw Error('Use reconcile-conflict JOB CONFIG [--confirm HASH --human NAME]');
     const config=JSON.parse(readFileSync(req(a[1],'Config'),'utf8'));validate(config);
     const store=new Store(db,a.length===2);
     try{const recovery=new ConflictRecovery(store),job=req(a[0],'Job');return out(a.length===2?await recovery.manualPreview(job,config):await recovery.manualConfirm(job,config,req(a[3],'Hash'),req(a[5],'Human')));}finally{store.close();}
    }
    if(command==='recovery-status'||command==='recovery-preview'){
     const store=new Store(db,true);
     try{
      if(command==='recovery-status')return out(recoveryRows(store));
      const config=JSON.parse(readFileSync(req(a[1],'Config'),'utf8'));validate(config);
      const job=req(a[0],'Job'),target=store.db.query('SELECT repo,pr FROM review_targets WHERE job=?').get(job) as any;
      if(!target)throw Error('Existing review target required');
      return out(await new ConflictRecovery(store).preview(job,config,target.repo,target.pr));
     }finally{store.close();}
    }
    if(command==='recover-handoff'){
    const config=JSON.parse(readFileSync(req(a[1],'Config'),'utf8'));validate(config);
    if(a.length!==2&&!(a.length===4&&a[2]==='--confirm'&&/^[a-f0-9]{64}$/.test(a[3])))throw Error('Use recover-handoff JOB CONFIG [--confirm HASH]');
    if(!existsSync(db))throw Error('Existing state database required');
    const store=new Store(db,a.length===2);
    try{const recovery=new DeliveryRecovery(store,recoveryTransport(store));return out(a.length===2?await recovery.preview(req(a[0],'Job'),config):await recovery.confirm(req(a[0],'Job'),config,a[3]));}finally{store.close();}
   }
   if(command==='reconcile-preview'){
    const config=JSON.parse(readFileSync(req(a[0],'Config'),'utf8'));validate(config);
    if(!existsSync(db))throw Error('Existing state database required');
    const store=new Store(db,true);
    try{return out(await new Workflow(store,liveTransport,undefined,true).previewReconcile(config));}finally{store.close();}
   }
   const s=new Store(db);const bridge=new Bridge(s);const lifecycle=new Lifecycle(s);const reviewLoop=new ReviewLoop(s);const workflow=new Workflow(s,liveTransport);const features=new FeaturePlanning(s,featureAgents);const linearLifecycle=new LinearLifecycle(s);const linearApprovals=new LinearApprovals(s,workflow);const blockers=new LinearBlockers(s);const clarifications=new LinearClarifications(s,workflow,blockers);
  const reviewStatus=()=>reviewLoop.list().map(t=>{
    const job=s.get(t.job),remediation=lifecycle.budgetSummary(t.job),blocked=job.state==='blocked'&&t.state!=='needs_reconciliation';
    const revision=revisionStatus(s,t.job),stale=revision?.blocking===true;
    return {...t,reviewState:t.state,...(blocked?{state:'blocked',displayStatus:reviewDisplay('blocked'),blockedReason:job.reason}:{}),...(stale?{state:'requirements_changed',displayStatus:'Requirements changed — fresh plan/approval required'}:{}),revision,jobState:job.state,remediation};
  });
   try{
    if(command==='retry-observation'){
     if(a.length!==1)throw Error('Use retry-observation JOB');lifecycle.current(a[0]);new RecoveryObservation(s).clear(a[0]);s.event(a[0],'operator_read_retry','Provider observations only; all mutation uncertainty retained');return out({job:a[0],readRetry:true,mutationReplay:false});
    }
    if(command==='authorize-base-merge'){
     return out(authorizeBaseMerge(lifecycle,a));
    }
    if(command==='approvals')return out((s.db.query("SELECT j.id,j.spec,j.plan_hash,d.reason FROM jobs j LEFT JOIN planning_dispatch d ON d.job=j.id WHERE j.state='awaiting_approval'").all() as any[]).map(j=>{let issue=null;try{issue=JSON.parse(j.spec).identifier;}catch{}return {job:j.id,issue,hash:j.plan_hash,requiresHumanPlanApproval:new ApprovalPolicyStore(s).requiresManual(j.id),reason:j.reason,linearNotice:s.db.query('SELECT comment_id,state,reason FROM plan_approval_notices WHERE job=? ORDER BY rowid DESC LIMIT 1').get(j.id)};}));
    if(command==='review-status')return out(reviewStatus());
    if(command==='status')return out({jobs:s.list().map(j=>({...j,remediation:lifecycle.budgetSummary(j.id)})),intents:bridge.intents(),runs:lifecycle.summary(),reviews:reviewStatus(),workflow:workflow.status(),clarifications:clarifications.status(),features:features.list(),featureIntakeBlocks:s.db.query('SELECT * FROM feature_intake_blocks').all(),newWorkerDispatch:'per-project policy; plan-approval-required tickets wait for explicit human approval'});
    if(command==='show-plan'){const j=s.get(req(a[0],'Job'));return out({job:j.id,state:j.state,hash:j.plan_hash,plan:j.plan,requiresHumanPlanApproval:new ApprovalPolicyStore(s).requiresManual(j.id),routing:new TaskRouting(s).list(j.id)});}
    if(command==='approve-job'){
      const option=(flag:string)=>{const i=a.indexOf(flag);if(i<0)throw grouped?new OperatorError(`${flag} required`):Error(`${flag} required`);return req(a[i+1],flag);};
      if(option('--git')!=='feature-pr')throw Error('Only feature-pr Git scope is supported; merge/deploy are forbidden');
      return out(workflow.approve(req(a[0],'Job'),req(a[1],'Hash'),req(a[2],'Human'),option('--paths').split(','),option('--runtime'),['inspect','fetch','worktree','branch','commit','push-feature','open-pr'],undefined,{readiness:a.includes('--acknowledge-readiness')}));
    }
    if(command==='resolve-plan'){
      const option=(flag:string)=>{const i=a.indexOf(flag);if(i<0)throw Error(`${flag} required`);return req(a[i+1],flag);};
      const job=req(a[0],'Job');recordResolution(s,job,option('--source'),option('--human'),option('--answer'));
      return out({job,state:'resolution_recorded',resumeAuthorized:false,readiness:readinessFor(s,job)});
    }
    if(command==='resume-job'){
      const job=req(a[0],'Job');
      if(s.get(job).project!==c!.linear.projectId)throw Error('Job project does not match configured project');
      const result=await runPollTick(async()=>{
       await poll(c!,s,linearToken());
       const stage=await workflow.resume(job,c!);
       let blockerLabel='retained';
       if(stage.state==='continuation_delivery_accepted'){
        try{blockerLabel=(await blockers.retract(job,c!)).state;}
        catch(e){blockerLabel=`retract_failed: ${e instanceof Error?e.message:'unknown error'}`;}
       }
       return {...stage,blockerLabel};
      });
      return out(result);
    }
    if(command==='register-review'){
      const job=req(a[0],'Job'),config=projectConfiguration(req(a[3],'Config'));
      const run=lifecycle.run(job);if(!run)throw Error('Existing approved run required');
      await disableNativeFeedback(run.session_id);
      if(!Array.isArray(config.reviewAllowedPaths)||config.reviewAllowedPaths.length===0)throw Error('Explicit reviewAllowedPaths required');
      return out(reviewLoop.register(job,req(a[1],'Repository'),Number(a[2]),config.requiredChecks,config.reviewAllowedPaths,true,config.verification,config.verificationContext));
    }
    if(command==='tick-review'){
       return out(await runCLIReviewTick(async()=>{
       const config=projectConfiguration(req(a[1],'Config'));validate(config);
       const job=req(a[0],'Job'),target=reviewLoop.get(job);
       if(s.get(job).project!==config.linear.projectId||target?.repo!==config.githubRepo)throw Error('Review target differs from configured project');
       new ApprovalPolicyStore(s).verify(job,config.linear.projectId,config.approval);
       reviewLoop.configureMetadataChecks(config.linear.projectId,config.prMetadataChecks??[]);
       reviewLoop.setVerification(job,config.verification,config.verificationContext);
        return reviewLoop.tick(job,config.branchUpdate,remediationPolicy(config.remediation),{project:config.linear.projectId,checks:config.prMetadataChecks??[]},config);
      }));
    }
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
    if(command==='capture-plan'){
      const job=req(a[0],'Job'),revision=latestRevision(s,job);
      if(blockingRevision(revision))throw Error('Active requirement revision requires spec-reconcile before manual plan capture');
      return out(capturePlan(s,job,await sessionEvidence(req(a[1],'Session')),Number(a[2]),revision?.id??null));
    }
    if(command==='ingest'){
      const project=req(a[0],'Project'),issue=req(a[1],'Issue'),specification=readFileSync(req(a[2],'Specification file'),'utf8');
      // Intake shares the submission fence: a reconcile reservation must make
      // ingestion fail closed rather than add work mid-reservation.
      return out({id:await withTurnSubmission(async()=>s.enqueue(project,issue,specification))});
    }
    if(command==='plan'){
      const job=req(a[0],'Job'),revision=latestRevision(s,job);
      if(blockingRevision(revision))throw Error('Active requirement revision requires spec-reconcile before manual plan submission');
      const plan=readFileSync(req(a[1],'Plan file'),'utf8');
      return out({hash:s.propose(job,plan,revision?.id??null)});
    }
    if(command==='approve-plan'){
      const job=req(a[0],'Job'),hash=req(a[1],'Hash'),j=s.get(job);
      if(hash!==j.plan_hash)throw Error('Stale plan or invalid state');
      assertCapturedRevision(s,job,hash,new Planning(s).get(job)?.session_id??null);
      if(latestRevision(s,job)?.state==='awaiting_approval'){
        throw Error('Revised plan requires approve-job to atomically rebind implementation authorization');
      }
      assertApprovalReadiness(s,job,req(a[2],'Human'),a.includes('--acknowledge-readiness'));
      s.approve(job,hash,req(a[2],'Human'));return out({approved:true,executionEnabled:false});
    }
    if(command==='rebind-review-target')return out(reviewLoop.rebind(req(a[0],'Job'),req(a[1],'Repository'),Number(req(a[2],'Pull request'))));
    if(command==='prepare')return out(bridge.prepare(req(a[0],'Job'),req(a[1],'Orchestrator project')));
    const tick=createCLIPollTick({config:c,loadConfig:command==='serve'?()=>projectConfiguration(req(a[0],'Config')):undefined,store:s,reviewLoop,workflow,linearApprovals,linearLifecycle,features,blockers,clarifications});
    const finished=await acknowledgePoll(req(a[0],'Config'),join(import.meta.dir,'cli.ts'));
    try{
    if(command==='poll')return await tick();
    let stop=false;process.on('SIGTERM',()=>stop=true);process.on('SIGINT',()=>stop=true);
    await serveLoop(tick,c,()=>stop,Bun.sleep,e=>console.error(e instanceof Error?e.message:'Poll failed'));
    }finally{try{finished();}catch{console.error('Poll completion receipt needs inspection; intake quiescence will remain unverified');}}
  }finally{s.close();}
}
if(import.meta.main)main().catch(e=>{const message=modern&&!(e instanceof OperatorError)?'Operation failed; inspect project configuration and supported service/auth diagnostics. Sensitive details withheld.':e instanceof Error?e.message:'ADLC failed',code=e instanceof OperatorError?e.code:1;console.error(grouped&&json?JSON.stringify({schemaVersion:1,command:requested,error:{code,message,candidates:e instanceof OperatorError?e.candidates:[]}}):`${message}${e instanceof OperatorError&&e.candidates.length?'\n'+JSON.stringify(e.candidates,null,2):''}`);process.exitCode=process.exitCode||code;});

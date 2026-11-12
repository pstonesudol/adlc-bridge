import {groups,OperatorError,jobViews,humanJobs} from './operator-cli';
import {projectEntries,selectProject,projectConfig,authStatus,queueView,versionView,completion} from './operator-discovery';
import {configView,configDefaults,editConfig,configPolling} from './operator-config';
import {reviewerPolicyView} from './reviewer-policy';
import {serviceControl} from './service-control';
import {validate} from './linear';
import {autonomyMetrics,humanMetrics} from './autonomy-metrics';
import {explainJob,explainText,watchJob,scopedEvents,diagnosticExport} from './operator-jobs';
import {Store,digest} from './core';
import {hasTable,safeOutput,blockerText} from './operator-evidence';
import {Lifecycle} from './lifecycle';
import {assertRecoveryAvailable} from './recovery-runtime';
import {turnBarrier,assertProjectIntakeEnabled} from './turn-submission';
import {resolveJob} from './operator-cli';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Workflow} from './workflow';
import type {WorkflowTransport} from './workflow';
import {assertConfiguredProjectIntakeEnabled} from './project-services';
import {Database} from 'bun:sqlite';
import {remediationPolicy} from './remediation';

export function modernCommand(command:string,args:string[]){
 return ['config','queue','auth','version','completion'].includes(command)||command==='diagnostics'&&args[0]==='export'||command==='projects'&&args[0]==='show'||['status','doctor'].includes(command)&&args.includes('--project')||command==='jobs'&&['metrics','show','list','status','lookup','explain','watch','logs','reconcile','budget','extend-budget','resume','recover-delivery'].includes(args[0]);
}
export async function dispatchOperator(command:string,args:string[],db:string){
 const json=args.includes('--json');const options:Record<string,string|boolean>={},position:string[]=[];
 for(let i=0;i<args.length;i++){
  const arg=args[i];if(!arg.startsWith('-')){position.push(arg);continue;}
   if(!['--project','--state','--json','--apply','--since','--until','--confirm','--human','--additional','--head','--reason','--follow'].includes(arg)||Object.hasOwn(options,arg))throw new OperatorError('Unknown or repeated option. Use --help.');
   if(['--project','--state','--since','--until','--confirm','--human','--additional','--head','--reason'].includes(arg)){if(!args[i+1]||args[i+1].startsWith('-'))throw new OperatorError(`${arg} requires a value`);options[arg]=args[++i];}else options[arg]=true;
 }
 const requireCount=(n:number)=>{if(position.length!==n)throw new OperatorError('Unexpected or missing arguments. Use --help.');};
 const jobMutation=command==='jobs'&&['reconcile','resume','recover-delivery','extend-budget'].includes(position[0]);
 if(options['--apply']&&!(command==='config'&&['set','reset'].includes(position[0]))&&!jobMutation&&!(command==='diagnostics'&&position[0]==='export'))throw new OperatorError('--apply is not supported by this command');
 if(options['--confirm']&&!jobMutation)throw new OperatorError('--confirm is supported only by guarded job mutations');
 if(options['--follow']&&!(command==='jobs'&&position[0]==='logs'))throw new OperatorError('--follow is supported only by jobs logs');
 if(['--human','--additional','--head','--reason'].some(k=>options[k])&&!(command==='jobs'&&position[0]==='extend-budget'))throw new OperatorError('Budget options require jobs extend-budget');
  if(options['--state']&&!(command==='jobs'&&position[0]==='list'))throw new OperatorError('--state is supported only by jobs list');
  if((options['--since']||options['--until'])&&!(command==='jobs'&&position[0]==='metrics'))throw new OperatorError('--since/--until are supported only by jobs metrics');
 const emit=(data:unknown,human?:string)=>console.log(json?JSON.stringify({schemaVersion:1,command,data:safeOutput(data)},null,2):human??JSON.stringify(safeOutput(data),null,2));
 if(command==='version'){requireCount(0);if(options['--project'])throw new OperatorError('version does not accept --project');emit(versionView());return;}
 if(command==='completion'){requireCount(1);if(Object.keys(options).length)throw new OperatorError('completion accepts only SHELL');console.log(completion(position[0],Object.keys(groups).concat('status','doctor','version','completion')));return;}
  const entries=projectEntries(db),requested=options['--project'] as string|undefined;
  if(command==='jobs'&&position[0]==='metrics'){
   requireCount(1);
   const project=requested&&entries.length?selectProject(entries,requested).linear_project:requested;
   const report=autonomyMetrics(db,{project,since:options['--since'] as string|undefined,until:options['--until'] as string|undefined});
   emit(report,humanMetrics(report));return;
  }
 if(command==='projects'&&requested)throw new OperatorError('Use projects show PROJECT, without --project');
 if(command==='jobs'){
  const operation=position[0],project=requested&&entries.length?selectProject(entries,requested).linear_project:requested;
  if(['explain','watch','logs','reconcile','budget','resume','recover-delivery','extend-budget'].includes(operation)){
   if(!position[1]||position.length>3||position.length===3&&!['resume','recover-delivery','extend-budget'].includes(operation))throw new OperatorError('Use jobs COMMAND TICKET [CONFIG] --project PROJECT [--json]');
   const job=resolveJob(db,position[1],project),view=jobViews(db,project,job)[0];
   const read=()=>explainJob(db,project,job);
   if(operation==='explain'){const v=await read();emit({jobs:[v]},explainText(v));return;}
   if(operation==='watch'||operation==='logs'&&options['--follow']){
    const abort=new AbortController(),cancel=()=>abort.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
    let cursor=0;
    const logRead=async()=>{const log=scopedEvents(db,project,job,cursor);cursor=log.cursor;return {...await read(),log};};
    try{await watchJob(operation==='logs'?logRead:read,v=>emit(v,operation==='logs'?JSON.stringify(v.log):explainText(v)),abort.signal);}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}return;
   }
   if(operation==='logs'){emit(scopedEvents(db,project,job));return;}
   if(operation==='budget'){const s=Store.readonly(db);try{if(!['remediation_budget','runs','remediation'].every(t=>hasTable(s,t)))throw new OperatorError('Budget engine evidence unavailable; existing lifecycle budget initialization is a prerequisite',1);emit({job,project:view.project,budget:new Lifecycle(s).budgetSummary(job),readOnly:true});}finally{s.close();}return;}
   if(operation==='reconcile'){
    let dependency:any=null,dependencyConfig:any=null;
    const entry=entries.length?selectProject(entries,requested):null;
    if(entry){dependencyConfig=projectConfig(entry);if(dependencyConfig.dependencyRecovery?.enabled){const s=Store.readonly(db);try{
     const r=hasTable(s,'plan_readiness')?s.db.query('SELECT state FROM plan_readiness WHERE job=?').get(job) as any:null;
     if(r?.state==='blocked-by-dependency')dependency=await new Workflow(s,{} as WorkflowTransport,undefined,true).planningDependencies.preview(job,dependencyConfig);
    }finally{s.close();}}}
    const proposal={job,project:view.project,effect:dependency?'Reevaluate existing planning dependencies only; no implementation dispatch or approval':'Refresh authoritative worker evidence only; no continuation, approval, budget or delivery mutation',binding:view.version,dependency:dependency?.id??null},confirmation=digest(JSON.stringify(proposal));
    if(!options['--apply']){emit({preview:true,...proposal,confirmation,capabilities:{continuation:'Use separately guarded resume/recover-delivery; not authorized by evidence refresh',planningDependencies:dependency?'Existing DEV-55 planning engine available':'No applicable registered planning dependency binding; no dependency mutation offered'}});return;}
    if(options['--confirm']!==confirmation)throw new OperatorError('Reconcile confirmation missing or changed; preview jobs reconcile again',1);
    assertRecoveryAvailable();assertProjectIntakeEnabled(view.project);
    await turnBarrier().submit(async()=>{assertRecoveryAvailable();if(jobViews(db,project,job)[0].version!==view.version)throw new OperatorError('Job evidence changed; preview again',1);
     let reevaluation=null;if(dependency){const s=new Store(db);try{assertConfiguredProjectIntakeEnabled(dependencyConfig,s);reevaluation=await new Workflow(s,{} as WorkflowTransport,undefined,true).planningDependencies.tick(job,dependencyConfig,dependency.id);}finally{s.close();}}
     const v=await read();emit({...proposal,preview:false,refreshed:true,jobs:[v],reevaluation,continued:false});});return;
   }
   const entry=entries.length?selectProject(entries,requested):undefined,configPath=position[2]??entry?.config;
   if(!configPath)throw new OperatorError('A registered project or explicit CONFIG is required');
   const config=JSON.parse(readFileSync(configPath,'utf8'));validate(config);if(config.linear.projectId!==view.project)throw new OperatorError('Job/config project mismatch',1);
   const invoke=async(argv:string[])=>{const p=Bun.spawn([process.execPath,join(import.meta.dir,'cli.ts'),...argv],{stdout:'pipe',stderr:'pipe',env:{...process.env,ADLC_DB:db},timeout:120000});const [text,_error,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code!==0)throw new OperatorError('Guarded engine refused or evidence unavailable; inspect jobs explain and the corresponding legacy engine preview. No replacement worker is authorized.',1);return JSON.parse(text);};
   if(operation==='resume'){
    const inspection=Store.readonly(db);try{assertConfiguredProjectIntakeEnabled(config,inspection);}catch(error){const message=error instanceof Error?error.message:'';throw new OperatorError(message.startsWith('Registered project identity')?'Registered project identity missing or changed; reconcile the configuration before intake':'Project intake is intentionally paused; use services start PROJECT after inspection',1);}finally{inspection.close();}
    const proposal={job,project:view.project,effect:'Resume eligible existing session through lifecycle engine',binding:view.version,configuration:digest(JSON.stringify(config))},confirmation=digest(JSON.stringify(proposal));
    if(!options['--apply']){emit({preview:true,...proposal,confirmation,blockers:view.blockers});return;}
    if(options['--confirm']!==confirmation)throw new OperatorError('Resume confirmation missing or stale; preview jobs resume again',1);
    assertRecoveryAvailable();assertProjectIntakeEnabled(view.project);emit(await invoke(['resume-job',job,configPath]));return;
   }
   if(operation==='recover-delivery'){
    if(options['--confirm']&&!options['--apply'])throw new OperatorError('Use --apply with --confirm');
    if(options['--apply']&&!options['--confirm'])throw new OperatorError('Preview jobs recover-delivery first; --apply requires --confirm HASH');
    if(options['--apply']){assertRecoveryAvailable();assertProjectIntakeEnabled(view.project);}
    const operation=()=>invoke(['recover-handoff',job,configPath,...(options['--apply']?['--confirm',String(options['--confirm'])]:[])]);
    emit(options['--apply']?await turnBarrier().submit(async()=>{assertRecoveryAvailable();const s=Store.readonly(db);try{assertConfiguredProjectIntakeEnabled(config,s);}finally{s.close();}return operation();}):await operation());return;
   }
   for(const flag of ['--human','--additional','--head'])if(!options[flag])throw new OperatorError(`${flag} required for budget extension preview and apply`);
   if(!/^[1-9][0-9]*$/.test(String(options['--additional']))||!Number.isSafeInteger(Number(options['--additional'])))throw new OperatorError('--additional must be a positive safe integer');
   if(options['--confirm']&&!options['--apply']||options['--apply']&&!options['--confirm'])throw new OperatorError('Preview first; apply requires --apply --confirm HASH');
   if(options['--apply'])assertRecoveryAvailable();
   const source=Store.readonly(db),s=new Store(':memory:');
   try{
    // Execute the real engine preview on an isolated database snapshot. Legacy
    // budget migrations/initialization cannot alter the live preview source.
    const snapshot=source.db.serialize();
    // sqlite3_serialize includes WAL journal header bytes. A detached memory
    // image has no sidecar; use rollback-journal format on this copy only.
    snapshot[18]=1;snapshot[19]=1;
    s.db.close();s.db=Database.deserialize(snapshot,{readonly:false});
    const preview=new Lifecycle(s).extendRemediationBudget(job,{actor:String(options['--human']),additional:Number(options['--additional']),head:String(options['--head']),policy:remediationPolicy(config.remediation),reason:options['--reason'] as string|undefined});
    if(!options['--apply']){emit({job,project:view.project,...preview});return;}
    if(options['--confirm']!==('confirmHash' in preview?preview.confirmHash:null))throw new OperatorError('Budget confirmation changed; preview again',1);
   }finally{source.close();s.close();}
   emit(await turnBarrier().submit(async()=>{assertRecoveryAvailable();const s=Store.readonly(db);try{assertConfiguredProjectIntakeEnabled(config,s);}finally{s.close();}return invoke(['extend-budget',job,configPath,String(options['--human']),String(options['--additional']),String(options['--head']),'--confirm',String(options['--confirm']),...(options['--reason']?['--reason',String(options['--reason'])]:[])]);}));return;
  }
  const verb=position.shift()!;if(position.length>1||['show','lookup'].includes(verb)&&position.length!==1||verb==='list'&&position.length)throw new OperatorError('Use jobs list [--state STATE] or jobs show/status/lookup [JOB/TICKET]');
  let jobs=jobViews(db,project,position[0]);
  if(options['--state']){const state=options['--state'];if(!['awaiting_plan','working','approval_wait','dependency_wait','blocked','complete','observation_wait','requirements_changed','uncertain_delivery','budget_exhausted','queued','tracked_activity_unknown'].includes(String(state)))throw new OperatorError('Unknown display state');jobs=jobs.filter(j=>j.state===state||j.phase===state);}
  emit({jobs},humanJobs(jobs)+'\n'+jobs.map(blockerText).join('\n'));return;
 }
 if(command==='config'&&!requested)throw new OperatorError('config requires --project PROJECT, including preview');
 if(command==='diagnostics'){
  requireCount(1);if(position[0]!=='export'||!requested)throw new OperatorError('Use diagnostics export --project PROJECT [--apply] [--json]');
  const entry=selectProject(entries,requested);emit(diagnosticExport(db,entry.linear_project,!!options['--apply'],undefined,String(versionView().source.version)));return;
 }
 const entry=selectProject(entries,command==='projects'?position[1]:requested),c=projectConfig(entry);
 if(command==='projects'){requireCount(2);emit({project:entry.project,name:entry.name,linearProject:entry.linear_project});return;}
 if(command==='status'){requireCount(0);const jobs=jobViews(db,entry.linear_project);emit({project:entry.project,jobs},humanJobs(jobs));return;}
 if(command==='doctor'){requireCount(0);emit({project:entry.project,auth:authStatus(c),reviewers:reviewerPolicyView(c.reviewers),nextAction:'Reviewers require fresh provider identity/membership evidence. Unsupported adapters/options fail config validate. No repair or dispatch was performed.',readOnly:true});return;}
 if(command==='auth'){requireCount(1);if(position[0]!=='status')throw new OperatorError('Use auth status');emit({project:entry.project,...authStatus(c)});return;}
 if(command==='queue'){requireCount(1);if(position[0]!=='list')throw new OperatorError('Use queue list');const result=await queueView(c,db);emit(result);if(!result.provider.complete)process.exitCode=1;return;}
 const verb=position[0],key=position[1];
 if(!['show','get','set','validate','diff','reset'].includes(verb))throw new OperatorError('Unknown config command');
 requireCount(verb==='set'?3:['get','reset'].includes(verb)?2:1);
 if(['set','reset','get'].includes(verb)&&!Object.hasOwn(configDefaults,key))throw new OperatorError('Key must be one of: '+Object.keys(configDefaults).join(', '));
 if(verb==='validate'){try{validate(c);}catch(error){if(error instanceof Error&&error.message.startsWith('reviewers '))throw new OperatorError(error.message,1);throw new OperatorError('Project configuration invalid. Check project identity, required checks, polling (5–86400), planning capacity (1–32), and remediation schema.',1);}emit({valid:true,reviewers:reviewerPolicyView(c.reviewers)});return;}
 if(['show','get','diff'].includes(verb)){
  const values=configView(c).filter(v=>verb!=='get'||v.key===key);
  const service=verb==='get'?undefined:await configPolling(entry.project,false,(action,project,apply)=>serviceControl(action,project,apply,{requireEnabled:true,statePath:db}));
  emit({values,service,note:'Only allowlisted non-secret settings are displayed. diff compares declared/default/effective values and saved/installed interval; active interval may be unknown.'});return;
 }
 const result=editConfig(entry.config,key,verb==='reset'?undefined:position[2],!!options['--apply']);
 const service=key==='pollingIntervalSeconds'?await configPolling(entry.project,!!options['--apply'],(action,project,apply)=>serviceControl(action,project,apply,{requireEnabled:true,statePath:db,...(!options['--apply']&&action==='service-config'?{previewPollingSeconds:Number(result.changes.after!.effective)}:{})})):undefined;
 emit({...result,service});if(service?.state==='partial-or-unavailable'&&options['--apply'])process.exitCode=1;
}

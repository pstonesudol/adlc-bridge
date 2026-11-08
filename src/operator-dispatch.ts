import {groups,OperatorError,jobViews,humanJobs} from './operator-cli';
import {projectEntries,selectProject,projectConfig,authStatus,queueView,versionView,completion} from './operator-discovery';
import {configView,configDefaults,editConfig,configPolling} from './operator-config';
import {serviceControl} from './service-control';
import {validate} from './linear';
import {autonomyMetrics,humanMetrics} from './autonomy-metrics';

export function modernCommand(command:string,args:string[]){
 return ['config','queue','auth','version','completion'].includes(command)||command==='projects'&&args[0]==='show'||['status','doctor'].includes(command)&&args.includes('--project')||command==='jobs'&&['metrics','show','list','status','lookup'].includes(args[0]);
}
export async function dispatchOperator(command:string,args:string[],db:string){
 const json=args.includes('--json');const options:Record<string,string|boolean>={},position:string[]=[];
 for(let i=0;i<args.length;i++){
  const arg=args[i];if(!arg.startsWith('-')){position.push(arg);continue;}
   if(!['--project','--state','--json','--apply','--since','--until'].includes(arg)||Object.hasOwn(options,arg))throw new OperatorError('Unknown or repeated option. Use --help.');
   if(['--project','--state','--since','--until'].includes(arg)){if(!args[i+1]||args[i+1].startsWith('-'))throw new OperatorError(`${arg} requires a value`);options[arg]=args[++i];}else options[arg]=true;
 }
 const requireCount=(n:number)=>{if(position.length!==n)throw new OperatorError('Unexpected or missing arguments. Use --help.');};
 if(options['--apply']&&!(command==='config'&&['set','reset'].includes(position[0])))throw new OperatorError('--apply is supported only by config set/reset');
  if(options['--state']&&!(command==='jobs'&&position[0]==='list'))throw new OperatorError('--state is supported only by jobs list');
  if((options['--since']||options['--until'])&&!(command==='jobs'&&position[0]==='metrics'))throw new OperatorError('--since/--until are supported only by jobs metrics');
 const emit=(data:unknown,human?:string)=>console.log(json?JSON.stringify({schemaVersion:1,command,data},null,2):human??JSON.stringify(data,null,2));
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
  const verb=position.shift()!;if(position.length>1||['show','lookup'].includes(verb)&&position.length!==1||verb==='list'&&position.length)throw new OperatorError('Use jobs list [--state STATE] or jobs show/status/lookup [JOB/TICKET]');
  const project=requested&&entries.length?selectProject(entries,requested).linear_project:requested;
  let jobs=jobViews(db,project,position[0]);
  if(options['--state']){const state=options['--state'];if(!['awaiting_plan','working','approval_wait','dependency_wait','blocked','complete'].includes(String(state)))throw new OperatorError('Unknown display state');jobs=jobs.filter(j=>j.state===state);}
  emit({jobs},humanJobs(jobs));return;
 }
 if(command==='config'&&!requested)throw new OperatorError('config requires --project PROJECT, including preview');
 const entry=selectProject(entries,command==='projects'?position[1]:requested),c=projectConfig(entry);
 if(command==='projects'){requireCount(2);emit({project:entry.project,name:entry.name,linearProject:entry.linear_project});return;}
 if(command==='status'){requireCount(0);const jobs=jobViews(db,entry.linear_project);emit({project:entry.project,jobs},humanJobs(jobs));return;}
 if(command==='doctor'){requireCount(0);emit({project:entry.project,auth:authStatus(c),nextAction:'Use config validate and services status with this project; no repair or dispatch was performed.',readOnly:true});return;}
 if(command==='auth'){requireCount(1);if(position[0]!=='status')throw new OperatorError('Use auth status');emit({project:entry.project,...authStatus(c)});return;}
 if(command==='queue'){requireCount(1);if(position[0]!=='list')throw new OperatorError('Use queue list');const result=await queueView(c,db);emit(result);if(!result.provider.complete)process.exitCode=1;return;}
 const verb=position[0],key=position[1];
 if(!['show','get','set','validate','diff','reset'].includes(verb))throw new OperatorError('Unknown config command');
 requireCount(verb==='set'?3:['get','reset'].includes(verb)?2:1);
 if(['set','reset','get'].includes(verb)&&!Object.hasOwn(configDefaults,key))throw new OperatorError('Key must be one of: '+Object.keys(configDefaults).join(', '));
 if(verb==='validate'){try{validate(c);}catch{throw new OperatorError('Project configuration invalid. Check project identity, required checks, polling (5–86400), planning capacity (1–32), and remediation schema.',1);}emit({valid:true});return;}
 if(['show','get','diff'].includes(verb)){
  const values=configView(c).filter(v=>verb!=='get'||v.key===key);
  const service=verb==='get'?undefined:await configPolling(entry.project,false,(action,project,apply)=>serviceControl(action,project,apply,{requireEnabled:true,statePath:db}));
  emit({values,service,note:'Only allowlisted non-secret settings are displayed. diff compares declared/default/effective values and saved/installed interval; active interval may be unknown.'});return;
 }
 const result=editConfig(entry.config,key,verb==='reset'?undefined:position[2],!!options['--apply']);
 const service=key==='pollingIntervalSeconds'?await configPolling(entry.project,!!options['--apply'],(action,project,apply)=>serviceControl(action,project,apply,{requireEnabled:true,statePath:db,...(!options['--apply']&&action==='service-config'?{previewPollingSeconds:Number(result.changes.after!.effective)}:{})})):undefined;
 emit({...result,service});if(service?.state==='partial-or-unavailable'&&options['--apply'])process.exitCode=1;
}

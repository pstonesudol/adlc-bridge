import {OperatorError} from './operator-cli';
import {managedLifecycle,type LifecycleAction,type LifecycleOptions} from './managed-lifecycle';

export function parseLifecycle(action:LifecycleAction,args:string[]):LifecycleOptions{
 const options:LifecycleOptions={timeout:30};const seen=new Set<string>();let positional:string|undefined;
 for(let i=0;i<args.length;i++){
  const arg=args[i];if(!arg.startsWith('-')){if(positional)throw new OperatorError('Only one project is supported; use --all explicitly');positional=arg;continue;}
  if(!['--all','--project','--pause','--drain','--workers','--timeout','--disable-login','--temporary','--preview','--apply','--confirm','--json'].includes(arg)||seen.has(arg))throw new OperatorError('Unknown or repeated lifecycle option. Use services --help');
  seen.add(arg);
  if(['--project','--timeout','--confirm'].includes(arg)){
   const value=args[++i];if(!value||value.startsWith('-'))throw new OperatorError(`${arg} requires a value`);
   if(arg==='--project')options.project=value;
   if(arg==='--confirm'){if(!/^[a-f0-9]{64}$/.test(value))throw new OperatorError('--confirm requires the preview hash');options.confirm=value;}
   if(arg==='--timeout'){const n=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(n)||n<1||n>3600)throw new OperatorError('--timeout must be an integer from 1 to 3600 seconds');options.timeout=n;}
  }else if(arg==='--all')options.all=true;
  else if(['--pause','--drain','--workers'].includes(arg)){if(options.mode)throw new OperatorError('Select only one of --pause, --drain, --workers');options.mode=arg.slice(2) as LifecycleOptions['mode'];}
  else if(arg==='--disable-login'||arg==='--temporary'){if(options.persistent!==undefined)throw new OperatorError('Select --disable-login or --temporary, not both');options.persistent=arg==='--disable-login';}
  else if(arg==='--preview')options.preview=true;
  else if(arg==='--apply')options.apply=true;
 }
 if(positional&&options.project)throw new OperatorError('Use PROJECT or --project PROJECT, not both');
 options.project??=positional;
 if(options.all&&options.project)throw new OperatorError('--all cannot be combined with a project');
 if(options.preview&&options.apply||options.confirm&&!options.apply)throw new OperatorError('Use --preview, or --apply --confirm HASH');
 if(action==='status'&&(options.mode||options.apply||options.confirm||options.preview||options.persistent!==undefined))throw new OperatorError('Status is read-only; mutation flags are not supported');
 if(action==='start'&&(options.mode||options.confirm||options.apply||options.persistent!==undefined))throw new OperatorError('Start accepts scope, --preview, --timeout and --json only');
 if(action==='restart'&&options.mode==='pause')throw new OperatorError('Restart cannot use --pause; use stop --pause or restart --drain');
 return options;
}
export async function lifecycleCLI(action:LifecycleAction,args:string[],db:string,run=managedLifecycle){return run(action,parseLifecycle(action,args),db);}

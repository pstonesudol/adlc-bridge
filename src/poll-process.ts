import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {appState} from './install-state';import {atomicFile} from './atomic-file';import {withTurnSubmission,TurnSubmissionBlocked} from './turn-submission';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const receiptPath=(state:string,config:string)=>join(state,'poll-processes',hash(config)+'.json');
export function processStarted(pid:number){
 if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid intake PID');
 const r=Bun.spawnSync(['/bin/ps','-p',String(pid),'-o','lstart='],{env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}),text=r.stdout.toString().trim();
 if(r.exitCode!==0||!text)throw Error('Cannot verify intake process start time');return text;
}
function readReceipt(path:string){
 if(!existsSync(path))throw Error('Intake barrier support is unverified; preserve this service. An operator must stop and unload legacy intake while quiescent before migration');
 const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('Intake process receipt must be owner-only');
 return JSON.parse(readFileSync(path,'utf8'));
}
export async function acknowledgePoll(config:string,cli:string,state=appState(),started=processStarted,submit=withTurnSubmission,wait={timeoutMs:Number.POSITIVE_INFINITY,pause:()=>Bun.sleep(100)}){
  config=realpathSync(config);cli=realpathSync(cli);const path=receiptPath(state,config),record={version:1,config,cli,cliHash:hash(readFileSync(cli)),pid:process.pid,started:started(process.pid),idle:false};
  // Publish barrier awareness before waiting: stack startup holds the fence
  // while verifying this PID-bound receipt. No polling or submission is allowed
  // until submit succeeds after the stack resumes and releases its fence.
  atomicFile(path,JSON.stringify(record));
  const finished=()=>{const current=readReceipt(path);if(current.pid===record.pid&&current.started===record.started)atomicFile(path,JSON.stringify({...record,idle:true}));};
  const deadline=Date.now()+wait.timeoutMs;
  try{for(;;){try{await submit(async()=>{});break;}catch(error){if(!(error instanceof TurnSubmissionBlocked)||Date.now()>=deadline)throw error;await wait.pause();}}}
  catch(error){try{finished();}catch(cleanup){throw new AggregateError([error,cleanup],'Poll startup failed and completion receipt could not be recorded');}throw error;}
  return finished;
}
function verifiedReceipt(config:string,cli:string,state:string){
  config=realpathSync(config);cli=realpathSync(cli);const r=readReceipt(receiptPath(state,config));
  if(r.version!==1||r.config!==config||r.cli!==cli||r.cliHash!==hash(readFileSync(cli)))throw Error('Intake barrier acknowledgement does not match this service; preserve it for operator inspection');
  return r;
}
export function assertPollStarted(status:{pid?:number;running?:boolean},config:string,cli:string,state=appState(),started=processStarted){
 const r=verifiedReceipt(config,cli,state);
 if(!status.running||status.pid===undefined||r.idle!==false||r.pid!==status.pid||r.started!==started(status.pid))throw Error('Poll startup is not acknowledged by the running intake process');
}
export function assertPollQuiescent(status:{pid?:number;running?:boolean},config:string,cli:string,state=appState(),started=processStarted){
 const r=verifiedReceipt(config,cli,state);
 if(status.pid!==undefined){if(r.pid!==status.pid||r.started!==started(status.pid))throw Error('Running intake process has not acknowledged the barrier; preserved');}
 else if(status.running||r.idle!==true)throw Error('Intake quiescence is unverified; preserve this service until an operator establishes an idle stop');
}

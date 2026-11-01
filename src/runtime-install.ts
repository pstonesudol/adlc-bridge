import {readFileSync,existsSync,mkdirSync,copyFileSync,realpathSync} from 'node:fs';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import {homedir} from 'node:os';import {appState,installedCLI} from './install-state';import {AO} from './orchestrator';
import {unlinkSync} from 'node:fs';
import {atomicFile} from './atomic-file';
import {trustedDaemon} from './daemon-runtime';
import {daemonStatus} from './stack-control';
export function runtimeDefinition(label:string,launcher:string,log:string){const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');return `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>${xml(launcher)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>WorkingDirectory</key><string>${xml(join(homedir(),'.ao'))}</string><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;}
const runtimeIO={state:appState,home:homedir,installedCLI,command:Bun.spawnSync,trustedDaemon};
export async function installRuntime(binary:string,apply=false,io=runtimeIO){
 if(process.platform!=='darwin')throw Error('Runtime service requires macOS');
 binary=realpathSync(binary);const bytes=readFileSync(binary),sha256=createHash('sha256').update(bytes).digest('hex');
 const pinPath=join(io.state(),'orchestrator-runtime.json'),old=existsSync(pinPath)?JSON.parse(readFileSync(pinPath,'utf8')):{};
 const label=old.serviceLabel??'local.adlc.orchestrator';if(!/^local\.adlc\.[a-z0-9.-]+$/.test(label))throw Error('Invalid existing service label');
 const cli=io.installedCLI();if(!cli)throw Error('Install a stable bridge snapshot first: adlc install --apply');
 const launcher=resolve(cli,'../serve-orchestrator.py'),executable=join(io.state(),'runtimes',sha256,'ao'),plist=join(io.home(),'Library/LaunchAgents',label+'.plist');
 if(!apply)return {preview:true,binary,sha256,executable,launcher,plist,note:'Stop --all before applying. Registers the binary and service without starting them; start --all activates it.'};
 const status=io.command([AO,'status','--json']);const current=daemonStatus({stdout:status.stdout.toString(),code:status.exitCode});if(current.ready)throw Error('Stop the stack before runtime registration');
 const running=io.command(['/bin/launchctl','print',`gui/${process.getuid?.()}/${label}`]);if(running.exitCode===0)throw Error('Unload the existing runtime service first');
 const backup=join(io.state(),'backups',`runtime-${Date.now()}`);mkdirSync(backup,{recursive:true,mode:0o700});
 if(existsSync(pinPath))copyFileSync(pinPath,join(backup,'runtime.json'));if(existsSync(plist))copyFileSync(plist,join(backup,'service.plist'));
 mkdirSync(resolve(executable,'..'),{recursive:true,mode:0o700});
 if(realpathSync(resolve(executable,'..'))!==resolve(executable,'..'))throw Error('Runtime installation requires a canonical executable path');
 // Install the exact bytes hashed above, not a second read of the source path.
 atomicFile(executable,bytes,0o700,staged=>{if(createHash('sha256').update(readFileSync(staged)).digest('hex')!==sha256)throw Error('Installed runtime hash mismatch');});
 const oldPin=existsSync(pinPath)?readFileSync(pinPath):null,oldPlist=existsSync(plist)?readFileSync(plist):null;
 try{
  atomicFile(plist,runtimeDefinition(label,launcher,join(io.state(),'orchestrator.log')));
  atomicFile(pinPath,JSON.stringify({executable,sha256,serviceLabel:label,launcher,appRunId:old.appRunId??'adlc-native-ci-fix-v1'},null,2)+'\n');
  if(!io.trustedDaemon(executable))throw Error('Installed runtime registration is not trusted');
 }catch(e){
  for(const [path,prior] of [[pinPath,oldPin],[plist,oldPlist]] as const)try{if(prior)atomicFile(path,prior);else if(existsSync(path))unlinkSync(path);}catch{console.error('Runtime registration rollback needs inspection:',path);}
  throw e;
 }
 return {installed:true,executable,sha256,service:label,backup,started:false};
}

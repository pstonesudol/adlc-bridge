import {readFileSync,existsSync,mkdirSync,writeFileSync,copyFileSync,chmodSync,realpathSync} from 'node:fs';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import {homedir} from 'node:os';import {appState,installedCLI} from './install-state';import {AO} from './orchestrator';
export function runtimeDefinition(label:string,launcher:string,log:string){const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');return `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>${xml(launcher)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>WorkingDirectory</key><string>${xml(join(homedir(),'.ao'))}</string><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n`;}
export async function installRuntime(binary:string,apply=false){
 if(process.platform!=='darwin')throw Error('Runtime service requires macOS');
 binary=realpathSync(binary);const sha256=createHash('sha256').update(readFileSync(binary)).digest('hex');
 const pinPath=join(appState(),'orchestrator-runtime.json'),old=existsSync(pinPath)?JSON.parse(readFileSync(pinPath,'utf8')):{};
 const label=old.serviceLabel??'local.adlc.orchestrator';if(!/^local\.adlc\.[a-z0-9.-]+$/.test(label))throw Error('Invalid existing service label');
 const cli=installedCLI();if(!cli)throw Error('Install a stable bridge snapshot first: adlc install --apply');
 const launcher=resolve(cli,'../serve-orchestrator.py'),executable=join(appState(),'runtimes',sha256,'ao'),plist=join(homedir(),'Library/LaunchAgents',label+'.plist');
 if(!apply)return {preview:true,binary,sha256,executable,launcher,plist,note:'Stop --all before applying. Registers the binary and service without starting them; start --all activates it.'};
 const status=Bun.spawnSync([AO,'status','--json']);const current=JSON.parse(status.stdout.toString());if(current.state!=='stopped')throw Error('Stop the stack before runtime registration');
 const running=Bun.spawnSync(['/bin/launchctl','print',`gui/${process.getuid?.()}/${label}`]);if(running.exitCode===0)throw Error('Unload the existing runtime service first');
 const backup=join(appState(),'backups',`runtime-${Date.now()}`);mkdirSync(backup,{recursive:true,mode:0o700});
 if(existsSync(pinPath))copyFileSync(pinPath,join(backup,'runtime.json'));if(existsSync(plist))copyFileSync(plist,join(backup,'service.plist'));
 mkdirSync(resolve(executable,'..'),{recursive:true,mode:0o700});if(binary!==executable)copyFileSync(binary,executable);chmodSync(executable,0o700);
 writeFileSync(pinPath,JSON.stringify({executable,sha256,serviceLabel:label,launcher,appRunId:old.appRunId??'adlc-native-ci-fix-v1'},null,2)+'\n',{mode:0o600});chmodSync(pinPath,0o600);
 writeFileSync(plist,runtimeDefinition(label,launcher,join(appState(),'orchestrator.log')),{mode:0o600});
 return {installed:true,executable,sha256,service:label,backup,started:false};
}

import {existsSync,readFileSync,realpathSync,writeFileSync,lstatSync} from 'node:fs';
import {isAbsolute,dirname} from 'node:path';
import {validate} from './linear';
import {validateVerification,verificationInstructions} from './verification';

export type RuntimeConfig={version:1;platform:'launchd';projectConfig:string;controller:string;workingDirectory:string;tools:Record<string,{path:string;version:string}>;service:{label:string;path:string;interval:number;runAtLoad:boolean;stdout:string;stderr:string}};
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Unknown runtime configuration field');}
function path(p:any){if(typeof p!=='string'||!isAbsolute(p)||/[\x00-\x1f]/.test(p))throw Error('Absolute runtime path required');}
export function validateRuntime(r:any):asserts r is RuntimeConfig{
 exact(r,['version','platform','projectConfig','controller','workingDirectory','tools','service']);
 if(r.version!==1||r.platform!=='launchd')throw Error('Unsupported runtime version/platform');
 for(const k of ['projectConfig','controller','workingDirectory'])path(r[k]);
 exact(r.tools,['bun','ao','git','gh','docker']);
 for(const name of ['bun','ao','git','gh'])if(!r.tools[name])throw Error('Pinned bun, ao, git and gh required');
 for(const t of Object.values(r.tools) as any[]){exact(t,['path','version']);path(t.path);if(typeof t.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(t.version))throw Error('Exact tool version required');}
 const s=r.service;exact(s,['label','path','interval','runAtLoad','stdout','stderr']);
 for(const k of ['path','stdout','stderr'])path(s[k]);
 if(!/^[a-zA-Z0-9][\w.-]{0,180}$/.test(s.label)||!Number.isSafeInteger(s.interval)||s.interval<10||s.interval>86400||typeof s.runAtLoad!=='boolean')throw Error('Invalid service settings');
}
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function runtimeServiceDefinition(r:RuntimeConfig){
 validateRuntime(r);const s=r.service;
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(s.label)}</string>
<key>ProgramArguments</key><array>${[r.tools.bun.path,r.controller,'poll',r.projectConfig].map(a=>`<string>${xml(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(r.workingDirectory)}</string>
<key>EnvironmentVariables</key><dict><key>ADLC_AO_PATH</key><string>${xml(r.tools.ao.path)}</string><key>PATH</key><string>${xml([...new Set(Object.values(r.tools).map(t=>dirname(t.path))),'/usr/bin','/bin'].join(':'))}</string></dict>
<key>StartInterval</key><integer>${s.interval}</integer><key>RunAtLoad</key><${s.runAtLoad?'true':'false'}/>
<key>StandardOutPath</key><string>${xml(s.stdout)}</string><key>StandardErrorPath</key><string>${xml(s.stderr)}</string>
</dict></plist>\n`;
}
// No provider calls, registry opening, credentials, project-setting changes or launchctl.
const liveProbe=(name:string,t:{path:string;version:string})=>{
 if(!existsSync(t.path))return false;
 const p=Bun.spawnSync([t.path,'--version'],{stdout:'pipe',stderr:'pipe',timeout:10000,env:{PATH:'/usr/bin:/bin'}});
 return p.exitCode===0&&p.stdout.toString().trim().split(/\s+/).some(x=>x===t.version||x===`v${t.version}`);
};
export function setupPreview(c:any,r:RuntimeConfig,probe=liveProbe){
 validate(c);validateRuntime(r);if(c.verification)validateVerification(c.verification);
 if(c.verification?.mode==='container'&&!r.tools.docker)throw Error('Pinned Docker executable required');
 const definition=runtimeServiceDefinition(r);
 const existing=existsSync(r.service.path)?readFileSync(r.service.path,'utf8'):undefined;
 const checks=Object.entries(r.tools).map(([name,t])=>({name,passed:probe(name,t),kind:probe===liveProbe?'live-executable-version':'injected-probe-not-live'}));
 for(const [name,p] of Object.entries({repo:c.repo,projectConfig:r.projectConfig,controller:r.controller,workingDirectory:r.workingDirectory}))checks.push({name,passed:existsSync(p as string),kind:'live-path'});
 if(existsSync(r.projectConfig))checks.push({name:'project-config-content',passed:JSON.stringify(JSON.parse(readFileSync(r.projectConfig,'utf8')))===JSON.stringify(c),kind:'live-file'});
 const conflict=existing!==undefined&&existing!==definition;
 return {mode:'preview_only',passed:checks.every(c=>c.passed)&&!conflict,checks,service:existing===undefined?'create':conflict?'conflict-existing-preserved':'unchanged',definition,verification:verificationInstructions(c.verification),activation:false,limitations:['No live provider, registered-project, credential, image availability or running-service verification performed.','An existing semantically equivalent plist with different formatting is conservatively treated as a conflict.']};
}
export function writeSetupService(c:any,r:RuntimeConfig){
 const preview=setupPreview(c,r);if(!preview.passed)throw Error('Setup validation failed; existing configuration preserved');
 if(preview.service==='unchanged')return {written:false,activation:false};
 // Render to a staging file only. Never install into a login-loaded service directory.
 if(r.service.path.includes('/Library/LaunchAgents/')||r.service.path.includes('/Library/LaunchDaemons/'))throw Error('Use a staging service.path; installation/activation requires separate human action');
 if(lstatSync(dirname(r.service.path)).isSymbolicLink()||realpathSync(dirname(r.service.path)).includes('/Library/LaunchAgents'))throw Error('Unsafe service staging directory');
 writeFileSync(r.service.path,preview.definition,{flag:'wx',mode:0o600});return {written:true,activation:false};
}
// Intentionally emit a portable template, not a dump of local configuration.
// Commands/identities/paths may themselves contain private data, so do not copy them.
export function sanitizedSetup(c:any,r:RuntimeConfig){
 validate(c);validateRuntime(r);if(c.verification)validateVerification(c.verification);
 return {version:1,kind:'sanitized-setup-template',project:{version:1,name:'YOUR_PROJECT',repo:'/REPLACE/repository',githubRepo:'OWNER/REPOSITORY',automation:{planningEnabled:false,orchestratorProject:'REPLACE_PROJECT'},linear:Object.fromEntries(['projectId','teamId','readyStateId','readyLabelId'].map(k=>[k,'REPLACE_UUID'])),approval:{mode:'manual'},verification:c.verification?{version:1,mode:c.verification.mode,steps:[{cwd:'.',argv:['REPLACE_VERIFICATION_COMMAND']}],...(c.verification.mode==='container'?{container:{image:'sha256:REPLACE_DIGEST',inputs:['REPLACE_INPUT']}}:{})}:undefined},runtime:{version:1,platform:r.platform,projectConfig:'/REPLACE/project.json',controller:'/REPLACE/stable-install/src/cli.ts',workingDirectory:'/REPLACE/stable-install',tools:Object.fromEntries(Object.entries(r.tools).map(([k,t])=>[k,{path:`/REPLACE/bin/${k}`,version:t.version}])),service:{label:'local.adlc.REPLACE',path:'/REPLACE/staging/service.plist',interval:r.service.interval,runAtLoad:false,stdout:'/REPLACE/state/stdout.log',stderr:'/REPLACE/state/stderr.log'}},instructions:'Template only: restore local mappings, policies and verification from original files. Never transfer standing authorization. Existing credential mechanisms must be configured separately.'};
}

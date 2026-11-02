import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
export const bundledAO='/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao';
const configPath=()=>join(homedir(),'Library/Application Support/ADLC Bridge/orchestrator-runtime.json');
let cached:{path:string;sha:string;stamp:string}|undefined;
// An explicitly pinned local hotfix may be used without changing the signed app.
// The stock bundled daemon remains accepted for rollback and vendor updates.
export function trustedDaemon(path:string,config=configPath()){
 if(path===bundledAO)return true;
 if(!existsSync(config))return false;
 const file=lstatSync(config);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0||file.uid!==process.getuid?.())throw Error('Daemon override must be an owner-only regular file');
 const c=JSON.parse(readFileSync(config,'utf8'));
 if(!isAbsolute(c.executable??'')||c.executable!==path||!/^[a-f0-9]{64}$/.test(c.sha256??'')||!existsSync(path))return false;
 const binary=lstatSync(path);if(!binary.isFile()||binary.isSymbolicLink()||binary.uid!==process.getuid?.()||(binary.mode&0o022)!==0||realpathSync(path)!==path)return false;
 const stamp=`${binary.ino}:${binary.size}:${binary.mtimeMs}:${binary.ctimeMs}`;
 if(cached?.path===path&&cached.sha===c.sha256&&cached.stamp===stamp)return true;
 const hash=createHash('sha256').update(readFileSync(path)).digest('hex');if(hash!==c.sha256)return false;
 cached={path,sha:hash,stamp};return true;
}

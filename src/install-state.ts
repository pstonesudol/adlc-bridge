import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';import {join,isAbsolute} from 'node:path';import {homedir} from 'node:os';
export const appState=()=>join(homedir(),'Library/Application Support/ADLC Bridge');
function installation(state:string){const p=join(state,'installation.json');if(!existsSync(p))return;
 const st=lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('Installation record must be owner-only');
 const c=JSON.parse(readFileSync(p,'utf8'));if(typeof c.cli!=='string'||!c.cli.startsWith(join(state,'versions')+'/')||!c.cli.endsWith('/src/cli.ts'))throw Error('Invalid installed CLI');return c;
}
export function installedCLI(){return installation(appState())?.cli as string|undefined;}
export function verifiedInstallationSource(state=appState()){
 const c=installation(state);if(!c)return;
 if(typeof c.source!=='string'||!isAbsolute(c.source))throw Error('Invalid installation source');
 return realpathSync(c.source);
}

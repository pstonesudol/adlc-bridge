import {existsSync,lstatSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {homedir} from 'node:os';
export const appState=()=>join(homedir(),'Library/Application Support/ADLC Bridge');
export function installedCLI(){const p=join(appState(),'installation.json');if(!existsSync(p))return;
 const st=lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw Error('Installation record must be owner-only');
 const c=JSON.parse(readFileSync(p,'utf8'));if(typeof c.cli!=='string'||!c.cli.startsWith(join(appState(),'versions')+'/')||!c.cli.endsWith('/src/cli.ts'))throw Error('Invalid installed CLI');return c.cli as string;
}

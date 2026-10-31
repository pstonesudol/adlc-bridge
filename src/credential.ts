import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
export const tokenPath=join(homedir(),'Library','Application Support','ADLC Bridge','linear-token');
export function linearToken(){
  if(process.env.ADLC_LINEAR_TOKEN)return process.env.ADLC_LINEAR_TOKEN;
  if(!existsSync(tokenPath))return '';
  const s=lstatSync(tokenPath);
  if(!s.isFile() || s.isSymbolicLink() || (s.mode&0o077)!==0 || s.uid!==process.getuid?.())throw Error('Linear credential must be an owner-only regular file');
  return readFileSync(tokenPath,'utf8').trim();
}

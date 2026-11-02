import {mkdirSync,mkdtempSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
export function atomicFile(path:string,text:string|Uint8Array,mode=0o600,verify?:(staged:string)=>void){
 mkdirSync(dirname(path),{recursive:true});
 const stage=mkdtempSync(join(dirname(path),'.adlc-write-'));
 try{const temp=join(stage,'file');writeFileSync(temp,text,{mode,flag:'wx'});verify?.(temp);renameSync(temp,path);}
 finally{rmSync(stage,{recursive:true,force:true});}
}

import {extractCILog,CI_LOG_LIMITS} from './ci-log-evidence';
type Command=(args:string[])=>Promise<{out:string;code:number}>;
export async function boundedLogCommand(args:string[],timeout=CI_LOG_LIMITS.timeout as number,spawn=Bun.spawn){
 const p=spawn(['gh',...args],{stdout:'pipe',stderr:'pipe',timeout,killSignal:'SIGKILL'});
 const logs=args.some(a=>/^repos\/[\w.-]+\/[\w.-]+\/actions\/jobs\/\d+\/logs$/.test(a));
 const read=async(stream:ReadableStream<Uint8Array>)=>{
  const reader=stream.getReader(),decoder=new TextDecoder();let size=0,text='';
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>128*1024){p.kill('SIGKILL');throw Error('CI log read exceeds bound');}text+=decoder.decode(chunk.value,{stream:true});}return text+decoder.decode();}finally{reader.releaseLock();}
 };
 try{
  const collect=async()=>{const evidence=await extractCILog(p.stdout);if(!evidence.complete)p.kill('SIGKILL');return JSON.stringify({ciLogExcerpt:1,...evidence});};
  const [out,_err,code]=await Promise.all([logs?collect():read(p.stdout),read(p.stderr),p.exited]);
  // Preserve fixed extraction failure codes, never stderr/provider prose.
  if(logs){const evidence=JSON.parse(out);if(code!==0&&evidence.complete){evidence.complete=false;evidence.text='';evidence.reason='log command failed or timed out';}return {out:JSON.stringify(evidence),code:0};}
  return {out,code};
 }finally{p.kill('SIGKILL');await p.exited;}
}
// One diagnosis gets one deadline, not a fresh timeout per endpoint.
export function ciLogReader(){
 const deadline=Date.now()+CI_LOG_LIMITS.timeout;
 return templateLogReader(args=>{const remaining=deadline-Date.now();if(remaining<=0)throw Error('CI evidence deadline exhausted');return boundedLogCommand(args,remaining);});
}
async function command(args:string[]){
 const p=Bun.spawn(['gh',...args],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [out,_err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {out,code};
}
export function templateLogReader(run:Command=command){
 let supportsEscapes:Promise<boolean>|undefined;
 const version=async()=>{
  const r=await run(['--version']);if(r.code!==0)throw Error('Cannot inspect GitHub CLI version');
  const match=r.out.match(/^gh version (\d+)\.(\d+)\.(\d+)(?:\s|\(|$)/);if(!match)throw Error('Unknown GitHub CLI version');
  const major=Number(match[1]),minor=Number(match[2]);return major>2||major===2&&minor>=97;
 };
 return async(path:string)=>{
  const escapes=await(supportsEscapes??=version()),r=await run(['api',path,...(escapes?['--allow-escape-sequences']:[])]);
  if(r.code!==0)throw Error('Template-check logs unavailable');return r.out;
 };
}

type Command=(args:string[])=>Promise<{out:string;code:number}>;
export async function boundedLogCommand(args:string[]){
 const p=Bun.spawn(['gh',...args],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const read=async(stream:ReadableStream<Uint8Array>)=>{
  const reader=stream.getReader(),decoder=new TextDecoder();let size=0,text='';
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>128*1024){p.kill();throw Error('CI log read exceeds bound');}text+=decoder.decode(chunk.value,{stream:true});}return text+decoder.decode();}finally{reader.releaseLock();}
 };
 const [out,_err,code]=await Promise.all([read(p.stdout),read(p.stderr),p.exited]);return {out,code};
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

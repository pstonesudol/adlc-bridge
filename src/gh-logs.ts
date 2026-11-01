type Command=(args:string[])=>Promise<{out:string;code:number}>;
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

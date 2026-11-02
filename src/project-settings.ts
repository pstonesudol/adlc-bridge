export type ProjectSettings = {pollingIntervalSeconds?:number;automation?:{maxPlanning?:number}};
export function effectiveSettings(c:ProjectSettings){
 const integer=(value:unknown,fallback:number,min:number,max:number,name:string)=>{
  const n=value===undefined?fallback:value;
  if(!Number.isSafeInteger(n)||(n as number)<min||(n as number)>max)throw Error(`${name} must be an integer from ${min} to ${max}`);
  return n as number;
 };
 return {pollingIntervalSeconds:integer(c.pollingIntervalSeconds,60,5,86400,'pollingIntervalSeconds'),maxPlanning:integer(c.automation?.maxPlanning,1,1,32,'automation.maxPlanning')};
}
export async function serveLoop(tick:()=>Promise<void>,c:ProjectSettings,stopped:()=>boolean,sleep:(ms:number)=>Promise<unknown>=Bun.sleep,onError:(e:unknown)=>void=console.error){
 const {pollingIntervalSeconds}=effectiveSettings(c);
 while(!stopped()){
  try{await tick();}catch(e){onError(e);}
  for(let i=0;i<pollingIntervalSeconds&&!stopped();i++)await sleep(1000);
 }
}

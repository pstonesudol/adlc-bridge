import {linearToken} from './credential';
import {Store} from './core';
import {registryPath} from './project-services';
import {LinearCooldowns,isLinearThrottle,LinearCooldown,LinearPreSendCooldown} from './linear-cooldowns';
export type LinearSendOptions={beforeSend?:()=>void};
export type LinearAPI=(query:string,variables?:Record<string,unknown>,options?:LinearSendOptions)=>Promise<any>;
class LinearTransportFailure extends Error{}
export class LinearPreSendFailure extends Error{}
// Only the caller owning a fresh reservation may release it, and only when the
// requested operation definitely never reached fetch. Sent failures stay fenced.
export async function withLinearReservation<T>(send:()=>Promise<T>,release:()=>void):Promise<T>{
 try{return await send();}catch(error){if(error instanceof LinearPreSendCooldown||error instanceof LinearPreSendFailure)release();throw error;}
}
function validateLinearSend(beforeSend?:()=>void){
 try{beforeSend?.();}catch{throw new LinearPreSendFailure('Linear pre-send validation rejected; refresh requirements and revision');}
}
export function coordinatedLinearFetch(quotas:LinearCooldowns,token:string,send=fetch,project?:string,beforeSend?:()=>void):typeof fetch {
 return (async(url:any,init:any)=>{
   await quotas.admit(token,project);
   const prior=init?.signal!==undefined?init.signal:(url instanceof Request?url.signal:undefined);
   if(prior?.aborted)throw new LinearPreSendFailure('Linear request cancelled before send');
   validateLinearSend(beforeSend);
   const timeout=AbortSignal.timeout(20000),signal=prior?AbortSignal.any([prior,timeout]):timeout;
   let r:Response;try{r=await send(url,{...init,signal});}catch{throw new LinearTransportFailure('Linear request failed; delivery may be uncertain');}
   let body:any,validJSON=true;try{body=await r.clone().json();}catch{validJSON=false;}
   const until=quotas.observe(token,r.status,r.headers,body);
   if(isLinearThrottle(r.status,body)){if(project)quotas.state(project,'cooldown');throw new LinearCooldown(until);}
   if(!validJSON)throw new LinearTransportFailure('Linear returned invalid JSON');
   return r;
 }) as typeof fetch;
}
export function createLinearAPI(send=fetch,token=linearToken,quotas?:LinearCooldowns):LinearAPI{return async(query,variables={},options={})=>{
  const credential=token();
  const transport=quotas?coordinatedLinearFetch(quotas,credential,send):send;
  if(quotas&&!quotas.verified(credential)){
    try{const identity=await transport('https://api.linear.app/graphql',{method:'POST',headers:{Authorization:credential,'Content-Type':'application/json'},body:JSON.stringify({query:'query{viewer{id}}'})});const b:any=await identity.json();if(identity.ok&&!b.errors)quotas.verify(credential,b.data?.viewer?.id);}catch(e){if(e instanceof LinearCooldown)throw new LinearPreSendCooldown(e.nextEligible);if(!(e instanceof LinearTransportFailure))throw e;}
  }
  const operation=quotas?coordinatedLinearFetch(quotas,credential,send,undefined,options.beforeSend):send;
  if(!quotas)validateLinearSend(options.beforeSend);
  const r=await operation('https://api.linear.app/graphql',{method:'POST',headers:{Authorization:credential,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),...(!quotas?{signal:AbortSignal.timeout(20000)}:{})});
 if(!r.ok)throw Error(`Linear HTTP ${r.status}`);const b=await r.json();if(b.errors||!b.data)throw Error('Linear returned errors or incomplete data');return b.data;
};}
export const linearAPI:LinearAPI=async(query,variables,options)=>{const s=new Store(process.env.ADLC_DB??registryPath());try{return await createLinearAPI(fetch,linearToken,new LinearCooldowns(s))(query,variables,options);}finally{s.close();}};
export const issueFields='id identifier title description url team{id} project{id} state{id type} labels(first:100){nodes{id name} pageInfo{hasNextPage}}';
export async function readLinearIssue(id:string,api:LinearAPI=linearAPI){const b=await api(`query($id:String!){issue(id:$id){${issueFields}}}`,{id});return b.issue;}

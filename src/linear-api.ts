import {linearToken} from './credential';
import {Store} from './core';
import {registryPath} from './project-services';
import {LinearCooldowns,isLinearThrottle,LinearCooldown,LinearPreSendCooldown} from './linear-cooldowns';
export type LinearAPI=(query:string,variables?:Record<string,unknown>)=>Promise<any>;
class LinearTransportFailure extends Error{}
// Only the caller owning a fresh reservation may release it, and only when the
// requested operation definitely never reached fetch. Sent failures stay fenced.
export async function withLinearReservation<T>(send:()=>Promise<T>,release:()=>void):Promise<T>{
 try{return await send();}catch(error){if(error instanceof LinearPreSendCooldown)release();throw error;}
}
export function coordinatedLinearFetch(quotas:LinearCooldowns,token:string,send=fetch,project?:string):typeof fetch {
 return (async(url:any,init:any)=>{
   await quotas.admit(token,project);
   let r:Response;try{r=await send(url,init);}catch{throw new LinearTransportFailure('Linear request failed; delivery may be uncertain');}
   let body:any,validJSON=true;try{body=await r.clone().json();}catch{validJSON=false;}
   const until=quotas.observe(token,r.status,r.headers,body);
   if(isLinearThrottle(r.status,body)){if(project)quotas.state(project,'cooldown');throw new LinearCooldown(until);}
   if(!validJSON)throw new LinearTransportFailure('Linear returned invalid JSON');
   return r;
 }) as typeof fetch;
}
export function createLinearAPI(send=fetch,token=linearToken,quotas?:LinearCooldowns):LinearAPI{return async(query,variables={})=>{
  const credential=token();
  const transport=quotas?coordinatedLinearFetch(quotas,credential,send):send;
  if(quotas&&!quotas.verified(credential)){
    try{const identity=await transport('https://api.linear.app/graphql',{method:'POST',headers:{Authorization:credential,'Content-Type':'application/json'},body:JSON.stringify({query:'query{viewer{id}}'}),signal:AbortSignal.timeout(20000)});const b:any=await identity.json();if(identity.ok&&!b.errors)quotas.verify(credential,b.data?.viewer?.id);}catch(e){if(e instanceof LinearCooldown)throw new LinearPreSendCooldown(e.nextEligible);if(!(e instanceof LinearTransportFailure))throw e;}
  }
  const r=await transport('https://api.linear.app/graphql',{method:'POST',headers:{Authorization:credential,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error(`Linear HTTP ${r.status}`);const b=await r.json();if(b.errors||!b.data)throw Error('Linear returned errors or incomplete data');return b.data;
};}
export const linearAPI:LinearAPI=async(query,variables)=>{const s=new Store(process.env.ADLC_DB??registryPath());try{return await createLinearAPI(fetch,linearToken,new LinearCooldowns(s))(query,variables);}finally{s.close();}};
export const issueFields='id identifier title description url team{id} project{id} state{id type} labels(first:100){nodes{id name} pageInfo{hasNextPage}}';
export async function readLinearIssue(id:string,api:LinearAPI=linearAPI){const b=await api(`query($id:String!){issue(id:$id){${issueFields}}}`,{id});return b.issue;}

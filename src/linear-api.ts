import {linearToken} from './credential';
export type LinearAPI=(query:string,variables?:Record<string,unknown>)=>Promise<any>;
export const linearAPI:LinearAPI=async(query,variables={})=>{
 const r=await fetch('https://api.linear.app/graphql',{method:'POST',headers:{Authorization:linearToken(),'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error(`Linear HTTP ${r.status}`);const b=await r.json();if(b.errors||!b.data)throw Error('Linear returned errors or incomplete data');return b.data;
};
export const issueFields='id identifier title description url team{id} project{id} state{id type} labels(first:100){nodes{id name} pageInfo{hasNextPage}}';
export async function readLinearIssue(id:string,api:LinearAPI=linearAPI){const b=await api(`query($id:String!){issue(id:$id){${issueFields}}}`,{id});return b.issue;}

import type {Route} from './task-routing';
import {localAO} from './workflow-transport';

type API=(path:string,method?:string,body?:unknown)=>Promise<any>;
export async function preflightRoute(route:Route,api:API=localAO){
 const catalog=await api(`agents/${route.harness}/models?catalogOnly=true`);
 if(!Array.isArray(catalog.models)||!catalog.models.some((m:any)=>m.id===route.model))throw Error('Configured routing model is not in the Orchestrator catalog');
}
export async function configureSessionRoute(session:string,route:Route,api:API=localAO){
 if(!/^[\w-]+$/.test(session))throw Error('Invalid routing session');
 const prefix=`sessions/${session}/conversation/config-options`;
 const evidence=await api(`sessions/${session}`);
 const conversation=await api(`sessions/${session}/conversation`);
 if(conversation.controller!=='ready'||conversation.turns?.some((t:any)=>['queued','running'].includes(t.state)))throw Error('Worker must be idle before changing its routing');
 if(evidence.session?.harness!==route.harness||evidence.session?.isTerminated)throw Error('Route requires a different harness; no implicit harness handoff');
 let b=await api(prefix);
 const options=()=>{if(!Array.isArray(b.options))throw Error('Incomplete model configuration controls');return b.options;};
 const select=async(id:string,value:string)=>{
  const o=options().find((o:any)=>o.id===id);
  if(!o?.choices?.some((c:any)=>c.value===value))throw Error(`Configured ${id} is not advertised by this live provider`);
  b=await api(`${prefix}/${encodeURIComponent(id)}`,'PATCH',{value});
  if(options().find((o:any)=>o.id===id)?.currentValue!==value)throw Error(`Provider did not confirm the selected ${id}`);
 };
 // Always select the model first: OpenCode resets its variant on a model change.
 await select('model',route.model);
 if(route.effort)await select('effort',route.effort);
 else if(options().find((o:any)=>o.id==='effort')?.choices?.some((c:any)=>c.value==='default'))await select('effort','default');
 await select('mode',route.mode);
 const after=await api(prefix);b=after;
 if(options().find((o:any)=>o.id==='mode')?.currentValue!==route.mode||options().find((o:any)=>o.id==='model')?.currentValue!==route.model||route.effort&&options().find((o:any)=>o.id==='effort')?.currentValue!==route.effort)throw Error('Routing selection changed before delivery');
 return {harness:route.harness,model:route.model,effort:route.effort,verified:true};
}

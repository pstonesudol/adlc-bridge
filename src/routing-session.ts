import type {Route} from './task-routing';
import {localAO} from './workflow-transport';
import {discoverMode,confirmMode,openCodeModes,NativeModeFailure,ProviderModeFailure} from './provider-mode';

type API=(path:string,method?:string,body?:unknown)=>Promise<any>;
const approvalPosture=(value:unknown)=>typeof value==='string'&&value?value:undefined;
export class RoutePreflightFailure extends Error{
 constructor(public kind:'unavailable'|'transient'){
  super(kind==='unavailable'?'Pinned model is not advertised by Orchestrator':'Model catalog could not be verified; retry preflight');
 }
}
export async function preflightRoute(route:Route,api:API=localAO){
 let catalog:any;
 try{catalog=await api(`agents/${route.harness}/models?catalogOnly=true`);}catch{throw new RoutePreflightFailure('transient');}
 // Incomplete/malformed evidence is not proof that a model is unavailable.
 if(!Array.isArray(catalog?.models)||catalog.models.some((m:any)=>typeof m?.id!=='string')||catalog.nextCursor||catalog.hasMore===true||catalog.pageInfo?.hasNextPage===true||catalog.complete===false)throw new RoutePreflightFailure('transient');
 if(!catalog.models.some((m:any)=>m.id===route.model))throw new RoutePreflightFailure('unavailable');
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
 // Mapping belongs to this adapter. A provider mode does not authorize the
 // workflow phase; existing revision/approval/submission gates remain owners.
 // Read the existing approval posture, never infer it from the target choice
 // or PATCH permissions. Unknown posture still rejects annotated modes.
 const permission=approvalPosture(conversation.settings?.approvalMode);
 const mode=discoverMode(route.mode==='plan'?'planning':'execution',openCodeModes,options(),route.mode,permission);
 try{b=await api(`${prefix}/${encodeURIComponent(mode.option)}`,'PATCH',{value:mode.mode});}
 catch(e){throw new ProviderModeFailure(e instanceof NativeModeFailure?e.kind:'uncertain',mode.intent,mode.mode,e instanceof NativeModeFailure?e.observed:'unknown');}
 confirmMode(mode,b.options);
 const after=await api(prefix);b=after;
 confirmMode(mode,options());
 const finalConversation=await api(`sessions/${session}/conversation`);
 if(approvalPosture(finalConversation.settings?.approvalMode)!==permission)throw new ProviderModeFailure('rejected',mode.intent,mode.mode,'unknown');
 if(options().find((o:any)=>o.id==='mode')?.currentValue!==route.mode||options().find((o:any)=>o.id==='model')?.currentValue!==route.model||route.effort&&options().find((o:any)=>o.id==='effort')?.currentValue!==route.effort)throw Error('Routing selection changed before delivery');
 return {harness:route.harness,model:route.model,effort:route.effort,verified:true};
}

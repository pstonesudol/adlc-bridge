/** Semantic intent is ADLC workflow data, never a provider permission grant.
 * This module performs no I/O, restore, retry, send, spawn or authorization. */
export type WorkflowIntent='planning'|'execution';
export type ModeAdapter={id:string;option:string;modes:Record<WorkflowIntent,readonly string[]>};
export type ModeSelection={intent:WorkflowIntent;adapter:string;option:string;mode:string;permission:string|null};
export const openCodeModes:ModeAdapter={id:'opencode',option:'mode',modes:{planning:['plan'],execution:['build']}};
type Failure='unsupported'|'rejected'|'unconfirmed'|'transient'|'uncertain';
// Never include provider error bodies, model configuration or credentials.
const label=(s:unknown)=>typeof s==='string'&&/^[\w.-]{1,80}$/.test(s)?s:'unknown';
export class ProviderModeFailure extends Error{
 constructor(public kind:Failure,public intent:WorkflowIntent,public requested:string,public observed:unknown){
  super(`Provider mode ${kind}: intent=${intent}; requested=${label(requested)}; observed=${label(observed)}. Preserve the existing owner and permissions; inspect advertised capabilities and native compatibility before explicit recovery. No turn sent or retry authorized.`);
 }
}
/** The native API has no authority to infer ADLC intent. Decode only the narrow
 * mode-restore schema; the workflow adapter supplies intent from its own grant. */
export class NativeModeFailure extends Error{
 constructor(public kind:Failure,public requested:string,public observed:string){
  super(`Native provider mode ${kind}: requested=${requested}; observed=${observed}. Preserve the existing session and permissions; inspect native/provider compatibility before explicit recovery. No automatic retry.`);
 }
}
export function nativeModeFailure(body:unknown):NativeModeFailure|null{
 if(!body||typeof body!=='object'||Array.isArray(body))return null;
 const b=body as any,error=b.code!==undefined?b:b.error,d=error?.details;
 if(error?.code!=='PROVIDER_MODE_RESTORE_FAILED'||!d||typeof d!=='object'||Array.isArray(d)||d.retrySafe!==false||!['unsupported','rejected','unconfirmed','transient','uncertain'].includes(d.failureKind))return null;
 return new NativeModeFailure(d.failureKind,label(d.requestedMode),label(d.observedMode));
}
function modeOption(catalog:unknown,id:string){
 if(!Array.isArray(catalog)||catalog.filter(o=>o?.id===id).length!==1)return null;
 const o=catalog.find(o=>o?.id===id);
 if(!Array.isArray(o.choices)||o.choices.some((c:any)=>typeof c?.value!=='string')||new Set(o.choices.map((c:any)=>c.value)).size!==o.choices.length)return null;
 return o;
}
/** Aliases must be explicitly provided by the adapter, not inferred from labels.
 * A pinned provider identifier never falls back to another alias. */
export function discoverMode(intent:WorkflowIntent,adapter:ModeAdapter,catalog:unknown,pinned?:string,permission?:string):ModeSelection{
 const ids=adapter.modes[intent],other=adapter.modes[intent==='planning'?'execution':'planning'];
 const option=modeOption(catalog,adapter.option),observed=option?.currentValue;
 const fail=()=>{throw new ProviderModeFailure('unsupported',intent,pinned??ids?.[0]??'unknown',observed);};
 if(!Array.isArray(ids)||!ids.length||ids.some(id=>!id||other?.includes(id))||new Set(ids).size!==ids.length||!option)return fail();
 const matches=option.choices.filter((c:any)=>ids.includes(c.value)&&(pinned===undefined||c.value===pinned));
 if(matches.length!==1)return fail();
 const choice=matches[0];
 // A mode declaring a permission posture may not alter the caller's boundary.
 if(choice.permissionMode!==undefined&&choice.permissionMode!==''&&choice.permissionMode!==permission)throw new ProviderModeFailure('rejected',intent,choice.value,observed);
 return {intent,adapter:adapter.id,option:adapter.option,mode:choice.value,permission:permission??null};
}
/** Only the authoritative setter result counts; never re-read a cache that may
 * have optimistically applied an empty acknowledgement. */
export function confirmMode(selection:ModeSelection,catalog:unknown){
 const option=modeOption(catalog,selection.option),choice=option?.choices.find((c:any)=>c.value===selection.mode);
 if(!choice||option.currentValue!==selection.mode)throw new ProviderModeFailure('unconfirmed',selection.intent,selection.mode,option?.currentValue);
 if(choice.permissionMode!==undefined&&choice.permissionMode!==''&&choice.permissionMode!==selection.permission)throw new ProviderModeFailure('rejected',selection.intent,selection.mode,option.currentValue);
 return selection;
}

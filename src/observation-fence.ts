import {AsyncLocalStorage} from 'node:async_hooks';
const fence=new AsyncLocalStorage<()=>void>();
// `sent` distinguishes a fence rejection before an external request from one
// after it may have been delivered; only the former is safe to release.
export class ObservationLeaseLost extends Error{constructor(public sent=true){super('Review evaluation lease expired or replaced; discard stale evidence and wait for the current owner');}}
export function assertObservationFence(){fence.getStore()?.();}
export function withObservationFence<T>(check:()=>void,run:()=>Promise<T>){return fence.run(check,run);}
// Preserve synchronous transports (notably spawn); fence both sides of async IO.
export function fencedIO<T extends object>(io:T):T{return new Proxy(io,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return (...args:any[])=>{
 try{assertObservationFence();}catch(error){if(error instanceof ObservationLeaseLost)throw new ObservationLeaseLost(false);throw error;}
 const result=value.apply(target,args);
 return result&&typeof result.then==='function'?result.then((v:any)=>{assertObservationFence();return v;},(e:any)=>{assertObservationFence();throw e;}):result;
};}});}

export type ConflictPolicy={version:1;enabled:boolean;authorizedBy:string;baseBranch:string;maxRecoveries:number;verification:string[][]};
export function validateConflictPolicy(p:unknown):asserts p is ConflictPolicy|undefined{
 if(p===undefined)return;
 const c=p as ConflictPolicy;
 if(!c||c.version!==1||typeof c.enabled!=='boolean'||typeof c.authorizedBy!=='string'||!c.authorizedBy.trim()||typeof c.baseBranch!=='string'||!c.baseBranch||c.baseBranch.startsWith('-')||/[\s~^:?*\[\\]/.test(c.baseBranch)||c.baseBranch.includes('..')||!Number.isSafeInteger(c.maxRecoveries)||c.maxRecoveries<1||c.maxRecoveries>10||!Array.isArray(c.verification)||!c.verification.length||c.verification.some(a=>!Array.isArray(a)||!a.length||a.some(v=>typeof v!=='string'||!v||v.includes('\0'))))throw Error('Explicit version 1 conflict recovery policy, base, bounded limit and verification argv required');
}

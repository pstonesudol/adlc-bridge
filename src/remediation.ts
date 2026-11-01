export type RemediationWindow='job';
export type RemediationPolicy={maxAttempts:number|null;maxNoProgress:number;window:RemediationWindow};
export type RemediationConfig={maxAttempts?:number|null;maxNoProgress?:number;window?:RemediationWindow};
export type RemediationSummary={
 job:string;
 configuredMaxAttempts:number|null;
 effectiveMaxAttempts:number|null;
 consumed:number;
 remaining:number|null;
 uncapped:boolean;
 extensions:number;
 noProgress:number;
 maxNoProgress:number;
 window:RemediationWindow;
 scope:'job';
 stopReason:string|null;
};

export const DEFAULT_REMEDIATION_POLICY:RemediationPolicy=Object.freeze({
 maxAttempts:5,
 maxNoProgress:5,
 window:'job' as const,
});

export function remediationPolicy(value?:RemediationConfig|null):RemediationPolicy{
 if(value!==undefined&&value!==null&&(typeof value!=='object'||Array.isArray(value)))throw Error('Invalid remediation budget configuration');
 const maxAttempts=value?.maxAttempts===undefined?DEFAULT_REMEDIATION_POLICY.maxAttempts:value.maxAttempts;
 if(maxAttempts!==null&&(!Number.isSafeInteger(maxAttempts)||maxAttempts<1))throw Error('Remediation maxAttempts must be a positive integer or null for uncapped mode');
 const maxNoProgress=value?.maxNoProgress===undefined?DEFAULT_REMEDIATION_POLICY.maxNoProgress:value.maxNoProgress;
 if(!Number.isSafeInteger(maxNoProgress)||maxNoProgress<1)throw Error('Remediation maxNoProgress must be a positive integer');
 const window=value?.window===undefined?DEFAULT_REMEDIATION_POLICY.window:value.window;
 if(window!=='job')throw Error('Only job-scoped remediation windows are supported');
 return {maxAttempts,maxNoProgress,window};
}

export function remediationSummary(input:{
 job:string;
 policy:RemediationPolicy;
 consumed:number;
 extensions:number;
 noProgress:number;
 stopReason?:string|null;
}):RemediationSummary{
 const {job,policy,consumed,extensions,noProgress}=input;
 const effectiveMaxAttempts=policy.maxAttempts===null?null:policy.maxAttempts+extensions;
 return {
  job,
  configuredMaxAttempts:policy.maxAttempts,
  effectiveMaxAttempts,
  consumed,
  remaining:effectiveMaxAttempts===null?null:Math.max(0,effectiveMaxAttempts-consumed),
  uncapped:effectiveMaxAttempts===null,
  extensions,
  noProgress,
  maxNoProgress:policy.maxNoProgress,
  window:policy.window,
  scope:'job',
  stopReason:input.stopReason??null,
 };
}

export function formatRemediationBudget(summary:RemediationSummary){
 const cap=summary.uncapped?'uncapped':`${summary.consumed}/${summary.effectiveMaxAttempts}`;
 const remaining=summary.uncapped?'remaining unlimited':`remaining ${summary.remaining}`;
 return `${cap} (${remaining}; job window; ${summary.noProgress}/${summary.maxNoProgress} consecutive without progress)${summary.stopReason?`; stopped: ${summary.stopReason}`:''}`;
}

export type ReadClass='authentication'|'permission'|'throttled'|'timeout'|'network'|'server'|'missing'|'malformed'|'unknown';
export const validReadTime=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
export const MAX_PROVIDER_RETRY_MS=24*60*60*1000;
export const boundedRetryAt=(value:unknown,now:number)=>validReadTime(value)&&value>now?Math.min(value,now+MAX_PROVIDER_RETRY_MS):undefined;
export type ReadEvidence={provider:'github'|'orchestrator';operation:string;timestamp:number;classification:ReadClass;exitStatus?:number;httpStatus?:number;retryAt?:number;retryAtUnrepresentable?:true;requestId?:string;detail:string};
export class ProviderReadError extends Error{
 constructor(public evidence:ReadEvidence,options?:ErrorOptions){super(`${evidence.provider} ${evidence.operation}: ${evidence.classification}`,options);}
}
export class ReadValidationError extends Error{constructor(){super('PR is not open; inspect PR state before further review.');}}
// gh --include interleaves headers with JSON (including inside --slurp's
// outer array). Recognize header blocks only outside JSON string literals.
export function githubOutput(text:string){let json='',protocol='',quoted=false,escaped=false;
 for(let i=0;i<text.length;){
 if(!quoted&&text.startsWith('HTTP/',i)&&/^HTTP\/[\d.]+[ \t]+\d{3}\b/.test(text.slice(i))){const end=text.slice(i).search(/\r?\n\r?\n/);if(end<0)throw malformed('github','response-headers');const match=text.slice(i+end).match(/^\r?\n\r?\n/)![0];protocol=text.slice(i,i+end)+match;i+=end+match.length;continue;}
 const ch=text[i++];json+=ch;if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;
 }
 return {json,protocol};
}
// Never persist arbitrary stderr, response bodies, URLs, commands or causes.
// Only recognized protocol facts survive this boundary.
export function readFailure(provider:ReadEvidence['provider'],operation:string,raw:string,exitStatus?:number,cause?:unknown,now=Date.now(),response='',retryPolicy:'bounded'|'preserve'='bounded'){
 // stdout may contain arbitrary PR/comment bodies. Only its initial HTTP status
 // line is protocol evidence; stderr also supports gh's trailing (HTTP NNN).
 const httpStatus=Number(response.match(/^HTTP\/[\d.]+[ \t]+([45]\d\d)\b/i)?.[1]??raw.match(/^HTTP(?:\/[\d.]+)?[ \t]+([45]\d\d)\b/im)?.[1]??raw.match(/\(HTTP ([45]\d\d)\)[ \t]*$/im)?.[1])||undefined;
 const headers=(text:string)=>/^HTTP(?:\/[\d.]+)?[ \t]+\d{3}\b/.test(text)?text.split(/\r?\n\r?\n/,1)[0]:'';
 const protocol=`${headers(raw)}\n${headers(response)}`;
 let messages:string[]=[];
 try{const body=response.replace(/^HTTP\/[\d.]+[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n/,'');const parsed=JSON.parse(body);if(typeof parsed.message==='string')messages.push(parsed.message);if(Array.isArray(parsed.errors))messages.push(...parsed.errors.map((e:any)=>e?.type==='RATE_LIMITED'?'rate limit exceeded':typeof e?.message==='string'?e.message:''));}catch{}
 // Error fields are provider-owned; GraphQL data (including comments) is not.
 const rateEvidence=[...messages,...raw.split(/\r?\n/).filter(line=>/^(?:gh: |HTTP(?:\/[\d.]+)?[ \t]+\d{3}\b)/.test(line))].join('\n');
 const stoppedDaemon=provider==='orchestrator'&&/^AO daemon is not running(?: — start it with `ao start`| \(stale run-file at [^\r\n]+\) — start it with `ao start`)\r?$/m.test(raw);
 const classification:ReadClass=httpStatus===401?'authentication':httpStatus===429||/secondary rate limit|rate limit exceeded|abuse detection/i.test(rateEvidence)?'throttled':httpStatus===403?'permission':httpStatus===404?'missing':httpStatus&&httpStatus>=500?'server':httpStatus?'unknown':/timed? ?out|timeout|ETIMEDOUT/i.test(raw)?'timeout':stoppedDaemon||/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network is unreachable|could not resolve|connection reset|error connecting/i.test(raw)?'network':'unknown';
 const retry=protocol.match(/^retry-after:[ \t]*(\d+)[ \t]*\r?$/im),reset=protocol.match(/^x-ratelimit-reset:[ \t]*(\d+)[ \t]*\r?$/im);
 const requestId=protocol.match(/^x-github-request-id:[ \t]*([A-F0-9: -]{1,100})\r?$/im)?.[1]?.trim();
 const remaining=protocol.match(/^x-ratelimit-remaining:[ \t]*(\d+)[ \t]*\r?$/im);
 const hints=[...(retry?[now+Number(retry[1])*1000]:[]),...(reset&&remaining&&Number(remaining[1])===0?[Number(reset[1])*1000]:[])];
 const hint=Math.max(0,...hints.filter(validReadTime));
 // Read-health probes remain bounded; a mutation retry must never shorten a
 // provider reset. Invalid/unrepresentable request hints require inspection.
 const invalid=retryPolicy==='preserve'&&(hints.some(v=>!validReadTime(v))||/^retry-after:/im.test(protocol)&&!retry||remaining&&Number(remaining[1])===0&&/^x-ratelimit-reset:/im.test(protocol)&&!reset);
 const retryAt=invalid?undefined:retryPolicy==='preserve'?(hint>now?hint:undefined):boundedRetryAt(hint,now);
 return new ProviderReadError({provider,operation:/^[a-z-]{1,64}$/.test(operation)?operation:'read',timestamp:now,classification,exitStatus,httpStatus,...(retryAt!==undefined?{retryAt}:{}),...(invalid?{retryAtUnrepresentable:true as const}:{}),...(requestId?{requestId}:{}),detail:`${classification}${httpStatus?` (HTTP ${httpStatus})`:''}; raw diagnostic omitted`},{cause});
}
// Only typed provider evidence may drive automatic recovery; an untyped error
// keeps its cause in memory but never classifies itself from its message.
export function providerEvidence(error:unknown):ReadEvidence|undefined{
 let e:any=error;for(let n=0;e&&n<8;n++,e=e.cause)if(e instanceof ProviderReadError)return e.evidence;
 return undefined;
}
export function readEvidence(error:unknown,provider:ReadEvidence['provider']='github',operation='observation'):ReadEvidence{
 return providerEvidence(error)??readFailure(provider,operation,'').evidence;
}
export function malformed(provider:ReadEvidence['provider'],operation:string,cause?:unknown){return new ProviderReadError({provider,operation,timestamp:Date.now(),classification:'malformed',detail:'Invalid or incomplete evidence; payload omitted'},{cause});}
export async function githubRead(args:string[],operation='branch-read',spawn=Bun.spawn){
 try{
 const include=args[0]==='api';
 const p=spawn(['gh',...args,...(include?['--include']:[])],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 let parsed:ReturnType<typeof githubOutput>;
 try{parsed=githubOutput(out);}catch(cause){if(code!==0)throw readFailure('github',operation,p.signalCode==='SIGTERM'?'timeout':err,code,cause);throw cause;}
 if(code!==0)throw readFailure('github',operation,p.signalCode==='SIGTERM'?'timeout':err,code,undefined,Date.now(),parsed.protocol+parsed.json);
 try{return JSON.parse(parsed.json);}catch(cause){throw malformed('github',operation,cause);}
 }catch(cause){if(cause instanceof ProviderReadError)throw cause;throw readFailure('github',operation,'',undefined,cause);}
}

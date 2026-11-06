export type ReadClass='authentication'|'permission'|'throttled'|'timeout'|'network'|'server'|'missing'|'malformed'|'unknown';
export type ReadEvidence={provider:'github'|'orchestrator';operation:string;timestamp:number;classification:ReadClass;exitStatus?:number;httpStatus?:number;retryAt?:number;requestId?:string;detail:string};
export class ProviderReadError extends Error{
 constructor(public evidence:ReadEvidence,options?:ErrorOptions){super(`${evidence.provider} ${evidence.operation}: ${evidence.classification}`,options);}
}
// Never persist arbitrary stderr, response bodies, URLs, commands or causes.
// Only recognized protocol facts survive this boundary.
export function readFailure(provider:ReadEvidence['provider'],operation:string,raw:string,exitStatus?:number,cause?:unknown,now=Date.now()){
 const httpStatus=Number(raw.match(/(?:HTTP[\/\d. ]*|status[=: ]+)([45]\d\d)\b/i)?.[1])||undefined;
 const classification:ReadClass=httpStatus===401?'authentication':httpStatus===429||/secondary rate limit|rate limit exceeded|abuse detection/i.test(raw)?'throttled':httpStatus===403?'permission':httpStatus===404?'missing':httpStatus&&httpStatus>=500?'server':/timed? ?out|timeout|ETIMEDOUT/i.test(raw)?'timeout':/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network is unreachable|could not resolve|connection reset|error connecting/i.test(raw)?'network':'unknown';
 const retry=raw.match(/retry-after:\s*(\d+)\s*(?:\r?\n|$)/i),reset=raw.match(/x-ratelimit-reset:\s*(\d+)/i);
 const requestId=raw.match(/x-github-request-id:\s*([A-F0-9: -]{1,100})(?:\r?\n|$)/i)?.[1]?.trim();
 const hint=Math.max(retry?now+Number(retry[1])*1000:0,reset?Number(reset[1])*1000:0);
 return new ProviderReadError({provider,operation:/^[a-z-]{1,64}$/.test(operation)?operation:'read',timestamp:now,classification,exitStatus,httpStatus,...(Number.isSafeInteger(hint)&&hint>now?{retryAt:hint}:{}),...(requestId?{requestId}:{}),detail:`${classification}${httpStatus?` (HTTP ${httpStatus})`:''}; raw diagnostic omitted`},{cause});
}
export function readEvidence(error:unknown,provider:ReadEvidence['provider']='github',operation='observation'):ReadEvidence{
 let e:any=error;for(let n=0;e&&n<8;n++,e=e.cause)if(e instanceof ProviderReadError)return e.evidence;
 return readFailure(provider,operation,error instanceof Error?error.message:'').evidence;
}
export function malformed(provider:ReadEvidence['provider'],operation:string,cause?:unknown){return new ProviderReadError({provider,operation,timestamp:Date.now(),classification:'malformed',detail:'Invalid or incomplete evidence; payload omitted'},{cause});}
export async function githubRead(args:string[],operation='branch-read',spawn=Bun.spawn){
 try{
 const include=operation==='branch-read'&&args[0]==='api'&&!args.includes('--paginate');
 const p=spawn(['gh',...args,...(include?['--include']:[])],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
 if(code!==0)throw readFailure('github',operation,p.signalCode?'timeout':`${err}\n${out}`,code);
 const body=include&&/^HTTP\//.test(out)?out.replace(/^HTTP\/[^\r\n]+\r?\n[\s\S]*?\r?\n\r?\n/,''):out;
 try{return JSON.parse(body);}catch(cause){throw malformed('github',operation,cause);}
 }catch(cause){if(cause instanceof ProviderReadError)throw cause;throw readFailure('github',operation,cause instanceof Error?cause.message:'',undefined,cause);}
}

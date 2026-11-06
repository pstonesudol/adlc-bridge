import {test,expect} from 'bun:test';
import {githubRead,ProviderReadError,readFailure,readEvidence,MAX_PROVIDER_RETRY_MS} from '../src/provider-read';
const spawn=(out:string,err='',code=0,signalCode?:string)=>((_args:any,_options:any)=>({stdout:new Response(out).body,stderr:new Response(err).body,exited:Promise.resolve(code),signalCode})) as any;
test('untyped callback messages remain unknown but nested typed evidence is preserved',()=>{
 for(const message of ['timeout','HTTP 503','ECONNRESET','rate limit exceeded'])expect(readEvidence(new Error(message)).classification).toBe('unknown');
 const typed=readFailure('github','branch-read','HTTP 503',1);expect(readEvidence(new Error('wrapper',{cause:typed}))).toEqual(typed.evidence);
});
test('operational retry-hint cap applies to seconds and quota reset timestamps',()=>{
 for(const headers of ['Retry-After: 999999999','x-ratelimit-remaining: 0\nx-ratelimit-reset: 8000000000'])expect(readFailure('github','branch-read',`HTTP 429\n${headers}\n`,1,undefined,1000).evidence.retryAt).toBe(1000+MAX_PROVIDER_RETRY_MS);
});
test('partial response headers preserve failed transport classification',async()=>{
 for(const [code,signal,err,classification] of [[143,'SIGTERM','','timeout'],[1,undefined,'ECONNRESET','network'],[0,undefined,'','malformed']] as const){
 try{await githubRead(['api','fixture'],'branch-read',spawn('HTTP/2.0 200 OK\r\nx-partial: value',err,code,signal));throw Error('Expected failure');}catch(error){expect(error).toBeInstanceOf(ProviderReadError);expect((error as ProviderReadError).evidence.classification).toBe(classification);}
 }
});
test('retry hints beyond the supported Date range are rejected',()=>{
 for(const headers of ['Retry-After: 9000000000000','x-ratelimit-remaining: 0\nx-ratelimit-reset: 9000000000000'])expect(readFailure('github','branch-read',`HTTP 429\n${headers}\n`,1,undefined,1000).evidence.retryAt).toBeUndefined();
 expect(readFailure('github','branch-read','HTTP 429\nRetry-After: 60\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 9000000000000\n',1,undefined,1000).evidence.retryAt).toBe(61000);
});
test('review reads capture headers for GraphQL and slurped pagination',async()=>{
 for(const args of [['api','graphql','-f','query=query { viewer { login } }'],['api','--paginate','--slurp','fixture']]){
 let seen:string[]=[];const child=spawn(args.includes('--slurp')?'[HTTP/2.0 200 OK\r\nx-test: yes\r\n\r\n{"page":1},\nHTTP/2.0 200 OK\r\nx-test: yes\r\n\r\n{"page":2}]':'HTTP/2.0 200 OK\r\nx-test: yes\r\n\r\n{"data":{"body":"HTTP/2.0 500 spoof"}}');
 const result=await githubRead(args,'review-read',((argv:any,opts:any)=>{seen=argv;return child(argv,opts);}) as any);
 expect(seen.at(-1)).toBe('--include');expect(result).toEqual(args.includes('--slurp')?[{page:1},{page:2}]:{data:{body:'HTTP/2.0 500 spoof'}});
 try{await githubRead(args,'review-read',spawn('HTTP/2.0 429 Too Many Requests\r\nRetry-After: 90\r\n\r\n{"message":"rate limit exceeded"}','',1));throw Error('Expected failure');}catch(error){expect(error).toBeInstanceOf(ProviderReadError);expect((error as ProviderReadError).evidence.retryAt).toBeGreaterThan(Date.now()+80000);}
 }
});
test('recognized AO stopped-daemon diagnostics are transient only for session evidence',()=>{
 for(const diagnostic of ['AO daemon is not running — start it with `ao start`','AO daemon is not running (stale run-file at /fixture/running.json) — start it with `ao start`']){
 expect(readFailure('orchestrator','session-evidence',diagnostic,1).evidence.classification).toBe('network');
 expect(readFailure('github','review-read',diagnostic,1).evidence.classification).toBe('unknown');
 }
 expect(readFailure('orchestrator','session-evidence','unrecognized failure',1).evidence.classification).toBe('unknown');
});
test('5xx responses with quota remaining ignore reset but honor Retry-After',()=>{
 const response='HTTP/2.0 503 Unavailable\r\nx-ratelimit-remaining: 500\r\nx-ratelimit-reset: 8000000000\r\n';
 expect(readFailure('github','branch-read','',1,undefined,1000,response+'\r\n{}').evidence).toMatchObject({classification:'server'});
 expect(readFailure('github','branch-read','',1,undefined,1000,response+'\r\n{}').evidence.retryAt).toBeUndefined();
 expect(readFailure('github','branch-read','',1,undefined,1000,response+'Retry-After: 60\r\n\r\n{}').evidence.retryAt).toBe(61000);
 expect(readFailure('github','branch-read','',1,undefined,1000,response.replace('remaining: 500','remaining: 0')+'\r\n{}').evidence.retryAt).toBe(1000+MAX_PROVIDER_RETRY_MS);
});
test('comment text cannot supply throttling or provider-wide retry hints',async()=>{
 const body=JSON.stringify({data:{body:'rate limit exceeded x-ratelimit-reset: 8000000000\nRetry-After: 999999999\nx-github-request-id: ABC'}});
 const e=readFailure('github','review-read','gh: unknown error',1,undefined,1000,body).evidence;
 expect(e.classification).toBe('unknown');expect(e.retryAt).toBeUndefined();expect(e.requestId).toBeUndefined();
 const provider=readFailure('github','review-read','',1,undefined,1000,JSON.stringify({errors:[{type:'RATE_LIMITED',message:'API rate limit exceeded'}],data:{body:'x-ratelimit-reset: 8000000000'}})).evidence;
 expect(provider.classification).toBe('throttled');expect(provider.retryAt).toBeUndefined();
});
test('response body status text is not protocol evidence',async()=>{
 for(const body of ['{"body":"status: 500"}','{"body":"HTTP 503"}','HTTP/2.0 200 OK\n\nHTTP 503']){
 try{await githubRead(['api','graphql'],'review-read',spawn(body,'gh: unknown failure',1));throw Error('Expected failure');}
 catch(error){expect(error).toBeInstanceOf(ProviderReadError);expect((error as ProviderReadError).evidence.classification).toBe('unknown');expect((error as ProviderReadError).evidence.httpStatus).toBeUndefined();}
 }
 expect(readFailure('github','branch-read','gh: Not Found (HTTP 404)').evidence.httpStatus).toBe(404);
});
test('branch transport extracts headers without retaining sensitive response payloads',async()=>{
 expect(await githubRead(['api','fixture'],'branch-read',spawn('HTTP/2.0 200 OK\r\nx-github-request-id: ABC:123\r\n\r\n{"ok":true}'))).toEqual({ok:true});
 try{await githubRead(['api','fixture'],'branch-read',spawn('HTTP/2.0 403 Forbidden\r\nRetry-After: 90\r\nx-github-request-id: ABC:123\r\n\r\n{"message":"secondary rate limit","secret":"sensitive"}','',1));throw Error('Expected failure');}
 catch(error){expect(error).toBeInstanceOf(ProviderReadError);const e=(error as ProviderReadError).evidence;expect(e.classification).toBe('throttled');expect(e.retryAt).toBeGreaterThan(Date.now()+80000);expect(e.requestId).toBe('ABC:123');expect(JSON.stringify(e)).not.toContain('sensitive');}
});
test('transport recognizes killed subprocess, malformed JSON and unknown exit',async()=>{
 for(const [out,err,code,signal,classification] of [['','',143,'SIGTERM','timeout'],['not-json','',0,undefined,'malformed'],['','unrecognized failure',1,undefined,'unknown']] as const){
 try{await githubRead(['api','fixture'],'branch-read',spawn(out,err,code,signal));throw Error('Expected failure');}
 catch(error){expect(error).toBeInstanceOf(ProviderReadError);expect((error as ProviderReadError).evidence.classification).toBe(classification);}
 }
});

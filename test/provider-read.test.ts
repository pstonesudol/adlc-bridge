import {test,expect} from 'bun:test';
import {githubRead,ProviderReadError,readFailure} from '../src/provider-read';
const spawn=(out:string,err='',code=0,signalCode?:string)=>((_args:any,_options:any)=>({stdout:new Response(out).body,stderr:new Response(err).body,exited:Promise.resolve(code),signalCode})) as any;
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

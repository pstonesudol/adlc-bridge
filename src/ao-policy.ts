import {trustedDaemon} from './daemon-runtime';
import {AO} from './orchestrator';

// Only disables native delivery; no generic mutating Orchestrator endpoint.
export async function disableNativeFeedback(session:string,spawn=Bun.spawn){
 if(!/^[\w-]+$/.test(session))throw Error('Invalid session');
 const probe=spawn([AO,'status','--json'],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const text=await new Response(probe.stdout).text();await new Response(probe.stderr).text();
 if(await probe.exited!==0)throw Error('Local daemon status probe failed');
 const run=JSON.parse(text);
 const port=run.port;
 if(run.state!=='ready'||!Number.isSafeInteger(port)||port<1||port>65535||!trustedDaemon(run.executablePath))throw Error('Unverified local daemon');
 for(const [suffix,field] of [['auto-inject-ci','autoInjectCI'],['auto-inject-review','autoInjectReview']]){
  const r=await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${session}/${suffix}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({[field]:false}),signal:AbortSignal.timeout(10000)});
  const b:any=await r.json();if(!r.ok||b[field]!==false)throw Error('Could not verify native feedback disabled');
 }
 return {session,nativeFeedbackEnabled:false,mergeEnabled:false};
}

import {localAO} from './workflow-transport';
import {configureSessionRoute,preflightRoute} from './routing-session';
import {disableNativeFeedback} from './ao-policy';
import {sessionEvidence} from './session-evidence';
import {AO} from './orchestrator';
import type {FeatureAgents} from './feature-planning';
import {withTurnSubmission} from './turn-submission';
import {PreSendFailure} from './pre-send';
export function createFeatureAgents(submit=withTurnSubmission,spawn=Bun.spawn,api=localAO,preflight=preflightRoute,disable=disableNativeFeedback):FeatureAgents{return {
 submit,
 async start(r){return submit(async()=>{
  try{await preflight(r.route,api);}catch{throw new PreSendFailure('Feature preflight failed before session creation');}
  const b=await api('sessions','POST',{kind:'worker',harness:r.route.harness,mode:'chat',approvalMode:'accept-edits',model:r.route.model,displayName:r.name,clientRequestId:r.key},r.beforeSend);
  try{if(!b.session?.id||b.session.projectId)throw Error('Standalone planning receipt required');await disable(b.session.id);return {id:b.session.id};}
  catch(e){if(e instanceof PreSendFailure)throw Error('Feature session setup outcome uncertain',{cause:e});throw e;}
 });},
 async find(name){const b=await localAO('sessions?active=true');if(!Array.isArray(b.sessions)||b.nextCursor)throw Error('Incomplete feature session inventory');return b.sessions.filter((s:any)=>s.displayName===name&&!s.projectId&&!s.isTerminated);},
 evidence:sessionEvidence,
 configure:configureSessionRoute,
 async send(session,prompt,key){return submit(async()=>{const p=spawn([AO,'send','--session',session,'--steer','--client-message-id',key,'--message',prompt],{stdout:'pipe',stderr:'pipe',timeout:30000});await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);if(await p.exited!==0)throw Error('Feature prompt delivery uncertain');});},
 async stop(session){const p=Bun.spawn([AO,'session','exit-agent',session],{stdout:'pipe',stderr:'pipe',timeout:30000});await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);if(await p.exited!==0)throw Error('Could not stop feature agent');}
};}
export const featureAgents=createFeatureAgents();

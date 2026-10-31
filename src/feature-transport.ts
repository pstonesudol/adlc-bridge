import {localAO} from './workflow-transport';
import {configureSessionRoute,preflightRoute} from './routing-session';
import {disableNativeFeedback} from './ao-policy';
import {sessionEvidence} from './session-evidence';
import {AO} from './orchestrator';
import type {FeatureAgents} from './feature-planning';
export const featureAgents:FeatureAgents={
 async start(r){await preflightRoute(r.route);const b=await localAO('sessions','POST',{kind:'worker',harness:r.route.harness,mode:'chat',approvalMode:'accept-edits',model:r.route.model,displayName:r.name,clientRequestId:r.key});if(!b.session?.id||b.session.projectId)throw Error('Standalone planning receipt required');await disableNativeFeedback(b.session.id);return {id:b.session.id};},
 async find(name){const b=await localAO('sessions?active=true');if(!Array.isArray(b.sessions)||b.nextCursor)throw Error('Incomplete feature session inventory');return b.sessions.filter((s:any)=>s.displayName===name&&!s.projectId&&!s.isTerminated);},
 evidence:sessionEvidence,
 configure:configureSessionRoute,
 async send(session,prompt,key){const p=Bun.spawn([AO,'send','--session',session,'--steer','--client-message-id',key,'--message',prompt],{stdout:'pipe',stderr:'pipe',timeout:30000});await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);if(await p.exited!==0)throw Error('Feature prompt delivery uncertain');},
 async stop(session){const p=Bun.spawn([AO,'session','exit-agent',session],{stdout:'pipe',stderr:'pipe',timeout:30000});await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);if(await p.exited!==0)throw Error('Could not stop feature agent');}
};

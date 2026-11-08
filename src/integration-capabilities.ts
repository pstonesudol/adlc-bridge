import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {linearAPI,type LinearAPI} from './linear-api';

export const integrationNames=['blockerPublication','clarificationPublication','clarificationReplies'] as const;
export type IntegrationName=typeof integrationNames[number];
export type IntegrationPolicy={required?:IntegrationName[]};
type Check=boolean|'unknown';
export type IntegrationEvidence={identity?:Check;label?:Check;humans?:Check;reachable?:Check;publicationPermission?:Check;replyPermission?:Check};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
export function validateIntegrationPolicy(c:any){
 const p=c.integrationPolicy;if(p===undefined)return;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>k!=='required')||p.required!==undefined&&(!Array.isArray(p.required)||p.required.some((v:any)=>!integrationNames.includes(v))||new Set(p.required).size!==p.required.length))throw Error('integrationPolicy.required must list unique supported integration capabilities');
}
/** Read source files, never import or execute an installed/candidate snapshot. */
export function integrationRuntime(source=resolve(import.meta.dir,'..'),installed?:string){
 const files=['src/integration-capabilities.ts','src/linear-blockers.ts','src/linear-clarifications.ts'];
 const signatures=(root:string)=>files.map(file=>existsSync(join(root,file))?fingerprint(readFileSync(join(root,file),'utf8')):null);
 const current=signatures(source),pin=installed?signatures(installed):undefined;
 return {implemented:current.every(Boolean),installed:pin?pin.every(Boolean):'unknown' as Check,mismatch:pin?JSON.stringify(current)!==JSON.stringify(pin):'unknown' as Check,sourceFingerprint:fingerprint(JSON.stringify(current)),installedFingerprint:pin?fingerprint(JSON.stringify(pin)):null};
}
/** No writes, credentials, local config dumps or operational claims in a preview. */
export function integrationPreview(c:any,evidence:IntegrationEvidence={},runtime=integrationRuntime()){
 validateIntegrationPolicy(c);
 const required=new Set<IntegrationName>(c.integrationPolicy?.required??[]);
 if(required.has('clarificationReplies'))required.add('clarificationPublication');
 if(required.has('clarificationPublication'))required.add('blockerPublication');
 const label=uuid.test(c.blockerSync?.labelId??'')&&c.blockerSync.labelId.toLowerCase()!==c.linear?.readyLabelId?.toLowerCase();
 const humans=Array.isArray(c.clarifications?.humanIds)&&c.clarifications.humanIds.length>0&&c.clarifications.humanIds.every((id:any)=>typeof id==='string'&&uuid.test(id));
 const publication=c.blockerSync?.enabled===true,clarifications=c.clarifications?.enabled===true;
 const matrix=integrationNames.map(name=>{
  const blocker=name==='blockerPublication',reply=name==='clarificationReplies';
  const configured=label&&(blocker||humans),enabled=publication&&(blocker||clarifications);
  const prerequisites={projectIdentity:evidence.identity??'unknown',needsHumanLabel:label?evidence.label??'unknown':false,...(!blocker?{authorizedHumans:humans?evidence.humans??'unknown':false}:{}),providerPermission:(reply?evidence.replyPermission:evidence.publicationPermission)??'unknown',runtime:runtime.implemented&&(runtime.installed!==false)&&runtime.mismatch!==true};
  const reachable=evidence.reachable??'unknown',validated=configured&&enabled&&reachable===true&&Object.values(prerequisites).every(v=>v===true);
  const unavailable=!runtime.implemented||runtime.installed===false||reachable===false;
  const action=!configured?'Configure a distinct verified blockerSync.labelId and (for clarifications) verified humanIds; preview again.':!enabled?'Explicitly review and enable blockerSync.enabled and, for clarifications, clarifications.enabled; preview again.':runtime.mismatch===true?'Review and install the matching runtime through the existing operator upgrade workflow; do not activate source implicitly.':'Run doctor CONFIG --verify-integrations for read-only identity checks. Publication permission needs a separately authorized live publication probe; read access is not write evidence. Keep required dispatch paused until validated.';
  return {name,required:required.has(name),implemented:runtime.implemented,configured,enabled,reachable,validated,unavailable,prerequisites,degraded:!validated,action:validated?null:action};
 });
 const repair=[];
 if(!c.blockerSync)repair.push({path:'blockerSync',operation:'add',value:{enabled:false,labelId:'REPLACE_WITH_DISTINCT_VERIFIED_NEEDS_HUMAN_UUID'}});
 if(!c.clarifications)repair.push({path:'clarifications',operation:'add',value:{enabled:false,humanIds:[]}});
 const enablementChanges=[...(!publication?[{path:'blockerSync.enabled',operation:'set',value:true}]:[]),...(!clarifications?[{path:'clarifications.enabled',operation:'set',value:true}]:[])];
 const configurationFingerprint=fingerprint(JSON.stringify([c.linear,c.repo,c.automation?.orchestratorProject,c.blockerSync,c.clarifications,c.integrationPolicy]));
 return {schemaVersion:1,configurationFingerprint,matrix,runtime,dispatchAllowed:matrix.every(row=>!row.required||row.validated),blockers:matrix.filter(row=>row.required&&!row.validated).map(row=>`${row.name}: ${row.action}`),repair:{mode:'preview_only',changes:repair,enablementChanges,enablementRequiresExplicitAuthorization:true,prerequisites:['Distinct verified needs-human label','Verified active authorized-human UUIDs','Verified provider permissions'],preserveExisting:true,backupRequired:true,activation:false,instructions:'Back up the original config before manually applying reviewed field changes. Preserve unknown fields and existing backups; no credentials are copied. Enabling publication/replies requires a separate explicit operator decision.'},limitations:['No live publication probe was performed. Reachable is not permission or operational validation. Unavailable and unknown evidence remain distinct.']};
}
/** Bounded read-only inventories. Provider errors are redacted, never printed. */
export async function verifyIntegrations(c:any,api:LinearAPI=linearAPI):Promise<IntegrationEvidence>{
 try{
  const b=await api('query($project:String!,$team:String!){project(id:$project){id teams(first:100){nodes{id}pageInfo{hasNextPage}}}team(id:$team){id labels(first:100){nodes{id}pageInfo{hasNextPage}}}}',{project:c.linear?.projectId,team:c.linear?.teamId});
  const identity=b.project?.id===c.linear?.projectId&&b.team?.id===c.linear?.teamId&&b.project?.teams?.pageInfo?.hasNextPage===false&&b.project.teams.nodes.some((t:any)=>t.id===c.linear.teamId);
  const label=identity&&b.team?.labels?.pageInfo?.hasNextPage===false&&b.team.labels.nodes.some((l:any)=>l.id===c.blockerSync?.labelId)&&c.blockerSync?.labelId?.toLowerCase()!==c.linear?.readyLabelId?.toLowerCase();
  const ids=c.clarifications?.humanIds;let humans=false;
  if(Array.isArray(ids)&&ids.length>0&&ids.length<=100&&ids.every(id=>typeof id==='string'&&uuid.test(id))){
   humans=true;for(const id of new Set<string>(ids)){
    const u=await api('query($id:String!){user(id:$id){id active app}}',{id});
    if(u.user?.id!==id||u.user.active!==true||u.user.app!==false)humans=false;
   }
  }
  return {reachable:true,identity,label,humans,replyPermission:identity&&humans?'unknown':false,publicationPermission:'unknown'};
 }catch{return {reachable:false,identity:'unknown',label:'unknown',humans:'unknown',publicationPermission:'unknown',replyPermission:'unknown'};}
}
export function assertRequiredIntegrations(c:any,report=integrationPreview(c)){
 if(!report.dispatchAllowed)throw Error(`Required integrations unavailable; dispatch paused: ${report.blockers.join('; ')}`);
}

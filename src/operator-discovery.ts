import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {Store} from './core';
import {ProjectServices,registryPath,type ProjectService} from './project-services';
import {OperatorError,jobViews} from './operator-cli';
import {effectiveSettings} from './project-settings';
import {linearAPI,type LinearAPI,issueFields} from './linear-api';
import {tokenPath} from './credential';
import {installedCLI} from './install-state';

export function projectEntries(path=registryPath()):ProjectService[]{
 if(!existsSync(path))return [];
 const s=Store.readonly(path);try{return new ProjectServices(s,false).list();}finally{s.close();}
}
export function selectProject(entries:ProjectService[],id?:string){
 const matches=id?entries.filter(p=>p.project===id||p.linear_project===id):entries;
 if(matches.length===0)throw new OperatorError('No registered project matches; use projects list.',3);
 if(matches.length!==1)throw new OperatorError('Select --project PROJECT; multiple projects match.',4,matches.map(p=>({project:p.project,name:p.name})));
 return matches[0];
}
export function projectConfig(entry:ProjectService){
 // Existing identity verification is reused without initializing or migrating the registry.
 const c=JSON.parse(readFileSync(entry.config,'utf8'));
 if(c.automation?.orchestratorProject!==entry.project||c.linear?.projectId!==entry.linear_project||realpathSync(c.repo)!==entry.repo)throw new OperatorError('Registered project identity differs from configuration; use explicit migration workflow.',1);
 return c;
}
export function authStatus(c:any,env=process.env,configuredFile=existsSync(tokenPath)){
 return {providers:[{provider:'linear',state:env.ADLC_LINEAR_TOKEN||configuredFile?'unverified':'missing',nextAction:'Use auth-linear for explicit credential entry; status does not verify token validity.'},{provider:'github',state:'unverified',nextAction:'Use gh auth status explicitly; no login refresh is performed.'},{provider:'worker',harness:['opencode-v2','codex','claude'].includes(c.routing?.harness)?c.routing.harness:null,state:'unverified',nextAction:'Inspect authentication using the configured harness; no paid model probe is performed.'}],secretsRead:false,probePerformed:false};
}
export async function queueView(c:any,path:string,api:LinearAPI=linearAPI,now=Date.now()){
 const jobs=jobViews(path,c.linear.projectId),capacity=effectiveSettings(c).maxPlanning;
 let occupancy=0;const reservations:any[]=[];
 if(existsSync(path)){const s=Store.readonly(path);try{
  if(s.db.query("SELECT name FROM sqlite_master WHERE name='planning_dispatch'").get()){
   const rows=s.db.query("SELECT d.job,d.state,d.session_id,j.state AS job_state FROM planning_dispatch d JOIN jobs j ON j.id=d.job WHERE j.project=?").all(c.linear.projectId) as any[];
   for(const d of rows){reservations.push(d);if(['dispatch_uncertain','needs_reconciliation'].includes(d.state)||!['awaiting_approval','planning_finished'].includes(d.state)&&!['awaiting_approval','approved','done'].includes(d.job_state))occupancy++;}
  }
 }finally{s.close();}}
 const base={planning:{capacity,occupancy,scope:'concurrent-planning-only'},jobs,reservations};
 const issues:any[]=[];let after:string|null=null;const seen=new Set<string>(),ids=new Set<string>(),started=Date.now();
 try{
  do{
   const b=await api(`query($project:ID!,$team:ID!,$state:ID!,$label:ID!,$after:String){issues(first:50,after:$after,filter:{project:{id:{eq:$project}},team:{id:{eq:$team}},state:{id:{eq:$state}},labels:{some:{id:{eq:$label}}}}){nodes{${issueFields}}pageInfo{hasNextPage endCursor}}}`,{project:c.linear.projectId,team:c.linear.teamId,state:c.linear.readyStateId,label:c.linear.readyLabelId,after});
   const page=b?.issues;if(!Array.isArray(page?.nodes)||typeof page.pageInfo?.hasNextPage!=='boolean')throw Error('Incomplete snapshot');
   for(const i of page.nodes){if(typeof i.id!=='string'||ids.has(i.id)||typeof i.identifier!=='string'||i.project?.id!==c.linear.projectId||i.team?.id!==c.linear.teamId||i.state?.id!==c.linear.readyStateId||i.labels?.pageInfo?.hasNextPage!==false||!i.labels.nodes.some((l:any)=>l.id===c.linear.readyLabelId))throw Error('Incomplete scoped evidence');ids.add(i.id);issues.push({issue:i.id,ticket:i.identifier});}
   if(Date.now()-started>120000)throw Error('Snapshot expired');
   if(!page.pageInfo.hasNextPage)break;
   after=page.pageInfo.endCursor;if(!after||seen.has(after)||seen.size>=100)throw Error('Incomplete pagination');seen.add(after);
  }while(true);
  // Provider eligibility is distinct from authoritative dependency/approval admission.
  return {...base,provider:{state:'available',complete:true,observedAt:now,freshness:'fresh'},tickets:issues.map(i=>{const job=jobs.find(j=>j.issue===i.issue);return {...i,job:job?.job??null,intakeEligible:true,admission:'unknown',reason:job?`Existing job: ${job.state}; inspect its retained waits before admission.`:occupancy>=capacity?'Planning capacity occupied; not a cap on implementation workers.':'Provider eligible; dependency and approval admission evidence has not been refreshed. No dispatch authorized.',nextAction:'Inspect jobs show or existing dependency/approval previews.'};})};
 }catch{return {...base,provider:{state:issues.length?'incomplete':'unavailable',complete:false,observedAt:null,freshness:'unknown'},tickets:issues.map(i=>({...i,intakeEligible:null,admission:'unknown',reason:'Incomplete provider evidence; cannot establish admission.'})),nextAction:'Check auth status and retry queue list; no eligibility or status changes were made.'};}
}
export function versionView(){
 const source=JSON.parse(readFileSync(join(import.meta.dir,'../package.json'),'utf8')).version;
 let snapshot:unknown=null;try{const cli=installedCLI();if(cli)snapshot={version:JSON.parse(readFileSync(join(dirname(cli),'../package.json'),'utf8')).version};}catch{snapshot={state:'unverified'};}
 return {source:{version:source},installed:snapshot??{state:'not-installed'},runningBackend:{state:'unknown',reason:'No authoritative running-version evidence collected; source and installed versions do not prove activation.'}};
}
export function completion(shell:string,words:string[]){
 if(shell==='bash')return `complete -W '${words.join(' ')}' adlc`;
 if(shell==='zsh')return `#compdef adlc\n_arguments '*:command:(${words.join(' ')})'`;
 if(shell==='fish')return words.map(w=>`complete -c adlc -f -a '${w}'`).join('\n');
 throw new OperatorError('Supported completion shells: bash, zsh, fish. Output only; shell files are never modified.');
}

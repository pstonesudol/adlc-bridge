import {ApprovalPolicyStore,type ApprovalPolicy} from './approval-policy';
import {randomUUID} from 'node:crypto';
import {validScopes} from './file-scope';
import { Store,digest } from './core';
import {remediationPolicy,type RemediationConfig} from './remediation';
import {validateConflictPolicy,type ConflictPolicy} from './conflict-policy';
import {validateClarifications} from './linear-clarifications';
import {validateVerification,type Verification} from './verification';
import {effectiveSettings} from './project-settings';
import {validateDependencies,type DependencyPolicy} from './dependency-policy';
import {validateIntegrationPolicy,type IntegrationPolicy} from './integration-capabilities';
import {reviewerPolicy,type ReviewerConfig} from './reviewer-policy';

export type ProjectConfig = {
  version: 1; name: string; repo: string;
  requiredChecks:string[];
  approval?:ApprovalPolicy;
  reviewers?:ReviewerConfig[];
  verification?:Verification;
  pollingIntervalSeconds?:number;
  automation?:{planningEnabled?:boolean;orchestratorProject?:string;maxPlanning?:number};
  linear: { projectId: string; teamId: string; readyStateId: string; readyLabelId: string };
  statusSync?:{enabled:boolean;inProgress:string;inReview:string;done:string};
  prMetadataChecks?:string[];
  branchUpdate?:{enabled:boolean;authorizedBy:string;maxUpdates:number|null};
  conflictRecovery?:ConflictPolicy;
  dependencyRecovery?:DependencyPolicy;
  planApproval?:{enabled:boolean;approverIds:string[];scope:string[]};
  blockerSync?:{enabled:boolean;labelId?:string};
  clarifications?:{enabled:boolean;humanIds:string[]};
  integrationPolicy?:IntegrationPolicy;
  workflow?:{prGraceMs?:number};
  featurePlanning?:{enabled:boolean;backlogStateId:string;maxAgents?:number;maxTickets?:number};
  remediation?:RemediationConfig;
};
export function requiredCheckNames(value:unknown):string[]{
  if(!Array.isArray(value)||!value.length||value.some(n=>typeof n!=='string'||!n.trim()))throw Error('Non-empty requiredChecks with nonblank check names required');
  return value;
}
export function metadataCheckNames(value:unknown):string[]{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>10||value.some(n=>typeof n!=='string'||!n.trim()))throw Error('Explicit PR metadata check names required');
  return value;
}
export function validate(c: any): asserts c is ProjectConfig {
  if(c?.verification!==undefined)validateVerification(c.verification);
  effectiveSettings(c??{});
  reviewerPolicy(c?.reviewers);
  validateIntegrationPolicy(c);
  if (c?.version !== 1 || typeof c.name !== 'string' || !c.name.trim() || typeof c.repo !== 'string' || !c.repo.startsWith('/')) throw Error('Invalid project configuration');
  requiredCheckNames(c.requiredChecks);
  validateClarifications(c);
  metadataCheckNames(c.prMetadataChecks);
   validateConflictPolicy(c.conflictRecovery);
   validateDependencies(c);
  if(c.branchUpdate?.enabled&&(!c.branchUpdate.authorizedBy?.trim()||c.branchUpdate.maxUpdates!==null&&(!Number.isSafeInteger(c.branchUpdate.maxUpdates)||c.branchUpdate.maxUpdates<1||c.branchUpdate.maxUpdates>10)))throw Error('Explicit branch update authorization and limit required');
  if(c.planApproval?.enabled&&(!Array.isArray(c.planApproval.approverIds)||!c.planApproval.approverIds.length||c.planApproval.approverIds.some((id:any)=>typeof id!=='string'||!/^[-a-f0-9]{36}$/i.test(id))||!validScopes(c.planApproval.scope)))throw Error('Explicit plan approver UUIDs and safe scope required');
  if(c.blockerSync!==undefined&&(c.blockerSync===null||typeof c.blockerSync!=='object'||typeof c.blockerSync.enabled!=='boolean'))throw Error('blockerSync.enabled must be a boolean');
  if(c.blockerSync?.enabled===true&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.blockerSync.labelId??''))throw Error('Verified blocker label UUID required');
  if(c.blockerSync?.enabled===true&&c.blockerSync.labelId?.toLowerCase()===c.linear.readyLabelId?.toLowerCase())throw Error('Blocker label must differ from the queue label');
  if(c.workflow?.prGraceMs!==undefined&&(!Number.isSafeInteger(c.workflow.prGraceMs)||c.workflow.prGraceMs<0||c.workflow.prGraceMs>86400000))throw Error('prGraceMs must be an integer from 0 to 86400000');
  if(c.statusSync?.enabled)for(const key of ['inProgress','inReview','done'])if(!/^[0-9a-f-]{36}$/i.test(c.statusSync[key]??''))throw Error('Verified status-sync UUIDs required');
  remediationPolicy(c.remediation);
  for (const key of ['projectId', 'teamId', 'readyStateId', 'readyLabelId']) {
    if (!/^[0-9a-f-]{36}$/i.test(c.linear?.[key] ?? '')) throw Error(`Verified Linear ${key} UUID required`);
  }
}
export async function poll(c: ProjectConfig, store: Store, token: string,send=fetch) {
  validate(c);
  if (!token) throw Error('ADLC_LINEAR_TOKEN required; existing application credentials are never copied');
  const policyStore=new ApprovalPolicyStore(store),pollToken=randomUUID(),observed=Date.now();
  store.db.query('INSERT INTO queue_poll_heads VALUES (?,?) ON CONFLICT(project) DO UPDATE SET token=excluded.token').run(c.linear.projectId,pollToken);
  let after: string | null = null;
  let count = 0;
  const seen = new Set<string>();
  const eligible = new Set<string>();
  const manual = new Set<string>();
  const candidates:any[]=[];
  do {
    const response = await send('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ query: `query($project: ID!, $team: ID!, $state: ID!, $label: ID!, $after: String) {
        issues(first: 50, after: $after, filter: { project: {id: {eq: $project}}, team: {id: {eq: $team}}, state: {id: {eq: $state}}, labels: {some: {id: {eq: $label}}} }) {
          nodes { id identifier title description project { id } team { id } state { id } labels(first: 100) {nodes {id name} pageInfo {hasNextPage}} }
          pageInfo { hasNextPage endCursor }
        }
      }`, variables: { project: c.linear.projectId, team: c.linear.teamId, state: c.linear.readyStateId, label: c.linear.readyLabelId, after } })
    });
    if (!response.ok) throw Error(`Linear HTTP ${response.status}`);
    const body: any = await response.json();
    if (body.errors || !body.data?.issues?.pageInfo || !Array.isArray(body.data.issues.nodes)) throw Error('Linear returned errors or incomplete data');
    for (const issue of body.data.issues.nodes) {
      if (issue.project?.id !== c.linear.projectId || issue.team?.id !== c.linear.teamId || issue.state?.id !== c.linear.readyStateId) throw Error('Linear scope mismatch');
      if (!Array.isArray(issue.labels?.nodes) || issue.labels?.pageInfo?.hasNextPage !== false || !issue.labels.nodes.some((label: any) => label.id === c.linear.readyLabelId)) throw Error('Linear label missing or incomplete');
      if (typeof issue.id !== 'string' || typeof issue.title !== 'string' || typeof issue.identifier !== 'string') throw Error('Invalid issue');
      candidates.push(issue);
      count++;
    }
    const page = body.data.issues.pageInfo;
    if (!page.hasNextPage) break;
    if (!page.endCursor || seen.has(page.endCursor)) throw Error('Invalid pagination cursor');
    seen.add(page.endCursor); after = page.endCursor;
  } while (true);
  if(c.statusSync?.enabled){
    const owned=store.db.query("SELECT j.issue FROM jobs j JOIN planning_runs p ON p.job=j.id WHERE j.project=? AND p.session_id IS NOT NULL AND j.state NOT IN ('done')").all(c.linear.projectId) as any[];
    for(let offset=0;offset<owned.length;offset+=50){
      const ids=owned.slice(offset,offset+50).map(j=>j.issue);
      const response=await send('https://api.linear.app/graphql',{method:'POST',headers:{Authorization:token,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({query:`query($ids:[ID!]!){issues(first:100,filter:{id:{in:$ids}}){nodes{id identifier title description project{id} team{id} state{id} labels(first:100){nodes{id name}pageInfo{hasNextPage}}}pageInfo{hasNextPage}}}`,variables:{ids}})});
      const body:any=await response.json();if(!response.ok||body.errors||!Array.isArray(body.data?.issues?.nodes)||body.data.issues.pageInfo?.hasNextPage!==false)throw Error('Incomplete owned Linear issue snapshot');
      for(const issue of body.data.issues.nodes){
        if(!ids.includes(issue.id)||issue.project?.id!==c.linear.projectId||issue.team?.id!==c.linear.teamId||issue.labels?.pageInfo?.hasNextPage!==false)throw Error('Owned issue scope mismatch');
        if([c.linear.readyStateId,c.statusSync.inProgress,c.statusSync.inReview].includes(issue.state?.id)&&issue.labels.nodes.some((l:any)=>l.id===c.linear.readyLabelId)&&!candidates.some(x=>x.id===issue.id))candidates.push(issue);
      }
    }
  }
  const dependencyBlocked=new Map<string,string>();
  if(store.db.query("SELECT name FROM sqlite_master WHERE name='feature_dependencies'").get()){
    for(const issue of candidates){
       const deps=store.db.query('SELECT prerequisite FROM feature_dependencies WHERE issue=?').all(issue.id) as any[];
       if(!deps.length)continue;
       // Existing approved sessions retain eligibility while the dependency
       // coordinator waits for verified source capabilities. Initial intake is
       // unchanged; Linear Done alone never authorizes an existing continuation.
       if(c.dependencyRecovery?.enabled&&store.db.query("SELECT name FROM sqlite_master WHERE name='implementation_dispatch'").get()&&store.db.query("SELECT 1 FROM implementation_dispatch d JOIN jobs j ON j.id=d.job WHERE j.issue=? AND j.project=? AND d.state IN ('delivery_uncertain','delivery_accepted','implementation_running','blocked_dependency','needs_input','awaiting_pr','pr_handoff','failed','uncertain','needs_reconciliation','blocked')").get(issue.id,c.linear.projectId))continue;
       // Keep an existing captured planning wait eligible for observation, not
       // authorization. Its receipt still gates approval until verified proof.
       if(c.dependencyRecovery?.enabled&&c.dependencyRecovery.jobs?.some(d=>d.issue===issue.id&&d.stage==='planning')&&store.db.query("SELECT name FROM sqlite_master WHERE name='planning_runs'").get()&&store.db.query("SELECT name FROM sqlite_master WHERE name='plan_readiness'").get()&&store.db.query("SELECT 1 FROM planning_runs p JOIN jobs j ON j.id=p.job JOIN plan_readiness r ON r.job=j.id AND r.plan_hash=j.plan_hash WHERE j.issue=? AND j.project=? AND j.state='awaiting_approval' AND p.state='plan_captured' AND r.valid=1 AND r.source='receipt' AND r.state='blocked-by-dependency' AND r.spec_hash=? AND p.spec_hash=r.spec_hash AND j.spec=?").get(issue.id,c.linear.projectId,digest(JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''})),JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''})))continue;
       const response=await send('https://api.linear.app/graphql',{method:'POST',headers:{Authorization:token,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({query:`query($ids:[ID!]!){issues(first:100,filter:{id:{in:$ids}}){nodes{id state{type} project{id} team{id}}pageInfo{hasNextPage}}}`,variables:{ids:deps.map(d=>d.prerequisite)}})});
      const body:any=await response.json();if(!response.ok||body.errors||!Array.isArray(body.data?.issues?.nodes)||body.data.issues.pageInfo?.hasNextPage!==false)throw Error('Incomplete dependency state snapshot');
      if(deps.some(d=>!body.data.issues.nodes.some((n:any)=>n.id===d.prerequisite&&n.state?.type==='completed'&&n.project?.id===c.linear.projectId&&n.team?.id===c.linear.teamId&&(!(store.db.query('SELECT state FROM jobs WHERE issue=? AND project=?').get(d.prerequisite,c.linear.projectId) as any)||(store.db.query('SELECT state FROM jobs WHERE issue=? AND project=?').get(d.prerequisite,c.linear.projectId) as any).state==='done'))))dependencyBlocked.set(issue.id,'Feature prerequisites must be completed before this ticket is picked up');
    }
  }
  // Only a fully successful snapshot can revoke eligibility. Never dispatch from
  // cached approval when the issue has left the Todo + agent-ready scope.
  store.db.transaction(() => {
    if((store.db.query('SELECT token FROM queue_poll_heads WHERE project=?').get(c.linear.projectId) as any)?.token!==pollToken)throw Error('Linear snapshot superseded by a newer poll; no eligibility changes applied');
    for(const issue of candidates){
      const held=store.db.query("SELECT name FROM sqlite_master WHERE name='feature_issue_holds'").get()&&store.db.query('SELECT issue FROM feature_issue_holds WHERE issue=?').get(issue.id);
      if(held||dependencyBlocked.has(issue.id))continue;
      if(issue.labels.nodes.some((label:any)=>label.name?.trim().toLowerCase()==='plan-approval-required'))manual.add(issue.id);
      store.enqueue(c.linear.projectId,issue.id,JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description??''}));eligible.add(issue.id);
    }
    if(store.db.query("SELECT name FROM sqlite_master WHERE name='feature_intake_blocks'").get()){for(const issue of candidates){store.db.query('DELETE FROM feature_intake_blocks WHERE issue=?').run(issue.id);if(dependencyBlocked.has(issue.id))store.db.query('INSERT INTO feature_intake_blocks VALUES (?,?)').run(issue.id,dependencyBlocked.get(issue.id)!);}}
    policyStore.snapshot(c.linear.projectId,eligible,observed,manual);
    store.db.query('DELETE FROM queue_observations WHERE job IN (SELECT id FROM jobs WHERE project=?)').run(c.linear.projectId);
    for(const issue of candidates){
      if(!eligible.has(issue.id))continue;
      const job=store.db.query('SELECT id,spec FROM jobs WHERE project=? AND issue=?').get(c.linear.projectId,issue.id) as any;
      const evidence={issue:issue.id,project:issue.project.id,team:issue.team.id,state:issue.state.id,labels:issue.labels.nodes,labelsComplete:true,policy:c.approval??{mode:'manual'}};
      store.db.query('INSERT INTO queue_observations VALUES (?,?,?,?)').run(job.id,digest(job.spec),observed,JSON.stringify(evidence));
    }
    const jobs=store.db.query('SELECT id,issue,state FROM jobs WHERE project=?').all(c.linear.projectId) as any[];
    for(const job of jobs) {
      if(!eligible.has(job.issue) && !['blocked','done'].includes(job.state)) {
        store.db.query("UPDATE jobs SET state='blocked', approved_hash=NULL, actor=NULL, reason='No longer eligible in Linear', updated=CURRENT_TIMESTAMP WHERE id=?").run(job.id);
        store.event(job.id,'eligibility_revoked','Absent from complete Todo + agent-ready snapshot');
      }
    }
  })();
  return { ingested: count, executionEnabled: false };
}

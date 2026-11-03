import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';
import {Workflow} from '../src/workflow';
import {Planning} from '../src/planning';
import {PlanningDependencies} from '../src/planning-dependencies';
import {dependencyIO} from '../src/dependency-evidence';
import {LinearBlockers} from '../src/linear-blockers';
import {ApprovalPolicyStore,featureGit} from '../src/approval-policy';
import {readinessFor,activeResolution,standingReady,recordReadiness} from '../src/readiness';
const root='11111111-1111-1111-1111-111111111111',dep='22222222-2222-2222-2222-222222222222';
async function fixture(manual=false){
 const s=new Store(':memory:'),messages:any[]=[];let merged=false,base='b'.repeat(40),lost=false;
 const issue={id:root,identifier:'DEV-43',title:'CLI controls',description:'Depends on DEV-32',project:{id:'p'},team:{id:'t'},state:{id:'todo'},labels:{nodes:[{id:'ready'}],pageInfo:{hasNextPage:false}}};
 const c:any={repo:'/repo',githubRepo:'owner/repo',linear:{projectId:'p',teamId:'t',readyStateId:'todo',readyLabelId:'ready'},requiredChecks:['CI'],approval:{mode:'ready-queue',id:'fixture-policy',authorizedBy:'human',scope:['src/**','test/**'],gitScope:'feature-pr'}};
 const e:any={session:{id:'session',projectId:'ao',branch:'',isTerminated:false,prs:[]},transcript:{controller:'ready',entries:[],turns:[]}};
 const w=new Workflow(s,{async startPlan(){throw Error('Never replace session');},async findPlans(){return [];},async evidence(){return e;},async disableFeedback(){},async sendImplementation(session,prompt,clientId){messages.push({session,prompt,clientId});if(lost)throw Error('Uncertain delivery');e.transcript.entries.push({clientMessageId:clientId,turnId:'implementation'});e.transcript.turns.push({id:'implementation',state:'running'});e.transcript.controller='busy';}});
 const job=s.enqueue('p',root,JSON.stringify({identifier:issue.identifier,title:issue.title,description:issue.description})),p=new Planning(s);p.reserve(job,'ao');const r=p.get(job);p.gate(job,'ao','session',r.branch,'/worktrees/session');e.session.branch=r.branch;
 const plan='Implement CLI controls using the reviewed DEV-32 interface.\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"blocked-by-dependency","questions":[],"dependencies":[{"ref":"DEV-32","reason":"CLI foundation"}]} -->';
 s.propose(job,plan);s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(job);s.db.query('INSERT INTO planning_dispatch(job,spec_hash,state,session_id,client_id) VALUES (?,?,?,?,?)').run(job,digest(s.get(job).spec),'awaiting_approval','session','planning-id');
 c.dependencyRecovery={enabled:true,baseBranch:'main',jobs:[{stage:'planning',project:'p',issue:root,planHash:s.get(job).plan_hash,specHash:digest(s.get(job).spec),contractReview:{actor:'reviewer',compatibility:'Existing plan uses unchanged reviewed CLI contract; no worktree update required by observation'},prerequisites:[{issue:dep,ref:'DEV-32',repo:'owner/repo',pr:32,headSha:'a'.repeat(40),kind:'source',capabilities:[{path:'src/cli.ts',sha256:'c'.repeat(64)}]}]}]};
 recordReadiness(s,job,plan,s.get(job).plan_hash,digest(s.get(job).spec));
 const io:any={async issue(id:string){return id===root?issue:{id:dep,identifier:'DEV-32',project:{id:'p'},team:{id:'t'}};},async relations(id:string){return id===root?[dep]:[];},async provider(){if(!merged)throw Error('DEV-32 PR #32 is open, not a verified merge');return {repo:'owner/repo',baseBranch:'main',base,dependencies:c.dependencyRecovery.jobs[0].prerequisites};},async fetch(){throw Error('Observation must not fetch');},async update(){throw Error('Observation must not mutate');},async facts(){throw Error('No worker/grant required');}};
 w.planningDependencies=new PlanningDependencies(s,w,io);
 new ApprovalPolicyStore(s).snapshot('p',new Set([root]),Date.now(),manual?new Set([root]):new Set());
 return {s,w,c,job,plan,messages,io,issue,merge:()=>{merged=true;},changeBase:()=>{base='d'.repeat(40);},lose:()=>{lost=true;}};
}
test('DEV-43/DEV-32: pre-merge wait, same-plan resolution, standing dispatch once',async()=>{
 const f=await fixture();try{
  await f.w.tick(f.c);expect(f.w.implementation(f.job)).toBeNull();expect(f.s.db.query('SELECT * FROM git_grants').all()).toEqual([]);expect(f.w.planningDependencies.rows()[0].reason).toContain('not a verified merge');
  f.merge();await f.w.tick(f.c);expect(f.messages).toHaveLength(1);expect(f.messages[0].session).toBe('session');expect(f.s.get(f.job).plan).toBe(f.plan);expect(readinessFor(f.s,f.job).state).toBe('blocked-by-dependency');expect(activeResolution(f.s,f.job).source).toBe('dependency-satisfied');
  await f.w.tick(f.c);expect(f.messages).toHaveLength(1);
 }finally{f.s.close();}
});
test('manual label stays paused and explicit current approval uses normal dispatcher',async()=>{
 const f=await fixture(true);try{f.merge();await f.w.tick(f.c);expect(f.messages).toHaveLength(0);expect(f.s.get(f.job).state).toBe('awaiting_approval');expect(f.w.planning(f.job).reason).toContain('explicit human');
 f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);await f.w.executeApproved(f.job,f.c);expect(f.messages).toHaveLength(1);
 }finally{f.s.close();}
});
test('concurrent observations and restart preserve one resolution and uncertain send is never replayed',async()=>{
 const f=await fixture();try{f.merge();await Promise.all([f.w.planningDependencies.tick(f.job,f.c),f.w.planningDependencies.tick(f.job,f.c)]);expect(f.s.db.query('SELECT * FROM plan_resolutions').all()).toHaveLength(1);
 f.w.planningDependencies=new PlanningDependencies(f.s,f.w,f.io);f.lose();await f.w.tick(f.c);await f.w.tick(f.c);expect(f.messages).toHaveLength(1);expect(f.w.implementation(f.job).state).not.toBe('approved_pending');
 }finally{f.s.close();}
});
for(const scenario of ['config','spec','plan','questions','provider','cycle','project','unmapped','missing-binding'])test(`${scenario} fails closed without grants or turns`,async()=>{
 const f=await fixture();try{f.merge();
 if(scenario==='config')f.c.dependencyRecovery.jobs[0].contractReview=null;
 if(scenario==='spec')f.issue.description='Changed requirements';
 if(scenario==='plan')f.s.db.query("UPDATE jobs SET plan='revised' WHERE id=?").run(f.job);
 if(scenario==='questions')f.s.db.query('UPDATE plan_readiness SET questions=? WHERE job=?').run(JSON.stringify([{id:'q1',kind:'security-scope',question:'Expand scope?'}]),f.job);
 if(scenario==='provider')f.io.provider=async()=>{throw Error('Rate limited/missing capability');};
 if(scenario==='cycle')f.io.relations=async(id:string)=>id===root?[dep]:[root];
 if(scenario==='project')f.c.dependencyRecovery.jobs[0].project='wrong';
 if(scenario==='unmapped')f.c.dependencyRecovery.jobs[0].prerequisites[0].ref='DEV-99';
 if(scenario==='missing-binding')f.c.dependencyRecovery.enabled=false;
 f.w.planningDependencies=new PlanningDependencies(f.s,f.w,f.io);await f.w.tick(f.c);expect(f.messages).toHaveLength(0);expect(f.w.implementation(f.job)).toBeNull();expect(standingReady(f.s,f.job)).toBe(false);
 }finally{f.s.close();}
});
test('base/config changes and approval revocation before dispatch cannot consume old evidence',async()=>{
 const f=await fixture(true);try{f.merge();await f.w.tick(f.c);f.w.approve(f.job,f.s.get(f.job).plan_hash,'human',['src/**'],'supervised-host',featureGit);f.changeBase();await expect(f.w.executeApproved(f.job,f.c)).rejects.toThrow('changed');expect(f.messages).toHaveLength(0);
 f.s.db.query('UPDATE jobs SET approved_hash=NULL WHERE id=?').run(f.job);await expect(f.w.executeApproved(f.job,f.c)).rejects.toThrow();expect(f.messages).toHaveLength(0);
 }finally{f.s.close();}
});
test('disabling configuration invalidates a resolved wait; a fresh manual label wins over cached standing eligibility',async()=>{
 const f=await fixture(true);try{f.merge();await f.w.tick(f.c);expect(standingReady(f.s,f.job)).toBe(true);f.c.dependencyRecovery.enabled=false;await f.w.tick(f.c);expect(standingReady(f.s,f.job)).toBe(false);expect(activeResolution(f.s,f.job)).toBeNull();
 f.c.dependencyRecovery.enabled=true;new ApprovalPolicyStore(f.s).snapshot('p',new Set([root]));(f.issue.labels.nodes as any[]).push({id:'manual',name:'plan-approval-required'});await f.w.tick(f.c);expect(f.messages).toHaveLength(0);expect(f.w.planning(f.job).reason).toContain('explicit human');
 }finally{f.s.close();}
});
test('concurrent workflow ticks authorize and dispatch only once',async()=>{
 const f=await fixture();try{f.merge();await Promise.all([f.w.tick(f.c),f.w.tick(f.c)]);expect(f.messages).toHaveLength(1);expect(f.s.db.query('SELECT * FROM policy_authorizations').all()).toHaveLength(1);expect(f.s.db.query('SELECT * FROM runs').all()).toHaveLength(1);}finally{f.s.close();}
});
for(const scenario of ['valid','head','base','repo','closed','capability','missing','runtime','ancestry','rate-limit'])test(`planning uses authoritative provider checks: ${scenario}`,async()=>{
 const f=await fixture();try{
 const d=f.c.dependencyRecovery.jobs[0],pr=d.prerequisites[0];pr.capabilities[0].sha256=digest('contract');if(scenario==='runtime')pr.kind='host-runtime';
 const io=dependencyIO(f.s,async(args)=>{
  const path=args.at(-1)!;if(scenario==='rate-limit')throw Error('Rate limited');
  if(path.includes('/branches/'))return JSON.stringify({name:'main',commit:{sha:'b'.repeat(40)}});
  if(path.includes('/pulls/'))return JSON.stringify({number:32,html_url:'https://github.com/owner/repo/pull/32',head:{sha:scenario==='head'?'e'.repeat(40):pr.headSha},base:{repo:{full_name:scenario==='repo'?'other/repo':'owner/repo'},ref:scenario==='base'?'other':'main'},merged:scenario!=='closed',merged_at:'2026-11-02',state:'closed',merge_commit_sha:'a'.repeat(40)});
  if(path.includes('/compare/'))return JSON.stringify({status:scenario==='ancestry'?'diverged':'ahead',merge_base_commit:{sha:'a'.repeat(40)}});
  return JSON.stringify({type:scenario==='missing'?'dir':'file',path:'src/cli.ts',encoding:'base64',size:8,content:Buffer.from(scenario==='capability'?'changed':'contract').toString('base64')});
 });
 if(scenario==='valid')expect((await io.provider(f.c,d)).dependencies).toHaveLength(1);else await expect(io.provider(f.c,d)).rejects.toThrow();
 }finally{f.s.close();}
});
test('planning notices deduplicate and unresolved planning label survives generic blocker cleanup',async()=>{
 const f=await fixture();try{
 const label='33333333-3333-3333-3333-333333333333',comments:any[]=[];f.c.blockerSync={enabled:true,labelId:label};
 const blockers=new LinearBlockers(f.s,async(q,v)=>{
  if(q.includes('commentCreate')){const comment={...v.input,createdAt:'2026-11-02T00:00:00Z'};comments.push(comment);return {commentCreate:{success:true,comment}};}
  if(q.includes('comments(first:100'))return {issue:{id:root,comments:{nodes:comments,pageInfo:{hasNextPage:false}}}};
  if(q.includes('issueUpdate')){f.issue.labels.nodes=v.added?[...f.issue.labels.nodes,{id:label}]:f.issue.labels.nodes.filter(x=>x.id!==label);return {issueUpdate:{success:true,issue:f.issue}};}
  return {issue:f.issue};
 });
 await f.w.tick(f.c);for(let i=0;i<2;i++){await f.w.planningDependencies.notices(f.c,blockers);await blockers.sync(f.c);}
 expect(comments).toHaveLength(1);expect(comments[0].body).toContain('Planning dependencies');expect(f.issue.labels.nodes.some(x=>x.id===label)).toBe(true);
 }finally{f.s.close();}
});

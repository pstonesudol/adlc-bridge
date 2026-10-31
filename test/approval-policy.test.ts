import {test,expect} from 'bun:test';
import {Store,digest} from '../src/core';import {Planning} from '../src/planning';import {Workflow} from '../src/workflow';import {Lifecycle} from '../src/lifecycle';
import {ApprovalPolicyStore,featureGit,type ApprovalPolicy} from '../src/approval-policy';import {scopeAllows} from '../src/file-scope';
const policy:ApprovalPolicy={mode:'ready-queue',id:'test-queue-policy',authorizedBy:'test human',scope:['**'],gitScope:'feature-pr'};
const config={repo:'/repo',linear:{projectId:'project'},requiredChecks:['CI'],automation:{planningEnabled:false,orchestratorProject:'ao'},approval:policy};
function fixture(){
 const s=new Store(':memory:'),messages:any[]=[],session={session:{id:'worker',projectId:'ao',branch:'',prs:[]},transcript:{controller:'ready',entries:[],turns:[]}};
 const w=new Workflow(s,{startPlan:async()=>{throw Error('No new worker expected');},findPlans:async()=>[],evidence:async()=>session,disableFeedback:async()=>{},sendImplementation:async(id,prompt,clientId)=>{messages.push({id,prompt,clientId});session.transcript.controller='busy';(session.transcript.entries as any[]).push({clientMessageId:clientId,turnId:'implementation'});(session.transcript.turns as any[]).push({id:'implementation',state:'running'});}});
 const id=s.enqueue('project','issue','User queued task'),p=new Planning(s);p.reserve(id,'ao');const r=p.get(id);session.session.branch=r.branch;p.gate(id,'ao','worker',r.branch,'/worktree');
 const hash=s.propose(id,'Captured plan');s.db.query("UPDATE planning_runs SET state='plan_captured' WHERE job=?").run(id);s.db.query('INSERT INTO planning_dispatch(job,spec_hash,state,session_id,client_id) VALUES (?,?,?,?,?)').run(id,digest('User queued task'),'awaiting_approval','worker','planning-id');
 return {s,w,id,hash,messages,policyStore:new ApprovalPolicyStore(s)};
}
test('complete trusted queue snapshot plus standing user policy authorizes one implementation delivery',async()=>{
 const {s,w,id,messages,policyStore}=fixture();try{
 policyStore.snapshot('project',new Set(['issue']));await w.tick(config);expect(s.get(id).state).toBe('approved');expect(messages.length).toBe(1);expect(messages[0].prompt).toContain('delegated authorization');expect(messages[0].prompt).toContain('No live payments');
 expect(policyStore.get(id).authorized_by).toBe('test human');expect(JSON.parse((s.db.query('SELECT operations FROM git_grants WHERE job=?').get(id) as any).operations)).toEqual(featureGit);
 const events=s.db.query('SELECT kind FROM events WHERE job=?').all(id) as any[];expect(events.some(e=>e.kind==='standing_policy_plan_authorized')).toBe(true);expect(events.some(e=>e.kind==='human_plan_approval_recorded')).toBe(false);
 await w.tick(config);expect(messages.length).toBe(1);
 }finally{s.close();}
});
test('missing, stale, wrong-project and revoked queue evidence cannot authorize work',async()=>{
 const {s,w,id,messages,policyStore}=fixture();try{
 await w.tick(config);expect(s.get(id).state).toBe('awaiting_approval');
 policyStore.snapshot('project',new Set(['issue']),Date.now()-121000);await w.tick(config);expect(messages.length).toBe(0);
 policyStore.snapshot('project',new Set());await w.tick(config);expect(messages.length).toBe(0);
 policyStore.snapshot('project',new Set(['issue']));expect(policyStore.evaluate(id,'different-project',policy).allowed).toBe(false);
 }finally{s.close();}
});
test('manual policy stays manual even when issue text claims authorization',async()=>{
 const {s,w,id,messages,policyStore}=fixture();try{policyStore.snapshot('project',new Set(['issue']));await w.tick({...config,approval:{mode:'manual'}});expect(s.get(id).state).toBe('awaiting_approval');expect(messages.length).toBe(0);}finally{s.close();}
});
test('standing grant revokes on policy changes and cannot support stale remediation',async()=>{
 const {s,w,id,messages,policyStore}=fixture();try{
 policyStore.snapshot('project',new Set(['issue']));await w.tick(config);expect(messages.length).toBe(1);
 policyStore.snapshot('project',new Set(['issue']),Date.now()-121000);expect(()=>new Lifecycle(s).current(id)).toThrow('eligibility');
 policyStore.snapshot('project',new Set(['issue']));await w.tick({...config,approval:{mode:'manual'}});expect(s.get(id).state).toBe('blocked');expect(s.get(id).approved_hash).toBeNull();expect(messages.length).toBe(1);
 }finally{s.close();}
});
test('wildcard repository scope still rejects traversal, secrets, Git metadata and policies',()=>{
 for(const path of ['backend/app/a.py','frontend/src/a.ts','backend/uv.lock'])expect(scopeAllows(path,['**'])).toBe(true);
 for(const path of ['/etc/passwd','../outside','frontend/../AGENTS.md','AGENTS.md','frontend/agents.md','.git/config','.GIT/config','.env.local','backend/.env','backend/.codex/config.toml','x\\..\\secret'])expect(scopeAllows(path,['**'])).toBe(false);
 expect(scopeAllows('backend/app/a.py',['backend/**','!backend/app/**'])).toBe(false);expect(scopeAllows('frontend/src/a.ts',['backend/**'])).toBe(false);
});

test('per-ticket label overrides automatic policy; explicit human approval proceeds without removing label',async()=>{
 const {s,w,id,hash,messages,policyStore}=fixture();try{
 policyStore.snapshot('project',new Set(['issue']),Date.now(),new Set(['issue']));
 await w.tick(config);expect(s.get(id).state).toBe('awaiting_approval');expect(messages.length).toBe(0);
 expect(w.planning(id).reason).toContain('plan-approval-required');expect(policyStore.get(id)).toBeNull();
 w.approve(id,hash,'test human',['**'],'supervised-host',featureGit);
 await w.tick(config);expect(messages.length).toBe(1);expect(policyStore.requiresManual(id)).toBe(true);
 expect(messages[0].prompt).toContain('Human test human approved');expect(policyStore.get(id)).toBeNull();
 await w.tick(config);expect(messages.length).toBe(1);
 }finally{s.close();}
});
test('removing label restores automatic eligibility, but project manual policy still wins',async()=>{
 const {s,w,id,messages,policyStore}=fixture();try{
 policyStore.snapshot('project',new Set(['issue']),Date.now(),new Set(['issue']));await w.tick(config);expect(messages.length).toBe(0);
 policyStore.snapshot('project',new Set(['issue']));await w.tick({...config,approval:{mode:'manual'}});expect(messages.length).toBe(0);
 await w.tick(config);expect(messages.length).toBe(1);
 }finally{s.close();}
});
test('a fresh approval-required label invalidates further standing execution checks',async()=>{
 const {s,w,id,policyStore}=fixture();try{
 policyStore.snapshot('project',new Set(['issue']));await w.tick(config);
 policyStore.snapshot('project',new Set(['issue']),Date.now(),new Set(['issue']));
 expect(()=>new Lifecycle(s).current(id)).toThrow('plan-approval-required');
 }finally{s.close();}
});

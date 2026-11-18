import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {AcceptanceEvidence,checkHash,validateDraftPolicy,bindDraftConfig,CURRENT_DRAFT_POLICY,type DraftPolicy,type DraftBinding,type AcceptanceRecord} from '../src/acceptance-evidence';

function fixture(){
 const s=new Store(':memory:'),job=s.enqueue('project','issue','spec');
 const b:DraftBinding={job,plan:'plan',spec:'spec',revision:null,dispatch:'dispatch',session:'worker',worktree:'/tree',branch:'feature',repo:'owner/repo',pr:175,head:'a'.repeat(40),authorization:'current-authority'};
 const p:DraftPolicy={enabled:true,repository:b.repo,operators:['human'],integrations:['ci-app'],maxAgeMs:1000,checks:[
  {id:'visual',kind:'responsive',definition:'about page at required widths',viewports:['390x844','1440x900']},
  {id:'saved',kind:'live-content',definition:'saved content matches approved revision',environment:'test',verifier:['/trusted/read-only-verifier']},
 ]};
 let now=10000;
 const evidence=new AcceptanceEvidence(s,()=>now);
 const record=(id:string,extra:Partial<AcceptanceRecord>={})=>{
  const c=p.checks.find(c=>c.id===id)!;
  const r:AcceptanceRecord={repository:b.repo,pr:b.pr,head:b.head,check:id,definitionHash:checkHash(c),passed:true,issuer:'human',observed:now,reference:'evidence:record',...(id==='visual'?{viewports:['390x844','1440x900']}:{environment:'test',revision:'content-v1'}),...extra};
  return evidence.record(b,p,r,{kind:'operator',id:'human'});
 };
 return {s,b,p,evidence,record,advance:()=>now+=1001};
}
test('durable evidence requires each independent check; CI attests no implicit visual/live pass',async()=>{
 const f=fixture();try{
  expect(await f.evidence.blockers(f.b,f.p,async()=>true)).toHaveLength(2);
  f.record('visual');expect(await f.evidence.blockers(f.b,f.p,async()=>true)).toEqual(['Acceptance saved: missing current-head/current-definition evidence']);
  f.record('saved');expect(await f.evidence.blockers(f.b,f.p,async()=>false)).toEqual(['Acceptance saved: current live content revision cannot be verified']);
  expect(await f.evidence.blockers(f.b,f.p,async()=>true)).toEqual([]);
  expect(f.s.db.query('SELECT * FROM acceptance_evidence').all()).toHaveLength(2);
 }finally{f.s.close();}
});
for(const [name,change] of Object.entries({
 head:(f:any)=>f.b.head='b'.repeat(40),definition:(f:any)=>f.p.checks[0].definition='changed',
 plan:(f:any)=>f.b.plan='new-plan',revision:(f:any)=>f.b.revision='new-revision',dispatch:(f:any)=>f.b.dispatch='new-dispatch',
 issuer:(f:any)=>f.p.operators=[],freshness:(f:any)=>f.advance(),
}))test(`acceptance evidence invalidates on ${name}`,async()=>{
 const f=fixture();try{f.record('visual');f.record('saved');change(f);expect((await f.evidence.blockers(f.b,f.p,async()=>true)).length).toBeGreaterThan(0);}finally{f.s.close();}
});
for(const [name,extra] of Object.entries({
 viewport:{viewports:['390x844']},head:{head:'b'.repeat(40)},repo:{repository:'other/repo'},pr:{pr:174},issuer:{issuer:'imposter'},
 definition:{definitionHash:'old'},future:{observed:10001},reference:{reference:''},
}))test(`record rejects ${name}`,()=>{
 const f=fixture();try{expect(()=>f.record('visual',extra)).toThrow();}finally{f.s.close();}
});
test('a new failed check supersedes green evidence; issuer trust does not cross categories',async()=>{
 const f=fixture();try{
  f.record('visual');f.record('saved');f.record('visual',{passed:false});
  expect(await f.evidence.blockers(f.b,f.p,async()=>true)).toContain('Acceptance visual: verification failed');
  f.p.operators=[];f.p.integrations=['human'];
  expect(await f.evidence.blockers(f.b,f.p,async()=>true)).toContain('Acceptance saved: issuer no longer trusted');
 }finally{f.s.close();}
});
test('live evidence cannot omit environment/revision or verify through an unavailable integration',async()=>{
 const f=fixture();try{
  expect(()=>f.record('saved',{environment:'production'})).toThrow('environment');
  expect(()=>f.record('saved',{revision:''})).toThrow('revision');
  f.record('visual');f.record('saved');
  expect(await f.evidence.blockers(f.b,f.p,async()=>{throw Error('offline');})).toContain('Acceptance saved: current live content revision cannot be verified');
  delete f.p.checks[1].verifier;
  expect((await f.evidence.blockers(f.b,f.p,async()=>true)).length).toBeGreaterThan(0);
 }finally{f.s.close();}
});
test('promotion config is default off and rejects wrong repository, malformed types and undefined checks',()=>{
 validateDraftPolicy(undefined,'owner/repo');
 const f=fixture();try{
  for(const patch of [{repository:'other/repo'},{enabled:'true'},{checks:[]},{maxAgeMs:0},{operators:null},{checks:[{id:'live',kind:'live-content',definition:'content'}]}]){
   expect(()=>validateDraftPolicy({...f.p,...patch},f.b.repo)).toThrow();
  }
 }finally{f.s.close();}
});
test('evidence changed or expired during awaited live verification fails closed',async()=>{
 const f=fixture();try{
  f.record('visual');f.record('saved');
  let changed=false;
  const blockers=await f.evidence.blockers(f.b,f.p,async()=>{
   if(!changed){changed=true;f.record('visual',{passed:false});f.advance();}
   return true;
  });
  expect(blockers).toContain('Acceptance evidence or policy changed during verification; reevaluate');
  expect(blockers).toContain('Acceptance evidence became stale during verification');
 }finally{f.s.close();}
});
test('host-only configuration guard notices policy revocation without exposing configuration',()=>{
 const f=fixture();try{
  let config:any={repo:'/repo',githubRepo:f.b.repo,linear:{projectId:'p'},draftPromotion:f.p};
  const snapshot=bindDraftConfig(structuredClone(config),()=>config) as any;
  snapshot[CURRENT_DRAFT_POLICY]();
  expect(JSON.stringify(snapshot)).not.toContain('current trusted');
  config={...config,draftPromotion:{...f.p,enabled:false},credential:'NEVER_PRINT'};
  expect(()=>snapshot[CURRENT_DRAFT_POLICY]()).toThrow('Trusted draft project policy changed; reload before any effect');
 }finally{f.s.close();}
});

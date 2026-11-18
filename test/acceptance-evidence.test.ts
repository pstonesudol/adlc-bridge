import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {AcceptanceEvidence,checkHash,validateDraftPolicy,bindDraftConfig,CURRENT_DRAFT_POLICY,verifyLiveContent,type DraftPolicy,type DraftBinding,type AcceptanceRecord} from '../src/acceptance-evidence';

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
function verifierProcess(stdout:string[],stderr:string[],code=0){
 let kills=0,produced=0,cancelled=0;
 const stream=(chunks:string[])=>{
  let index=0;
  return new ReadableStream<Uint8Array>({
   pull(controller){if(index===chunks.length){controller.close();return;}produced++;controller.enqueue(new TextEncoder().encode(chunks[index++]));},
   cancel(){cancelled++;},
  });
 };
 const spawn=(()=>({stdout:stream(stdout),stderr:stream(stderr),exited:Promise.resolve(code),kill:(signal:string)=>{expect(signal).toBe('SIGKILL');kills++;}})) as typeof Bun.spawn;
 return {spawn,kills:()=>kills,produced:()=>produced,cancelled:()=>cancelled};
}
for(const kind of ['stdout','stderr','utf8'])test(`live verifier bounds ${kind} bytes while reading, kills and cancels on overflow`,async()=>{
 const f=fixture();try{
  const valid=JSON.stringify({environment:'test',revision:'v1'});
  const large=kind==='utf8'?JSON.stringify({environment:'test',revision:'v1',noise:'😀'.repeat(5000)}):'x'.repeat(9000);
  const stdout=kind==='stderr'?[valid]:kind==='utf8'?[large]:Array(100).fill(large);
  const stderr=kind==='stderr'?Array(100).fill(large):[];
  const child=verifierProcess(stdout,stderr);
  const record={environment:'test',revision:'v1'} as AcceptanceRecord;
  expect(await verifyLiveContent(f.p.checks[1],record,child.spawn)).toBe(false);
  expect(child.kills()).toBe(1);expect(child.produced()).toBeLessThan(10);
  if(kind!=='utf8')expect(child.cancelled()).toBeGreaterThan(0);
 }finally{f.s.close();}
});
test('small valid verifier responses and exact per-stream byte limits remain accepted',async()=>{
 const f=fixture();try{
  const valid=JSON.stringify({environment:'test',revision:'v1'}),record={environment:'test',revision:'v1'} as AcceptanceRecord;
  for(const [out,err] of [[[valid.slice(0,10),valid.slice(10)],['diagnostic']],[[valid.padEnd(16000,' ')],['e'.repeat(16000)]]]){
   const child=verifierProcess(out,err);
   expect(await verifyLiveContent(f.p.checks[1],record,child.spawn)).toBe(true);expect(child.kills()).toBe(0);
  }
  for(const [out,code] of [[valid,1],['not-json',0]] as const){
   expect(await verifyLiveContent(f.p.checks[1],record,verifierProcess([out],[],code).spawn)).toBe(false);
  }
 }finally{f.s.close();}
});
test('a verifier output read error terminates the process and fails closed',async()=>{
 const f=fixture();try{
  let kills=0;
  const spawn=(()=>({
   stdout:new ReadableStream({pull(controller){controller.error(Error('unreadable output'));}}),
   stderr:new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(100));}}),
   exited:Promise.resolve(0),kill:()=>kills++,
  })) as typeof Bun.spawn;
  expect(await verifyLiveContent(f.p.checks[1],{environment:'test',revision:'v1'} as AcceptanceRecord,spawn)).toBe(false);
  expect(kills).toBe(1);
 }finally{f.s.close();}
});

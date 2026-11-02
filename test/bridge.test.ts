import {test,expect} from 'bun:test';
import {Store,reviewGate,remediationDecision,type ReviewEvidence} from '../src/core';
import {Bridge,handoffChecklist} from '../src/orchestrator';
import {poll} from '../src/linear';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('durable approval and dispatch intent survive restart without a second preparation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'adlc-bridge-'));
  try{
    let s=new Store(join(dir,'state.db'));let b=new Bridge(s);
    const id=s.enqueue('p','i','requirements');
    expect(()=>b.prepare(id,'demo')).toThrow();
    const hash=s.propose(id,'plan');expect(()=>s.approve(id,'old','human')).toThrow();
    s.approve(id,hash,'human');const payload=b.prepare(id,'demo');
    expect(payload.executionEnabled).toBe(false);s.close();
    s=new Store(join(dir,'state.db'));b=new Bridge(s);
    expect(b.prepare(id,'demo')).toEqual(payload);expect(b.intents().length).toBe(1);
    expect(()=>b.prepare(id,'different-project')).toThrow();
    s.enqueue('p','i','new requirements');expect(s.get(id).approved_hash).toBeNull();
    expect(()=>b.prepare(id,'demo')).toThrow();
    s.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('OpenChamber handoff requires existing absolute directory and remains manual',()=>{
  expect(()=>handoffChecklist('relative')).toThrow();
  expect(handoffChecklist(tmpdir()).automaticHandoff).toBe(false);
});
const evidence=():ReviewEvidence=>({head:'abc',observedHead:'abc',required:['CI'],checks:[
  {name:'CI',sha:'abc',app:'github-actions',status:'completed',conclusion:'success'},
  {name:'CodeRabbit',sha:'abc',app:'coderabbitai',status:'completed',conclusion:'success'}
],review:{sha:'abc',author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true});
test('latest-SHA gate rejects incomplete, stale, ambiguous and unresolved evidence',()=>{
  expect(reviewGate(evidence()).clear).toBe(true);
  const changes=[(e:ReviewEvidence)=>e.observedHead='new',(e:ReviewEvidence)=>e.review=null,
    (e:ReviewEvidence)=>e.review!.sha='old',(e:ReviewEvidence)=>e.review!.state='COMMENTED',
    (e:ReviewEvidence)=>e.unresolved=null,(e:ReviewEvidence)=>e.unresolved=1,
    (e:ReviewEvidence)=>e.checksComplete=false,(e:ReviewEvidence)=>e.threadsComplete=false,
    (e:ReviewEvidence)=>e.checks[1].status='in_progress',(e:ReviewEvidence)=>e.checks.push(e.checks[0])];
  for(const change of changes){const e=evidence();change(e);expect(reviewGate(e).clear).toBe(false);}
});
test('fifth failed remediation blocks and missing review stays pending',()=>{
  expect(remediationDecision(5,true,false)).toBe('blocked');
  expect(remediationDecision(0,false,false)).toBe('waiting_for_review');
});
test('Linear pagination is scoped and idempotent, errors do not authorize execution',async()=>{
  const fetchOriginal=globalThis.fetch;const s=new Store(':memory:');
  const projectId='25a25ffb-6a31-4851-8ec5-2732cd9174d3',teamId='1e9f847c-2009-4fec-85a8-8b71d9820579',readyStateId='00000000-0000-0000-0000-000000000000';
  const readyLabelId='762695df-df09-4eba-aff4-35bee6415650';
  const c={version:1 as const,name:'test',repo:'/repo',requiredChecks:['CI'],linear:{projectId,teamId,readyStateId,readyLabelId}};
  globalThis.fetch=(async(_url:any,options:any)=>{
    const vars=JSON.parse(options.body).variables;const after=vars.after;
    expect(vars.label).toBe(readyLabelId);
    return Response.json({data:{issues:{nodes:[{id:after?'two':'one',identifier:'DEV-1',title:'Test',description:'Spec',project:{id:projectId},team:{id:teamId},state:{id:readyStateId},labels:{nodes:[{id:readyLabelId}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:!after,endCursor:after?null:'next'}}}});
  }) as typeof fetch;
  try{
    await poll(c,s,'test-only');await poll(c,s,'test-only');expect(s.list().length).toBe(2);
    expect(s.list().every((j:any)=>j.state==='awaiting_plan')).toBe(true);
    const id=(s.list()[0] as any).id;s.approve(id,s.propose(id,'plan'),'human');
    globalThis.fetch=(async()=>Response.json({data:{issues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}})) as typeof fetch;
    await poll(c,s,'test-only');expect(s.get(id).state).toBe('blocked');expect(s.get(id).approved_hash).toBeNull();
    globalThis.fetch=(async()=>Response.json({errors:[{}]})) as typeof fetch;
    await expect(poll(c,s,'test-only')).rejects.toThrow();
  }finally{globalThis.fetch=fetchOriginal;s.close();}
});
test('unlabelled Todo issues cannot enter the agent queue',async()=>{
  const original=globalThis.fetch;const s=new Store(':memory:');
  const projectId='25a25ffb-6a31-4851-8ec5-2732cd9174d3',teamId='1e9f847c-2009-4fec-85a8-8b71d9820579',readyStateId='b4eb906f-23b3-41b5-8aa5-2bee8753a556',readyLabelId='762695df-df09-4eba-aff4-35bee6415650';
  const c={version:1 as const,name:'test',repo:'/repo',requiredChecks:['CI'],linear:{projectId,teamId,readyStateId,readyLabelId}};
  globalThis.fetch=(async()=>Response.json({data:{issues:{nodes:[{id:'unlabelled',identifier:'DEV-1',title:'Test',project:{id:projectId},team:{id:teamId},state:{id:readyStateId},labels:{nodes:[],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}}})) as typeof fetch;
  try{await expect(poll(c,s,'test-only')).rejects.toThrow('label missing');expect(s.list()).toEqual([]);}
  finally{globalThis.fetch=original;s.close();}
});

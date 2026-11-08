import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {integrationPreview,integrationRuntime,verifyIntegrations,validateIntegrationPolicy,assertRequiredIntegrations} from '../src/integration-capabilities';
import {validate} from '../src/linear';
import {Store} from '../src/core';
import {Workflow} from '../src/workflow';
const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const config=()=>({version:1,name:'test',repo:'/repo',requiredChecks:['CI'],linear:{projectId:id(1),teamId:id(2),readyLabelId:id(3),readyStateId:id(4)},blockerSync:{enabled:true,labelId:id(5)},clarifications:{enabled:true,humanIds:[id(6)]}});
const evidence={identity:true,label:true,humans:true,reachable:true,publicationPermission:true,replyPermission:true};
test('legacy and disabled optional integrations show degradation without changing config or dispatch policy',()=>{
 const c:any={...config(),blockerSync:undefined,clarifications:undefined},before=JSON.stringify(c),report=integrationPreview(c);
 expect(report.dispatchAllowed).toBe(true);expect(report.matrix).toHaveLength(3);
 for(const row of report.matrix)expect(row).toMatchObject({implemented:true,configured:false,enabled:false,reachable:'unknown',validated:false,unavailable:false,degraded:true});
 expect(report.repair.changes.map(c=>c.path)).toEqual(['blockerSync','clarifications']);expect(JSON.stringify(c)).toBe(before);
 c.blockerSync={enabled:false,labelId:id(5)};c.clarifications={enabled:false,humanIds:[id(6)]};
 expect(integrationPreview(c,evidence).matrix.every(r=>r.configured&&!r.enabled&&!r.validated)).toBe(true);
});
test('installed, reachable and enabled are not operational permission evidence',()=>{
 const report=integrationPreview(config(),{identity:true,label:true,humans:true,reachable:true});
 expect(report.matrix.every(r=>r.configured&&r.enabled&&r.reachable===true&&!r.validated)).toBe(true);
 expect(report.matrix[0].prerequisites.providerPermission).toBe('unknown');
 expect(integrationPreview(config(),evidence).matrix.every(r=>r.validated)).toBe(true);
});
test('required missing settings and unknown permissions fail closed with operator action',()=>{
 const c={...config(),integrationPolicy:{required:['blockerPublication']}};
 expect(()=>assertRequiredIntegrations(c)).toThrow('Required integrations');
 expect(()=>assertRequiredIntegrations(c,integrationPreview(c,evidence))).not.toThrow();
 expect(integrationPreview({...c,blockerSync:{enabled:false,labelId:id(5)}}).blockers.join()).toContain('Explicitly review and enable');
 for(const required of [null,'blockerPublication',['other'],['blockerPublication','blockerPublication']])expect(()=>validateIntegrationPolicy({integrationPolicy:{required}})).toThrow('unique supported');
 expect(()=>validate({...config(),integrationPolicy:{required:['clarificationReplies']}})).not.toThrow();
});
test('existing validators reject invalid human UUIDs and queue label reuse',()=>{
 expect(()=>validate({...config(),blockerSync:{enabled:true,labelId:id(3)}})).toThrow('distinct');
 expect(()=>validate({...config(),clarifications:{enabled:true,humanIds:['not-a-human-id']}})).toThrow('UUID');
});
test('read-only checks verify project membership, labels and active non-app humans, never claim write permissions',async()=>{
 const c=config(),calls:string[]=[];
 const api=async(query:string)=>{calls.push(query);return query.includes('user(id:')?{user:{id:id(6),active:true,app:false}}:{project:{id:id(1),teams:{nodes:[{id:id(2)}],pageInfo:{hasNextPage:false}}},team:{id:id(2),labels:{nodes:[{id:id(5)}],pageInfo:{hasNextPage:false}}}};};
 expect(await verifyIntegrations(c,api)).toMatchObject({reachable:true,identity:true,label:true,humans:true,publicationPermission:'unknown',replyPermission:'unknown'});
 expect(calls.every(q=>q.startsWith('query'))).toBe(true);
 for(const user of [{id:id(6),active:true,app:true},{id:id(6),active:false,app:false},{id:id(7),active:true,app:false}]){
  expect((await verifyIntegrations(c,async q=>q.includes('user(id:')?{user}:api(q))).humans).toBe(false);
 }
 expect((await verifyIntegrations(c,async()=>({project:{id:id(9)},team:{id:id(2)}}))).identity).toBe(false);
 const failed=await verifyIntegrations(c,async()=>{throw Error('secret token HTTP 401');});
 expect(failed.reachable).toBe(false);expect(JSON.stringify(failed)).not.toContain('secret');
 expect(integrationPreview(c,failed).matrix.every(r=>r.unavailable&&!r.validated)).toBe(true);
});
test('runtime file mismatch and rollback are detected without importing snapshots or changing config',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-integrations-'));
 try{
  const files=['integration-capabilities.ts','linear-blockers.ts','linear-clarifications.ts'];
  for(const dir of ['source','installed']){mkdirSync(join(root,dir,'src'),{recursive:true});for(const file of files)writeFileSync(join(root,dir,'src',file),'throw Error("never execute snapshot")');}
  const source=join(root,'source'),installed=join(root,'installed');
  expect(integrationRuntime(source,installed)).toMatchObject({implemented:true,installed:true,mismatch:false});
  writeFileSync(join(installed,'src/linear-blockers.ts'),'old');expect(integrationRuntime(source,installed).mismatch).toBe(true);
  expect(integrationPreview(config(),evidence,integrationRuntime(source,installed)).matrix.every(r=>!r.validated)).toBe(true);
  writeFileSync(join(installed,'src/linear-blockers.ts'),readFileSync(join(source,'src/linear-blockers.ts')));
  expect(integrationRuntime(source,installed).mismatch).toBe(false);
  rmSync(join(installed,'src/linear-clarifications.ts'));expect(integrationRuntime(source,installed).installed).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('required dispatch blocks before reservation or transport, leaving recovery available',async()=>{
 const s=new Store(':memory:');let sends=0;
 try{
  const w=new Workflow(s,{startPlan:async()=>{sends++;return {id:'session'};},findPlans:async()=>[],evidence:async()=>({}),sendImplementation:async()=>{sends++;},disableFeedback:async()=>{}});
  const c:any={...config(),integrationPolicy:{required:['blockerPublication']}};
  await expect(w.startPlanning('missing',c)).rejects.toThrow('Required integrations');
  await expect(w.executeApproved('missing',c)).rejects.toThrow('Required integrations');
  await expect(w.resume('missing',c)).rejects.toThrow('Required integrations');
  expect(sends).toBe(0);expect(s.db.query('SELECT count(*) AS n FROM planning_dispatch').get()).toEqual({n:0});
 }finally{s.close();}
});

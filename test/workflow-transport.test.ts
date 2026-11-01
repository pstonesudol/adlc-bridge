import {test,expect} from 'bun:test';
import {bridgePlanningHook,createWorkflowTransport} from '../src/workflow-transport';
test('implementation send has a bounded timeout and retains uncertain-delivery handling',async()=>{
 for(const code of [0,1]){let options:any;const transport=createWorkflowTransport(async operation=>operation(),((_args:any,opts:any)=>{options=opts;return {stdout:new Response('').body,stderr:new Response('').body,exited:Promise.resolve(code)};}) as any);
  const result=transport.sendImplementation('worker','prompt','key');if(code===0)await result;else await expect(result).rejects.toThrow('Implementation delivery uncertain');expect(options).toEqual({stdout:'pipe',stderr:'pipe',timeout:30000});
 }
});
test('gate filtering recognizes only the current checkout and managed snapshot paths',()=>{
 const checkout='/work/bridge/src/planning-gate.ts',versions='/home/user/Library/Application Support/ADLC Bridge/versions';
 for(const script of [`'/bin/bun' '${checkout}'`,`bun ${checkout}`,`'/old/bun' '${versions}/abc/src/planning-gate.ts'`])expect(bridgePlanningHook(script,checkout,versions)).toBe(true);
 for(const script of ["bun /other/project/src/planning-gate.ts",`echo '${checkout}' is documentation`,`bun '${versions}-other/abc/src/planning-gate.ts'`,`bun '${versions}/abc/other/src/planning-gate.ts'`,`bun '${checkout}.backup'`,'echo setup'])expect(bridgePlanningHook(script,checkout,versions)).toBe(false);
});

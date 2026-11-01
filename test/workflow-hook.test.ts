import {test,expect} from 'bun:test';
import {workflowGateScripts,planningGateMarker} from '../src/workflow-transport';

test('stable-install hooks replace previous gates exactly once and preserve unrelated scripts',()=>{
 const gate='/stable/releases/release-42/src/planning-gate.ts';
 const scripts=['echo keep',"'/bin/bun' '/stable/releases/release-41/src/planning-gate.ts'",'ADLC execution disabled pending host approval gate','echo keep-too'];
 const once=workflowGateScripts(scripts,gate),twice=workflowGateScripts(once,gate);
 expect(twice).toEqual(once);expect(once).toHaveLength(3);expect(once[0]).toContain(planningGateMarker);expect(once[0]).toContain(gate);expect(once.slice(1)).toEqual(['echo keep','echo keep-too']);
 expect(scripts).toHaveLength(4);
 expect(workflowGateScripts(["bun /code/adlc-bridge/src/planning-gate.ts",...once],gate)).toEqual(once);
 expect(workflowGateScripts(['echo /docs/planning-gate.ts',...once],gate)).toContain('echo /docs/planning-gate.ts');
 expect(()=>workflowGateScripts(['echo keep',null])).toThrow('Unexpected setup scripts');
});
test('legacy replacement keeps user planning-gate scripts outside src for all supported quoting forms',()=>{
 const gate='/stable/releases/release-42/src/planning-gate.ts';
 const unrelated=['bun /srv/myapp/scripts/planning-gate.ts',"'/bin/bun' '/srv/myapp/scripts/planning-gate.ts'",'"/bin/bun" "/srv/my app/scripts/planning-gate.ts"'];
 for(const legacy of ['bun /stable/releases/old/src/planning-gate.ts',"'/bin/bun' '/stable releases/old/src/planning-gate.ts'",'"/bin/bun" "/stable releases/old/src/planning-gate.ts"']){
  const scripts=workflowGateScripts([legacy,...unrelated],gate);
  expect(scripts.slice(1)).toEqual(unrelated);expect(workflowGateScripts(scripts,gate)).toEqual(scripts);
 }
});

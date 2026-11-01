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

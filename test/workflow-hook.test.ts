import {test,expect} from 'bun:test';
import {workflowGateScripts,planningGateMarker} from '../src/workflow-transport';

const shellQuote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
test('known-installation and marked hooks replace exactly once while unrelated scripts survive',()=>{
 const gate='/stable/releases/release-42/src/planning-gate.ts';
 const scripts=['echo keep',`'/bin/bun' ${shellQuote(gate)}`,'ADLC execution disabled pending host approval gate','echo keep-too'];
 const once=workflowGateScripts(scripts,gate),twice=workflowGateScripts(once,gate);
 expect(twice).toEqual(once);expect(once).toHaveLength(3);expect(once[0]).toContain(planningGateMarker);expect(once[0]).toContain(gate);expect(once.slice(1)).toEqual(['echo keep','echo keep-too']);expect(scripts).toHaveLength(4);
 const oldMarked=workflowGateScripts([],'/stable/releases/release-41/src/planning-gate.ts')[0];
 expect(workflowGateScripts([oldMarked,...once],gate)).toEqual(once);
 expect(workflowGateScripts([`'/runtime/bun-1.4.2' '/old/src/planning-gate.ts' # ${planningGateMarker}`,...once],gate)).toEqual(once);
 for(const legacy of [`bun ${gate}`,`"/bin/bun" "${gate}"`])expect(workflowGateScripts([legacy,...once],gate)).toEqual(once);
 expect(workflowGateScripts(['echo /docs/planning-gate.ts',...once],gate)).toContain('echo /docs/planning-gate.ts');
 expect(workflowGateScripts([`echo '${planningGateMarker}'`,...once],gate)).toContain(`echo '${planningGateMarker}'`);
 expect(()=>workflowGateScripts(['echo keep',null])).toThrow('Unexpected setup scripts');
});
test('ambiguous unmarked src gates require reconciliation without changing existing hooks',()=>{
 const gate='/stable/releases/release-42/src/planning-gate.ts';
 for(const unknown of ['bun /srv/myapp/src/planning-gate.ts',"'/bin/bun' '/stable releases/old/src/planning-gate.ts'",'"/bin/bun" "/srv/my app/src/planning-gate.ts"',`'/bin/bun' ${shellQuote("/Users/O' Brien/old-install/src/planning-gate.ts")}`]){
  const scripts=['echo keep',unknown],before=[...scripts];
  expect(()=>workflowGateScripts(scripts,gate)).toThrow('reconcile postCreate ownership');expect(scripts).toEqual(before);
 }
});
test('literal shell-quoted legacy installation paths with apostrophes and whitespace migrate idempotently',()=>{
 const gate="/Users/O' Brien/adlc-bridge/src/planning-gate.ts",bun="/Users/O' Brien/bin/bun";
 const legacy=`${shellQuote(bun)} ${shellQuote(gate)}`;
 const once=workflowGateScripts(['echo keep',legacy],gate);
 expect(once).toHaveLength(2);expect(once[1]).toBe('echo keep');expect(workflowGateScripts(once,gate)).toEqual(once);
 for(const ambiguous of [`${legacy}; echo extra`,`${shellQuote(bun)} "$HOME/src/planning-gate.ts"`])expect(()=>workflowGateScripts([ambiguous],gate)).toThrow('reconcile postCreate ownership');
});
test('legacy replacement keeps user planning-gate scripts outside src for all supported quoting forms',()=>{
 const gate='/stable/releases/release-42/src/planning-gate.ts';
 const unrelated=['bun /srv/myapp/scripts/planning-gate.ts',"'/bin/bun' '/srv/myapp/scripts/planning-gate.ts'",'"/bin/bun" "/srv/my app/scripts/planning-gate.ts"'];
 const scripts=workflowGateScripts(unrelated,gate);
 expect(scripts.slice(1)).toEqual(unrelated);expect(workflowGateScripts(scripts,gate)).toEqual(scripts);
});

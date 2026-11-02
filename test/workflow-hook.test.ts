import {test,expect} from 'bun:test';
import {workflowGateScripts,planningGateMarker} from '../src/workflow-transport';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';

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
test('gate ownership ignores shell comments and bare echo, not literal hashes or path-qualified runners',()=>{
 const gate='/stable/src/planning-gate.ts';
 const unrelated=['echo ready # inspect /srv/myapp/src/planning-gate.ts','printf ready # /srv/myapp/src/planning-gate.ts','echo /srv/myapp/src/planning-gate.ts',"echo '/srv/myapp/src/planning-gate.ts'",'echo ready#literal',"printf '%s' '# /srv/myapp/src/planning-gate.ts'",'echo \\#literal'];
 expect(workflowGateScripts(unrelated,gate).slice(1)).toEqual(unrelated);
 expect(workflowGateScripts(['bun /stable/src/planning-gate.ts # old gate'],gate)).toHaveLength(1);
 for(const unknown of ['/custom/echo /srv/myapp/src/planning-gate.ts','bun /srv/myapp#literal/src/planning-gate.ts','bun /srv/myapp/src/planning-gate.ts # comment'])expect(()=>workflowGateScripts([unknown],gate)).toThrow('reconcile postCreate ownership');
});
test('prefixed and extra-argument gates reject before duplicate insertion even with installation proof',()=>{
 const gate='/stable/src/planning-gate.ts',installation={sourceGate:gate,versions:'/stable/versions'};
 const ambiguous=[`ADLC_MODE=1 bun ${gate}`,`env ADLC_MODE=1 bun ${gate}`,`command bun ${gate}`,`bun --silent ${gate}`,`bun ${gate} extra`,`${gate}`];
 for(const command of ambiguous)for(const proof of [undefined,installation]){
  const scripts=['echo keep',command],before=[...scripts];expect(()=>workflowGateScripts(scripts,gate,proof)).toThrow('reconcile postCreate ownership');expect(scripts).toEqual(before);
 }
 expect(workflowGateScripts([`bun ${gate}`],gate,installation)).toHaveLength(1);expect(workflowGateScripts([`echo ${gate} extra`],gate,installation).slice(1)).toEqual([`echo ${gate} extra`]);
});
for(const candidate of ['bun /unknown/src/planning-gate.ts','ADLC_MODE=1 bun /stable/src/planning-gate.ts'])test(`installer rejects ambiguous postCreate before backups or project-config PUTs: ${candidate}`,()=>{
 const home=mkdtempSync(join(tmpdir(),'adlc-hook-no-write-'));
 try{
  const script=`import {installWorkflowHook} from ${JSON.stringify(join(import.meta.dir,'../src/workflow-transport.ts'))};import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';import {join} from 'node:path';
const home=${JSON.stringify(home)},repo=join(home,'repo'),config=join(home,'project.json'),backups=join(home,'Library/Application Support/ADLC Bridge/backups');mkdirSync(repo);writeFileSync(config,JSON.stringify({repo,automation:{orchestratorProject:'fixture'}}));
const scripts=['echo keep',${JSON.stringify(candidate)}],original={postCreate:scripts,unrelated:true};const results=[];
for(const existing of [false,true]){if(existing){mkdirSync(backups,{recursive:true});writeFileSync(join(backups,'operator-backup'),'preserve');}const before=existing?readdirSync(backups):null,calls=[];let reason='';try{await installWorkflowHook(config,async(_path,method='GET')=>{calls.push(method);return {status:'ok',project:{path:repo,config:original}};});}catch(e){reason=e.message;}results.push({reason,calls,before,after:existsSync(backups)?readdirSync(backups):null,marker:existing?readFileSync(join(backups,'operator-backup'),'utf8'):null,original});}console.log(JSON.stringify(results));`;
  const child=Bun.spawnSync([process.execPath,'-e',script],{env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home},stdout:'pipe',stderr:'pipe'});
  expect(child.exitCode).toBe(0);expect(child.stderr.toString()).toBe('');
  for(const result of JSON.parse(child.stdout.toString())){expect(result.reason).toContain('reconcile postCreate ownership');expect(result.calls).toEqual(['GET']);expect(result.after).toEqual(result.before);expect(result.original).toEqual({postCreate:['echo keep',candidate],unrelated:true});if(result.before)expect(result.marker).toBe('preserve');}
 }finally{rmSync(home,{recursive:true,force:true});}
});

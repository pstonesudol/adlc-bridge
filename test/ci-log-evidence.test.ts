import {test,expect} from 'bun:test';
import {extractCILog,CI_LOG_LIMITS} from '../src/ci-log-evidence';
import {classifyCIFailure,readCIFailure,ciFinding} from '../src/ci-failures';
import {boundedLogCommand} from '../src/gh-logs';
import {incident} from './incidents/harness';
import {ReviewLoop} from '../src/review-loop';

function stream(text:string|Uint8Array,chunk=1024){const bytes=typeof text==='string'?new TextEncoder().encode(text):text;let offset=0;return new ReadableStream<Uint8Array>({pull(c){if(offset===bytes.length)return c.close();c.enqueue(bytes.slice(offset,offset+=Math.min(chunk,bytes.length-offset)));}});}
const failure='test/action-watchdog.test.ts:\nerror: Test exceeded 5000ms\n(fail) idle ready-for-human targets receive ordinary polls past 240 observations without charging retry budget\n';
const check={id:1,sha:'92e39323b857538df0cc96486766ba510d9459a5',name:'Bridge tests',conclusion:'failure',url:'https://github.com/fixture/repo/actions/runs/42440318138/job/128607949593'};
const job={id:128607949593,run_id:42440318138,head_sha:check.sha,name:check.name,status:'completed',conclusion:'failure',check_run_url:'https://api.github.com/repos/fixture/repo/check-runs/1',run_attempt:2,steps:[{number:3,status:'completed',conclusion:'failure'}]};
async function evidence(text:string,change=false){const excerpt=await extractCILog(stream(text));let reads=0;return readCIFailure('fixture/repo',check,async path=>path.endsWith('/logs')?JSON.stringify({ciLogExcerpt:1,...excerpt}):JSON.stringify({...job,run_attempt:change&&++reads>1?3:2}));}

for(const position of ['early','late'])test(`PR42 231911-byte reproduction: failure ${position}, not tail-only`,async()=>{
 const padding='passing fixture Error is expected\n'.repeat(8000);
 const raw=(position==='early'?failure+padding:padding+failure);
 const text=position==='early'?raw.slice(0,231911):padding.slice(0,231911-failure.length-1)+'\n'+failure;
 const result=await evidence(text);expect(result).not.toBeNull();
 const diagnosis=classifyCIFailure(result,['test/**']);expect(diagnosis.classification).toBe('repairable');
 expect(diagnosis.evidence?.provenance).toMatchObject({run:42440318138,job:128607949593,attempt:2,steps:[3]});
 expect(diagnosis.evidence?.truncation.omitted).toBe(true);
 expect(JSON.stringify(ciFinding(check,diagnosis))).not.toContain('Test exceeded');
});
test('UTF8 and ANSI split across single-byte chunks preserve failure context',async()=>{
 const result=await extractCILog(stream('\x1b[31m'+failure+'é雪\x1b[0m\n',1));expect(result.complete).toBe(true);expect(result.text).toContain('é雪');expect(result.text).not.toContain('\x1b');
});
test('passing Error fixtures alone are not failure evidence',async()=>{
 const result=await evidence('test/action-watchdog.test.ts:\n(pass) fixture Error: expected failure\n');expect(classifyCIFailure(result,['test/**']).classification).toBe('unknown');
});
for(const [name,bytes] of [
 ['giant line','x'.repeat(CI_LOG_LIMITS.line+1)],['archive',new Uint8Array([80,75,3,4,0])],['invalid UTF8',new Uint8Array([0xc3,0x28])],['transfer',('ok\n').repeat(Math.ceil(CI_LOG_LIMITS.transfer/3)+1)],['contexts',failure.repeat(65)],
] as const)test(`${name} fails closed without partial evidence`,async()=>{
 const result=await extractCILog(stream(bytes));expect(result.complete).toBe(false);expect(result.text).toBe('');expect(result.reason).toBeTruthy();
});
test('multiple failures retain both paths; attempt change during collection rejects evidence',async()=>{
 const result=await evidence(failure+'test/another.test.ts:\n(fail) another test\n');expect(classifyCIFailure(result,['test/**']).paths).toContain('test/another.test.ts');
 expect(classifyCIFailure(await evidence(failure,true),['test/**']).reason).toContain('attempt changed');
});
test('all failed step identities are preserved; passing steps and unavailable logs cannot authorize repair',async()=>{
 const excerpt=await extractCILog(stream(failure));
 const steps=[...job.steps,{number:4,status:'completed',conclusion:'failure'},{number:5,status:'completed',conclusion:'success'}];
 const result=await readCIFailure('fixture/repo',check,async path=>path.endsWith('/logs')?JSON.stringify({ciLogExcerpt:1,...excerpt}):JSON.stringify({...job,steps}));
 expect(classifyCIFailure(result,['test/**']).evidence?.provenance.steps).toEqual([3,4]);
 for(const change of [{run_attempt:undefined},{steps:[]},{steps:[{number:1,status:'completed',conclusion:'success'}]}]){
  const missing=await readCIFailure('fixture/repo',check,async path=>path.endsWith('/logs')?JSON.stringify({ciLogExcerpt:1,...excerpt}):JSON.stringify({...job,...change}));
  expect(classifyCIFailure(missing,['test/**']).classification).toBe('unknown');
 }
 const missing=await readCIFailure('fixture/repo',check,async path=>{if(path.endsWith('/logs'))throw Error('SECRET_SENTINEL');return JSON.stringify(job);});
 expect(classifyCIFailure(missing,['test/**']).reason).toContain('job logs unavailable');expect(JSON.stringify(missing)).not.toContain('SECRET_SENTINEL');
});
test('truncated summaries and stream interruptions fail closed with fixed secret-safe reasons',async()=>{
 expect((await extractCILog(stream(failure.trimEnd()))).reason).toBe('unterminated failure summary');
 const broken=new ReadableStream<Uint8Array>({start(c){c.error(Error('SECRET_SENTINEL'));}});
 const result=await extractCILog(broken);expect(result.complete).toBe(false);expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL');
});
test('bounded command always reaps process; timeout/nonzero discards otherwise valid excerpts',async()=>{
 for(const code of [0,143]){
  let killed=0;
  const spawn:any=(_args:unknown,options:any)=>{expect(options.timeout).toBe(10);return {stdout:stream(failure),stderr:stream(''),exited:Promise.resolve(code),kill(){killed++;}};};
  const result=await boundedLogCommand(['api','repos/fixture/repo/actions/jobs/3/logs'],10,spawn);
  expect(killed).toBeGreaterThan(0);const parsed=JSON.parse(result.out);expect(parsed.complete).toBe(code===0);if(code)expect(parsed.text).toBe('');
 }
});
test('extracted large-log evidence dispatches once across repeated polls and loop restart',async()=>{
 const f=incident();try{
  const c={...check,sha:f.evidence.head};
  Object.assign(f.evidence,{clear:false,reasons:['Required CI failed'],failedChecks:[c]});
  f.s.db.query('UPDATE review_targets SET allowed_paths=? WHERE job=?').run(JSON.stringify(['test/**']),f.id);
  const extracted=await evidence(failure+'ok\n'.repeat(80000));
  if(!extracted||typeof extracted==='string'||'unavailable' in extracted)throw Error('fixture evidence unavailable');
  extracted.provenance.head=c.sha;
  f.loop.io.readCIFailure=async()=>extracted;f.io.readCIFailure=async()=>extracted;
  await Promise.all([f.loop.tick(f.id),f.loop.tick(f.id)]);
  const restarted=new ReviewLoop(f.s,async()=>{},f.loop.io);
  await restarted.tick(f.id);
  expect(f.calls.filter(x=>x.kind==='send')).toHaveLength(1);expect(f.s.get(f.id).attempts).toBe(1);
  expect(JSON.stringify(f.s.db.query('SELECT * FROM events').all())).not.toContain('Test exceeded');
 }finally{f.s.close();}
});

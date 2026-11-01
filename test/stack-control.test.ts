import {test,expect} from 'bun:test';
import {controlStack,activityBlockers,turnBlockers,workerBlockers,daemonStatus,type StackOps} from '../src/stack-control';
function fixture(){
 const calls:string[]=[];let on=true;let blocks:{session:string;reason:string}[]=[];
 const ops:StackOps={projects:async()=>[{project:'one'},{project:'two'}],project:async(a,id)=>{calls.push(`${a}:${id}`);return {project:id,loaded:a!=='stop'};},backend:async()=>({ready:on,loaded:on,managed:true}),backendStart:async()=>{calls.push('backend:start');on=true;},backendStop:async()=>{calls.push('backend:stop');on=false;},blockers:async()=>{calls.push('workers:check');return blocks;}};
 return {calls,ops,block:(value:typeof blocks)=>blocks=value};
}
test('stack stop pauses all intake before scanning workers and stopping backend',async()=>{const f=fixture();const r=await controlStack('stop',f.ops);expect(f.calls).toEqual(['stop:one','stop:two','workers:check','backend:stop']);expect(r.backend.ready).toBe(false);});
test('busy and queued workers preserve backend and leave intake paused',async()=>{const f=fixture();f.block([{session:'worker',reason:'queued turn'}]);await expect(controlStack('stop',f.ops)).rejects.toThrow('worker (queued turn)');expect(f.calls).toEqual(['stop:one','stop:two','workers:check']);});
test('failed worker inspection cannot stop backend',async()=>{const f=fixture();f.ops.blockers=async()=>{throw Error('unavailable');};await expect(controlStack('stop',f.ops)).rejects.toThrow('unavailable');expect(f.calls).not.toContain('backend:stop');});
test('shared backend is preserved when not bridge managed',async()=>{const f=fixture();f.ops.backend=async()=>({ready:true,loaded:true,managed:false});await expect(controlStack('stop',f.ops)).rejects.toThrow('not managed');expect(f.calls).toEqual(['stop:one','stop:two']);});
test('backend must be ready before enabling any intake',async()=>{const f=fixture();f.ops.backendStart=async()=>{throw Error('startup failed');};await expect(controlStack('start',f.ops)).rejects.toThrow('startup failed');expect(f.calls).toEqual([]);});
test('stack start and repeated stop are ordered and safe',async()=>{const f=fixture();await controlStack('stop',f.ops);f.calls.length=0;await controlStack('stop',f.ops);expect(f.calls).toEqual(['stop:one','stop:two','backend:stop']);f.calls.length=0;await controlStack('start',f.ops);expect(f.calls).toEqual(['backend:start','start:one','start:two']);});
test('status does not mutate services',async()=>{const f=fixture();await controlStack('status',f.ops);expect(f.calls).toEqual(['service-status:one','service-status:two']);});
test('unknown worker activity and queued turns block; idle and terminal work do not',()=>{expect(activityBlockers([{id:'idle',activity:{state:'idle'}},{id:'busy',activity:{state:'working'}},{id:'unknown'},{id:'gone',isTerminated:true}])).toEqual([{session:'busy',reason:'working'},{session:'unknown',reason:'unknown activity'}]);expect(turnBlockers('one',{turns:[{state:'completed'},{state:'queued'},{state:'running'}]})).toEqual([{session:'one',reason:'queued turn'},{session:'one',reason:'running turn'}]);expect(()=>turnBlockers('one',{})).toThrow('Cannot verify');});
const inspect=async()=>({ready:true,executablePath:'/ao',port:3001});
const idle={id:'worker',activity:{state:'idle'}};
test('queued work appearing during final idle inventory recheck prevents backend shutdown',async()=>{
 const f=fixture();let conversations=0;
 f.ops.blockers=()=>workerBlockers('/ao',inspect,async(_port,path)=>path==='sessions'?{sessions:[idle]}:{turns:++conversations===1?[]:[{state:'queued'}]});
 await expect(controlStack('stop',f.ops)).rejects.toThrow('queued turn');expect(conversations).toBe(2);expect(f.calls).not.toContain('backend:stop');
});
test('worker inventory rejects new sessions, unreadable conversations and malformed listings',async()=>{
 let lists=0;
 expect(await workerBlockers('/ao',inspect,async(_port,path)=>path==='sessions'?{sessions:++lists===1?[idle]:[idle,{...idle,id:'new'}]}:{turns:[]})).toContainEqual({session:'new',reason:'new session during stop'});
 await expect(workerBlockers('/ao',inspect,async(_port,path)=>{if(path==='sessions')return {sessions:[idle]};throw Error('unreadable');})).rejects.toThrow('unreadable');
 for(const badAt of [1,2]){lists=0;await expect(workerBlockers('/ao',inspect,async(_port,path)=>path==='sessions'?(++lists===badAt?{}:{sessions:[idle]}):{turns:[]})).rejects.toThrow('Cannot');}
 await expect(workerBlockers('/ao',inspect,async()=>({sessions:[{...idle,id:'bad/id'}]}))).rejects.toThrow('identity');
 expect(await workerBlockers('/ao',inspect,async()=>({sessions:[{id:'gone',isTerminated:true},{id:'exited',activity:{state:'exited'}}]}))).toEqual([]);
});
test('unready backend after start leaves every intake stopped',async()=>{const f=fixture();f.ops.backend=async()=>({ready:false,loaded:true,managed:true});await expect(controlStack('start',f.ops)).rejects.toThrow('not ready');expect(f.calls).toEqual(['backend:start']);});
test('daemon status handles both stopped states and fails closed on errors or malformed output',()=>{
 for(const state of ['stopped','not_running'])expect(daemonStatus({stdout:JSON.stringify({state}),code:0})).toEqual({ready:false});
 for(const stdout of ['no json','null','{}','{"state":"ready","port":0}'])expect(()=>daemonStatus({stdout,code:0})).toThrow();
 expect(()=>daemonStatus({stdout:'null',code:0})).toThrow('readiness is unknown');
 expect(()=>daemonStatus({stdout:'{"state":"stopped"}',code:1})).toThrow('readiness is unknown');
 expect(daemonStatus({stdout:'{"state":"ready","port":3001}',code:0})).toMatchObject({ready:true,port:3001});
});

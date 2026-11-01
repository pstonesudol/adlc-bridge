import {test,expect} from 'bun:test';import {mkdtempSync,writeFileSync,readFileSync,readdirSync,chmodSync,rmSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {acknowledgePoll,assertPollQuiescent} from '../src/poll-process';import {stopLoadedIntake} from '../src/service-control';import {turnBarrier} from '../src/turn-submission';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'adlc-poll-proof-')),state=join(root,'state'),config=join(root,'project.json'),cli=join(root,'cli.ts');writeFileSync(config,'{}');writeFileSync(cli,'barrier-aware CLI');const turns=turnBarrier(state);
 const started=()=> 'known start',verify=(status:any,c=config,program=cli)=>assertPollQuiescent(status,c,program,state,started);
 return {root,state,config,cli,turns,started,verify,receipt:()=>join(state,'poll-processes',readdirSync(join(state,'poll-processes'))[0]),close:()=>rmSync(root,{recursive:true,force:true})};
}
test('loaded legacy intake is preserved even when the new barrier is available and launchd reports idle',async()=>{
 const f=fixture();try{let bootouts=0;for(const status of [{loaded:true,running:true,pid:process.pid},{loaded:true,running:false}])await f.turns.run(async()=>{await expect(stopLoadedIntake(status,f.config,f.cli,async()=>{bootouts++;},f.verify)).rejects.toThrow('barrier support is unverified');});expect(bootouts).toBe(0);
  await stopLoadedIntake({loaded:false},f.config,f.cli,async()=>{bootouts++;},()=>{throw Error('Unloaded legacy service needs no receipt');});expect(bootouts).toBe(0);
 }finally{f.close();}
});
test('barrier-aware running and cleanly completed poll receipts allow fenced stop without changing start/status behavior',async()=>{
 const f=fixture();try{
  const finished=await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit);let bootouts=0;
  await f.turns.run(()=>stopLoadedIntake({loaded:true,running:true,pid:process.pid},f.config,f.cli,async()=>{bootouts++;},f.verify));
  await expect(stopLoadedIntake({loaded:true,running:false},f.config,f.cli,async()=>{bootouts++;},f.verify)).rejects.toThrow('quiescence is unverified');
  finished();await f.turns.run(()=>stopLoadedIntake({loaded:true,running:false},f.config,f.cli,async()=>{bootouts++;},f.verify));expect(bootouts).toBe(2);
 }finally{f.close();}
});
test('reused PIDs, changed CLI bytes, insecure and symlinked receipts never establish service quiescence',async()=>{
 const f=fixture();try{
  await acknowledgePoll(f.config,f.cli,f.state,f.started,f.turns.submit);const status={pid:process.pid,running:true},path=f.receipt(),original=readFileSync(path);
  expect(()=>f.verify({...status,pid:process.pid+1})).toThrow('has not acknowledged');expect(()=>assertPollQuiescent(status,f.config,f.cli,f.state,()=> 'reused PID start')).toThrow('has not acknowledged');
  writeFileSync(f.cli,'different process code');expect(()=>f.verify(status)).toThrow('does not match');writeFileSync(f.cli,'barrier-aware CLI');chmodSync(path,0o644);expect(()=>f.verify(status)).toThrow('owner-only');chmodSync(path,0o600);
  const other=join(f.root,'receipt');writeFileSync(other,original,{mode:0o600});rmSync(path);symlinkSync(other,path);expect(()=>f.verify(status)).toThrow('owner-only');
 }finally{f.close();}
});

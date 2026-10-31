import {test,expect} from 'bun:test';
import {decision,ReviewLoop} from '../src/review-loop';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {Lifecycle} from '../src/lifecycle';
const pending=()=>({clear:false,reasons:['CodeRabbit absent'],failedChecks:[],findings:[]});
test('missing/pending review waits then blocks; never becomes success or spends an attempt',()=>{
 expect(decision(pending(),['a'],0).state).toBe('waiting_for_coderabbit');
 expect(decision(pending(),['a'],30*60*1000)).toMatchObject({state:'blocked',send:false});
 expect(decision({...pending(),clear:true},['a'],0).state).toBe('ready_for_human');
});
test('only current actionable findings within ticket file scope are sent to the worker',()=>{
 expect(decision({...pending(),findings:[{path:'a',body:'fix'}]},['a'],0).send).toBe(true);
 expect(decision({...pending(),findings:[{path:'backend/secrets.py',body:'fix'}]},['a'],0)).toMatchObject({state:'blocked',send:false});
 expect(decision({...pending(),failedChecks:[{name:'backend'}]},['a'],0).send).toBe(false);
 expect(decision({...pending(),findings:[{kind:'pr_description',path:null,body:'exact verification commands'}]},['a'],0).send).toBe(true);
});
test('review registration is restart-safe and cannot silently change PR or scope',()=>{
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('p','i','spec'),r=p.reserve(id,'project');
 p.gate(id,'project','session',r.branch,'/worktree');const hash=s.propose(id,'plan');s.approve(id,hash,'human');
 new Lifecycle(s).adoptSupervised(id,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
 const loop=new ReviewLoop(s);loop.register(id,'owner/repo',1,['CI'],['a'],true);
 expect(loop.register(id,'owner/repo',1,['CI'],['a'],true).pr).toBe(1);
 expect(()=>loop.register(id,'owner/repo',2,['CI'],['a'],true)).toThrow();expect(loop.list().length).toBe(1);s.close();
});


test('CI waits are distinct from CodeRabbit waits; no approval is inferred',()=>{
 expect(decision({...pending(),pendingChecks:['CI']},['a'],0).state).toBe('waiting_for_ci');
 expect(decision({...pending(),missingChecks:['CI']},['a'],0).state).toBe('waiting_for_ci');
});

test('full review requests survive lost replies without duplicate comments',async()=>{
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('p','i','spec'),r=p.reserve(id,'project');
 p.gate(id,'project','session',r.branch,'/worktree');const hash=s.propose(id,'plan');s.approve(id,hash,'human');
 new Lifecycle(s).adoptSupervised(id,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
 let calls=0;const loop=new ReviewLoop(s,async()=>{calls++;throw Error('Reply lost');});loop.register(id,'owner/repo',1,['CI'],['a'],true);
 await expect(loop.requestReview(id,'sha','body')).rejects.toThrow('lost');
 expect(await loop.requestReview(id,'sha','body')).toBe(false);expect(calls).toBe(1);
 expect((s.db.query('SELECT state FROM full_review_requests').get() as any).state).toBe('delivery_uncertain');s.close();
});

test('one project service cannot select another project’s PR targets',()=>{
 const s=new Store(':memory:'),p=new Planning(s),loop=new ReviewLoop(s);
 for(const project of ['a','b']){const id=s.enqueue(project,'issue','spec'),r=p.reserve(id,project);p.gate(id,project,project,r.branch,`/${project}`);const hash=s.propose(id,'plan');s.approve(id,hash,'human');new Lifecycle(s).adoptSupervised(id,{id:project,correlation:r.correlation,worktree:`/${project}`,controller:'running'});loop.register(id,'owner/repo',project==='a'?1:2,['CI'],['src/**'],true);}
 expect(loop.list('a').map(t=>t.pr)).toEqual([1]);expect(loop.list('b').map(t=>t.pr)).toEqual([2]);expect(loop.list().length).toBe(2);s.close();
});

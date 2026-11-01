import {test,expect} from 'bun:test';
import {Store} from '../src/core';import {Planning} from '../src/planning';
import {Workflow,type WorkflowTransport} from '../src/workflow';
import {TaskRouting,type Route} from '../src/task-routing';
import {routingConfig,settings} from './routing-fixture';
const config={repo:'/repo',linear:{projectId:'p'},requiredChecks:['CI'],automation:{planningEnabled:true,orchestratorProject:'project',maxPlanning:1},routing:settings};
const ops=['inspect','fetch','worktree','branch','commit','push-feature','open-pr'];
class Fake implements WorkflowTransport{
 session:any;start:any;configured:Route[]=[];messages:any[]=[];lost=false;drop=false;failControl=false;
 constructor(public s:Store){}
 async preflightRoute(_route:Route){}
 async startPlan(r:any){this.start=r;const row=this.s.db.query('SELECT job FROM planning_runs WHERE branch=?').get(r.branch) as any;new Planning(this.s).gate(row.job,r.project,'session',r.branch,'/worktree');this.session={session:{id:'session',projectId:r.project,branch:r.branch,harness:r.route.harness,isTerminated:false},transcript:{controller:'ready',entries:[],turns:[]}};return {id:'session'};}
 async findPlans(){return [this.session.session];}
 async evidence(){return this.session;}
 async disableFeedback(){}
 async configureRoute(_id:string,route:Route){if(this.failControl)throw Error('Setting unsupported');this.configured.push(route);}
 async sendImplementation(id:string,prompt:string,clientId:string){
  this.messages.push({id,prompt,clientId,route:this.configured.at(-1)});
  if(this.drop)throw Error('No receipt');
  const plan=clientId.startsWith('adlc-plan-message-'),turn=plan?'plan':'implement';
  this.session.transcript.entries.push({sequence:1,role:'user',kind:'message',clientMessageId:clientId,turnId:turn,text:prompt});
  this.session.transcript.turns.push({id:turn,state:plan?'completed':'running'});
  if(plan){this.session.transcript.entries.push({sequence:2,role:'assistant',kind:'message',origin:'provider',streaming:false,turnId:turn,text:prompt.match(/<!-- ADLC_PLAN_READY:[a-f0-9]+ -->/)![0]+'\nChange src/a.ts and run lint.\n<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready","questions":[],"dependencies":[],"risks":[]} -->'});}
  else this.session.transcript.controller='busy';
  if(this.lost)throw Error('Lost response after delivery');
 }
}
function fixture(){const s=new Store(':memory:'),f=new Fake(s),router=new TaskRouting(s,async()=>({config:routingConfig,classify:async()=>({choice:'implement',confidence:0.95})})),w=new Workflow(s,f,router),id=s.enqueue('p','i','Update src/a.ts');return {s,f,router,w,id};}
test('planning and approved implementation use separate pinned routes in the same session',async()=>{
 const {s,f,router,w,id}=fixture();try{
 await w.tick(config);expect(f.messages.length).toBe(1);expect(f.messages[0].route.model).toBe('openai/luna');expect(f.messages[0].route.mode).toBe('plan');
 await w.tick(config);expect(s.get(id).state).toBe('awaiting_approval');expect(f.messages.length).toBe(1);expect(router.get(id,'implementation')).toBeTruthy();
 w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops);await w.tick(config);
 expect(f.messages.length).toBe(2);expect(f.messages[1].route.model).toBe('openai/sol');expect(f.messages[1].route.effort).toBe('medium');expect(f.messages[1].id).toBe(f.messages[0].id);
 await w.tick(config);expect(f.messages.length).toBe(2);
 }finally{s.close();}
});
test('lost planning reply is reconciled without duplicate delivery',async()=>{
 const {s,f,w}=fixture();try{f.lost=true;await w.tick(config);await w.tick(config);expect(f.messages.length).toBe(1);}finally{s.close();}
});
test('absent planning receipt blocks rather than resending',async()=>{
 const {s,f,w}=fixture();try{f.drop=true;await w.tick(config);const result=await w.tick(config);expect(result[0].state).toBe('needs_reconciliation');expect(f.messages.length).toBe(1);}finally{s.close();}
});
test('unsupported provider control never sends a planning task',async()=>{
 const {s,f,w}=fixture();try{f.failControl=true;await w.tick(config);await w.tick(config);expect(f.messages.length).toBe(0);expect(f.start).toBeTruthy();}finally{s.close();}
});
test('tampering with an approved routing decision blocks implementation',async()=>{
 const {s,f,w,router,id}=fixture();try{await w.tick(config);await w.tick(config);w.approve(id,s.get(id).plan_hash,'human',['src/a.ts'],'supervised-host',ops);
 const row=router.get(id,'implementation'),route=JSON.parse(row.route);route.model='openai/unapproved';s.db.query('UPDATE task_routes SET route=? WHERE job=? AND phase=?').run(JSON.stringify(route),id,'implementation');
 const result=await w.tick(config);expect(result[0].error).toContain('human approval');expect(f.messages.length).toBe(1);
 }finally{s.close();}
});

test('provider/authentication failure becomes blocked rather than appearing to run forever',async()=>{
 const {s,f,w}=fixture();try{await w.tick(config);f.session.transcript.turns[0].state='failed';f.session.transcript.entries=f.session.transcript.entries.filter((x:any)=>x.role!=='assistant');
 const result=await w.tick(config);expect(result[0].state).toBe('needs_reconciliation');expect(f.messages.length).toBe(1);
 }finally{s.close();}
});

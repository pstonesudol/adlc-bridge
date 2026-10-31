import {Store} from '../src/core';import {FeaturePlanning,type FeatureAgents} from '../src/feature-planning';
import {routingConfig,settings} from './routing-fixture';
export const requirements={title:'Test feature',requirements:[{id:'R1',text:'Create a form'},{id:'R2',text:'Validate its entries'}],constraints:[],outOfScope:[]};
export const draft={summary:'Deliver form and validation',assumptions:[],questions:[],tickets:[
 {key:'T1',title:'Create form',description:'Create the bounded form.',requirementIds:['R1'],acceptanceCriteria:['Form accepts input'],verification:['Test form inputs'],dependsOn:[]},
 {key:'T2',title:'Validate entries',description:'Validate form entries.',requirementIds:['R2'],acceptanceCriteria:['Invalid entries show errors'],verification:['Test invalid cases'],dependsOn:['T1']}
]};
export const featureConfig={name:'Test',repo:'/repo',linear:{projectId:'00000000-0000-0000-0000-000000000001',teamId:'00000000-0000-0000-0000-000000000002',readyLabelId:'00000000-0000-0000-0000-000000000003',readyStateId:'00000000-0000-0000-0000-000000000004'},routing:settings,featurePlanning:{enabled:true,backlogStateId:'00000000-0000-0000-0000-000000000005',maxAgents:3,maxTickets:10}};
export class Agents implements FeatureAgents{
 sessions=new Map<string,any>();starts:any[]=[];messages:any[]=[];stopped:string[]=[];loseSpawn=false;loseSend=false;question=false;
 async start(r:any){const id='session-'+(this.starts.length+1);this.starts.push(r);this.sessions.set(id,{session:{id,displayName:r.name,projectId:'',harness:r.route.harness,isTerminated:false},transcript:{controller:'ready',entries:[],turns:[]}});if(this.loseSpawn){this.loseSpawn=false;throw Error('Lost spawn reply');}return {id};}
 async find(name:string){return [...this.sessions.values()].map(e=>e.session).filter(s=>s.displayName===name);}
 async evidence(id:string){return this.sessions.get(id);}
 async configure(_id:string,route:any){if(route.mode!=='plan')throw Error('Planning must be read-only');}
 async send(id:string,prompt:string,key:string){
  this.messages.push({id,prompt,key});const e=this.sessions.get(id),marker=prompt.match(/<!-- ADLC_FEATURE_RESULT:[a-f0-9]+:([a-z]+) -->/)!,role=marker[1];
  const result=role==='synthesis'?draft:{summary:role+' review',recommendations:['Keep it bounded'],questions:this.question&&role==='quality'?['Confirm a product decision']:[]};
  e.transcript.entries=[{kind:'message',role:'user',clientMessageId:key,turnId:'turn'},{kind:'message',role:'assistant',origin:'provider',streaming:false,turnId:'turn',text:marker[0]+'\n'+JSON.stringify(result)}];e.transcript.turns=[{id:'turn',state:'completed'}];
  if(this.loseSend){this.loseSend=false;throw Error('Lost send reply');}
 }
 async stop(id:string){this.stopped.push(id);}
}
export function featureFixture(){const s=new Store(':memory:'),agents=new Agents(),planner=new FeaturePlanning(s,agents,async()=>({config:routingConfig,classify:async()=>({choice:'planning',confidence:1})}));return {s,agents,planner};}
export async function plannedFeature(){const f=featureFixture(),{id}=await f.planner.create(featureConfig,JSON.stringify(requirements),'Test');for(let n=0;n<4;n++)await f.planner.tick(id);return {...f,id};}

import type {RoutingConfig} from '../src/task-routing';
export const routingConfig:RoutingConfig={enabled:true,minConfidence:0.6,fallback:{model:{providerID:'opencode-go',modelID:'flash'}},categories:[
 {id:'planning',enabled:true,description:'Plan only',model:{providerID:'openai',modelID:'luna'},variant:'high'},
 {id:'implement',enabled:true,description:'Ordinary file changes',model:{providerID:'openai',modelID:'sol'},variant:'medium',agent:'build'},
 {id:'hard',enabled:true,description:'Exceptional complexity',model:{providerID:'openai',modelID:'astra'},variant:'high'},
 {id:'testing',enabled:true,description:'Test focused',model:{providerID:'openai',modelID:'sol'},variant:'low'}
]};
export const settings={enabled:true,dataDir:'/config/openchamber',runtimeDir:'/runtime/routing',harness:'opencode-v2' as const};

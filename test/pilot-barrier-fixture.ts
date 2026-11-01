// Subprocess fixture: provider I/O is stubbed, but pilotIO.submit is production.
import {Store} from '../src/core';import {Planning} from '../src/planning';import {Lifecycle} from '../src/lifecycle';import {ReviewLoop} from '../src/review-loop';import {sendPilotRemediation} from '../src/pilot';import {turnBarrier} from '../src/turn-submission';
const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('project','issue','spec'),r=p.reserve(id,'ao');p.gate(id,'ao','session',r.branch,'/worktree');const hash=s.propose(id,'plan');s.approve(id,hash,'human');
const l=new Lifecycle(s);l.grantGit(id,hash,['open-pr'],'human');l.adoptSupervised(id,{id:'session',correlation:r.correlation,worktree:'/worktree',controller:'running'});
const head='a'.repeat(40),e:any={clear:false,reasons:['metadata failed'],head,descriptionHash:'body',templateSignature:'check',findings:[{kind:'pr_description',source:'github-ci',check:'metadata',checkId:1,descriptionHash:'body',sha:head}],failedChecks:[{id:1,sha:head,name:'metadata'}],pendingChecks:[],missingChecks:[],coderabbitPending:false,coderabbitPresent:true};
const session:any={session:{id:'session',prs:[{number:1,url:'https://github.com/owner/repo/pull/1'}]},transcript:{controller:'ready',entries:[],turns:[]}};let sends=0;
const providers:any={readiness:async()=>e,sessionEvidence:async()=>session,spawn:()=>{sends++;return {stdout:new Response('{}').body,stderr:new Response('').body,exited:Promise.resolve(0)};}};
const loop=new ReviewLoop(s,async()=>{},{readiness:providers.readiness,sessionEvidence:providers.sessionEvidence,disableNativeFeedback:async()=>({}),sendPilotRemediation:(...args:any[])=>sendPilotRemediation(...args as Parameters<typeof sendPilotRemediation>,providers)} as any);
loop.configureMetadataChecks('project',['metadata']);loop.register(id,'owner/repo',1,['CI'],['src/**'],true);
try{
 let rejection='';await turnBarrier().run(async()=>{try{await loop.tick(id);}catch(e:any){rejection=e.message;}});
 console.log(JSON.stringify({rejection,sends,attempts:s.get(id).attempts,rows:s.db.query('SELECT * FROM remediation').all()}));
}finally{s.close();}

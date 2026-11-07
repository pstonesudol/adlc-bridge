import {expect} from 'bun:test';
import {Store} from '../../src/core';
import {Planning} from '../../src/planning';
import {Lifecycle} from '../../src/lifecycle';
import {ReviewLoop} from '../../src/review-loop';
import {sendPilotRemediation} from '../../src/pilot';

export function seededRandom(seed=78){
 return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
}

/** All storage is private in-memory SQLite. Every reachable provider edge is
 * injected. Unexpected branch ancestry or mutations fail closed, never fall
 * through to a real provider. Initial approval is fixture setup, not recovery. */
export function incident(){
 const s=new Store(':memory:'),p=new Planning(s);
 const id=s.enqueue('incident','DEV-78','Repair src/example.ts only');
 const reservation=p.reserve(id,'fake-project');
 p.gate(id,'fake-project','fake-session',reservation.branch,'/incident-worktree');
 const hash=s.propose(id,'Approved incident fixture');s.approve(id,hash,'fixture-human');
 const lifecycle=new Lifecycle(s);
 lifecycle.grantGit(id,hash,['commit','push-feature','open-pr'],'fixture-human');
 lifecycle.adoptSupervised(id,{id:'fake-session',correlation:reservation.correlation,worktree:'/incident-worktree',controller:'running'});
 const head='a'.repeat(40);
 const evidence:any={head,clear:true,reasons:[],findings:[],failedChecks:[],pendingChecks:[],missingChecks:[],descriptionHash:'body-1',templateSignature:'checks-1',botReviewSubmittedAt:Date.now()+1,coderabbitPending:false,coderabbitPresent:true};
 const session:any={receiptObservation:{complete:true,observed:Date.now()},session:{id:'fake-session',branch:reservation.branch,isTerminated:false,prs:[{number:1,url:'https://github.com/fixture/repo/pull/1'}]},transcript:{controller:'ready',entries:[],turns:[]}};
 const calls:{kind:string;key:string}[]=[];
 const forbidden=(kind:string)=>{calls.push({kind,key:kind});throw Error(`Forbidden incident capability: ${kind}`);};
 const io:any={
  readiness:async()=>evidence,
  sessionEvidence:async()=>session,
  readBranchSnapshot:async()=>({head:evidence.head,base:'b'.repeat(40),branch:reservation.branch,baseBranch:'main',defaultBranch:'main',headRepo:'fixture/repo',baseRepo:'fixture/repo',state:'open',draft:false,mergeable:true,behind:0}),
  worktreeIdentity:async()=>({tree:'/incident-worktree',branch:reservation.branch,head:evidence.head}),
  contains:async()=>forbidden('unexpected-ancestry'),
  disableNativeFeedback:async()=>({}),
  submit:async(operation:()=>unknown)=>operation(),
  spawn:(args:string[])=>{
   expect(args[0].split('/').at(-1)).toBe('ao');
   const key=args[args.indexOf('--client-message-id')+1];
   expect(key).toStartWith('adlc-fix-');
   calls.push({kind:'send',key});
   const turnId=`turn-${calls.length}`;
   session.transcript.entries.push({clientMessageId:key,turnId});
   session.transcript.turns.push({id:turnId,state:'running'});
   return {stdout:new Response('{}').body,stderr:new Response('').body,exited:Promise.resolve(0)};
  },
 };
 const loop=new ReviewLoop(s,async(_repo,_pr,marker)=>{calls.push({kind:'review-request',key:marker!});}, {
  ...io,
  sendPilotRemediation:(...args:Parameters<typeof sendPilotRemediation>)=>sendPilotRemediation(...args,io),
 });
 loop.configureMetadataChecks('incident',[]);
 loop.register(id,'fixture/repo',1,['CI'],['src/example.ts'],true);
 const interventions:string[]=[];
 return {s,id,loop,evidence,session,io,calls,interventions,
  operator:(command:string)=>{interventions.push(command);},
  complete:()=>{for(const turn of session.transcript.turns)turn.state='completed';evidence.head='c'.repeat(40);evidence.clear=true;evidence.findings=[];evidence.failedChecks=[];},
  assertSafe:(operators=0)=>{
   expect(interventions).toHaveLength(operators);
   expect(calls.every(c=>['send','review-request'].includes(c.kind))).toBe(true);
   expect(new Set(calls.map(c=>`${c.kind}:${c.key}`)).size).toBe(calls.length);
   expect(loop.list()).toHaveLength(1);
   expect(loop.get(id)).toMatchObject({repo:'fixture/repo',pr:1,allowed_paths:JSON.stringify(['src/example.ts'])});
   expect(s.get(id).spec).toBe('Repair src/example.ts only');
   expect((s.db.query('SELECT operations FROM git_grants WHERE job=?').get(id) as any).operations).toBe(JSON.stringify(['commit','push-feature','open-pr']));
  },
 };
}

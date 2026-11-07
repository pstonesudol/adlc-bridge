import {test,expect} from 'bun:test';
import {latestWorkflowChecks} from '../src/check-runs';
import {reviewGate} from '../src/core';
import {requiredCheckState} from '../src/github';
import {decision} from '../src/review-loop';
const head='1736c394c64a1f4bf10fb021e147a0214d557889';
function check(id:number,conclusion:string|null='success',over:any={}){return {id,name:'PR body structure',head_sha:head,app:{id:15368,slug:'github-actions'},status:'completed',conclusion,started_at:'2026-11-07T14:45:00Z',completed_at:`2026-11-07T14:45:${String(id).padStart(2,'0')}Z`,...over};}
const bot=()=>check(10,'success',{name:'CodeRabbit',app:{id:100,slug:'coderabbitai'}});
function evidence(raw:any[],required=['PR body structure']){
 const gate=reviewGate({head,observedHead:head,required,checks:raw.map(c=>({...c,sha:c.head_sha,app:c.app.slug})),review:{sha:head,author:'coderabbitai[bot]',state:'APPROVED'},unresolved:0,threadsComplete:true,checksComplete:true,reviewComplete:true});
 return {head,...gate,...requiredCheckState(raw,head,required),findings:[]};
}
function variants(raw:any[]){return [raw,[...raw].reverse(),[...raw.slice(1),raw[0]]];}
test('latest attempt is independent of response order and conclusion',()=>{
 for(const [before,after,state] of [['success','cancelled','waiting_for_ci'],['cancelled','success','ready_for_human'],['failure','success','ready_for_human'],['success','failure','blocked']] as const){
  for(const raw of variants([check(1,before),check(2,after),bot()])){
   expect(latestWorkflowChecks(raw).find(c=>c.name==='PR body structure')?.id).toBe(2);
   const e=evidence(raw);
   expect(e.clear).toBe(state==='ready_for_human');
   expect(e.failedChecks.map(c=>c.conclusion)).toEqual(after==='failure'?['failure']:[]);
   expect(e.pendingChecks).toEqual(after==='cancelled'?['PR body structure']:[]);
   expect(decision(e,['src/**'],0)).toMatchObject({state,send:false});
  }
 }
});
test('completed timestamp, started timestamp and provider ID deterministically order attempts',()=>{
 const pairs=[
  [check(20,'failure',{completed_at:'2026-11-07T14:45:01Z'}),check(1,'success',{completed_at:'2026-11-07T14:46:00Z'})],
  [check(20,'failure'),check(1,null,{status:'in_progress',started_at:'2026-11-07T14:46:00Z',completed_at:null})],
  [check(20,'failure',{completed_at:null}),check(1,'success',{started_at:'2026-11-07T14:46:00Z',completed_at:null})],
  [check(1,'failure',{completed_at:null}),check(2,'success',{completed_at:null})],
  [check(1,'failure',{completed_at:'invalid',started_at:null}),check(2,'success',{completed_at:null,started_at:null})]
 ];
 for(const pair of pairs)for(const raw of variants(pair))expect(latestWorkflowChecks(raw)).toEqual([pair[1]]);
});
test('newest cancellation or incomplete/unknown result stays pending, never a pass or failure',()=>{
 for(const last of [check(2,'cancelled'),check(2,null),check(2,'neutral'),check(2,'skipped'),check(2,'stale'),check(2,'unknown'),check(2,null,{status:'queued',started_at:'2026-11-07T14:46:00Z',completed_at:null}),check(2,null,{status:'queued',started_at:null,completed_at:null})]){
  const e=evidence([check(1),last,bot()]);
  expect(e).toMatchObject({clear:false,failedChecks:[],pendingChecks:['PR body structure'],missingChecks:[]});
  expect(decision(e,['src/**'],0)).toMatchObject({state:'waiting_for_ci',send:false});
 }
});
test('app and head are part of identity; another logical success cannot hide a failure',()=>{
 const failed=check(1,'failure'),otherApp=check(2,'success',{app:{id:99,slug:'other'}}),base=check(3,'success',{head_sha:'b'.repeat(40)}),otherName=check(4,'success',{name:'CI'});
 for(const raw of variants([failed,otherApp,base,otherName,bot()])){
  expect(latestWorkflowChecks(raw)).toHaveLength(5);
  const e=evidence(raw,['PR body structure','CI']);
  expect(e.failedChecks.map(c=>c.id)).toEqual([1]);
  expect(decision(e,['src/**'],0)).toMatchObject({state:'blocked',send:false});
 }
 expect(evidence([otherApp,base,bot()])).toMatchObject({clear:false,failedChecks:[],pendingChecks:[],missingChecks:['PR body structure']});
 expect(evidence([check(1),check(3,'failure',{head_sha:'base'}),bot()]).clear).toBe(true);
});
test('CodeRabbit skipped never becomes success, including after an earlier success',()=>{
 const skipped={...bot(),id:11,conclusion:'skipped',completed_at:'2026-11-07T14:46:00Z'};
 for(const raw of variants([check(1),bot(),skipped])){
  const e=evidence(raw);expect(e.clear).toBe(false);expect(e.reasons).toEqual(['CodeRabbit check not clear']);
  expect(decision(e,['src/**'],0)).toMatchObject({state:'waiting_for_coderabbit',send:false});
 }
});
test('unorderable required attempts remain ambiguous and unrequired duplicates do not block',()=>{
 const ambiguous={...check(1),id:undefined,started_at:undefined,completed_at:undefined};
 const e=evidence([ambiguous,{...ambiguous},bot()]);
 expect(e).toMatchObject({clear:false,pendingChecks:['PR body structure']});
 expect(evidence([check(1),bot(),{...ambiguous,name:'unrequired'},{...ambiguous,name:'unrequired'}]).clear).toBe(true);
});
test('PR #150 shape resolves cancelled duplicates by chronology, not numeric ID or array order',()=>{
 const raw=[
  check(128434655570,'cancelled',{completed_at:'2026-11-07T14:45:31Z'}),
  check(128434660661,'success',{completed_at:'2026-11-07T14:46:00Z'}),
  check(128434542357,'success',{completed_at:'2026-11-07T14:47:00Z'}),
  check(128434655571,'success',{name:'Conventional Commits title',completed_at:'2026-11-07T14:45:31Z'}),
  check(128434660662,'success',{name:'Conventional Commits title',completed_at:'2026-11-07T14:46:00Z'}),bot()
 ];
 for(const input of variants(raw)){
  const e=evidence(input,['PR body structure','Conventional Commits title']);
  expect(e).toMatchObject({clear:true,reasons:[],failedChecks:[],pendingChecks:[],missingChecks:[]});
  expect(decision(e,['src/**'],0)).toEqual({state:'ready_for_human',send:false,reason:'Latest-SHA CI and CodeRabbit gate passed'});
  const absentReview={...e,clear:false,reasons:['Explicit latest-SHA CodeRabbit approval missing']};
  expect(decision(absentReview,['src/**'],0)).toMatchObject({state:'waiting_for_coderabbit',send:false});
 }
});

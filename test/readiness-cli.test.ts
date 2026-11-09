import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {digest} from '../src/core';
import {REVIEW_THREADS_QUERY,REVIEW_THREAD_COMMENTS_QUERY} from '../src/github';
import {CONFIG_QUERY} from '../src/coderabbit-scheduling';
import {BODY_VERSION_QUERY} from '../src/coderabbit-checks';
import {customFixture} from './coderabbit-fixture';

test('real readiness CLI gates otherwise-successful metadata checks on body evidence, but not an empty policy',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-readiness-cli-'));try{
  const head='a'.repeat(40),base='b'.repeat(40),config=join(root,'config.json'),db=join(root,'unused.sqlite');
   const pr={number:1,user:{id:8},changed_files:1,labels:[],head:{sha:head,repo:{full_name:'owner/repo'}},base:{sha:base,ref:'main'},state:'open',draft:false,mergeable:true,body:'current PR description',html_url:'https://github.com/owner/repo/pull/1'};
  const checks=['CI','Metadata','CodeRabbit'].map((name,i)=>({id:i+1,name,head_sha:head,app:{slug:name==='CodeRabbit'?'coderabbitai':'github-actions'},status:'completed',conclusion:'success'}));
   const review={user:{id:136622811,type:'Bot',login:'coderabbitai[bot]'},state:'APPROVED',commit_id:head,submitted_at:'2026-11-01T00:00:00Z'};
   const responses:any={
    'user':{id:9},
    'user/136622811':{id:136622811,login:'coderabbitai[bot]',type:'Bot'},
    'user/199175422':{id:199175422,login:'chatgpt-codex-connector[bot]',type:'Bot'},
    'user/3':{id:3,type:'User',login:'human'},
    'repos/owner/repo/collaborators/human/permission':{user:{id:3},permission:'write'},
   'repos/owner/repo/pulls/1/files?per_page=100':[[{filename:'src/a.ts'}]],
    'repos/owner/repo/issues/1/comments?per_page=100':[[{id:100,user:{id:3,type:'User',login:'human'},body:'Fix ownership',created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:01:00Z'}]],
   'repos/owner/repo/pulls/1':pr,
   [`repos/owner/repo/commits/${head}/check-runs?per_page=100`]:[{check_runs:checks}],
    'repos/owner/repo/pulls/1/reviews?per_page=100':[[review,{id:42,user:{id:4,type:'User',login:'unavailable'},state:'CHANGES_REQUESTED',commit_id:head,submitted_at:'2026-11-01T00:01:00Z',body:'Fix the ownership guard'},{id:43,user:{id:3,type:'User',login:'human'},state:'APPROVED',commit_id:head,submitted_at:'2026-11-01T00:02:00Z',body:''}]],
   'repos/owner/repo/git/ref/heads/main':{ref:'refs/heads/main',object:{type:'commit',sha:base}},
   [`repos/owner/repo/compare/${base}...${head}`]:{behind_by:0},
  };
   // A wholly authenticated/excluded thread must not re-enter the raw unresolved
   // gate. Independent metadata and required CodeRabbit approval gates remain.
   const graphql={data:{repository:{pullRequest:{reviewThreads:{nodes:[{id:'excluded-codex',path:'src/a.ts',line:1,isResolved:false,isOutdated:false,comments:{nodes:[{id:'excluded-comment',body:'Filtered feedback',author:{login:'chatgpt-codex-connector[bot]',__typename:'Bot',databaseId:199175422},originalCommit:{oid:head}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}}}}};
  const query=REVIEW_THREADS_QUERY;
  const graphqlArgs=['api','graphql','-f',`query=${query}`,'-f','owner=owner','-f','name=repo','-F','number=1'];
  const configArgs=['api','graphql','-f',`query=${CONFIG_QUERY}`,'-f','owner=owner','-f','name=repo','-f',`hy=${head}:.coderabbit.yaml`,'-f',`hm=${head}:.coderabbit.yml`,'-f',`by=${base}:.coderabbit.yaml`,'-f',`bm=${base}:.coderabbit.yml`];
  const configGraphql={data:{repository:{defaultBranchRef:{name:'main'},hy:{oid:'blob',text:'reviews: {}'},hm:null,by:{oid:'blob',text:'reviews: {}'},bm:null}}};
  const bodyArgs=['api','graphql','-f',`query=${BODY_VERSION_QUERY}`,'-f','owner=owner','-f','name=repo','-F','number=1'];
  // Replace gh entirely; this process has no credentials or network fallback.
  writeFileSync(join(root,'gh'),`#!${process.execPath}
const args=process.argv.slice(2),responses=${JSON.stringify(responses)};
const mode=process.env.FIXTURE_MODE;
if(mode?.startsWith('rabbit-')){
 const review=responses['repos/owner/repo/pulls/1/reviews?per_page=100'][0][0];
 review.state=mode==='rabbit-changes'?'CHANGES_REQUESTED':'COMMENTED';
 const checks=responses[${JSON.stringify(`repos/owner/repo/commits/${head}/check-runs?per_page=100`)}][0].check_runs;
 if(mode==='rabbit-pending')checks.find(c=>c.name==='CodeRabbit').status='in_progress';
 if(mode==='rabbit-skipped')checks.find(c=>c.name==='CodeRabbit').conclusion='skipped';
 if(mode==='rabbit-ci-failed')checks.find(c=>c.name==='CI').conclusion='failure';
 if(mode.startsWith('rabbit-custom-')){
  const summary=${JSON.stringify(customFixture().comments[0])};
  if(mode.endsWith('-pass'))summary.body=summary.body.replace('![Error]','![Passed]');
  if(mode.endsWith('-inconclusive'))summary.body=summary.body.replace('![Error]','![Inconclusive]');
  if(mode.includes('-stale-'))responses['repos/owner/repo/pulls/1/reviews?per_page=100'][0].push({...review,state:'APPROVED',commit_id:'f'.repeat(40),submitted_at:'2026-10-31T00:00:00Z'});
  responses['repos/owner/repo/issues/1/comments?per_page=100'][0].push(summary);
 }
}
if(args.at(-1)==='--include')args.pop();
if(args[0]!=='api')throw Error('Read-only fixture only');
let result;
if(args[1]==='graphql'){
 // Field flags are allowed only for this exact read-only query and variables.
 if(JSON.stringify(args)===JSON.stringify(${JSON.stringify(configArgs)}))result=${JSON.stringify(configGraphql)};
 else if(JSON.stringify(args)===JSON.stringify(${JSON.stringify(bodyArgs)}))result={data:{repository:{pullRequest:{body:${JSON.stringify(pr.body)},headRefOid:${JSON.stringify(head)},createdAt:'2026-10-31T00:00:00Z',lastEditedAt:null}}}};
 else {if(JSON.stringify(args)!==JSON.stringify(${JSON.stringify(graphqlArgs)}))throw Error('Read-only fixture only');result=${JSON.stringify(graphql)};}
}else{
 // REST accepts only plain or paginated GET argument shapes: no -f/-F,
 // --field/--raw-field, method overrides, inputs, or attached flag forms.
 if(!(args.length===2||args.length===4&&args[1]==='--paginate'&&args[2]==='--slurp'))throw Error('Read-only fixture only');
 const key=args.at(-1);if(!Object.hasOwn(responses,key))throw Error('Unexpected GitHub read');result=responses[key];
}
console.log(JSON.stringify(result));
`,{mode:0o755});
  const path='repos/owner/repo/pulls/1';
  for(const args of [['api',path,'-f','title=changed'],['api',path,'-F','title=changed'],['api',path,'--field=title=changed'],['api',path,'--raw-field=title=changed'],['api',path,'--method','PATCH'],['api',path,'-X','POST'],['api','--paginate','--slurp',path,'-f','title=changed'],['api','graphql','-f','query=mutation { deleteIssue(input:{issueId:"x"}) { clientMutationId } }'],[...graphqlArgs,'-f','query=mutation { ignored }']]){
   const rejected=Bun.spawnSync([join(root,'gh'),...args],{env:{PATH:root+':/usr/bin:/bin',HOME:root}});expect(rejected.exitCode).not.toBe(0);expect(rejected.stderr.toString()).toContain('Read-only fixture only');expect(rejected.stdout.toString()).toBe('');
  }
   for(const mode of ['metadata','clear','advisory-outage','acknowledged','rabbit-strict','rabbit-advisory','rabbit-changes','rabbit-pending','rabbit-skipped','rabbit-ci-failed','rabbit-custom-error','rabbit-custom-pass','rabbit-custom-stale-error','rabbit-custom-stale-inconclusive','rabbit-custom-stale-pass']){
    const metadata=mode==='metadata'?['Metadata']:[];
    // No user/4 response: the fixture rejects the advisory identity lookup.
    // Its summary-only change request must not disappear into green clearance.
    writeFileSync(config,JSON.stringify({requiredChecks:['CI'],prMetadataChecks:metadata,reviewers:[{id:'codex',excludePaths:['src/**']},...(mode.startsWith('rabbit-')?[{id:'coderabbit',approvalRequired:mode==='rabbit-strict'}]:[]),...(['advisory-outage','acknowledged'].includes(mode)?[{id:'human',adapter:'github-review',identity:{userId:mode==='advisory-outage'?4:3,type:'User'},approvalRequired:false}]:[])]}));
   const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'readiness','owner/repo','1',config],{env:{PATH:root+':/usr/bin:/bin',HOME:root,ADLC_DB:db,FIXTURE_MODE:mode}});
   expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');const output=JSON.parse(result.stdout.toString());
    expect(output).toMatchObject({head,descriptionHash:digest(pr.body),pendingChecks:[],missingChecks:[],coderabbitPresent:true,mergeEnabled:false});
    expect(output.failedChecks).toHaveLength(mode==='rabbit-ci-failed'?1:0);
    expect(output.reviewerEvidence.pending).toEqual([]);expect(output.reviewerEvidence.excluded).toHaveLength(1);expect(output.reviewerEvidence.ignoredThreadIds).toEqual(['excluded-codex']);
   if(metadata.length){expect(output.clear).toBe(false);expect(output.reasons).toEqual(['Missing body-bound success evidence for every configured metadata check']);expect(output.metadataCheckEvidence).toEqual([{name:'Metadata',checkId:2,sha:head,status:'completed',conclusion:'success',descriptionHash:null}]);}
    else if(mode==='advisory-outage'){expect(output.clear).toBe(false);expect(output.reasons).toEqual(['Reviewer human: fresh identity/membership evidence unavailable or mismatched; no trust granted']);expect(output.findings).toEqual([]);}
    else if(mode.startsWith('rabbit-')&&!['rabbit-advisory','rabbit-custom-pass','rabbit-custom-stale-pass'].includes(mode)){
     expect(output.clear).toBe(false);
     const reason=mode.startsWith('rabbit-custom-')?'CodeRabbit custom-check failure: current bot review provenance is unavailable':mode==='rabbit-strict'?'Explicit latest-SHA CodeRabbit approval missing':mode==='rabbit-changes'?'Reviewer coderabbit: changes requested':mode==='rabbit-ci-failed'?'Required check not clear: CI':'CodeRabbit check not clear';
     expect(output.reasons.some((r:string)=>r.includes(reason))).toBe(true);
     if(mode.startsWith('rabbit-custom-')){expect(output.customCheckBlocker).toBe(reason);expect(output.findings).toEqual([]);expect(output.coderabbitBodyReviewed).toBe(false);}
    }else{expect(output.clear).toBe(true);expect(output.reasons).toEqual([]);if(mode==='acknowledged'){expect(output.findings).toEqual([]);expect(output.reviewerEvidence.acknowledged).toMatchObject([{threadId:'comment:100',reviewId:43}]);}}
   expect(existsSync(db)).toBe(false);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},15000);
for(const mode of ['success','outer-repeat','outer-null','outer-errors','outer-pageInfo','nested-repeat','nested-null','nested-errors','nested-pageInfo'])test(`readiness pagination: ${mode}`,()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-review-threads-'));try{
  const head='a'.repeat(40),base='b'.repeat(40),config=join(root,'config.json'),db=join(root,'unused.sqlite');
   const pr={number:1,user:{id:8},changed_files:1,head:{sha:head},base:{sha:base,ref:'main'},state:'open',draft:false,mergeable:true,body:'current PR description',html_url:'https://github.com/owner/repo/pull/1'};
  const checks=['CI','CodeRabbit'].map((name,i)=>({id:i+1,name,head_sha:head,app:{slug:name==='CodeRabbit'?'coderabbitai':'github-actions'},status:'completed',conclusion:'success'}));
   const review={user:{id:136622811,type:'Bot',login:'coderabbitai[bot]'},state:'CHANGES_REQUESTED',commit_id:'f'.repeat(40),submitted_at:'2026-11-01T00:00:00Z',body:'Actionable comments posted'};
   const comment=(id:string,body:string)=>({id,body,author:{login:'coderabbitai[bot]',__typename:'Bot',databaseId:136622811},originalCommit:{oid:'dcf66943'}});
  const thread=(id:string,over:any={})=>({id,isResolved:false,isOutdated:false,path:'src/workflow.ts',line:10,startLine:null,comments:{nodes:[comment(`${id}-c1`,`${id} first`)],pageInfo:{hasNextPage:false,endCursor:null}},...over});
  const page1={data:{repository:{pullRequest:{reviewThreads:{nodes:[thread('T1',{comments:{nodes:[comment('C1','Planning slot leak')],pageInfo:{hasNextPage:true,endCursor:'c1'}}})],pageInfo:{hasNextPage:true,endCursor:'t2'}}}}}};
  const page2={data:{repository:{pullRequest:{reviewThreads:{nodes:[thread('T2',{isOutdated:true,path:'src/other.ts'})],pageInfo:{hasNextPage:false}}}}}};
  const commentPage={data:{node:{comments:{nodes:[comment('C2','Follow-up detail')],pageInfo:{hasNextPage:false,endCursor:null}}}}};
  const outer:any=page2.data.repository.pullRequest.reviewThreads,inner:any=commentPage.data.node.comments;
  if(mode==='outer-repeat')outer.pageInfo={hasNextPage:true,endCursor:'t2'};
  if(mode==='outer-null')outer.pageInfo={hasNextPage:true,endCursor:null};
  if(mode==='outer-errors')(page2 as any).errors=[{message:'Unavailable'}];
  if(mode==='outer-pageInfo')delete outer.pageInfo;
  if(mode==='nested-repeat')inner.pageInfo={hasNextPage:true,endCursor:'c1'};
  if(mode==='nested-null')inner.pageInfo={hasNextPage:true,endCursor:null};
  if(mode==='nested-errors')(commentPage as any).errors=[{message:'Unavailable'}];
  if(mode==='nested-pageInfo')delete inner.pageInfo;
   const responses:any={
    'user':{id:9},
    'user/136622811':{id:136622811,login:'coderabbitai[bot]',type:'Bot'},
    'user/199175422':{id:199175422,login:'chatgpt-codex-connector[bot]',type:'Bot'},
    'repos/owner/repo/pulls/1/files?per_page=100':[[{filename:'src/workflow.ts'}]],
   'repos/owner/repo/issues/1/comments?per_page=100':[[]],
   'repos/owner/repo/pulls/1':pr,
   [`repos/owner/repo/commits/${head}/check-runs?per_page=100`]:[{check_runs:checks}],
   'repos/owner/repo/pulls/1/reviews?per_page=100':[[review]],
   'repos/owner/repo/git/ref/heads/main':{ref:'refs/heads/main',object:{type:'commit',sha:base}},
   [`repos/owner/repo/compare/${base}...${head}`]:{behind_by:0},
  };
  writeFileSync(join(root,'gh'),`#!${process.execPath}
const args=process.argv.slice(2),responses=${JSON.stringify(responses)};
if(args.at(-1)==='--include')args.pop();
if(args[0]!=='api')throw Error('Read-only fixture only');
if(args[1]!=='graphql'){
 if(!(args.length===2||args.length===4&&args[1]==='--paginate'&&args[2]==='--slurp'))throw Error('Read-only fixture only');
 const key=args.at(-1);if(!Object.hasOwn(responses,key))throw Error('Unexpected GitHub read');
 console.log(JSON.stringify(responses[key]));process.exit(0);
}
const fields=Object.fromEntries(args.slice(2).filter(a=>a!=='-f'&&a!=='-F').map(a=>{const i=a.indexOf('=');return [a.slice(0,i),a.slice(i+1)]}));
const query=String(fields.query);
if(query.includes('mutation'))throw Error('Read-only fixture only');
if(query===${JSON.stringify(REVIEW_THREADS_QUERY)}){
 if(fields.after&&fields.after!=='t2')throw Error('Read-only fixture only');
 console.log(JSON.stringify(fields.after?${JSON.stringify(page2)}:${JSON.stringify(page1)}));process.exit(0);
}
if(query===${JSON.stringify(REVIEW_THREAD_COMMENTS_QUERY)}){
 if(fields.id!=='T1'||fields.after!=='c1')throw Error('Read-only fixture only');
 console.log(JSON.stringify(${JSON.stringify(commentPage)}));process.exit(0);
}
throw Error('Read-only fixture only');
`,{mode:0o755});
  writeFileSync(config,JSON.stringify({requiredChecks:['CI'],prMetadataChecks:[]}));
  const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'readiness','owner/repo','1',config],{env:{PATH:root+':/usr/bin:/bin',HOME:root,ADLC_DB:db}});
  if(mode!=='success'){
   expect(result.exitCode).not.toBe(0);
   expect(result.stderr.toString()).toContain(/repeat|null/.test(mode)?'Invalid thread cursor':mode.startsWith('outer')?'Incomplete review threads':'Incomplete thread comments');
   expect(result.stdout.toString()).toBe('');expect(existsSync(db)).toBe(false);return;
  }
  expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');
  const output=JSON.parse(result.stdout.toString());
  expect(output).toMatchObject({head,unresolved:2,clear:false});
  expect(output.reviewThreads.stale.map((t:any)=>t.threadId)).toEqual(['T2']);
  expect(output.reviewThreads.candidates.map((t:any)=>t.threadId)).toEqual(['T1']);
  expect(output.reviewThreads.candidates[0]).toMatchObject({path:'src/workflow.ts',originalCommit:'dcf66943',commentIds:['C1','C2'],commentsHash:digest('C1,C2')});
  expect(output.findings).toHaveLength(1);
  expect(output.findings[0]).toMatchObject({source:'github-review',kind:'review_thread',threadId:'T1',path:'src/workflow.ts',sha:head,originalCommit:'dcf66943'});
  expect(output.findings[0].body).toContain('Planning slot leak');expect(output.findings[0].body).toContain('Follow-up detail');
  expect(existsSync(db)).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});}
},15000);

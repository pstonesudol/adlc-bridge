import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {digest} from '../src/core';

test('real readiness CLI gates otherwise-successful metadata checks on body evidence, but not an empty policy',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-readiness-cli-'));try{
  const head='a'.repeat(40),base='b'.repeat(40),config=join(root,'config.json'),db=join(root,'unused.sqlite');
  const pr={head:{sha:head},base:{sha:base,ref:'main'},state:'open',draft:false,mergeable:true,body:'current PR description',html_url:'https://github.com/owner/repo/pull/1'};
  const checks=['CI','Metadata','CodeRabbit'].map((name,i)=>({id:i+1,name,head_sha:head,app:{slug:name==='CodeRabbit'?'coderabbitai':'github-actions'},status:'completed',conclusion:'success'}));
  const review={user:{login:'coderabbitai[bot]'},state:'APPROVED',commit_id:head,submitted_at:'2026-11-01T00:00:00Z'};
  const responses:any={
   'repos/owner/repo/pulls/1':pr,
   [`repos/owner/repo/commits/${head}/check-runs?per_page=100`]:[{check_runs:checks}],
   'repos/owner/repo/pulls/1/reviews?per_page=100':[[review]],
   'repos/owner/repo/git/ref/heads/main':{ref:'refs/heads/main',object:{type:'commit',sha:base}},
   [`repos/owner/repo/compare/${base}...${head}`]:{behind_by:0},
  };
  const graphql={data:{repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}};
  const query='query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved isOutdated path comments(first:100){nodes{body author{login} originalCommit{oid}} pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}}}';
  const graphqlArgs=['api','graphql','-f',`query=${query}`,'-f','owner=owner','-f','name=repo','-F','number=1'];
  // Replace gh entirely; this process has no credentials or network fallback.
  writeFileSync(join(root,'gh'),`#!${process.execPath}
const args=process.argv.slice(2),responses=${JSON.stringify(responses)};
if(args[0]!=='api')throw Error('Read-only fixture only');
let result;
if(args[1]==='graphql'){
 // Field flags are allowed only for this exact read-only query and variables.
 if(JSON.stringify(args)!==JSON.stringify(${JSON.stringify(graphqlArgs)}))throw Error('Read-only fixture only');
 result=${JSON.stringify(graphql)};
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
  for(const metadata of [['Metadata'],[]]){
   writeFileSync(config,JSON.stringify({requiredChecks:['CI'],prMetadataChecks:metadata}));
   const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'readiness','owner/repo','1',config],{env:{PATH:root+':/usr/bin:/bin',HOME:root,ADLC_DB:db}});
   expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');const output=JSON.parse(result.stdout.toString());
   expect(output).toMatchObject({head,descriptionHash:digest(pr.body),failedChecks:[],pendingChecks:[],missingChecks:[],coderabbitPresent:true,mergeEnabled:false});
   if(metadata.length){expect(output.clear).toBe(false);expect(output.reasons).toEqual(['Missing body-bound success evidence for every configured metadata check']);expect(output.metadataCheckEvidence).toEqual([{name:'Metadata',checkId:2,sha:head,status:'completed',conclusion:'success',descriptionHash:null}]);}
   else{expect(output.clear).toBe(true);expect(output.reasons).toEqual([]);}
   expect(existsSync(db)).toBe(false);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
},15000);

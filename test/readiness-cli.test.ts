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
  // Replace gh entirely; this process has no credentials or network fallback.
  writeFileSync(join(root,'gh'),`#!${process.execPath}\nconst args=process.argv.slice(2),responses=${JSON.stringify(responses)};if(args[0]!=='api'||args.includes('--method'))throw Error('Read-only fixture only');const key=args.find(x=>Object.hasOwn(responses,x));const result=args.includes('graphql')?${JSON.stringify(graphql)}:responses[key];if(result===undefined)throw Error('Unexpected GitHub read');console.log(JSON.stringify(result));\n`,{mode:0o755});
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

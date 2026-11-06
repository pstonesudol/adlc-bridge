import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {customFixture} from './coderabbit-fixture';
import {BODY_VERSION_QUERY} from '../src/coderabbit-checks';
test('read-only historical preview preserves full custom failure details with no mutation fallback',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-custom-preview-'));try{
  const f=customFixture(),responses:any={
   'repos/owner/repo/pulls/1':{state:'closed',head:{sha:f.head},body:f.context.body},
   'repos/owner/repo/pulls/1/reviews?per_page=100':[[f.review]],
   'repos/owner/repo/issues/1/comments?per_page=100':[f.comments],
   [`repos/owner/repo/commits/${f.head}/check-runs?per_page=100`]:[{check_runs:f.context.checks}],
  };
  const graphqlArgs=['graphql','-f',`query=${BODY_VERSION_QUERY}`,'-f','owner=owner','-f','name=repo','-F','number=1'];
  writeFileSync(join(root,'gh'),`#!${process.execPath}
const args=process.argv.slice(2);if(args.shift()!=='api')throw Error('Read only');
if(args.at(-1)==='--include')args.pop();
if(JSON.stringify(args)===JSON.stringify(${JSON.stringify(graphqlArgs)})){console.log(JSON.stringify(${JSON.stringify({data:{repository:{pullRequest:f.context.version}}})}));process.exit(0);}
if(!(args.length===1||args.length===3&&args[0]==='--paginate'&&args[1]==='--slurp'))throw Error('Read only');
const responses=${JSON.stringify(responses)},key=args.at(-1);if(!Object.hasOwn(responses,key))throw Error('Read only');console.log(JSON.stringify(responses[key]));
`,{mode:0o755});
  const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../scripts/preview-coderabbit.ts'),'owner/repo','1'],{env:{PATH:root+':/usr/bin:/bin',HOME:root}});
  expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toBe('');
  const output=JSON.parse(result.stdout.toString());expect(output).toMatchObject({state:'closed',head:f.head,reviewState:'CHANGES_REQUESTED',blocker:null,mutations:false,readinessEvaluated:false});
  expect(output.findings).toHaveLength(1);expect(output.findings[0].body).toContain('**Resolution**');
 }finally{rmSync(root,{recursive:true,force:true});}
});

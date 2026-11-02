import {customCheckEvidence,BODY_VERSION_QUERY} from '../src/coderabbit-checks';
import {effectiveBotReview} from '../src/github';

// Read-only evidence preview, including closed historical PRs. No controller
// state, delivery, review request, description edit or approval mutation.
async function read(args:string[]){
 const p=Bun.spawn(['gh','api',...args],{stdout:'pipe',stderr:'pipe',timeout:30000});
 const [out,code]=await Promise.all([new Response(p.stdout).text(),p.exited]);
 if(code!==0)throw Error('GitHub preview read failed');return JSON.parse(out);
}
const [repo,rawPR]=process.argv.slice(2),pr=Number(rawPR);
if(!/^[\w.-]+\/[\w.-]+$/.test(repo??'')||!Number.isSafeInteger(pr)||pr<1||process.argv.length!==4)throw Error('Use bun scripts/preview-coderabbit.ts OWNER/REPO PR');
const base=`repos/${repo}`,path=`${base}/pulls/${pr}`,[owner,name]=repo.split('/');
const first=await read([path]);
const [reviewPages,commentPages,checkPages,versionResult]=await Promise.all([
 read(['--paginate','--slurp',`${path}/reviews?per_page=100`]),
 read(['--paginate','--slurp',`${base}/issues/${pr}/comments?per_page=100`]),
 read(['--paginate','--slurp',`${base}/commits/${first.head.sha}/check-runs?per_page=100`]),
 read(['graphql','-f',`query=${BODY_VERSION_QUERY}`,'-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${pr}`]),
]);
if(![reviewPages,commentPages,checkPages].every(Array.isArray)||checkPages.some((p:any)=>!Array.isArray(p.check_runs)))throw Error('Incomplete preview pagination');
const final=await read([path]);
if(first.head.sha!==final.head.sha||first.body!==final.body)throw Error('PR changed during preview; inspect again');
const review=effectiveBotReview(reviewPages.flat()),checks=checkPages.flatMap((p:any)=>p.check_runs);
const evidence=customCheckEvidence(review,first.head.sha,commentPages.flat(),{repo,pr,body:final.body??'',version:versionResult.errors?null:versionResult.data?.repository?.pullRequest,checks});
console.log(JSON.stringify({mode:'read-only-custom-check-preview',repo,pr,state:final.state,head:final.head.sha,reviewState:review?.state??null,...evidence,readinessEvaluated:false,mutations:false},null,2));

import {test,expect} from 'bun:test';
import {readPlanningPRs} from '../src/planning-prs';
const repo='owner/repo',branch='adlc/owned',pr=(number:number)=>({number,html_url:`https://github.com/${repo}/pull/${number}`,state:'open',head:{ref:branch,sha:'a'.repeat(40),repo:{full_name:repo}},base:{repo:{full_name:repo}}});
test('complete empty branch inventory is explicit no-PR evidence, not an absent attachment',async()=>{
 let args:string[]=[];expect(await readPlanningPRs(repo,branch,async a=>{args=a;return [];})).toEqual({repo,branch,complete:true,prs:[]});
 expect(args[1]).toContain('head=owner%3Aadlc%2Fowned');expect(args[1]).toContain('page=1');
 expect(args[1]).toContain('state=all');
});
test('branch inventory reads an explicit terminal page and rejects duplicate identities',async()=>{
 const pages=[Array.from({length:100},(_,i)=>pr(i+1)),[pr(101)]],calls:string[][]=[];
 expect((await readPlanningPRs(repo,branch,async a=>{calls.push(a);return pages.shift();})).prs).toHaveLength(101);expect(calls[1][1]).toContain('page=2');
 let page=0;await expect(readPlanningPRs(repo,branch,async()=>++page===1?Array.from({length:100},(_,i)=>pr(i+1)):[pr(1)])).rejects.toThrow('ambiguous');
});
for(const kind of ['partial','foreign-repo','foreign-branch','invalid-head','wrong-url','closed','duplicate'])test(`PR inventory fails closed on ${kind}`,async()=>{
 const p=pr(1);if(kind==='foreign-repo')p.head.repo.full_name='other/repo';if(kind==='foreign-branch')p.head.ref='other';if(kind==='invalid-head')p.head.sha='short';if(kind==='wrong-url')p.html_url='https://example.com';if(kind==='closed')p.state='closed';
 await expect(readPlanningPRs(repo,branch,async()=>kind==='partial'?{nodes:[p]}:kind==='duplicate'?[p,p]:[p])).rejects.toThrow();
});

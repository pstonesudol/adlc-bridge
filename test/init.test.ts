import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyInitConfig,saveInitConfig,serviceDefinition} from '../src/init';
const uuid=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
function fixture(repo:string){
 const c:any={version:1,name:'Test',repo,githubRepo:'owner/repo',automation:{orchestratorProject:'test'},linear:{projectId:uuid(1),teamId:uuid(2),readyStateId:uuid(3),readyLabelId:uuid(4)},requiredChecks:['CI'],reviewAllowedPaths:['src/**']};
 const page={hasNextPage:false};const b:any={project:{id:uuid(1),teams:{nodes:[{id:uuid(2)}],pageInfo:page}},team:{id:uuid(2),states:{nodes:[{id:uuid(3),type:'unstarted'}],pageInfo:page},labels:{nodes:[{id:uuid(4)}],pageInfo:page}}};
 return {c,b,api:async()=>b,ao:async()=>({status:'ok',project:{path:repo}})};
}
test('init validates actual Linear membership and Orchestrator repository without mutation',async()=>{
 const f=fixture(tmpdir());await verifyInitConfig(f.c,f.api,f.ao);
 f.b.project.teams.nodes=[];await expect(verifyInitConfig(f.c,f.api,f.ao)).rejects.toThrow('mismatch');
});
test('init rejects incomplete inventory, wrong workflow state, and unsafe review scope',async()=>{
 const f=fixture(tmpdir());f.b.team.states.pageInfo={hasNextPage:true};await expect(verifyInitConfig(f.c,f.api,f.ao)).rejects.toThrow('incomplete');
 f.b.team.states.pageInfo={hasNextPage:false};f.b.team.states.nodes[0].type='completed';await expect(verifyInitConfig(f.c,f.api,f.ao)).rejects.toThrow('Todo');
 f.c.reviewAllowedPaths=['../secret'];await expect(verifyInitConfig(f.c,f.api,f.ao)).rejects.toThrow('safe');
});
test('init never replaces an existing config and writes owner-only configuration',()=>{
 const dir=mkdtempSync(join(tmpdir(),'adlc-init-'));try{const p=join(dir,'local.json');saveInitConfig(p,{name:'original'});expect(()=>saveInitConfig(p,{name:'replacement'})).toThrow();expect(JSON.parse(readFileSync(p,'utf8')).name).toBe('original');}finally{rmSync(dir,{recursive:true,force:true});}
});
test('generated launchd definition escapes user paths and uses explicit poll arguments',()=>{
 const xml=serviceDefinition('/a & b/config.json','/bun','/code/cli.ts','/home/a');expect(xml).toContain('/a &amp; b/config.json');expect(xml).toContain('<string>poll</string>');expect(xml).toContain('<integer>60</integer>');expect(xml).not.toContain('linear-token');
});
import {collectMetadataChecks} from '../src/init';
test('metadata check prompts preserve exact names with commas and allow none',async()=>{
 const names=['CI, PR body','Second check','CI, PR body',''];expect(await collectMetadataChecks(async()=>names.shift()!)).toEqual(['CI, PR body','Second check']);expect(await collectMetadataChecks(async()=>'')).toEqual([]);
});

export type Capability={path:string;sha256:string};
export type Prerequisite={issue:string;ref:string;repo:string;pr:number;kind:'source'|'host-runtime';capabilities:Capability[]};
export type DependencyJob={issue:string;planHash:string;specHash:string;prerequisites:Prerequisite[]};
export type DependencyPolicy={enabled:boolean;baseBranch:string;jobs:DependencyJob[]};
const hash=(s:any)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const issue=(s:any)=>typeof s==='string'&&/^[a-f0-9-]{36}$/i.test(s);
export function validateDependencies(c:any){
 const p=c.dependencyRecovery;if(p===undefined)return;
 if(!p||typeof p.enabled!=='boolean')throw Error('dependencyRecovery.enabled must be boolean');
 if(!p.enabled)return;
 if(typeof c.githubRepo!=='string'||! /^[\w.-]+\/[\w.-]+$/.test(c.githubRepo))throw Error('Exact configured GitHub repository required');
 if(typeof p.baseBranch!=='string'||! /^(?!-)[\w/-]+$/.test(p.baseBranch)||p.baseBranch.includes('//')||!Array.isArray(p.jobs)||p.jobs.length>100)throw Error('Bounded dependency jobs and exact base branch required');
 const ids=new Set<string>();
 for(const j of p.jobs){
  if(!issue(j.issue)||ids.has(j.issue)||!hash(j.planHash)||!hash(j.specHash)||!Array.isArray(j.prerequisites)||!j.prerequisites.length||j.prerequisites.length>20)throw Error('Unique dependency issue and approved plan/spec hashes required');
  ids.add(j.issue);const deps=new Set<string>(),refs=new Set<string>();
  for(const d of j.prerequisites){
   if(!issue(d.issue)||deps.has(d.issue)||typeof d.ref!=='string'||! /^[A-Z][A-Z0-9]*-\d+$/.test(d.ref)||refs.has(d.ref)||d.repo!==c.githubRepo||!Number.isSafeInteger(d.pr)||d.pr<1||!['source','host-runtime'].includes(d.kind)||!Array.isArray(d.capabilities)||!d.capabilities.length||d.capabilities.length>20)throw Error('Unambiguous same-repository dependency PR and capabilities required');
   deps.add(d.issue);refs.add(d.ref);
   for(const cap of d.capabilities)if(typeof cap.path!=='string'||! /^(?:[\w-]+\/)*[\w.-]+$/.test(cap.path)||cap.path.split('/').some((x:string)=>x.startsWith('.'))||!hash(cap.sha256))throw Error('Safe tracked capability path and SHA-256 required');
  }
 }
 const done=new Set<string>();
 const visit=(id:string,stack:Set<string>)=>{if(stack.has(id))throw Error(`Dependency cycle at ${id}`);if(done.has(id))return;const j=p.jobs.find((j:DependencyJob)=>j.issue===id);if(!j)return;const next=new Set(stack).add(id);for(const d of j.prerequisites)visit(d.issue,next);done.add(id);};
 for(const id of ids)visit(id,new Set());
}

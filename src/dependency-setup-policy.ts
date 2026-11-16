export type DependencySetupPolicy={version:1;runtime:'verification-container';cwd:string;lockfile:'package-lock.json';manifests:string[];cache:string};
const relative=(p:unknown):p is string=>typeof p==='string'&&(p==='.'||/^(?:[\w-]+\/)*[\w-]+$/.test(p))&&!p.split('/').some(x=>['node_modules','.git'].includes(x));
export function validateDependencySetup(p:unknown):asserts p is DependencySetupPolicy|undefined{
 if(p===undefined)return;
 const v=p as DependencySetupPolicy;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['version','runtime','cwd','lockfile','manifests','cache'].includes(k))||v.version!==1||v.runtime!=='verification-container'||!relative(v.cwd)||v.lockfile!=='package-lock.json'||!Array.isArray(v.manifests)||!v.manifests.length||v.manifests.length>50||v.manifests[0]!=='package.json'||new Set(v.manifests).size!==v.manifests.length||v.manifests.some(x=>typeof x!=='string'||!(x==='package.json'||x.endsWith('/package.json')&&relative(x.slice(0,-'/package.json'.length))))||typeof v.cache!=='string'||!/^\/(?:[\w.-]+\/)*[\w.-]+$/.test(v.cache)||v.cache.split('/').some(x=>x==='..'||x==='.')||['/tmp','/input','/output','/proc','/dev','/run'].some(x=>v.cache===x||v.cache.startsWith(x+'/')))throw Error('dependencySetup requires v1 verification-container, safe workspace/manifests, package-lock.json and an image-internal cache path');
}

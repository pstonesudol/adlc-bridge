import {existsSync,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Exact runtime closure of the pinned Promise client. Optional UI peers and
// development files are not part of the service-discovery adapter.
export const routingRuntimePackages:Record<string,string>={
 '@opencode/client':'2.2.5','@opencode/protocol':'2.2.5','@opencode/schema':'2.2.5',
 'effect':'4.0.6','@standard-schema/spec':'1.1.0'
};
const diagnostic='Routing runtime dependencies are missing or incompatible; run bun install --ignore-scripts --linker hoisted in the trusted source checkout before preparing installation';
function regular(root:string,path:string,directory=false){
 const parts=path.split('/');let current=root;
 for(const [index,part] of parts.entries()){
  current=join(current,part);let st;try{st=lstatSync(current);}catch{throw Error(diagnostic);}
  if(st.isSymbolicLink()||((index<parts.length-1||directory)?!st.isDirectory():!st.isFile()))throw Error('Routing runtime dependencies must be regular, non-symlink files/directories');
 }
}
function declared(root:string){
 const path=join(root,'package.json');if(!existsSync(path))return false;
 const manifest=JSON.parse(readFileSync(path,'utf8')),version=manifest.dependencies?.['@opencode/client'];
 if(version===undefined)return false;if(version!==routingRuntimePackages['@opencode/client'])throw Error(diagnostic);return true;
}
function packages(root:string){
 if(!declared(root))throw Error(diagnostic);
 for(const [name,version] of Object.entries(routingRuntimePackages)){
  const path=`node_modules/${name}/package.json`;regular(root,path);
  const manifest=JSON.parse(readFileSync(join(root,path),'utf8'));
  if(manifest.name!==name||manifest.version!==version)throw Error(diagnostic);
  for(const [dependency,pin] of Object.entries(manifest.dependencies??{}))if(!Object.hasOwn(routingRuntimePackages,dependency)||routingRuntimePackages[dependency]!==pin)throw Error(diagnostic);
  regular(root,`node_modules/${name}/dist`,true);
 }
 const entry='node_modules/@opencode/client/dist/promise/service.js';regular(root,entry);
 const client=JSON.parse(readFileSync(join(root,'node_modules/@opencode/client/package.json'),'utf8'));
 if(client.exports?.['./service']?.import!=='./dist/promise/service.js')throw Error(diagnostic);
 return entry;
}
export function routingClientURL(root=resolve(import.meta.dir,'..')){
 // Resolve only a verified, local exported entry. A bare dynamic import can
 // otherwise ask Bun to install packages during a routing decision.
 return pathToFileURL(join(root,packages(root))).href;
}
export function routingDependencyFiles(root:string){
 if(!declared(root))return [];
 packages(root);const files:string[]=[];
 const walk=(path:string)=>{regular(root,path,true);for(const name of readdirSync(join(root,path)).sort()){
  const child=path+'/'+name,st=lstatSync(join(root,child));if(st.isSymbolicLink())throw Error('Routing runtime dependencies cannot contain symlinks');
  if(st.isDirectory())walk(child);else if(st.isFile())files.push(child);else throw Error('Unsupported routing runtime dependency file');
 }};
 for(const name of Object.keys(routingRuntimePackages)){
  const base=`node_modules/${name}`;files.push(base+'/package.json');walk(base+'/dist');
  for(const license of ['LICENSE','LICENSE.md','LICENSE.txt'])if(existsSync(join(root,base,license))){regular(root,base+'/'+license);files.push(base+'/'+license);}
 }
 return files.sort();
}

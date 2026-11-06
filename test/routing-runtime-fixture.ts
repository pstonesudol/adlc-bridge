import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';
import {routingRuntimePackages} from '../src/routing-dependencies';
export function routingRuntimeFixture(){
 const root=mkdtempSync(join(tmpdir(),'adlc-runtime-packages-')),source=join(root,'source'),destination=join(root,'versions');
 const write=(path:string,text:string)=>{mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),text);};
 write('package.json',JSON.stringify({type:'module',dependencies:{'@opencode/client':'2.2.5'}}));write('src/cli.ts','export const fixture=true;');
 const dependencies:Record<string,Record<string,string>>={
  '@opencode/client':{'@opencode/schema':'2.2.5','@opencode/protocol':'2.2.5'},
  '@opencode/schema':{'@standard-schema/spec':'1.1.0',effect:'4.0.6'},
  '@opencode/protocol':{'@opencode/schema':'2.2.5',effect:'4.0.6'}
 };
 for(const [name,version] of Object.entries(routingRuntimePackages)){
  const base=`node_modules/${name}`,client=name==='@opencode/client';
  write(base+'/package.json',JSON.stringify({name,version,type:'module',exports:client?{'./service':{import:'./dist/promise/service.js'}}:'./dist/index.js',dependencies:dependencies[name]}));
  const imports=Object.keys(dependencies[name]??{}).map(name=>`import '${name}';`).join('\n');
  write(base+(client?'/dist/promise/service.js':'/dist/index.js'),imports+(client?`\nimport {writeFileSync} from 'node:fs';export const Service={discover:async()=>{if(process.env.ADLC_TEST_DISCOVERY)writeFileSync(process.env.ADLC_TEST_DISCOVERY,'unexpected discovery');return undefined;},headers:()=>({})};`:'\nexport const fixture=true;'));
  write(base+'/LICENSE','fixture license');write(base+'/.env','must not be packaged');
 }
 write('node_modules/unrelated/secret.json','must not be packaged');
 return {root,source,destination,write};
}

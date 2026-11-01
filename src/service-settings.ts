import {readFileSync,statSync,mkdtempSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {assertDefinition,readDefinition} from './project-services';
import {effectiveSettings,type ProjectSettings} from './project-settings';

// Change only StartInterval. Retain arguments, environment, logs and all unknown keys.
export function serviceSettings(path:string,label:string,config:string,c:ProjectSettings,apply=false){
 const settings=effectiveSettings(c),before=readFileSync(path),definition=readDefinition(path);
 assertDefinition(definition,label,config);
 const result={...settings,installedIntervalSeconds:definition.StartInterval,changed:definition.StartInterval!==settings.pollingIntervalSeconds,applied:false};
 if(!apply||!result.changed)return result;
 const dir=mkdtempSync(join(dirname(path),'.adlc-service-'));
 try{
  const temp=join(dir,'service.plist');writeFileSync(temp,before,{mode:statSync(path).mode&0o777});
  const converted=Bun.spawnSync(['/usr/bin/plutil','-replace','StartInterval','-integer',String(settings.pollingIntervalSeconds),temp],{stdout:'pipe',stderr:'pipe'});
  if(converted.exitCode!==0)throw Error('Unable to update service interval; existing definition preserved');
  if(!before.equals(readFileSync(path)))throw Error('Service definition changed during update; retry preview');
  renameSync(temp,path);return {...result,applied:true};
 }finally{rmSync(dir,{recursive:true,force:true});}
}

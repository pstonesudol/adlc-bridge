import {test,expect} from 'bun:test';
import {effectiveSettings,serveLoop} from '../src/project-settings';
import {validate} from '../src/linear';
import {serviceDefinition} from '../src/init';
test('defaults and supported boundaries are explicit, never clamped',()=>{
 expect(effectiveSettings({})).toEqual({pollingIntervalSeconds:60,maxPlanning:1});
 for(const n of [5,86400])expect(effectiveSettings({pollingIntervalSeconds:n}).pollingIntervalSeconds).toBe(n);
 for(const n of [1,32])expect(effectiveSettings({automation:{maxPlanning:n}}).maxPlanning).toBe(n);
 for(const n of [null,0,4,86401,1.5,'60',NaN])expect(()=>validate({pollingIntervalSeconds:n})).toThrow('pollingIntervalSeconds');
 for(const n of [null,0,-1,33,1.5,'2',Infinity])expect(()=>validate({automation:{maxPlanning:n}})).toThrow('automation.maxPlanning');
});
test('serve uses configured interval and omitted default without overlapping ticks',async()=>{
 for(const seconds of [undefined,5,120]){
  let sleeps=0,ticks=0,stop=false;
  await serveLoop(async()=>{ticks++;if(ticks===2)stop=true;},{pollingIntervalSeconds:seconds},()=>stop,async ms=>{expect(ms).toBe(1000);sleeps++;});
  expect(ticks).toBe(2);expect(sleeps).toBe(seconds??60);
 }
});
test('generated project services accept distinct validated intervals',()=>{
 for(const seconds of [5,120])expect(serviceDefinition('/config','/bun','/cli','/home','label',{pollingIntervalSeconds:seconds})).toContain(`<integer>${seconds}</integer>`);
 expect(()=>serviceDefinition('/config','/bun','/cli','/home','label',{pollingIntervalSeconds:0})).toThrow('pollingIntervalSeconds');
});

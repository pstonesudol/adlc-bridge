import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
test('planning reservation admits only its issue, project and isolated branch once',()=>{
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('p','i','spec');const r=p.reserve(id,'demo');
 expect(()=>p.reserve(id,'demo')).toThrow();
 expect(()=>p.gate(id,'wrong','s',r.branch,'/isolated')).toThrow();
 expect(()=>p.gate(id,'demo','s','main','/isolated')).toThrow();
 expect(p.gate(id,'demo','s',r.branch,'/isolated').state).toBe('provisioned');
 expect(()=>p.gate(id,'demo','s',r.branch,'/isolated')).toThrow();s.close();
});
test('specification change revokes pending planning admission',()=>{
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('p','i','spec');const r=p.reserve(id,'demo');
 s.enqueue('p','i','new spec');expect(()=>p.gate(id,'demo','s',r.branch,'/isolated')).toThrow();s.close();
});

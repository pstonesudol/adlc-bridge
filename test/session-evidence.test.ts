import {test,expect} from 'bun:test';
import {Store} from '../src/core';
import {Planning} from '../src/planning';
import {capturePlan} from '../src/session-evidence';
test('capture binds the actual agent plan to reserved spec/session without approving it',()=>{
 const s=new Store(':memory:'),p=new Planning(s),id=s.enqueue('p','i','spec'),r=p.reserve(id,'project');
 const evidence={session:{id:'session',projectId:'project',branch:r.branch},transcript:{entries:[{sequence:13,kind:'message',role:'assistant',origin:'provider',streaming:false,text:'The plan'}]}};
 expect(capturePlan(s,id,evidence,13).approved).toBe(false);
 expect(s.get(id).state).toBe('awaiting_approval');expect(s.get(id).approved_hash).toBe(null);
 evidence.transcript.entries[0].role='user';expect(()=>capturePlan(s,id,evidence,13)).toThrow();
 evidence.transcript.entries[0].role='assistant';s.enqueue('p','i','changed');expect(()=>capturePlan(s,id,evidence,13)).toThrow();s.close();
});

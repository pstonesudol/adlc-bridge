import {test,expect} from 'bun:test';import {parseRequirements,validateDraft} from '../src/feature-schema';
import {featureFixture,plannedFeature,featureConfig,requirements,draft} from './feature-fixture';
test('three parallel reviews precede synthesis; proposed batch requires exact human approval',async()=>{
 const {s,agents,planner,id}=await plannedFeature();try{
 expect(agents.starts.length).toBe(4);expect(agents.starts.slice(0,3).some(a=>a.name.includes('synthesis'))).toBe(false);expect(agents.starts[3].name).toContain('synthesis');
 expect(planner.get(id).state).toBe('awaiting_review');expect(planner.show(id).draft.tickets.length).toBe(2);expect(agents.stopped.length).toBe(4);
 expect(()=>planner.approve(id,'stale','human')).toThrow();planner.approve(id,planner.get(id).hash,'human');expect(planner.get(id).state).toBe('approved');
 const revised={...draft,summary:'Revised plan'};planner.setDraft(id,revised);expect(planner.get(id).approved_hash).toBeNull();
 }finally{s.close();}
});
test('lost spawn and delivery replies recover existing agents without duplicates',async()=>{
 const {s,agents,planner}=featureFixture();try{
 agents.loseSpawn=true;agents.loseSend=true;const {id}=await planner.create(featureConfig,JSON.stringify(requirements),'Test');
 for(let n=0;n<8;n++)await planner.tick(id);expect(planner.get(id).state).toBe('awaiting_review');expect(agents.starts.length).toBe(4);expect(agents.messages.length).toBe(4);
 const same=await planner.create(featureConfig,JSON.stringify(requirements),'Test');expect(same.id).toBe(id);
 }finally{s.close();}
});
test('missing decisions are retained and cannot be silently approved',async()=>{
 const {s,agents,planner}=featureFixture();try{agents.question=true;const {id}=await planner.create(featureConfig,JSON.stringify(requirements),'Test');for(let n=0;n<4;n++)await planner.tick(id);
 expect(planner.show(id).draft.questions).toContain('Confirm a product decision');expect(()=>planner.approve(id,planner.get(id).hash,'human')).toThrow('acknowledge');planner.approve(id,planner.get(id).hash,'human',true);
 }finally{s.close();}
});
test('dependency cycles, unknown references, unreviewed workflow fields and uncovered requirements are rejected',()=>{
 expect(()=>validateDraft({...draft,tickets:[{...draft.tickets[0],dependsOn:['T2']},draft.tickets[1]]},requirements)).toThrow('Cyclic');
 expect(()=>validateDraft({...draft,tickets:[{...draft.tickets[0],stateId:'Todo'},draft.tickets[1]]},requirements)).toThrow('Unknown');
 expect(()=>validateDraft({...draft,tickets:[draft.tickets[0]]},requirements)).toThrow('Uncovered');
 expect(()=>validateDraft({...draft,tickets:[draft.tickets[0],{...draft.tickets[1],requirementIds:['UNKNOWN']}]},requirements)).toThrow('Unknown');
 expect(parseRequirements('plain requirements','Title').requirements[0].text).toBe('plain requirements');
});

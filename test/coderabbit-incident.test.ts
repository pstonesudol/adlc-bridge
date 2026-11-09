import {test,expect} from 'bun:test';
import {customCheckEvidence,customCheckSection} from '../src/coderabbit-checks';
import {customFixture} from './coderabbit-fixture';
import summary48 from './fixtures/coderabbit-dev97/summary48.json';
import summary30 from './fixtures/coderabbit-dev97/summary30.json';
import summary51 from './fixtures/coderabbit-dev97/summary51.json';
import oldReview from './fixtures/coderabbit-dev97/review5816629718.json';
import newReview from './fixtures/coderabbit-dev97/review5816794711.json';

// Transplant only real check sections into an explicitly synthetic completed
// run/description context. Real PR48 review/head currency is tested separately.
for(const [name,summary,fail] of [['PR48 passed',summary48,false],['PR30 inconclusive',summary30,true],['PR51 error',summary51,true]] as const)test(`real complete ${name} markup`,()=>{
 const f=customFixture();
 f.comments[0].body=f.comments[0].body.replace(/<!-- pre_merge_checks_walkthrough_start -->[\s\S]*<!-- pre_merge_checks_walkthrough_end -->/,`<!-- pre_merge_checks_walkthrough_start -->${customCheckSection(summary.body)}<!-- pre_merge_checks_walkthrough_end -->`);
 const result=f.evidence();expect(result.blocker).toBeNull();expect(result.bodyReviewed).toBe(true);expect(result.findings).toHaveLength(fail?1:0);
 if(fail){expect(result.findings[0].body).toContain('**Explanation**');expect(result.findings[0].body).toContain('**Resolution**');}
});
test('PR48 old review is historical; mutable summary cannot attest the earlier new-head review',()=>{
 expect(oldReview.commit_id).toBe('b6d63e92e519529787aa51312b8fad2608ab0550');
 expect(newReview.commit_id).toBe('455bcc3122870e39cce600b74b706631fba7e79b');
 expect(customCheckEvidence(oldReview,newReview.commit_id,[summary48])).toMatchObject({findings:[],bodyReviewed:false});
 // The comment was edited after this review: no invented run attestation.
 expect(customCheckEvidence(newReview,newReview.commit_id,[summary48])).toMatchObject({findings:[],bodyReviewed:false});
});

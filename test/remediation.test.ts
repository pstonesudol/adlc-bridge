import {test,expect} from 'bun:test';
import {remediationDecision} from '../src/core';
import {validate} from '../src/linear';
import {DEFAULT_REMEDIATION_POLICY,formatRemediationBudget,remediationPolicy,remediationSummary} from '../src/remediation';

const config=(extra:any={})=>({version:1,name:'Test',repo:'/repo',linear:{projectId:'00000000-0000-0000-0000-000000000001',teamId:'00000000-0000-0000-0000-000000000002',readyStateId:'00000000-0000-0000-0000-000000000003',readyLabelId:'00000000-0000-0000-0000-000000000004'},...extra});

test('omitted remediation settings preserve the five-attempt default',()=>{
 expect(DEFAULT_REMEDIATION_POLICY).toEqual({maxAttempts:5,maxNoProgress:5,window:'job'});
 expect(remediationPolicy()).toEqual(DEFAULT_REMEDIATION_POLICY);
 expect(remediationPolicy({})).toEqual(DEFAULT_REMEDIATION_POLICY);
 expect(()=>validate(config())).not.toThrow();
});

test('custom limits above five and explicit uncapped mode are honored without clamping',()=>{
 expect(remediationPolicy({maxAttempts:9,maxNoProgress:4,window:'job'})).toEqual({maxAttempts:9,maxNoProgress:4,window:'job'});
 expect(remediationPolicy({maxAttempts:null}).maxAttempts).toBeNull();
 const summary=remediationSummary({job:'j',policy:remediationPolicy({maxAttempts:null}),consumed:12,extensions:0,noProgress:1});
 expect(summary.uncapped).toBe(true);expect(summary.remaining).toBeNull();
 expect(formatRemediationBudget(summary)).toContain('uncapped');
 expect(remediationDecision(8,true,false,9)).toBe('remediation_pending_authorization');
 expect(remediationDecision(9,true,false,9)).toBe('blocked');
 expect(remediationDecision(100,true,false,null)).toBe('remediation_pending_authorization');
});

test('invalid remediation settings fail closed instead of being clamped',()=>{
 for(const value of [{maxAttempts:0},{maxAttempts:-1},{maxAttempts:1.5},{maxAttempts:'5'},{maxNoProgress:0},{maxNoProgress:2.5},{window:'release'}]){
  expect(()=>remediationPolicy(value as any)).toThrow();
 }
 expect(()=>validate(config({remediation:{maxAttempts:0}}))).toThrow();
 expect(()=>validate(config({remediation:{maxAttempts:null,maxNoProgress:3}}))).not.toThrow();
});

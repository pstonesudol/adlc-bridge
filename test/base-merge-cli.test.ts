import {test,expect} from 'bun:test';
import {authorizeBaseMerge} from '../src/cli';

test('base merge authority requires exactly three unambiguous positional arguments',()=>{
 const calls:string[][]=[];
 const lifecycle={grantBaseMerge:(...args:string[])=>{calls.push(args);return {mergePR:false};}};
 for(const args of [[],['job','hash'],['job','hash','--human','Patrick'],['job','hash','--human'],['job','hash',' -operator'],['job','hash',''],['job','hash','Patrick','extra']]){
  expect(()=>authorizeBaseMerge(lifecycle as any,args)).toThrow('exactly three positional');
 }
 expect(calls).toEqual([]);
 expect(authorizeBaseMerge(lifecycle as any,['job','hash','Patrick Stone'])).toEqual({mergePR:false});
 expect(calls).toEqual([['job','hash','Patrick Stone']]);
});

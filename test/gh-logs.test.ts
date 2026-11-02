import {test,expect} from 'bun:test';import {templateLogReader} from '../src/gh-logs';
test('template logs omit the escape flag on older gh and enable it from 2.97.0 onward',async()=>{
 for(const version of ['2.96.9','2.97.0','2.100.1','3.0.0']){
  const calls:string[][]=[],read=templateLogReader(async args=>{calls.push(args);return {code:0,out:args[0]==='--version'?`gh version ${version} (2026-01-01)`:'Missing section: Summary'};});
  const path='repos/owner/repo/actions/jobs/1/logs';expect(await read(path)).toBe('Missing section: Summary');await read(path);
  expect(calls.filter(args=>args[0]==='--version')).toHaveLength(1);expect(calls[1]).toEqual(['api',path,...(version==='2.96.9'?[]:['--allow-escape-sequences'])]);
 }
});
test('version and template-log command failures remain explicit',async()=>{
 await expect(templateLogReader(async()=>({code:1,out:''}))('logs')).rejects.toThrow('inspect GitHub CLI version');
 await expect(templateLogReader(async()=>({code:0,out:'unknown version'}))('logs')).rejects.toThrow('Unknown GitHub CLI version');
 await expect(templateLogReader(async args=>args[0]==='--version'?{code:0,out:'gh version 2.96.0'}:{code:1,out:''})('logs')).rejects.toThrow('logs unavailable');
});

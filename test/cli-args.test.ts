import {test,expect} from 'bun:test';
import {mkdtempSync,existsSync,readdirSync,rmSync} from 'node:fs';import {join,isAbsolute} from 'node:path';import {tmpdir} from 'node:os';
test('install rejects missing, option-like or relative --bin values before filesystem operations',()=>{
 const root=mkdtempSync(join(tmpdir(),'adlc-cli-bin-')),home=mkdtempSync(join(tmpdir(),'adlc-cli-home-'));try{
   for(const args of [['install','--apply','--bin','--apply'],['install','--bin'],['install','--bin','-x'],['install','--apply','--bin','relative/adlc'],['install','--bin','./adlc']]){
   const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),...args],{cwd:root,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_DB:join(home,'test.sqlite')}});
    expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toMatch(/Launcher path required|--bin requires (?:an absolute|a) launcher path/);expect(existsSync(join(root,'--apply'))).toBe(false);expect(existsSync(join(root,'Library/Application Support/ADLC Bridge/installation.json'))).toBe(false);expect(existsSync(join(home,'Library/Application Support/ADLC Bridge/installation.json'))).toBe(false);expect(readdirSync(root)).toEqual([]);
  }
  const launcher=join(root,'bin with spaces/adlc'),preview=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'install','--bin',launcher],{cwd:root,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_DB:join(home,'test.sqlite')}});
   expect(preview.exitCode).toBe(0);expect(JSON.parse(preview.stdout.toString()).launcher).toBe(launcher);expect(existsSync(launcher)).toBe(false);
   const defaults=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'install'],{cwd:root,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,ADLC_DB:join(home,'test.sqlite')}});
    // HOME is isolated, but /opt/homebrew/bin/adlc is a host-wide candidate.
    // Its intentional preservation guard is not a CLI argument failure.
    expect(defaults.stderr.toString()).not.toContain('--bin requires');
    if(defaults.exitCode===0){expect(JSON.parse(defaults.stdout.toString()).preview).toBe(true);expect(isAbsolute(JSON.parse(defaults.stdout.toString()).launcher)).toBe(true);}
    else{expect(defaults.stderr.toString()).toContain('Existing launcher is not recognizable; choose --bin PATH');expect(existsSync('/opt/homebrew/bin/adlc')).toBe(true);}
    expect(existsSync(join(home,'Library/Application Support/ADLC Bridge/installation.json'))).toBe(false);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(home,{recursive:true,force:true});}
});
test('CLI help advertises cleanup only as preview and reserves apply syntax for recovery',()=>{
 const result=Bun.spawnSync([process.execPath,join(import.meta.dir,'../src/cli.ts'),'help'],{env:{PATH:process.env.PATH??'/usr/bin:/bin'}}),help=result.stdout.toString();
 expect(result.exitCode).toBe(0);expect(help).toMatch(/recover JOB[^\n]*\n\s+\[--apply --confirm HASH\]/);expect(help).toMatch(/cleanup JOB[^\n]*preview-only/);expect(help).not.toContain('recover JOB | cleanup JOB');
});

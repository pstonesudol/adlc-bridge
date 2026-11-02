// Rebuild the local hotfix from a checksum-pinned official source archive. No Git.
import {mkdirSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
const revision='403a8c8385ed43bbf9e9289e3f3bbaa6517dc437';
const sha='c3d654baaef49743adc2dcfa458053ae103decbcefb11e5a2cb5627cbf126768';
const out=resolve(process.argv[2]??join(homedir(),'Library/Application Support/ADLC Bridge/builds',revision));
const go=process.env.ADLC_GO??'go';
async function run(args:string[],cwd?:string){const p=Bun.spawn(args,{cwd,stdout:'inherit',stderr:'inherit'});if(await p.exited!==0)throw Error('Build step failed');}
if(existsSync(out))throw Error('Build directory already exists; choose a new path');
const v=Bun.spawnSync([go,'version']);if(!v.stdout.toString().includes('go1.27.1 '))throw Error('Go 1.27.1 required (set ADLC_GO to its binary)');
mkdirSync(out,{recursive:true,mode:0o700});
try{
const r=await fetch(`https://codeload.github.com/OrchestratorInc/agent-orchestrator/tar.gz/${revision}`);if(!r.ok)throw Error('Official source download failed');
const bytes=new Uint8Array(await r.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==sha)throw Error('Source archive checksum mismatch');
writeFileSync(join(out,'source.tar.gz'),bytes);
await run(['tar','-xzf',join(out,'source.tar.gz'),'-C',out]);
const source=join(out,`agent-orchestrator-${revision}`);
await run(['patch','-p1','--batch','--forward','-i',resolve(import.meta.dir,'../patches/orchestrator-ci-reruns.patch')],source);
await run([go,'test','-race','./internal/adapters/scm/github'],join(source,'backend'));
await run([go,'build','-buildvcs=false','-o',join(out,'ao'), './cmd/ao'],join(source,'backend'));
}catch(e){try{rmSync(out,{recursive:true,force:true});}catch{console.error('Build directory cleanup needs inspection:',out);}throw e;}
console.log(`Built ${join(out,'ao')}. Register it with adlc install-runtime --binary PATH --apply while the stack is stopped.`);

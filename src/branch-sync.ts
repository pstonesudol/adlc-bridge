import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Store} from './core';
import {DeliveryRecovery} from './delivery-recovery';
import {command,recoveryTransport,type ProcessRunner} from './delivery-evidence';
import {assertDeliveryTarget} from './delivery-identity';
import {canonicalWorktree,assertWorktreeAvailable} from './worktree-reservation';
import {withTurnSubmission} from './turn-submission';
import {assertObservationFence,fencedIO} from './observation-fence';
import {BranchUpdates,branchTransport,branchUpdateBinding,type BranchTransport} from './branch-updates';
import {scopeAllows} from './file-scope';

class WorkerBusy extends Error{}

// Separate from the provider delivery ledger: remote observation is not local
// reconciliation. Retain the reservation on uncertain/unsafe outcomes.
export class BranchSync{
 constructor(public s:Store,public transport:BranchTransport=branchTransport,public run:ProcessRunner=command,public inspect=recoveryTransport(s,run,undefined,true).inspect,public submit=withTurnSubmission){
  new BranchUpdates(s,transport);
  s.db.exec(`CREATE TABLE IF NOT EXISTS branch_syncs(job TEXT PRIMARY KEY,worktree TEXT NOT NULL,state TEXT NOT NULL,proof TEXT NOT NULL,reason TEXT);`);
 }
 async ensure(job:string,c:any,repo:string,pr:number){return this.submit(async()=>{
   const git=(tree:string,...args:string[])=>fencedIO({run:this.run}).run(['git','--no-replace-objects','--no-optional-locks',...args],tree);
  const saved=this.s.db.query('SELECT * FROM branch_syncs WHERE job=?').get(job) as any;
  try{
   const auth=()=>new DeliveryRecovery(this.s,{} as any).authorization(job,c);
   const a=auth(),facts=await this.inspect(job,c),b=await this.transport.read(repo,pr);
   const intentCurrent=(row:any)=>{
    const intent=this.s.db.query('SELECT binding FROM branch_update_intents WHERE job=? AND head=? AND base=?').get(job,row.head,row.base) as any;
    if(intent){if(intent.binding!==branchUpdateBinding(this.s,job,repo,pr,b.branch))throw Error('Recorded branch update approval/session/worktree changed; explicit recovery authority required');return;}
    // Legacy rows have no request-time binding. Only a single original approval
    // can disambiguate their plan; never reinterpret an old update after replan.
    const approvals=this.s.db.query('SELECT plan_hash,at FROM approvals WHERE job=?').all(job) as any[];
    if(approvals.length!==1||approvals[0].plan_hash!==a.plan||Date.parse(approvals[0].at+'Z')>row.requested)throw Error('Legacy branch update approval provenance is ambiguous; explicit recovery authority required');
   };
   const validate=(f:any,snapshot:any)=>{
    if(repo!==c.githubRepo||c.automation?.orchestratorProject&&c.automation.orchestratorProject!==a.project||JSON.stringify(auth())!==JSON.stringify(a)||f.session!==a.session||f.project!==a.project||f.reserved!==a.reserved||f.worktree!==canonicalWorktree(a.worktree)||!f.isolated||f.owners.length!==1||f.owners[0]!==a.session)throw Error('Branch synchronization ownership/approval changed; inspect recover-handoff, preserve work');
    assertDeliveryTarget(this.s,job,{id:a.session,branch:a.reserved},repo,pr,snapshot);
    if(f.branch!==snapshot.branch||f.candidates.length!==1||f.candidates[0].pr!==pr||f.candidates[0].repo!==repo||f.candidates[0].head!==snapshot.head)throw Error('Branch synchronization PR identity changed; inspect recover-handoff');
    if(!f.clean)throw Error('Branch synchronization blocked by local edits; preserve edits and reconcile before retry');
   };
   validate(facts,b);
   if(!facts.idle)return {state:'waiting_for_worker',send:false,head:b.head,reason:'Branch synchronization deferred until the existing worker is verifiably idle'};
   if(facts.head===b.head&&(!saved||saved.state==='completed'))return null;
   const rows=this.s.db.query("SELECT * FROM branch_updates WHERE job=? AND state IN ('accepted','observed','remote_observed','delivery_uncertain')").all(job) as any[];
   const candidates=rows.filter(r=>r.head!==b.head);
   let proof:any=saved&&saved.state!=='completed'?JSON.parse(saved.proof):null;
   if(proof&&(JSON.stringify(proof.auth)!==JSON.stringify(a)||proof.repo!==repo||proof.pr!==pr||proof.target!==b.head||proof.base!==b.base||proof.branch!==b.branch))throw Error('Retained branch synchronization evidence changed; inspect recovery-status; never discard reservation');
    if(!proof){
    const proven=[];
    for(const row of candidates)if(row.head===facts.head&&this.transport.contains&&await this.transport.contains(repo,row.head,b.head)&&await this.transport.contains(repo,row.base,b.head))proven.push(row);
     if(proven.length>1)throw Error('Ambiguous recorded ADLC update provenance; explicit recovery authority required');
     if(proven.length===1){
      intentCurrent(proven[0]);
      proof={auth:a,repo,pr,branch:b.branch,predecessor:proven[0].head,inputBase:proven[0].base,target:b.head,base:b.base};
     }else{
      const missing=['inspect','fetch','merge-base-feature'].filter(op=>!JSON.parse(a.grant).includes(op));
      if(missing.length)throw Error(`External update provenance requires current grants: ${missing.join(', ')}`);
      const tracked=this.s.db.query("SELECT name FROM sqlite_master WHERE name='review_targets'").get()?this.s.db.query('SELECT * FROM review_targets WHERE job=?').get(job) as any:null;
      if(!tracked||tracked.repo!==repo||tracked.pr!==pr||tracked.head!==facts.head||!facts.lineage||!facts.completed)throw Error('External update provenance requires the previously verified tracked PR head and completed owned delivery');
      if(!c.conflictRecovery?.baseBranch||b.baseBranch!==c.conflictRecovery.baseBranch)throw Error('External update requires the configured base branch');
      // Do not reinterpret stale, unrelated or uncertain recorded intents as an
      // absent receipt. The recorded path above still handles an exact receipt.
      if(rows.some(row=>row.state!=='observed'))throw Error('Unmatched recorded update provenance; explicit recovery authority required');
      proof={source:'external-base-merge',auth:a,repo,pr,branch:b.branch,baseBranch:b.baseBranch,predecessor:facts.head,target:b.head,base:b.base};
     }
    this.s.db.transaction(()=>{
     assertObservationFence();assertWorktreeAvailable(this.s,job);if(JSON.stringify(auth())!==JSON.stringify(a))throw Error('Authorization changed before synchronization reservation');
     this.s.db.query("INSERT INTO branch_syncs VALUES (?,?,'reserved',?,NULL) ON CONFLICT(job) DO UPDATE SET worktree=excluded.worktree,state=excluded.state,proof=excluded.proof,reason=NULL WHERE branch_syncs.state='completed'").run(job,facts.worktree,JSON.stringify(proof));
    }).immediate();
   }
   const check=async()=>{
    assertObservationFence();
    assertWorktreeAvailable(this.s,job,undefined,undefined,JSON.stringify(proof));
    if(proof.source==='external-base-merge'){
     if(c.conflictRecovery?.baseBranch!==proof.baseBranch)throw Error('Configured base changed; preserve synchronization evidence');
     const tracked=this.s.db.query('SELECT * FROM review_targets WHERE job=?').get(job) as any;
     if(!tracked||tracked.repo!==repo||tracked.pr!==pr||tracked.head!==proof.predecessor)throw Error('Previously verified tracked head changed; preserve synchronization evidence');
     if(this.s.db.query("SELECT 1 FROM branch_updates WHERE job=? AND state IN ('accepted','remote_observed','delivery_uncertain')").get(job))throw Error('Update receipt changed during external synchronization');
    }else{
     const update=this.s.db.query("SELECT * FROM branch_updates WHERE job=? AND head=? AND base=? AND state IN ('accepted','observed','remote_observed','delivery_uncertain')").get(job,proof.predecessor,proof.inputBase) as any;
     if(!update)throw Error('Recorded update intent changed; preserve synchronization evidence');
     intentCurrent(update);
    }
     const fresh=await this.transport.read(repo,pr),f=await this.inspect(job,c);validate(f,fresh);
     if(proof.source==='external-base-merge'&&(!f.lineage||!f.completed))throw Error('Owned delivery completion or retained lineage changed');
    for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','sequencer','rebase-apply','rebase-merge','index.lock'])if(existsSync(resolve(f.worktree,await git(f.worktree,'rev-parse','--git-path',name))))throw Error(`Ongoing Git operation ${name}; preserve work and inspect`);
    if(!f.idle)throw new WorkerBusy('Branch synchronization deferred until the existing worker is verifiably idle; reservation retained');
    if(fresh.head!==proof.target||fresh.base!==proof.base||fresh.branch!==proof.branch||proof.source==='external-base-merge'&&fresh.baseBranch!==proof.baseBranch||![proof.predecessor,proof.target].includes(f.head))throw Error('Worker/head/base changed during branch synchronization; preserve reservation and recheck');
     if(await git(f.worktree,'ls-remote','--refs','origin',`refs/heads/${proof.branch}`)!==`${proof.target}\trefs/heads/${proof.branch}`)throw Error('Exact remote feature ref changed; preserve reservation');
     if(proof.source==='external-base-merge'&&await git(f.worktree,'ls-remote','--refs','origin',`refs/heads/${proof.baseBranch}`)!==`${proof.base}\trefs/heads/${proof.baseBranch}`)throw Error('Exact remote base ref changed; preserve reservation');
    if(JSON.stringify(auth())!==JSON.stringify(a))throw Error('Authorization changed immediately before branch synchronization; preserve reservation');
    return f;
   };
    let f=await check();
    if(f.head===proof.predecessor||proof.source==='external-base-merge'){
    this.s.db.query("UPDATE branch_syncs SET state='fetching',reason=NULL WHERE job=?").run(job);
     await git(f.worktree,'fetch','--no-tags','--no-write-fetch-head','origin',`refs/heads/${proof.branch}`,...proof.source==='external-base-merge'?[`refs/heads/${proof.baseBranch}`]:[]);
    // Both ancestry inputs alone allow unrelated appended commits. Require the
    // exact update-branch merge shape before adopting a provider result.
    const parents=(await git(f.worktree,'show','-s','--format=%P',proof.target)).split(' ');
     if(proof.source==='external-base-merge'){
      if(parents.length!==2||parents[0]!==proof.predecessor)throw Error('External head is not an exact two-parent base merge of the verified feature head');
      if(await git(f.worktree,'merge-base',parents[1],proof.base)!==parents[1])throw Error('External merge second parent is not from the configured base branch');
      // Reconstruct without changing HEAD/index/worktree. Disable configured
      // custom merge drivers: untrusted repository content must not select host
      // code execution to establish a provenance proof. Conflicts fail closed.
      const config=(await git(f.worktree,'config','--null','--list')).split('\0');
      const drivers=config.map(entry=>entry.split('\n')[0]).filter(key=>/^merge\..+\.driver$/i.test(key)).flatMap(key=>['-c',`${key}=false`]);
      let expected:string;
      try{expected=await git(f.worktree,...drivers,'-c','core.attributesFile=/dev/null','-c','merge.renormalize=false','merge-tree','--write-tree',proof.predecessor,parents[1]);}
      catch{throw Error('Cannot prove a clean external base merge tree; conflict resolution or merge-driver evidence requires explicit operator reconciliation');}
      if(!/^[a-f0-9]{40,64}$/.test(expected)||expected!==await git(f.worktree,'rev-parse',`${proof.target}^{tree}`))throw Error('External merge introduces independent feature edits or an ambiguous merge result');
      const paths=(await git(f.worktree,'diff','--name-only','--no-renames','-z',`${parents[1]}...${proof.target}`)).split('\0').filter(Boolean);
      if(paths.some(path=>!scopeAllows(path,JSON.parse(a.paths))))throw Error('External merge feature changes exceed approved scope');
     }else if(parents.length!==2||parents[0]!==proof.predecessor||parents[1]!==proof.inputBase)throw Error('Remote result is not the exact recorded update merge; explicit recovery authority required');
     f=await check();
     if(f.head===proof.predecessor){
     this.s.db.query("UPDATE branch_syncs SET state='updating' WHERE job=?").run(job);
     await git(f.worktree,'-c','core.hooksPath=/dev/null','merge','--ff-only','--no-overwrite-ignore','--no-edit',proof.target);
    }
   }
   f=await check();if(f.head!==proof.target)throw Error('Fast-forward outcome uncertain; inspect retained synchronization');
   this.s.db.transaction(()=>{
     assertObservationFence();if(JSON.stringify(auth())!==JSON.stringify(a))throw Error('Authorization changed before synchronization completion');
     if(proof.source!=='external-base-merge')this.s.db.query("UPDATE branch_updates SET state='observed',reason=NULL WHERE job=? AND head=? AND base=?").run(job,proof.predecessor,proof.inputBase);
     if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='review_targets'").get())this.s.db.query("UPDATE review_targets SET last_signature=NULL,state=CASE WHEN state='ready_for_human' THEN 'waiting_for_review' ELSE state END WHERE job=?").run(job);
    this.s.db.query("UPDATE branch_syncs SET state='completed',reason=NULL WHERE job=?").run(job);
     this.s.event(job,'feature_worktree_synchronized',JSON.stringify({head:proof.target,predecessor:proof.predecessor,source:proof.source??'recorded-update',reason:proof.source==='external-base-merge'?'Exact base merge tree, retained feature history, scope and current grants verified':'Exact recorded update merge verified',verification:'historical evidence remains SHA-bound; fresh verification required'}));
   }).immediate();
    return {state:'updating_branch',send:false,head:proof.target,maintenanceComplete:true,reason:'Owned worktree synchronized; collect fresh current-head CI/review/verification next poll'};
  }catch(error){
   const reason=error instanceof Error?error.message:'Branch synchronization evidence unavailable';
   assertObservationFence();this.s.db.query('UPDATE branch_syncs SET reason=? WHERE job=? AND state!=\'completed\'').run(reason,job);
    return {state:error instanceof WorkerBusy?'waiting_for_worker':'blocked',send:false,reason};
  }
 });}
}

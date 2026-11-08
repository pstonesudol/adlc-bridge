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

// Separate from the provider delivery ledger: remote observation is not local
// reconciliation. Retain the reservation on uncertain/unsafe outcomes.
export class BranchSync{
 constructor(public s:Store,public transport:BranchTransport=branchTransport,public run:ProcessRunner=command,public inspect=recoveryTransport(s,run,undefined,true).inspect,public submit=withTurnSubmission){
  new BranchUpdates(s,transport);
  s.db.exec(`CREATE TABLE IF NOT EXISTS branch_syncs(job TEXT PRIMARY KEY,worktree TEXT NOT NULL,state TEXT NOT NULL,proof TEXT NOT NULL,reason TEXT);`);
 }
 async ensure(job:string,c:any,repo:string,pr:number){return this.submit(async()=>{
  const git=(tree:string,...args:string[])=>fencedIO({run:this.run}).run(['git','--no-optional-locks',...args],tree);
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
    if(proven.length!==1)throw Error('Local/remote HEAD mismatch without unique recorded ADLC update provenance; explicit recovery authority required');
    intentCurrent(proven[0]);
    proof={auth:a,repo,pr,branch:b.branch,predecessor:proven[0].head,inputBase:proven[0].base,target:b.head,base:b.base};
    this.s.db.transaction(()=>{
     assertObservationFence();assertWorktreeAvailable(this.s,job);auth();
     this.s.db.query("INSERT INTO branch_syncs VALUES (?,?,'reserved',?,NULL) ON CONFLICT(job) DO UPDATE SET worktree=excluded.worktree,state=excluded.state,proof=excluded.proof,reason=NULL WHERE branch_syncs.state='completed'").run(job,facts.worktree,JSON.stringify(proof));
    }).immediate();
   }
   const check=async()=>{
    assertObservationFence();
    assertWorktreeAvailable(this.s,job,undefined,undefined,JSON.stringify(proof));
    const update=this.s.db.query("SELECT * FROM branch_updates WHERE job=? AND head=? AND base=? AND state IN ('accepted','observed','remote_observed','delivery_uncertain')").get(job,proof.predecessor,proof.inputBase) as any;
    if(!update)throw Error('Recorded update intent changed; preserve synchronization evidence');
    intentCurrent(update);
    const fresh=await this.transport.read(repo,pr),f=await this.inspect(job,c);validate(f,fresh);
    for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','sequencer','rebase-apply','rebase-merge','index.lock'])if(existsSync(resolve(f.worktree,await git(f.worktree,'rev-parse','--git-path',name))))throw Error(`Ongoing Git operation ${name}; preserve work and inspect`);
    if(!f.idle||fresh.head!==proof.target||fresh.base!==proof.base||fresh.branch!==proof.branch||![proof.predecessor,proof.target].includes(f.head))throw Error('Worker/head/base changed during branch synchronization; preserve reservation and recheck');
    if(await git(f.worktree,'ls-remote','--refs','origin',`refs/heads/${proof.branch}`)!==`${proof.target}\trefs/heads/${proof.branch}`)throw Error('Exact remote feature ref changed; preserve reservation');
    if(JSON.stringify(auth())!==JSON.stringify(a))throw Error('Authorization changed immediately before branch synchronization; preserve reservation');
    return f;
   };
   let f=await check();
   if(f.head===proof.predecessor){
    this.s.db.query("UPDATE branch_syncs SET state='fetching',reason=NULL WHERE job=?").run(job);
    await git(f.worktree,'fetch','--no-tags','--no-write-fetch-head','origin',`refs/heads/${proof.branch}`);
    // Both ancestry inputs alone allow unrelated appended commits. Require the
    // exact update-branch merge shape before adopting a provider result.
    const parents=(await git(f.worktree,'show','-s','--format=%P',proof.target)).split(' ');
    if(parents.length!==2||parents[0]!==proof.predecessor||parents[1]!==proof.inputBase)throw Error('Remote result is not the exact recorded update merge; explicit recovery authority required');
    f=await check();
    if(f.head===proof.predecessor){
     this.s.db.query("UPDATE branch_syncs SET state='updating' WHERE job=?").run(job);
     await git(f.worktree,'-c','core.hooksPath=/dev/null','merge','--ff-only','--no-overwrite-ignore','--no-edit',proof.target);
    }
   }
   f=await check();if(f.head!==proof.target)throw Error('Fast-forward outcome uncertain; inspect retained synchronization');
   this.s.db.transaction(()=>{
    assertObservationFence();auth();
    this.s.db.query("UPDATE branch_updates SET state='observed',reason=NULL WHERE job=? AND head=? AND base=?").run(job,proof.predecessor,proof.inputBase);
    this.s.db.query("UPDATE branch_syncs SET state='completed',reason=NULL WHERE job=?").run(job);
    this.s.event(job,'feature_worktree_synchronized',JSON.stringify({head:proof.target,predecessor:proof.predecessor,verification:'historical evidence remains SHA-bound; fresh verification required'}));
   }).immediate();
    return {state:'updating_branch',send:false,head:proof.target,maintenanceComplete:true,reason:'Owned worktree synchronized; collect fresh current-head CI/review/verification next poll'};
  }catch(error){
   const reason=error instanceof Error?error.message:'Branch synchronization evidence unavailable';
   assertObservationFence();this.s.db.query('UPDATE branch_syncs SET reason=? WHERE job=? AND state!=\'completed\'').run(reason,job);
   return {state:'blocked',send:false,reason};
  }
 });}
}

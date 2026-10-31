import {ApprovalPolicyStore} from './approval-policy';
import {Store,digest} from './core';

export type Session = {id:string;correlation:string;worktree:string;controller:'running'|'stopped'|'unknown'};
export type Transport = {start(request:{correlation:string;spec:string;plan:string}):Promise<Session>};
const allowedGit=new Set(['inspect','fetch','worktree','branch','commit','push-feature','open-pr']);

/** Durable host coordination. Transport remains disconnected until a restricted
 * worker runtime is validated. This store must never be writable by that runtime. */
export class Lifecycle {
  constructor(public s:Store) {
    s.db.exec(`CREATE TABLE IF NOT EXISTS git_grants (
      job TEXT PRIMARY KEY REFERENCES jobs(id), plan_hash TEXT NOT NULL,
      operations TEXT NOT NULL, actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
      job TEXT PRIMARY KEY REFERENCES jobs(id), correlation TEXT NOT NULL UNIQUE,
      plan_hash TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT, worktree TEXT,
      owner TEXT NOT NULL DEFAULT 'orchestrator', reason TEXT);
      CREATE TABLE IF NOT EXISTS remediation (
      job TEXT NOT NULL REFERENCES jobs(id), head TEXT NOT NULL, findings_hash TEXT NOT NULL,
      attempt INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(job,head,findings_hash));`);
  }
  grantGit(job:string,hash:string,operations:string[],actor:string) {
    if(!actor.trim()||!operations.length||operations.some(op=>!allowedGit.has(op)))throw Error('Invalid scoped Git authorization');
    this.s.db.transaction(()=>{
      const j=this.current(job);if(j.plan_hash!==hash)throw Error('Stale Git grant');
      this.s.db.query('INSERT INTO git_grants VALUES (?,?,?,?) ON CONFLICT(job) DO UPDATE SET plan_hash=excluded.plan_hash,operations=excluded.operations,actor=excluded.actor')
        .run(job,hash,JSON.stringify([...new Set(operations)]),actor);
      this.s.event(job,'git_scope_recorded',JSON.stringify({hash,operations,actor}));
    })();
  }
  current(job:string) {
    const j=this.s.get(job);
    if(j.state!=='approved'||!j.actor||!j.plan||j.plan_hash!==j.approved_hash||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan])))throw Error('Current plan approval required');
    if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='policy_authorizations'").get())new ApprovalPolicyStore(this.s).assertEligible(job);
    return j;
  }
  async dispatch(job:string,transport:Transport,runtime:{isolated:boolean;hostVerified:boolean}) {
    // Not exposed by the CLI. These booleans are a dependency contract, not
    // evidence of isolation; a production host verifier is still required.
    if(!runtime.isolated||!runtime.hostVerified)throw Error('Verified isolated worker runtime required');
    const request=this.s.db.transaction(()=>{
      const j=this.current(job);
      const grant=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
      const required=['inspect','fetch','worktree','branch'];
      if(!grant||grant.plan_hash!==j.plan_hash||required.some(op=>!JSON.parse(grant.operations).includes(op)))throw Error('Scoped Git authorization required');
      if(this.s.db.query('SELECT job FROM runs WHERE job=?').get(job))throw Error('Existing run requires reconciliation; never retry blindly');
      const correlation=digest(JSON.stringify([job,j.plan_hash]));
      this.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state) VALUES (?,?,?,?)').run(job,correlation,j.plan_hash,'dispatching');
      this.s.event(job,'dispatch_reserved',correlation);
      return {correlation,spec:j.spec,plan:j.plan};
    })();
    try {
      const session=await transport.start(request);
      if(!session.id||session.correlation!==request.correlation||!session.worktree.startsWith('/'))throw Error('Unverifiable session receipt');
      this.s.db.transaction(()=>{
        const j=this.s.get(job);
        // A plan can be revoked while the external transport is starting.
        const current=j.state==='approved'&&j.plan_hash===j.approved_hash&&digest(JSON.stringify([j.spec,j.plan]))===j.plan_hash;
        this.s.db.query('UPDATE runs SET state=?,session_id=?,worktree=?,reason=? WHERE job=?')
          .run(current?'running':'needs_reconciliation',session.id,session.worktree,current?null:'Approval changed during dispatch; stop and inspect session',job);
        this.s.event(job,'session_receipt',session.id);
      })();
      return this.run(job);
    }catch{
      this.s.db.query("UPDATE runs SET state='needs_reconciliation',reason='Transport outcome uncertain; inspect before any retry' WHERE job=?").run(job);
      this.s.event(job,'dispatch_uncertain',request.correlation);
      throw Error('Dispatch uncertain; reconcile before retrying');
    }
  }
  adoptSupervised(job:string,session:Session) {
    // Recovery/adoption of an already-running, human-supervised pilot only.
    // This does not satisfy the isolated-runtime contract for new dispatches.
    return this.s.db.transaction(()=>{
      const j=this.current(job);
      const p=this.s.db.query('SELECT * FROM planning_runs WHERE job=?').get(job) as any;
      if(!p||p.session_id!==session.id||p.worktree!==session.worktree||p.correlation!==session.correlation||session.controller==='unknown')throw Error('Verified existing planning session required');
      const old=this.run(job);
      if(old){if(old.session_id!==session.id||old.plan_hash!==j.plan_hash)throw Error('Existing run needs reconciliation');return old;}
      this.s.db.query('INSERT INTO runs(job,correlation,plan_hash,state,session_id,worktree,reason) VALUES (?,?,?,?,?,?,?)')
        .run(job,session.correlation,j.plan_hash,'running',session.id,session.worktree,'Supervised host pilot; agent containment not verified');
      this.s.event(job,'supervised_existing_session_adopted',JSON.stringify(session));return this.run(job);
    })();
  }
  run(job:string):any{return this.s.db.query('SELECT * FROM runs WHERE job=?').get(job);}
  reconcile(job:string,sessions:Session[],complete:boolean) {
    if(!complete)throw Error('Complete authoritative session inventory required');
    return this.s.db.transaction(()=>{
      const r=this.run(job);if(!r)throw Error('No run to reconcile');
      const matches=sessions.filter(x=>x.correlation===r.correlation);
      if(matches.length!==1){
        this.s.db.query("UPDATE runs SET state='needs_reconciliation',reason=? WHERE job=?").run(matches.length?'Multiple matching sessions':'No matching session; human recovery required',job);
      }else{
        const x=matches[0];const j=this.s.get(job);
        const valid=j.state==='approved'&&j.approved_hash===r.plan_hash&&j.plan_hash===r.plan_hash;
        const state=r.owner==='human'?(x.controller==='stopped'?'human_control':'needs_reconciliation'):
          valid&&x.controller==='running'?'running':'needs_reconciliation';
        this.s.db.query('UPDATE runs SET session_id=?,worktree=?,state=?,reason=? WHERE job=?')
          .run(x.id,x.worktree,state,state==='needs_reconciliation'?'Inspect approval and controller state':null,job);
      }
      this.s.event(job,'run_reconciled',r.correlation);return this.run(job);
    })();
  }
  reserveRemediation(job:string,head:string,findings:string) {
    if(!/^[a-f0-9]{40,64}$/.test(head)||!findings.trim())throw Error('Current SHA and actionable findings required');
    return this.s.db.transaction(()=>{
      this.current(job);const r=this.run(job);
      if(!r||r.state!=='running'||r.owner!=='orchestrator')throw Error('Active agent-owned run required');
      const hash=digest(findings);
      const previous=this.s.db.query('SELECT * FROM remediation WHERE job=? AND head=? AND findings_hash=?').get(job,head,hash);
      if(previous)return previous;
      const j=this.s.get(job);
      if(j.attempts>=5){
        this.s.db.query("UPDATE jobs SET state='blocked',reason='Remediation limit exhausted' WHERE id=?").run(job);
        this.s.db.query("UPDATE runs SET state='blocked',reason='Remediation limit exhausted' WHERE job=?").run(job);
        this.s.event(job,'remediation_exhausted',head);return {blocked:true,attempts:j.attempts};
      }
      const attempt=j.attempts+1;
      this.s.db.query('UPDATE jobs SET attempts=? WHERE id=?').run(attempt,job);
      this.s.db.query('INSERT INTO remediation VALUES (?,?,?,?,?)').run(job,head,hash,attempt,'reserved');
      this.s.event(job,'remediation_reserved',JSON.stringify({head,hash,attempt}));
      return {job,head,findings_hash:hash,attempt,state:'reserved'};
    })();
  }
  takeHumanControl(job:string,receipt:Session,processesStopped:boolean) {
    return this.s.db.transaction(()=>{
      const r=this.run(job);
      if(!r||receipt.id!==r.session_id||receipt.correlation!==r.correlation||receipt.worktree!==r.worktree||receipt.controller!=='stopped'||!processesStopped)throw Error('Verified stopped controller and worktree processes required');
      this.s.db.query("UPDATE runs SET owner='human',state='human_control',reason=NULL WHERE job=?").run(job);
      // Human edits can change scope. Returning control always requires review.
      this.s.db.query("UPDATE jobs SET state='awaiting_approval',approved_hash=NULL,actor=NULL WHERE id=?").run(job);
      this.s.event(job,'human_control_taken',receipt.worktree);return this.run(job);
    })();
  }
  summary(){return this.s.db.query('SELECT job,correlation,state,session_id,worktree,owner,reason FROM runs').all();}
}

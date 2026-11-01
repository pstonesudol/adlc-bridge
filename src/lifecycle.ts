import {ApprovalPolicyStore} from './approval-policy';
import {Store,digest} from './core';
import {DEFAULT_REMEDIATION_POLICY,remediationPolicy,remediationSummary,type RemediationPolicy,type RemediationSummary} from './remediation';

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
      attempt INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(job,head,findings_hash));
      CREATE TABLE IF NOT EXISTS remediation_budget (
      job TEXT PRIMARY KEY REFERENCES jobs(id), consumed INTEGER NOT NULL DEFAULT 0,
      extensions INTEGER NOT NULL DEFAULT 0, no_progress INTEGER NOT NULL DEFAULT 0,
      last_head TEXT, last_findings_hash TEXT, last_attempt INTEGER,
      stop_reason TEXT, configured_max_attempts INTEGER, configured_max_no_progress INTEGER,
      window TEXT NOT NULL DEFAULT 'job', updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS remediation_budget_extensions (
      seq INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id), plan_hash TEXT NOT NULL,
      head TEXT NOT NULL, actor TEXT NOT NULL, additional INTEGER NOT NULL, reason TEXT,
      consumed INTEGER NOT NULL, extensions INTEGER NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  }

  private ensureBudget(job:string){
    const j=this.s.get(job);
    this.s.db.query('INSERT OR IGNORE INTO remediation_budget(job,consumed,no_progress,configured_max_attempts,configured_max_no_progress,window) VALUES (?,?,?,?,?,?)')
      .run(job,j.attempts,0,DEFAULT_REMEDIATION_POLICY.maxAttempts,DEFAULT_REMEDIATION_POLICY.maxNoProgress,DEFAULT_REMEDIATION_POLICY.window);
    return this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any;
  }

  private summarizeBudget(job:string,row:any,policy?:RemediationPolicy){
    const effective=policy??{
      maxAttempts:row.configured_max_attempts===null?null:(row.configured_max_attempts??DEFAULT_REMEDIATION_POLICY.maxAttempts),
      maxNoProgress:row.configured_max_no_progress??DEFAULT_REMEDIATION_POLICY.maxNoProgress,
      window:(row.window??DEFAULT_REMEDIATION_POLICY.window) as 'job',
    };
    return remediationSummary({job,policy:effective,consumed:row.consumed,extensions:row.extensions,noProgress:row.no_progress,stopReason:row.stop_reason});
  }

  budgetPolicy(job:string):RemediationPolicy {
    const row=this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any;
    if(!row)return {...DEFAULT_REMEDIATION_POLICY};
    return remediationPolicy({
      maxAttempts:row.configured_max_attempts===null?null:row.configured_max_attempts,
      maxNoProgress:row.configured_max_no_progress,
      window:row.window,
    });
  }

  budgetSummary(job:string,policyInput?:RemediationPolicy):RemediationSummary {
    const j=this.s.get(job),row=this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any;
    if(row)return this.summarizeBudget(job,row,policyInput?remediationPolicy(policyInput):undefined);
    const policy=remediationPolicy(policyInput);
    return remediationSummary({job,policy,consumed:j.attempts,extensions:0,noProgress:0,stopReason:null});
  }

  recordRemediationPolicy(job:string,policyInput:RemediationPolicy){
    const policy=remediationPolicy(policyInput);
    return this.s.db.transaction(()=>{
      const row=this.ensureBudget(job);
      if(row.configured_max_attempts===policy.maxAttempts&&row.configured_max_no_progress===policy.maxNoProgress&&row.window===policy.window)return this.summarizeBudget(job,row,policy);
      this.s.db.query('UPDATE remediation_budget SET configured_max_attempts=?,configured_max_no_progress=?,window=?,updated=CURRENT_TIMESTAMP WHERE job=?')
        .run(policy.maxAttempts,policy.maxNoProgress,policy.window,job);
      this.s.event(job,'remediation_policy_observed',JSON.stringify(policy));
      return this.summarizeBudget(job,this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any,policy);
    })();
  }

  private stopBudget(job:string,row:any,reason:string,total:number,policy:RemediationPolicy){
    this.s.db.query('UPDATE remediation_budget SET stop_reason=?,configured_max_attempts=?,configured_max_no_progress=?,window=?,updated=CURRENT_TIMESTAMP WHERE job=?')
      .run(reason,policy.maxAttempts,policy.maxNoProgress,policy.window,job);
    const detail=reason==='no_progress_exhausted'
      ?`No-progress remediation threshold exhausted (${row.no_progress}/${policy.maxNoProgress})`
      :`Remediation budget exhausted (${total}${policy.maxAttempts===null?'':'/'+(policy.maxAttempts+row.extensions)})`;
    this.s.db.query("UPDATE jobs SET state='blocked',reason=? WHERE id=? AND state!='done'").run(detail,job);
    this.s.db.query("UPDATE runs SET state='blocked',reason=? WHERE job=? AND state!='completed'").run(detail,job);
    this.s.event(job,reason,JSON.stringify({consumed:row.consumed,noProgress:row.no_progress,extensions:row.extensions}));
    const updated=this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any;
    return {blocked:true,reason:detail,budget:this.summarizeBudget(job,updated,policy)};
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
  reserveRemediation(job:string,head:string,findings:string,policyInput:RemediationPolicy=DEFAULT_REMEDIATION_POLICY) {
    if(!/^[a-f0-9]{40,64}$/.test(head)||!findings.trim())throw Error('Current SHA and actionable findings required');
    const policy=remediationPolicy(policyInput);
    return this.s.db.transaction(()=>{
      this.current(job);const r=this.run(job);
      if(!r||r.state!=='running'||r.owner!=='orchestrator')throw Error('Active agent-owned run required');
      const hash=digest(findings),budget=this.ensureBudget(job);
      const previous=this.s.db.query('SELECT * FROM remediation WHERE job=? AND head=? AND findings_hash=?').get(job,head,hash) as any;
      if(previous)return {...previous,budget:this.summarizeBudget(job,budget,policy)};
      const uncertain=this.s.db.query("SELECT * FROM remediation WHERE job=? AND state='delivery_uncertain' ORDER BY attempt DESC LIMIT 1").get(job);
      if(uncertain)return {blocked:true,reason:'Previous remediation delivery is uncertain; reconcile it before reserving another attempt',budget:this.summarizeBudget(job,budget,policy)};
      if(budget.stop_reason)return {blocked:true,reason:`Remediation is stopped (${budget.stop_reason}); authorized budget extension required`,budget:this.summarizeBudget(job,budget,policy)};
      const effective=policy.maxAttempts===null?null:policy.maxAttempts+budget.extensions;
      if(effective!==null&&budget.consumed>=effective)return this.stopBudget(job,budget,'budget_exhausted',budget.consumed,policy);
      const prior=budget.last_attempt?this.s.db.query('SELECT * FROM remediation WHERE job=? AND attempt=?').get(job,budget.last_attempt) as any:null;
      const progressed=!!(prior&&prior.state==='completed'&&prior.head!==head&&prior.findings_hash!==hash);
      const noProgress=progressed?0:budget.no_progress+1;
      if(noProgress>policy.maxNoProgress){
        this.s.db.query('UPDATE remediation_budget SET no_progress=?,configured_max_attempts=?,configured_max_no_progress=?,window=? WHERE job=?').run(noProgress,policy.maxAttempts,policy.maxNoProgress,policy.window,job);
        const stopped=this.stopBudget(job,{...budget,no_progress:noProgress},'no_progress_exhausted',budget.consumed,policy);
        return {...stopped,reason:`No-progress remediation threshold exhausted (${noProgress}/${policy.maxNoProgress}); authorized budget extension required`};
      }
      const j=this.s.get(job),attempt=j.attempts+1;
      this.s.db.query('UPDATE jobs SET attempts=? WHERE id=?').run(attempt,job);
      this.s.db.query(`UPDATE remediation_budget SET consumed=consumed+1,no_progress=?,last_head=?,last_findings_hash=?,last_attempt=?,
        stop_reason=NULL,configured_max_attempts=?,configured_max_no_progress=?,window=?,updated=CURRENT_TIMESTAMP WHERE job=?`)
        .run(noProgress,head,hash,attempt,policy.maxAttempts,policy.maxNoProgress,policy.window,job);
      this.s.db.query('INSERT INTO remediation VALUES (?,?,?,?,?)').run(job,head,hash,attempt,'reserved');
      const updated=this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any;
      this.s.event(job,'remediation_reserved',JSON.stringify({head,hash,attempt,progressed,budget:this.summarizeBudget(job,updated,policy)}));
      return {job,head,findings_hash:hash,attempt,state:'reserved',budget:this.summarizeBudget(job,updated,policy)};
    }).immediate();
  }

  extendRemediationBudget(job:string,options:{actor:string;additional:number;head:string;policy:RemediationPolicy;reason?:string;confirm?:string}){
    const actor=options.actor?.trim(),head=options.head,additional=options.additional,policy=remediationPolicy(options.policy);
    if(!actor)throw Error('Human operator identity required');
    if(!Number.isSafeInteger(additional)||additional<1)throw Error('Positive additional remediation budget required');
    if(!/^[a-f0-9]{40,64}$/.test(head))throw Error('Current PR head required');
    return this.s.db.transaction(()=>{
      const j=this.s.get(job);
      if(!j.plan||!j.actor||j.plan_hash!==j.approved_hash||j.plan_hash!==digest(JSON.stringify([j.spec,j.plan]))||!['approved','blocked'].includes(j.state))throw Error('Current plan approval required');
      if(this.s.db.query("SELECT name FROM sqlite_master WHERE name='policy_authorizations'").get())new ApprovalPolicyStore(this.s).assertEligible(job);
      const run=this.run(job);if(!run||run.owner!=='orchestrator'||run.plan_hash!==j.plan_hash)throw Error('Existing owned job required');
      const budget=this.ensureBudget(job);
      if(!budget.stop_reason)throw Error('Remediation budget is not exhausted; extension refused');
      if(policy.maxAttempts===null&&budget.stop_reason!=='no_progress_exhausted')throw Error('Uncapped remediation budgets only support recovery from no-progress stops');
      if(this.s.db.query("SELECT 1 FROM remediation WHERE job=? AND state='delivery_uncertain'").get(job))throw Error('Prior delivery uncertainty must be reconciled before extension');
      const target=this.s.db.query("SELECT name FROM sqlite_master WHERE name='review_targets'").get()
        ?this.s.db.query('SELECT * FROM review_targets WHERE job=?').get(job) as any:null;
      if(!target||target.head!==head)throw Error('Current review target and exact PR head required');
      const grant=this.s.db.query('SELECT * FROM git_grants WHERE job=?').get(job) as any;
      if(!grant||grant.plan_hash!==j.plan_hash||!['open-pr','push-feature'].some(op=>JSON.parse(grant.operations).includes(op)))throw Error('Current scoped GitHub authorization required');
      const previewHash=digest(JSON.stringify([job,j.plan_hash,head,actor,additional,budget.consumed,budget.extensions,budget.no_progress,budget.stop_reason,policy]));
      const summary=this.summarizeBudget(job,budget,policy);
      if(options.confirm!==previewHash)return {preview:true,confirmHash:previewHash,head,additional,actor,reason:options.reason??null,budget:summary};
      const nextExtensions=budget.extensions+additional;
      // The human extension is explicit fresh authority; reset only the
      // consecutive no-progress counter. Consumed/audit counts remain intact.
      this.s.db.query('UPDATE remediation_budget SET extensions=?,no_progress=0,stop_reason=NULL,configured_max_attempts=?,configured_max_no_progress=?,window=?,updated=CURRENT_TIMESTAMP WHERE job=?')
        .run(nextExtensions,policy.maxAttempts,policy.maxNoProgress,policy.window,job);
      this.s.db.query('INSERT INTO remediation_budget_extensions(job,plan_hash,head,actor,additional,reason,consumed,extensions) VALUES (?,?,?,?,?,?,?,?)')
        .run(job,j.plan_hash,head,actor,additional,options.reason??null,budget.consumed,nextExtensions);
      if(j.state==='blocked')this.s.db.query("UPDATE jobs SET state='approved',reason=NULL,updated=CURRENT_TIMESTAMP WHERE id=?").run(job);
      if(run.state==='blocked')this.s.db.query("UPDATE runs SET state='running',reason=NULL WHERE job=?").run(job);
      if(target)this.s.db.query("UPDATE review_targets SET state='remediation_pending',reason='Budget extended; next poll reevaluates current evidence' WHERE job=?").run(job);
      const updated=this.s.db.query('SELECT * FROM remediation_budget WHERE job=?').get(job) as any;
      this.s.event(job,'remediation_budget_extended',JSON.stringify({actor,additional,head,previewHash,totalExtensions:nextExtensions,consumed:budget.consumed}));
      return {preview:false,head,additional,actor,budget:this.summarizeBudget(job,updated,policy)};
    }).immediate();
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

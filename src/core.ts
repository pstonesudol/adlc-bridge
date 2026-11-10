import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {installRevisions,recordRevision,observeLegacyRevision,latestRevision} from './spec-revisions';
import {latestWorkflowChecks} from './check-runs';
// Copied-source diagnostics may have no package manifest. Never invent a release.
const runtimeVersion=(()=>{try{const v=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;return typeof v==='string'?v:'unknown';}catch{return 'unknown';}})();

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export type State = 'awaiting_plan' | 'awaiting_approval' | 'approved' | 'blocked' | 'done';
export class Store {
  db: Database;
  static readonly(path:string){
    return new Store(path,true);
  }
  readonly: boolean;
  constructor(path: string, readonly=false) {
    this.readonly=readonly;
    if(readonly){
      this.db=new Database(path,{readonly:true,create:false});
      try {
        const version = (this.db.query('PRAGMA user_version').get() as any).user_version;
        if (!Number.isInteger(version) || version < 0 || version > 2) throw Error(`Unsupported SQLite schema version: ${version}`);
        if (version === 0 && this.db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get()) throw Error('Unversioned nonempty database; refusing read-only access');
      } catch (error) { this.db.close(); throw error; }
      return;
    }
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.db = new Database(path, { create: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    try {
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const initialVersion = (this.db.query('PRAGMA user_version').get() as any).user_version;
    if (initialVersion > 2) throw Error(`Unsupported SQLite schema version: ${initialVersion}`);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.transaction(() => {
      const version = (this.db.query('PRAGMA user_version').get() as any).user_version;
      if (!Number.isInteger(version) || version < 0 || version > 2) throw Error(`Unsupported SQLite schema version: ${version}`);
      if (version === 0) {
        if (this.db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get()) throw Error('Unversioned nonempty database; refusing initialization');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, issue TEXT NOT NULL,
        spec TEXT NOT NULL, state TEXT NOT NULL, plan TEXT, plan_hash TEXT,
        approved_hash TEXT, actor TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        reason TEXT, updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project, issue));
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id),
        kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS approvals (
        seq INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id),
        plan_hash TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      PRAGMA user_version=1;`);
      }
      // Validate the legacy contract before advancing its version. Extra module tables
      // are intentionally retained: their initialization remains owned by each module.
      this.db.query('SELECT id,project,issue,spec,state,plan,plan_hash,approved_hash,actor,attempts,reason,updated FROM jobs LIMIT 0').all();
      this.db.query('SELECT seq,job,kind,detail,at FROM events LIMIT 0').all();
      this.db.query('SELECT seq,job,plan_hash,actor,at FROM approvals LIMIT 0').all();
      if (version < 2) {
        // An index with the right name may still have the wrong definition (for
        // example UNIQUE or different columns). Validate before advancing the
        // version so a conflicting database fails here instead of on a later write.
        const matches=(name:string,table:string,columns:string[])=>{
          const existing=this.db.query("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(name) as any;
          if(!existing)return false;
          if(existing.tbl_name!==table)throw Error(`Conflicting index definition: ${name}`);
          const entry=(this.db.query('SELECT * FROM pragma_index_list(?)').all(table) as any[]).find((x:any)=>x.name===name);
          const actual=entry?(this.db.query('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(name) as any[]).map((x:any)=>x.name):[];
          if(!entry||entry.unique!==0||entry.partial!==0||actual.length!==columns.length||actual.some((c:string,i:number)=>c!==columns[i]))throw Error(`Conflicting index definition: ${name}`);
          return true;
        };
        if(!matches('events_job_seq','events',['job','seq']))this.db.exec('CREATE INDEX events_job_seq ON events(job,seq);');
        if(!matches('approvals_job_seq','approvals',['job','seq']))this.db.exec('CREATE INDEX approvals_job_seq ON approvals(job,seq);');
        this.db.exec('PRAGMA user_version=2;');
      }
    }).immediate();
    installRevisions(this);
    this.db.exec(`CREATE TABLE IF NOT EXISTS event_provenance (
      seq INTEGER PRIMARY KEY REFERENCES events(seq), event_ms INTEGER NOT NULL,
      runtime_version TEXT NOT NULL, attempt INTEGER NOT NULL, plan_hash TEXT,
      detail_hash TEXT NOT NULL);`);
    } catch (error) { this.db.close(); throw error; }
  }
  event(id: string, kind: string, detail: string) {
    this.db.transaction(()=>{
      const job=this.get(id);
      const now=Date.now();
      const event=this.db.query('INSERT INTO events(job,kind,detail,at) VALUES (?,?,?,?)').run(id, kind, detail,new Date(now).toISOString());
      this.db.query('INSERT INTO event_provenance VALUES (?,?,?,?,?,?)').run(event.lastInsertRowid,now,runtimeVersion,job.attempts,job.plan_hash,digest(detail));
    }).immediate();
  }
  enqueue(project: string, issue: string, spec: string) {
    if (!project || !issue || !spec.trim()) throw Error('Project, issue and specification required');
    const id = digest(JSON.stringify([project, issue]));
    return this.db.transaction(() => {
      const old = this.db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
      if (!old) {
        this.db.query('INSERT INTO jobs(id,project,issue,spec,state) VALUES (?,?,?,?,?)')
          .run(id, project, issue, spec, 'awaiting_plan');
        this.event(id, 'ingested', digest(spec));
      } else if (old.spec !== spec || (old.state === 'blocked' && old.reason === 'No longer eligible in Linear')) {
        if(old.spec!==spec)recordRevision(this,old,spec);
        this.db.query(`UPDATE jobs SET spec=?,state='awaiting_plan',plan=NULL,plan_hash=NULL,
          approved_hash=NULL,actor=NULL,reason=NULL,updated=CURRENT_TIMESTAMP WHERE id=?`).run(spec, id);
        this.event(id, 'spec_changed_approval_revoked', digest(spec));
      }
      observeLegacyRevision(this,id);
      return id;
    }).immediate();
  }
  get(id: string): any {
    const row = this.db.query('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw Error('Unknown job');
    return row;
  }
  list() { return this.db.query('SELECT id,project,issue,state,plan_hash,attempts,reason,updated FROM jobs ORDER BY updated,id').all(); }
  propose(id: string, plan: string, expectRevision?: string | null) {
    if (!plan.trim()) throw Error('Empty plan');
    return this.db.transaction(() => {
      if (expectRevision !== undefined && (latestRevision(this, id)?.id ?? null) !== expectRevision) throw Error('Requirement revision changed before plan submission; refresh evidence');
      const job = this.get(id);
      const hash = digest(JSON.stringify([job.spec, plan]));
      this.db.query(`UPDATE jobs SET plan=?,plan_hash=?,approved_hash=NULL,actor=NULL,
        state='awaiting_approval',reason=NULL,updated=CURRENT_TIMESTAMP WHERE id=?`).run(plan, hash, id);
      this.event(id, 'plan_proposed', hash);
      return hash;
    }).immediate();
  }
  approve(id: string, hash: string, actor: string, source:'human'|'standing-policy'='human') {
    if (!actor.trim()) throw Error('Human approver required');
    this.db.transaction(() => {
      const job = this.get(id);
      if (job.state !== 'awaiting_approval' || hash !== job.plan_hash) throw Error('Stale plan or invalid state');
      this.db.query(`UPDATE jobs SET approved_hash=?,actor=?,state='approved',updated=CURRENT_TIMESTAMP WHERE id=?`).run(hash, actor, id);
      this.db.query('INSERT INTO approvals(job,plan_hash,actor) VALUES (?,?,?)').run(id, hash, actor);
      this.event(id, source==='human'?'human_plan_approval_recorded':'standing_policy_plan_authorized', hash);
    })();
  }
  close() { this.db.close(); }
}

export type Check = { name: string; sha: string; app: string; status: string; conclusion: string | null; id?:number; started_at?:string|null; completed_at?:string|null };
export type ReviewEvidence = {
  head: string; observedHead: string; required: string[]; checks: Check[];
  review: { sha: string; author: string; state: string } | null;
  unresolved: number | null; threadsComplete: boolean; checksComplete: boolean;
  reviewComplete: boolean; coderabbitApprovalRequired?: boolean;
};
// Pure gate, not a live GitHub adapter. Missing/paginated/stale evidence fails closed.
export function reviewGate(e: ReviewEvidence): { clear: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!e.head || e.head !== e.observedHead) reasons.push('Head changed');
  if (!e.checksComplete || !e.threadsComplete || !e.reviewComplete) reasons.push('Incomplete evidence');
  if (!e.required.length) reasons.push('Required checks not configured');
  const resolved=latestWorkflowChecks(e.checks.map(c=>({...c,head_sha:c.sha,app:{slug:c.app}})));
  for (const name of e.required) {
    const checks = resolved.filter(c => c.name === name && c.sha === e.head && c.app.slug === 'github-actions');
    if (checks.length !== 1 || checks[0].status !== 'completed' || checks[0].conclusion !== 'success') reasons.push(`Required check not clear: ${name}`);
  }
  const bot = resolved.filter(c => c.app.slug === 'coderabbitai' && c.name === 'CodeRabbit' && c.sha === e.head);
  if (bot.length !== 1 || bot[0].status !== 'completed' || bot[0].conclusion !== 'success') reasons.push('CodeRabbit check not clear');
  if (e.coderabbitApprovalRequired !== false && (!e.review || e.review.sha !== e.head || e.review.author !== 'coderabbitai[bot]' || e.review.state !== 'APPROVED')) reasons.push('Explicit latest-SHA CodeRabbit approval missing');
  if (e.unresolved !== 0) reasons.push('Unresolved or unknown findings');
  return { clear: reasons.length === 0, reasons };
}

export function remediationDecision(attempts: number, actionable: boolean, clear: boolean, limit: number | null = 5) {
  if (!Number.isInteger(attempts) || attempts < 0) throw Error('Invalid attempt count');
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw Error('Invalid remediation limit');
  if (clear && actionable) return 'blocked';
  if (clear) return 'ready_for_human';
  if (actionable) return limit !== null && attempts >= limit ? 'blocked' : 'remediation_pending_authorization';
  return 'waiting_for_review';
}

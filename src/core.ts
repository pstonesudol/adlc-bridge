import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export type State = 'awaiting_plan' | 'awaiting_approval' | 'approved' | 'blocked' | 'done';
export class Store {
  db: Database;
  static readonly(path:string){
    const store=Object.create(Store.prototype) as Store;
    store.db=new Database(path,{readonly:true,create:false});return store;
  }
  constructor(path: string) {
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.db = new Database(path, { create: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
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
  event(id: string, kind: string, detail: string) {
    this.db.query('INSERT INTO events(job,kind,detail) VALUES (?,?,?)').run(id, kind, detail);
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
        this.db.query(`UPDATE jobs SET spec=?,state='awaiting_plan',plan=NULL,plan_hash=NULL,
          approved_hash=NULL,actor=NULL,reason=NULL,updated=CURRENT_TIMESTAMP WHERE id=?`).run(spec, id);
        this.event(id, 'spec_changed_approval_revoked', digest(spec));
      }
      return id;
    })();
  }
  get(id: string): any {
    const row = this.db.query('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw Error('Unknown job');
    return row;
  }
  list() { return this.db.query('SELECT id,project,issue,state,plan_hash,attempts,reason,updated FROM jobs ORDER BY updated,id').all(); }
  propose(id: string, plan: string) {
    if (!plan.trim()) throw Error('Empty plan');
    return this.db.transaction(() => {
      const job = this.get(id);
      const hash = digest(JSON.stringify([job.spec, plan]));
      this.db.query(`UPDATE jobs SET plan=?,plan_hash=?,approved_hash=NULL,actor=NULL,
        state='awaiting_approval',reason=NULL,updated=CURRENT_TIMESTAMP WHERE id=?`).run(plan, hash, id);
      this.event(id, 'plan_proposed', hash);
      return hash;
    })();
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

export type Check = { name: string; sha: string; app: string; status: string; conclusion: string | null };
export type ReviewEvidence = {
  head: string; observedHead: string; required: string[]; checks: Check[];
  review: { sha: string; author: string; state: string } | null;
  unresolved: number | null; threadsComplete: boolean; checksComplete: boolean;
  reviewComplete: boolean;
};
// Pure gate, not a live GitHub adapter. Missing/paginated/stale evidence fails closed.
export function reviewGate(e: ReviewEvidence): { clear: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!e.head || e.head !== e.observedHead) reasons.push('Head changed');
  if (!e.checksComplete || !e.threadsComplete || !e.reviewComplete) reasons.push('Incomplete evidence');
  if (!e.required.length) reasons.push('Required checks not configured');
  for (const name of e.required) {
    const checks = e.checks.filter(c => c.name === name && c.sha === e.head && c.app === 'github-actions');
    if (checks.length !== 1 || checks[0].status !== 'completed' || checks[0].conclusion !== 'success') reasons.push(`Required check not clear: ${name}`);
  }
  const bot = e.checks.filter(c => c.app === 'coderabbitai' && c.name === 'CodeRabbit' && c.sha === e.head);
  if (bot.length !== 1 || bot[0].status !== 'completed' || bot[0].conclusion !== 'success') reasons.push('CodeRabbit check not clear');
  if (!e.review || e.review.sha !== e.head || e.review.author !== 'coderabbitai[bot]' || e.review.state !== 'APPROVED') reasons.push('Explicit latest-SHA CodeRabbit approval missing');
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

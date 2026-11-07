/** Standalone trusted App; never imported by the bridge CLI or auto-started. */
import {Database} from 'bun:sqlite';
import {createPrivateKey, sign} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {approvalGate, fingerprint, signed, GATE_NAME, REVIEW_APP} from './approval-gate';

type API = (method: string, path: string, body?: any) => Promise<any>;
export async function pages(api: API, path: string, key?: string) {
  const result: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = key ? response[key] : response;
    if (!Array.isArray(items) || items.some((i: any) => !Number.isSafeInteger(i?.id))) throw Error('Incomplete API page');
    result.push(...items);
    if (items.length < 100) {
      if (new Set(result.map(i => i.id)).size !== result.length) throw Error('Duplicate API evidence');
      return result;
    }
  }
  throw Error('API evidence exceeds pagination bound');
}

export function openGateStore(path: string) {
  if (path !== ':memory:' && !isAbsolute(path)) throw Error('Dedicated absolute App state path required');
  const db = new Database(path, {create: true});
  // Never initialize inside another application's database.
  const application = (db.query('PRAGMA application_id').get() as any).application_id;
  const version = (db.query('PRAGMA user_version').get() as any).user_version;
  if (!(application === 0x41475052 && version === 1) &&
      !(application === 0 && version === 0 && !db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get())) {
    db.close(); throw Error('Not a supported dedicated approval-gate database');
  }
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS prs(number INTEGER PRIMARY KEY, sha TEXT, fingerprint TEXT, barrier INTEGER NOT NULL, check_id INTEGER);
    CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL, barrier INTEGER NOT NULL);
    INSERT OR IGNORE INTO control VALUES(1,0,0);
    PRAGMA application_id=1095192658; PRAGMA user_version=1;`);
  return db;
}
export function receive(db: Database, delivery: string, invalidate: boolean, now = Date.now()) {
  return db.transaction(() => {
    const inserted = db.query('INSERT OR IGNORE INTO deliveries VALUES(?)').run(delivery).changes;
    if (!inserted) return false;
    db.query('UPDATE control SET epoch=epoch+1, barrier=CASE WHEN ? THEN MAX(barrier,?) ELSE barrier END').run(invalidate ? 1 : 0, now);
    return true;
  })();
}

export class ApprovalApp {
  constructor(readonly db: Database, readonly api: API, readonly repo: string, readonly appId: number) {}
  async publish(row: any, conclusion: 'failure' | 'success', summary: string) {
    const base = `repos/${this.repo}/check-runs`;
    if (!row.check_id) {
      const created = await this.api('POST', base, {name: GATE_NAME, head_sha: row.sha, status: 'in_progress', external_id: `approval:${row.number}`});
      if (!Number.isSafeInteger(created.id) || created.app?.id !== this.appId) throw Error('Unexpected publisher identity');
      row.check_id = created.id;
      this.db.query('UPDATE prs SET check_id=? WHERE number=? AND sha=?').run(row.check_id, row.number, row.sha);
    }
    await this.api('PATCH', `${base}/${row.check_id}`, {status: 'completed', conclusion,
      output: {title: conclusion === 'success' ? 'Explicit CodeRabbit approval verified' : 'Approval blocked', summary}});
  }
  async reconcile() {
    // Revoke previous successes before evidence reads. Provider outages can still
    // prevent this write: this is asynchronous enforcement, not a check lease.
    for (const row of this.db.query('SELECT * FROM prs').all() as any[]) await this.publish(row, 'failure', 'Revalidating current review evidence');
    const epoch = (this.db.query('SELECT epoch FROM control').get() as any).epoch;
    const prs = await pages(this.api, `repos/${this.repo}/pulls?state=open`);
    for (const pr of prs) {
      const prior: any = this.db.query('SELECT * FROM prs WHERE number=?').get(pr.number);
      const base = await this.api('GET', `repos/${this.repo}/git/ref/heads/${encodeURIComponent(pr.base.ref)}`);
      if (!/^[a-f0-9]{40}$/.test(base.object?.sha) || !/^[a-f0-9]{40}$/.test(pr.head?.sha)) throw Error('Invalid PR/base SHA');
      const hash = fingerprint(pr, base.object.sha);
      const barrier = Math.max(prior?.fingerprint === hash ? prior.barrier : Date.now(), (this.db.query('SELECT barrier FROM control').get() as any).barrier);
      const row = {number: pr.number, sha: pr.head.sha, fingerprint: hash, barrier, check_id: prior?.sha === pr.head.sha ? prior.check_id : null};
      this.db.query('INSERT OR REPLACE INTO prs VALUES(?,?,?,?,?)').run(row.number, row.sha, hash, barrier, row.check_id);
      await this.publish(row, 'failure', 'Fresh current-head approval and custom-check evidence required');
      const root = `repos/${this.repo}`;
      const [reviews, checks, comments] = await Promise.all([
        pages(this.api, `${root}/pulls/${pr.number}/reviews`),
        pages(this.api, `${root}/commits/${pr.head.sha}/check-runs?filter=latest`, 'check_runs'),
        pages(this.api, `${root}/issues/${pr.number}/comments`)]);
      const reasons = approvalGate({repo: this.repo, number: pr.number, pr, reviews, checks, comments, after: barrier});
      if (prs.filter(p => p.head.sha === pr.head.sha).length !== 1) reasons.push('Multiple open PRs share this head');
      const compare = await this.api('GET', `${root}/compare/${base.object.sha}...${pr.head.sha}`);
      if (compare.behind_by !== 0) reasons.push('PR is behind base or comparison is incomplete');
      const final = await this.api('GET', `${root}/pulls/${pr.number}`);
      const finalBase = await this.api('GET', `${root}/git/ref/heads/${encodeURIComponent(pr.base.ref)}`);
      if (fingerprint(final, finalBase.object?.sha) !== hash || final.mergeable !== true || (this.db.query('SELECT epoch FROM control').get() as any).epoch !== epoch) reasons.push('Evidence changed or mergeability is unknown');
      await this.publish(row, reasons.length ? 'failure' : 'success', reasons.length ? reasons.join('\n') : `Authenticated CodeRabbit approval and custom checks verified for ${row.sha}. Human merge only. Metadata invalidation is asynchronous.`);
      // A delivery can arrive while the final API write is in flight.
      if ((this.db.query('SELECT epoch FROM control').get() as any).epoch !== epoch) await this.publish(row, 'failure', 'New event invalidated collected evidence');
    }
  }
}

if (import.meta.main) {
  const required = (key: string) => {const value = process.env[key]; if (!value) throw Error(`Missing ${key}`); return value;};
  const repo = required('APPROVAL_REPOSITORY');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('Invalid repository');
  const appId = Number(required('APPROVAL_APP_ID')), installation = Number(required('APPROVAL_INSTALLATION_ID'));
  if (![appId, installation].every(n => Number.isSafeInteger(n) && n > 0)) throw Error('Invalid App/installation ID');
  const secret = required('APPROVAL_WEBHOOK_SECRET'), key = createPrivateKey(required('APPROVAL_PRIVATE_KEY'));
  const db = openGateStore(required('APPROVAL_STATE_PATH'));
  let token = '', expires = 0;
  const api: API = async (method, path, body) => {
    if (Date.now() >= expires) {
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${Buffer.from(JSON.stringify({alg: 'RS256', typ: 'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify({iat: now - 60, exp: now + 540, iss: appId})).toString('base64url')}`;
      const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
      const response = await fetch(`https://api.github.com/app/installations/${installation}/access_tokens`, {method: 'POST', headers: {Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json'}, body: JSON.stringify({repositories: [repo.split('/')[1]], permissions: {checks: 'write', pull_requests: 'read', issues: 'read', contents: 'read'}})});
      if (!response.ok) throw Error('Installation authentication failed');
      const data: any = await response.json();
      if (typeof data.token !== 'string' || !Number.isFinite(Date.parse(data.expires_at))) throw Error('Incomplete authentication');
      token = data.token; expires = Date.parse(data.expires_at) - 60000;
    }
    const response = await fetch(`https://api.github.com/${path}`, {method, headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    if (!response.ok) throw Error(`GitHub ${method} failed (${response.status})`);
    return response.json();
  };
  const app = new ApprovalApp(db, api, repo, appId);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {await app.reconcile();} catch {console.error('Approval reconciliation failed; inspect App availability. No bypass.');} finally {running = false;}
  };
  Bun.serve({hostname: '127.0.0.1', port: Number(process.env.APPROVAL_PORT ?? 8789), maxRequestBodySize: 2 * 1024 * 1024,
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/webhook') return new Response('Not found', {status: 404});
      const body = await request.text();
      if (!signed(body, request.headers.get('x-hub-signature-256'), secret)) return new Response('Unauthorized', {status: 401});
      try {
        const data = JSON.parse(body), event = request.headers.get('x-github-event'), delivery = request.headers.get('x-github-delivery');
        if (!delivery || data.repository?.full_name !== repo || data.installation?.id !== installation) return new Response('Wrong scope', {status: 400});
        // Never consume our own publications: that would form a check-event loop.
        if (event === 'check_run' && data.check_run?.app?.id !== REVIEW_APP.id ||
            event === 'check_suite' && data.check_suite?.app?.id !== REVIEW_APP.id ||
            !['push', 'pull_request', 'issues', 'issue_comment', 'pull_request_review', 'pull_request_review_comment', 'check_run', 'check_suite'].includes(event ?? ''))
          return new Response('Ignored', {status: 202});
        // Global conservative invalidation prevents metadata edit-away/edit-back
        // from inheriting clearance, even when the final fingerprint is unchanged.
        const invalidate = event === 'push' || event === 'pull_request' || event === 'issues' || event === 'pull_request_review' && data.action === 'dismissed';
        receive(db, delivery, invalidate);
        void tick();
        return new Response('Accepted', {status: 202});
      } catch {return new Response('Invalid delivery', {status: 400});}
    }});
  // Bootstrap deliberately requires a new review run after first observation.
  void tick(); setInterval(() => void tick(), 30000);
}

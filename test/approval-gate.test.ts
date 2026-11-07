import {expect, test} from 'bun:test';
import {createHmac} from 'node:crypto';
import {approvalGate, fingerprint, GATE_NAME, REVIEWER, REVIEW_APP, signed} from '../src/approval-gate';
import {ApprovalApp, openGateStore, pages, receive} from '../src/approval-gate-app';
import ruleset from '../.github/main-ruleset.template.json';

const head = 'a'.repeat(40), base = 'b'.repeat(40), repo = 'owner/repo';
const at = (seconds: number) => new Date(seconds * 1000).toISOString();
function fixture(): any {
  return {repo, number: 1, after: 1000,
    pr: {id: 1, number: 1, head: {sha: head}, base: {ref: 'main'}, title: 'Gate', body: 'Evidence', labels: [], draft: false, state: 'open', mergeable: true},
    reviews: [{id: 10, user: {...REVIEWER}, state: 'APPROVED', commit_id: head, submitted_at: at(5)}],
    checks: [{id: 20, name: 'CodeRabbit', app: {...REVIEW_APP}, head_sha: head, status: 'completed', conclusion: 'success', started_at: at(2), completed_at: at(4)}],
    comments: [{id: 30, user: {...REVIEWER}, issue_url: `https://api.github.com/repos/${repo}/issues/1`, updated_at: at(3), body: `<!-- pre_merge_checks_walkthrough_start -->
| Check name | Status | Explanation |
| --- | --- | --- |
| Verification evidence | ![Passed](https://example.test/pass) | Clear |
<!-- pre_merge_checks_walkthrough_end -->
**Commit**: [${head}](<https://github.com/${repo}/commit/${head}>)`}]};
}
test('fresh explicit authenticated current-head approval and custom clearance allow the gate only', () => {
  expect(approvalGate(fixture())).toEqual([]);
});
test('ruleset template is disabled until operator activation and pins every check source', () => {
  expect(ruleset.enforcement).toBe('disabled');
  expect(ruleset.bypass_actors).toEqual([]);
  expect(ruleset.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
  expect(ruleset.rules.map(r => r.type)).toContain('deletion');
  expect(ruleset.rules.map(r => r.type)).toContain('non_fast_forward');
  const checks = ruleset.rules.find(r => r.type === 'required_status_checks')!.parameters!;
  expect(checks.strict_required_status_checks_policy).toBe(true);
  expect(checks.required_status_checks).toEqual([
    {context: 'Bridge tests', integration_id: 15368},
    {context: 'bun-test', integration_id: 15368},
    {context: GATE_NAME, integration_id: 0}]);
});
test('App state rejects relative paths rather than creating worktree state', () => {
  expect(() => openGateStore('approval.db')).toThrow('absolute');
});
test('green CI does not replace explicit current-head approval', () => {
  for (const state of ['CHANGES_REQUESTED', 'COMMENTED', 'PENDING', 'DISMISSED']) {
    const e = fixture(); e.reviews[0].state = state;
    expect(approvalGate(e).length).toBeGreaterThan(0);
  }
  const e = fixture(); e.reviews = []; expect(approvalGate(e).length).toBeGreaterThan(0);
  const stale = fixture(); stale.reviews[0].commit_id = base; expect(approvalGate(stale).length).toBeGreaterThan(0);
});
test('lookalikes and wrong App identities fail closed', () => {
  for (const user of [{...REVIEWER, id: 2}, {...REVIEWER, type: 'User'}, {...REVIEWER, login: 'coderabbitai'}]) {
    const e = fixture(); e.reviews[0].user = user; expect(approvalGate(e).length).toBeGreaterThan(0);
  }
  const e = fixture(); e.checks[0].app.id++; expect(approvalGate(e).length).toBeGreaterThan(0);
});
test('pending, skipped, failed, missing, duplicate or stale review runs block', () => {
  for (const change of [{status: 'in_progress'}, {conclusion: 'skipped'}, {conclusion: 'failure'}, {started_at: at(0)}, {completed_at: null}]) {
    const e = fixture(); Object.assign(e.checks[0], change); expect(approvalGate(e).length).toBeGreaterThan(0);
  }
  for (const checks of [[], [...fixture().checks, ...fixture().checks]]) expect(approvalGate({...fixture(), checks}).length).toBeGreaterThan(0);
});
test('custom failure, warning, missing, ambiguous or stale summary blocks despite approval', () => {
  for (const status of ['Error', 'Warning', 'Unknown']) {
    const e = fixture(); e.comments[0].body = e.comments[0].body.replace('[Passed]', `[${status}]`); expect(approvalGate(e).length).toBeGreaterThan(0);
  }
  for (const comments of [[], [...fixture().comments, ...fixture().comments]]) expect(approvalGate({...fixture(), comments}).length).toBeGreaterThan(0);
  const e = fixture(); e.comments[0].updated_at = at(10); expect(approvalGate(e).length).toBeGreaterThan(0);
  const old = fixture(); old.comments[0].body = old.comments[0].body.replaceAll(head, base); expect(approvalGate(old).length).toBeGreaterThan(0);
});
test('human change requests and later bot dismissals cannot inherit earlier approval', () => {
  const e = fixture(); e.reviews.push({id: 11, user: {id: 88}, state: 'CHANGES_REQUESTED'});
  expect(approvalGate(e)).toContain('An outstanding changes-requested review remains');
  e.reviews.push({id: 12, user: {id: 88}, state: 'DISMISSED'}); expect(approvalGate(e)).toEqual([]);
  e.reviews.push({...e.reviews[0], id: 13, state: 'DISMISSED'}); expect(approvalGate(e).length).toBeGreaterThan(0);
});
test('metadata fingerprint and invalidation barrier require fresh review execution', () => {
  const e = fixture(), hash = fingerprint(e.pr, base);
  for (const pr of [{...e.pr, body: 'Changed'}, {...e.pr, title: 'Changed'}, {...e.pr, labels: [{name: 'new'}]}, {...e.pr, draft: true}]) expect(fingerprint(pr, base)).not.toBe(hash);
  expect(fingerprint(e.pr, head)).not.toBe(hash);
  expect(approvalGate({...e, after: 3000}).length).toBeGreaterThan(0);
});
test('webhook signatures cover raw bytes and use the configured secret', () => {
  const body = '{"safe":true}', signature = 'sha256=' + createHmac('sha256', 'secret').update(body).digest('hex');
  expect(signed(body, signature, 'secret')).toBe(true);
  expect(signed(body + ' ', signature, 'secret')).toBe(false);
  expect(signed(body, signature, 'other')).toBe(false);
  expect(signed(body, null, 'secret')).toBe(false);
});
test('durable delivery deduplication never rolls back metadata barriers', () => {
  const db = openGateStore(':memory:');
  try {
    expect(receive(db, 'edit', true, 5000)).toBe(true);
    expect(receive(db, 'edit', true, 9000)).toBe(false);
    receive(db, 'review', false, 10000); receive(db, 'late-edit', true, 2000);
    expect(db.query('SELECT epoch,barrier FROM control').get()).toEqual({epoch: 3, barrier: 5000});
  } finally {db.close();}
});
test('pagination rejects missing or duplicate evidence instead of returning partial success', async () => {
  await expect(pages(async () => ({}), 'path')).rejects.toThrow();
  await expect(pages(async () => [{id: 1}, {id: 1}], 'path')).rejects.toThrow();
  let calls = 0;
  const result = await pages(async () => ++calls === 1 ? Array.from({length: 100}, (_, id) => ({id})) : [{id: 101}], 'path');
  expect(result.length).toBe(101); expect(calls).toBe(2);
});
test('publisher blocks first, then publishes success only for complete stable evidence', async () => {
  const e = fixture(), db = openGateStore(':memory:'), writes: any[] = [];
  db.query('INSERT INTO prs VALUES(?,?,?,?,?)').run(1, head, fingerprint(e.pr, base), 1000, null);
  const api = async (method: string, path: string, body?: any) => {
    if (method !== 'GET') {writes.push({method, body}); return {id: 99, app: {id: 123}};}
    if (path.includes('/git/ref/')) return {object: {sha: base}};
    if (path.includes('/reviews')) return e.reviews;
    if (path.includes('/check-runs')) return {check_runs: e.checks};
    if (path.includes('/comments')) return e.comments;
    if (path.includes('/compare/')) return {behind_by: 0};
    return path.includes('/pulls?') ? [e.pr] : e.pr;
  };
  try {
    const app = new ApprovalApp(db, api, repo, 123); await app.reconcile();
    expect(writes[0].body.name).toBe(GATE_NAME);
    expect(writes.filter(w => w.body.conclusion).map(w => w.body.conclusion)).toEqual(['failure', 'failure', 'success']);
    writes.length = 0; e.reviews = []; await app.reconcile();
    expect(writes.at(-1).body.conclusion).toBe('failure');
    expect(writes.some(w => w.body.conclusion === 'success')).toBe(false);
  } finally {db.close();}
});
test('metadata edits, API errors and events during collection cannot publish success', async () => {
  for (const mode of ['edit', 'outage', 'delivery']) {
    const e = fixture(), db = openGateStore(':memory:'), conclusions: string[] = [];
    db.query('INSERT INTO prs VALUES(?,?,?,?,?)').run(1, head, fingerprint(e.pr, base), 1000, 99);
    const api = async (method: string, path: string, body?: any) => {
      if (method !== 'GET') {conclusions.push(body.conclusion); return {};}
      if (path.includes('/git/ref/')) return {object: {sha: base}};
      if (path.includes('/reviews')) {if (mode === 'outage') throw Error('offline'); return e.reviews;}
      if (path.includes('/check-runs')) return {check_runs: e.checks};
      if (path.includes('/comments')) return e.comments;
      if (path.includes('/compare/')) return {behind_by: 0};
      if (path.includes('/pulls?')) return [e.pr];
      if (mode === 'delivery') receive(db, 'during-read', true, 6000);
      return mode === 'edit' ? {...e.pr, body: 'Changed'} : e.pr;
    };
    try {
      try {await new ApprovalApp(db, api, repo, 123).reconcile();} catch {expect(mode).toBe('outage');}
      expect(conclusions.length).toBeGreaterThan(0); expect(conclusions).not.toContain('success');
    } finally {db.close();}
  }
});

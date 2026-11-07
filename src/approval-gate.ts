import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {customCheckSection} from './coderabbit-checks';

export const GATE_NAME = 'CodeRabbit explicit approval';
// Verified from GitHub PR #2 and its CodeRabbit check, not from PR prose.
export const REVIEWER = {id: 136622811, login: 'coderabbitai[bot]', type: 'Bot'};
export const REVIEW_APP = {id: 347564, slug: 'coderabbitai'};
export const isReviewer = (user: any) => user?.id === REVIEWER.id && user?.login === REVIEWER.login && user?.type === REVIEWER.type;
const time = (s: any) => typeof s === 'string' ? Date.parse(s) : NaN;
export function fingerprint(pr: any, base: string) {
  return createHash('sha256').update(JSON.stringify([pr.head.sha, pr.base.ref, base,
    pr.title, pr.body ?? '', pr.draft, pr.state, (pr.labels ?? []).map((l: any) => l.name).sort()])).digest('hex');
}
export function signed(body: string, signature: string | null, secret: string) {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), createHmac('sha256', secret).update(body).digest());
}
export type GateEvidence = {repo: string; number: number; pr: any; checks: any[]; reviews: any[]; comments: any[]; after: number};
/** Inputs must be complete authenticated API responses. No prose is executed. */
export function approvalGate(e: GateEvidence): string[] {
  const reasons: string[] = [], head = e.pr.head.sha;
  if (e.pr.state !== 'open' || e.pr.draft) reasons.push('PR is not open and ready');
  // A COMMENTED or PENDING review cannot supply approval. Dismissals revoke it.
  const bot = e.reviews.filter(r => isReviewer(r.user)).sort((a, b) => a.id - b.id);
  const review = bot.at(-1);
  if (!review || review.state !== 'APPROVED' || review.commit_id !== head || !Number.isFinite(time(review.submitted_at)) || time(review.submitted_at) <= e.after)
    reasons.push('Fresh explicit authenticated CodeRabbit approval of this head is missing');
  const effective = new Map<number, any>();
  for (const r of [...e.reviews].sort((a, b) => a.id - b.id)) {
    if (!Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.user?.id)) reasons.push('Malformed review evidence');
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) effective.set(r.user.id, r);
  }
  if ([...effective.values()].some(r => r.state === 'CHANGES_REQUESTED')) reasons.push('An outstanding changes-requested review remains');
  const runs = e.checks.filter(c => c.name === 'CodeRabbit' && c.head_sha === head && c.app?.id === REVIEW_APP.id && c.app?.slug === REVIEW_APP.slug);
  // Refuse ambiguous reruns rather than selecting an arbitrary success.
  const run = runs.length === 1 ? runs[0] : null;
  if (!run || run.status !== 'completed' || run.conclusion !== 'success' || !Number.isFinite(time(run.started_at)) || !Number.isFinite(time(run.completed_at)) || time(run.started_at) <= e.after || time(run.completed_at) < time(run.started_at) || time(review?.submitted_at) < time(run.started_at))
    reasons.push('A single fresh successful authenticated CodeRabbit run is missing');
  const summaries = e.comments.filter(c => isReviewer(c.user) && typeof c.body === 'string' && c.body.includes('<!-- pre_merge_checks_walkthrough_start -->'));
  const summary = summaries.length === 1 ? summaries[0] : null;
  const section = summary && customCheckSection(summary.body);
  // Support only the known table format. Warnings, errors and unknown formats
  // block; the table is data, never an instruction or a substitute for approval.
  // Examine all table-looking rows, including full-details prose. Rejecting an
  // unfamiliar/example table is safer than hiding a failing row after details.
  const table = section;
  const rows = table?.split('\n').filter((l: string) => l.includes('|')) ?? [];
  let count = 0, invalid = false, verification = false;
  for (const row of rows) {
    const cells = row.trim().split('|').map((s: string) => s.trim());
    if (cells[0] !== '' || cells.at(-1) !== '' || cells.length !== 5) {invalid = true; continue;}
    if (cells[1] === 'Check name' && cells[2] === 'Status' || cells.slice(1, -1).every((s: string) => /^:?-+:?$/.test(s))) continue;
    count++;
    if (!/^!\[Passed\]\([^\s)]+\)$/i.test(cells[2])) invalid = true;
    if (/^Verification evidence$/i.test(cells[1])) verification = true;
  }
  const commits = summary ? [...summary.body.matchAll(/\*\*Commit\*\*:\s*\[[^\]]+\]\(<https:\/\/github\.com\/([^/]+\/[^/]+)\/commit\/([a-f0-9]{40})>\)/g)] : [];
  if (!section || !count || invalid || !verification || !summary || !run ||
      summary.issue_url !== `https://api.github.com/repos/${e.repo}/issues/${e.number}` ||
      commits.length !== 1 || commits[0][1] !== e.repo || commits[0][2] !== head ||
      !Number.isFinite(time(summary.updated_at)) || time(summary.updated_at) < time(run.started_at) || time(summary.updated_at) > time(run.completed_at))
    reasons.push('Complete current-run custom pre-merge clearance is missing or failing');
  return [...new Set(reasons)];
}

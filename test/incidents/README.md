# DEV-78 incident acceptance harness

Run from the repository root:

```sh
bun test test/incidents
```

The numbered matrix and dependency owners are in `incidents.test.ts`. The suite
also runs under `bun test`.

## Boundary and evidence

Each replay starts with a ticket, approved plan, scoped Git grant, adopted worker
and exactly one PR in an in-memory `Store`. This is a post-dispatch incident
acceptance gate, not a test of Linear ingestion or live provider correctness.
It drives the real `ReviewLoop`, `RecoveryObservation`, and (for in-scope review
repair) `sendPilotRemediation`; it does not implement a second recovery engine.
Provider results and completed worker output are deterministic fixture events.
The missing-attestation case waits until the fake provider supplies a body-bound
attestation; it does not claim the bridge can invent or repair an attestation.

The clock is frozen and advanced explicitly. Backoff uses a seeded PRNG, restored
after the replay. There are no sleeps. Provider, identity, feedback and spawn
edges are injected. Real Bun process execution and fetch fail immediately.
No credentials, disk database, CLI operation or network service is needed.

Only worker sends and marked review requests are allowed fake mutations. Their
keys must be unique. Every successful replay checks the unchanged ticket scope,
PR identity and Git grant (commit, feature push, open PR only). There is no merge,
auto-merge, protection-change, PR-creation or scope-expansion capability. The
suite does not equate `ready_for_human` with merge permission.

Operator count means explicit commands/decisions **after** the preauthorized
fixture setup, not polling, provider observations or notifications. Recoverable
cases execute no operator action. The human-only case first proves repeated
polling remains blocked with zero commands, records one simulated explicit human
decision, and proves that this alone cannot manufacture approval. In-scope
findings remain non-ready until worker completion and fresh approval evidence;
they are not themselves a reason to request human scope expansion.

## Current coverage and limits

The executable matrix now includes DEV-77 logical CI deduplication, DEV-65 review
scheduling, DEV-70 attestation waits, DEV-80 CI remediation, DEV-56 provider
recovery, DEV-83 safe escalation and DEV-84 lost worker receipts. Terminated or
stuck workers **escalate**; they are not claimed as automatic recovery successes.
DEV-88 additionally reconstructs ReviewLoop on the same Store, verifies throttling
cooldowns across reconstruction and checks durable metrics. This is component
reconstruction, not a full process crash or disk restart test. Lost review and
worker receipts reconcile without duplicate mutations; initial ticket-to-PR
handoff adoption is not covered by this post-dispatch fixture.

`test/linear-clarifications.test.ts` exercises real clarification publication,
human reply/confirmation and guarded continuation in an existing session; DEV-88
asserts expected-human-action provenance and zero rescue observations there.
These replies are expected human input, not a literal absence of humans. There
is no single live ticket-to-reviewed-PR replay, live baseline, provider correctness
claim, automatic terminated-worker restart, or full handoff-adoption incident
coverage. Keep these limits explicit rather than weakening safety assertions.

## DEV-88 autonomy evidence report

```sh
adlc jobs metrics --project PROJECT --since 2026-01-01T00:00:00Z --until 2026-02-01T00:00:00Z --json
```

Human output omits `--json`; grouped JSON retains the operator envelope
`{schemaVersion:1, command:"jobs", data:...}`. Project selection uses existing
operator project resolution. Without dates, the window is the last 30 days;
timestamps must be UTC ISO, `since < until <= now`, at most 366 days. The cohort
is jobs ingested in **[since, until)**, observed through (excluding) `until`.
Reports fail with exit 1 rather than truncate beyond 1,000 jobs or 50,000 events;
narrow the filters. Invalid options/dates use exit 2. Missing state is empty,
unknown evidence, never an instruction to initialize a database.

### Definitions

- **Handoff without recorded rescue proportion:** number of eligible jobs with
  an explicit `review_state_changed: ready_for_human` event containing a head,
  and zero recorded rescue interventions through that first handoff, divided by
  all eligible cohort jobs. Eligible means every observed event has valid
  provenance and a recognized measurement classification. In-flight jobs remain
  in the denominator and are separately censored, so recent cohorts are not
  directly comparable to mature ones. Empty eligible cohorts report `null`.
  Later interventions do not erase an earlier no-rescue handoff milestone.
- **Interventions per job:** recorded rescue actions divided by all cohort jobs;
  totals remain lower bounds when history is incomplete. Read retries, cooldown
  overrides, review recovery, manual reconciliation/adoption, budget extensions
  and human takeover are rescue. Human plan approval and material clarification
  resolution are expected actions and counted separately. Dependency observation
  and standing-policy authorization are not human actions. Human merge is outside
  the handoff endpoint and never implies autonomous completion; Linear status
  synchronization alone is not proof of a human merge.
- **Blocked duration by cause:** observed review-state intervals, grouped as
  external review/CI waits, delivery uncertainty, unclassified blockers or
  orchestration work; provider-read episodes additionally report external-provider
  duration. These overlapping dimensions must not be summed as wall time.
  Unclassified blockers are **not** silently labelled orchestration defects.
  Planning/approval/dependency wait history without explicit transitions is not
  reconstructed. Absence of a measured interval does not mean zero actual wait.
- **Automatic recovery:** currently scoped to provider observations, not all job
  recovery. An episode begins at the first persisted read failure and ends at a
  successful observed read, operator interruption, or invalidation. Permanent or
  unknown provider classifications record failure/escalation, not success.
  Open transient episodes are censored at `until`. Mean time-to-recovery uses
  successful episodes only; episode durations and provenance remain available.
  Invalidating evidence or manually clearing a wait is not automatic success.
- **Retries:** failed provider observations grouped by allowlisted reason;
  successful polls are not retries. Backoff polls do not emit duplicate failures.
  Worker remediation retries deduplicate by job/plan/logical attempt, not by
  repeated polling or delivery messages. Durable event sequence identifies each
  provider observation; repeated reporting does not create observations.
- **Censoring/history:** jobs without an evidenced handoff are censored, including
  closed jobs lacking handoff evidence. Unknown event kinds, missing provenance
  or detail-hash mismatch make coverage incomplete. Legacy events are preserved,
  never backfilled with invented version, attempt, success or zero-rescue history.

### Provenance, baseline and privacy

The existing event ledger remains authoritative. New events atomically append
`event_provenance` with event sequence, millisecond timestamp, emitting package
version, current remediation attempt counter, current plan hash and detail hash.
Attempt zero means no remediation attempt yet; it is not a new worker/session
identifier. Plan hash plus job and attempt retain the available binding. Runtime
version means the emitting source package version, **not** a verified Git SHA or
live backend identity; commits sharing a version cannot be distinguished. Jobs
spanning versions are reported as `mixed`, not attributed to a single release.

The report itself is the reproducible bounded baseline; no live baseline was
collected during implementation. Save JSON through an operator-controlled export
if needed. Version cohorts include sample sizes, incomplete and censored counts;
comparisons are descriptive, never causal evidence, especially with tiny samples
or different projects/workload ages. Raw feature/test counts are not autonomy.

Reporting opens SQLite read-only in one snapshot, never invokes a controller,
refreshes providers, sends work, changes labels/config, resets budgets or grants
authority. It returns allowlisted categories and opaque provenance identifiers,
not event details, prompts, answers, actors, free-form reasons or diagnostics.
Each job gives persisted evidence age, a coarse blocker and an exact read-only
`jobs status` next command using existing CLI conventions. Job state is a present-day
snapshot; interval/recovery evidence is historical through the requested bound.
Out-of-band operator actions are unobservable: **zero recorded rescue is not proof
of universal autonomy**, even for fully instrumented event history.

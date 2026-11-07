# DEV-78 incident acceptance harness

Run from the repository root:

```sh
bun test test/incidents
```

The numbered matrix and dependency owners are in `incidents.test.ts`. The suite
also runs under `bun test`. No production files or other sessions' tests change.

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

## Pending acceptance gates

- DEV-77: duplicate/cancelled logical CI attempts. Skipped executable expectation
  currently fails against the raw-check resolver.
- DEV-65: skipped current-head review plus stale changes requested. Explicit todo
  requires an injected collector replay once its fix/interface lands; merely
  setting `clear=true` would not test stale-review classification.
- Later CI-remediation ticket, **not assigned in Linear at implementation time**:
  skipped executable worker-repair expectation.
- Later worker-liveness ticket, **not assigned**: separate skipped terminated and
  stuck-worker acceptance expectations. Existing fixtures must not pretend an
  operator restart is automatic recovery.
- Later worker-receipt ticket, **not assigned**: explicit todo for uncertain
  worker-send completion. The active lost-review-request test covers only the
  already-supported marked-comment reconciliation, not all worker receipts.

DEV-78 tracks these unassigned follow-ups; no ticket identifiers are invented.
Replace the owner text with the assigned ticket when available. Enable each
skipped body after its fix lands; for todos, add the collector/receipt replay
before removing the todo. Do not delete the zero-command or mutation assertions
to make a pending gate pass. Skips/todos are visible CI debt, not claimed recovery
coverage. Production behavior is intentionally unchanged.

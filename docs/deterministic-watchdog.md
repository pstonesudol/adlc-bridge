# Deterministic action/watchdog foundation (DEV-79)

This is a bounded deterministic observation foundation, not unattended
ticket-to-approval completion. The only enabled action is `observe:
review-evidence`. It reads the existing owner's session/transcript and the
registered PR's branch snapshot. There is no model call, command/prompt
executor, worker creation, sender, or automatic replacement/recovery worker.

## Production integration

`createCLIPollTick` schedules registered review targets and selects at most four
due actions, oldest first, within the existing sequential
`runPollTick` / `withTurnSubmission` scope. Poll and serve use that same path;
`serveLoop` remains cadence-only. The selected `ReviewLoop.tick` replaces its
initial session/branch reads with `ActionWatchdog.observeReview`. It does not
perform an extra copy of those reads. Existing later verification reads remain
necessary for mutation-specific preconditions.

**The whole review tick is effectful and is not a retryable observation.** The
watchdog reserves only its closed read adapter. Later branch updates, review
requests and remediation remain in their existing executors with their existing
authorization, delivery reservations, fences and receipt reconciliation.
An unsettled exception from the surrounding tick escalates rather than being
classified as a transient read error. No readiness, GitHub approval, Changes
Requested, skipped/neutral review or human-only merge rule is changed.

Workflow planning, clarification and dependency handling retain their existing
paths. This first action implementation schedules registered review evidence;
it does not schedule all workflow phases. Explicit operator `tick-review` uses
the existing supervised path, independent of automatic observation budgets.

## Closed contract and bindings

`ActionContract` is `observe | defer | invoke_supported_recovery | escalate`.
The supported recovery operation type is currently `never`: there are **zero
new automatic recovery operations**. CI/reviewer/worker/provider waits and
uncertain receipts can receive bounded observations. Human, dependency and
unsupported blockers stop for their existing operator interfaces. A conflict
worktree reservation is unsupported by this scheduler; it is not cleared or
bypassed. Active/queued workers may be read, but observation supplies no
permission to steer them.

The immutable binding contains job/project, specification hash, requirement
revision instance, plan hash, owner/session, repository/PR, persisted head and
fingerprints of approval/grant, execution ownership, review target and relevant
configuration. Snapshotting and claiming use SQLite immediate transactions.
The evaluator rechecks exact bindings, current approved spec/plan, inspect
grant, standing-policy eligibility, project/global pause and worktree
reservations before reads and after every await. Session/project/PR/branch
identity and complete fresh transcript evidence must match before returning.

A newly observed remote head can differ from the *persisted* head: discovering
it is the purpose of a read. This does not authorize a head-bound mutation.
The existing review evaluator still obtains and validates current-head evidence
and updates its target. A concurrent change to the persisted binding discards
the observation. A later poll creates a new immutable action for that new
binding. A previously superseded binding recurring (A → B → A) escalates instead
of reviving its old claim.

## Persistence, due times and restart

`watchdog_actions` records identity/binding, blocker, next action, due time,
claim token/expiry, attempts, failures, outcome/reason and bounded evidence.
`watchdog_budgets` holds cumulative per-job consumption. Module-owned additive
tables follow the existing `Store` extension pattern; read-only status never
creates them. Actions and budgets are not deleted on restart or head changes.

Defaults are four candidates per poll, a 60-second minimum interval, a
two-minute observation claim, six consecutive transient failures per action,
and 240 lifetime automatic observation reservations per job. There is no
automatic budget reset/extension; different heads/specs/plans do not reset the
job budget. Reservation consumes budget even if the process exits before IO or
shared provider capacity subsequently defers it. No elapsed wait is evidence of
worker failure or successful delivery.

Only read-only claims can be reclaimed on expiry. A stale owner cannot publish
its result after another token claims the action. Existing provider and review
leases also apply: a process crash can therefore defer the next observation
longer than the two-minute action lease (currently ten-minute provider and
one-hour review leases). No lock is deleted or stolen by this module.

`RecoveryObservation.read` provides the existing shared provider capacity,
provider leases and typed bounded exponential/jittered backoff. Unknown,
malformed, authentication and permission errors escalate; arbitrary error text
never enables retry. Due times retain provider retry floors. Exhaustion reports
an explicit operator inspection step. Existing `retry-observation JOB` can
rearm a provider-error escalation after inspection, retaining cumulative budget,
shared cooldown, uncertain mutation receipts and all mutation-specific gates.
Other escalations require their existing supervised inspection/recovery path;
there is no generic watchdog reset command.

## Uncertain effects and scope boundaries

The action ledger never marks a mutation absent, accepted or completed. Existing
`ReceiptReconciliation.inspect` and workflow/review ledgers remain authoritative.
Missing transcripts, elapsed time, a new SHA or expired action/provider lease
cannot erase them. A crash after the observation but during later review work
leaves that work's original mutation reservation in place; subsequent reads do
not constitute permission to resend it. This feature supplies no new receipt
recovery algorithm.

DEV-52 remains an optional future model-supervision layer. It could consume
typed action evidence, but cannot supply grants or bypass these contracts.
DEV-59 owns submission-lock contention/backoff and abandoned-barrier diagnosis;
this feature neither retries whole fenced operations nor changes lock ownership.
CI repair, worker liveness/replacement, new receipt recovery and additional
supported recovery adapters are follow-ups. Each new effectful adapter needs
its own exact permission/precondition contract, durable mutation reservation,
existing transport/fence and authoritative receipt reconciliation before it can
inhabit `invoke_supported_recovery`. A generic callback is not an extension
point.

## Inspection and verification

`adlc jobs status JOB --json` exposes persisted `watchdog` identity, next action,
due time, attempts/budget, failure count, outcome, escalation reason and evidence
age. Human-readable job status includes a concise watchdog line. Absence of the
new tables returns `watchdog: null`. These paths use `Store.readonly`, perform
no provider IO, claims, migrations, cooldown repairs or cleanup, and label
evidence persisted-only. Evidence contains hashes, identifiers and fixed
classification/activity codes; no transcripts, prompts, credentials or raw
provider diagnostics are stored by the watchdog.

Offline tests execute the production evaluator and review integration with
injected provider reads and deterministic time. Coverage includes due/not-due,
cross-connection claims, restart, expired-read late completion, changed bindings
and grants, pause before/during reads, active/queued work, provider capacity,
retry/job budgets, uncertain receipts, and byte-unchanged read-only status.
Run `bun test`. These tests do not demonstrate a live unattended pilot, install
or activate the feature, or authorize service operation. Activation remains an
explicit reviewed operator action; merging remains human-only.

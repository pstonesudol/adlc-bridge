# Deterministic action/watchdog foundation (DEV-79)

This is a bounded deterministic observation foundation, not unattended
ticket-to-approval completion. The only enabled action is `observe:
review-evidence`. It reads the existing owner's session/transcript and the
registered PR's branch snapshot. There is no model call, command/prompt
executor, worker creation, sender, or automatic replacement/recovery worker.

## Production integration

`createCLIPollTick` skips completed review targets, schedules the remaining
registered targets and selects at most four due candidates, oldest first, within the existing sequential
`runPollTick` / `withTurnSubmission` scope. Poll and serve use that same path;
`serveLoop` remains cadence-only. With an action, `ReviewLoop.tick` only calls
`ActionWatchdog.observeReview`, validates/persists the session/branch evidence
and returns `observed` before entering normal review evaluation. It does not
reconcile mutation receipts, update review readiness, update branches, request
reviews, send remediation or run conflict recovery.

For a pending action, only after that successful return does the same sequential poll invoke the
existing `ReviewLoop.tick` **without an action** for that target. This separate
effectful step collects its own fresh evidence, including new session/branch
reads; it does not reuse the observation as mutation authority. A failed or
deferred observation skips the effectful step. Both calls remain inside the
same poll/submission fence, and each uses the existing review-evaluation lease.
There is no second sender, timer or background review loop.

An escalated `human_required` target also receives an ordinary review check at
most once per 15 minutes, without an action. It shares the **same four-candidate
batch**, submission fence and review lease, and revalidates binding, eligibility,
pause and worktree reservations before entry. This lets the existing evaluator
discover a worker push or cleared CI/review blocker instead of requiring a manual
tick just to refresh the persisted head. Other escalated outcomes do not use this
path. It is ordinary review evaluation, not an automatic recovery operation.

**The whole review tick is effectful and is not a retryable observation.** The
watchdog reserves only its closed read adapter. The separate ordinary review
step retains existing authorization, remediation/branch/review-request budgets,
delivery reservations, fences and receipt reconciliation. The observation budget
counts non-idle read-action reservations; it grants no mutation budget or permission.
An unsettled exception from the separate effectful step uses its own durable
per-job failure counter and backoff, not provider-read retry classification.
The next ordinary evaluation obtains fresh evidence and retains every existing
mutation receipt; it does not replay a transport callback. No readiness, GitHub approval, Changes
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
unsupported blockers stop the read action for their existing operator interfaces;
`human_required` retains the bounded ordinary check described above. A conflict
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
`watchdog_budgets` holds cumulative per-job consumption. `watchdog_evaluations`
holds per-job ordinary-review due time and consecutive evaluation failures.
Its cadence is reserved before the ordinary call, and both fields survive new
action bindings and process restarts. Module-owned additive
tables follow the existing `Store` extension pattern; read-only status never
creates them. Actions and budgets are not deleted on restart or head changes.

Defaults are four candidates per poll, a 60-second minimum interval, a
two-minute observation claim, six consecutive transient failures per action,
and 240 lifetime **non-idle** automatic observation reservations per job. A
`ready_for_human` target with blocker `none` uses a 15-minute cadence and does not
charge `watchdog_budgets`; a newly discovered blocker restores charged observation.
There is no
automatic budget reset/extension; different heads/specs/plans do not reset the
job budget. A non-idle reservation consumes budget even if the process exits before IO or
shared provider capacity subsequently defers it. No elapsed wait is evidence of
worker failure or successful delivery.

Ordinary evaluation exceptions defer with `evaluation_uncertain` after 1, 2, 4,
8 and 15 minutes. The sixth consecutive exception stops automatic evaluation as
`evaluation_failed`. A settled ordinary result resets that counter; a successful
read action, a head/configuration change or a provider retry does not. There is
no automatic reset after exhaustion. The limits are defined in `WATCHDOG_LIMITS`.

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
Other escalations (apart from the bounded `human_required` check) require their existing supervised inspection/recovery path;
there is no generic watchdog reset command.

### Operator path for an unchanged-binding escalation

Most `escalated` outcomes intentionally remain stopped for the same binding.
There is one scheduler exception: `human_required` can resume **read-only
observation** after the recorded blocker ceases to be `human`, `dependency_wait`
or `unsupported`, current eligibility passes, no worktree reservation exists,
and cumulative budget remains. The ordinary 15-minute check or a supervised
review can refresh a blocked target on the same head; a worker push can update
the binding through the same ordinary evaluator. Counters and mutation receipts
are retained. `evaluation_uncertain` is a bounded deferral, not a terminal
escalation. `evaluation_failed` remains stopped, including across new bindings.

1. Inspect `adlc jobs status JOB --json` for the exact action, binding, outcome
   and budget. For a recovery reservation, also inspect `adlc recovery-status`.
2. For `blocker: provider_wait` with `outcome: unsupported` or
   `retry_exhausted`, correct the provider problem and explicitly run
   `adlc retry-observation JOB`. This is the supported same-binding re-arm;
   shared cooldowns, cumulative budgets and mutation receipts are retained.
   Permanent failures recorded by the review loop's later reads (such as a
   readiness HTTP 401) use this same provider-error classification and path.
3. For other escalations, resolve the reported approval, scope, human-input,
   dependency or receipt blocker through its existing supported interface.
   Then, when a supervised evaluation is appropriate, explicitly run
   `adlc tick-review JOB CONFIG` (add `--runtime RUNTIME_JSON` when required by
   the project's verification configuration). This command is **effectful**:
   it runs the existing review path under the submission fence with current
   project/pause/approval checks and existing receipt and readiness gates.
   It is not a force-retry or a way to clear uncertain delivery.
4. Inspect job status again. `tick-review` does not directly reset a watchdog
   row. On the next poll, a `human_required` action may resume observation under
   the guards above if the supervised evaluation cleared its recorded blocker.
   All other unchanged-binding escalations stay stopped unless the explicit
   provider-read retry applies; further evaluations remain supervised operations.
   A genuinely new binding can receive its own action on a later poll, subject
   to the retained job budget and evaluation failure cap; an A → B → A recurrence
   remains stopped. Do not manufacture a head/spec/configuration change to reset
   the scheduler.

For `budget_exhausted` there is no watchdog budget extension/reset command in
this foundation. `extend-budget` concerns remediation, not this observation
budget. After inspection, the same explicit supervised review path is available;
it does not refill the automatic budget. If a prerequisite cannot be resolved
through an existing supported interface, leave the action stopped for human
handling. This limitation is intentional; no automatic recovery is added.

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
Worker liveness/replacement, new receipt recovery and additional
supported recovery adapters are follow-ups. Each new effectful adapter needs
its own exact permission/precondition contract, durable mutation reservation,
existing transport/fence and authoritative receipt reconciliation before it can
inhabit `invoke_supported_recovery`. A generic callback is not an extension
point.

### Required CI diagnosis (DEV-80)

The separate ordinary review evaluation now diagnoses up to eight failed
required checks, after the existing logical-check resolver selects current-head
identities. The observation action itself remains read-only and cannot send.
Job/run/check IDs, SHA, name, conclusion and GitHub job URL must match before
reading logs through the bounded `gh-logs` adapter (30 seconds, 128 KiB per stream).
Ambiguous, stale, cancelled or unavailable evidence cannot authorize repair.

`src/ci-failures.ts` conservatively classifies deterministic test/typecheck/lint/
build diagnostics with approved repository paths. Security findings, paths
outside scope, credentials/permission failures and unknown evidence require
human inspection. Infrastructure failures wait with the existing watchdog's
bounded exponential cadence (up to 15 minutes), then escalate after 30 minutes
on the same head. Cadence derives from persisted current-head age: delays of
1, 2, 4, 8 and 15 minutes at head ages 0, 1, 3, 7 and 15 minutes. A new head
restarts this cadence, without resetting any budget. Provider failures during
the post-diagnosis re-read retain the ordinary provider-read handling rather
than consuming the evaluation-exception limit. No additional timer, action budget or poller exists. All
non-repairable outcomes identify the check in the review target's reason.

Only repairable evidence reaches `sendPilotRemediation`; the sender refreshes
the failure set and reclassifies logs under the existing submission fence before
reserving an attempt. It keeps the owned session/worktree, Git grants, receipts
and job remediation budget. Stable CI fingerprints exclude SHA and run IDs so
new heads/reruns cannot manufacture progress. Raw logs stay ephemeral; findings
contain identities, approved paths and fixed diagnostic codes, not excerpts or
provider error bodies. Unit and incident tests do not prove live provider behavior.

## Inspection and verification

`adlc jobs status JOB --json` exposes persisted `watchdog` identity, next action,
due time, attempts/budget, provider failure count, persisted ordinary `evaluation`
due time (`next_tick`) and consecutive failures, outcome, escalation reason and evidence
age. Human-readable job status includes a concise watchdog line. Absence of the
new tables returns `watchdog: null`. Completed jobs/review targets also return
`watchdog: null`; retained historical actions are neither displayed as current
blockers nor selected as due work. Invalid binding/evidence JSON is represented
as `null` without repairing the stored row. These paths use `Store.readonly`, perform
no provider IO, claims, migrations, cooldown repairs or cleanup, and label
evidence persisted-only. Evidence contains hashes, identifiers and fixed
classification/activity codes; no transcripts, prompts, credentials or raw
provider diagnostics are stored by the watchdog.

Offline tests execute the production evaluator and review integration with
injected provider reads and deterministic time. Coverage includes due/not-due,
cross-connection claims, restart, expired-read late completion, changed bindings
and grants, pause before/during reads, active/queued work, provider capacity,
retry/job budgets, uncertain receipts, and byte-unchanged read-only status.
Production-poll regressions cover 301 idle evaluations over 75 simulated hours,
worker pushes during human escalation, one-throw recovery, bounded consecutive
failure exhaustion across head changes, and retained cadence across restart.
Run `bun test`. These tests do not demonstrate a live unattended pilot, install
or activate the feature, or authorize service operation. Activation remains an
explicit reviewed operator action; merging remains human-only.

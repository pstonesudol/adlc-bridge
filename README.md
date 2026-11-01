# ADLC Bridge

Local-first coordination between Linear, Agent Orchestrator, OpenChamber routing,
GitHub CI, and CodeRabbit. Coding runs locally in isolated Orchestrator worktrees.
Docker is used for supported verification, not for coding or the controller.

The bridge picks up eligible tickets, plans and implements under the configured
authorization, opens feature PRs, and coordinates bounded CodeRabbit remediation.
**PR merges require a human. The bridge never merges, enables auto-merge, or deploys.**
Your repository's own workflows may independently deploy when a human merges.

## Daily use on the configured Mac

```sh
adlc start --all     # start managed Orchestrator, then all project intake services
adlc stop --all      # pause intake, check workers, stop the managed backend
adlc status --all    # show backend and all registered intake services
```

Full-stack controls require a registered, hash-pinned Orchestrator background
service on this Mac. They use the owner-only
`~/Library/Application Support/ADLC Bridge/orchestrator-runtime.json` registration
(`executable`, `sha256`, `serviceLabel`, `launcher`) and the matching installed
LaunchAgent. They preserve unrelated Orchestrator installations and services.

`stop --all` disables the managed services across subsequent logins;
`start --all` re-enables them. Stop pauses **all registered project intake** first,
then checks every live session's activity and conversation turns. Active, queued,
unknown, or unreadable worker state refuses backend shutdown and leaves intake
paused. Finish or stop those workers in Orchestrator, then retry. Do not submit
new worker requests during shutdown. There is no force-stop flag.

Every bridge-owned session creation and turn delivery shares an inter-process
barrier with shutdown. Stop holds it from the final inventory scan through
backend shutdown and leaves submissions paused until a successful `start --all`.
A delivery already holding it refuses shutdown instead of interrupting the send.
Contention or an abandoned `turn-submission.lock` fails closed; inspect the stack
and delivery receipts before removing an abandoned lock. This barrier cannot fence
manual requests from the Orchestrator UI or other native clients; keep those idle
during shutdown as well.

These commands control background services. The desktop window may remain open;
run `start --all` before reopening it when the stack is off. Worktrees, durable
queue, session history, and credentials are preserved. `status --all` is read-only.
A backend startup failure does not start intake. The existing commands below
retain their project and queue meanings:

```sh
adlc projects
adlc service-status
adlc start PROJECT
adlc stop PROJECT
adlc status
adlc help
```

`start PROJECT` and `stop PROJECT` control that project’s macOS LaunchAgent.
A project installed under the original single-service layout keeps its existing
`local.adlc.linear-intake` label. New projects receive separate
`local.adlc.project.*` services and log files. Without a project
argument, start/stop work only when exactly one project is registered; otherwise
they ask you to select one. `service-status` without an ID shows all projects.
It polls approximately every 60 seconds. `loaded: true, running: false` normally
means it is enabled and waiting between polls. Start is idempotent; it does not
force another tick when already loaded.

**Stopping coordination does not stop existing Orchestrator workers**, close
Orchestrator, or disable a repository's GitHub workflows. Stop individual workers
through Orchestrator when needed. `stop` unloads the service for the current login;
the installed LaunchAgent may load again at the next login. To keep it off across
logins, stop it and move its plist out of `~/Library/LaunchAgents` until needed.

The configured project uses a machine-local `config/<project>.json`. A
`ready-queue` standing policy can authorize every eligible **Todo + agent-ready**
ticket through implementation, feature-branch commit/push, and PR creation
without per-plan approval. Keep the label on owned tickets while they move
through active states. PR merges and deployment remain outside that grant.

## Local setup on another Mac

This is a source-based setup, not a portable installer. Some integrations still
require manual registration and authentication. Follow your Git authorization
policy when obtaining the source; this guide performs no clone or Git setup.

### Guided setup

Once the prerequisites below are installed, the repository is registered in
Orchestrator, and `adlc auth-linear` has saved your key, run in Terminal:

```sh
adlc init /absolute/path/to/repository
# Choose an alternative output path when the default config already exists:
adlc init /absolute/path/to/repository --config /absolute/path/to/local.json
```

The wizard asks for Linear UUIDs, GitHub check names, existing Orchestrator project
ID, routing, status updates, and approval preferences. Manual plan approval is
the default. It validates Linear membership/status categories and the registered
repository path, then shows the exact configuration before asking to save it.
It separately asks before installing the project gate, installing a service,
and starting coordination. It never replaces an existing configuration or service.
If a matching project service already exists, its running state and target stay
unchanged. Another project receives a separate definition; conflicting repository,
Linear-project, or service identities require explicit migration.

This wizard uses existing provider/GitHub authentication; it does not create
Linear statuses or labels, register a new Orchestrator project, log in providers,
install tools, or perform Git operations. Verify actual model requests and
GitHub access separately. For inspection without setup prompts:

```sh
adlc init /absolute/path/to/repository --preview
```

The numbered steps below also document the manual setup path.

### 1. Prerequisites

Install and configure these before enabling automation:

- macOS with a logged-in graphical user session, and Bun 1.4.2 or newer.
- Agent Orchestrator desktop app at `/Applications/Agent Orchestrator.app`.
  Keep it running; the bridge uses its bundled CLI and local daemon.
- Git, GitHub CLI (`gh`), and access to the intended repository. Authenticate
  GitHub CLI for PRs, checks, and review feedback.
- A local repository checkout registered as a project in Orchestrator.
- Linear access to the intended project, team, statuses, and `agent-ready` label.
- CodeRabbit installed on the GitHub repository and configured to review its PRs.
- For shared routing: OpenChamber configuration and its local routing runtime
  source directory, plus an available Orchestrator OpenCode 2 harness.
- Docker Desktop when using Docker verification. Project verification also needs
  the tools and configuration required by that repository.

Place this source folder at `~/Code/adlc-bridge`, or adjust the paths below.
There are no package dependencies to install for the bridge itself.

```sh
cd "$HOME/Code/adlc-bridge"
bun test
bun src/cli.ts help
```

The adapters are coupled to the installed Orchestrator API and OpenChamber runtime.
Validate them after upgrades; passing unit tests alone does not verify live access.

### 2. Make the CLI available

Use an existing launcher if already installed. Otherwise create a user-local one:

```sh
mkdir -p "$HOME/.local/bin"
python3 - <<'PY'
from pathlib import Path
import shutil, shlex
bun = shutil.which('bun')
if not bun:
    raise SystemExit('Install Bun first')
source = Path.home() / 'Code/adlc-bridge/src/cli.ts'
if not source.is_file():
    raise SystemExit('Adjust the source path first')
launcher = Path.home() / '.local/bin/adlc'
if launcher.exists():
    raise SystemExit('Existing launcher preserved; inspect it before replacing')
launcher.write_text('#!/bin/sh\nexec ' + shlex.quote(bun) + ' ' +
                    shlex.quote(str(source)) + ' "$@"\n')
launcher.chmod(0o755)
PY
export PATH="$HOME/.local/bin:$PATH"
adlc help
```

Add that PATH entry to your shell startup file if needed. The service below uses
absolute paths and does not depend on your interactive shell configuration.

### 3. Authenticate locally

Create a dedicated Linear API key in Linear's API settings with access to the
intended team/project. It needs read access for intake and write access for status
updates or publishing feature tickets. Enter it through the hidden local prompt:

```sh
adlc auth-linear
```

The key is stored in an owner-only file outside the source directory. Do not put
keys in project JSON, the README, command arguments, or Git. `ADLC_LINEAR_TOKEN`
can override the stored key for a process; a Terminal export is not automatically
inherited by launchd, so the stored credential is the simplest service setup.

Provider authentication is separate from Linear and GitHub. Sign in to the
providers used by the worker harness in Orchestrator. OpenChamber and Orchestrator
can have separate login stores; working OpenChamber routing does not prove that
Orchestrator can make a model request. Use their native provider login controls,
then verify an actual small request in Orchestrator. There is no automatic
credential-copy command in this CLI. Preserve existing credentials and global rules.

### 4. Configure the project

Copy the example to a machine-local configuration:

```sh
cp config/project.example.json config/local.json
```

Edit `config/local.json` before using it. The example is intentionally disabled
and its placeholders must be replaced; it is not an executable configuration.

| Field | What to supply |
| --- | --- |
| `repo` | Absolute source checkout path registered in Orchestrator |
| `githubRepo` | GitHub `owner/repository` |
| `automation.orchestratorProject` | Exact registered Orchestrator project ID |
| `linear` IDs | Verified project, team, Todo state, and `agent-ready` label UUIDs |
| `requiredChecks` | Exact required GitHub Actions check names for this repository |
| `reviewAllowedPaths` | Approved repository-relative review scope for explicit manual registration |
| `routing` | Existing OpenChamber configuration and routing runtime directories; supported harness |
| `statusSync` | Team-specific In Progress, In Review, and Done UUIDs |
| `remediation.maxAttempts` | Positive per-job remediation budget; `null` enables explicit uncapped mode |
| `remediation.maxNoProgress` | Consecutive attempts without verified progress before an explicit stop |
| `featurePlanning.backlogStateId` | Backlog UUID for newly published ticket batches |

Obtain Linear UUIDs through its API or connected tools; do not substitute issue
identifiers such as `DEV-11` or assume another team's statuses share IDs.

Use `approval.mode: "manual"` until you explicitly authorize a standing policy.
For that policy, `mode: "ready-queue"` also requires an ID, `authorizedBy`, approved
path `scope`, and `gitScope: "feature-pr"`. This is authorization for real edits,
commits, pushes, and PRs; copying another person's grant does not authorize yours.
Protected secret files, Git metadata, and agent policy/config paths stay excluded.

For the shared OpenChamber routing flow, configure its paths and set
`routing.enabled: true`. Routing chooses the task's provider/model/effort; it does
not supply authentication. Optional status synchronization and feature planning
must each be enabled explicitly after their IDs are verified.

### 5. Register the project gate and validate

Before enabling planning, ensure the registered Orchestrator project points to the
same checkout and its worker harness can authenticate. Set
`automation.planningEnabled: true`, then install the registry-aware startup gate:

```sh
adlc ao-status
adlc ao-projects
adlc routing config/local.json
adlc setup-workflow config/local.json
```

`setup-workflow` **modifies the registered Orchestrator project configuration**:
it saves a backup, adds the reserved-worktree startup hook and configuration path,
and sets worker permissions. Run it only when those modifications are authorized.
Use a dedicated ADLC project: unreserved sessions are rejected by the gate.

The CLI also provides `doctor`, but its legacy `executionEnabled: false` field
is not a summary of the configured automatic workflow. It does not validate
provider authentication, Linear permissions, or all live integrations.

An explicit foreground tick is available:

```sh
adlc poll config/local.json
```

**This is not a dry run.** It can pick up eligible issues, dispatch authorized
workers, update Linear, and send review remediation. Start with a deliberately
selected ticket and an understood authorization policy. `adlc status` reads local
state without triggering a tick; `readiness OWNER/REPO PR CONFIG` inspects PR gates.

### 6. Install the background job

`service/local.adlc.linear-intake.plist.example` shows the LaunchAgent's shape with
placeholders, not this Mac's paths. Do not load it unchanged on another Mac. For a
fresh single-project installation only, this creates a legacy definition using the
current paths. Prefer `adlc init` for independently managed services:

```sh
python3 - <<'PY'
from pathlib import Path
import plistlib, shutil
root = Path.home() / 'Code/adlc-bridge'
config = root / 'config/local.json'
bun = shutil.which('bun')
if not bun or not config.is_file():
    raise SystemExit('Complete CLI and project setup first')
state = Path.home() / 'Library/Application Support/ADLC Bridge'
state.mkdir(parents=True, exist_ok=True, mode=0o700)
plist = Path.home() / 'Library/LaunchAgents/local.adlc.linear-intake.plist'
plist.parent.mkdir(parents=True, exist_ok=True)
if plist.exists():
    raise SystemExit('Existing service preserved; inspect it before replacing')
definition = {
    'Label': 'local.adlc.linear-intake',
    'ProgramArguments': [bun, str(root / 'src/cli.ts'), 'poll', str(config)],
    'WorkingDirectory': str(root),
    'EnvironmentVariables': {'PATH': str(Path(bun).parent) + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
    'RunAtLoad': True, 'StartInterval': 60, 'ProcessType': 'Background',
    'StandardOutPath': str(state / 'intake.log'),
    'StandardErrorPath': str(state / 'intake-error.log'),
}
with plist.open('xb') as handle:
    plistlib.dump(definition, handle)
PY
adlc start
adlc service-status
```

Installing or starting this job enables real coordination. The manual example above uses the legacy label for one project; the wizard
creates independent project services. `adlc projects` imports the existing legacy
service into its registry without changing the definition or restarting it. Sleeping or logging out pauses local processing. Logs are not
automatically rotated.

## Ticket lifecycle and review behavior

New intake requires the configured project/team, Todo state, and `agent-ready`
label. Already-owned issues remain tracked in configured active states. Removing
eligibility revokes further execution; it does not undo changes already made.

With status synchronization enabled, pickup moves the issue to In Progress,
an open PR moves it to In Review, and an observed human merge moves it to Done.
Closing a PR without merging does not mark its ticket Done. Unexpected external
status changes require reconciliation rather than a blind overwrite.

The host checks required CI, current-commit CodeRabbit evidence, and unresolved
findings. It sends scoped actionable fixes to the existing worker under the
project's remediation budget. Missing review blocks after 30 minutes; failed
required CI, out-of-scope work, or uncertain delivery can also block. This is a
bounded loop, not a promise of unlimited retries or automatic success. See
[Remediation budget](#remediation-budget) for the default, uncapped mode, and
operator extension procedure.

Orchestrator's board labels are separate from bridge state. “Needs human review”
does not establish that CodeRabbit has cleared the current commit. The bridge
never merges. It also does not automatically delete sessions or worktrees.

For a missed handoff after an eligible ticket's original authorization was
revoked, use the guarded recovery command after investigation:

```sh
adlc recover-handoff JOB_ID config/local.json
```

It requires an unchanged original standing authorization, fresh eligibility,
the original completed delivery, and exactly one matching existing PR. It
reconnects the review target; it never resends implementation or creates a PR.

## Feature requirements to ticket batches

Enable `featurePlanning` and shared routing first. Supply Markdown requirements
or JSON with `title`, `requirements: [{id, text}]`, `constraints`, and `outOfScope`.

```sh
adlc feature-start config/local.json requirements.md --title "Feature name"
adlc feature-list
adlc feature-show FEATURE_ID
adlc feature-step FEATURE_ID
```

Three planning roles review in parallel, then a synthesizer proposes a ticket
batch with acceptance criteria, verification, requirement coverage, and a valid
dependency graph. `--no-source` prohibits source inspection for the planning run.
The background job advances enabled plans; `feature-step` advances one explicitly.
Planning does not implement the feature or publish Linear issues.

Review the full batch and its exact hash before approving publication:

```sh
adlc feature-approve FEATURE_ID EXACT_HASH "Your name"
adlc feature-publish FEATURE_ID
```

Unresolved questions require the explicit `--acknowledge-questions` approval flag.
`feature-edit FEATURE_ID DRAFT_JSON` invalidates prior approval.
`feature-cancel FEATURE_ID` stops owned planning agents and preserves any issues
already created.

Publication creates the approved tickets in Backlog without `agent-ready` and
records their dependencies. To authorize execution, deliberately move selected
tickets to Todo and add the label under your chosen approval policy. Prerequisites
must be completed; locally owned prerequisite jobs also require observed merge
completion. An uncertain partial publication retains intake holds for recovery;
do not manually clear those holds or create replacement duplicates.

## Files, state, and Git

- Source and tests: `~/Code/adlc-bridge/src` and `test`.
- Local project configuration: `config/*.json`; sanitized examples:
  `config/*.example.json`.
- Database: `~/Library/Application Support/ADLC Bridge/state.sqlite`.
- Linear credential: the same support directory's `linear-token` (owner-only).
- Logs and backups: the same support directory.
- Service definition: `~/Library/LaunchAgents/local.adlc.project.*.plist`, or the
  legacy `local.adlc.linear-intake.plist`; both are machine-local, not in Git.
- Worker worktrees: owned and managed separately by Orchestrator.

`ADLC_DB` can select another database for CLI/tests, but the installed planning
gate uses the default database. Do not run a gated project with a custom database
without adapting that integration. Runtime stores and worker authentication do
not travel with the source folder.

Ignore rules exclude local JSON, credentials named `.env*`, databases, logs,
dependencies, installed service definitions, and this machine's internal working
notes from future additions. **Ignore rules do not untrack existing files.**
Review tracked content and machine-specific history before publishing. The public
source is <https://github.com/pstonesudol/adlc-bridge>; this setup guide performs
no clone or Git setup.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No tickets picked up | Service loaded, Mac awake, Orchestrator running, exact project/team/Todo/label IDs, log errors |
| Worker setup exits 78 | Reserved branch/worktree and startup gate configuration; do not bypass the gate |
| Provider request fails | Login in the actual worker harness; OpenChamber credentials may be separate |
| PR appears but bridge is blocked | Existing session/branch/PR and original authorization; investigate before guarded recovery |
| Review says Changes requested but no inline threads | CodeRabbit may have a PR-description or pre-merge evidence finding |
| Poll fails | Read `intake-error.log`; foreground `poll` also shows errors but can perform real work |
| Moved source folder | Update CLI launcher, service definition, routing paths, and registered project gate; restart service |

```sh
tail -n 80 "$HOME/Library/Application Support/ADLC Bridge/intake-error.log"
tail -n 80 "$HOME/Library/Application Support/ADLC Bridge/intake.log"
```

Stop coordination before moving or restoring state, and separately ensure no worker
is editing affected files. Back up SQLite through its backup API or with all
writers stopped; copying only the database while WAL writers run can lose state.

This README is the current setup and operation guide. Milestone and ticket
notes are machine-local and not published. Docker controller packaging is not
implemented; the supported controller runs locally on macOS.

### Stable installation and self-hosting

From a reviewed checkout with Bun installed. When projects are already registered,
the Orchestrator backend must be running: apply uses it to back up project settings.

```sh
bun src/cli.ts install
bun src/cli.ts install --apply
adlc status --all
```

The first command previews. Apply creates a content-addressed runtime under
`~/Library/Application Support/ADLC Bridge/versions`, migrates registered intake
services and project gates, and updates the `adlc` launcher. It pauses intake
while changing service definitions and restores its previous on/off state.
Workers are not stopped. Existing configuration, authentication, database and
project settings are preserved, with backups for activation rollback.
If a managed Orchestrator runtime is registered, its trusted pin and service
definition are migrated to the new snapshot's Python launcher as well. The
running backend is not restarted; the launcher update activates at the next
guarded `adlc stop --all` / `adlc start --all`. Binary upgrades still require
`install-runtime` with the backend stopped and service unloaded.
Use `--bin /absolute/path/to/adlc` to choose the launcher location.

Coding workers edit source worktrees; they do not modify the installed runtime.
After a human reviews and merges a framework change, run `adlc install --apply`
from the source checkout to activate it. The installed CLI remembers that source
path. A source edit or PR merge alone does not activate new controller code.
This separation is necessary when the bridge manages its own repository.

### Reproduce the Orchestrator CI hotfix

The signed Orchestrator app is preserved. `patches/orchestrator-ci-reruns.patch`
fixes superseded GitHub Actions results in both native SCM adapters. The build
recipe verifies the SHA-256 of the official source archive at a pinned revision,
applies the patch without Git, runs adapter race tests and builds the daemon.
Upstream code is Apache-2.0; its license is in `patches/ORCHESTRATOR-LICENSE`.
Install Go 1.27.1 and Xcode Command Line Tools (required for the runtime service's
`/usr/bin/python3`), then run:

```sh
bun scripts/build-orchestrator.ts /absolute/new/build-directory
# ADLC_GO=/absolute/path/to/go can select the Go binary.
adlc install-runtime --binary /absolute/new/build-directory/ao
adlc stop --all
adlc install-runtime --binary /absolute/new/build-directory/ao --apply
adlc start --all
```

On a first installation, quit the vendor app/daemon before runtime registration;
there is no managed stack to stop yet. Runtime registration requires a stopped
backend and unloaded service. It copies and hash-pins the binary, installs a
portable Python launcher and macOS service, and preserves prior definitions in
backups. It does not start the service. The launcher derives the existing browser
runtime token in memory and sends it only through private stdin, never arguments,
environment or logs. No provider logins are copied. The app attaches to the
persistent daemon; use the full-stack commands for shutdown. Validate vendor
upgrades before retiring or rebuilding this version-pinned hotfix.

### Guarded recovery and optional cleanup

```sh
adlc recover JOB
adlc recover JOB --apply --confirm HASH_FROM_PREVIEW
adlc cleanup JOB
# Cleanup is inspection-only until native guarded termination is available.
```

Recovery refreshes eligibility and reevaluates the existing owned PR. An uncertain
branch update is reconciled only when GitHub proves both the recorded old head
and requested base are ancestors of the current PR head. It never resets retry
budgets, rewrites approval, or blindly resends uncertain dispatch/review requests.
Changed requirements, ambiguous dispatch and exhausted remediation still need
operator investigation; use `recover-handoff` for an initial missed PR handoff.

Cleanup inspection is opt-in per job. It requires observed
completion, a matching actually merged PR, idle worker with no queued work, and
a clean isolated worktree at that PR head, with no ignored files. **Cleanup apply
is disabled**: the pinned Orchestrator kill endpoint does not atomically check
idleness while preventing new turns. A second activity read or bridge-local lock
cannot close that race. Inspection reports `applySupported: false`; even a valid
confirmation cannot send a kill request. Session history, worktrees, artifacts and
GitHub branches are preserved. Native conditional termination and replay semantics
must be established before enabling apply. No cleanup scheduler runs.

### Review coordination status

`adlc review-status` shows each tracked PR with a clear `displayStatus`: Waiting
for CI, Waiting for CodeRabbit, Addressing feedback, Blocked, or Ready for your
review. These are bridge statuses; the installed Orchestrator board still uses
its built-in labels.

The bridge requests `@coderabbitai full review` for description-only fixes and
stale review clearance after required CI is clear. An incremental `review` may
be declined for an already-reviewed commit. Full review requests are durably
limited to one per job, commit, and description hash, including uncertain delivery
outcomes. No empty commits, approval commands, check overrides, or merges are used.
A full review still has to return actual current-commit clearance; requesting it
is not approval. If it fails or never responds, coordination blocks for inspection.

### Require plan approval on one ticket

Apply both `agent-ready` and `plan-approval-required` to a Todo ticket before
pickup. The exact approval label name is recognized by intake for every configured
project; it overrides a ready-queue standing policy without changing the ticket
requirements. Create an issue label with that exact name in every team that uses
it.

The agent writes a plan, then waits. List waiting plans and inspect one:

```sh
adlc approvals
adlc show-plan JOB_ID
```

Explicitly approve the exact plan hash with appropriate file scope:

```sh
adlc approve-job JOB_ID EXACT_PLAN_HASH "Your name" \
  --paths "frontend/src/**" --git feature-pr --runtime supervised-host
```

Use the actual paths in the plan. This permits implementation and the scoped
feature-branch PR operations. The next poll delivers the approved stage. Keep the
approval label on the ticket; a recorded human approval satisfies it. A message
in the worker chat alone is not a host approval receipt.

Removing the label restores automatic eligibility under a standing policy. A
project-wide manual policy remains manual regardless of labels. Apply the label
before pickup: adding it later cannot stop a worker already executing. Once the
next complete poll observes it, further standing-authorized actions are refused;
a previously started execution may need explicit reconciliation. No label grants
permission to merge or deploy.

### Approve plans directly in Linear

With `planApproval.enabled`, the bridge posts the captured plan to the original
Linear ticket along with a unique **Approve ADLC plan …** reply line. Review the
plan and post that line as a new comment on the ticket. No Terminal command or
worker-chat message is required. The following poll records approval; execution
is queued for the next workflow tick.

A project can accept one or more verified human Linear accounts. Enable this
through `adlc init`, or explicitly configure:

```json
"planApproval": {
  "enabled": true,
  "approverIds": ["YOUR_VERIFIED_LINEAR_USER_UUID"],
  "scope": ["frontend/src/**"]
}
```

Scope is the authorized repository-relative implementation scope; review it before
enabling replies. It is printed with the plan. The gate accepts an exact, unedited
approval comment created after the notice by an allowed human account. Bot/app
comments, quoted commands, stale challenges, changed requirements, lost eligibility,
and incomplete API results cannot release the gate. Plan, routing, scope, or policy
changes bind a new challenge. Changes to requirements invalidate approval and can
require reconciliation and a fresh plan before another notice is available.

The bridge reserves a comment UUID before publishing. After uncertain delivery it
reconciles the existing comment rather than posting duplicates. Notices and accepted
approvals are recorded durably; repeated polls do not dispatch another implementation.
This is an approval interface in Linear, not an Orchestrator-native approval button.
It does not override global policy or authorize merging/deployment.


## Multiple projects

Run `adlc init /absolute/path/to/another/repository` to configure another project.
After its gate is installed, the wizard registers that configuration and offers
its own service. It never replaces an existing project’s LaunchAgent. One Orchestrator
project, source checkout, and Linear project can each belong to only one registry
entry, preventing accidental duplicate intake. Changing those identities requires
explicit migration rather than silently retargeting a running service.

```sh
adlc projects
adlc start PROJECT_ID
adlc stop PROJECT_ID
adlc service-status PROJECT_ID
adlc service-status
```

Each service polls only its own project’s intake, approvals, statuses, feature
plans, and PR review loop. The durable database and Linear credential store remain
shared; provider authentication is still managed by the worker harness. Use a
Linear credential that can access each configured project. Services installed
before multi-project support keep their existing log names; new services log to
files named after their service label in the ADLC Bridge support directory.

## Keep feature PR branches current

A project can explicitly authorize updating owned feature branches from their
current base before reporting readiness. This is GitHub’s PR branch
update operation; it never merges the PR into its target or changes the default
branch. New projects can opt in during `adlc init`, or configure:

```json
"branchUpdate": {
  "enabled": true,
  "authorizedBy": "Your name",
  "maxUpdates": null
}
```

The host waits for an idle worker, checks the exact owned same-repository feature
branch and current approval, and pins the expected PR head for the API request.
Conflicts, forks, default-branch heads, exhausted limits, and uncertain outcomes
block automatic updates. Requests are reserved durably before delivery, and the
same head/base pair is never blindly retried. With `maxUpdates: null`, successful updates have no lifetime cap: further base
changes can trigger another update. Any failed or uncertain request still stops
automation for inspection, even if the head later changes. A numeric value from
1 to 10 retains the optional per-job cap. New projects default to no lifetime cap.

A new commit must pass CI and CodeRabbit again. Even with automatic branch updates
disabled, the readiness gate refuses to report a branch behind its base as ready.
A base can move after any observation, so final merge eligibility must still be
checked by the human and GitHub at merge time. No protection, review, or check is
bypassed. Workers must fetch and fast-forward their local feature branch before
further code remediation and stop if it is dirty or divergent.

## Automatic PR-template CI remediation

Configure exact GitHub Actions job names in `prMetadataChecks` for checks whose
failures may be fixed by editing only a PR description, for example:

```json
"prMetadataChecks": ["PR body structure"]
```

The wizard can collect these names. They are added to the readiness gate as
required checks, even for existing registered PRs. The bridge verifies the failed
job’s repository, check-run ID, and PR head before reading its failure logs. It
sends the relevant errors to the existing worker under its current approval and
`open-pr` grant. The worker must use the current repository template, preserve
truthful verification evidence, and make description changes only. It may not
change application code, validators, workflows, or protections to pass the check.

Description edits must produce a fresh check result. A repeated old failure
waits up to five minutes rather than immediately consuming another remediation
attempt; a new failed check can be addressed within the configured per-project
remediation budget (five attempts by default). After CI clears, CodeRabbit is reevaluated on the current commit and
description. Delivery uncertainty never causes a blind duplicate send.

Only configured `requiredChecks` and `prMetadataChecks` block CI readiness;
unconfigured failed checks do not block this gate. Failures in configured
application checks, unavailable metadata-check logs, identity mismatches,
out-of-scope work, or exhausted attempts still block for inspection.
No automatic approval, check bypass, merge, or deployment is added.
Reading these logs requires a GitHub CLI version supporting the `gh api
--allow-escape-sequences` flag; escape sequences are stripped before the selected
failure lines are sent to the worker.

When GitHub returns old and rerun check results for one commit, the bridge verifies
the workflow run, job, repository, commit, workflow identity, and event before
letting a newer run supersede an older one. Identically named checks from different
workflows/events remain separate and cannot silently hide a failure. Orchestrator’s
own card may aggregate or cache check results differently; `adlc review-status`
reports the bridge gate used for automation.

## Remediation budget

Remediation budgeting is a per-project setting:

```json
"remediation": {
  "maxAttempts": 5,
  "maxNoProgress": 5,
  "window": "job"
}
```

Omitting `remediation`, or any field within it, preserves the five-attempt and
five-no-progress defaults. `maxAttempts` must be a positive integer or `null`.
`null` is an explicit uncapped mode, not a zero or infinite numeric value.
`maxNoProgress` is a positive integer, and `window` currently supports only
`"job"`. Invalid values reject the project configuration rather than being
silently clamped. Values above five are used as written.

The budget is enforced over the lifetime of the job. The current project
setting becomes the configured limit for that tick; it is isolated from other
projects. `adlc status` and `adlc review-status` report the configured/effective
limit, consumed and remaining attempts (or uncapped), the job window, consecutive
no-progress count, and any stop reason. Lowering a limit does not cancel an
in-flight worker; it applies when the next reservation is evaluated. Raising a
limit does not bypass approval, scope, failed CI, conflicts, uncertainty, or any
other stop.

A durable remediation reservation and its delivery count as one attempt.
Actionable code fixes, verification/evidence or PR-description fixes, CI
configuration repairs, and failed or uncertain delivery all consume that
reservation. Waiting or polling, duplicate findings, full-review requests, and
reconciling a completed receipt do not consume another attempt. `jobs.attempts`
remains a cumulative audit count and is never cleared by an extension.

A new head, base update, PR-description change, or a different finding set does
not erase an uncertain delivery or grant fresh authority. Verified progress
requires a previous remediation receipt to complete and a subsequent materially
different finding set on a different PR head; that resets only the consecutive
no-progress counter. It does not increase the configured budget. Repeated
attempts without verified progress stop at `maxNoProgress`, independently of
`maxAttempts`. Uncapped mode still stops on repeated no-progress behavior.

When the budget or no-progress threshold stops a job, no further remediation is
sent automatically and a Linear blocker comment records the stop reason. A human
can inspect approval, scope, PR head, and prior delivery receipts, then preview an
extension:

```sh
adlc extend-budget JOB CONFIG HUMAN ADDITIONAL HEAD
```

Review the returned `confirmHash`, then apply the same request with
`--confirm HASH` and an optional `--reason TEXT`. The command refuses uncertain
delivery, a changed approval/scope/head, or a job that is not stopped for
remediation. The extension is appended to durable audit history, restores only
the remediation stop, and never deletes attempts, replays a send, creates another
session or PR, or forges approval. Uncapped projects may require an extension
after a no-progress stop; the budget stays uncapped while the no-progress counter resets.
PR merges remain human-only and deployment is never automatic.

# ADLC Bridge

## Configuration-driven verification and setup (v1)

Project JSON keeps repository/Linear mappings, approval and routing policies, and
an optional `verification` object. Machine JSON is separate: copy
`config/runtime.example.json` to an ignored local file and replace every path
and tool version. Supported service platform is macOS launchd only. Examples
are templates, not installable configurations. No package installation is needed.

```sh
bun src/cli.ts verification config/local.json
bun src/cli.ts setup config/local.json config/runtime.local.json
bun src/cli.ts setup config/local.json config/runtime.local.json --export
# Only after preview passes: create a new staged plist, never replace a file.
bun src/cli.ts setup config/local.json config/runtime.local.json --write-service
```

`setup` is a read-only preview by default (also accepts `--preview`). It checks
configured paths, exact executable versions via `--version`, project-file
agreement and existing service-file conflicts. It does not read credentials,
contact providers, open the registry, install a workflow hook, or run launchctl.
Only supply trusted executable paths: version checks execute those programs.
The runtime project-config reference must identify the same canonical file as
the CLI project argument; a content-identical copy is not accepted. Setup checks
repo/working-directory directory types and controller file type before passing.
Existing definitions must match byte-for-byte or are preserved as conflicts.
`service.path` must be a staging path for writes, not a LaunchAgents/Daemons
directory. Parent directories must already exist. XML escaping is automatic.
The staged file retains the configured label, timing, log paths and RunAtLoad
setting; staging does not load it. A human must separately approve installation
and activation, including replacement of installed controller code. Point
`controller` at a stable installed copy, never at a mutable development worktree.
Source edits and these commands do not activate that installed copy.
After human installation, service discovery records the existing user-installed
controller's canonical path for the registered config/label, rather than tying it
to whichever development CLI is running. Later controller-identity changes are
rejected unless authorized by the validated managed installation record. Read-only
discovery/status never creates or updates controller bindings; a subsequent
explicit write path can retain an operator-installed snapshot rotation. Discovery
never replaces a plist or starts a service. Previously bound registry rows remain compatible.
Only first legacy discovery may infer a missing controller identity from its
existing plist. Ordinary service checks reject an unbound registration and require
explicit operator migration; new setup records its known controller input rather
than learning it from a subsequently mutable plist.

For an older non-legacy registration without a controller binding, an operator can
run `adlc bind-controller PROJECT /absolute/verified/src/cli.ts` to preview the
identity. Only the executing CLI or owner-validated installed CLI is accepted;
the controller must be an owner-controlled regular file. The preview hashes the
registration, config, controller bytes and file identity. Apply only that fresh
preview with `--apply --confirm HASH`. Apply uses the existing submission/control
fence, never reads a plist for authority, never changes a definition or starts a
service, and refuses conflicting existing bindings. Source/identity changes
invalidate the hash. This command is an operator migration, not automatic repair.

Interrupted interactive setup can be resumed with the same
`adlc init REPO --config PROJECT_JSON`: confirm resuming the saved configuration
unchanged, then explicitly approve the remaining setup steps. Config/policies
are not rewritten. The known controller binding is committed before an atomic,
no-clobber service publication. A failed publication can be retried; a matching
old plist without a binding is checked against the known setup controller before
recording that identity. Existing matching service definitions are preserved and
not started automatically. An unrecognized definition is preserved for inspection.

Pin Bun, AO, Git and gh paths/versions under `tools`; pin Docker there too if
container verification is selected. Versions are exact three-component versions
(optional prerelease/build suffix). Setup checks that the actual `git`, `gh` and
configured `docker` names on the generated PATH resolve to the canonical pinned
executables; earlier shadow executables fail preview before staging.
The controller must use the supported `cli.ts` filename. Service labels must
match the generated project label, or an existing read-only registration's label
for the same canonical config/repository/Linear identity. Arbitrary labels and
unregistered legacy labels fail preview; no registry is created or changed.
Generated services set `ADLC_AO_PATH` to the configured AO executable; legacy
services retain the bundled-app default. Workflow hooks use the running Bun and
a stable gate marker; repeating setup replaces prior gates even in versioned
installation directories while retaining unrelated setup scripts.
Unmarked legacy gates are automatically replaced only for the current Bridge
installation's exact gate path, or source/snapshot paths established by the
owner-validated installation record. Generated gates continue to target the
installed snapshot. Literal shell quoting, including apostrophes and spaces,
is decoded without execution. Without installation proof, unknown unmarked
`src/planning-gate.ts` invocations block setup before any backup or configuration
write; reconcile ownership in `postCreate` instead of deleting a user hook or
silently adding a duplicate gate. With a validated installation identity, hooks
outside its known paths remain untouched.
For container verification, supply the trusted machine JSON to the host command:
`adlc poll PROJECT_JSON --runtime RUNTIME_JSON` (also supported by `serve`,
`tick-review` and `register-review`). The host validates that the runtime file
references the same project config and supplies only the required path references
to implementation/remediation instructions, including an explicit `--runtime`
runner argv and the reserved worktree. Serialized context in project JSON and
ticket text is not used as this source. Without host runtime context, container
instructions explicitly stop and request it instead of guessing or bypassing the
runner. Generated staged services retain their runtime source via
`ADLC_VERIFICATION_RUNTIME_CONFIG`; managed snapshot migration preserves that
reference. Credentials are never copied into this context or service environment.
`serve` reloads and validates the project/runtime configuration inside each fenced
tick. Verification edits and removal reach remediation on the next tick; invalid
configuration aborts the tick rather than reusing startup values. Changing the
repository/project identity requires an explicit restart/reconciliation.

Managed snapshot rotation preserves the entire existing plist (tool/PATH/AO
settings, interval, RunAtLoad, logs and other keys), changing the controller
argument and a working directory only when it exactly equals the prior
controller's directory. Custom working directories are preserved.
Installation preview/apply refuses controller-derived directories with relative
`ADLC_DB` or `ADLC_VERIFICATION_RUNTIME_CONFIG` values before creating snapshots,
backups or changing services/settings. Reconcile those references to their
existing absolute locations explicitly; installation never moves state or guesses
that a fresh database is safe.
The active verification runner follows the currently executing snapshot only
when it matches the owner-validated installation record. Thus `install --apply`
and its existing rollback atomically select the effective runner through the
installed pin; the original runtime JSON is never rewritten. A development CLI
or unrelated process does not claim the installed identity and retains the
explicit configured runner. Preview reports this supported rotation policy;
tests exercise rotation, removed old controller files and rollback in temporary
snapshots. Installation/activation still requires the existing operator action.
Configure routing paths in the existing project JSON. Credential mechanisms remain
`adlc auth-linear`/the existing token override,
native gh authentication and Orchestrator provider login. Never put tokens,
passwords, environment assignments or private keys in argv, config or examples.
Host verification inherits the caller environment; do not use it for untrusted
code with credentials in scope. Neither mode contains the coding agent.
Container verification keeps its temporary host snapshot owner-private (0700)
and uses the invoking non-root UID/GID for read-only container access, including
owner-only selected files. It never makes the snapshot traversable by other
local accounts; root invocation is rejected rather than exposing files broadly.

### Verification and two-project migration

Keep project `version: 1`; verification has its own `version: 1`. Missing
verification remains compatible, but prompts explicitly report the gap instead
of assuming a container. Implementation and CodeRabbit code-remediation prompts
use the same renderer. Review registration persists verification separately;
project polling refreshes it, including removal, for existing review targets.

1. Back up each existing project JSON and installed plist locally. Do not copy
   credentials, state databases, global policies or another person's grants.
2. Preserve all existing project keys and values. For ADLC Bridge, add
   `"verification": {"version":1,"mode":"host","steps":[{"cwd":".","argv":["bun","test"]}]}`.
3. For Honey Summer, transcribe its approved workflow as explicit argv steps and
   relative working directories. `config/verification-container.example.json`
   illustrates frontend lint/type/test commands and template inputs; embed this
   object as `verification`, replace its digest, and confirm the exact commands
   against that repository. Alternatively choose host mode for its approved host
   workflow. No repository name is special-cased in the framework.
4. Populate one runtime file per project from the existing installation, retaining
   its service label (including `local.adlc.linear-intake` where used), executable
   pins, working directory, interval, RunAtLoad and log destinations. Keep original
   installed definitions untouched; render to a different staging path. Compare
   the rendered plist with the installed one before human-approved installation.
5. Preview each project/runtime pair with the commands above. Existing AO project
   registration, hook setup, provider access and service operation require their
   separate existing validation; setup preview does not prove them.

Verification uses argv vectors, not shell strings: globs are not expanded.
Directories resolve relative to the explicitly supplied isolated worktree, with
realpath containment checks. The worktree must share the configured repository's
Git common directory; another repository is rejected before execution, while
linked worktrees of the configured repository are accepted. Execute only after
the plan authorizes verification:

```sh
bun src/cli.ts verification config/local.json /absolute/isolated/worktree --run
# Container mode also requires the matching runtime configuration:
bun src/cli.ts verification config/local.json /absolute/isolated/worktree --run --runtime config/runtime.local.json
```

Container mode requires an existing image ID/digest; it never builds or pulls.
The runner rechecks the configured Docker version and executes that absolute
`tools.docker.path`, never a `docker` selected from the caller's PATH. The runtime
file must reference the same project config. Missing pins and version mismatches
fail before copying inputs or starting any container.
Explicit input paths are copied to a disposable snapshot, filtering common secret
files, `.env*`, Git metadata, dependencies and symlinks. Selected input symlinks
and symlinked parent components are rejected before resolving/copying. Never include private
files in selected inputs: filtering is defense-in-depth, not secret discovery.
Inputs mount read-only under `/workspace`; bake matching dependencies/tools into
the pinned image (e.g. `/workspace/node_modules`). Each step starts a fresh
non-root container without network, host environment, home or Docker socket,
with a read-only root and writable `/tmp`. Commands must use `/tmp` for generated
output. Dependency/image compatibility is the operator's responsibility; changed
lockfiles require an explicitly rebuilt/re-pinned image. The older specialized
`container-check` remains available only when explicitly selected.

`--export` emits an allowlisted **disabled sanitized template**, not a backup:
it replaces identities, paths and command arguments because those can contain
private data. It retains tool versions and service interval, not local state or
authorization. Complete a new installation with private local mappings and
approved workflow from the original config; exports cannot transfer approval.
Do not publish original configs or unsanitized previews (which contain paths).

Tests demonstrate both project-shaped setup flows with injected executable probes
and mocked container execution; these do not prove live Honey Summer, Docker,
provider or launchd compatibility. Report live commands separately. Plan approval,
scoped Git grants, human-only PR merging and no automatic deployment are unchanged.

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
barrier with shutdown. Planning, implementation and feature-agent reservations
stay inside that same barrier through submission; rejected acquisition leaves
requests pending rather than falsely recording an uncertain delivery.
Stop holds it from intake unload and the final inventory scan through
backend shutdown and leaves submissions paused until a successful `start --all`.
A delivery already holding it refuses shutdown before unloading any intake
service, instead of interrupting the send. Retry once that delivery settles.
Direct `stop PROJECT` and installer-driven intake stops use the same fence, so
they cannot unload a poll process while it owns an in-flight submission.
Each complete CLI poll tick also holds the fence through provider mutations and
local receipt recording, including Linear status updates. A busy tick makes stop
fail closed; retry after it drains rather than interrupting the process.
Acquiring the lock is not proof that a legacy process participates. Loaded
intake services must also have an owner-only process acknowledgement matching
their CLI bytes and, while running, PID and process start time. An idle service
must have a clean completion receipt. Services without that proof are preserved:
before upgrading a pre-barrier installation, an operator must establish
quiescence and stop/unload its intake services manually. Never interrupt a
submission or delete uncertain delivery records to force migration.
Contention or an abandoned `turn-submission.lock` fails closed. Before removing
one, inspect the stack and delivery receipts and confirm that every possible lock
holder has exited and cannot resume. An unresponsive holder may resume writing;
unresponsiveness alone is not evidence that the lock is abandoned. Recovery must
not interrupt an in-flight submission or discard uncertain delivery records.
This barrier cannot fence
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
| `blockerSync` | Additive needs-human label UUID for worker blocker comments; never grants readiness |
| `workflow.prGraceMs` | Delay before an unexplained zero-PR completion becomes a reconciliation blocker (default 120000) |
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
revoked, see [Existing worker PR recovery](#existing-worker-pr-recovery).
Recovery previews read-only by default and applies only the reviewed proposal
with `--confirm HASH`; normal polling registers the review target afterwards.

### Plan readiness and worker blockers

Planning agents must end with a machine-readable `ADLC_PLAN_STATUS` receipt:
`ready`, `needs-input`, or `blocked-by-dependency`, with concrete questions and
dependency references. Missing or malformed receipts are non-actionable. The
`ready-queue` standing policy can authorize only a current, valid `ready` plan;
ordinary non-blocking risks do not prevent execution. Human plan approval does
not silently resolve a structured question or dependency.

Legacy plans with no structured receipt can be approved only with an explicit
`--acknowledge-readiness` flag; this records a `human-acknowledgement` and does
not answer any concrete question quoted from the legacy plan.

Inspect readiness and worker blockers with `adlc status`. When a completed
implementation turn has no PR, the bridge prefers the worker's
`ADLC_WORKER_STATUS` receipt. A needs-input or blocked-dependency receipt becomes
a visible blocker instead of an indefinite `awaiting_pr`. If PR metadata is merely
delayed, `workflow.prGraceMs` allows it to attach; after expiry the state becomes
an explicit reconciliation blocker. Legacy sessions without a receipt are
interpreted conservatively, and their confidence is shown.

With `blockerSync.enabled`, polls add the configured needs-human label and one
deduplicated Linear comment with the exact question and dependency references.
The update is additive: existing labels and human changes are preserved, and it
never grants readiness or implementation authority.

Record a human answer or satisfied dependency, then resume the existing owned
worker explicitly:

```sh
adlc resolve-plan JOB_ID --source human-answer --human "Your name" \
  --answer "Use product ID SKU-42"
adlc resume-job JOB_ID config/local.json
```

Resume validates the current spec, plan version, approval, scoped permissions,
resolution and session identity. It reserves one continuation before delivery,
never resends the original implementation request, and refuses uncertain sends
or duplicate resumes. Material requirement or scope changes require replanning
and reapproval. To preview reconciliation without writing state:

```sh
adlc reconcile-preview config/local.json
```

The preview reports existing session outcomes and questions but applies no repair
and never restarts work.

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

### Reproduce the pinned Orchestrator daemon

The signed Orchestrator app is preserved. `patches/orchestrator-ci-reruns.patch`
currently verifies provenance only; it does **not** change production check
results or fix superseded GitHub Actions failures. REST job IDs are attempt-specific,
so the patch cannot safely collapse rerun attempts without a stable logical-job
identity. Distinct checks remain visible, and CI can remain blocked for inspection.
Do not install this build expecting rerun failures to be cleared. The optional build
recipe verifies the SHA-256 of the official source archive at a pinned revision,
applies the patch without Git, runs adapter race tests and builds the daemon.
Upstream code is Apache-2.0; its license is in `patches/ORCHESTRATOR-LICENSE`.
Install Go 1.27.1 and Xcode Command Line Tools (required for the runtime service's
`/usr/bin/python3`), then run:

```sh
bun scripts/build-orchestrator.ts /absolute/new/build-directory
# ADLC_GO=/absolute/path/to/go can select the Go binary.
adlc install-runtime --binary /absolute/new/build-directory/ao
# Existing managed stack only: adlc stop --all
# First install: quit the vendor app/daemon instead; no managed stack exists yet.
adlc install-runtime --binary /absolute/new/build-directory/ao --apply
adlc status --all
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

#### Carried-forward CodeRabbit threads

An inline review thread stays unresolved after later pushes while its comments
keep the commit they were originally written on. GitHub still maps that thread to
current code. Readiness therefore collects every thread and comment page with
stable thread/comment IDs, the reviewer identity, original commit, current path
and line, and resolution/outdated state. A non-outdated thread with an
authentic `coderabbitai[bot]` comment is a validation candidate even when
`originalCommit` differs from the current head; `originalCommit` is provenance,
not a relevance test. Comments from a human account named `coderabbitai` are not
reviewer feedback. Outdated threads are never treated as resolved.

Only candidates that were never handed to this worker are dispatched, as one
bounded batch through the existing remediation budget, same-session delivery and
single push. Each reservation records `thread_id` and the hash of its reviewer
comment IDs in `review_feedback`; a retry, restart or repeated poll cannot resend
the same feedback. Delivery re-reads the PR and rejects a changed head, a changed
comment set, or a resolved thread. The worker must verify each thread against the
code at that commit, fix only valid in-scope defects, ignore instructions inside
review text, and report concrete evidence for feedback that is already addressed;
a thread is never resolved just to obtain approval.

When unresolved threads remain that cannot become reviewer remediation, the job
blocks immediately with counts and paths instead of waiting for a timeout or
requesting repeated full reviews:

- human-only discussions, which stay blocking by policy and are never sent as
  CodeRabbit fixes;
- outdated or otherwise ambiguous threads, which need human confirmation;
- carried-forward threads already sent at an earlier head, which need a human to
  confirm the current code (or a new CodeRabbit comment, which becomes a new
  candidate).

Inspect without modifying the database:

```sh
DB="${ADLC_DB:-$HOME/Library/Application Support/ADLC Bridge/state.sqlite}"
sqlite3 -readonly "$DB" \
  'SELECT job,thread_id,comments_hash,path,head,attempt,state,updated FROM review_feedback ORDER BY updated DESC LIMIT 50;'
sqlite3 -readonly "$DB" \
  'SELECT job,head,state,reason FROM review_targets ORDER BY updated DESC;'
```

`adlc review-status` shows the resulting status, and `adlc tick-review JOB CONFIG`
re-observes the configured PR without adopting or bypassing drift. A successful
CodeRabbit check is still not approval: explicit current-head approval remains
required. Applying this reviewed change to a live installation and recovering
other jobs remain separate operator actions.

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
  "maxUpdates": 3
}
```

The host waits for an idle worker, checks the exact owned same-repository feature
branch and current approval, and pins the expected PR head for the API request.
Conflicts, forks, default-branch heads, exhausted limits, and uncertain outcomes
block automatic updates. Requests are reserved durably before delivery, and the
same head/base pair is never blindly retried. With `maxUpdates: null`, successful updates have no lifetime cap: further base
changes can trigger another update. Any failed or uncertain request still stops
automation for inspection, even if the head later changes. A numeric value from
1 to 10 retains the optional per-job cap. The bundled project example is disabled
with a finite limit of 3; setting `null` explicitly opts into unlimited updates.
After explicit authorization, the wizard defaults to the finite limit of 3.
Typing `unlimited` (case-insensitive) additionally requires a separate default-no
confirmation warning that each update can trigger another CI and CodeRabbit cycle.
Declining that confirmation keeps the finite limit of 3.

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
required checks, even for existing registered PRs.

**Current production limitation:** GitHub check/job responses do not attest which
PR description they evaluated, so production evidence has `descriptionHash: null`.
Configured metadata checks therefore cannot authorize automatic findings or
PR-description remediation, even when the check succeeds. Otherwise-clear checks
wait up to five minutes for body-bound evidence and then block for inspection;
unattested failures block for inspection without sending remediation. This remains
fail-closed until a trustworthy body-bound attestation source is implemented.
An empty `prMetadataChecks` policy skips this additional body-evidence gate; it
does not bypass other required checks or CodeRabbit approval. Clearing the policy
does not clear an outstanding remediation send: its delivery must be reconciled,
and any observed description change still requires a fresh CodeRabbit evaluation.

The remediation flow below requires that future attestation support. In addition
to body evidence, the bridge verifies the failed job’s repository, check-run ID,
and PR head before reading its failure logs. Only a body-bound failure can send
the relevant errors to the existing worker under its current approval and
`open-pr` grant. The worker must use the current repository template, preserve
truthful verification evidence, and make description changes only. It may not
change application code, validators, workflows, or protections to pass the check.

Description edits must produce a check result bound to the current description;
check timestamps or a matching commit/check ID alone are not proof. A repeated old failure
waits up to five minutes rather than immediately consuming another remediation
attempt; a new failed check can be addressed within the configured per-project
remediation budget (five attempts by default). After CI clears, CodeRabbit is reevaluated on the current commit and
description. Delivery uncertainty never causes a blind duplicate send.

Only configured `requiredChecks` and `prMetadataChecks` block CI readiness;
unconfigured failed checks do not block this gate. Failures in configured
application checks, unavailable metadata-check logs, identity mismatches,
out-of-scope work, or exhausted attempts still block for inspection.
No automatic approval, check bypass, merge, or deployment is added.
Log retrieval checks the installed GitHub CLI version and passes `gh api
--allow-escape-sequences` only on version 2.97.0 or newer; older versions omit
that flag. Escape sequences are stripped before selected failure lines reach
the worker.

When GitHub returns old and rerun check results for one commit, the bridge passes
the raw check results through unchanged, without extra provenance REST reads.
The native patch verifies workflow/job provenance but cannot supersede production
attempts: GitHub REST job IDs are attempt-specific
and do not establish a stable logical-job identity across attempts. Distinct job
IDs are therefore retained even for successful reruns of same-name checks. This
can leave readiness blocked or ambiguous for inspection; it cannot hide another
job’s failure during a selective rerun. Identically named checks from different
workflows/events also remain separate. Orchestrator’s
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

## Clarification questions and replies in Linear (DEV-18)

Clarifications reuse the merged DEV-17 readiness/resolution bindings, blocker
publication receipts and guarded same-session continuation. Enable explicitly in
the project configuration after reviewing the exact human account IDs:

```json
"blockerSync": {
  "enabled": true,
  "labelId": "YOUR_NEEDS_HUMAN_LABEL_UUID"
},
"clarifications": {
  "enabled": true,
  "humanIds": ["YOUR_AUTHORIZED_LINEAR_HUMAN_UUID"]
}
```

The needs-human label must differ from `agent-ready`. Enabling replies does not
grant plan approval, Git scope, merge/deployment permissions, or readiness. It
does not install/activate this source version. Live installation and configuration
remain explicit operator actions.

Before asking, the worker must inspect the original ticket, linked issues and
dependencies, and accessible repository context. Its `ADLC_DISCOVERY` receipt
records the specific context checked and why the missing information is essential.
Ordinary implementation choices, facts already supplied and authorized work are
not blockers. The bridge refreshes the ticket/comments, linked-issue inventory and
referenced context, and hashes bounded repository files before publication. Missing
discovery evidence or incomplete API context fails closed without publishing a new
question. Older workers without discovery receipts require inspection, not a blind
restart or another implementation request.

One deduplicated comment on the original issue lists the exact numbered questions,
reason, checked context and issue/job/requirements/plan/round-bound clarification
reference. Reply there, not in Terminal or worker chat. For a single question in
the first round, an ordinary answer is accepted. Multiple questions, dependency
answers and later rounds use the exact IDs and reference shown in the comment:

```text
Clarification DEV-18-REFERENCE_FROM_NOTICE
q1: exact listing identifier
q2: final approved display wording
```

Partial answers are retained durably; acknowledgments list only what remains.
Once all questions and dependencies have answers, a configured human must attest
that the answers resolve them within existing scope by posting the **exact**
confirmation printed in the notice. This can accompany the answers or be a later
comment. Structural parsing is not a semantic oracle: this explicit human
completeness/scope attestation is required before resolution activation. Generic
assent to a factual question and placeholders are not answers. Permission-sensitive
answer text escalates conservatively, even when accompanied by confirmation.

For a material requirement/scope change, use the exact `Replan clarification …`
line shown in the notice. Security decisions and changed dependencies never
silently authorize production exposure, credentials, merge/deployment or expanded
scope. Replanning and applicable human approval are required. Never post secrets.

Bot/app/self-authored, unauthorized, quoted, duplicate, stale and edited comments
cannot release the gate. Edits/removals of accepted evidence before continuation
invalidate the adapter's resolution and require review. Ambiguous or conflicting
answers remain blocked; no answer is guessed. Bounded resolution detail is never
silently truncated.

`adlc status` includes **Waiting for clarification**, partial/confirmed evidence
state and reconciliation reasons. All answer provenance and resolution activation
commit atomically under the current binding, without rewriting the resolution
timestamp on retries. Planning answers still await the existing plan-approval gate.
Their bound resolution is included as untrusted task context in the first approved
implementation prompt. A preflight check before workflow dispatch invalidates
edited or superseded evidence even if plan approval occurred on an earlier poll.
Implementation answers reserve only the existing foundation continuation, after
fresh ticket eligibility, exact approval/scope, branch, ownership and idle/queued
work checks. An answer arriving while a worker is active is retained and waits for
idle; it is not steered into competing work.

Requests and acknowledgments use `LinearBlockers`' existing publication receipts.
Only a tracked bridge-applied needs-human label is removed, with additive/removal
label mutations preserving unrelated human labels and other unresolved blockers.
Uncertain sends or comments reconcile their existing receipts and never replay the
original implementation request, spawn another worker, or resend an uncertain
continuation. Tests cover the real merged foundation with fake provider/session
evidence; they do not exercise live Linear, install code or activate services.

### Legacy exhausted jobs from pre-budget databases

Databases created before per-project remediation budgets have no
`remediation_budget` row for jobs that the older release blocked. The legacy
implementation wrote the exact reason `Remediation limit exhausted` to both the
job and its owned run after five cumulative attempts. `adlc review-status` now
reports those jobs as **Blocked** with a `budget_exhausted` remediation stop
instead of showing **Addressing feedback** or a neutral budget.

Run the normal extension preview with the project configuration and the current
review-target head:

```sh
adlc extend-budget JOB CONFIG HUMAN ADDITIONAL HEAD
```

Before any compatibility bookkeeping, the command requires current plan
approval, an orchestrator-owned run, no uncertain remediation delivery, a
registered review target whose stored head exactly matches `HEAD`, and current
scoped GitHub authorization. A head mismatch fails with the stored and requested
values and instructs the operator to refresh evidence with
`adlc tick-review JOB CONFIG`; it never adopts or bypasses drift.

For a corroborated legacy stop, preview lazily writes a one-time compatibility
mirror to `remediation_budget` and a provenance row to
`remediation_budget_migrations`, plus a
`legacy_remediation_budget_reconciled` audit event. Migration requires the exact
legacy reason on both job and run, at least the old five-attempt limit, matching
plan/approval hashes, an existing owned session/worktree, and retained
remediation history ending at the cumulative attempt count. Arbitrary blocked
reasons, untrusted messages, missing history, or mismatched ownership are never
treated as authorization.

Preview grants no budget and dispatches no worker. If the current policy still
treats the job as exhausted, the returned preview enters the usual extension
flow; confirm the exact `confirmHash` to append the extension. If the current
policy has a higher limit or is uncapped, the legacy five-attempt stop no longer
applies: preview returns `action: "resume_legacy_stop"` with zero additional
budget, and the exact confirmation clears only that legacy job/run stop so the
next poll reevaluates current evidence. A lowered limit still uses the exhausted
path. If policy changes after an exhausted preview, that same migration is
re-evaluated: the provenance row keeps its single identity but its outcome is
updated and a `legacy_remediation_budget_reassessed` event records the prior and
current outcome. In every outcome, `jobs.attempts`, consumed counts, prior
remediation deliveries, Git grants, plan bindings and original audit events are
preserved; the migration row and its initial audit event are created once even
across repeated or overlapping previews.

After confirmation, verify recovery without starting replacement work:

```sh
adlc review-status
adlc status
```

The job must be `approved`, the existing run `running`, and the remediation
budget must show the extension count or, for a superseded stop, the configured
limit with the legacy migration provenance. Then run the normal
`adlc tick-review JOB CONFIG` or poll so the existing session is reevaluated
against the current head. A confirmed budget extension is not a send: an
uncertain or accepted delivery still requires its normal reconciliation. Do not
edit SQLite directly, reset attempts, create another session/PR, or install the
new snapshot automatically; reviewed installation and any live recovery remain
explicit operator actions. No merge or deployment is automatic.

## Existing worker PR recovery

Workers must retain the reserved planning branch. At completed delivery, the
bridge verifies the registered worktree branch/HEAD and PR identity. Drift is
reported as **Blocked — branch mismatch**, with a deduplicated Linear comment
when lifecycle status sync is enabled. A PR title or worker message is not
ownership evidence.

```sh
bun src/cli.ts recover-handoff JOB CONFIG
# Operator only, after reviewing the exact preview:
bun src/cli.ts recover-handoff JOB CONFIG --confirm HASH
bun src/cli.ts tick-review JOB CONFIG
```

Recovery defaults to a read-only database connection and does not run intake,
refresh approval, post Linear comments, or claim a PR. It requires current
approval and scope, completed original delivery, idle AO activity/controller
with no queued turns, a clean registered isolated worktree, reserved-branch
ancestry, exact GitHub repository/feature ref/HEAD, and no conflicting active
owner. Missing or truncated evidence fails closed; inspect the stated blocker
rather than editing identity records. A stale eligibility snapshot requires
normal authorized coordination, not a recovery-command bypass.

Confirmation re-reads evidence and rejects changed proposals. It reserves a
durable claim intent before using AO's supported `claim-pr --no-takeover`.
Lost receipts reconcile authoritative attachment; an uncertain unattached claim
is never replayed automatically. Adoption stores a distinct delivery identity,
preserving reservation rows, audit history, and remediation/update budgets.
Normal polling registers the existing PR after successful adoption; no worker
is restarted and implementation is never resent. Manual review now requires
CONFIG and uses the same branch policy and identity checks as periodic review.

The bridge does not rename/delete branches or add native AO cleanup/resume
operations. Run reconciliation cannot replace an adopted session/worktree.
Native reservation metadata stays unchanged. Human merges remain mandatory;
there is no auto-merge or deployment. DEV-30/#7 validation for DEV-31 is preview
only; any live adoption is a separate operator action after reviewed installation.

### Project coordinator setup

The setup hook admits a project coordinator only after matching the native AO
project/session registry, the canonical coordinator workspace, and the source
repository's Git common directory. Ticket workers still require a durable ADLC
planning reservation; a branch name or environment role flag does not grant access.

This integration currently reads the default local AO registry at `~/.ao/data/ao.db`
in read-only mode and recognizes AO's managed coordinator layout
`worktrees/<project>/orchestrator/<sessionPrefix>-orchestrator` (the prefix defaults
to the first 12 characters of the project ID). A custom AO data directory or a
changed native schema/layout is unsupported: it never admits a coordinator, and a
registry that is absent, unreadable or unsupported falls through to the reservation
gate so a reserved ticket worker is still evaluated. The registry must
contain exactly one non-terminated coordinator for the project. During initial
setup its stored workspace may be empty, so the native coordinator-only layout
and shared Git directory establish workspace identity. This admits coordinator
startup; it does not approve a ticket plan, merge a PR, or activate a new runtime.

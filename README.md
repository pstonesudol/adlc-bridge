# ADLC Bridge

### Planning dependency observation

Dependency bindings may opt into `stage: "planning"` (omitted stage retains
the approved-worker continuation path). A planning binding uses the existing
`dependencyRecovery.enabled`, `baseBranch`, `jobs[].issue`, `planHash`,
`specHash`, and exact prerequisite repository/PR/capability SHA-256 fields.
It additionally requires `project` equal to the configured Linear project,
`contractReview: {"actor": "named reviewer", "compatibility": "why this exact
captured plan remains valid against the pinned interfaces"}`, and a reviewed
`headSha` for each prerequisite PR. Configuration is operator-controlled, never
inferred from ticket comments. Do not put literal placeholder values into live
configuration.

Pin an in-development PR only after reviewing its interface contract and the
existing plan. The observer waits for that exact head to merge into the exact
base and checks the pinned capability contents there. Any head or capability
change fails closed: review it and explicitly update configuration, or use the
existing same-session replanning flow with fresh approval if the plan changes.
Hashes are never learned or silently rewritten by polling. Host-runtime
prerequisites remain unsupported without authoritative installation proof;
source merge is not runtime activation.

`dependency-preview JOB CONFIG` inspects planning evidence without requiring a
run or implementation grant. `dependency-resume JOB CONFIG HASH` records only
the verified planning resolution; normal workflow polling evaluates current
approval policy and eligibility. `dependency-status` exposes `planningWaits`
separately from implementation waits. Missing configuration reports a wait,
not a promise of auto-resume. `plan-approval-required` still requires explicit
current human approval. Original plan text, receipt, and reservation are kept.

Observation never fetches, switches, merges, or updates the planning worktree.
If implementation needs source synchronization that its real scoped grant
does not allow, an operator must reconcile under separate authorization; no
grant is fabricated to make progress. Changed plan/spec/config/base evidence
between approval and delivery blocks delivery for reconciliation. Accepted or
uncertain implementation delivery is owned by the existing dispatcher and is
never resent by this observer. Runtime installation and PR merging remain
separate human actions.

## Configuration-driven verification and setup (v1)

Project JSON keeps repository/Linear mappings, approval and routing policies, and
an optional `verification` object. Machine JSON is separate: copy
`config/runtime.example.json` to an ignored local file and replace every path
and tool version. Supported service platform is macOS launchd only. Examples
are templates, not installable configurations. The default test suite and routing
previews do not require package installation. OpenCode classification and new
installed snapshots require the pinned project dependencies; see setup below.

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
Installation preview/apply refuses controller-derived directories with a relative
project-config argument or relative `ADLC_DB` / `ADLC_VERIFICATION_RUNTIME_CONFIG`
values before creating snapshots,
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

Local-first coordination between Linear, Agent Orchestrator, ADLC-owned routing,
GitHub CI, and CodeRabbit. Coding runs locally in isolated Orchestrator worktrees.
Docker is used for supported verification, not for coding or the controller.

The bridge picks up eligible tickets, plans and implements under the configured
authorization, opens feature PRs, and coordinates bounded CodeRabbit remediation.
**PR merges require a human. The bridge never merges, enables auto-merge, or deploys.**
Your repository's own workflows may independently deploy when a human merges.

## Daily use on the configured Mac

```sh
adlc start --all     # start managed Orchestrator, then all project intake services
adlc stop --all      # PREVIEW full shutdown; does not stop anything yet
adlc status --all    # backend, intake, owned workers, shared sessions, child processes
adlc services stop PROJECT              # pause this project's intake only
adlc services stop --all --pause         # pause all intake; keep workers/backend
adlc services stop --all --drain --timeout 120 --json
# Review the returned confirm hash, then repeat the exact scope/mode/timeout:
adlc services stop --all --drain --timeout 120 --apply --confirm HASH --json
adlc services start PROJECT             # re-enable only this project's intake
adlc services restart PROJECT --drain   # PREVIEW; apply with returned hash
adlc services stop PROJECT --workers    # PREVIEW explicit worker interruption
```

Full-stack controls require a registered, hash-pinned Orchestrator background
service on this Mac. They use the owner-only
`~/Library/Application Support/ADLC Bridge/orchestrator-runtime.json` registration
(`executable`, `sha256`, `serviceLabel`, `launcher`) and the matching installed
LaunchAgent. They preserve unrelated Orchestrator installations and services.

Grouped `services start|stop|restart|status` accepts `PROJECT`, `--project PROJECT`,
or explicit `--all`. Flat `start`, `stop`, `restart`, and `status --all` are aliases;
flat `status --project PROJECT` retains its existing **job-status** meaning.
Use `services status --project PROJECT` for lifecycle status. `service-status`
retains its legacy intake-only inspection (including all projects without an ID).
Without a scope, lifecycle commands select only an unambiguous registered project.

**Stop modes:** project stop defaults to intake-only pause. `--pause` explicitly
keeps workers and backend running, including with `--all`, and works even when
worker APIs are unavailable. `--drain` stops new coordination, waits for already
queued/active native turns, then exits verified owned agents in place. Drain does
not run further coordination stages, issue new turns, approve work, or wait for
an entire multi-stage ticket to finish. `--workers` explicitly interrupts owned
agents through AO's session-preserving `exit-agent` API. Never use session kill,
worktree cleanup, process-name matching, or replacement sessions to restart work.
Full `stop --all` without a mode refuses busy/queued/unknown workers and exits
only verified idle owned agents before stopping the managed backend.

Full shutdown, drain, explicit worker stop, and restart are **preview-only** until
`--apply --confirm HASH`. A confirmation binds action, scope, mode, persistence,
timeout and the observed session identities/ownership and native turn IDs. Existing
turns may finish during drain; newly queued work requires a fresh preview. If these change, preview
again. `--preview` is available for non-disruptive start/pause too. The default
timeout is 30 seconds; `--timeout` accepts 1–3600. Timeout or partial failure reports
remaining observed resources and exits nonzero, without escalating to force-kill.
An uncertain exit acknowledgement requires inspection of the original session.

All-stack stop defaults to persistent disable-at-login; `start --all` re-enables
the requested managed stack. Project stop defaults to unloading this login only;
`--disable-login` explicitly persists its launchd disable. `--temporary` suppresses
launchd disable, so installed RunAtLoad/KeepAlive definitions may load next login.
Durable intake pause markers still block bridge polls until explicit start; login
or an app window is not authorization to dispatch. No plist is moved or deleted.
The same project pause blocks explicit `ingest`, `dependency-resume`,
`feature-start`/`feature-step`, `tick-review`, and new `spec-reconcile` replanning
turns under the submission fence. Read-only inspection and receipt-only recovery
remain available; a manual submission command does not implicitly restart intake.
Starting one project checks backend readiness first (starting the registered
managed dependency only when needed). After an all-stack stop it retains durable
pause markers for every other project before releasing the global fence; it does
not re-enable their services or resume their workers.

Every bridge-owned session creation and turn delivery shares an inter-process
barrier with shutdown. Planning, implementation and feature-agent reservations
stay inside that same barrier through submission; rejected acquisition leaves
requests pending rather than falsely recording an uncertain delivery.
Stop holds it from intake unload and the final inventory scan through
backend shutdown and leaves submissions paused until a successful `start --all`.
A delivery already holding it refuses ordinary shutdown before unloading any
intake service, instead of interrupting the send. Drain can wait within its timeout
for that fence to settle, never breaking or deleting a held lock.
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

These commands control background services, not desktop windows. Closing a window
does not stop agents/services or prove memory release; stopping intake alone
releases only its poll process. Exiting agents can release their controller memory;
backend shutdown can release daemon memory. UI memory, unrelated apps, detached
processes and OS caches remain outside that guarantee. The window may stay open;
run `start --all` before reopening it when the stack is off.

Status is read-only and separates intake services, owned workers, shared/external
sessions, and observed daemon descendants (PID plus process start time). It never
claims that every process on the Mac is off. Missing/unreadable native inventory
is **unknown**, not an empty worker list. A stopped/crashed daemon cannot attest
current session/child state, so status may return incomplete evidence even when
launchd reports unloaded. Backend shutdown refuses live unowned/shared sessions,
including idle sessions. Project scope never stops the shared backend.

Stop and status validate project/registry/controller/service identity without
requiring valid execution-policy settings. Unsupported branch-update limits or
newer runtime options cannot prevent safe pause/diagnosis; malformed JSON, changed
identity and altered service definitions still fail closed. Start uses full
configuration validation and verifies poll startup acknowledgements.

Restart stops the selected scope then starts dependencies before intake; it is
not a reset/retry operation. Worktrees (including uncommitted changes), durable
queue, session history, approvals, delivery receipts and attempt history survive.
Exited/interrupted workers are **not automatically resumed**: inspect the existing
session and use the approved job recovery/resume workflow after current scope and
receipt reconciliation. No lifecycle command resends a prompt or creates a worker.
A partial start leaves global intake paused and reports the successful steps;
fix the reported problem, inspect status, then explicitly retry start.

Live macOS shutdown/start integration must be validated by a separately authorized
operator using disposable managed sessions/services. Mocked launchd tests do not
prove live compatibility and no existing live session may be interrupted by a
coding worker. The existing commands below retain their project and queue meanings:

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

**Project stop without a worker mode does not stop existing Orchestrator workers**,
close Orchestrator, or disable a repository's GitHub workflows. Use the previewed
`--drain` or explicit `--workers` workflow when worker exit is intended, and
`--disable-login` rather than moving installed service definitions.

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
- For routing: an ADLC routing document and an available Orchestrator OpenCode 2 harness.
- Optionally, for classification: an authorized OpenCode classifier model and a
  compatible running OpenCode V2 service.
- Docker Desktop when using Docker verification. Project verification also needs
  the tools and configuration required by that repository.

Place this source folder at `~/Code/adlc-bridge`, or adjust the paths below.
Install the pinned project dependencies before enabling classification or preparing
an installed snapshot. This is a local source-checkout operation, not a global
install or runtime activation:

```sh
cd "$HOME/Code/adlc-bridge"
bun install --ignore-scripts --linker hoisted
bun test
bun test ./test/routing-client.integration.ts
bun src/cli.ts help
```

New snapshots include only the pinned OpenCode client runtime packages, their
`dist` files, manifests and licenses—not arbitrary `node_modules`, provider
credentials or development configuration. Those bytes participate in the snapshot
hash and are imported with Bun auto-install disabled before publication/activation.
Missing, mismatched, symlinked or unloadable dependencies abort preparation and
leave the active installation unchanged. Routing never downloads packages on
first use; a source checkout without the client uses the configured failure
fallback. Source dependency changes do not activate installed snapshots.

The adapters use the installed Orchestrator API and OpenCode's supported client/service API, not OpenChamber runtime modules.
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
providers used by the worker harness in Orchestrator. The local OpenCode service and Orchestrator
can have separate login stores; working classifier inference does not prove that
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
| `routing` | ADLC routing `configFile`, optional `overridesFile`, and `opencode-v2` harness; see [routing setup](OPENCHAMBER-ROUTING.md) |
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

For ADLC-owned routing, configure `routing.configFile` and set
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

#### Integration enablement and upgrade readiness

`adlc init REPO --preview --config CONFIG`, `adlc doctor CONFIG`, setup previews,
PR readiness, and update previews include an integration matrix for blocker
publication, clarification publication and clarification reply consumption.
Implemented, configured, enabled, reachable, validated and unavailable are
separate fields. Unknown evidence is not success; installing code does not prove
an integration operational. Legacy configurations remain optional and visibly
degraded; no feature is silently enabled.

Run `adlc doctor CONFIG --verify-integrations` to make **read-only** provider
requests validating project/team membership, the distinct needs-human label and
active non-app authorized-human UUIDs. Incomplete inventories and credential
failures never count as validation. This command does not publish a probe or
prove comment/label mutation permissions. Publication probes require separate
explicit operator authorization; no live publication probe is automatically run
by init, doctor, upgrades, dispatch or tests.

To explicitly require a capability, configure `integrationPolicy.required` with
any of `blockerPublication`, `clarificationPublication`, `clarificationReplies`.
Required capabilities fail closed before planning, implementation or continuation
dispatch when validation is missing; observation/reconciliation remains available.
**Current limitation:** provider mutation/reply permission verification is unknown
without independent live evidence. Required capabilities therefore remain paused;
do not opt into required mode expecting configuration alone to unlock dispatch.
Doctor gives the missing prerequisites and operator action rather than claiming
that a configured integration is operational.

Repair output is a field-level **preview only**, not an apply command. Back up the
original config, retain unknown fields and existing backups, review the proposed
disabled sections, supply verified local mappings and explicitly authorize any
enablement. Never copy credentials. Upgrade previews compare integration source
fingerprints with the installed snapshot and recheck configuration before activation.
Repairs and runtime installation remain separate operator actions; existing
upgrade/rollback lifecycle and human-only merge/no-deployment rules are unchanged.

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
| Provider request fails | Login in the actual worker harness; classifier service credentials may be separate |
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

### Safe runtime updates (DEV-51)

#### Read-only update history

```sh
adlc update history
adlc update history --project PROJECT --json
adlc update history --help
```

History reads the existing owner-only `update-intent.json` without creating state,
querying providers/services, or executing activation/recovery. JSON has a stable
`version: 1` envelope, `history`, `reason`, `scope`, `nextCommands` and `entries`.
Entries include attempt identity, exact known commit/snapshot hashes, timestamps,
transitions, outcome, deferred/failure category, restart/migration/health evidence
and recorded rollback compatibility. Text uses the same redacted projection.
Raw errors, configuration, service definitions and paths are deliberately omitted;
inspect protected local evidence separately when needed.

New apply/rollback attempts retain prior attempts and transitions in that same
intent file (no independent ledger). Preflight verification failures are recorded;
failures before a candidate can be verified/reserved may have no attempt record.
Inspection never upgrades legacy records. Missing/overwritten legacy history and
interrupted effects are **unknown**, not synthesized success. Snapshot installation
and a successful readiness check do not prove which bridge/backend identities are
actually running. Migration compatibility evidence does not prove migration execution.
Health refers to the existing readiness/service checks, not an end-to-end activation.

`--project` annotates observed project membership but never hides shared-runtime
operations or their cross-project impact. Legacy project scope can be unknown.
Recorded rollback compatibility is **not current authorization**: snapshot presence,
database changes, quiescence and reattachment must be rechecked by the explicit
`adlc update-rollback` command. History only suggests `adlc update-status` and
`adlc update-preview`; preview stages/verifies but does not activate. Neither is
executed by history. Interrupted/ambiguous records require explicit operator recovery.
Retained evidence is not silently pruned and the intent file can grow over time.
Separately authorized controlled end-to-end activation is still required before
claiming unattended updates are supported.

Updates are manual by default. A policy pins an authenticated GitHub remote and
an authoritative branch or immutable release; ticket, PR or comment text never
supplies executable instructions.

```json
{
  "version": 1,
  "repository": "pstonesudol/adlc-bridge",
  "remote": "git@github.com:pstonesudol/adlc-bridge.git",
  "ref": "main",
  "refKind": "branch",
  "cadenceSeconds": 3600,
  "mode": "manual",
  "verification": {
    "requiredChecks": ["CI"],
    "allowCandidateTests": false
  },
  "maintenance": { "blockIntakeDuringActivation": true }
}
```

```sh
adlc update-config ./update-policy.json          # validate only
adlc update-config ./update-policy.json --apply  # write owner-only policy
adlc update-status                               # source, installed and running identities
adlc update-check                                # resolve the exact candidate commit
adlc update-preview                              # stage and verify; no install or restart
adlc update-apply                                # guarded activation when idle
adlc update-rollback                             # restore the prior compatible snapshot
```

`update-preview` fetches into an isolated checkout under
`~/Library/Application Support/ADLC Bridge/updates/work`. It never stashes,
resets or switches a developer checkout or worker worktree. It pins the commit,
verifies required GitHub checks for that exact commit, checks package and bridge
entrypoint compatibility, and classifies the change:

- `hot`: bridge code only; the backend stays running.
- `backend`: native launcher or scripts changed; a supported graceful backend
  restart is required.
- `schema`: migration or patch changed; explicit compatible migration and
  restore evidence is required or the update fails closed.

Candidate test execution is disabled unless `allowCandidateTests` is explicitly
enabled; required checks remain authoritative. Missing, pending or unsuccessful
checks block activation. Schema changes without compatible migration evidence
never activate.

`update-apply` acquires the shared submission fence, records a durable intent,
stops previously loaded intake, and re-checks authoritative worker activity.
The control scope remains exclusive through activation, recovery and verification;
concurrent stack starts cannot remove its pause. An existing operator pause is
preserved and refuses apply/rollback until explicit operator reconciliation.
Active turns, queued turns, uncertain delivery, pending mutations or unknown
activity defer the update, restore the prior intake, and notify `waiting for
idle`. Unknown activity is treated as busy. Backend or schema activation also
requires authoritative controller-reattachment evidence; without it the update
defers. An idle attached controller is never assumed reconnectable and is not
restarted. After activation, the CLI verifies backend readiness and every
previously enabled project service. The prior loaded/disabled state is restored
exactly.

A failure restores the previous verified snapshot and services when rollback is
safe. If a schema migration is not reversible, or the database changed after
activation, rollback is refused: intake remains paused where required, backups
and the durable intent are preserved, and the error names the recovery steps.
A hot update that migrates the native launcher reports `restartRequired`; it
does not claim the backend restarted. Use the guarded full-stack controls to
activate that launcher migration.
Interrupted intents, held update locks and ambiguous concurrent attempts must be
inspected manually; they are never retried automatically. Notifications are
deduplicated in `update-notifications.json`.

Automatic cadence is opt-in only (`"mode": "automatic"` plus a separately
invoked `adlc update-auto`). Creating the policy or this section schedules
nothing. Unattended adoption is **not claimed as supported** until an operator
authorizes and completes a controlled end-to-end activation. Native Orchestrator
backend upgrades remain explicit, versioned and trust-verified through
`install-runtime`; bridge updates do not silently replace vendor binaries and
never merge PRs, deploy managed applications or expand permissions.

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

The bridge requests `@coderabbitai review` (regular/incremental review) after a
completed remediation batch and clear required CI, not after each individual fix.
Normal scheduling retains the five-minute stable-head grace period. With automatic
incremental review enabled it waits for the provider instead of posting a command.
`reviews.auto_review.auto_incremental_review: false` disables triggering on every
push, not explicit regular-review commands. Repository exclusions, opt-outs and
intentional pauses remain respected; the bridge does not resume reviews itself.

CodeRabbit's [command guide](https://docs.coderabbit.ai/guides/commands) and
[configuration reference](https://docs.coderabbit.ai/reference/configuration)
(verified 2026-11-07) distinguish incremental `review` (changes since the last
review) from `full review` (all PR changes from scratch). Whole-PR reassessment is
reserved for an explicit operator comment `@coderabbitai full review`; there is
no automatic full-review fallback, including for description-only remediation.
A regular review may skip an already-reviewed SHA or description-only edit. If
it produces no fresh body/custom-check evidence, coordination waits then blocks
for inspection rather than weakening freshness requirements or escalating silently.

Requests share a durable repository/PR/head budget across jobs, modes, restarts
and concurrent polls. Accepted or uncertain legacy full requests still consume
that budget; changing commands does not replay them. Only confirmed throttling
allows bounded retries after cooldown (at most three attempts). Mode is recorded
per request/attempt, not added to its deduplication key. The historical
`full_review_requests` table remains a compatibility/body-obligation ledger, not
a selector of full-review mode. Old shared receipts migrate as `full`; new sends
are `regular`. Markers remain stable and uncertain replies reconcile only against
the exact recorded command, marker and send time, never trigger a resend.

`adlc review-status`/`status` expose `reviewRequest.mode`; review-state reasons
carried into CLI/Linear notices name the requested mode and limitations. Neither
a successful command nor a green check is approval: current-head approval and
fresh body/custom-check clearance remain required. No empty commits, approval
commands, check overrides, or merges are used.

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

## Project polling and planning capacity

Project JSON supports `"pollingIntervalSeconds": 60` at the top level and
`"automation": { "maxPlanning": 1 }` alongside the other automation fields.
Omitted values retain defaults of 60 seconds and one planning stage. Polling must
be an integer from **5 to 86400 seconds**; maxPlanning must be an integer from
**1 to 32**. Invalid values are rejected, never silently clamped. Setup prompts
for both values; the static service example represents the default interval.
Staged `setup` definitions also honor an explicit project polling interval. When
it is omitted, staged setup retains the runtime configuration’s service interval;
initial wizard generation and `serve` retain their 60-second default. Verification
runtime references, pinned tools, controller bindings and unrelated service keys
are preserved.

Intake durably records all eligible tickets before dispatch, independently of
available slots. Overflow stays queued. Reservations are made transactionally
across polls/restarts, including uncertain dispatches and reconciliation blockers;
these consume slots and are never blindly retried. Lowering a limit stops further
starts until capacity becomes available, without terminating existing workers.
`maxPlanning` limits ticket planning stages only, not implementation/review workers
or the separate feature-planning agent pool. It grants no execution authorization:
approval gates, scoped Git permissions, human-only merges and no deployment remain.

After editing a project's JSON, preview and explicitly apply its service interval:

```sh
adlc service-config PROJECT_ID
adlc service-config PROJECT_ID --apply
adlc service-status PROJECT_ID
```

Preview makes no service changes. Apply validates project identity and changes
only StartInterval in the existing definition, preserving arguments, environment,
logs and unrelated keys; other projects are untouched. An already-loaded service
requires verified intake quiescence under the submission fence before changing its
definition or unloading. It is reloaded even if the definition already matches, allowing a failed unload to be
retried (and can immediately pick up authorized work); a stopped service stays
stopped. Existing worker sessions are not terminated. If `bootout` fails, inspect
`service-status PROJECT_ID` and retry `service-config PROJECT_ID --apply` after
resolving the error; the service can still be loaded with its previous interval.
If `bootstrap` or poll startup fails after unload, inspect `service-status PROJECT_ID`
and use `start PROJECT_ID` after resolving the error. Status reports
effective configured settings and the installed definition interval; a loaded
service needs apply/reload after interval changes. maxPlanning changes are read
on the next launched poll, without service regeneration. `serve CONFIG` snapshots
settings at startup: restart it after edits. Its ticks are sequential, sleeping
the configured interval after each tick; launchd schedules approximately at the
configured interval and does not run concurrent instances of the same service.

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

## Bounded required-CI failure evidence

Required-CI diagnosis streams job logs instead of rejecting every log over
128 KiB. It retains failure summaries and nearby context (including Bun test
file headers), rather than a tail-only sample or incidental `Error` text from
passing fixtures. The collector limits log stdout to 4 MiB, excerpts to 64 KiB,
lines to 8,192 characters, and failure contexts to 64. Version/metadata reads
and stderr each retain the existing 128 KiB cap. One diagnosis has a shared
30-second deadline; timed-out or over-budget subprocesses are killed and reaped.

Repository/run/job/check/head, run attempt and failed-step numbers are bound
before diagnosis and revalidated before dispatch. Raw excerpts and test/error
prose stay ephemeral: persisted findings contain validated paths, provenance and
omission/byte metadata, plus the job link for inspecting exact test/error context.
Invalid UTF-8, binary/archive or unsupported control data, giant lines, truncated
failure summaries, unavailable logs and exhausted budgets fail closed with an
inspection reason. This is not a generic archive decoder or unlimited log viewer.
Only sufficient in-scope evidence enters the existing authorized same-worker
remediation path; collecting evidence does not reserve a remediation attempt.

## Automatic PR-template CI remediation

Configure exact GitHub Actions job names in `prMetadataChecks` for checks whose
failures may be fixed by editing only a PR description, for example:

```json
"prMetadataChecks": ["PR body structure"]
```

The wizard can collect these names. They are added to the readiness gate as
required checks, even for existing registered PRs.

GitHub check/job responses alone do not attest which description they evaluated.
The bridge accepts an `ADLC_METADATA_V1` JSON record only from logs fetched from
a verified, completed `pull_request_target` job. It cross-checks repository, PR,
head SHA, workflow path, run ID/attempt, check suite, job/check-run URL, check name
and result against GitHub API records. The workflow source at the run's PR base
SHA must exactly match the bundled producer template; customized or unverifiable
workflows cannot authorize evidence. The record's SHA-256 description hash must
match the exact current UTF-8 body, without whitespace or newline normalization.
Missing, ambiguous, malformed, mismatched or unavailable evidence fails closed.
Otherwise-clear checks wait up to five minutes for body-bound evidence and then
block for inspection; unattested failures cannot send remediation.

`patches/pr-body-attestation.yml` is an **operator-reviewed rollout template**, not
an active bridge workflow. In a repository already using `scripts/pr-body.mjs`,
replace its existing PR-body workflow with this template through normal review,
on the default branch. Retain the existing validator and validation semantics.
The template executes only the base snapshot (`github.sha`), uses read-only
permissions, reads event metadata as JSON, emits the exact event-body hash after
validation, and preserves validation failures. Never check out PR code, interpolate
PR text into executable source, or add PR-controlled commands to this trusted job.
Base-branch workflow maintainers are part of the evidence trust boundary. The
consumer trusts GitHub's `pull_request_target` provenance, not arbitrary log URLs,
check output or PR-provided attestations. Other validators require a separately
reviewed producer adaptation retaining these invariants.

Description-only edits trigger the template via `edited`. Authenticated results
for different body hashes are excluded from current readiness evaluation; unknown
results and same-body duplicate checks remain ambiguous and block. Legacy checks
without attestations may therefore still require operator inspection during rollout.
The bridge does not install workflows, modify rulesets or activate runtime snapshots.
An empty `prMetadataChecks` policy skips this additional body-evidence gate; it
does not bypass other required checks or CodeRabbit approval. Clearing the policy
does not clear an outstanding remediation send: its delivery must be reconciled,
and any observed description change still requires a fresh CodeRabbit evaluation.

In addition to body evidence, the bridge verifies the failed job’s repository,
check-run ID and PR head before reading its failure logs. Only a body-bound failure can send
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

When GitHub returns old and rerun check results for one commit, the bridge keeps
raw results unchanged except for the authenticated older-description exclusion
described above. Configured metadata checks require additional provenance reads.
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

### CodeRabbit custom Verification Evidence failures

A successful CodeRabbit check is not approval. Readiness also collects the full
bot-authored pre-merge summary, independently of inline threads. A failing
**Verification Evidence** row can become a description-only finding for the
existing approved worker. Optional warnings and older `NEEDS_EVIDENCE` prose in
the walkthrough do not become failures when the pre-merge row passes.

The collector requires the reserved bot identity, the exact PR and head in the
summary's recent-run section, a current bot change request, and one unambiguous
completed CodeRabbit run. The summary update and review must fall within that
run. GitHub GraphQL supplies the actual description and `lastEditedAt`; that
description must have existed unchanged throughout the run and still match the
observed REST body/head. Full Explanation and Resolution details are preserved,
not silently truncated. Missing details, ambiguous runs, stale summaries or
post-review edits fail closed with a concrete blocker. Unknown custom errors
are not automatically treated as permission to change code.

This establishes **relevance for remediation**, not a GitHub CI attestation.
It never manufactures `metadataCheckEvidence.descriptionHash`, overrides a
configured metadata check, or replaces explicit current-head CodeRabbit approval.
Unsupported provider formats require inspection; the parser deliberately does
not guess provenance. Read-only `adlc readiness OWNER/REPO PR CONFIG` previews
the collector without sending remediation or requesting a review.
For closed historical PRs, `bun scripts/preview-coderabbit.ts OWNER/REPO PR`
previews only custom-check evidence; it explicitly does not evaluate readiness.

The worker first inspects existing session artifacts and current-head CI. Any
additional checks use the merged project `verification` configuration (host or
container as configured), with actual commands, working directory/runtime,
tested SHA, exit codes, browser surface/mocks and limitations. Historical checks
remain historical; not-run evidence is not a substitute for a valid requirement.
Description-only work cannot edit application files, commit or push. Mixed code
findings still require approved paths and the corresponding Git grants.

If verification prerequisites are unavailable, the delivered remediation turn
reports the existing `ADLC_WORKER_STATUS` and truthful `ADLC_DISCOVERY` receipts.
An already attached PR does not hide that blocker. Enabled Linear clarification
sync publishes the question and uses its existing human-answer, scope-confirmation
and guarded-continuation machinery. Only the exact owned PR and reconciled
remediation attempt may continue; this does not grant new permissions or reset
the attempt budget. Unparseable provider evidence instead uses the existing
deduplicated blocker publisher for human inspection. These surfaces require the
project's configured blocker/clarification settings; disabled settings do not
authorize unsolicited Linear changes.

A delivered description edit retains a durable fresh-review obligation. Full
review requests use the existing uncertainty reservation and, for custom-check
remediation, the GitHub description edit version as well as its content hash.
Concurrent polls, restarts and lost replies never blindly replay a request.
Old evidence cannot clear the edited description; returning to earlier text is
still a new edit version. Existing body-bound metadata-check gates remain intact.
No check weakening, review dismissal, automatic approval, merging or deployment
is added.

### Budget configuration

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
continuation. A continuation whose own transcript turn failed, was cancelled or
was interrupted remains a durable failed state. A later completed remediation
turn cannot turn that failure into a PR handoff, and another clarification answer
cannot resume it. Recovery requires the existing explicit `recover-handoff`
delivery adoption plus a confirmation made after that failure. Confirmation
records recovery against that specific continuation, and only an `adopted` record
matching the same job, plan, requirements, session, repository, PR, worktree
branch and exact current head settles it. An adoption that predates a later
failure has no such record and cannot recover it; that dispatch repairs only the
guarded `failed` or masked `needs_reconciliation` state to handoff. Once settled,
the continuation remains recovered across later legitimate head changes, while
handoff still requires the exact attached PR and current local/remote head
agreement. Until then, workflow handoff and review
dispatch remain blocked with a concrete reconciliation reason; review settlement
re-reads the adopted evidence and never repairs or fabricates it. Tests cover the real merged foundation with
fake provider/session evidence; they do not exercise live Linear, install code or
activate services.

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

### Opt-in base-conflict recovery (DEV-50)

Conflict-free GitHub Update branch keeps its existing `branchUpdate` policy.
Confirmed conflicts may instead use this **separate, disabled-by-default** policy:

```json
{
  "conflictRecovery": {
    "version": 1,
    "enabled": true,
    "authorizedBy": "named authorizing operator",
    "baseBranch": "main",
    "maxRecoveries": 3,
    "verification": [["bun", "test"]]
  }
}
```

Verification is an explicit ordered list of argv arrays, not inferred shell
commands. Each runs in the registered worktree with a ten-minute timeout; the
first failure stops publication. Configure the project's approved Docker
verification command here when appropriate. Both automatic and manual verification
use only `PATH`, temporary-directory variables (`TMPDIR`, `TMP`, `TEMP`), `LANG`,
`LC_ALL`, `TZ` and `CI` from the host environment. Host tokens, `HOME`, Git context,
credential variables, and arbitrary tool configuration are not inherited, even
for a configured verification command named `git`. Internal Git operations use a
separate environment for authentication. Tools requiring additional environment
must fail closed rather than receiving host secrets. This is environment isolation,
not filesystem/network containment: supervised-host code still runs as the same
OS user. Use an approved container workflow for stronger isolation. This bridge's full suite uses the
supported macOS host runtime, as in its CI. Verification output tails and exit
codes are retained with the recovery, so do not configure commands that print
secrets. Configuration is operator-trusted execution input, not reviewer text.

Policy alone grants **no Git authority**. Every attempt requires current unchanged
job/plan approval, applicable scope, an existing registered delivery/run and PR
handoff, and current grants for `inspect`, `fetch`, `branch`, `commit`,
`push-feature`, `open-pr`, and **`merge-base-feature`**. Existing grants and standing
policies are never migrated or expanded automatically. An operator can explicitly
add the narrowly defined base-into-feature grant to a current approved job:

```sh
adlc authorize-base-merge JOB CURRENT_PLAN_HASH HUMAN
adlc recovery-preview JOB CONFIG
adlc recovery-status
```

The grant does not permit PR merges, default-branch pushes, rebases, force-pushes,
resets, deployments or history rewrites. Normal polling and `tick-review` use the
same policy. Preview uses a read-only database and neither reserves nor sends.
Enabling policy or granting authority to live jobs is a separately authorized
operator action; shipping this code does neither.

Recovery requires the configured repository/base, a clean isolated registered
worktree at the exact remote feature head, one verified owning AO session, idle
activity/controller, no queued turns, and no uncertain branch update, remediation,
implementation or continuation. Local divergence, pre-existing merge/rebase or
sequencer operations, changed scope/approval/head/base, or ambiguous ownership
block without discarding work. Standing approval freshness is checked again
after verification; expired eligibility must be refreshed by normal coordination,
never bypassed by recovery.

The host reserves one durable intent bound to job, plan, PR and both input SHAs.
It fetches exact refs, retains immutable `refs/adlc/conflict/<intent>/head` and
`.../base` backups, and merges the base into the existing feature branch without
committing. Only ordinary three-stage regular-text conflicts inside approved
paths are sent to the **existing worker** through the existing turn-submission
transport and stable client receipt. Binary, rename, add/delete, type/symlink,
protected-path and out-of-scope conflicts require an operator. The worker must
preserve both feature intent and base safeguards, and stop with exact files and
questions for product/security/scope ambiguity; blindly selecting ours/theirs is
not allowed. It edits only conflict files and does not stage, commit or push.

After the completed receipt, the host rejects changes to non-conflict content,
untracked/unstaged edits and conflict markers, stages only the approved conflict
files, runs verification, checks the unchanged verified tree and exact merge
parents, then normal-pushes only the owned feature ref after fresh ownership and
remote head/base checks. No force option is used. The new SHA returns to fresh
latest-SHA CI/CodeRabbit gates; earlier clearance is not reused.

#### Reservation boundary and manual reconciliation

The durable reservation is honored by bridge planning delivery, implementation,
continuations, review remediation, branch updates, delivery adoption and lifecycle
reconciliation. The disconnected lifecycle dispatch contract requires a verified
worktree before starting transport, persists that binding, and rejects a receipt
for a different tree. Reservation checks include planning and active-run paths.
It is not a native AO lock: **arbitrary human/native AO writers
can still race the bridge**. Activity and ownership are rechecked, but this is
not atomic native exclusivity. Operators must not concurrently edit/send into a
reserved worktree. Unexpected activity or changed evidence fails closed. The
bridge does not claim protection against an external writer that evades those
observations. Use native exclusive execution only if a separately verified
native capability becomes available; none is assumed here.

Reservations have no timeout/lease-stealing escape. Each recovery consumes one
existing remediation-budget reservation, additionally bounded by `maxRecoveries`
(1–10); waiting and receipt reconciliation consume none. Existing no-progress
limits and audit history remain intact. Missing/uncertain resolution receipts
never resend. A proven successful push with a lost reply is observed on the next
tick without another push. Interrupted fetch/merge/stage/verification/commit,
rejected push, decision blockers, and unprovable results preserve work and stop
for operator reconciliation rather than replaying a mutation. These conservative
stops are intentional, not automatic reset/retry opportunities.

Inspect `recovery-status` for the exact stage, conflict paths, input SHAs,
verification evidence and reason. After separately authorized manual repair and
normal publication of the exact two-parent merge, an operator can preview and
confirm its completion:

```sh
adlc reconcile-conflict JOB CONFIG
adlc reconcile-conflict JOB CONFIG --confirm HASH --human NAME
```

Confirmation verifies the same approval/policy/scope/ownership, exact original
parents, clean published tree, retained non-conflict content and a terminal
worker receipt, then reruns configured verification and releases only that proven
completed reservation. Completion rechecks current approval and grants inside its
transaction; revocation keeps the reservation for reconciliation rather than
releasing it under stale authority. It never sends, commits, pushes, resets or
expands scope.
If that proof cannot be obtained, preserve the reservation and request explicit
operator reconciliation/replanning; do not edit SQLite or rewrite history to
satisfy the check. DEV-18 answer intake is not required or assumed: a human answer
alone does not resume a conflict worker. DEV-17 blocker notices are deduplicated;
they identify the recovery and stage without publishing raw Git/hook diagnostics.
Detailed failure text remains local in `recovery-status`.
Completion notices report the new SHA but do not grant readiness or merge approval.

Installation/activation is a separate reviewed operator step. Human-only PR
merging remains mandatory.

#### Operator publication and stale-blocker recovery matrix

An operator may complete a previously authorized Git operation outside the bridge.
Do not repeat a successful merge/update merely because a controller intent is
stale. The supported observation interface is:

```sh
adlc reconcile-publication JOB CONFIG merge HUMAN
adlc reconcile-publication JOB CONFIG merge HUMAN --confirm EXACT_PREVIEW_HASH
# Other observed sources: commits, fast-forward, authorized-rebase
```

Preview is read-only: no schema writes, sends, fetches, commits, pushes, grants,
or blocker clearing. It reports independent message/latest-SHA gates. Confirmation
requires current unchanged plan/spec approval, applicable policy/grants, exact
registered repository/PR/base/feature/worktree, an idle unique owner, clean local
HEAD equal to the remote, and the retained old/current bases included in that
head. Normal publications must descend from each retained feature head. Feature
changes relative to the current base must fit current approved paths, and
configured verification is rerun. Changed SHA alone never proves recovery.

`authorized-rebase` is a named operator attestation that a rewrite was **already**
separately authorized and published. The observer does not rebase or force-push.
It requires an equivalent ordered patch replay (`git range-diff`, all entries
equal); changed, dropped, merged, added or ambiguous patches block for explicit
scope/product reconciliation. Observation never grants future rewrite authority.
Old objects must remain locally available; missing evidence blocks without fetch
or mutation. Broader rewrite/adoption is deliberately unsupported.

Confirmation rechecks evidence after verification and immediately before the
transaction. That transaction compares the authorization, target and intents,
appends old/new SHA/base, actor/source, verification and disposition evidence,
supersedes only the proven Git records and invalidates old CI/review readiness.
It preserves planning identity, grants, budgets, attempts, unrelated blockers and
all original audit history. An unrelated review/security stop remains stopped.
Repeated confirmation of the same current proof is idempotent. Native writers
remain outside the advisory fence: no claim of an atomic GitHub/native lock is
made, including after the last observation.

**Git publication and message delivery are separate layers.** A proven published
merge can release its Git reservation while retaining `delivery_uncertain` for
the original stable resolution client ID. No send is replayed and no receipt is
fabricated. The deduplicated reconciliation blocker remains until the existing
receipt reconciler observes that exact completed turn. A missing/failed receipt
still requires explicit operator investigation even when Git is proven current.

| Matrix category | Supported behavior and validation |
|---|---|
| Base current / clean update / unknown mergeability | No-op, existing GitHub update or bounded read-only observation; unknown is never readiness. Accepted updates are observed before conflict recovery only after both inputs are proven included and head/base rechecked. |
| Automated merge boundaries | Existing local-Git fixtures cover merged safeguards, text decisions, verification failure, interrupted merge/commit, normal/rejected push and lost reply. Interrupted mutations are never blindly replayed. |
| Operator merge / commits / fast-forward / authorized rewrite | Inspect/confirm publication proof; DEV-50 merge-with-missing-receipt and DEV-16 equivalent-rewrite-with-uncertain-update fixtures verify independent dispositions and no new sends or grants. |
| Dirty, detached, pre-existing operations, unpublished/divergent work | Preserve all edits/objects; preview rejects. A completed local merge without publication is not a published proof. Operator must separately authorize publication, not reset/abort/stash as a shortcut. |
| Concurrent base/head, changed owner/repository/base | Recheck and reject changed evidence; verification/head/base/approval-race fixtures retain intent. Out-of-scope publications and non-equivalent replay stop for a decision. |
| PR lifecycle / branch recreation | Closed/merged PRs fail open-feature proof; normal human-merge lifecycle remains authoritative. Reopened PRs are revalidated. Deleted/recreated branches, missing objects, replacement PRs and changed delivery identity are not silently adopted. No closure alone completes a job. |
| Crash and uncertain receipts | Existing reservations/receipts remain authoritative; published Git can settle separately, unknown delivery never resends. Same proof cannot spend another attempt or duplicate handoff. |
| Stale blocker and stale transaction | Only matching Git intents are superseded. Current head/base proof, scope and transaction-bound authorization are mandatory. Unrelated security/review/delivery gates remain. |
| Atomic identity/audit disposition | Publication ledger and target/intent changes commit together; planning reservation, attempt/budget history and original inputs remain untouched. |
| Latest-SHA pipeline | Target gets the observed head and fresh CI/review obligation, not approval; uncertain resolution receipt uses its actual client ID. Reconciliation performs no full-review request or remediation dispatch. |
| Bounded observations/no progress | Provider observation failures/unknown state use a durable six-read budget with backoff (one second, then sixty seconds); no remediation attempts consumed. `retry-observation JOB` rearms reads only after operator inspection, never resets mutation uncertainty or budgets. |
| Human decision and CLI fallback | DEV-17 deduplicated fixed notices identify recovery/stage and local evidence. Existing DEV-18 clarification/resume paths remain fenced; publication confirmation is a trusted named operator CLI action, not authority inferred from reviewer text or a Linear acknowledgement. |

The test suite combines injected provider state with isolated local Git remotes;
it performs no real main merge, paid provider call, installation, or live controller
repair. The lifecycle/rename/recreation and non-equivalent rewrite cases above
are conservative escalation boundaries, not universal automatic recovery claims.

### Existing worker handoff recovery

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
# Verified dependency resumption (DEV-47)

`dependencyRecovery` is an opt-in adapter around the existing readiness,
clarification publisher, `Workflow.resume`, submission fence and worktree
reservation contracts. It never spawns a replacement session or creates a PR.
The existing worker continues its approved implementation and owns its normal
feature commit/push/PR workflow. Human-only PR merges remain mandatory.

Configure this in the **operator-managed project configuration**, not in a worker
message, ticket description or PR comment. Each job binding must match its
current approved plan and specification SHA-256. Example shape (replace every
placeholder with verified values before enabling):

```json
{
  "dependencyRecovery": {
    "enabled": true,
    "baseBranch": "main",
    "jobs": [{
      "issue": "DEPENDENT_LINEAR_ISSUE_UUID",
      "planHash": "CURRENT_APPROVED_PLAN_SHA256",
      "specHash": "CURRENT_SPECIFICATION_SHA256",
      "prerequisites": [{
        "issue": "PREREQUISITE_LINEAR_ISSUE_UUID",
        "ref": "DEV-15",
        "repo": "OWNER/REPOSITORY",
        "pr": 3,
        "kind": "source",
        "capabilities": [{
          "path": "src/verification.ts",
          "sha256": "REVIEWED_CONTRACT_FILE_UTF8_SHA256"
        }]
      }]
    }]
  }
}
```

Prerequisites are the union of configured edges, structured plan/worker
dependency references, authoritative Linear `blocks` relationships, and
published feature-dependency edges. Worker references must have exact configured
issue/PR/capability mappings; they supply no commands or authority. Linear edges
are paginated and the combined graph is cycle checked with bounded traversal.
Unknown references, incomplete inventories, excessive graphs and changed
plan/spec bindings fail closed with an inspectable reason. Replaced PRs require
explicit operator mapping reconciliation; closed-unmerged or reopened PRs are
not considered satisfied. Linear Done is not capability evidence.

For every prerequisite the observer verifies the exact GitHub repository/PR,
provider-recorded merge, merge-commit ancestry in the configured current base, and configured
capability file contents at that immutable base. Capability digests are exact
UTF-8 file-content SHA-256. Merge evidence does not attest that a human manually
performed the merge; human-only merging remains an operator policy, not a claim
inferred from provider account type. Capability digests include trailing newlines:
they are for operator-reviewed
interface/contracts (bounded to 1 MB each). They are deliberately conservative:
an interface file changed after merge needs a new reviewed digest rather than
guessing compatibility. This is not arbitrary test execution or proof of
installed-service behavior. `kind: "host-runtime"` always requires explicit
operator reconciliation; workers never install or activate runtime changes.

Automatic continuation requires a dependency-only structured worker receipt,
current approval/scope, current Linear eligibility, supported runtime, the
existing plan-bound `merge-base-feature` grant, no outstanding clarification,
remediation or uncertain delivery, and a clean isolated singly-owned idle
worktree with a completed delivery receipt. Missing discovery or human questions
must be resolved through existing clarification/replanning interfaces, never
fabricated attestations. This does not retroactively grant Git operations.

Only a nondivergent **fast-forward** of the reserved feature branch is automatic.
The adapter fetches and verifies the exact base, checks local capability bytes,
and records an update reservation before changing the worktree. It does not
push, switch branch, rebase, discard, resolve conflicts or overwrite local work.
Dirty/shared/divergent work is an operator blocker, not permission to force it.
Existing published feature refs must match the recorded pre-update head; an
unpublished branch is allowed. Git conflicts and other recovery paths share the
same worktree fence.

```sh
adlc dependency-status
adlc dependency-preview JOB CONFIG
adlc dependency-resume JOB CONFIG CONFIRMATION_HASH
```

Preview is read-only, including database schema. Confirmation rechecks the exact
proposal and all guards; it cannot override missing capability, scope, ownership
or approval evidence. After a known interrupted fetch/update, explicit fresh
confirmation may retry only when clean original HEAD/ownership/base evidence
still matches. Automatic polls never replay an uncertain Git stage. A crash
after a failed pre-update fetch may leave an older-base reservation. A fresh
confirmed `dependency-resume` can supersede that reserved/fetching row only when
its recorded authorization, ownership, clean worktree and original HEAD still
match current evidence. Superseded rows remain in the audit history; changed
HEAD/ownership or a possibly attempted update retains its fence. A crash
after a successful fast-forward can be reconciled from exact clean updated HEAD
without repeating Git. Changed base/plan or unrelated reservations require
operator reconciliation, not live SQL edits or reservation deletion.

`Waiting for dependencies` is persisted separately from job approval and from
delivery uncertainty, and exposed by `status` / `dependency-status`. With
`blockerSync` enabled, Linear receives deduplicated waiting and resolution
comments listing prerequisites, current plan and next action; existing board
workflow states are not renamed or overwritten. Generic clarification notices
do not compete with dependency-only notices. Mixed human questions still use
clarification and cannot bypass dependency proof through `resume-job`.

Continuation uses the existing durable `continuations` intent and sender, bound
to job, plan/specification, dependency graph, base, scope and resolution evidence.
Provider receipt loss never means unsent: the observer reconciles the existing
intent and does not replay. Polling/waiting consumes no remediation attempts and
does not reset prior budgets. Existing exhausted/no-progress budgets block
continuation. If the worker blocks again after a completed continuation, further
automatic resumption stops for no-progress reconciliation.

Verification: `bun test test/dependency-recovery.test.ts`, then `bun test`.
Fixtures exercise two prerequisites, provider/capability failures, conservative
Git updates, concurrency, crashes, receipts and deduplicated notices without
live PR merges or paid model calls. These fixtures are **not a live unattended
recovery demonstration**. A separately authorized controlled run must verify
the installed host version, real provider receipts and same-session behavior
before claiming unattended recovery works. No such activation or end-to-end
operation is performed by this coding change.

# Worker delivery receipt reconciliation

New implementation, remediation and guarded-continuation dispatches reserve an
exact job/spec/plan/session/client-message/attempt binding before sending. The
delivery ledger is separate from worker outcomes, remediation budgets and PR
identity. Host acceptance is not provider confirmation. Queued/running native
turns mean **wait for the existing worker**, never send a competing turn.
Completion proves only delivery; existing scope, requirement, dependency,
approval, implementation-outcome and current-head CI/review gates still apply.

`reconcile-preview CONFIG` evaluates the same receipt rules without writing state
and includes per-attempt delivery results. Workflow status includes durable
delivery observations and exact `ageMs` (null when never observed). Polling audits
state/turn changes once rather than emitting an event for every evidence refresh.

The AO collector exhausts sequence-cursor pages (100 entries per page, bounded to
100 pages), rejects inconsistent turn snapshots and requires evidence no older
than two minutes for automatic reconciliation. Each page timeout is bounded by
the remaining freshness window, and a final page returned after that window is
rejected as incomplete. Missing/duplicate client receipts,
unknown turn states, mismatched identities, incomplete pagination, contradictory
terminal results and changed specifications remain uncertain. The native AO turn
ID is the execution receipt; prompt prose, timestamps alone and branch-head changes
are never substitutes. A send accepted by the host without a native turn remains
accepted-but-not-provider-confirmed.

Legacy remediation attempts without a durable binding cannot be automatically
settled by this ledger. Inspect the original session and attempt through supported
operator previews; do not backfill guessed identities, repair live SQL, reset
attempts, replace the worker/PR or resend. Provider-read recovery/backoff remains
separate from mutation uncertainty. No provider replay/idempotency guarantee is
assumed or introduced. If complete authoritative receipts cannot be obtained,
preserve the uncertain attempt and escalate the specific evidence gap. Human-only
merges and no deployments remain mandatory.

# Editing requirements of an active ticket

Changing any byte of the executable specification (identifier, title or
description, including formatting) invalidates the plan approval and scoped
dispatch authority. This deterministic conservative policy uses no model to
classify an edit as harmless. Provider timestamps and other fields outside that
specification do not change its hash; labels, project, state and policy still
undergo their independent eligibility/security checks. Revision notices expose
field names and character counts, not ticket excerpts or secrets.

An edit made before any planning owner exists is ordinary intake: the first
captured plan binds those requirements, so it is not a blocking revision.
Edits once planning has started always invalidate the previous scope.

Record future suggestions in a **separate follow-up ticket without agent-ready**,
linked to the active ticket. Do not append them to its executable description or
rely on an “ignore this” heading, comment or label to waive scope checks. Promoting
follow-up scope into the active description requires a new plan and authority.

New dispatch stops when the edit is observed. The bridge does not interrupt an
active turn or Git operation: wait for authoritative idle/completed receipts.
An already-running supervised-host process is not retroactively sandboxed or
cancelled. Missing/failed/uncertain receipts require controlled reconciliation,
not a resend or database repair. Existing PR/session/worktree identity, attempts,
reservations and historical evidence remain intact.

For a `delivery_uncertain` remediation whose original turn actually completed
(DEV-69), preview `adlc receipt-reconcile JOB CONFIG ATTEMPT`, then repeat with
`--confirm HASH`. This receipt-only operation requires fresh complete original
worker evidence and exact historical plan/spec/attempt/client identity. Legacy
rows require corroborating retained history; mismatches or competing attempts
remain blocked. It never resends or restores stale approval. Afterwards use the
normal `spec-reconcile` path below. See [receipt reconciliation](docs/deterministic-watchdog.md#original-remediation-receipts-dev-84--dev-69)
for refusals, audit guarantees and persisted-only receipt status.

Use `adlc spec-reconcile JOB CONFIG` for a read-only preview. It refreshes Linear,
owner, worktree and attached PR evidence. `--confirm HASH` authorizes **only a
planning turn in the existing owner** when that exact evidence remains valid.
It does not grant implementation, verification, commit/push or PR metadata edits.
Do not create another worker/PR. A reserved send is never replayed; normal polling
captures its exact completed reply, or retains its uncertainty. Repeated edits
coalesce to the latest revision while preserving earlier delivery records.

For an archived/terminated planning owner after a requirement revision (DEV-91),
first run `adlc spec-restore JOB CONFIG` for a read-only preview, then repeat with
`--confirm HASH`. Confirmation durably reserves **one planning-only native restore**
before calling AO. Admission requires the exact native session/project/workspace,
linked repository/branch/HEAD, current eligible Linear requirements, retained
completed receipts, and unambiguous existing PR ownership. Local work and history
are preserved; `planning_finished` alone never permits setup.

Repeat `spec-restore JOB CONFIG --confirm HASH` with the returned binding to
reconcile the outcome **without invoking restore again**. A lost reply or restart
does not authorize replay or a replacement worker. Missing receipts, unknown
activity, identity/requirements changes, or an unconsumed/failed setup remain
blocked for operator inspection. Only a known failure before native launch permits
a fresh preview and separately confirmed attempt. Once restore is verified,
preview and confirm `spec-reconcile` separately to request revised planning in the
same session. Neither restore nor reconciliation grants implementation authority;
the configured approval policy, human-only merging and no-deploy policy remain.

After capture, `plan-approval-required` tickets use the exact fenced command in
the new Linear plan notice, from a configured human. Previous replies are stale.
Standing-policy tickets pass through current eligibility/readiness/scope policy;
an ineligible or unresolved plan stays blocked, without expanding permissions.
Worker outcomes retain revision/dispatch instance identifiers; legacy outcomes
without them cannot drive dependency
recovery or continuation after a requirement revision. Approval notice tokens
also bind the revision, even when specification and plan hashes recur.
Previous PR/verification evidence is historical until the revised implementation
hands off; a merge of that old PR cannot mark the revised job Done. Terminal
failed/cancelled replan turns are retired only by confirming their exact receipt
(`spec-reconcile` preview), then a fresh preview/confirmation is required.
If a throwing send has no receipt, only a complete fresh inventory of the exact
idle owner can offer an explicit absence confirmation. It retires that uncertain
reservation without replay; a new planning attempt needs a separate confirmation.
Incomplete, stale, busy, mismatched or accepted-message evidence stays blocked.
Completed replans without their revision marker report `replan_unmarked` without
breaking polling. Confirming that exact completed turn retires it without replay;
a fresh planning attempt still needs separate preview/confirmation. Active
revisions require approval of the exact captured revised-plan hash, even before
the first implementation. A manually submitted plan cannot bypass that capture.
Direct `plan` and `capture-plan` refuse for every recorded revision state except
`preplanning`, including `pending`, `awaiting_approval`, and `authorized`; use
`spec-reconcile` instead. A revised handoff must be the PR the review target
registered. The recorded revision handoff is authoritative: if the target points
at another PR, `adlc rebind-review-target JOB REPO PR` (with the handoff's PR)
aligns the target atomically or leaves progression blocked. It cannot substitute
a different PR for the recorded handoff.
Linear revision notices require enabled status synchronization and are
published in bounded batches with durable forward and older-retry cursors.
`status`, `review-status` and `reconcile-preview` retain independent
provider/dependency blockers alongside the requirements blocker.

Existing incidents are not automatically approved or resumed. A subsequent
eligible intake can record a legacy planning/spec mismatch using its retained
hashes; unavailable historical text stays explicitly unknown. Use the same
preview/confirmation path and inspect session history. No live SQL repair,
automatic merge, deployment or runtime activation is part of this recovery.
DEV-35/DEV-55 integrations are optional; this core command does not require them.

# Everyday operator CLI

Grouped commands coexist with all existing flat commands. No migration or
installation activation is needed to use the source CLI:

```sh
adlc projects list
adlc jobs list
adlc jobs lookup DEV-31
adlc jobs status DEV-31 --project LINEAR_PROJECT_ID
adlc jobs status DEV-31 --project LINEAR_PROJECT_ID --json
adlc jobs show-plan DEV-31 --project LINEAR_PROJECT_ID
adlc services status
adlc routing show PROJECT_JSON
adlc routing preview PROJECT_JSON TASK_FILE
adlc diagnostics doctor
adlc jobs --help
```

Lookup accepts an exact job ID, stored issue ID, or ticket identifier from the
ingested specification. It never queries Linear or picks the newest match.
Ambiguity prints candidates and requires `--project PROJECT` (the stored project
ID), or an exact job ID. Commands never prompt to resolve ambiguity.

`jobs list/status/lookup` use read-only persisted evidence, never initialize
engines, dispatch workers, change labels, fetch Git, or activate configuration.
Worker activity and evidence freshness are explicitly `unknown`: a persisted
dispatch is not proof a worker is currently working. The persisted update time,
orchestration state, reason, and next supported inspection action are shown.

Grouped `--json` success output is `{schemaVersion:1, command:GROUP, data:...}`;
job inspection data is `{jobs:[...]}` with stable fields `job`, `project`, `issue`,
`ticket`, `state`, `orchestrationState`, `reason`, `nextAction`, `worker`
(`activity`, `session`, `dispatchState`, `outcome`), and `evidence`
(`freshness`, `persistedUpdatedAt`, `note`). State is `awaiting_plan`, `working`, `approval_wait`,
`dependency_wait`, `blocked`, or `complete`. JSON errors go to stderr as
`{schemaVersion:1, command:GROUP, error:{code,message,candidates}}`.
Exit codes: 0 successful inspection (including empty lists), 1 operational
failure, 2 grouped usage error, 3 missing job, 4 ambiguous lookup. Errors never
select a candidate or dispatch work. Legacy flat commands retain their existing
JSON/text output and operational error behavior for scripts.

Compatibility aliases: `projects list` → `projects`; `routing show/preview` →
`routing`; `services start/stop/restart` → `start/stop/restart`;
`services status` is the richer lifecycle inspection, while flat `service-status`
retains intake-only output; `services config` → `service-config`;
`diagnostics doctor/readiness/runtime-check/ao-status`
→ the corresponding flat command. `jobs show-plan/approvals/recover/cleanup/resume/approve/dependency-status/review-status`
map to `show-plan/approvals/recover/cleanup/resume-job/approve-job/dependency-status/review-status`.
Their existing explicit authorization, confirmation and argument requirements
still apply; grouped job commands accept ticket references in the job position.
`status` remains the legacy detailed queue output; `jobs status` is the new
read-only operator summary. See `help` for the full legacy command reference.

Services control running processes only. Job approval/resume/recovery remains
explicit and separate. Source updates remain operator-managed; no inspection
updates source. `install` and `install-runtime` are separate preview-first
installation commands, with activation requiring explicit `--apply`; service
inspection does not install or activate anything. Merge and deployment remain
outside the CLI's authority.

## Scoped configuration and discovery

```sh
adlc projects show ORCHESTRATOR_PROJECT_ID
adlc status --project ORCHESTRATOR_PROJECT_ID --json
adlc jobs show DEV-31 --project ORCHESTRATOR_PROJECT_ID
adlc jobs list --project ORCHESTRATOR_PROJECT_ID --state approval_wait
adlc doctor --project ORCHESTRATOR_PROJECT_ID
adlc config show --project ORCHESTRATOR_PROJECT_ID --json
adlc config get automation.maxPlanning --project ORCHESTRATOR_PROJECT_ID
adlc config set automation.maxPlanning 8 --project ORCHESTRATOR_PROJECT_ID
adlc config set automation.maxPlanning 8 --project ORCHESTRATOR_PROJECT_ID --apply
adlc config set pollingIntervalSeconds 30 --project ORCHESTRATOR_PROJECT_ID
adlc config set remediation.maxAttempts null --project ORCHESTRATOR_PROJECT_ID
adlc config reset automation.maxPlanning --project ORCHESTRATOR_PROJECT_ID
adlc config validate --project ORCHESTRATOR_PROJECT_ID
adlc config diff --project ORCHESTRATOR_PROJECT_ID
adlc queue list --project ORCHESTRATOR_PROJECT_ID --json
adlc auth status --project ORCHESTRATOR_PROJECT_ID --json
adlc version --json
adlc completion zsh
```

Config commands require explicit project selection. Registered Orchestrator IDs
and unambiguous registered Linear IDs resolve to the same project. Job lookup
also supports a stored Linear ID when no registry entry exists. Exact job IDs
take precedence over issue/ticket matches. `services list` is an alias of
`projects`; `jobs show` aliases operator job status. Lifecycle commands accept
`--project PROJECT` or a positional project, but never both. `services config`
retains its positional project requirement. No selector is silently discarded.

Writable settings and defaults:

| Key | Allowed value | Default |
| --- | --- | --- |
| automation.maxPlanning | integer 1–32 | 1 |
| pollingIntervalSeconds | integer 5–86400 | 60 |
| remediation.maxAttempts | positive safe integer or literal null | 5 |
| remediation.maxNoProgress | positive safe integer | 5 |
| remediation.window | job | job |

Numbers must use canonical decimal notation: no signs, leading zeros, fractions,
exponents or whitespace. `maxPlanning` limits concurrent **planning**, not total
implementation/review workers. Next poll adopts capacity; reductions never kill
active work. Remediation changes do not reset history, attempts, or existing stops.
Approval, routing, service identity and Git/recovery grants are not writable here.

Set/reset preview by default. `--apply` saves atomically, keeps unrelated fields
and permissions, creates a uniquely named `.backup-*` beside the config, and
rejects concurrent changes. Reset removes only the allowed override and restores
its default. A `.adlc-config-lock` prevents overlapping CLI editors; a stale lock
requires operator inspection, not automatic deletion. External editors must not
race an apply. Config output projects only allowlisted values; it is not a raw
export and never prints secrets or credential references.

`config diff` shows declared/default/effective values plus saved-versus-installed
polling settings. Polling set/reset previews the proposed service interval;
explicit apply reuses guarded service-config. Stopped services stay stopped.
Loaded services require verified enabled identity and quiescence before reload.
Native backend and worker sessions are not restarted. Saving config and reloading
a service are separate operations: a failure reports unknown active interval,
returns a nonzero result and gives supported service-status/config recovery steps.
Do not assume a saved interval is active. Missing service installation does not
implicitly install or start one. `serve` captures its sleep interval at startup;
saved values alone do not change that running loop.

Queue reads provider evidence without ingesting or reconciling jobs. It exhausts
cursor pages (bounded at 100), rejects repeated/incomplete/expired evidence, and
reports unavailable/incomplete snapshots separately from an empty queue. Existing
jobs, waits and uncertain reservations remain visible. Provider eligibility is
not admission authorization: when dependency/approval evidence was not refreshed,
admission stays unknown with that precise evidence gap rather than guessing.
Queue capacity/occupancy describes planning only. No queue status or readiness
label is changed. Provider-unavailable/incomplete results exit 1.

Auth status reports missing or unverified authentication from safe presence and
configured harness metadata; it never reads raw token files, prints sensitive
references, refreshes logins or makes paid probes. Presence cannot establish
expiry/validity, so use the explicit provider/harness login-status workflow when
verification is needed. Version distinguishes source package, installed snapshot
package and unknown running backend; equal package versions do not prove the same
commit or active runtime. Completion prints bash/zsh/fish definitions only; shell
files are never modified automatically.

New scoped commands use schemaVersion 1 success/error envelopes. Version 1
job views use display states `awaiting_plan`, `approval_wait`, `dependency_wait`,
`working`, `observation_wait`, `blocked`, and `complete`. The nullable
`observation` object retains historical evidence even when a persisted blocker,
approval/dependency wait, or completion takes precedence. Its fields are:
`failures` (consecutive incomplete observations), `nextRetry` (epoch milliseconds,
or null when no automatic probe is eligible), `error` (nullable secret-safe typed
provider evidence: provider, operation, timestamp, classification, optional
exitStatus/httpStatus/retryAt/requestId, and bounded detail), and `evidenceAgeMs`
(elapsed milliseconds or null for legacy unknown evidence). `observation_wait`
means an otherwise approved working job is waiting on read-only observation;
it does not authorize dispatch, Git writes, or approval.

Existing flat
commands retain legacy text/JSON contracts. Display state `awaiting_plan` means
no planning dispatch, not an active worker; activity/freshness remain unknown
without authoritative evidence. Linked DEV-35/43/34/33/51/55 integrations remain
planned, not success-shaped placeholders; existing guarded engine commands remain
available as documented elsewhere.
# Read-only observation recovery

Review-loop GitHub branch/ancestry/readiness reads, conflict-recovery delivery
facts (before and after reservation) and Orchestrator session evidence have
durable observation recovery, separate from remediation and all
mutation receipts. Evidence stores provider, safe operation, time, classification,
exit/HTTP status and available retry/request identifiers. Raw stderr, credentials,
URLs and response bodies are not retained; diagnostics are an allowlisted summary.
Nested errors retain their cause in memory, not in persisted diagnostics.
Transcript pagination reconciles page-local turns and retries a genuinely changed
turn before failing closed.

Timeout/network, 5xx and explicit primary/secondary throttling errors retry at
1, 2, 4, 8 and 16 seconds (±25% jitter). From failure six onward the circuit uses
one health probe per 30 minutes, or later when Retry-After/rate-reset requires it.
Only a complete successful observation resets consecutive failures. Unknown,
malformed, missing-resource and authentication/permission failures require
inspection and an explicit read retry; unknown errors are never called quota
failures. A successful read is not approval or permission to write.

Automatic review polling also uses the [deterministic watchdog action ledger](docs/deterministic-watchdog.md):
at most four due review candidates per tick, durable read-only observation claims,
six transient retries per action and a cumulative 240-observation job budget.
These tighter automatic limits sit above the shared provider controls described
below. `jobs status JOB --json` exposes persisted next action/due/budget and
escalation evidence without writes. The ledger adds no recovery sender or model
conductor and never resets uncertain mutation receipts.

Failure history spans providers and survives branch-only ticks until readiness
collection succeeds. Unknown mergeability uses a separate durable one-minute
wait, not the provider-failure or remediation budget. After six unknown results,
polling stops for inspection; `retry-observation JOB` rearms that wait after
operator inspection. A known branch result clears the mergeability wait only.

Capacity/cooldowns are shared by provider across projects/jobs in the same state
database. A job's circuit delay is not shared: transient failures impose only a
one-second provider coordination cooldown, extended by valid provider retry
hints. GitHub throttling without a usable hint instead waits at least one minute
across the job and shared provider cooldown. Provider hints are capped at 24 hours
from observation time; existing longer stored cooldowns are also capped at startup.
Untyped callback errors remain unknown; only typed provider-read evidence can
authorize automatic transient recovery. Invalid timestamps outside the supported Date range are rejected; legacy
invalid stored cooldowns are durably normalized to a 30-minute health-probe wait
without clearing failure history or mutation receipts. Reserved conflict recovery
uses this read backoff before any worktree mutation; later uncertain mutation
stages still require their existing reconciliation and are never replayed.

Capacity coordination uses the same state
database. A provider lease permits one collection at a time (10-minute crash
expiry); a job evaluation lease suppresses concurrent continuations (one-hour
crash expiry). Run projects sharing provider capacity against the same state
database, not independent databases. Restart preserves cooldowns and leases.
There is no autonomous mutation replay or retry timer outside normal supervised
polling; existing update/shutdown submission barriers remain authoritative.

Inspect `adlc review-status` or `adlc jobs show JOB --json` for the observation
class, evidence age, failure count and scheduled retry time. Old six-failure rows
without typed evidence become eligible for a guarded probe at their stored due
time; their historical cause remains unknown. For persistent failures, verify
provider login, repository/session access and configuration locally. Never paste
tokens or credential stores into tickets. When blocker synchronization is enabled,
the existing receipt-backed Linear publisher posts a deduplicated notice without
adding/removing labels or blindly repeating an uncertain comment delivery.

After correcting a permanent problem, use `adlc retry-observation JOB`. This
rearms reads only and does not bypass a shared provider cooldown. Inspect
`adlc review-status` for the provider's `sharedNextRead` timestamp. To override
an abnormal shared cooldown after inspecting provider health and retry guidance,
use `adlc retry-observation JOB --override-shared-cooldown github TIMESTAMP`
(or `orchestrator`). This compares the exact inspected timestamp, audits the
override, and clears only that provider's shared cooldown; it does not change
any job wait. Then use plain `retry-observation JOB` separately as needed. A
changed timestamp requires inspection again. Neither action replays mutations.

Inspect
`adlc reconcile-publication` preview separately for uncertain publication; read
recovery never replays PUTs, pushes, comments, model sends or other mutations.
Other freshness, scope, approval, ownership, busy-worker and reconciliation gates
remain in force. Recovering reads does not clear those blockers or reset attempts.

Source changes do not activate the pinned live runtime. After human review and
manual merge, an operator must follow the guarded runtime activation workflow;
coding workers must not install, activate, restart or deploy the live bridge.
# CodeRabbit review recovery

Review scheduling uses GitHub-hosted `.coderabbit.yaml` (or `.coderabbit.yml`)
from the PR head, as documented by CodeRabbit's
[YAML configuration guide](https://docs.coderabbit.ai/getting-started/yaml-configuration).
It does not read the local checkout or require a duplicate project mode setting.
ADLC clearance still requires its configured checks and explicit current-head bot
approval. Head/base YAML differences block clearance until trusted base policy is
reconciled; a feature branch cannot weaken its own clearance policy.

Automatic incremental reviews are awaited, not manually requested. With automatic
review enabled and incremental review disabled, an idle worker and five-minute
stable-head/config grace period precede a request. Accepted or uncertain requests
consume the repository/PR/head budget, even across description edits and restarts.
Confirmed HTTP 403/429 rate-limit rejection permits retry after the persisted
provider cooldown (at least one minute; default 30 minutes), with at most three
attempts per head. Unknown outcomes are never retried blindly. Matching marked
GitHub request comments can reconcile uncertain delivery; otherwise operator
inspection is required. Missing review evidence after 30 minutes yields a specific
CodeRabbit blocker through the existing optional Linear blocker synchronization.
Verified provider reset times are never shortened to a 24-hour retry cap: that
could send before the provider permits it. Long or implausible reset evidence
requires operator inspection rather than shortening the reset, silently retrying
or enabling paid usage. This CodeRabbit request ledger is
distinct from bounded GitHub observation/read backoff hints.

Conservative fallback: missing/competing filenames, malformed or inherited YAML,
unsupported filters/branch expressions, unavailable changed-file evidence, and
intentional exclusions block rather than guessing or requesting reviews. Supported
path filters use ordinary repository-relative `*`, `**` and `?` globs; complex
patterns require operator reconciliation. Auto-pause uses a conservative count of
distinct reviewed commits; when its threshold may have been reached, inspect the
provider's pause state rather than automatically resuming. Disabled automatic
review is never overridden, even if a description keyword could opt in.
These blockers do not grant approval. Merges remain human-only.

## Provider mode restoration compatibility (DEV-92)

Archived planning authorization (DEV-91) and native provider startup are separate
gates. This change adds **no** restore controller, restore command, session
replacement, automatic retry, or turn replay. DEV-91 must use the original native
restore path before its existing fresh-requirements/authorization checks permit
replanning. A provider mode never grants ADLC implementation authority. Live
DEV-90 recovery still requires both paths and a separately reviewed operator
runtime activation; it has not been performed by these fixture tests.

`src/provider-mode.ts` separates `planning`/`execution` intent from adapter-owned
mode identifiers. Discovery accepts only explicitly mapped advertised choices;
ambiguous aliases, missing capabilities, permission-posture changes and
unconfirmed selection fail closed. Existing OpenCode routing pins `plan`/`build`
without alias fallback. Tests also use an independent `inspect`/`edit` adapter.
Model/effort selection still precedes mode selection and all existing approval,
revision, setup, ownership and submission fences remain in force.

The isolated native regression reproduces the reported confirmation boundary:
an ACP provider advertises a mode picker, acknowledges `session/set_config_option`
without a rebuilt catalog, and confirms via `current_mode_update`. At pinned
Orchestrator revision `403a8c8385ed43bbf9e9289e3f3bbaa6517dc437`, that notification
is ignored and startup reports an unconfirmed mode. This is a **reproduced
compatibility failure**, not proof of the live incident's provider response.
An empty modern config-option acknowledgement alone must never become confirmation.

Supported native remediation is that exact pinned source plus the reviewed
`patches/orchestrator-provider-mode.patch` (alongside the existing CI patch).
It adds shared ACP notification confirmation, capability discovery and classified
sanitized restore errors. Observation is bounded to 250 ms after an empty modern
mode response, with **one setter call and no retry**. Only fresh advertised mode
evidence counts. A rejected/unsupported/unconfirmed/uncertain mode blocks controller
publication. The existing persistent ACP relay invalidates mode evidence before
selection and retains uncertainty across daemon attachments; a late older response
cannot confirm a newer request. Reconnection verifies saved intent against that
host-owned evidence, not its original setup snapshot, without changing an in-flight
host. Old hosts lacking this provenance fail closed: inspect/quiesce them through
a separately authorized native operator workflow before same-session restoration;
never kill uncertain work or silently replace the host. Legacy ACP `set_mode`
success retains its protocol-defined selection confirmation. The OpenCode v2 binding
also stops mapping every permission posture to Build on each turn: its existing
permission policy remains responsible for approvals, independently of workflow
mode. No unadvertised custom mode or Build fallback is introduced.

Reproduce/build only in a new scratch directory with Go 1.27.1:

```sh
export ADLC_GO='/absolute/path/to/go1.27.1/go/bin/go'
export PATH="$(dirname "$ADLC_GO"):$PATH"
# Use isolated HOME, GOCACHE and GOMODCACHE for native verification.
bun scripts/build-orchestrator.ts /absolute/new/scratch/build-directory
```

The script verifies the upstream archive SHA-256, applies both patches, runs
full race-enabled ACP/persistent-host/GitHub suites plus focused OpenCode-v2,
chat, session-API and session-manager restoration tests, then builds `ao`.
Its test/build environment excludes inherited provider credentials and live-test
flags and uses temporary HOME/AO data. It does **not** install, start, restore, activate services, merge or
deploy. The launcher remains a pinned-binary launcher; changing bridge source
does not repair the installed native runtime. If a provider still does not
advertise/confirm the requested mode, preserve the original session, worktree,
history, revision, harness/model and permissions; inspect the reported requested
and observed mode and establish provider compatibility before explicit recovery.
Never test recovery by sending a prompt or inspecting/editing live databases.

Broader native-suite limitations observed during development: the unchanged
session-manager scratch-provisioning test requires an available `tmux` on macOS;
the existing wrong-major OpenCode fixture can fall through to a system-installed
binary outside its temporary PATH/HOME. These are not exercised by the focused
reproduction path, which uses only fake providers. Neither failure is reported as
a passing full native suite or repaired by weakening production prerequisites.

## Same-spec planning evidence recovery

When a captured plan has invalid readiness (for example, `ready` with blocking
dependencies), obtain a corrected completed plan from the **same planning
session**. Preview `adlc plan-reconcile JOB CONFIG SEQUENCE`, then confirm the
unchanged preview with `adlc plan-reconcile JOB CONFIG SEQUENCE --confirm HASH`.
Preview is read-only; confirmation preserves the previous plan/readiness/route
evidence in event history and captures the selected plan without approval or a
new model turn. Fresh unchanged eligible ticket requirements, exact completed
transcript evidence, current ownership/routes and an idle session are required.
Existing approvals, execution reservations and uncertain deliveries are never
overwritten. Requirement changes use `spec-reconcile` instead.

The readiness receipt's `dependencies` array means **blocking execution
prerequisites**, including legacy entries without a `blocking` field. Omit
coordination-only links from that array or use `blocking:false`; prose links do
not create execution prerequisites. `ready` with blocking dependencies is invalid.
Validated clarification resolutions are reevaluated by the normal standing-policy
poll, not treated as new authority. `plan-approval-required` still requires explicit
approval of the current plan. Changed requirements or scope require replanning.
# Trusted review feedback

ADLC accepts review feedback through one existing-worker remediation loop; native
Orchestrator CI/review injection stays disabled for bridge-managed workers. GitHub
branch protection is independent: reviewer configuration does **not** install or
activate live protection, request paid usage, merge, or deploy.

`reviewers` is an optional project configuration array, merged by reviewer `id`.
An omitted array retains CodeRabbit's existing required check/approval/custom-check
gates and adds advisory Codex ingestion. Defaults are pinned to immutable GitHub
Bot IDs: CodeRabbit `136622811`, Codex `199175422`; both are freshly verified before
processing. A matching login alone grants no trust. If a descriptive login is
configured, a rename blocks that identity until the operator reviews the binding.

```json
{"reviewers":[
 {"id":"codex","adapter":"github-review","identity":{"userId":199175422,"type":"Bot","login":"chatgpt-codex-connector[bot]"},"enabled":true,"remediate":true,"approvalRequired":false,"requestReview":false},
 {"id":"maintainers","adapter":"github-review","membership":{"kind":"collaborators"},"approvalRequired":true},
 {"id":"team","adapter":"github-review","membership":{"kind":"team","organization":"OWNER","slug":"TEAM"},"includePaths":["src/**"],"excludePaths":["src/generated/**"]}
]}
```

Humans may instead select `identity: {"userId":123,"type":"User"}` with a verified
account ID, not a placeholder in live configuration. Explicit users must still
have current repository read access. Membership is re-read on each collection,
at most 100 pages of 100 users, within the existing receipt freshness window.
Revoked/deleted/renamed identities and unavailable evidence grant no trust and
block affected processing. Bots are never trusted through human membership.
The authenticated executing GitHub account, PR author, and bridge control-marker
comments are excluded from remediation. Other automation requires a configured
stable Bot identity. Provider originals remain untrusted requirements data and
cannot authorize credentials, security/scope changes, Git permissions, installation,
merging or deployment. Conflicting/ambiguous feedback must use the existing exact
Linear clarification/worker outcome flow, not guessed reconciliation.

## Flags and policy adoption

* `enabled`, `remediate`: boolean, default true. Disabling ingestion preserves
  durable evidence. Disabling remediation never grants clearance.
* `approvalRequired`: boolean, default false for new reviewers; CodeRabbit remains
  required. `enabled=false` plus `approvalRequired=true` is invalid. An advisory
  approval cannot substitute for any required reviewer. COMMENTED, summaries,
  missing reviews, neutral checks and skipped checks are never approval.
* `minimumSeverity`: `info|low|medium|high|critical`, absent by default. Standard
  GitHub APIs do not supply structured severity, so their unknown findings remain
  eligible without a threshold; with one they remain visibly unclassified and
  cannot silently clear an obligation. Severity is never guessed from prose.
* `includePaths` / `excludePaths`: up to 100 repository-relative globs of up to 256
  characters, supporting `*`, `**`, `?`; no traversal, absolute paths, braces or
  negation. Exclusions win, both rename paths are checked conservatively, and
  deleted-path provenance is retained. Pathless feedback is eligible without
  filters; with filters it remains unclassified rather than silently cleared.
  Ingestion eligibility is not send authorization: pathless code findings remain
  visible but automatic remediation stops until concrete approved paths are known.
  Trusted reviewer identity alone never expands the worker's file scope.
  Explicitly excluded findings are retained as nonblocking provenance, not pending
  remediation. A thread is ignored only when every substantive comment is trusted
  and excluded; required approvals and provider change requests still block.
* `requestReview`: default false for generic GitHub adapters, true for CodeRabbit.
  False does not disable external feedback ingestion. Only `coderabbit` has a
  supported request adapter. Generic GitHub accepts standard review APIs, not
  custom summary formats, APIs or arbitrary bot issue comments.
* `reviewMode`: `regular` (default) or explicitly selected `full`, CodeRabbit only.
* `cooldown`: milliseconds, 60000–86400000, default 60000; `retryLimit`: integer
  1–3, default 3. CodeRabbit only. These may constrain existing durable retries,
  never bypass provider resets, shared quotas, budgets or uncertain requests.
  The existing five-minute initial review grace period remains unchanged.

Unsupported options/adapters fail validation rather than being ignored. Graphite
and Claude custom adapters are **not supported**. Extensions must provide typed
capabilities, stable authenticated identity/app provenance where available,
normalized findings/originals, applicability and review-state semantics, and
authenticated fixtures; request adapters additionally need durable reservation,
cooldown and uncertain-delivery reconciliation. A configured name is not provider
support. No CodeRabbit commands are sent to generic GitHub reviewers.

Policies bind to the approved job plan on its first review tick. A policy change
during active work blocks until a fresh reviewed plan is approved; restarting or
reloading alone cannot remove obligations. Serve reloads configuration each poll,
but source changes do not activate the installed runtime. Use `adlc config show
--project PROJECT` and `adlc config validate --project PROJECT`; doctor reports
the effective policy without configuring reviewers. Jobs JSON includes persisted
policy and observations (timestamps, trust, pending findings and approvals);
`adlc readiness OWNER/REPO PR CONFIG` collects fresh evidence without mutations.

Unresolved mapped threads may carry older comments after applicability checks;
outdated threads require clarification. Resolved threads stop being actionable.
Edited bodies change finding identity; exact same-location duplicates retain all
provenance. Distinct threads are not semantically collapsed. Dismissal withdraws
approval/change-request state, not independent unresolved threads. A later
COMMENTED review does not revoke a substantive review; a later approval must
still match the current head. Membership-selected required reviewers need at least
one current approval and no remaining member change request. Durable legacy
thread receipts prevent replay on upgrade; legacy feedback needing edit validation
requires human inspection instead of an unbounded automatic resend.
Human issue comments have no GitHub resolve operation. A subsequent explicit
current-head approval by the same freshly authenticated human acknowledges their
preceding issue-comment versions; observations retain comment/review originals.
An edit after that approval, a new head, dismissal, or a later change request
reopens the finding. Another reviewer's approval, unavailable timestamps or failed
identity evidence cannot acknowledge it. Inline thread resolution stays separate.
The example project file deliberately disables Codex ingestion/remediation until
an operator opts in; built-in defaults for configurations that omit this override
are unchanged.

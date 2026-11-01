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
Existing definitions must match byte-for-byte or are preserved as conflicts.
`service.path` must be a staging path for writes, not a LaunchAgents/Daemons
directory. Parent directories must already exist. XML escaping is automatic.
The staged file retains the configured label, timing, log paths and RunAtLoad
setting; staging does not load it. A human must separately approve installation
and activation, including replacement of installed controller code. Point
`controller` at a stable installed copy, never at a mutable development worktree.
Source edits and these commands do not activate that installed copy.

Pin Bun, AO, Git and gh paths/versions under `tools`; pin Docker there too if
container verification is selected. Versions are exact three-component versions
(the actual `git`, `gh` and `docker` executable names must be on the generated PATH).
Generated services set `ADLC_AO_PATH` to the configured AO executable; legacy
services retain the bundled-app default. Workflow hooks use the running Bun.
(optional prerelease/build suffix). Configure routing paths in the existing project
JSON. Credential mechanisms remain `adlc auth-linear`/the existing token override,
native gh authentication and Orchestrator provider login. Never put tokens,
passwords, environment assignments or private keys in argv, config or examples.
Host verification inherits the caller environment; do not use it for untrusted
code with credentials in scope. Neither mode contains the coding agent.

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
realpath containment checks. Execute only after the plan authorizes verification:

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
findings. It sends scoped actionable fixes to the existing worker, up to five
remediation attempts. Missing review blocks after 30 minutes; failed required CI,
out-of-scope work, or uncertain delivery can also block. This is a bounded loop,
not a promise of unlimited retries or automatic success.

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
documents are machine-local notes and are not part of the published source. Docker controller packaging, a portable
installer, and automatic worktree cleanup are not implemented.

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
  "maxUpdates": 3
}
```

The host waits for an idle worker, checks the exact owned same-repository feature
branch and current approval, and pins the expected PR head for the API request.
Conflicts, forks, default-branch heads, exhausted limits, and uncertain outcomes
block automatic updates. Requests are reserved durably before delivery, and the
same head/base pair is never blindly retried. Base changes can consume further
updates up to the configured per-job limit (maximum 10).

A new commit must pass CI and CodeRabbit again. Even with automatic branch updates
disabled, the readiness gate refuses to report a branch behind its base as ready.
A base can move after any observation, so final merge eligibility must still be
checked by the human and GitHub at merge time. No protection, review, or check is
bypassed. Workers must fetch and fast-forward their local feature branch before
further code remediation and stop if it is dirty or divergent.

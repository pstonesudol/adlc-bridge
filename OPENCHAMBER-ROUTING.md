# ADLC-owned task routing

ADLC installs and routes without OpenChamber files, modules, processes or classifier
services. OpenChamber is an optional import source and interactive interface.
Orchestrator, OpenCode, GitHub and Linear remain workflow integrations.

## Setup and schema version 1

Copy `config/routing.example.json` to an operator-owned configuration directory,
replace its model references with models offered by your authorized OpenCode login,
and set the project's routing section:

```json
{"enabled":true,"harness":"opencode-v2","configFile":"/absolute/path/adlc-routing.json","overridesFile":"/absolute/path/project-routing.json"}
```

The example document is disabled. After configuring its targets, explicitly set
the document's `enabled` to true as well as enabling routing in the project.

`configFile` is the shared defaults document. The optional `overridesFile` is a
versioned partial document. Paths resolve from the process working directory;
use absolute paths in services. Precedence is shared document, then explicit
project overrides. Overrides replace complete top-level values, including the
entire categories array, fallback and classifier object; there is no implicit
category merge. Both merged configuration and shared defaults are validated.
`adlc routing PROJECT_CONFIG` prints effective values and their top-level source
paths. Unknown fields, versions, duplicate category IDs, unsupported harness/agents,
invalid model references and out-of-range confidence thresholds fail closed.
Missing/malformed files report the affected path; no implicit paid model is chosen.

Required document fields: `version:1`, `harness:"opencode-v2"`, boolean `enabled`,
`minConfidence` in [0,1], `categories` and `fallback` (a target or null), and
`classifier`. Each category has a unique `id`, boolean `enabled`, description,
model `{providerID,modelID}` or null, optional `variant` (reasoning effort), and
optional `agent` (`build` or `plan`). Targets support the same model and effort
fields. Only the OpenCode 2 harness is supported; live worker controls must also
advertise the selected model/effort. No silent harness/provider substitution occurs.
Fallback targets are build-only and reject the `agent` field.

## Classification and authentication

`classifier:{"adapter":"off"}` uses the configured fallback for classified tasks.
Planning selects the enabled `planning` category deterministically without inference.
To enable classification, explicitly configure
`{"adapter":"opencode","model":"AUTHORIZED_PROVIDER/MODEL"}`. This authorizes
classification requests to that model under its normal billing terms; ADLC does
not choose a classifier model automatically. The adapter uses `opencode run`
in a temporary empty directory, a standalone server, Plan agent, and deny-all
tool permissions/policy. It expects JSON choice/confidence from JSON text events
and bounds requests to 30 seconds. No automatic inference retries occur.
Malformed/unknown/disabled categories, low confidence and classifier failures use
only the configured fallback and record the reason; a missing fallback blocks.

The OpenCode CLI owns provider login and account selection. Authenticate through
its supported interface before enabling classification; the AO worker's OpenCode
store may be different and must also be authorized. ADLC neither reads/copies login
stores nor exports tokens or creates provider access. Routing documents accept no
credential fields. Provider output/error payloads are not persisted as route errors.
Global/managed OpenCode configuration remains operator-controlled; verify its
policies and integrations before enabling the adapter. Classification is not a
container or an authorization to execute the task.

```sh
adlc routing PROJECT_CONFIG
adlc routing PROJECT_CONFIG /absolute/path/task.txt
adlc show-plan JOB
```

## Optional one-time import and rollback

Use a complete effective OpenChamber routing JSON document containing enabled,
minConfidence, fallback and categories. Sparse UI-only files must first be expanded
to their effective values; ADLC never executes OpenChamber source to discover defaults.
Preview is read-only and reports unsupported top-level settings by name, never value.
Invalid/unsupported nested routing fields block import rather than being ignored.
Classifier endpoints, credential sources, warming and UI automation are not imported.
The imported classifier is deliberately `off`; configure an authorized ADLC classifier
separately. Imported category IDs, descriptions, models, agents and efforts are preserved.

```sh
adlc routing-import /absolute/source.json /absolute/adlc-routing.json
adlc routing-import /absolute/source.json /absolute/adlc-routing.json --apply
```

The destination parent must exist. Apply creates a uniquely named backup of any
existing destination and uses a private same-directory temporary file plus rename
for atomic replacement. Source and destination must differ; the source is never
modified. Repeated imports require another explicit apply and create another backup;
there is no background synchronization. Restore the reported backup using a
same-directory temporary copy and rename, then preview effective settings again.
Atomic rename prevents partially visible JSON, not guaranteed recovery from power loss.
Keep backups private and outside Git. No installed runtime or existing job is
rewritten by import; activation of installed snapshots remains an operator action.

## Existing jobs and approval

Route records, policy snapshots and approval hashes retain their original serialized
values. Re-reading config never alters an existing phase binding. Implementation
approval still covers the exact route, plan and Git scope. Remediation uses the pinned
implementation policy (including classifier model), not newly edited settings.
Historical snapshots without an ADLC classifier use their pinned fallback for new
remediation rather than reading OpenChamber credentials. Historical jobs without
routing are not converted automatically. Legacy dataDir/runtimeDir settings are not
runtime adapters: migrate explicitly before selecting new phases on those jobs.

For an unstarted job awaiting approval only:

```sh
adlc routing-reconcile JOB PROJECT_CONFIG
adlc routing-reconcile JOB PROJECT_CONFIG --confirm PREVIEW_HASH
```

The confirmation rechecks the preview hash and job state, records the new snapshot,
and invalidates route approval. A changed classifier result requires a new preview.
Review `show-plan` and approve through the existing approval path again. Already
approved or dispatched implementations cannot be rerouted by this command; operator
reconciliation/replanning is required, never mutate stored approvals manually.
Model changes happen only between completed turns, with live model/effort/mode
verification before task delivery. Uncertain delivery is never blindly retried.
Routing grants no additional permissions; merges and deployment remain human-only.

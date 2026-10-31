# Shared OpenChamber task routing

ADLC reads OpenChamber's existing routing preferences rather than maintaining
another category/model list. It uses the installed OpenChamber effective-config
resolver (including built-in defaults and user overrides), the same Jev request
builder, the user's selected classifier and the configured confidence threshold.
The bridge does not edit OpenChamber preferences or classifier credentials.

## How a job runs

1. A new planning job selects the enabled Planning category from OpenChamber.
   Its model and effort are explicit; native OpenCode Plan mode is used.
2. The Orchestrator session is created without an initial task prompt. The host
   confirms its live model, effort and mode controls before delivering the plan
   request once, using a durable message identifier.
3. After a completed plan is captured, the original task is classified for the
   implementation stage. Ordinary implementation, exceptional engineering,
   test-focused work and other categories use their corresponding preferences.
4. `adlc show-plan JOB` displays both the plan hash and selected routes. The one
   approval records the exact implementation route as well as the plan and Git
   scope. A missing, stale or tampered route blocks execution.
5. Only between completed turns, the bridge selects the implementation model,
   applies its effort after selecting the model, and selects Build mode (or a
   supported user-configured Plan agent). It verifies the provider's response
   before sending the approved implementation request. The same session and
   worktree are retained; no extra Git worktree operations are introduced.
6. Bounded in-scope CodeRabbit remediation is classified as a request to fix the
   findings. Each head/findings combination receives a durable route decision.
   The effective routing policy approved for implementation is retained, so an
   edit to OpenChamber's preferences does not silently alter an approved run.

The existing CodeRabbit GitHub integration remains the PR reviewer. Choosing a
Code Review model here does not change CodeRabbit's own model or configuration.
Supporting tests inside a feature implementation do not create extra model turns;
Testing is selected when the classifier judges testing to be the primary task.

## Harness and authentication

Routed jobs use Orchestrator's `opencode-v2` harness for both the OpenAI and
OpenCode Go providers. This allows model/provider changes within one session.
The installed AO accepts model at spawn but rejects OpenCode effort at spawn;
the bridge therefore uses its native live config-options controls before delivery.
A provider or variant not offered by the live session blocks the task. There is
no silent substitution to Codex or to a different paid provider.

The user authorized native, in-memory transfer of existing OpenAI and OpenCode
Console credentials to Orchestrator's separate OpenCode store. The source
configuration was not rewritten, and no credential values were logged or saved
to bridge files. Each OpenCode instance subsequently owns its login lifecycle.
If a login expires, reconnect it and explicitly reconcile the affected worker;
a failed message is never resent automatically. Credential refresh can invalidate
an expired login in OpenCode, so a stored login is not proof of working inference.

Jobs created before routing retain their existing Codex sessions. Enabling
project routing does not restart or convert those jobs.

## Configuration and controls

The configured project's routing section typically points to:

- dataDir: ~/.config/openchamber
- runtimeDir: ~/Code/openchamber/packages/web/server/lib/routing
- harness: opencode-v2

The source model list stays in ~/.config/openchamber/routing.json. A new job/stage
reads fresh preferences, then pins its decision. The CLI requires the local
OpenChamber runtime modules and their existing dependencies; it installs none.
Changes to OpenChamber's runtime code take effect on the next one-shot service
invocation. Built-in Build and Plan agents are supported; other custom agents
block until a specific adapter is supplied.

```sh
adlc routing config/local.json
# Preview the classification of text in a file, without creating a job:
adlc routing config/local.json /absolute/path/task.txt
adlc show-plan JOB
adlc status
```

Low-confidence, malformed/unknown categories and classification request failures
use only OpenChamber's configured fallback, and record the reason. Disabled Auto,
invalid configuration, unsupported custom agents, unavailable live model/effort,
missing authentication and uncertain delivery never authorize a different model
or an automatic retry.

This adapter currently supports the selected Custom classifier, TypeSafe, and the
Zen promotional classifier without exporting provider credentials. Other classifier
credential sources require an explicit adapter. Provider credentials used by the
coding agent stay in OpenCode; the classifier key is read in memory by the existing
OpenChamber resolver. Neither is stored in route records or CLI output.

OpenChamber's UI-specific prompt-cache holding, warming and safety-net automation
are not replicated. ADLC keeps its own approval, Git scope, ownership and retry
rules. Selecting a category never grants permissions. Coding remains local;
Docker remains a separate verification option. Merges and deployment stay manual.

## Installed validation (October 31, 2026)

Enabled for the configured project after the bridge tests passed. A live Jev request selected
Implement → OpenAI GPT-6.1 Sol / medium for a copy-edit task. A standalone
Orchestrator diagnostic session completed read-only replies with GPT-6.1 Sol /
medium, then Go DeepSeek V4.1 Flash / low, then GPT-6 Luna / high in Plan mode.
No application or Git/GitHub changes were made by those diagnostics.

The first OpenAI requests exposed an expired login and an old selected account.
The user refreshed the source login. Native import creates a new credential ID;
the correct destination account was selected by matching the transferred login
in memory, then validated by real requests. Source provider settings were not
replaced. Old failed diagnostic turns are retained as evidence, not retried.

The complete routed Linear-ticket → plan approval → PR → CI/review flow has not
yet run live. The existing DEV-8/PR #108 session is intentionally not migrated.

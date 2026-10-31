# ADLC Bridge development

Run `bun test` for changes to orchestration, permissions, state transitions or recovery. Python launcher changes also need `python3 -m py_compile src/serve-orchestrator.py`.

Never merge PRs, enable auto-merge, bypass checks, or deploy. Keep credentials, local configuration, state databases and internal notes outside Git. Do not copy provider credentials or change global agent policies.

Workers use isolated feature worktrees. They may implement, commit/push the assigned feature branch and open its PR only under the ticket's recorded authorization. Never edit the main checkout, installed runtime snapshots, launchd definitions, live credentials or databases as part of a coding ticket. Propose migrations through reviewed code and explicit operator commands.

The live bridge runs a pinned installed snapshot. Source changes do not activate themselves. `adlc install --apply` is an operator action after review. Do not call install, runtime-install, stack controls, cleanup, or recovery from a coding worker unless the human explicitly assigned that operation.

No ADLC/ALDC skills may be invoked without explicit user authorization. Plan approval is required when the ticket has `plan-approval-required`. Preserve human-only merging in every path.

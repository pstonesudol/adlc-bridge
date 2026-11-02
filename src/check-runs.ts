// REST job IDs cannot establish logical-job identity across rerun attempts.
// Preserve raw checks, including failures and ambiguous duplicates. Do not add
// provenance reads that cannot safely change the result. The readiness gate
// still validates required names, apps, head, status and conclusion.
export function latestWorkflowChecks(checks:any[]){return checks;}

// Sanitized diagnostic shape from PR #66, run 43149259090/job 130957851310,
// head 6dc86b4: two test timeouts and a passing classifier test's synthetic CVE.
// Runner paths, timings and test titles are reduced; no credentials or raw log.
export const dev115Timeouts=`test/action-watchdog.test.ts:
(fail) idle ready-for-human polling [10049.41ms]
  ^ this test timed out after 10000ms.
test/update.test.ts:
(fail) frozen artifact reuse [6804.79ms]
  ^ this test timed out after 5000ms.
test/ci-failures.test.ts:
(pass) classifier transient: FAIL src/example.ts
HTTP 503 [0.01ms]
(pass) classifier unauthorized: FAIL src/example.ts
Permission denied [0.01ms]
(pass) classifier out_of_scope: FAIL src/example.ts
CVE-2026-123
(pass) classifier unknown: Process exited with code 1
2 tests failed:
`;

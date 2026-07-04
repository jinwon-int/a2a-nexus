# CodeQL triage — 2026-07 V1 organic observation round

Issue: [#1262](https://github.com/jinwon-int/a2a-nexus/issues/1262) under umbrella [#1261](https://github.com/jinwon-int/a2a-nexus/issues/1261)

Round: `a2a-nexus-v1-codeql-triage-20260704T080336Z`

Target revision at start: `bf294e23a2a51ebfa5149acfd6f0f1dc0bbe49fb`

## Summary

CodeQL open alerts were queried from GitHub code-scanning before the V1 round. The result set contained **21 open alerts**, and this document classifies all 21 without recording exploit detail, raw secrets, or private runtime data.

| Classification | Count | Meaning |
| --- | ---: | --- |
| `true_defect_fixed` | 3 | Real hardening issue in reachable/maintainer-run code; fixed in this PR. |
| `false_positive_hardened` | 2 | CodeQL finding is not exploitable in context, but the code was hardened to remove the pattern. |
| `false_positive` | 12 | Test assertion, fixture check, or sanitized wrapper; no security fix required. |
| `acceptable_risk` | 4 | Markdown/report rendering surface with bounded operator-facing output; keep as documented risk unless a later report-rendering hardening lane is opened. |
| **Total** | **21** | Matches GitHub code-scanning open alert count at triage time. |

## Per-alert disposition

| Alert | Rule | Location | Classification | Disposition / rationale | Follow-up |
| ---: | --- | --- | --- | --- | --- |
| 1 | `js/polynomial-redos` | `packages/openclaw-plugin-a2a/standalone-broker-client.ts` | `true_defect_fixed` | SSE frame-boundary trimming used a regex over broker-controlled stream chunks. Replaced with a linear newline-stripper and added a regression test with a long CRLF boundary. | Fixed in this PR. |
| 2 | `js/identity-replacement` | `packages/broker/scripts/refresh-drift-refs.mjs` | `false_positive_hardened` | `.replace(/T/, "T")` was a no-op timestamp normalization step, not a security issue. Removed the no-op while touching adjacent CodeQL findings. | Fixed in this PR. |
| 3 | `js/identity-replacement` | `scripts/archive/check-team1-ops-stability-standards-libero.test.mjs` | `false_positive` | Test-only `issue.replace('#', '#')` expression is an inert historical assertion helper. No runtime exposure. | None. |
| 4 | `js/identity-replacement` | `scripts/archive/check-team1-workerDelta-terminal-brief-activation-libero.test.mjs` | `false_positive` | Test-only inert assertion helper. No runtime exposure. | None. |
| 5 | `js/identity-replacement` | `scripts/archive/check-team2-final-go-no-go-semantics-libero.test.mjs` | `false_positive` | Test-only inert assertion helper. No runtime exposure. | None. |
| 6 | `js/identity-replacement` | `scripts/archive/check-team2-terminal-brief-activation-libero.test.mjs` | `false_positive` | Test-only inert assertion helper. No runtime exposure. | None. |
| 7 | `js/identity-replacement` | `scripts/check-a2a-allhands-stability-closeout-gates.test.mjs` | `false_positive` | Test-only inert assertion helper. No runtime exposure. | None. |
| 8 | `js/incomplete-sanitization` | `packages/broker/scripts/a2ad-evidence-classifier.mjs` | `acceptable_risk` | Markdown table cell rendering escapes pipes/newlines for local classifier reports. It is bounded report output, not an HTML or shell boundary. | Consider a general Markdown-cell encoder lane only if report injection becomes a product boundary. |
| 9 | `js/incomplete-sanitization` | `packages/broker/scripts/refresh-drift-refs.mjs` | `true_defect_fixed` | Maintainer-run script built a regex from repo identifiers. Current constants are safe, but future repo values should be regex-escaped. Added `escapeRegExp`. | Fixed in this PR. |
| 10 | `js/incomplete-sanitization` | `packages/broker/scripts/refresh-drift-refs.mjs` | `true_defect_fixed` | Same dynamic-regex issue as #9 for pinned ref replacement. Added `escapeRegExp`. | Fixed in this PR. |
| 11 | `js/incomplete-sanitization` | `packages/broker/scripts/round-closeout-report.mjs` | `acceptable_risk` | Markdown table renderer for local closeout snapshots escapes pipes. Output is local/operator-facing and not used as a browser HTML trust boundary. | Optional report-rendering hardening lane. |
| 12 | `js/incomplete-sanitization` | `packages/broker/scripts/terminal-brief-activation-report.mjs` | `acceptable_risk` | Markdown report output with bounded operator data; no command/HTML execution boundary. | Optional report-rendering hardening lane. |
| 13 | `js/incomplete-sanitization` | `packages/broker/scripts/terminal-receipt-closeout-report.mjs` | `acceptable_risk` | Markdown report output with bounded operator data; no command/HTML execution boundary. | Optional report-rendering hardening lane. |
| 14 | `js/incomplete-url-substring-sanitization` | `packages/broker/scripts/caddy-log-redaction-preflight.test.mjs` | `false_positive` | Test scans a static Caddy fixture for secret-looking strings and allow-lists the fixture host line. No URL sanitizer or runtime trust boundary. | None. |
| 15 | `js/incomplete-url-substring-sanitization` | `packages/docker-runner/src/integration.test.ts` | `false_positive` | Test assertion verifies a stale PR URL is absent from generated evidence. No sanitizer boundary. | None. |
| 16 | `js/incomplete-url-substring-sanitization` | `packages/docker-runner/src/runner.test.ts` | `false_positive` | Test assertion checks that extracted PR URL contains GitHub and `/pull/99`. No security decision uses the substring check. | None. |
| 17 | `js/incomplete-url-substring-sanitization` | `packages/docker-runner/src/task-normalizer.test.ts` | `false_positive` | Test assertion confirms generated PR body includes the issue URL. No URL sanitizer boundary. | None. |
| 18 | `js/incomplete-url-substring-sanitization` | `test/conformance/check-adapter-conformance-matrix.mjs` | `false_positive` | Conformance test asserts fixture metadata includes a known GitHub issue URL. No sanitizer boundary. | None. |
| 19 | `js/incomplete-url-substring-sanitization` | `test/conformance/check-adapter-conformance-matrix.mjs` | `false_positive` | Same fixture metadata assertion pattern as #18. | None. |
| 20 | `js/stack-trace-exposure` | `packages/broker/src/http/response.ts` | `false_positive` | `sendJson` is a generic serializer. Broker error mapping sends `BrokerError` code/message/details or a fixed `internal_error` message for unknown errors; it does not serialize `Error.stack`. | None. |
| 21 | `js/shell-command-injection-from-environment` | `packages/broker/scripts/caddy-log-redaction-preflight.test.mjs` | `false_positive_hardened` | Test helper used `execSync` string interpolation with constant local path and test-controlled args. Switched to `execFileSync(process.execPath, [script, ...args])` to remove the shell pattern. | Fixed in this PR. |

## V1 gate-dogfooding observations

Dispatch manifest `a2a-nexus-v1-codeql-triage-20260704T080336Z` populated all analysis lanes with:

- `acceptance` commands and expected evidence,
- `declaredScope.paths`,
- `evidenceGate` requiring 21-alert coverage and integer counts,
- non-empty `sourceBundle.files[]` with required source projection paths,
- no-live/no-deploy/no-restart/no-provider/no-DB/no-ACK boundaries.

The round intentionally uses real CodeQL triage as the first organic post-`176a788` source-only workload, so its worker task readbacks are the input for #1257 error-code counts and #1263 enforcement decisions.

### A2A worker readback summary

Two all-worker source-only rounds were dispatched across Team1 and Team2:

| Round | Team | Terminal readback | Notes |
| --- | --- | ---: | --- |
| R1 | Team1 | 5/5 | Four lanes failed closed with `source_projection_blocked`; one mobile lane failed with `acceptance_malformed` due an invalid acceptance shape in the first manifest. |
| R1 | Team2 | 5/5 dispatched | Dispatch succeeded, but readback collection initially failed because the local readback helper had not been copied onto the second broker node. |
| R2 | Team1 | 5/5 | One lane returned a bounded `analysisStatus=blocked`; three lanes failed closed with `source_projection_blocked`; one lane failed through the OpenClaw analysis adapter. |
| R2 | Team2 | 4/5 by readback cutoff | Two lanes produced `analysisStatus=done`; two lanes failed closed through the handler; one mobile lane remained queued at cutoff. |

Dogfooding result: the V1 workload produced the intended real readback data for the #1261 V2/V3 track. Substantive CodeQL triage was confirmed by local analysis and two Team2 lanes, while the remaining failures are recorded as projection/adapter readiness signals rather than counted as worker opinions.

## Security disclosure boundary

This document records alert IDs, high-level classifications, and remediation disposition only. It does not include exploit instructions, secrets, production payloads, or private runtime logs.

# Harness-neutral analysis adapter contract

This contract freezes the source-only analysis evidence shape used by A2A/A2AD rounds. It exists so the broker/finalizer can classify worker evidence without depending on a specific harness such as Hermes CLI, OpenClaw CLI, or the Docker runner.

Issue: [a2a-nexus#666](https://github.com/jinwon-int/a2a-nexus/issues/666)
Parent direction: [a2a-nexus#663](https://github.com/jinwon-int/a2a-nexus/issues/663)

## Scope

This is a source-only/no-live contract. It does not authorize production deploys, Gateway/broker/worker restarts, provider sends, Terminal ACK/replay, DB mutation, release/tag/npm/Docker publish, secret movement, repo visibility changes, history rewrite, or force-push.

The contract applies to `intent=analyze` tasks where the operator/finalizer expects source review, issue triage, PR review, or design-review evidence.

## Required task inputs

A source-only analysis task MUST carry enough harness-neutral context for the worker adapter to decide whether it can produce substantive evidence:

- `intent: "analyze"`.
- `taskOrigin: "github"` when the task depends on GitHub issue/PR/source evidence.
- `payload.noLive: true`.
- `payload.sourceOnly: true`.
- `payload.readOnlyValidation: true`.
- Top-level `parentRoundId`, `parentRoundTotal`, and `parentRoundOrder` for round grouping.
- The same round metadata duplicated in `payload` when broker payload validation requires it.
- `payload.originBrokerId` and `payload.brokerOfRecordId`.
- At least one source-evidence carrier:
  - `payload.repo` plus repo-relative `paths`/`sourceHints`; or
  - `payload.sourceBundle.files[]`; or
  - `payload.sourceEvidence[]`; or
  - explicit GitHub PR/issue refs the adapter can fetch read-only.

Adapters MAY add harness-specific fields, but finalizer classification MUST NOT require them.

## Required adapter output

The adapter output SHOULD be JSON or be convertible to JSON with these fields:

- `analysisStatus`: one of `done`, `wrapper_only`, `source_blocked`, `handler_artifact_failure`, `queued_unclaimed`, `provider_or_model_failure`.
- `evidenceClass`: one of `substantive`, `readiness_only`, `generic_ack`, `wrapper_only`, `source_blocked`, `handler_artifact_failure`, `queued_unclaimed`, `provider_or_model_failure`.
- `summary`: short human-readable result.
- `findings[]`: concrete findings, each with severity, title, evidence refs, and recommendation when applicable.
- `risks[]`: optional risks or caveats.
- `recommendations[]`: concrete next actions.
- `evidenceRefs[]`: GitHub issue/PR numbers, file paths, task ids, or fixture ids used as evidence.

If the adapter cannot inspect source or cannot run the model bridge, it MUST return a blocked/failure class. It MUST NOT echo the prompt or return a generic wrapper success as substantive analysis.

## Evidence classification

Finalizers and round collectors MUST classify lanes as follows:

- `substantive`: `analysisStatus=done`, file/issue/PR-backed findings or recommendations exist, and the output distinguishes evidence from assumptions.
- `readiness_only`: the lane proves source readability, no-live/source-only boundary, source-projection budget/quality, or bridge health, but does not answer the requested issue/PR/design question. Count as dispatch/readiness evidence only.
- `generic_ack`: the lane only acknowledges task acceptance/completion (for example “analysis bridge done” or “task accepted”) without task-specific findings, risks, recommendations, or evidence. Count as liveness evidence only.
- `wrapper_only`: the adapter only proves task lifecycle/plumbing, e.g. “analysis-only completed”, “reference worker dry-run completed”, or prompt echo without analysis. Count as liveness only.
- `source_blocked`: repo roots, source bundles, GitHub refs, or embedded evidence were missing/unreadable/truncated. Do not infer a code/design opinion.
- `handler_artifact_failure`: the worker adapter or model bridge could not execute because of local artifact/path/permission/runtime failure, e.g. `EACCES`, missing executable, missing cwd, or `spawn ... ENOENT`.
- `queued_unclaimed`: the broker created or queued the task but no worker claimed it by the finalizer deadline.
- `provider_or_model_failure`: the adapter launched but the model/provider returned invalid JSON, auth failure, null exit, timeout, or other non-substantive model failure.

## Finalizer rules

- Count only `substantive` lanes as worker opinions.
- Preserve wrapper/blocked/failed lanes as operational evidence and link them to preflight/bridge issues when needed.
- A synthesis candidate is not an automatic winner. The finalizer compares thesis, antithesis, ordinary alternatives, direct source verification, and approval boundaries.
- For PR/issue closeout, use `Closes` only for issues fully satisfied by the PR. Use `Refs` for partial progress or approval-gated follow-up.

## Conformance fixture

The frozen fixture is [`fixtures/contract/harness-neutral-analysis-adapter.json`](../../fixtures/contract/harness-neutral-analysis-adapter.json). It covers these mandatory scenarios:

1. substantive analysis;
2. readiness-only success;
3. generic acknowledgement success;
4. wrapper-only success;
5. source-mapping blocked;
6. handler artifact failure;
7. queued/unclaimed lane;
8. provider/model failure.

Run:

```sh
node test/conformance/check-contract-fixtures.mjs
```

# Complexity execution plan draft

`npm run orchestration -- complexity_execution_plan_draft` converts a finalizer approval envelope
draft into a deterministic, source-only execution plan draft. It sits after the
complexity classifier, orchestration recommendation, and finalizer approval
envelope stages:

```text
task input -> complexity recommendation -> approval envelope -> execution plan draft
```

The output is an operator-review artifact only. It never grants approval,
dispatches workers, spawns subagents, creates broker tasks, mutates TaskFlow or
DB state, sends providers, ACKs Terminal Briefs, deploys, restarts services, or
publishes a release.

## Local command

Markdown output:

```bash
npm run orchestration -- complexity_execution_plan_draft \
  --input fixtures/complexity-execution-plan-draft/complex-parallel-envelope.json
```

JSON output:

```bash
npm run orchestration -- complexity_execution_plan_draft \
  --input fixtures/complexity-execution-plan-draft/critical-blocked-envelope.json \
  --json \
  --now 2026-06-01T12:00:00.000Z
```

## Fixtures

The fixture set is synthetic and intentionally no-live:

- `simple-autonomous-envelope.json` -> direct execution draft with no approval
  needed.
- `moderate-sequential-envelope.json` -> operator-approval-gated sequential
  subagent draft.
- `complex-parallel-envelope.json` -> operator-approval-gated parallel subagent
  draft.
- `critical-blocked-envelope.json` -> operator-review-gated draft with
  autonomous execution blocked.

Each fixture has a matching `*-plan.json` expected output artifact. These
artifacts are display and regression evidence only; they are not approval
receipts.

## Safety rules

- Unknown envelope categories fail closed with `plan_safety_blocked`.
- `operator_review_required` remains blocked and never becomes autonomous
  execution.
- `operator_approval_required` can describe requested subagent steps, but the
  plan itself does not grant approval or dispatch those steps.
- All no-live boundary flags remain false, including DB mutation, TaskFlow
  mutation, provider send, Terminal ACK, deploy/restart, release, and credential
  movement.
- Runtime/bootstrap context files must not be included in fixtures, PR evidence,
  or generated artifacts.

# A2A Hybrid Worker Mode Design

This source-only design defines `a2a_hybrid`: a broker task is claimed by one
worker, that worker may run bounded internal roles, and the worker returns one
synthesized evidence packet to the broker/finalizer.

This document does not enable production subagent spawning, dispatch workers,
restart services, mutate databases, ACK or replay Terminal Brief rows, send
providers, publish releases, move credentials, or change repository visibility.

## Semantics

```text
broker task
  -> one A2A worker claims task
      -> implement role
      -> validate or skeptic role
      -> evidence or test role
  -> worker returns one synthesized evidence packet
  -> broker/finalizer decides
```

`a2a_hybrid` is not a second finalizer. Internal roles produce evidence only.
The broker or named finalizer still owns merge, closeout, approval, and runtime
decisions.

## Role Names

| Role | Purpose | Output |
| --- | --- | --- |
| `implement` | Make the scoped change or draft the proposed artifact. | Candidate patch, doc, or plan reference. |
| `validate` | Run tests, inspect risks, and check acceptance criteria. | Validation notes and command evidence. |
| `skeptic` | Challenge assumptions, coupling, approval boundaries, and failure modes. | Risk and opposition notes. |
| `evidence` | Assemble a concise source-only evidence packet. | One synthesized packet for the worker result. |
| `finalizer` | Compare evidence and decide merge, defer, block, or close. | Broker/finalizer decision, not a worker-internal subagent decision. |

## Evidence Packet

```json
{
  "workMode": "a2a_hybrid",
  "workerId": "workereta",
  "taskId": "example",
  "roles": ["implement", "validate", "evidence"],
  "synthesizedEvidence": {
    "summary": "...",
    "commands": ["npm test"],
    "artifacts": ["https://github.com/owner/repo/pull/123"],
    "risks": ["..."],
    "approvalRequired": false
  },
  "finalizerRequired": true,
  "workerFinalDecision": false
}
```

The packet must contain one synthesized worker answer. It must not submit
multiple conflicting final decisions.

## Routing

Use `a2a_hybrid` only after a selector or planning record shows:

- task size is medium or large;
- roles are separable;
- validation, opposition, or evidence assembly can reduce rework;
- broker health is not degraded;
- finalizer ownership is explicit;
- approval-gated live actions are absent or separately approved.

Do not use `a2a_hybrid` for small tasks unless a benchmark record shows a
specific benefit. The current no-live fixture keeps small tasks on `solo` or
`a2a_direct`.

## Benchmark Gate

Run the source-only benchmark checker:

```bash
npm run a2a_hybrid_worker_mode_benchmark -- \
  --input fixtures/a2a-hybrid-worker-mode/no-live-benchmark-2026-06-07.json
```

The checker verifies:

- small samples do not enable `a2a_hybrid`;
- medium and large `a2a_hybrid` samples improve at least one of evidence
  completeness, finalizer review time, defect/rework count, or wall-clock time
  against `solo` or `a2a_direct`;
- broker route p95 stays `<= 2s`;
- broker route p99 stays `<= 5s`;
- all samples are marked source-only and no-live.

## Related

- `docs/a2a-adaptive-work-mode-selector.md`
- `docs/worker-subagent-orchestration-policy.md`
- `docs/a2a-work-mode-benchmark-v1.md`
- `jinwon-int/a2a-broker#1320`

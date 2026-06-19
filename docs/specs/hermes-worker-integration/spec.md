# Feature Spec: Hermes Broker-Agnostic Worker Contract

## Problem

Hermes Agent and other non-OpenClaw runtimes need a small, public-safe worker contract for A2A broker participation without depending on OpenClaw Gateway internals, Telegram/provider state, or production node configuration.

## User / operator stories

- As a Hermes worker author, I can register a worker identity, heartbeat, poll assigned pending work, and post terminal evidence over HTTP.
- As a broker maintainer, I can verify that the existing worker registry accepts non-OpenClaw metadata without adding runtime-specific fields.
- As an operator, I can review the contract without triggering production deploys, broker restarts, live canaries, database mutation, terminal ACK/replay, or secret exposure.

## Scope

### In scope

- Document the minimal worker registration payload: nodeId, role, displayName, capabilities, workerMode, metadata, and brokerUrl.
- Document heartbeat refresh with POST /workers/:nodeId/heartbeat.
- Provide a broker-agnostic polling alias: GET /tasks?worker=<nodeId>&status=pending, mapped to the existing assigned-worker queued task read model.
- Provide a terminal evidence alias: POST /tasks/:id/evidence, mapped to existing task completion/failure behavior.
- Add local server validation that a Hermes-style worker can register, heartbeat, poll, claim/start, and post redacted terminal evidence.

### Out of scope

- Hermes Agent native tool implementation.
- Live worker registration against production broker.
- Production broker/Gateway/worker restart or deploy.
- Live provider or Telegram canary.
- Production database, queue, or terminal-outbox mutation.
- Manual terminal ACK/replay or historical replay.
- OpenClaw plugin SDK changes.
- Secret movement, credential disclosure, release/tag, or repository visibility changes.

## Minimal worker API

### Register

    POST /workers/register
    content-type: application/json

    {
      "nodeId": "hermes-agent-reference-worker",
      "role": "analyst",
      "displayName": "Hermes Agent Reference Worker",
      "brokerUrl": "http://127.0.0.1:8787",
      "workerMode": "mobile",
      "capabilities": {
        "canAnalyze": true,
        "canBackfill": false,
        "canPatchWorkspace": true,
        "canPromoteLive": false,
        "workspaceIds": ["public-safe-reference"],
        "environments": ["research"]
      },
      "metadata": {
        "runtime": "hermes-agent",
        "openClawRequired": "false",
        "transport": "http-poll"
      }
    }

### Heartbeat

    POST /workers/hermes-agent-reference-worker/heartbeat
    content-type: application/json

    {
      "metadata": {
        "runtime": "hermes-agent",
        "heartbeat": "ok"
      }
    }

Heartbeat may refresh displayName, brokerUrl, capabilities, workerMode, or metadata. Missing fields keep their prior values.

### Poll assigned pending work

    GET /tasks?worker=hermes-agent-reference-worker&status=pending

Compatibility mapping:

- worker=<nodeId> is an alias for assignedWorkerId=<nodeId>.
- status=pending is an alias for the broker's existing internal queued status.
- detail=full may be added by local tools that need the complete task record.

### Claim, start, and post evidence

Workers keep the existing lifecycle sequence:

    POST /tasks/:id/claim
    POST /tasks/:id/start
    POST /tasks/:id/evidence

Terminal evidence request:

    {
      "workerId": "hermes-agent-reference-worker",
      "outcome": "done",
      "result": {
        "summary": "Hermes-style worker produced redacted terminal evidence",
        "output": {
          "referenceWorker": "hermes-agent",
          "openClawRequired": false
        }
      }
    }

outcome=done and outcome=pr succeed the task. outcome=blocked and outcome=failed fail the task with redacted error evidence.

## Minimal A2AAdapter conformance path

For #918/#922, the smallest Hermes/native adapter path is the HTTP worker sequence above mapped to
`A2AAdapter` operations:

| A2AAdapter category | Hermes/native HTTP operation | Notes |
| --- | --- | --- |
| claim/poll | `GET /tasks?worker=<nodeId>&status=pending`, then `POST /tasks/:id/claim` | Polling and claiming happen before any mutable work. |
| report status | `POST /tasks/:id/start`, then terminal evidence outcome mapping | Status acceptance is not an operator ACK. |
| heartbeat | `POST /workers/:nodeId/heartbeat` | Uses redacted runtime/health metadata only. |
| terminal evidence | `POST /tasks/:id/evidence` | Evidence is compact, redacted, and non-ACK. |
| idempotency/dedupe | broker idempotency key / terminal evidence dedupe key | Replays return existing evidence or conflict. |
| fail-closed redaction | local evidence redaction gate before broker submission | Unsafe evidence becomes classified Block evidence. |

This path does not require the OpenClaw plugin SDK, Hermes CLI internals, Docker runner state, live
provider sends, database mutation, or terminal-outbox ACK/replay. The contract fixture is
`fixtures/contract/adapter-conformance-matrix.json` and is validated with
`node test/conformance/check-adapter-conformance-matrix.mjs`.

## Success criteria

- [x] Existing registerWorker/heartbeatWorker fields can represent a non-OpenClaw worker.
- [x] HTTP worker polling can use worker and pending terms without knowing the broker's internal assignedWorkerId/queued names.
- [x] HTTP terminal evidence can use a single /tasks/:id/evidence route while preserving existing task lifecycle semantics.
- [x] A local server test covers the Hermes-style registration, heartbeat, poll, claim/start, and evidence flow.
- [x] The change performs no live production action.

## Safety and approval boundaries

This contract is source-only. It does not approve or perform production registration, broker/Gateway/worker deploys or restarts, live provider sends, database or terminal-outbox mutation, manual ACK/replay, release/tag publication, repository visibility changes, secret rotation, or credential disclosure.

## Rollback

Revert the docs and HTTP compatibility aliases. No production state is created.


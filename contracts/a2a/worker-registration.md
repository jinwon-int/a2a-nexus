# Worker Registration and Read-Model Assumptions (v0 Freeze)

> **v0 Freeze (2026-05-09):** Publishable fields, capability labels, and read-model assumptions are frozen.
> New registration fields or capability semantics require a v0→v1 compatibility plan.

Worker registration data must remain stable and public-safe across the monorepo import. This file names the assumptions expected by broker read models and worker-facing tooling.

## Worker registration fields

- `workerName`: stable public-safe identifier, not a host name or private path.
- `capabilities`: coarse labels such as `docs`, `contracts`, `repo-inspection`, or `tests`.
- `policyVersion`: safety policy version understood by the worker.
- `lastSeenAt`: timestamp used for liveness display only; not proof of terminal delivery.
- `currentTaskId`: optional task reference for in-progress visibility.

## Broker-agnostic HTTP worker fields

The broker worker API also accepts runtime-neutral HTTP worker registration records for non-OpenClaw workers such as Hermes Agent reference workers:

- `nodeId`: stable public-safe worker id.
- `role`: A2A party role, usually `analyst` for worker execution.
- `displayName`: human-readable public-safe worker label.
- `brokerUrl`: local/test broker endpoint advertised by the worker; never include private production endpoints in public fixtures.
- `capabilities`: normalized `WorkerCapabilities` object with booleans plus `workspaceIds` and `environments`.
- `metadata`: string-only public-safe hints such as `runtime=hermes-agent`, `transport=http-poll`, and `openClawRequired=false`.

`workerMode` is **retired** (#2065). The registration/heartbeat request schema
still tolerates the field on the wire (lenient passthrough validation), but the
broker no longer persists it, does not echo it in worker views, and derives no
behavior from it. New integrations must not send it.

The read-only `a2a.peer.status` view uses one common window for every worker:
`workerOfflineAfterMs ?? DEFAULT_WORKER_OFFLINE_AFTER_MS` (default 90,000 ms),
plus 10 advisory busy slots. There is no mode-specific window and no
mobile-only override; explicit zero and longer `workerOfflineAfterMs` values
remain valid constructor overrides. Busy slots count active plus queued tasks
and do not set executor concurrency or grant task admission. Registration,
policy classes, and fast-lane eligibility do not read any worker mode. The
`/dashboard` and `GET /workers/capacity` projections resolve the same common
window pattern and synthesize no mobile-specific fields. See the
[peer-status contract](../../packages/broker/docs/phase-8-peer-status-rfc.md#25-worker-capacity-and-advisory-slots).

Generic worker task polling may use `GET /tasks?worker=<nodeId>&status=pending`. The server maps this to the existing `assignedWorkerId=<nodeId>&status=queued` read model. Generic terminal evidence may use `POST /tasks/:id/evidence`; `done` and `pr` outcomes complete the task, while `blocked` and `failed` outcomes fail it with redacted error evidence.

## Stable read-model assumptions

- Read models may show queued, claimed, running, and terminal tasks without exposing private infrastructure details.
- Read models must distinguish provider-send status from terminal Done/Block/PR evidence.
- Read models must not infer terminal ACK from Telegram/provider delivery responses.
- Worker names and capability labels are safe to publish only after a public-readiness scan confirms they contain no private topology or credentials.

## Import notes

During sanitized/squash imports, preserve public-safe names and capability labels, but re-disposition any private host names, local paths, provider IDs, and secret-shaped values before they enter this repository.

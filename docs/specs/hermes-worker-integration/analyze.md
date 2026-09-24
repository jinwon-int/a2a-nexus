# Analysis: Hermes Broker-Agnostic Worker Contract

## Current broker support

Repository inspection shows the broker already has a runtime-neutral worker record:

- packages/broker/src/core/types.ts defines RegisterWorkerRequest with nodeId, role, displayName, brokerUrl, capabilities, and metadata (the `workerMode` field this analysis originally listed was later retired by #2065; brokers tolerate but drop it).
- packages/broker/src/core/broker.ts stores worker registration through registerWorker without OpenClaw-only fields.
- heartbeatWorker can refresh displayName, brokerUrl, capabilities, and metadata.
- packages/broker/src/server.ts exposes POST /workers/register, POST /workers/:nodeId/heartbeat, GET /tasks, and task lifecycle routes.

## Gaps closed in Phase 1

Before this Phase 1 patch, a generic HTTP worker had to know A2A's internal task query terms:

- assigned work used assignedWorkerId=<nodeId>;
- pending work used the internal queued task status;
- terminal evidence used /tasks/:id/complete or /tasks/:id/fail.

Phase 1 adds public worker-friendly aliases while keeping the existing internal semantics:

- GET /tasks?worker=<nodeId>&status=pending maps to assignedWorkerId=<nodeId>&status=queued.
- POST /tasks/:id/evidence maps done/pr to completeTask and blocked/failed to failTask.

## Validation evidence

packages/broker/src/server.test.ts now covers a Hermes-style worker that:

1. registers with runtime=hermes-agent, openClawRequired=false, and transport=http-poll metadata;
2. heartbeats without OpenClaw/Gateway/provider fields;
3. polls pending work through the broker-agnostic worker and pending aliases;
4. claims and starts the task through the existing lifecycle;
5. posts redacted terminal evidence through /tasks/:id/evidence.

## Safety boundary

This analysis used repository inspection and local tests only. It did not perform production broker registration, production deploy/restart, Gateway restart, live provider/Telegram send, production database or terminal-outbox mutation, manual ACK/replay, release/tag publication, repository visibility changes, secret movement, or credential disclosure.


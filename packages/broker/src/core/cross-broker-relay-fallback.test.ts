// #2339 PR-5 (contract routing gate 5): a child brief that the parent broker
// permanently rejects gets one child-local operator row, explicitly labelled
// "Terminal Brief relay failure" and never rendered as a parent-round title.
import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryA2ABroker } from "./broker.js";
import {
  buildCrossBrokerTerminalBriefProjectionFromEvent,
  pollCrossBrokerTerminalBriefReceiver,
  type CrossBrokerTerminalBriefReceiverFetch,
} from "./completion/cross-broker-terminal-brief-receiver.js";
import type { CrossBrokerTerminalBriefProjectionRequest } from "./completion/cross-broker-terminal-brief.js";
import type { TaskStatusEvent } from "./transport/task-events.js";
import {
  TerminalTaskEventOutbox,
  buildRelayFallbackTitle,
  type TerminalTaskOutboxEvent,
} from "./completion/terminal-event-outbox.js";
import type { CreateTaskRequest, TaskRecord } from "./types.js";
import { jsonHeaders, startTestServer } from "../server-test-helpers.js";

const WORKER = "workerA";
const PARENT = "brokeralpha";
const CHILD = "brokerbeta";
const ROUND = "brokeralpha-parent-round";

function parentOwnedTask(id = "child-task-1", worker = WORKER): TaskRecord {
  return {
    id,
    intent: "propose_patch",
    brokerOfRecord: CHILD,
    assignedWorkerId: worker,
    payload: {
      parentRoundId: ROUND,
      parentRoundTotal: 3,
      parentRoundOrder: 2,
      originBrokerId: PARENT,
      brokerOfRecordId: PARENT,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: ROUND,
        originBrokerId: PARENT,
        handoffBrokerId: CHILD,
        childWorkerId: worker,
        originTaskId: "brokeralpha-parent-task-1",
      },
      notificationOwnership: { owner: "parent", ownerBrokerId: PARENT, scope: "parent-broker-only" },
    },
    artifactIds: [],
    status: "succeeded",
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:05.000Z",
    completedAt: "2026-10-23T00:00:05.000Z",
  } as unknown as TaskRecord;
}

function localTask(id = "local-task-1"): TaskRecord {
  return {
    id,
    intent: "chat",
    brokerOfRecord: CHILD,
    assignedWorkerId: WORKER,
    payload: {},
    artifactIds: [],
    status: "succeeded",
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:05.000Z",
    completedAt: "2026-10-23T00:00:05.000Z",
  } as unknown as TaskRecord;
}

function statusEvent(task: TaskRecord): TaskStatusEvent {
  return {
    id: 11,
    timestamp: task.completedAt ?? task.updatedAt,
    taskId: task.id,
    kind: "succeeded",
    status: task.status,
  } as unknown as TaskStatusEvent;
}

function childOutboxWithParentOwnedEvent(): { outbox: TerminalTaskEventOutbox; source: TerminalTaskOutboxEvent } {
  const outbox = new TerminalTaskEventOutbox({ brokerId: CHILD, knownBrokerIds: [PARENT] });
  const task = parentOwnedTask();
  const source = outbox.enqueue(statusEvent(task), task);
  assert.ok(source);
  assert.equal(source.payload.notificationOwnership?.scope, "parent-broker-only");
  return { outbox, source };
}

test("PR-5 fallback row drops parent ownership and every round field, and uses the contract label", () => {
  const { outbox, source } = childOutboxWithParentOwnedEvent();

  const result = outbox.enqueueRelayFallback({
    sourceEventId: source.id,
    lastErrorCode: "missing_parent",
    lastErrorReason: "parent round is not present on this broker",
    at: "2026-10-23T00:01:00.000Z",
  });

  assert.equal(result.status, "created");
  assert.ok(result.status === "created");
  const row = result.event;
  assert.equal(row.id, `terminal:${encodeURIComponent(`fallback:${source.id}`)}`);
  assert.equal(row.payload.taskId, "child-task-1");
  assert.equal(row.payload.worker, WORKER);
  assert.equal(row.payload.terminalBriefTitle, `A2A Terminal Brief relay failure: ${WORKER} (missing_parent)`);
  assert.equal(row.payload.title, row.payload.terminalBriefTitle);
  assert.doesNotMatch(row.payload.terminalBriefTitle ?? "", /\d+\/\d+/, "no parent-round n/N");
  for (const field of [
    "parentRoundId",
    "run",
    "parentRoundTotal",
    "parentRoundOrder",
    "parentRoundProgress",
    "parentRoundTerminalProgress",
    "notificationOwnership",
    "crossBrokerHandoff",
  ] as const) {
    assert.equal(row.payload[field], undefined, `${field} must not be on the fallback row`);
  }
  assert.equal(row.payload.brokerOfRecordId, CHILD, "the child broker owns the fallback notice");
  assert.deepEqual(row.payload.relayFallback, {
    scope: "local-fallback",
    reason: "permanent_destination_reject",
    attempts: 1,
    lastErrorCode: "missing_parent",
    lastErrorReason: "parent round is not present on this broker",
    parentRoundId: ROUND,
    parentBrokerId: PARENT,
    sourceEventId: source.id,
  });
  assert.equal(row.receipt.status, "accepted");
  assert.equal(row.ack, undefined);
  assert.equal(
    buildCrossBrokerTerminalBriefProjectionFromEvent(row, { sourceBrokerId: CHILD, destinationBrokerId: PARENT }),
    null,
    "the fallback row is never relayed again",
  );
});

test("PR-5 fallback is idempotent per source event, including after a snapshot restore", () => {
  const { outbox, source } = childOutboxWithParentOwnedEvent();
  const first = outbox.enqueueRelayFallback({ sourceEventId: source.id, lastErrorCode: "missing_parent" });
  const second = outbox.enqueueRelayFallback({ sourceEventId: source.id, lastErrorCode: "routing_mismatch" });

  assert.equal(first.status, "created");
  assert.equal(second.status, "replayed");
  assert.ok(first.status === "created" && second.status === "replayed");
  assert.equal(second.event?.id, first.event.id);
  assert.equal(second.event?.payload.relayFallback?.lastErrorCode, "missing_parent", "the first reject wins");
  assert.equal(outbox.subscribe().filter((event) => event.payload.relayFallback).length, 1);

  const restored = new TerminalTaskEventOutbox({ brokerId: CHILD, events: outbox.snapshot() });
  const afterRestore = restored.enqueueRelayFallback({ sourceEventId: source.id, lastErrorCode: "missing_parent" });
  assert.equal(afterRestore.status, "replayed");
  assert.deepEqual(
    restored.subscribe().find((event) => event.payload.relayFallback)?.payload.relayFallback,
    first.event.payload.relayFallback,
  );
});

test("PR-5 fallback refuses unknown and never-relayed source events", () => {
  const outbox = new TerminalTaskEventOutbox({ brokerId: CHILD, knownBrokerIds: [PARENT] });
  const local = localTask();
  const localEvent = outbox.enqueue(statusEvent(local), local);
  assert.ok(localEvent);

  assert.deepEqual(
    outbox.enqueueRelayFallback({ sourceEventId: "terminal:does-not-exist", lastErrorCode: "missing_parent" }),
    { status: "source_not_found" },
  );
  assert.deepEqual(
    outbox.enqueueRelayFallback({ sourceEventId: localEvent.id, lastErrorCode: "missing_parent" }),
    { status: "not_relayed" },
    "a locally owned brief is already notified locally; a fallback would duplicate it",
  );
  assert.equal(outbox.size, 1);
});

test("PR-5 fallback title stays within 80 characters and closed-set codes", () => {
  const long = buildRelayFallbackTitle("w".repeat(200), "missing_dispatch_metadata");
  assert.ok(long.length <= 80, `title is ${long.length} chars`);
  assert.match(long, /^A2A Terminal Brief relay failure: w+ \(missing_dispatch_metadata\)$/);

  const { outbox, source } = childOutboxWithParentOwnedEvent();
  const result = outbox.enqueueRelayFallback({ sourceEventId: source.id, lastErrorCode: "Bad Code <script>" });
  assert.ok(result.status === "created");
  assert.equal(result.event.payload.relayFallback?.lastErrorCode, "unknown");
  assert.equal(result.event.payload.terminalBriefTitle, `A2A Terminal Brief relay failure: ${WORKER} (unknown)`);
});

test("PR-5 broker counts only newly created fallback rows", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: CHILD, knownBrokerIds: [PARENT] });
  const source = completeParentOwnedChild(broker);

  assert.deepEqual(broker.getCrossBrokerRelayFallbackDiagnostics(), { relayFallbackLocal: 0 });
  assert.equal(broker.recordCrossBrokerRelayFallback({ sourceEventId: source.id, lastErrorCode: "missing_parent" }).status, "created");
  assert.equal(broker.recordCrossBrokerRelayFallback({ sourceEventId: source.id, lastErrorCode: "missing_parent" }).status, "replayed");
  assert.equal(broker.recordCrossBrokerRelayFallback({ sourceEventId: "terminal:nope", lastErrorCode: "missing_parent" }).status, "source_not_found");
  assert.deepEqual(broker.getCrossBrokerRelayFallbackDiagnostics(), { relayFallbackLocal: 1 });

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot(), { brokerId: CHILD, knownBrokerIds: [PARENT] });
  const rows = restarted.getTerminalTaskEventOutbox().subscribe().filter((event) => event.payload.relayFallback);
  assert.equal(rows.length, 1, "the fallback row survives a restart");
});

function registerWorker(broker: InMemoryA2ABroker): void {
  broker.registerWorker({
    nodeId: WORKER,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

function handoffChildRequest(): CreateTaskRequest {
  return {
    intent: "propose_patch",
    taskOrigin: "github",
    requester: { id: "brokeralpha-handoff", kind: "service", role: "operator" },
    target: { id: WORKER, kind: "node", role: "analyst" },
    assignedWorkerId: WORKER,
    brokerOfRecord: CHILD,
    message: "fix issue",
    payload: {
      mode: "github-propose-patch",
      repo: "acme/platform",
      issueNumber: 291,
      issueUrl: "https://github.com/acme/platform/issues/291",
      parentIssueUrl: "https://github.com/acme/platform/issues/290",
      parentRoundId: ROUND,
      parentRoundTotal: 3,
      parentRoundOrder: 2,
      originBrokerId: PARENT,
      brokerOfRecordId: PARENT,
      operatorFacingOwner: "parent",
      crossBrokerHandoff: {
        parentRoundId: ROUND,
        originBrokerId: PARENT,
        handoffBrokerId: CHILD,
        childWorkerId: WORKER,
        originTaskId: "brokeralpha-parent-task-1",
      },
    },
  } as unknown as CreateTaskRequest;
}

function completeParentOwnedChild(broker: InMemoryA2ABroker): TerminalTaskOutboxEvent {
  registerWorker(broker);
  const task = broker.createTask(handoffChildRequest());
  broker.claimTask(task.id, WORKER);
  broker.completeTask(task.id, WORKER, {
    summary: "child finished",
    output: { github: { doneCommentUrl: "https://github.com/acme/platform/issues/291#issuecomment-1" } },
  });
  const event = broker.getTerminalTaskEventOutbox().subscribe().find((candidate) => candidate.payload.taskId === task.id);
  assert.ok(event);
  assert.equal(event.payload.notificationOwnership?.scope, "parent-broker-only");
  return event;
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

/** Routes receiver fetches to two in-memory brokers, mirroring the HTTP status mapping. */
function brokerPairFetch(child: InMemoryA2ABroker, parent: InMemoryA2ABroker): {
  fetchImpl: CrossBrokerTerminalBriefReceiverFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${new URL(url).host}${path}`);
    if (path === "/a2a/tasks/terminal-outbox/relay-fallback") {
      const body = JSON.parse(init?.body ?? "{}");
      const result = child.recordCrossBrokerRelayFallback(body);
      const status = result.status === "created" ? 201
        : result.status === "replayed" ? 200
          : result.status === "source_not_found" ? 404 : 409;
      return jsonResponse(status, result);
    }
    if (path === "/a2a/tasks/terminal-outbox") {
      const events = child.getTerminalTaskEventOutbox().subscribe({ afterId: new URL(url).searchParams.get("after_id") ?? undefined });
      return jsonResponse(200, { events, cursor: events.at(-1)?.id ?? null });
    }
    const result = parent.ingestCrossBrokerTerminalBriefProjection(JSON.parse(init?.body ?? "{}") as CrossBrokerTerminalBriefProjectionRequest);
    if (result.accepted) return jsonResponse(result.replayed ? 200 : 202, result);
    return jsonResponse(result.ack.code === "missing_parent" ? 404 : 400, result);
  };
  return { fetchImpl, calls };
}

const RECEIVER = {
  sourceBrokerId: CHILD,
  sourceBaseUrl: "http://child.test",
  destinationBrokerId: PARENT,
  destinationBaseUrl: "http://parent.test",
};

test("PR-5 end to end: a missing_parent reject on the parent creates exactly one child-local fallback row", async () => {
  const child = new InMemoryA2ABroker(undefined, undefined, { brokerId: CHILD, knownBrokerIds: [PARENT] });
  const parent = new InMemoryA2ABroker(undefined, undefined, { brokerId: PARENT, knownBrokerIds: [CHILD] });
  const source = completeParentOwnedChild(child);
  const { fetchImpl, calls } = brokerPairFetch(child, parent);

  const first = await pollCrossBrokerTerminalBriefReceiver(RECEIVER, fetchImpl);
  assert.equal(first.ok, true);
  assert.deepEqual(first.skippedByCode, { missing_parent: 1 });
  assert.equal(first.relayFallbackLocal, 1);
  assert.equal(first.relayFallbackReplayed, 0);
  assert.deepEqual(first.relayFallbackFailed, []);
  assert.ok(calls.includes("POST child.test/a2a/tasks/terminal-outbox/relay-fallback"));

  const rows = child.getTerminalTaskEventOutbox().subscribe().filter((event) => event.payload.relayFallback);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.payload.relayFallback?.sourceEventId, source.id);
  assert.equal(rows[0]?.payload.terminalBriefTitle, `A2A Terminal Brief relay failure: ${WORKER} (missing_parent)`);
  assert.equal(parent.getTerminalTaskEventOutbox().size, 0, "the parent broker renders nothing");

  // A cursor rewind replays the reject, but the fallback stays a single row.
  const rewind = await pollCrossBrokerTerminalBriefReceiver(RECEIVER, fetchImpl);
  assert.equal(rewind.relayFallbackLocal, 0);
  assert.equal(rewind.relayFallbackReplayed, 1);
  assert.equal(child.getTerminalTaskEventOutbox().subscribe().filter((event) => event.payload.relayFallback).length, 1);
  assert.deepEqual(child.getCrossBrokerRelayFallbackDiagnostics(), { relayFallbackLocal: 1 });
});

test("PR-5 end to end: an accepted relay creates no fallback row", async () => {
  const child = new InMemoryA2ABroker(undefined, undefined, { brokerId: CHILD, knownBrokerIds: [PARENT] });
  const parent = new InMemoryA2ABroker(undefined, undefined, { brokerId: PARENT, knownBrokerIds: [CHILD] });
  registerWorker(parent);
  parent.createTask({
    id: ROUND,
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: WORKER, kind: "node", role: "analyst" },
    assignedWorkerId: WORKER,
    message: "parent round",
    payload: { parentRoundTotal: 3 },
  });
  completeParentOwnedChild(child);
  const { fetchImpl, calls } = brokerPairFetch(child, parent);

  const result = await pollCrossBrokerTerminalBriefReceiver(RECEIVER, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.relayFallbackLocal, 0);
  assert.ok(!calls.some((call) => call.includes("relay-fallback")), "success never calls the fallback route");
  assert.equal(child.getTerminalTaskEventOutbox().subscribe().filter((event) => event.payload.relayFallback).length, 0);
});

test("PR-5 HTTP route: hub creates and replays, workers are refused, /health reports the counter", async () => {
  const server = await startTestServer({ brokerId: CHILD, knownBrokerIds: [PARENT] });
  try {
    const broker = server.runtime.broker as InMemoryA2ABroker;
    const source = completeParentOwnedChild(broker);
    const hub = jsonHeaders({ "x-a2a-requester-id": "brokerbeta-terminal-brief-receiver", "x-a2a-requester-role": "hub" });
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/relay-fallback`, { method: "POST", headers, body: JSON.stringify(body) });

    const created = await post(hub, { sourceEventId: source.id, lastErrorCode: "missing_parent", lastErrorReason: "no parent", attempts: 1 });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { status: string; event: TerminalTaskOutboxEvent };
    assert.equal(createdBody.status, "created");
    assert.equal(createdBody.event.payload.relayFallback?.parentBrokerId, PARENT);

    const replayed = await post(hub, { sourceEventId: source.id, lastErrorCode: "missing_parent" });
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json() as { status: string }).status, "replayed");

    const missing = await post(hub, { sourceEventId: "terminal:nope", lastErrorCode: "missing_parent" });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { status: "source_not_found" });

    const badRequest = await post(hub, { lastErrorCode: "missing_parent" });
    assert.equal(badRequest.status, 400);

    const worker = jsonHeaders({ "x-a2a-requester-id": WORKER, "x-a2a-requester-role": "analyst" });
    const refused = await post(worker, { sourceEventId: source.id, lastErrorCode: "missing_parent" });
    assert.equal(refused.status, 401, "non hub/operator roles are refused like the other outbox writes");

    const health = await fetch(`${server.baseUrl}/health`);
    const healthBody = await health.json() as { crossBrokerTerminalBriefs?: Record<string, number> };
    assert.equal(healthBody.crossBrokerTerminalBriefs?.relayFallbackLocal, 1);
  } finally {
    await server.close();
  }
});

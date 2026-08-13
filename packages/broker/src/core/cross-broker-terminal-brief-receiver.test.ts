import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCrossBrokerTerminalBriefProjectionFromEvent,
  pollCrossBrokerTerminalBriefReceiver,
  type CrossBrokerTerminalBriefReceiverFetch,
} from "./cross-broker-terminal-brief-receiver.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

const CONFIG = {
  sourceBrokerId: "brokerbeta",
  sourceBaseUrl: "http://127.0.0.1:8799",
  destinationBrokerId: "brokeralpha",
  destinationBaseUrl: "http://127.0.0.1:8787",
  edgeSecret: "test-edge-secret",
  cursor: "terminal:old",
  limit: 25,
  reconcileUnacked: true,
};

function event(overrides: Partial<TerminalTaskOutboxEvent> = {}): TerminalTaskOutboxEvent {
  return {
    id: "terminal:brokerbeta-child-1",
    kind: "task.terminal",
    taskEventId: 42,
    createdAt: "2026-06-02T13:00:00.000Z",
    receipt: { status: "accepted", updatedAt: "2026-06-02T13:00:00.000Z" },
    attempts: 0,
    payload: {
      taskId: "brokerbeta-child-1",
      status: "succeeded",
      parentRoundId: "brokeralpha-parent-round",
      originBrokerId: "brokeralpha",
      brokerOfRecordId: "brokeralpha",
      run: "brokeralpha-parent-round",
      taskDescription: "Team2 child finished",
      worker: "workerzeta",
      taskBrief: "Cross-broker child",
      doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/1206#issuecomment-done",
      testSummary: "Team2 child completed safely",
      createdAt: "2026-06-02T12:59:00.000Z",
      updatedAt: "2026-06-02T13:00:00.000Z",
      completedAt: "2026-06-02T13:00:00.000Z",
      parentRoundTotal: 8,
      parentRoundOrder: 6,
      terminalBriefTitle: "A2A Terminal Brief 완료: workerzeta(완료 6/8)",
      crossBrokerHandoff: {
        parentRoundId: "brokeralpha-parent-round",
        originBrokerId: "brokeralpha",
        handoffBrokerId: "brokerbeta",
        originTaskId: "brokeralpha-parent-task-1",
        childWorkerId: "workerzeta",
      },
      notificationOwnership: {
        ownerBrokerId: "brokeralpha",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
        reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
      },
    },
    ...overrides,
  };
}

test("buildCrossBrokerTerminalBriefProjectionFromEvent maps child broker event to parent projection", () => {
  const projection = buildCrossBrokerTerminalBriefProjectionFromEvent(event(), CONFIG);

  assert.deepEqual(projection, {
    parentRoundId: "brokeralpha-parent-round",
    originBrokerId: "brokerbeta",
    brokerOfRecordId: "brokeralpha",
    childTaskId: "brokerbeta-child-1",
    childRunId: "brokeralpha-parent-round",
    childWorkerId: "workerzeta",
    status: "succeeded",
    summary: "Team2 child completed safely",
    taskBrief: "Cross-broker child",
    terminalBriefTitle: "A2A Terminal Brief 완료: workerzeta(완료 6/8)",
    evidenceUrl: "https://github.com/jinwon-int/a2a-broker/issues/1206#issuecomment-done",
    completedAt: "2026-06-02T13:00:00.000Z",
    emittedAt: "2026-06-02T13:00:00.000Z",
    parentRoundTotal: 8,
    parentRoundOrder: 6,
    terminalAck: false,
  });
});

test("pollCrossBrokerTerminalBriefReceiver posts parent-owned child events and advances cursor on success", async () => {
  const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers, body: init?.body });
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [event()], cursor: "terminal:brokerbeta-child-1" });
    }
    return jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(CONFIG, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.fetched, 1);
  assert.equal(result.posted, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.cursorToPersist, "terminal:brokerbeta-child-1");
  assert.match(calls[0].url, /after_id=terminal%3Aold/);
  assert.match(calls[0].url, /reconcile_unacked=true/);
  assert.match(calls[1].url, /\/a2a\/cross-broker\/terminal-briefs$/);
  assert.equal(JSON.parse(calls[1].body ?? "{}").originBrokerId, "brokerbeta");
});

test("pollCrossBrokerTerminalBriefReceiver can authenticate source and destination with separate edge secrets", async () => {
  const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers, body: init?.body });
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [event()], cursor: "terminal:brokerbeta-child-1" });
    }
    return jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver({
    ...CONFIG,
    edgeSecret: "legacy-fallback-secret",
    sourceEdgeSecret: "brokerbeta-source-secret",
    destinationEdgeSecret: "brokeralpha-destination-secret",
  }, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(calls[0].headers?.["x-a2a-edge-secret"], "brokerbeta-source-secret");
  assert.equal(calls[1].headers?.["x-a2a-edge-secret"], "brokeralpha-destination-secret");
});

test("pollCrossBrokerTerminalBriefReceiver ignores non-parent-owned events but keeps source cursor", async () => {
  const localEvent = event({
    id: "terminal:local",
    payload: {
      ...event().payload,
      notificationOwnership: undefined,
      crossBrokerHandoff: undefined,
      brokerOfRecordId: "brokerbeta",
    },
  });
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url) => {
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [localEvent], cursor: "terminal:local" });
    }
    throw new Error("destination should not be called");
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(CONFIG, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.ignored, 1);
  assert.equal(result.posted, 0);
  assert.equal(result.cursorToPersist, "terminal:local");
});

test("pollCrossBrokerTerminalBriefReceiver skips missing_parent without pinning the cursor", async () => {
  // Contract: a parentless cross-broker projection fails closed at the
  // destination and never creates an implicit parent round. The event is
  // terminal for this lane — it must be reported as skipped and MUST NOT
  // freeze the cursor, so an orphaned/stale event cannot starve new events.
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url) => {
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [event()], cursor: "terminal:brokerbeta-child-1" });
    }
    return jsonResponse(404, {
      accepted: false,
      ack: {
        code: "missing_parent",
        reason: "parent round brokeralpha-parent-round is not present on this broker",
      },
    });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(CONFIG, fetchImpl);

  assert.equal(result.ok, true, "missing_parent is not a retryable block");
  assert.equal(result.posted, 1);
  assert.equal(result.accepted, 0);
  assert.equal(result.cursorToPersist, "terminal:brokerbeta-child-1", "cursor advances past the orphan");
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.skipped, [{
    eventId: "terminal:brokerbeta-child-1",
    code: "missing_parent",
    reason: "parent round brokeralpha-parent-round is not present on this broker",
  }]);
});

test("pollCrossBrokerTerminalBriefReceiver freezes the cursor at the first retryable failure only", async () => {
  const okEvent = event({ id: "terminal:ok-1" });
  const staleEvent = event({ id: "terminal:stale-2", payload: { ...event().payload, taskId: "brokerbeta-child-2" } });
  const outageEvent = event({ id: "terminal:outage-3", payload: { ...event().payload, taskId: "brokerbeta-child-3" } });
  const tailEvent = event({ id: "terminal:tail-4", payload: { ...event().payload, taskId: "brokerbeta-child-4" } });
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [okEvent, staleEvent, outageEvent, tailEvent], cursor: "terminal:tail-4" });
    }
    const childTaskId = JSON.parse(init?.body ?? "{}").childTaskId as string;
    if (childTaskId === "brokerbeta-child-2") {
      return jsonResponse(409, { accepted: false, ack: { code: "stale_replay", reason: "already newer" } });
    }
    if (childTaskId === "brokerbeta-child-3") {
      return jsonResponse(500, { accepted: false, ack: { code: "destination_http_500", reason: "outage" } });
    }
    return jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(CONFIG, fetchImpl);

  assert.equal(result.ok, false, "a retryable failure is still a blocked poll");
  assert.equal(result.accepted, 2, "events before and after the outage still post");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.code, "stale_replay");
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0]?.eventId, "terminal:outage-3");
  assert.equal(
    result.cursorToPersist,
    "terminal:stale-2",
    "cursor advances past accepted+skipped events but freezes before the retryable failure",
  );
});

test("pollCrossBrokerTerminalBriefReceiver keeps unauthorized rejects blocked (fail closed)", async () => {
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url) => {
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [event()], cursor: "terminal:brokerbeta-child-1" });
    }
    return jsonResponse(401, { accepted: false, ack: { code: "unauthorized", reason: "peer credential rejected" } });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(CONFIG, fetchImpl);

  assert.equal(result.ok, false);
  assert.equal(result.cursorToPersist, "terminal:old", "unauthorized must not advance the cursor");
  assert.equal(result.blocked[0]?.code, "unauthorized");
  assert.deepEqual(result.skipped, []);
});

// ---------------------------------------------------------------------------
// Reverse direction (symmetric v1): brokerbeta-origin parent round, brokeralpha
// Team1 child. Source = brokeralpha (child producer), destination = brokerbeta
// (parent ledger). Mirrors the forward CONFIG with the pairs inverted.
// ---------------------------------------------------------------------------

const REVERSE_CONFIG = {
  sourceBrokerId: "brokeralpha",
  sourceBaseUrl: "http://127.0.0.1:18787",
  destinationBrokerId: "brokerbeta",
  destinationBaseUrl: "http://127.0.0.1:8787",
  edgeSecret: "test-edge-secret",
  cursor: "terminal:old-reverse",
  limit: 25,
  reconcileUnacked: true,
};

function reverseEvent(overrides: Partial<TerminalTaskOutboxEvent> = {}): TerminalTaskOutboxEvent {
  return {
    id: "terminal:brokeralpha-child-1",
    kind: "task.terminal",
    taskEventId: 43,
    createdAt: "2026-08-11T09:00:00.000Z",
    receipt: { status: "accepted", updatedAt: "2026-08-11T09:00:00.000Z" },
    attempts: 0,
    payload: {
      taskId: "brokeralpha-child-1",
      status: "succeeded",
      parentRoundId: "brokerbeta-parent-round",
      originBrokerId: "brokerbeta",
      brokerOfRecordId: "brokerbeta",
      run: "brokerbeta-parent-round",
      taskDescription: "Team1 child finished",
      worker: "workergamma",
      taskBrief: "Cross-broker child (reverse)",
      doneUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1206#issuecomment-done-reverse",
      testSummary: "Team1 child completed safely",
      createdAt: "2026-08-11T08:59:00.000Z",
      updatedAt: "2026-08-11T09:00:00.000Z",
      completedAt: "2026-08-11T09:00:00.000Z",
      parentRoundTotal: 2,
      parentRoundOrder: 1,
      terminalBriefTitle: "A2A Terminal Brief 완료: workergamma(완료 1/2)",
      crossBrokerHandoff: {
        parentRoundId: "brokerbeta-parent-round",
        originBrokerId: "brokerbeta",
        handoffBrokerId: "brokeralpha",
        originTaskId: "brokerbeta-parent-task-1",
        childWorkerId: "workergamma",
      },
      notificationOwnership: {
        ownerBrokerId: "brokerbeta",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
        reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
      },
    },
    ...overrides,
  };
}

test("reverse direction: brokeralpha child event maps to a brokerbeta parent projection", () => {
  const projection = buildCrossBrokerTerminalBriefProjectionFromEvent(reverseEvent(), REVERSE_CONFIG);

  assert.deepEqual(projection, {
    parentRoundId: "brokerbeta-parent-round",
    originBrokerId: "brokeralpha",
    brokerOfRecordId: "brokerbeta",
    childTaskId: "brokeralpha-child-1",
    childRunId: "brokerbeta-parent-round",
    childWorkerId: "workergamma",
    status: "succeeded",
    summary: "Team1 child completed safely",
    taskBrief: "Cross-broker child (reverse)",
    terminalBriefTitle: "A2A Terminal Brief 완료: workergamma(완료 1/2)",
    evidenceUrl: "https://github.com/jinwon-int/a2a-nexus/issues/1206#issuecomment-done-reverse",
    completedAt: "2026-08-11T09:00:00.000Z",
    emittedAt: "2026-08-11T09:00:00.000Z",
    parentRoundTotal: 2,
    parentRoundOrder: 1,
    terminalAck: false,
  });
});

test("reverse direction: a forward-owned event is ignored by the reverse receiver (wrong owner)", () => {
  // A brokeralpha-owned (forward-direction) event must not leak into the
  // brokerbeta-destination lane: ownership filtering is direction-aware.
  const projection = buildCrossBrokerTerminalBriefProjectionFromEvent(event(), REVERSE_CONFIG);
  assert.equal(projection, null);
});

test("reverse direction: poll posts to the brokerbeta ledger and advances the reverse cursor", async () => {
  const calls: Array<{ url: string; headers?: Record<string, string>; body?: string }> = [];
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers, body: init?.body });
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [reverseEvent()], cursor: "terminal:brokeralpha-child-1" });
    }
    return jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver(REVERSE_CONFIG, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.cursorToPersist, "terminal:brokeralpha-child-1");
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:18787\//, "polls the brokeralpha source outbox");
  assert.match(calls[1].url, /^http:\/\/127\.0\.0\.1:8787\/a2a\/cross-broker\/terminal-briefs$/, "posts to the brokerbeta ledger");
  const posted = JSON.parse(calls[1].body ?? "{}");
  assert.equal(posted.originBrokerId, "brokeralpha", "projection originates from the handoff broker");
  assert.equal(posted.brokerOfRecordId, "brokerbeta", "projection is addressed to the parent broker");
  assert.equal(
    calls[1].headers?.["x-a2a-requester-id"],
    "brokeralpha-terminal-brief-receiver",
    "requester id derives from the source broker id (auto-flips per direction)",
  );
});

test("reverse direction: duplicate poll of the same events converges as replays, cursor stable", async () => {
  const destinationSeen = new Map<string, number>();
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [reverseEvent()], cursor: "terminal:brokeralpha-child-1" });
    }
    const key = JSON.parse(init?.body ?? "{}").childTaskId as string;
    const count = (destinationSeen.get(key) ?? 0) + 1;
    destinationSeen.set(key, count);
    return count === 1
      ? jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } })
      : jsonResponse(200, { accepted: true, replayed: true, ack: { decision: "duplicate_replay" } });
  };

  const first = await pollCrossBrokerTerminalBriefReceiver(REVERSE_CONFIG, fetchImpl);
  const second = await pollCrossBrokerTerminalBriefReceiver(REVERSE_CONFIG, fetchImpl);

  assert.equal(first.accepted, 1);
  assert.equal(first.replayed, 0);
  assert.equal(second.accepted, 1);
  assert.equal(second.replayed, 1, "duplicate poll converges onto the existing projection");
  assert.equal(second.cursorToPersist, "terminal:brokeralpha-child-1");
  assert.equal(destinationSeen.get("brokeralpha-child-1"), 2);
});

test("receiver presents minimum-scope peer credentials per target", async () => {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [reverseEvent()], cursor: "terminal:brokeralpha-child-1" });
    }
    return jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } });
  };

  await pollCrossBrokerTerminalBriefReceiver({
    ...REVERSE_CONFIG,
    sourcePeerBrokerId: "brokerbeta",
    sourcePeerSecret: "status-scope-secret",
    destinationPeerBrokerId: "brokeralpha",
    destinationPeerSecret: "evidence-scope-secret",
  }, fetchImpl);

  assert.equal(calls[0].headers?.["x-a2a-peer-broker-id"], "brokerbeta", "source poll authenticates as the parent peer");
  assert.equal(calls[0].headers?.["x-a2a-peer-secret"], "status-scope-secret");
  assert.equal(calls[1].headers?.["x-a2a-peer-broker-id"], "brokeralpha", "evidence relay authenticates as the child peer");
  assert.equal(calls[1].headers?.["x-a2a-peer-secret"], "evidence-scope-secret");
});

test("receiver attaches a verifiable request-bound senderProof when a signing key is configured", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { verifyCrossBrokerSenderProof, CrossBrokerNonceCache } = await import("../a2a/cross-broker-sender-proof.js");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const bodies: string[] = [];
  const fetchImpl: CrossBrokerTerminalBriefReceiverFetch = async (url, init) => {
    if (url.includes("/a2a/tasks/terminal-outbox")) {
      return jsonResponse(200, { events: [reverseEvent()], cursor: "terminal:brokeralpha-child-1" });
    }
    bodies.push(init?.body ?? "{}");
    return jsonResponse(202, { accepted: true, replayed: false, ack: { decision: "accepted" } });
  };

  const result = await pollCrossBrokerTerminalBriefReceiver({
    ...REVERSE_CONFIG,
    senderProofPrivateKeyPem: privateKeyPem,
  }, fetchImpl);

  assert.equal(result.accepted, 1);
  const posted = JSON.parse(bodies[0]!);
  assert.ok(posted.senderProof, "projection body carries a senderProof");
  assert.equal(posted.senderProof.binding.brokerId, "brokeralpha", "claimed sender defaults to the source broker id");

  const anchors = new Map([["brokeralpha", publicKeyPem]]);
  const verdict = verifyCrossBrokerSenderProof(anchors, posted, { nonceCache: new CrossBrokerNonceCache() });
  assert.deepEqual(verdict, { ok: true, brokerId: "brokeralpha" }, "senderProof verifies against the pinned key");

  // A tampered body must fail the request binding (unsigned/tampered evidence
  // fails closed at the destination).
  const tampered = { ...posted, summary: "tampered" };
  const tamperedVerdict = verifyCrossBrokerSenderProof(anchors, tampered, { nonceCache: new CrossBrokerNonceCache() });
  assert.equal(tamperedVerdict.ok, false, "tampered projection body must not verify");
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

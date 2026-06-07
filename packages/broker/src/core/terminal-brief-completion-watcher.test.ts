import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalBriefCompletionPacket,
  renderTerminalBriefCompletionPacketMarkdown,
} from "./terminal-brief-completion-watcher.js";
import type {
  TerminalTaskOutboxEvent,
  TerminalTaskReceiptStatus,
  TerminalTaskStatus,
} from "./terminal-event-outbox.js";

const NOW = "2026-05-18T08:30:00.000Z";
const LEGACY_CUTOFF_MS = Date.parse("2026-05-04T07:10:00.000Z");
const LEGACY_PRE_CUTOFF_TIMESTAMP = "2026-04-15T00:00:00.000Z";
const RECENT_CUTOFF_MS = Date.parse("2026-05-10T00:00:00.000Z");

function eventFor(
  worker: string,
  status: TerminalTaskStatus,
  options: {
    taskId?: string;
    receiptStatus?: TerminalTaskReceiptStatus;
    progress?: number;
    total?: number;
    prUrl?: string;
    doneUrl?: string;
    blockUrl?: string;
    parentRoundId?: string;
    ack?: boolean;
  } = {},
): TerminalTaskOutboxEvent {
  const taskId = options.taskId ?? "task-" + worker;
  return {
    id: taskId + "-" + status,
    kind: "task.terminal",
    taskEventId: 1,
    payload: {
      taskId,
      status,
      parentRoundId: options.parentRoundId ?? "round-689",
      worker,
      repo: "jinwon-int/a2a-broker",
      issue: 689,
      prUrl: options.prUrl,
      doneUrl: options.doneUrl,
      blockUrl: options.blockUrl,
      parentRoundProgress: options.progress,
      parentRoundTotal: options.total,
      taskBrief: "Terminal Brief completion watcher",
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    createdAt: NOW,
    receipt: {
      status: options.receiptStatus ?? "provider_accepted",
      updatedAt: NOW,
      receiptId: "receipt-" + taskId,
    },
    ack: options.ack ? {
      status: "receipt_confirmed",
      evidence: "operator_visible",
      acknowledgedAt: NOW,
      receiptId: "receipt-" + taskId,
    } : undefined,
    attempts: options.receiptStatus === "produced" ? 0 : 1,
  };
}

test("buildTerminalBriefCompletionPacket prepares ready closeout candidate without treating provider receipt as ACK", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    events: [
      eventFor("bangtong", "succeeded", { progress: 1, total: 3, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/701" }),
      eventFor("sogyo", "succeeded", { progress: 2, total: 3, doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/689#issuecomment-sogyo" }),
      eventFor("nosuk", "succeeded", { progress: 3, total: 3, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/702" }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "ready_for_finalizer");
  assert.equal(packet.closeoutCandidate.status, "candidate");
  assert.equal(packet.summary.finalCount?.reached, true);
  assert.equal(packet.summary.providerOnly, 3);
  assert.equal(packet.summary.operatorVisible, 0);
  assert.equal(packet.semantics.providerAcceptedIsTerminalAck, false);
  assert.equal(packet.semantics.providerAcceptedIsReadReceipt, false);
  assert.equal(packet.semantics.providerAcceptedIsVisibilityProof, false);
  assert.match(packet.receiptGaps[0] ?? "", /not terminal ACK/);
});

test("buildTerminalBriefCompletionPacket blocks when expected worker evidence is missing", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong", "sogyo"],
    events: [
      eventFor("bangtong", "succeeded", { progress: 1, total: 2, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/701" }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.deepEqual(packet.missingWorkers, ["sogyo"]);
  assert.match(packet.closeoutCandidate.reason, /no terminal event observed/);
  assert.equal(packet.closeoutCandidate.status, "blocked");
});

test("buildTerminalBriefCompletionPacket blocks succeeded lanes without PR or Done evidence", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong"],
    events: [
      eventFor("bangtong", "succeeded", { progress: 1, total: 1 }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.deepEqual(packet.missingEvidence, ["bangtong: succeeded lacks PR/Done/Block evidence"]);
  assert.equal(packet.lanes[0]?.state, "needs_evidence");
});

test("buildTerminalBriefCompletionPacket blocks conflicting duplicate worker terminal events", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong"],
    events: [
      eventFor("bangtong", "succeeded", {
        taskId: "task-bangtong-a",
        progress: 1,
        total: 1,
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/701",
      }),
      eventFor("bangtong", "failed", {
        taskId: "task-bangtong-b",
        progress: 1,
        total: 1,
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/689#issuecomment-block",
      }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.equal(packet.lanes[0]?.state, "conflict");
  assert.match(packet.conflicts[0] ?? "", /conflicting duplicate/);
});

test("buildTerminalBriefCompletionPacket treats failed and blocked lanes as closeout blockers with follow-up", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong"],
    events: [
      eventFor("bangtong", "blocked", {
        progress: 1,
        total: 1,
        receiptStatus: "operator_visible",
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/689#issuecomment-block",
      }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.equal(packet.summary.operatorVisible, 1);
  assert.equal(packet.receiptGaps.length, 0);
  assert.match(packet.followUpTaskCandidates.join("\n"), /inspect Block evidence/);
});

test("renderTerminalBriefCompletionPacketMarkdown includes safety and lane evidence", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong"],
    events: [
      eventFor("bangtong", "succeeded", { progress: 1, total: 1, doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/689#issuecomment-done" }),
    ],
  }, { now: NOW });
  const markdown = renderTerminalBriefCompletionPacketMarkdown(packet);

  assert.match(markdown, /^Ready: terminal-brief completion watcher/);
  assert.match(markdown, /bangtong \(1\/1\)/);
  assert.match(markdown, /provider accepted\/message-id is not terminal ACK/);
  assert.match(markdown, /Legacy residue/);
});

test("buildTerminalBriefCompletionPacket filters legacy-residue rows from lane decisions", () => {
  // Current-window event (post-cutoff, has taskBrief and evidence)
  const currentEvent = eventFor("worker-current", "succeeded", {
    parentRoundId: "round-893",
    progress: 1,
    total: 1,
    prUrl: "https://github.com/jinwon-int/a2a-broker/pull/893",
  });

  // Legacy-residue event: pre-cutoff timestamp, legacy receipt status
  const legacyEvent: TerminalTaskOutboxEvent = {
    id: "legacy-event-1",
    kind: "task.terminal",
    taskEventId: 1,
    payload: {
      taskId: "task-legacy",
      status: "succeeded",
      parentRoundId: "round-old",
      worker: "worker-legacy",
      // no taskBrief, no evidence URLs
      createdAt: LEGACY_PRE_CUTOFF_TIMESTAMP,
      updatedAt: LEGACY_PRE_CUTOFF_TIMESTAMP,
      completedAt: LEGACY_PRE_CUTOFF_TIMESTAMP,
    },
    createdAt: LEGACY_PRE_CUTOFF_TIMESTAMP,
    receipt: { status: "sent", updatedAt: LEGACY_PRE_CUTOFF_TIMESTAMP } as any, // legacy receipt
    attempts: 0,
  };

  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-893",
    expectedWorkers: ["worker-current"],
    events: [currentEvent, legacyEvent],
  }, { now: NOW });

  assert.equal(packet.summary.legacyResidueFiltered, 1,
    "should count 1 legacy-residue row filtered");
  assert.ok(packet.legacyResidueIds.includes("legacy-event-1"),
    "legacy event id should appear in legacyResidueIds");
  assert.equal(packet.summary.observedWorkers, 1,
    "only current-window worker should be observed");
  assert.equal(packet.decision, "ready_for_finalizer",
    "decision should not be blocked by legacy residue");
});

test("buildTerminalBriefCompletionPacket excludes unclassifiable rows", () => {
  const currentEvent = eventFor("worker-current", "succeeded", {
    parentRoundId: "round-893",
    progress: 1,
    total: 1,
    prUrl: "https://github.com/jinwon-int/a2a-broker/pull/893",
  });

  // A near-empty event that the classifier will mark as unclassifiable
  const emptyEvent: any = {
    id: "empty-event-1",
    kind: "task.terminal",
    taskEventId: 0,
    payload: { taskId: "task-empty", status: "succeeded", worker: "worker-empty", createdAt: "", updatedAt: "" },
    createdAt: "",
    receipt: {},
    attempts: 0,
  };

  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-893",
    expectedWorkers: ["worker-current"],
    events: [currentEvent, emptyEvent],
  }, { now: NOW });

  assert.equal(packet.summary.legacyResidueFiltered, 1,
    "should count 1 unclassifiable/excluded row");
  assert.equal(packet.summary.observedWorkers, 1,
    "only current-window worker observed");
  assert.equal(packet.decision, "ready_for_finalizer",
    "unclassifiable rows should not block decision");
});

test("buildTerminalBriefCompletionPacket legacyResidueFiltered is zero when all events are current-window", () => {
  const events = [
    eventFor("w1", "succeeded", { progress: 1, total: 2, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/1", parentRoundId: "round-893" }),
    eventFor("w2", "succeeded", { progress: 2, total: 2, doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/893#done", parentRoundId: "round-893" }),
  ];

  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-893",
    expectedWorkers: ["w1", "w2"],
    events,
  }, { now: NOW });

  assert.equal(packet.summary.legacyResidueFiltered, 0,
    "no legacy residue when all events are current-window");
  assert.deepEqual(packet.legacyResidueIds, [],
    "empty legacyResidueIds when no residue");
  assert.equal(packet.decision, "ready_for_finalizer",
    "ready when all rows are current-window");
});

test("buildTerminalBriefCompletionPacket cutoffMs option filters pre-cutoff events", () => {
  // Event with a pre-cutoff timestamp
  const event = eventFor("worker-edge", "succeeded", {
    parentRoundId: "round-893",
    progress: 1,
    total: 1,
    prUrl: "https://github.com/jinwon-int/a2a-broker/pull/893",
  });
  // Override createdAt to be before the custom cutoff
  const eventCreatedAt = "2026-05-05T00:00:00.000Z";
  event.createdAt = eventCreatedAt;
  event.payload.createdAt = eventCreatedAt;
  event.payload.updatedAt = eventCreatedAt;
  event.payload.completedAt = eventCreatedAt;

  // The classifier considers preCutoff=true alone as stong legacy signal.
  // So with a cutoff of 2026-05-10 and event from 2026-05-05, it's legacy-residue.
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-893",
    expectedWorkers: ["worker-edge"],
    events: [event],
  }, { now: NOW, cutoffMs: RECENT_CUTOFF_MS });

  assert.equal(packet.summary.legacyResidueFiltered, 1,
    "pre-cutoff event is filtered as legacy residue");
  assert.ok(packet.legacyResidueIds.includes(event.id),
    "pre-cutoff event id appears in legacyResidueIds");
  // With all events filtered, the worker is waiting — closeout is blocked
  assert.equal(packet.decision, "blocked",
    "blocked when current-window events are all filtered");
  assert.ok(packet.missingWorkers.length > 0,
    "missing workers reported when legacy events are the only ones");
});

test("renderTerminalBriefCompletionPacketMarkdown includes legacy residue info", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-893",
    expectedWorkers: ["worker-a"],
    events: [],
  }, { now: NOW });

  const markdown = renderTerminalBriefCompletionPacketMarkdown(packet);
  assert.match(markdown, /Legacy residue/,
    "render should include legacy residue line");
});

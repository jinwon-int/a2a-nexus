import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import type { TaskStatusEvent, TerminalTaskEvent } from "./task-events.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-1"): void {
  broker.registerWorker({
    nodeId,
    role: "operator",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  });
}

function createTask(
  broker: InMemoryA2ABroker,
  overrides: {
    id?: string;
    parentTaskId?: string;
    targetNodeId?: string;
    message?: string;
    payload?: Record<string, unknown>;
    policyContext?: { requiresApproval?: boolean };
  } = {},
) {
  return broker.createTask({
    id: overrides.id,
    parentTaskId: overrides.parentTaskId,
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: overrides.targetNodeId ?? "worker-1", kind: "node", role: "operator" },
    policyContext: overrides.policyContext,
    message: overrides.message,
    payload: overrides.payload ?? {},
  });
}

describe("TaskEventStream", () => {
  it("emits a TaskStatusEvent when a task is created", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker);
    const events = broker.getTaskEventStream().subscribe();

    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.taskId, task.id);
    assert.equal(event.kind, "created");
    assert.equal(event.status, "queued");
    assert.equal(event.id, 1);
    assert.equal(event.metadata.intent, "analyze");
    assert.equal(event.metadata.targetNodeId, "worker-1");
  });

  it("emits events in monotonic order across the task lifecycle", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1");

    const events = broker.getTaskEventStream().subscribe();
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["created", "claimed", "started", "succeeded"],
    );
    assert.deepEqual(
      events.map((e) => e.id),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      events.map((e) => e.status),
      ["queued", "claimed", "running", "succeeded"],
    );
  });

  it("subscribe(afterId) returns only events strictly after the cursor", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1");

    const stream = broker.getTaskEventStream();
    const afterThree = stream.subscribe({ afterId: 3 });
    assert.equal(afterThree.length, 1);
    assert.equal(afterThree[0]!.id, 4);
    assert.equal(afterThree[0]!.kind, "succeeded");

    const afterFour = stream.subscribe({ afterId: 4 });
    assert.equal(afterFour.length, 0);
  });

  it("subscribe with no cursor or afterId=-1 returns every retained event", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    const stream = broker.getTaskEventStream();
    const noCursor = stream.subscribe();
    const negativeCursor = stream.subscribe({ afterId: -1 });

    assert.equal(noCursor.length, 2);
    assert.deepEqual(noCursor, negativeCursor);
  });

  it("events include operator-safe metadata but no raw prompt or payload text", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const secret = "do-not-leak: highly-sensitive prompt body";
    broker.createTask({
      intent: "analyze",
      requester: { id: "hub", kind: "node", role: "hub" },
      target: { id: "worker-1", kind: "node", role: "operator" },
      message: secret,
      payload: { sessionPrompt: secret, githubRepo: "acme/example", githubIssueNumber: 42 },
      taskOrigin: "github",
    });

    const [event] = broker.getTaskEventStream().subscribe();
    assert.ok(event);
    assert.equal(event.metadata.taskOrigin, "github");
    assert.equal(event.metadata.repoFullName, "acme/example");
    assert.equal(event.metadata.issueNumber, 42);

    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes("highly-sensitive"), "raw prompt body must not appear in event");
    assert.ok(!serialized.includes("sessionPrompt"), "payload keys must not leak into event");
    assert.equal(Object.prototype.hasOwnProperty.call(event, "message"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(event, "payload"), false);
  });

  it("a parent aggregate can consume child task lifecycle updates via parentTaskId filter", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-1");
    registerWorker(broker, "worker-2");

    const parent = createTask(broker, { id: "parent-task", targetNodeId: "worker-1" });
    const childA = createTask(broker, { id: "child-a", parentTaskId: parent.id, targetNodeId: "worker-1" });
    const childB = createTask(broker, { id: "child-b", parentTaskId: parent.id, targetNodeId: "worker-2" });

    broker.claimTask(childA.id, "worker-1");
    broker.startTask(childA.id, "worker-1");
    broker.failTask(childA.id, "worker-1", { code: "boom", message: "blew up" });

    broker.claimTask(childB.id, "worker-2");
    broker.completeTask(childB.id, "worker-2");

    const stream = broker.getTaskEventStream();
    const childEvents = stream.subscribe({ parentTaskId: parent.id });

    assert.deepEqual(
      childEvents.map((e: TaskStatusEvent) => `${e.taskId}:${e.kind}`),
      [
        "child-a:created",
        "child-b:created",
        "child-a:claimed",
        "child-a:started",
        "child-a:failed",
        "child-b:claimed",
        "child-b:succeeded",
      ],
    );
    for (const event of childEvents) {
      assert.equal(event.parentTaskId, parent.id);
    }

    const parentOnly = stream.subscribe({ taskId: parent.id });
    assert.equal(parentOnly.length, 1);
    assert.equal(parentOnly[0]!.kind, "created");
    assert.equal(parentOnly[0]!.parentTaskId, undefined);
  });

  it("bounded replay honors the limit parameter", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1");

    const stream = broker.getTaskEventStream();
    const firstTwo = stream.subscribe({ afterId: 0, limit: 2 });
    assert.equal(firstTwo.length, 2);
    assert.deepEqual(
      firstTwo.map((e) => e.id),
      [1, 2],
    );

    const fromCursorWithLimit = stream.subscribe({ afterId: 1, limit: 2 });
    assert.deepEqual(
      fromCursorWithLimit.map((e) => e.id),
      [2, 3],
    );
  });

  it("emits compact terminal events with safe evidence fields and replay ids", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, {
      payload: {
        githubRepo: "acme/example",
        githubIssueNumber: 217,
        githubIssueTitle: "Broker receipt/evidence gate token=fake-token-placeholder /home/alice/secret",
        sessionPrompt: "do-not-leak",
      },
    });
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", {
      summary: "raw summary should not be used as logs",
      output: {
        prUrl: "https://github.com/acme/example/pull/9",
        doneUrl: "https://github.com/acme/example/issues/217#issuecomment-1",
        privatePath: "/home/alice/secret",
        testSummary: { status: "passed", total: 3, passed: 3, summary: "npm test ok\nno raw logs" },
      },
    });

    const stream = broker.getTaskEventStream();
    const terminalEvents = stream.subscribeTerminal();
    assert.equal(terminalEvents.length, 1);
    assert.deepEqual(terminalEvents[0], {
      id: 1,
      taskId: task.id,
      status: "succeeded",
      worker: "worker-1",
      repo: "acme/example",
      issue: 217,
      taskBrief: "Broker receipt/evidence gate token=[redacted] [path]",
      prUrl: "https://github.com/acme/example/pull/9",
      doneUrl: "https://github.com/acme/example/issues/217#issuecomment-1",
      testSummary: { status: "passed", total: 3, passed: 3, summary: "npm test ok no raw logs" },
      createdAt: terminalEvents[0]!.createdAt,
      updatedAt: terminalEvents[0]!.updatedAt,
      completedAt: terminalEvents[0]!.completedAt,
    });
    assert.deepEqual(stream.subscribeTerminal({ afterId: 1 }), []);
    const serialized = JSON.stringify(terminalEvents[0]);
    assert.ok(!serialized.includes("sessionPrompt"));
    assert.ok(!serialized.includes("do-not-leak"));
    assert.ok(!serialized.includes("privatePath"));
    assert.ok(!serialized.includes("/home/alice"));
  });

  it("projects no-change comment evidence aliases into compact terminal event URLs", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, {
      payload: {
        githubRepo: "acme/example",
        githubIssueNumber: 472,
        githubIssueTitle: "no-change evidence-only closeout",
      },
    });
    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", {
      summary: "Done/Block evidence posted without a patch",
      output: {
        doneCommentUrl: "https://github.com/acme/example/issues/472#issuecomment-done",
        github: {
          blockCommentUrl: "https://github.com/acme/example/issues/472#issuecomment-block",
        },
      },
    });

    const [event] = broker.getTaskEventStream().subscribeTerminal();
    assert.ok(event);
    assert.equal(event.doneUrl, "https://github.com/acme/example/issues/472#issuecomment-done");
    assert.equal(event.blockUrl, "https://github.com/acme/example/issues/472#issuecomment-block");
    assert.equal((event as unknown as Record<string, unknown>).doneCommentUrl, undefined);
    assert.equal((event as unknown as Record<string, unknown>).blockCommentUrl, undefined);
  });

  it("does not project runId-only tasks as parent rounds in compact terminal events", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workeralpha");
    const task = createTask(broker, {
      id: "compact-runid-only",
      targetNodeId: "workeralpha",
      payload: {
        runId: "standalone-retry-run",
      },
    });
    broker.claimTask(task.id, "workeralpha");
    broker.completeTask(task.id, "workeralpha", { summary: "retry complete" });

    const [event] = broker.getTaskEventStream().subscribeTerminal();
    assert.ok(event);
    assert.equal(event.run, "standalone-retry-run");
    assert.equal(event.parentRoundId, undefined);
    assert.equal(event.parentRoundTotal, undefined);
    assert.equal(event.parentRoundOrder, undefined);
    assert.equal(event.terminalBriefTitle, undefined);
  });

  it("keeps ambiguous parentRoundId out of raw compact event fields", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workerbeta");
    const task = createTask(broker, {
      id: "compact-parent-round-without-total",
      targetNodeId: "workerbeta",
      payload: {
        parentRoundId: "ambiguous-parent-round",
      },
    });
    broker.claimTask(task.id, "workerbeta");
    broker.completeTask(task.id, "workerbeta", { summary: "ambiguous complete" });

    const [event] = broker.getTaskEventStream().subscribeTerminal();
    assert.ok(event);
    assert.equal(event.run, "ambiguous-parent-round");
    assert.equal(event.parentRoundId, undefined);
    assert.equal(event.parentRoundTotal, undefined);
    assert.match(event.terminalBriefTitle ?? "", /진단: parentRoundTotal/);
  });

  it("counts total-only parentRoundId compact event fields when local progress is available", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workerbeta");
    const task = createTask(broker, {
      id: "compact-parent-round-without-order",
      targetNodeId: "workerbeta",
      payload: {
        parentRoundId: "total-only-parent-round",
        parentRoundTotal: 4,
      },
    });
    broker.claimTask(task.id, "workerbeta");
    broker.completeTask(task.id, "workerbeta", { summary: "ambiguous complete" });

    const [event] = broker.getTaskEventStream().subscribeTerminal();
    assert.ok(event);
    assert.equal(event.run, "total-only-parent-round");
    assert.equal(event.parentRoundId, "total-only-parent-round");
    assert.equal(event.parentRoundTotal, 4);
    assert.equal(event.parentRoundOrder, undefined);
    assert.equal(event.parentRoundProgress, 1);
    assert.equal(event.parentRoundTerminalProgress, 1);
    assert.equal(event.terminalBriefTitle, "A2A Terminal Brief 완료: workerbeta(완료 1/4)");
  });

  it("preserves parent-owned cross-broker routing metadata in compact terminal events", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
    registerWorker(broker, "workerzeta");

    const task = createTask(broker, {
      id: "compact-parent-owned-workerzeta",
      targetNodeId: "workerzeta",
      payload: {
        parentRoundId: "brokeralpha-led-round",
        parentRoundTotal: 2,
        parentRoundOrder: 2,
        originBrokerId: "brokeralpha",
        brokerOfRecordId: "brokeralpha",
        operatorFacingOwner: "parent",
        crossBrokerHandoff: {
          parentRoundId: "brokeralpha-led-round",
          originBrokerId: "brokeralpha",
          handoffBrokerId: "brokerbeta",
          originTaskId: "parent-task-1",
          childWorkerId: "workerzeta",
        },
      },
    });
    broker.claimTask(task.id, "workerzeta");
    broker.completeTask(task.id, "workerzeta", { summary: "Team2 child completed" });

    const [event] = broker.getTaskEventStream().subscribeTerminal();
    assert.ok(event);
    assert.equal(event.parentRoundId, "brokeralpha-led-round");
    assert.equal(event.originBrokerId, "brokeralpha");
    assert.equal(event.brokerOfRecordId, "brokeralpha");
    assert.equal(event.parentRoundTotal, 2);
    assert.equal(event.parentRoundOrder, 2);
    assert.equal(event.parentRoundProgress, 2);
    assert.equal(event.parentRoundProgressSource, "parent_round_order");
    assert.deepEqual(event.crossBrokerHandoff, {
      parentRoundId: "brokeralpha-led-round",
      originBrokerId: "brokeralpha",
      handoffBrokerId: "brokerbeta",
      originTaskId: "parent-task-1",
      childWorkerId: "workerzeta",
    });
    assert.deepEqual(event.notificationOwnership, {
      ownerBrokerId: "brokeralpha",
      scope: "parent-broker-only",
      providerSendPermittedByProjection: false,
      terminalAckPermittedByProjection: false,
      reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
    });
    assert.equal(event.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 2/2)");
  });
});

describe("TerminalTaskEventOutbox", () => {
  it("enqueues compact idempotent terminal events for webhook replay", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, {
      message: "jinwon-int/a2a-broker#218: terminal outbox regression should not leak /work/repo",
      payload: {
        githubRepo: "jinwon-int/a2a-broker",
        githubIssueNumber: 218,
        run: "a2a-terminal-push-1",
        traceId: "trace-terminal-1",
        taskDescription: "Fix terminal closeout from /work/private token=fake-token-placeholder",
        crossBrokerHandoff: {
          parentRoundId: "parent-round-1",
          originBrokerId: "brokerbeta",
          handoffBrokerId: "brokeralpha",
          originTaskId: "parent-task-1",
        },
      },
    });

    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", {
      summary: "tests passed from /work/repo/dist/core/task-events.test.js",
      output: {
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/999",
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/218#issuecomment-1",
        blockUrl: "/work/private/block.md",
        rawLog: "secret token should not appear",
      },
    });
    broker.completeTask(task.id, "worker-1");

    const outbox = broker.getTerminalTaskEventOutbox();
    const events = outbox.subscribe();
    assert.equal(events.length, 1);
    const [event] = events;
    assert.ok(event);
    assert.match(event.id, /^terminal:/);
    assert.equal(event.kind, "task.terminal");
    assert.equal(event.payload.taskId, task.id);
    assert.equal(event.payload.status, "succeeded");
    assert.equal(event.payload.worker, "worker-1");
    assert.equal(event.payload.run, "a2a-terminal-push-1");
    assert.equal(event.payload.traceId, "trace-terminal-1");
    assert.equal(event.payload.taskDescription, "Fix terminal closeout from [path] token=[redacted]");
    assert.equal(event.payload.repo, "jinwon-int/a2a-broker");
    assert.equal(event.payload.issue, 218);
    assert.equal(event.payload.taskBrief, "terminal outbox regression should not leak [path]");
    assert.equal(event.payload.prUrl, "https://github.com/jinwon-int/a2a-broker/pull/999");
    assert.equal(event.payload.doneUrl, "https://github.com/jinwon-int/a2a-broker/issues/218#issuecomment-1");
    assert.equal(event.payload.blockUrl, undefined);
    assert.match(event.payload.testSummary ?? "", /tests passed from \[path\]/);
    assert.deepEqual(event.payload.crossBrokerHandoff, {
      parentRoundId: "parent-round-1",
      originBrokerId: "brokerbeta",
      handoffBrokerId: "brokeralpha",
      originTaskId: "parent-task-1",
    });
    assert.deepEqual(event.ackAudit, {
      decision: "pending",
      reason: "terminal event accepted; awaiting current-session-visible/operator-visible evidence before ACK",
      updatedAt: event.createdAt,
      taskId: task.id,
      worker: "worker-1",
      repo: "jinwon-int/a2a-broker",
      issue: 218,
      taskBrief: "terminal outbox regression should not leak [path]",
      run: "a2a-terminal-push-1",
      traceId: "trace-terminal-1",
      receiptStatus: "accepted",
    });

    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes("rawLog"));
    assert.ok(!serialized.includes("secret token"));
    assert.ok(!serialized.includes("/work/repo"));
    assert.ok(!serialized.includes("sessionPrompt"));
  });

  it("normalizes no-change comment evidence aliases into terminal outbox evidence URLs", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workerepsilon");
    const task = createTask(broker, {
      targetNodeId: "workerepsilon",
      payload: {
        githubRepo: "jinwon-int/a2a-broker",
        githubIssueNumber: 472,
        githubIssueTitle: "Team2 broker parity for no-change evidence task outcomes",
        run: "a2a-evidence-nochange-hardening-20260510T100150Z",
      },
    });

    broker.claimTask(task.id, "workerepsilon");
    broker.completeTask(task.id, "workerepsilon", {
      summary: "no code change needed; evidence-only Done/Block URL returned",
      output: {
        github: {
          doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/472#issuecomment-done",
        },
        blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/472#issuecomment-block",
      },
    });

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.payload.doneUrl, "https://github.com/jinwon-int/a2a-broker/issues/472#issuecomment-done");
    assert.equal(event.payload.blockUrl, "https://github.com/jinwon-int/a2a-broker/issues/472#issuecomment-block");
    assert.equal((event.payload as unknown as Record<string, unknown>).doneCommentUrl, undefined);
    assert.equal((event.payload as unknown as Record<string, unknown>).blockCommentUrl, undefined);
    assert.equal(event.ackAudit?.decision, "pending");
    assert.match(event.ackAudit?.reason ?? "", /awaiting current-session-visible\/operator-visible evidence before ACK/);
  });

  it("includes worker task brief in fake operator terminal line", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workerbeta");
    const task = createTask(broker, {
      id: "brief-line",
      targetNodeId: "workerbeta",
      payload: {
        githubRepo: "jinwon-int/a2a-broker",
        githubIssueNumber: 310,
        githubIssueTitle: "broker receipt/evidence gate",
      },
    });

    broker.claimTask(task.id, "workerbeta");
    broker.completeTask(task.id, "workerbeta", { summary: "npm test passed" });

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    const envelope = toFakeOperatorEnvelope(event);
    assert.equal(envelope.body.worker, "workerbeta");
    assert.equal(envelope.body.taskBrief, "broker receipt/evidence gate");
    assert.equal(renderFakeOperatorLine(envelope.body), "workerbeta completed jinwon-int/a2a-broker#310 — broker receipt/evidence gate");
  });

  it("counts direct parent round progress only when a total denominator is known", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-1");
    registerWorker(broker, "worker-2");

    const first = createTask(broker, {
      id: "direct-parent-round-first",
      targetNodeId: "worker-1",
      payload: {
        parentRoundId: "parent-round-direct",
        parentRoundTotal: 2,
      },
    });
    const second = createTask(broker, {
      id: "direct-parent-round-second",
      targetNodeId: "worker-2",
      payload: {
        roundId: "parent-round-direct",
        roundTotal: "2",
      },
    });
    const unknownTotal = createTask(broker, {
      id: "direct-parent-round-unknown-total",
      targetNodeId: "worker-1",
      payload: {
        parentRoundId: "parent-round-unknown-total",
      },
    });

    broker.claimTask(first.id, "worker-1");
    broker.completeTask(first.id, "worker-1", { summary: "first child done" });
    broker.claimTask(second.id, "worker-2");
    broker.completeTask(second.id, "worker-2", { summary: "second child done" });
    broker.claimTask(unknownTotal.id, "worker-1");
    broker.completeTask(unknownTotal.id, "worker-1", { summary: "unknown total child done" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.slice(0, 2).map((event) => ({
        taskId: event.payload.taskId,
        run: event.payload.run,
        parentRoundProgress: event.payload.parentRoundProgress,
        parentRoundTotal: event.payload.parentRoundTotal,
      })),
      [
        { taskId: "direct-parent-round-first", run: "parent-round-direct", parentRoundProgress: 1, parentRoundTotal: 2 },
        { taskId: "direct-parent-round-second", run: "parent-round-direct", parentRoundProgress: 2, parentRoundTotal: 2 },
      ],
    );
    assert.equal(events[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: worker-1(완료 1/2)");
    assert.equal(events[1]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: worker-2(완료 2/2)");
    assert.equal(events[2]?.payload.taskId, "direct-parent-round-unknown-total");
    assert.equal(events[2]?.payload.run, "parent-round-unknown-total");
    assert.equal(events[2]?.payload.parentRoundTotal, undefined);
    assert.equal(events[2]?.payload.parentRoundProgress, undefined);
    assert.equal(events[2]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: worker-1(진단: parentRoundTotal, parentRoundOrder 누락)");
  });

  it("direct task flow emits workergamma compact Terminal Brief with parentRoundTotal=7, progress=1", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");

    const task = createTask(broker, {
      id: "workergamma-direct-child",
      targetNodeId: "workergamma",
      payload: {
        parentRoundId: "r13-parent-round",
        parentRoundTotal: 7,
      },
    });

    broker.claimTask(task.id, "workergamma");
    broker.completeTask(task.id, "workergamma", { summary: "workergamma direct task completed" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    const event = events.find(e => e.payload.taskId === "workergamma-direct-child");
    assert.ok(event, "workergamma direct task event must exist");
    assert.equal(event.payload.worker, "workergamma");
    assert.equal(event.payload.run, "r13-parent-round");
    assert.equal(event.payload.parentRoundTotal, 7);
    assert.equal(event.payload.parentRoundProgress, 1);
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 1/7)");
    assert.equal(event.payload.status, "succeeded");
  });

  it("parent-local Terminal Brief defaults origin broker to broker-of-record for compact title metadata", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
    registerWorker(broker, "workergamma");

    const task = createTask(broker, {
      id: "parent-local-terminal-brief-child",
      targetNodeId: "workergamma",
      payload: {
        parentRoundId: "brokeralpha-parent-local-round",
        parentRoundTotal: 7,
      },
    });

    broker.claimTask(task.id, "workergamma");
    broker.completeTask(task.id, "workergamma", { summary: "parent local child completed" });

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.payload.parentRoundId, "brokeralpha-parent-local-round");
    assert.equal(event.payload.run, "brokeralpha-parent-local-round");
    assert.equal(event.payload.originBrokerId, "brokeralpha");
    assert.equal(event.payload.brokerOfRecordId, "brokeralpha");
    assert.equal(event.payload.parentRoundTotal, 7);
    assert.equal(event.payload.parentRoundProgress, 1);
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 1/7)");
    assert.equal(event.payload.notificationOwnership, undefined);
  });

  it("projects R16 Terminal Brief metadata aliases from payload and result metadata", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
    registerWorker(broker, "workerzeta");

    const task = createTask(broker, {
      id: "r16-terminal-brief-metadata",
      targetNodeId: "workerzeta",
      payload: {
        parentRoundId: "a2a-r16-terminal-brief-round",
        parentRoundTotal: "7",
        githubIssueTitle: "preserve structured Terminal Brief metadata",
      },
    });

    broker.claimTask(task.id, "workerzeta");
    broker.completeTask(task.id, "workerzeta", {
      summary: "metadata projection fixed",
      output: {
        metadata: {
          originBrokerId: "brokerbeta",
          brokerOfRecordId: "brokeralpha",
          parentRoundOrder: "6",
        },
      },
    });

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.payload.parentRoundId, "a2a-r16-terminal-brief-round");
    assert.equal(event.payload.run, "a2a-r16-terminal-brief-round");
    assert.equal(event.payload.originBrokerId, "brokerbeta");
    assert.equal(event.payload.brokerOfRecordId, "brokeralpha");
    assert.equal(event.payload.parentRoundTotal, 7);
    assert.equal(event.payload.parentRoundOrder, 6);
    assert.equal(event.payload.parentRoundProgress, 1);
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 1/7)");
    assert.equal(event.payload.title, "A2A Terminal Brief 완료: workerzeta(완료 1/7)");
  });

  it("direct task flow emits workergamma compact Terminal Brief on failed and canceled", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");

    // failed
    const failedTask = createTask(broker, {
      id: "workergamma-failed",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r13-failed-round", parentRoundTotal: 7 },
    });
    broker.claimTask(failedTask.id, "workergamma");
    broker.failTask(failedTask.id, "workergamma", { message: "task failed" });

    // canceled
    const canceledTask = createTask(broker, {
      id: "workergamma-canceled",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r13-canceled-round", parentRoundTotal: 7 },
    });
    broker.claimTask(canceledTask.id, "workergamma");
    broker.cancelTask(canceledTask.id, { actor: { id: "workergamma", kind: "node", role: "analyst" }, reason: "task canceled" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();

    const failedEvent = events.find(e => e.payload.taskId === "workergamma-failed");
    assert.ok(failedEvent, "workergamma-failed event must exist");
    assert.equal(failedEvent.payload.terminalBriefTitle, "A2A Terminal Brief 실패: workergamma(완료 1/7)");
    assert.equal(failedEvent.payload.status, "failed");
    assert.equal(failedEvent.payload.parentRoundProgress, 1);
    assert.equal(failedEvent.payload.parentRoundTotal, 7);

    const canceledEvent = events.find(e => e.payload.taskId === "workergamma-canceled");
    assert.ok(canceledEvent, "workergamma-canceled event must exist");
    assert.equal(canceledEvent.payload.terminalBriefTitle, "A2A Terminal Brief 취소: workergamma(완료 1/7)");
    assert.equal(canceledEvent.payload.status, "canceled");
    assert.equal(canceledEvent.payload.parentRoundProgress, 1);
    assert.equal(canceledEvent.payload.parentRoundTotal, 7);
  });

  it("replays terminal outbox events after a stable event id", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const first = createTask(broker, { id: "task-one" });
    const second = createTask(broker, { id: "task-two" });

    broker.claimTask(first.id, "worker-1");
    broker.failTask(first.id, "worker-1", { message: "tests failed" });
    broker.claimTask(second.id, "worker-1");
    broker.completeTask(second.id, "worker-1", { summary: "tests passed" });

    const all = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(all.length, 2);
    const replay = broker.getTerminalTaskEventOutbox().subscribe({ afterId: all[0]!.id });
    assert.equal(replay.length, 1);
    assert.equal(replay[0]!.payload.taskId, "task-two");
    assert.equal(replay[0]!.payload.status, "succeeded");
  });

  it("proves operator terminal push envelopes without direct Telegram delivery", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const sseEvents: TerminalTaskEvent[] = [];
    broker.getTaskEventStream().onTerminal((event) => sseEvents.push(event));

    const succeeded = createTask(broker, {
      id: "proof-succeeded",
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 229 },
    });
    broker.claimTask(succeeded.id, "worker-1");
    broker.completeTask(succeeded.id, "worker-1", { summary: "npm test passed" });
    broker.completeTask(succeeded.id, "worker-1", { summary: "duplicate terminal update ignored" });

    const failed = createTask(broker, {
      id: "proof-failed",
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 229 },
    });
    broker.claimTask(failed.id, "worker-1");
    broker.failTask(failed.id, "worker-1", {
      message: "tests failed token=fake-token-placeholder at /work/private/raw-session.log",
    });
    broker.failTask(failed.id, "worker-1", { message: "duplicate failure ignored" });

    createTask(broker, {
      id: "proof-blocked",
      policyContext: { requiresApproval: true },
      payload: {
        githubRepo: "jinwon-int/a2a-broker",
        githubIssueNumber: 229,
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/229#issuecomment-block",
        rawTranscript: "do-not-leak",
      },
    });

    const prOpened = createTask(broker, {
      id: "proof-pr-opened",
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 229 },
    });
    broker.claimTask(prOpened.id, "worker-1");
    broker.startTask(prOpened.id, "worker-1");
    broker.completeTask(prOpened.id, "worker-1", {
      summary: "PR opened and Done evidence posted from /work/repo/dist/core/task-events.test.js",
      output: {
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/230",
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/229#issuecomment-done",
        testSummary: {
          status: "passed",
          total: 1,
          passed: 1,
          summary: "operator push proof ok password=hunter2 /home/operator/session.txt",
        },
        rawLog: "do-not-leak",
      },
    });

    const outbox = broker.getTerminalTaskEventOutbox();
    const webhookEvents = outbox.subscribe();
    assert.deepEqual(
      webhookEvents.map((event) => event.payload.status),
      ["succeeded", "failed", "succeeded"],
    );
    assert.equal(outbox.size, 3);
    // The compact SSE projection mints exactly the same terminal records as the
    // durable outbox (#2056). `proof-blocked` is parked at the approval gate and
    // has not run, so neither surface announces it as terminal.
    assert.deepEqual(
      sseEvents.map((event) => event.status),
      ["succeeded", "failed", "succeeded"],
    );
    assert.equal(sseEvents.find((event) => event.taskId === "proof-blocked"), undefined);

    const replay = outbox.subscribe({ afterId: webhookEvents[1]!.id });
    assert.deepEqual(
      replay.map((event) => event.payload.taskId),
      ["proof-pr-opened"],
    );

    const envelopes = webhookEvents.map(toFakeOperatorEnvelope);
    assert.deepEqual(envelopes.map((envelope) => envelope.transportOwner), [
      "brokeralpha/OpenClaw plugin-notifier",
      "brokeralpha/OpenClaw plugin-notifier",
      "brokeralpha/OpenClaw plugin-notifier",
    ]);
    assert.equal(envelopes[2]!.body.prUrl, "https://github.com/jinwon-int/a2a-broker/pull/230");
    assert.equal(envelopes[2]!.body.doneUrl, "https://github.com/jinwon-int/a2a-broker/issues/229#issuecomment-done");

    const serialized = JSON.stringify({ envelopes, sseEvents });
    for (const forbidden of [
      "telegram",
      "rawLog",
      "rawTranscript",
      "do-not-leak",
      "fake-token-placeholder",
      "hunter2",
      "/work/private",
      "/work/repo",
      "/home/operator",
    ]) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), forbidden);
    }
  });

  it("persists terminal outbox replay and dedupe state in broker snapshots", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxTerminalTaskOutboxEvents: 10 });
    registerWorker(broker);
    const task = createTask(broker, {
      id: "persisted-terminal",
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 247 },
    });

    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", {
      summary: "npm test passed",
      output: { doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/247#issuecomment-done" },
    });

    const [before] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(before);
    broker.getTerminalTaskEventOutbox().acknowledge(before.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-02T00:00:00.000Z",
      receiptId: "operator-message-1",
    });

    const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot(), {
      maxTerminalTaskOutboxEvents: 10,
    });
    const replayed = restarted.getTerminalTaskEventOutbox().subscribe();
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]!.id, before.id);
    assert.deepEqual(replayed[0]!.ack, {
      status: "receipt_confirmed",
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-02T00:00:00.000Z",
      receiptId: "operator-message-1",
    });
    assert.equal(replayed[0]!.attempts, 1);
    assert.equal(
      restarted.getTerminalTaskEventOutbox().subscribe({ afterId: before.id }).length,
      0,
    );

    // Rehydrating the same snapshot twice must not duplicate records; the stable id
    // remains the durable dedupe key across restart/replay cycles.
    restarted.getTerminalTaskEventOutbox().restoreSnapshot(broker.exportSnapshot().terminalOutbox ?? []);
    assert.equal(restarted.getTerminalTaskEventOutbox().subscribe().length, 1);
  });

  it("acknowledges receipt-confirmed terminal records without removing replay state", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, { id: "ack-task" });

    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", { summary: "done" });

    const outbox = broker.getTerminalTaskEventOutbox();
    const [event] = outbox.subscribe();
    assert.ok(event);
    assert.deepEqual(event.receipt, {
      status: "accepted",
      updatedAt: event.createdAt,
    });
    assert.deepEqual(event.ackAudit!, {
      decision: "pending",
      reason: "terminal event accepted; awaiting current-session-visible/operator-visible evidence before ACK",
      updatedAt: event.createdAt,
      taskId: "ack-task",
      worker: "worker-1",
      receiptStatus: "accepted",
    });

    for (const evidence of ["gateway_send_success", "provider_send_success"]) {
      assert.throws(
        () => outbox.acknowledge(event.id, { evidence } as any),
        /current-session-visible\/operator-visible evidence/,
        evidence,
      );
    }
    assert.throws(
      () => outbox.acknowledge(event.id, { evidence: "provider_delivery_receipt" } as any),
      /current-session-visible\/operator-visible evidence/,
      "provider delivery evidence is a non-ACK provider receipt, not Terminal Brief visibility proof",
    );
    const rejected = outbox.subscribe()[0]!;
    assert.equal(rejected.attempts, 0);
    assert.equal(rejected.ackAudit!.decision, "rejected");
    assert.match(rejected.ackAudit!.reason, /provider evidence is not current-session-visible\/operator-visible evidence/);
    assert.equal(rejected.ackAudit!.taskId, "ack-task");
    assert.equal(rejected.ackAudit!.worker, "worker-1");

    const acknowledgedAt = "2026-05-01T00:00:00.000Z";
    const acked = outbox.acknowledge(event.id, {
      evidence: "operator_visible",
      acknowledgedAt,
      receiptId: "receipt-123",
      note: "operator saw message at /work/private token=fake-token-placeholder",
    });
    assert.ok(acked);
    assert.deepEqual(acked.ack, {
      status: "receipt_confirmed",
      evidence: "operator_visible",
      acknowledgedAt,
      receiptId: "receipt-123",
      note: "operator saw message at [path] token=[redacted]",
    });
    assert.deepEqual(acked.receipt, {
      status: "operator_visible",
      updatedAt: acknowledgedAt,
      evidence: "operator_visible",
      receiptId: "receipt-123",
      note: "operator saw message at [path] token=[redacted]",
    });
    assert.deepEqual(acked.ackAudit!, {
      decision: "confirmed",
      reason: "terminal ACK confirmed from operator-visible evidence",
      updatedAt: acknowledgedAt,
      taskId: "ack-task",
      worker: "worker-1",
      receiptStatus: "operator_visible",
      evidence: "operator_visible",
      receiptId: "receipt-123",
    });
    assert.equal(acked.deliveredAt, undefined);
    assert.equal(acked.attempts, 1);
    assert.equal(outbox.acknowledge("missing", { evidence: "operator_visible" }), null);

    const replayed = outbox.subscribe()[0];
    assert.equal(replayed!.id, event.id);
    assert.deepEqual(replayed!.ack, acked.ack);
    assert.deepEqual(replayed!.receipt, acked.receipt);
    assert.deepEqual(replayed!.ackAudit, acked.ackAudit);
    assert.equal(replayed!.attempts, 1);
  });

  it("acks current-session visibility separately from manual operator confirmation", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, { id: "current-session-visible-task" });

    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", { summary: "done" });

    const outbox = broker.getTerminalTaskEventOutbox();
    const [event] = outbox.subscribe();
    assert.ok(event);

    const acknowledgedAt = "2026-05-02T01:58:00.000Z";
    const acked = outbox.acknowledge(event.id, {
      evidence: "current_session_visible",
      acknowledgedAt,
      receiptId: "main-session-message-1",
    });

    assert.deepEqual(acked?.ack, {
      status: "receipt_confirmed",
      evidence: "current_session_visible",
      acknowledgedAt,
      receiptId: "main-session-message-1",
    });
    assert.deepEqual(acked?.receipt, {
      status: "current_session_visible",
      updatedAt: acknowledgedAt,
      evidence: "current_session_visible",
      receiptId: "main-session-message-1",
    });
    assert.equal(acked?.ackAudit?.decision, "confirmed");
    assert.equal(acked?.ackAudit?.receiptStatus, "current_session_visible");
    assert.match(acked?.ackAudit?.reason ?? "", /not provider send-only success or manual operator confirmation/);
  });

  it("keeps legacy provider-delivery ACK snapshots readable but rejects new provider ACK input", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, { id: "legacy-provider-ack" });

    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", { summary: "done" });

    const [event] = broker.getTerminalTaskEventOutbox().snapshot();
    assert.ok(event);
    const legacySnapshot: TerminalTaskOutboxEvent[] = [{
      ...event,
      ack: {
        status: "receipt_confirmed",
        evidence: "provider_delivery_receipt",
        acknowledgedAt: "2026-05-02T00:00:00.000Z",
        receiptId: "legacy-provider-receipt",
      },
      receipt: {
        status: "provider_sent",
        updatedAt: "2026-05-02T00:00:00.000Z",
        evidence: "provider_delivery_receipt",
        receiptId: "legacy-provider-receipt",
      },
      attempts: 1,
    }];

    const restored = new InMemoryA2ABroker();
    restored.getTerminalTaskEventOutbox().restoreSnapshot(legacySnapshot);
    const [restoredEvent] = restored.getTerminalTaskEventOutbox().subscribe();
    assert.equal(restoredEvent?.ack?.evidence, "provider_delivery_receipt");
    assert.equal(restoredEvent?.receipt.status, "provider_sent");

    assert.throws(
      () => broker.getTerminalTaskEventOutbox().acknowledge(event.id, { evidence: "provider_delivery_receipt" } as any),
      /current-session-visible\/operator-visible evidence/,
    );
  });

  it("tracks notification send failure and stale/timed-out receipt without acking", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, { id: "receipt-status-task" });

    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", { summary: "done" });

    const outbox = broker.getTerminalTaskEventOutbox();
    const [event] = outbox.subscribe();
    assert.ok(event);

    const providerSent = outbox.recordReceiptStatus(event.id, {
      status: "provider_sent",
      updatedAt: "2026-05-02T01:55:00.000Z",
      note: "provider accepted outbound send id=telegram:123",
    });
    assert.ok(providerSent);
    assert.equal(providerSent.ack, undefined);
    assert.deepEqual(providerSent.receipt, {
      status: "provider_sent",
      updatedAt: "2026-05-02T01:55:00.000Z",
      note: "provider accepted outbound send id=telegram:123",
    });
    assert.equal(providerSent.ackAudit!.decision, "pending");
    assert.match(providerSent.ackAudit!.reason, /provider send-only success/);
    assert.equal(providerSent.ackAudit!.receiptStatus, "provider_sent");

    const providerAccepted = outbox.recordReceiptStatus(event.id, {
      status: "provider_accepted",
      updatedAt: "2026-05-02T01:55:30.000Z",
      note: "provider accepted but no operator-visible receipt",
    });
    assert.ok(providerAccepted);
    assert.equal(providerAccepted.ack, undefined);
    assert.equal(providerAccepted.receipt.status, "provider_accepted");
    assert.equal(providerAccepted.ackAudit!.decision, "pending");
    assert.match(providerAccepted.ackAudit!.reason, /provider send-only success/);
    assert.equal(providerAccepted.ackAudit!.receiptStatus, "provider_accepted");

    const currentSessionVisible = outbox.recordReceiptStatus(event.id, {
      status: "current_session_visible",
      updatedAt: "2026-05-02T01:56:00.000Z",
      note: "main session rendered the message",
    });
    assert.ok(currentSessionVisible);
    assert.equal(currentSessionVisible.ack, undefined);
    assert.deepEqual(currentSessionVisible.ackAudit!, {
      decision: "eligible",
      reason: "current-session-visible receipt recorded; terminal ACK is eligible with current_session_visible evidence but is not manual operator confirmation",
      updatedAt: "2026-05-02T01:56:00.000Z",
      taskId: "receipt-status-task",
      worker: "worker-1",
      receiptStatus: "current_session_visible",
    });

    const operatorVisible = outbox.recordReceiptStatus(event.id, {
      status: "operator_visible",
      updatedAt: "2026-05-02T01:57:00.000Z",
      note: "operator-facing message visible",
    });
    assert.ok(operatorVisible);
    assert.equal(operatorVisible.ack, undefined);
    assert.deepEqual(operatorVisible.ackAudit!, {
      decision: "eligible",
      reason: "operator-visible receipt recorded; terminal ACK is eligible with operator_visible/operator_confirmed evidence",
      updatedAt: "2026-05-02T01:57:00.000Z",
      taskId: "receipt-status-task",
      worker: "worker-1",
      receiptStatus: "operator_visible",
    });

    const failed = outbox.recordReceiptStatus(event.id, {
      status: "failed",
      updatedAt: "2026-05-02T02:00:00.000Z",
      note: "provider send failed token=fake-token-placeholder",
    });
    assert.ok(failed);
    assert.equal(failed.ack, undefined);
    assert.deepEqual(failed.receipt, {
      status: "failed",
      updatedAt: "2026-05-02T02:00:00.000Z",
      note: "provider send failed token=[redacted]",
    });
    assert.equal(failed.ackAudit!.decision, "pending");
    assert.equal(failed.ackAudit!.receiptStatus, "failed");

    const timedOut = outbox.recordReceiptStatus(event.id, {
      status: "timed_out",
      updatedAt: "2026-05-02T02:15:00.000Z",
    });
    assert.equal(timedOut?.receipt.status, "timed_out");
    assert.equal(timedOut?.ack, undefined);

    const stale = outbox.recordReceiptStatus(event.id, {
      status: "stale",
      updatedAt: "2026-05-02T02:30:00.000Z",
    });
    assert.equal(stale?.receipt.status, "stale");
    assert.equal(outbox.subscribeWithCursor({ afterId: event.id }).reconciledUnacked, 1);
  });

  it("reconciles unacknowledged terminal records before a notifier cursor", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxTerminalTaskOutboxEvents: 10 });
    registerWorker(broker);

    for (const id of ["cursor-one", "cursor-two", "cursor-three"]) {
      const task = createTask(broker, { id });
      broker.claimTask(task.id, "worker-1");
      broker.completeTask(task.id, "worker-1", { summary: `done ${id}` });
    }

    const outbox = broker.getTerminalTaskEventOutbox();
    const firstPoll = outbox.subscribeWithCursor();
    const [first, second, third] = firstPoll.events;
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.equal(firstPoll.cursor, third.id);

    outbox.acknowledge(first.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-02T00:00:00.000Z",
    });

    const retryPoll = outbox.reconcile({ afterId: second.id });
    assert.deepEqual(retryPoll.events.map((event) => event.id), [second.id, third.id]);
    assert.equal(retryPoll.cursor, third.id);
    assert.equal(retryPoll.reconciledUnacked, 1);

    const retryOnly = outbox.subscribeWithCursor({ afterId: firstPoll.cursor ?? undefined, limit: 1 });
    assert.deepEqual(retryOnly.events.map((event) => event.id), [second.id]);
    assert.equal(retryOnly.cursor, third.id, "retry-only reconciliation must not move the cursor backward");
    assert.equal(retryOnly.reconciledUnacked, 1);
  });

  it("does not duplicate terminal records across manual ack and cursor replay", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxTerminalTaskOutboxEvents: 10 });
    registerWorker(broker);

    for (const id of ["manual-ack-one", "manual-ack-two", "manual-ack-three"]) {
      const task = createTask(broker, { id });
      broker.claimTask(task.id, "worker-1");
      broker.completeTask(task.id, "worker-1", { summary: `done ${id}` });
    }

    const outbox = broker.getTerminalTaskEventOutbox();
    const initial = outbox.subscribeWithCursor();
    const [first, second, third] = initial.events;
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    assert.equal(initial.cursor, third.id);

    outbox.acknowledge(second.id, {
      evidence: "operator_confirmed",
      acknowledgedAt: "2026-05-02T00:00:00.000Z",
      receiptId: "manual-ack-message-2",
    });

    const replay = outbox.reconcile({ afterId: initial.cursor ?? undefined });
    assert.deepEqual(replay.events.map((event) => event.id), [first.id, third.id]);
    assert.equal(new Set(replay.events.map((event) => event.id)).size, replay.events.length);
    assert.equal(replay.cursor, third.id);
    assert.equal(replay.reconciledUnacked, 2);

    for (const event of replay.events) {
      outbox.acknowledge(event.id, {
        evidence: "operator_visible",
        acknowledgedAt: "2026-05-02T00:01:00.000Z",
        receiptId: `receipt-${event.payload.taskId}`,
      });
    }

    const settled = outbox.reconcile({ afterId: initial.cursor ?? undefined });
    assert.deepEqual(settled.events, []);
    assert.equal(settled.cursor, third.id);
    assert.equal(settled.reconciledUnacked, 0);
    assert.equal(outbox.subscribe().length, 3, "acknowledged records remain retained for audit/dedupe");
  });

  it("replays unacked terminal records after notifier restart without duplicating receipt-confirmed records", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxTerminalTaskOutboxEvents: 10 });
    registerWorker(broker, "workeralpha");

    for (const id of ["restart-acked", "restart-unacked"]) {
      const task = createTask(broker, {
        id,
        targetNodeId: "workeralpha",
        payload: {
          githubRepo: "jinwon-int/a2a-broker",
          githubIssueNumber: 319,
          githubIssueTitle: "terminal outbox cursor recovery proof",
        },
      });
      broker.claimTask(task.id, "workeralpha");
      broker.completeTask(task.id, "workeralpha", { summary: `done ${id}` });
    }

    const outbox = broker.getTerminalTaskEventOutbox();
    const firstPoll = outbox.subscribeWithCursor();
    const [acked, unacked] = firstPoll.events;
    assert.ok(acked);
    assert.ok(unacked);
    assert.equal(firstPoll.cursor, unacked.id);

    outbox.acknowledge(acked.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-04T02:00:00.000Z",
      receiptId: "operator-terminal-visible-1",
    });

    // Simulate a notifier crash/restart that persisted its cursor after seeing both
    // records, but only receipt-confirmed the first terminal notice.
    const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot(), {
      maxTerminalTaskOutboxEvents: 10,
    });
    const replay = restarted.getTerminalTaskEventOutbox().reconcile({ afterId: firstPoll.cursor ?? undefined });

    assert.deepEqual(replay.events.map((event) => event.id), [unacked.id]);
    assert.equal(replay.cursor, unacked.id, "stale-cursor recovery must not move the notifier cursor backward");
    assert.equal(replay.reconciledUnacked, 1);
    const replayed = replay.events[0]!;
    assert.equal(replayed.payload.worker, "workeralpha");
    assert.equal(replayed.payload.taskBrief, "terminal outbox cursor recovery proof");
    assert.equal(
      renderFakeOperatorLine(replayed.payload),
      "workeralpha completed jinwon-int/a2a-broker#319 — terminal outbox cursor recovery proof",
    );

    restarted.getTerminalTaskEventOutbox().acknowledge(replayed.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-04T02:01:00.000Z",
      receiptId: "provider-receipt-replayed",
    });
    const settled = restarted.getTerminalTaskEventOutbox().reconcile({ afterId: firstPoll.cursor ?? undefined });
    assert.deepEqual(settled.events, []);
    assert.equal(settled.reconciledUnacked, 0);
  });

  it("retains unacked terminal outbox events for replay, bounded by the hard cap (a2a-nexus#573 item 20)", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxTerminalTaskOutboxEvents: 2 });
    registerWorker(broker);

    // 3 completed tasks => 3 receipt-unconfirmed terminal events. They exceed
    // maxEvents=2 but must NOT be evicted: subscribeWithCursor replays unacked
    // events, and a plain "drop oldest" would silently lose them.
    for (const id of ["retain-1", "retain-2", "retain-3"]) {
      const task = createTask(broker, { id });
      broker.claimTask(task.id, "worker-1");
      broker.completeTask(task.id, "worker-1", { summary: `done ${id}` });
    }
    let retained = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(retained.length, 3, "unacked events must not be evicted at maxEvents");
    assert.deepEqual(
      retained.map((event) => event.payload.taskId),
      ["retain-1", "retain-2", "retain-3"],
    );

    // Two more unacked events trip the hard cap (2 * maxEvents = 4); only then
    // is the oldest unacked event dropped, so memory stays bounded.
    for (const id of ["retain-4", "retain-5"]) {
      const task = createTask(broker, { id });
      broker.claimTask(task.id, "worker-1");
      broker.completeTask(task.id, "worker-1", { summary: `done ${id}` });
    }
    retained = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(retained.length, 4, "the hard cap bounds unacked growth at 2x maxEvents");
    assert.deepEqual(
      retained.map((event) => event.payload.taskId),
      ["retain-2", "retain-3", "retain-4", "retain-5"],
    );
  });

  it("excludes worker heartbeats and approval-blocked creation noise from the terminal outbox", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");

    broker.heartbeatWorker("worker-a", { metadata: { check: "alive" } });
    const blocked = broker.createTask({
      intent: "apply_local_change",
      requester: { id: "analyst-a", kind: "node", role: "analyst" },
      target: { id: "worker-a", kind: "node", role: "live-trader" },
      workspace: { nodeId: "worker-a", workspaceId: "test" },
      message: "apply live patch",
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(broker.getTerminalTaskEventOutbox().subscribe().length, 0);
  });

  // ---------------------------------------------------------------------------
  // Regression: SSE terminal stream and durable outbox must agree on what is
  // terminal (#2056).
  //
  // `blocked` is the pre-execution approval gate (broker.ts sets it at creation
  // and on requeue when `policyContext.requiresApproval` is set), not a
  // completion result. A worker that reports a Block outcome fails the task
  // (`TaskEvidenceOutcome` "blocked" -> failTask -> status "failed"), so Block
  // evidence still reaches both surfaces through the `failed` path.
  // ---------------------------------------------------------------------------

  it("does not project an approval-blocked task as terminal on either surface", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const sseEvents: TerminalTaskEvent[] = [];
    broker.getTaskEventStream().onTerminal((event) => sseEvents.push(event));

    const blocked = createTask(broker, {
      id: "gate-blocked",
      policyContext: { requiresApproval: true },
      payload: { blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/2056#issuecomment-block" },
    });

    assert.equal(blocked.status, "blocked");
    // Durable outbox gates on kind; the SSE stream must gate on the same set.
    assert.deepEqual(
      broker.getTerminalTaskEventOutbox().subscribe().map((event) => event.payload.status),
      [],
    );
    assert.deepEqual(sseEvents.map((event) => event.status), []);

    // The non-terminal status stream still carries the early "waiting on an
    // operator" signal, so removing the terminal projection loses no visibility.
    const statusEvents = broker.getTaskEventStream().subscribe({ taskId: "gate-blocked" });
    assert.deepEqual(
      statusEvents.map((event) => `${event.kind}:${event.status}`),
      ["created:blocked"],
    );

    // Once approved, claimed and completed, both surfaces emit exactly one
    // terminal record with the same status.
    broker.approveTask("gate-blocked", {
      actor: { id: "operator-1", kind: "node", role: "operator" },
    });
    broker.claimTask("gate-blocked", "worker-1");
    broker.completeTask("gate-blocked", "worker-1", { summary: "done" });

    assert.deepEqual(sseEvents.map((event) => event.status), ["succeeded"]);
    assert.deepEqual(
      broker.getTerminalTaskEventOutbox().subscribe().map((event) => event.payload.status),
      ["succeeded"],
    );
  });

  it("approval-blocked lane does not inflate the shared parent-round numerator", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-1");
    registerWorker(broker, "worker-2");

    // Lane A is parked at the approval gate and never runs.
    const laneA = createTask(broker, {
      id: "round-lane-a",
      targetNodeId: "worker-1",
      policyContext: { requiresApproval: true },
      payload: { run: "round-2056", parentRoundTotal: 2 },
    });
    assert.equal(laneA.status, "blocked");

    // Lane B actually runs to completion.
    createTask(broker, {
      id: "round-lane-b",
      targetNodeId: "worker-2",
      payload: { run: "round-2056", parentRoundTotal: 2 },
    });
    broker.claimTask("round-lane-b", "worker-2");
    broker.completeTask("round-lane-b", "worker-2", { summary: "ok" });

    const outbox = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(outbox.length, 1);
    const [event] = outbox;
    assert.equal(event.payload.taskId, "round-lane-b");
    // The SSE stream shares the RoundProgressTracker with the outbox, so a
    // terminal projection for the still-gated lane A would report the round as
    // 2/2 complete while lane A has not even been dispatched.
    assert.equal(event.payload.parentRoundProgress, 1);
    assert.equal(event.payload.parentRoundTotal, 2);
    assert.ok(
      event.payload.terminalBriefTitle?.includes("1/2"),
      `Terminal Brief title must report 1/2, got: ${event.payload.terminalBriefTitle}`,
    );
  });

  it("Terminal Brief single-task 1/1 succeeds with 1/1 progress", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");

    const task = createTask(broker, {
      id: "single-task-single-round",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r-single-1of1", parentRoundTotal: 1 },
    });
    broker.claimTask(task.id, "workergamma");
    broker.completeTask(task.id, "workergamma", { summary: "done" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    const event = events.find(e => e.payload.taskId === "single-task-single-round");
    assert.ok(event);
    assert.equal(event.payload.parentRoundProgress, 1);
    assert.equal(event.payload.parentRoundTotal, 1);
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 1/1)");
    assert.equal(event.payload.status, "succeeded");
  });

  // ---------------------------------------------------------------------------
  // Regression tests: Terminal Brief metadata guard/hardening
  // - Ambiguous round-shaped input must not silently render ?/?
  // - Valid multi-lane metadata must keep deterministic n/N
  // - Standalone single-worker rendering must not regress
  // - runId-only payload without total/order must stay standalone
  // ---------------------------------------------------------------------------

  it("valid 4-lane round metadata renders deterministic n/4 title", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");
    registerWorker(broker, "workerdelta");
    registerWorker(broker, "workerbeta");
    registerWorker(broker, "workeralpha");

    const lanes = ["workergamma", "workerdelta", "workerbeta", "workeralpha"];
    const tasks = lanes.map((worker, i) => {
      const task = createTask(broker, {
        id: `regression-lane-${worker}`,
        targetNodeId: worker,
        payload: {
          parentRoundId: "r4-lane-regression",
          originBrokerId: "brokeralpha",
          brokerOfRecordId: "brokeralpha",
          parentRoundTotal: 4,
          parentRoundOrder: i + 1,
        },
      });
      return { task, worker };
    });

    for (const { task, worker } of tasks) {
      broker.claimTask(task.id, worker);
      broker.completeTask(task.id, worker, { summary: `${worker} done` });
    }

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    lanes.forEach((worker, i) => {
      const event = events.find(e => e.payload.taskId === `regression-lane-${worker}`);
      assert.ok(event, `event for ${worker} exists`);
      assert.equal(event.payload.parentRoundTotal, 4);
      assert.equal(event.payload.parentRoundOrder, i + 1);
      assert.equal(event.payload.parentRoundProgress, i + 1);
      assert.equal(event.payload.originBrokerId, "brokeralpha");
      assert.equal(event.payload.brokerOfRecordId, "brokeralpha");
      assert.ok(event.payload.terminalBriefTitle);
      assert.match(
        event.payload.terminalBriefTitle,
        /^A2A Terminal Brief (완료|실패|취소|차단): /,
      );
      assert.equal(event.payload.terminalBriefTitle, `A2A Terminal Brief 완료: ${worker}(완료 ${i + 1}/4)`);
    });
  });

  it("runId-only payload without total/order stays standalone", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workeralpha");

    // Simulate a retry task that only carries runId as round context
    const task = createTask(broker, {
      id: "regression-runId-only",
      targetNodeId: "workeralpha",
      payload: {
        runId: "simulated-retry-run",
      },
    });
    broker.claimTask(task.id, "workeralpha");
    broker.completeTask(task.id, "workeralpha", { summary: "retry succeeded" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    const event = events.find(e => e.payload.taskId === "regression-runId-only");
    assert.ok(event);
    assert.equal(event.payload.run, "simulated-retry-run");
    assert.equal(event.payload.parentRoundId, undefined);
    assert.equal(event.payload.parentRoundTotal, undefined);
    assert.equal(event.payload.parentRoundOrder, undefined);
    assert.ok(event.payload.terminalBriefTitle);
    assert.doesNotMatch(event.payload.terminalBriefTitle, /\?\//);
    assert.doesNotMatch(event.payload.terminalBriefTitle, /진단/);
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workeralpha");
  });

  it("standalone single-worker without round metadata keeps simple title", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");

    // A task with no parentRoundId, no runId, no round metadata at all
    const task = createTask(broker, {
      id: "regression-standalone-no-round",
      targetNodeId: "workergamma",
      payload: {},
    });
    broker.claimTask(task.id, "workergamma");
    broker.completeTask(task.id, "workergamma", { summary: "standalone done" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    const event = events.find(e => e.payload.taskId === "regression-standalone-no-round");
    assert.ok(event);
    // Standalone falls through to: A2A Terminal Brief 완료: workergamma (no progress parens)
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma");
    // No diagnostic, no ?/?, no progress
    assert.doesNotMatch(event.payload.terminalBriefTitle, /\//);
    assert.doesNotMatch(event.payload.terminalBriefTitle, /진단/);
  });

  it("Terminal Brief out-of-order completion uses correct completed-lane count", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");

    // Complete task B first, then task A
    const taskB = createTask(broker, {
      id: "out-of-order-b",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r-out-of-order", parentRoundTotal: 2 },
    });
    broker.claimTask(taskB.id, "workergamma");
    broker.completeTask(taskB.id, "workergamma", { summary: "task B done first" });

    const taskA = createTask(broker, {
      id: "out-of-order-a",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r-out-of-order", parentRoundTotal: 2 },
    });
    broker.claimTask(taskA.id, "workergamma");
    broker.completeTask(taskA.id, "workergamma", { summary: "task A done second" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    const eventB = events.find(e => e.payload.taskId === "out-of-order-b");
    const eventA = events.find(e => e.payload.taskId === "out-of-order-a");
    assert.ok(eventB);
    assert.ok(eventA);

    // First terminal task gets completed-lane count 1
    assert.equal(eventB.payload.parentRoundProgress, 1);
    assert.equal(eventB.payload.parentRoundTotal, 2);
    assert.equal(eventB.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 1/2)");

    // Second terminal task gets completed-lane count 2
    assert.equal(eventA.payload.parentRoundProgress, 2);
    assert.equal(eventA.payload.parentRoundTotal, 2);
    assert.equal(eventA.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 2/2)");
  });

  it("Terminal Brief failed tasks increment completed-lane progress", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");

    // First task fails
    const failTask = createTask(broker, {
      id: "mixed-fail",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r-mixed-round", parentRoundTotal: 3 },
    });
    broker.claimTask(failTask.id, "workergamma");
    broker.failTask(failTask.id, "workergamma", { message: "failed" });

    // Second task succeeds
    const succeedTask = createTask(broker, {
      id: "mixed-succeed",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r-mixed-round", parentRoundTotal: 3 },
    });
    broker.claimTask(succeedTask.id, "workergamma");
    broker.completeTask(succeedTask.id, "workergamma", { summary: "succeeded" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();

    const failedEvent = events.find(e => e.payload.taskId === "mixed-fail");
    assert.ok(failedEvent);
    assert.equal(failedEvent.payload.status, "failed");
    // Failed task still reports lane completion for operator progress.
    assert.equal(failedEvent.payload.parentRoundProgress, 1);
    assert.equal(failedEvent.payload.terminalBriefTitle, "A2A Terminal Brief 실패: workergamma(완료 1/3)");

    const succeededEvent = events.find(e => e.payload.taskId === "mixed-succeed");
    assert.ok(succeededEvent);
    assert.equal(succeededEvent.payload.status, "succeeded");
    // Succeeded task is the second terminal lane in the round.
    assert.equal(succeededEvent.payload.parentRoundProgress, 2);
    assert.equal(succeededEvent.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 2/3)");
  });

  it("Terminal Brief retry replaces failed task: same canonical child counts once when succeeded", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");

    // Task fails — no succeeded children yet
    const task = createTask(broker, {
      id: "retry-child-fixed-id",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r-retry-round", parentRoundTotal: 2 },
    });
    broker.claimTask(task.id, "workergamma");
    broker.failTask(task.id, "workergamma", { message: "first attempt failed" });

    // Retry with new task ID but same round — this is a new canonical child
    const retry = createTask(broker, {
      id: "retry-child-retry-attempt",
      targetNodeId: "workergamma",
      payload: { parentRoundId: "r-retry-round", parentRoundTotal: 2 },
    });
    broker.claimTask(retry.id, "workergamma");
    broker.completeTask(retry.id, "workergamma", { summary: "retry succeeded" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();

    const failedEvent = events.find(e => e.payload.taskId === "retry-child-fixed-id");
    assert.ok(failedEvent);
    assert.equal(failedEvent.payload.parentRoundProgress, 1);
    assert.equal(failedEvent.payload.terminalBriefTitle, "A2A Terminal Brief 실패: workergamma(완료 1/2)");

    const succeededEvent = events.find(e => e.payload.taskId === "retry-child-retry-attempt");
    assert.ok(succeededEvent);
    // Retry is the second terminal event for the round.
    assert.equal(succeededEvent.payload.parentRoundProgress, 2);
    assert.equal(succeededEvent.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 2/2)");
  });

  it("Terminal Brief failed final lane counts as completed progress", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "workergamma");

    for (const [id, order] of [
      ["round-child-success-1", 2],
      ["round-child-success-2", 3],
      ["round-child-success-3", 4],
    ] as const) {
      const task = createTask(broker, {
        id,
        targetNodeId: "workergamma",
        payload: {
          parentRoundId: "r-final-failure-round",
          parentRoundTotal: 4,
          parentRoundOrder: order,
          originBrokerId: "brokeralpha",
        },
      });
      broker.claimTask(task.id, "workergamma");
      broker.completeTask(task.id, "workergamma", { summary: "succeeded" });
    }

    const failedTask = createTask(broker, {
      id: "round-child-failed-last",
      targetNodeId: "workergamma",
      payload: {
        parentRoundId: "r-final-failure-round",
        parentRoundTotal: 4,
        parentRoundOrder: 1,
        originBrokerId: "brokeralpha",
      },
    });
    broker.claimTask(failedTask.id, "workergamma");
    broker.failTask(failedTask.id, "workergamma", { message: "failed after three successes" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    const failedEvent = events.find(e => e.payload.taskId === "round-child-failed-last");
    assert.ok(failedEvent);
    assert.equal(failedEvent.payload.status, "failed");
    assert.equal(failedEvent.payload.parentRoundProgress, 4);
    assert.equal(failedEvent.payload.parentRoundTerminalProgress, 4);
    assert.equal(failedEvent.payload.parentRoundOrder, 1);
    assert.equal(failedEvent.payload.terminalBriefTitle, "A2A Terminal Brief 실패: workergamma(완료 4/4)");
  });

  it("Terminal Brief local parent round uses completed progress rather than lane order", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
    registerWorker(broker, "workergamma");

    // Create first succeeded child so progress becomes 1
    const task1 = createTask(broker, {
      id: "order-test-first",
      targetNodeId: "workergamma",
      payload: {
        parentRoundId: "r-order-round",
        parentRoundTotal: 4,
        parentRoundOrder: 1,
        originBrokerId: "brokeralpha",
      },
    });
    broker.claimTask(task1.id, "workergamma");
    broker.completeTask(task1.id, "workergamma", { summary: "first completed" });

    // Second child: lane 4 of 4, but only progress=1 (only one succeeded so far)
    const task4 = createTask(broker, {
      id: "order-test-fourth",
      targetNodeId: "workergamma",
      payload: {
        parentRoundId: "r-order-round",
        parentRoundTotal: 4,
        parentRoundOrder: 4,
        originBrokerId: "brokeralpha",
      },
    });
    broker.claimTask(task4.id, "workergamma");
    broker.completeTask(task4.id, "workergamma", { summary: "fourth completed" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();

    const firstEvent = events.find(e => e.payload.taskId === "order-test-first");
    assert.ok(firstEvent);
    assert.equal(firstEvent.payload.parentRoundProgress, 1);
    assert.equal(firstEvent.payload.parentRoundOrder, 1);
    assert.equal(firstEvent.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 1/4)");

    const fourthEvent = events.find(e => e.payload.taskId === "order-test-fourth");
    assert.ok(fourthEvent);
    assert.equal(fourthEvent.payload.parentRoundProgress, 2);
    assert.equal(fourthEvent.payload.parentRoundOrder, 4);
    assert.equal(fourthEvent.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workergamma(완료 2/4)");
  });

  it("Terminal Brief same-broker parent-owned round does not use lane order as progress", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokeralpha" });
    registerWorker(broker, "workerdelta");

    const task = createTask(broker, {
      id: "same-broker-parent-owned-third-lane-first",
      targetNodeId: "workerdelta",
      payload: {
        parentRoundId: "same-broker-parent-owned-round",
        parentRoundTotal: 4,
        parentRoundOrder: 3,
        originBrokerId: "brokeralpha",
        brokerOfRecordId: "brokeralpha",
        operatorFacingOwner: "parent",
      },
    });
    broker.claimTask(task.id, "workerdelta");
    broker.completeTask(task.id, "workerdelta", { summary: "third lane completed first" });

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.payload.parentRoundOrder, 3);
    assert.equal(event.payload.parentRoundProgress, 1);
    assert.equal(event.payload.parentRoundTerminalProgress, 1);
    assert.equal(event.payload.parentRoundProgressSource, "broker_local_count");
    assert.equal(event.payload.notificationOwnership, undefined);
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerdelta(완료 1/4)");
  });

  it("Terminal Brief parentRoundNum=2/2 is preserved when it is the first local child completion", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
    registerWorker(broker, "workerzeta");

    const task = createTask(broker, {
      id: "parent-round-num-first-child",
      targetNodeId: "workerzeta",
      payload: {
        parentRoundId: "brokeralpha-led-cross-broker-round",
        parentRoundTotal: 2,
        parentRoundNum: 2,
        originBrokerId: "brokeralpha",
        brokerOfRecordId: "brokeralpha",
        crossBrokerHandoff: {
          parentRoundId: "brokeralpha-led-cross-broker-round",
          originBrokerId: "brokeralpha",
          handoffBrokerId: "brokerbeta",
        },
      },
    });
    broker.claimTask(task.id, "workerzeta");
    broker.completeTask(task.id, "workerzeta", { summary: "Team2 child completed" });

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.payload.parentRoundProgress, 2);
    assert.equal(event.payload.parentRoundOrder, 2);
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 2/2)");
  });

  it("parent-owned cross-broker Terminal Brief uses parent order for handoff progress", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
    registerWorker(broker, "workerzeta");

    const task = createTask(broker, {
      id: "parent-owned-live-shape-workerzeta",
      targetNodeId: "workerzeta",
      payload: {
        runId: "terminal-brief-runner317-proof-20260521",
        parentRoundId: "terminal-brief-runner317-proof-20260521",
        parentRoundTotal: 2,
        roundTotal: 2,
        parentRoundNum: 2,
        parentRoundOrder: 2,
        roundNum: 2,
        laneWorker: "workerzeta",
        parentOwnedTerminalBrief: true,
        operatorFacingOwner: "parent",
        originBrokerId: "brokeralpha",
        brokerOfRecordId: "brokeralpha",
        handoffBrokerId: "brokerbeta",
        terminalBrief: {
          parentRoundId: "terminal-brief-runner317-proof-20260521",
          originBrokerId: "brokeralpha",
          parentRoundTotal: 2,
          parentRoundNum: 2,
          parentRoundOrder: 2,
          workerId: "workerzeta",
        },
      },
    });
    broker.claimTask(task.id, "workerzeta");
    broker.completeTask(task.id, "workerzeta", { summary: "Team2 child completed" });

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.payload.parentRoundOrder, 2);
    assert.equal(event.payload.parentRoundProgress, 2);
    assert.equal(event.payload.parentRoundTerminalProgress, 2);
    assert.equal(event.payload.parentRoundProgressSource, "parent_round_order");
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 2/2)");
    assert.equal(event.payload.crossBrokerHandoff?.originBrokerId, "brokeralpha");
    assert.equal(event.payload.crossBrokerHandoff?.handoffBrokerId, "brokerbeta");
    assert.deepEqual(event.payload.notificationOwnership, {
      ownerBrokerId: "brokeralpha",
      scope: "parent-broker-only",
      providerSendPermittedByProjection: false,
      terminalAckPermittedByProjection: false,
      reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
    });
  });

  it("infers parent-owned cross-broker Terminal Brief ownership from origin operator owner", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "brokerbeta" });
    registerWorker(broker, "workerzeta");

    const task = createTask(broker, {
      id: "brokeralpha-led-team2-parent-owned-workerzeta",
      targetNodeId: "workerzeta",
      payload: {
        parentRoundId: "family-wiki-cleanup-scan-20260522T031233Z",
        parentRoundTotal: 7,
        parentRoundOrder: 6,
        originBrokerId: "brokeralpha",
        brokerOfRecordId: "brokerbeta",
        operatorFacingOwner: "brokeralpha",
      },
    });
    broker.claimTask(task.id, "workerzeta");
    broker.completeTask(task.id, "workerzeta", { summary: "Team2 child completed" });

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.payload.brokerOfRecordId, "brokeralpha");
    assert.equal(event.payload.originBrokerId, "brokeralpha");
    assert.equal(event.payload.parentRoundOrder, 6);
    assert.equal(event.payload.parentRoundProgress, 6);
    assert.equal(event.payload.parentRoundTerminalProgress, 6);
    assert.equal(event.payload.parentRoundProgressSource, "parent_round_order");
    assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: workerzeta(완료 6/7)");
    assert.deepEqual(event.payload.crossBrokerHandoff, {
      parentRoundId: "family-wiki-cleanup-scan-20260522T031233Z",
      originBrokerId: "brokeralpha",
      handoffBrokerId: "brokerbeta",
      childWorkerId: "workerzeta",
    });
    assert.deepEqual(event.payload.notificationOwnership, {
      ownerBrokerId: "brokeralpha",
      scope: "parent-broker-only",
      providerSendPermittedByProjection: false,
      terminalAckPermittedByProjection: false,
      reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
    });
  });
});

function renderFakeOperatorLine(payload: TerminalTaskOutboxEvent["payload"]): string {
  const worker = payload.worker ?? "worker";
  const verb = payload.status === "succeeded" ? "completed" : payload.status;
  const issue = payload.repo && payload.issue !== undefined ? `${payload.repo}#${payload.issue}` : payload.taskId;
  const brief = payload.taskBrief ? ` — ${payload.taskBrief}` : "";
  return `${worker} ${verb} ${issue}${brief}`;
}

function toFakeOperatorEnvelope(event: TerminalTaskOutboxEvent) {
  return {
    envelopeVersion: 1,
    delivery: "operator-terminal-push-proof",
    transportOwner: "brokeralpha/OpenClaw plugin-notifier",
    brokerTransport: "webhook-or-sse",
    cursor: event.id,
    body: event.payload,
  };
}

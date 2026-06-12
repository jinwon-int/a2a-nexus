import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBrokerStateStore } from "./core/store.js";
import { startTestServer, jsonHeaders, registerTestWorker, readAllSseEvents, readSseEventsUntil } from "./server-test-helpers.js";

test("GET/POST /a2a/tasks/terminal-outbox replays and acknowledges compact records", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", rateLimitMaxRequests: 20 });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        payload: { githubRepo: "acme/example", githubIssueNumber: 246, rawPrompt: "do-not-leak" },
        message: "do not leak this prompt",
      }),
    });
    const task = await taskRes.json();

    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          summary: "Done from /work/repo/dist/server.test.js token=fake-token-placeholder",
          output: {
            doneUrl: "https://github.com/acme/example/issues/246#issuecomment-done",
            rawLog: "do-not-leak",
          },
        },
      }),
    });

    const listRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.kind, "task.terminal.outbox");
    assert.equal(list.count, 1);
    const [event] = list.events;
    assert.equal(event.kind, "task.terminal");
    assert.equal(event.payload.taskId, task.id);
    assert.equal(event.payload.status, "succeeded");
    assert.equal(event.payload.worker, "worker-a");
    assert.equal(event.payload.repo, "acme/example");
    assert.equal(event.payload.issue, 246);
    assert.equal(event.payload.doneUrl, "https://github.com/acme/example/issues/246#issuecomment-done");
    assert.match(event.payload.testSummary, /Done from \[path\]/);
    assert.equal(list.cursor, event.id);

    const replayRes = await fetch(
      `${server.baseUrl}/a2a/tasks/terminal-outbox?after_id=${encodeURIComponent(event.id)}`,
      {
        headers: {
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "hub-a",
          "x-a2a-requester-role": "hub",
        },
      },
    );
    const replay = await replayRes.json();
    assert.equal(replay.count, 0);
    assert.equal(replay.cursor, event.id);

    const falseAckRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({ id: event.id, deliveredAt: "2026-05-02T00:00:00.000Z" }),
    });
    assert.equal(falseAckRes.status, 400);

    for (const evidence of ["gateway_send_success", "provider_send_success", "provider_accepted"]) {
      const sendSuccessAckRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
        method: "POST",
        headers: hubHeaders,
        body: JSON.stringify({ id: event.id, receipt: { evidence } }),
      });
      assert.equal(sendSuccessAckRes.status, 400, evidence);
    }

    const providerSentAt = "2026-05-01T23:59:00.000Z";
    const providerSentRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/receipt`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: { status: "provider_sent", updatedAt: providerSentAt, note: "provider accepted message-id=abc" },
      }),
    });
    assert.equal(providerSentRes.status, 200);
    const providerSent = await providerSentRes.json();
    assert.equal(providerSent.event.ack, undefined);
    assert.deepEqual(providerSent.event.receipt, {
      status: "provider_sent",
      updatedAt: providerSentAt,
      note: "provider accepted message-id=abc",
    });

    const reportRes = await fetch(`${server.baseUrl}/operator/task-report?task_id=${encodeURIComponent(task.id)}`, {
      headers: hubHeaders,
    });
    assert.equal(reportRes.status, 200);
    const report = await reportRes.json();
    assert.equal(report.items[0].receiptStatus, "provider_sent");
    assert.equal(report.items[0].terminalBrief.cursor, event.id);
    assert.equal(report.items[0].terminalBrief.ackStatus, "unacknowledged");
    assert.equal(report.items[0].terminalBrief.evidenceUrl, "https://github.com/acme/example/issues/246#issuecomment-done");
    assert.match(report.items[0].reportLine, /receipt gap: provider_sent/);

    const providerAcceptedAt = "2026-05-01T23:59:30.000Z";
    const providerAcceptedRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/receipt`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: { status: "provider_accepted", updatedAt: providerAcceptedAt, note: "provider accepted only" },
      }),
    });
    assert.equal(providerAcceptedRes.status, 200);
    const providerAccepted = await providerAcceptedRes.json();
    assert.equal(providerAccepted.event.ack, undefined);
    assert.deepEqual(providerAccepted.event.receipt, {
      status: "provider_accepted",
      updatedAt: providerAcceptedAt,
      note: "provider accepted only",
    });

    const inboxRes = await fetch(`${server.baseUrl}/terminal-brief/inbox`, { headers: hubHeaders });
    assert.equal(inboxRes.status, 200);
    const inbox = await inboxRes.json();
    assert.equal(inbox.kind, "a2a-broker.terminal-brief.inbox");
    assert.equal(inbox.summary.rawUnacked, 1);
    assert.equal(inbox.summary.actionableUnacked, 1);
    assert.equal(inbox.summary.providerSendOnlyUnacked, 1);
    assert.equal(inbox.query.events[0].taskId, task.id);
    assert.equal(inbox.query.events[0].actionableUnacked, true);
    assert.equal(inbox.query.events[0].ackIneligibleProjection, false);

    const controlTowerRes = await fetch(`${server.baseUrl}/control-tower`, { headers: hubHeaders });
    assert.equal(controlTowerRes.status, 200);
    const controlTower = await controlTowerRes.json();
    assert.equal(controlTower.kind, "a2a-broker.control-tower.snapshot");
    assert.equal(controlTower.safety.readOnly, true);
    assert.equal(controlTower.terminalBrief.actionableUnacked, 1);
    assert.equal(controlTower.workerCapacity.items.length, 1);

    const acknowledgedAt = "2026-05-02T00:00:00.000Z";
    const ackRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: {
          evidence: "operator_visible",
          acknowledgedAt,
          receiptId: "operator-message-246",
        },
      }),
    });
    assert.equal(ackRes.status, 200);
    const ack = await ackRes.json();
    assert.deepEqual(ack.event.ack, {
      status: "receipt_confirmed",
      evidence: "operator_visible",
      acknowledgedAt,
      receiptId: "operator-message-246",
    });
    assert.deepEqual(ack.event.receipt, {
      status: "operator_visible",
      updatedAt: acknowledgedAt,
      evidence: "operator_visible",
      receiptId: "operator-message-246",
    });
    assert.equal(ack.event.deliveredAt, undefined);
    assert.equal(ack.event.attempts, 1);

    const serialized = JSON.stringify({ list, ack });
    for (const forbidden of ["do not leak", "rawPrompt", "rawLog", "do-not-leak", "fake-token-placeholder", "/work/repo"]) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  } finally {
    await server.close();
  }
});

test("terminal outbox receipt and ACK endpoints persist SQLite hot rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-outbox-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"), { loadSource: "hot-tables" });
  const server = await startTestServer({ stateStore: store, edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });

    const createRes = await fetch(server.baseUrl + "/tasks", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "persist terminal outbox ACK",
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const claimRes = await fetch(server.baseUrl + "/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimRes.status, 200);

    const completeRes = await fetch(server.baseUrl + "/tasks/" + encodeURIComponent(task.id) + "/complete", {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a", result: { summary: "done" } }),
    });
    assert.equal(completeRes.status, 200);

    const [event] = store.readHotTerminalOutbox();
    assert.ok(event, "terminal outbox event should be persisted before ACK");
    assert.equal(event.ack, undefined);
    let diagnostics = store.readHotTerminalOutboxDiagnostics();
    assert.equal(diagnostics.total, 1);
    assert.equal(diagnostics.acked, 0);
    assert.equal(diagnostics.rawUnacked, 1);
    assert.equal(diagnostics.unacked, 1);
    assert.equal(diagnostics.ackEligibleUnacked, 1);
    assert.equal(diagnostics.ackIneligibleUnacked, 0);
    assert.equal(diagnostics.unackedRatio, 1);
    assert.equal(diagnostics.oldestUnackedCreatedAt, event.createdAt);
    assert.deepEqual(diagnostics.warnings, []);

    const receiptAt = "2026-05-02T00:00:00.000Z";
    const receiptRes = await fetch(server.baseUrl + "/a2a/tasks/terminal-outbox/receipt", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: { status: "provider_accepted", updatedAt: receiptAt, note: "provider accepted only" },
      }),
    });
    assert.equal(receiptRes.status, 200);
    let persisted = store.readHotTerminalOutbox()[0]!;
    assert.deepEqual(persisted.receipt, {
      status: "provider_accepted",
      updatedAt: receiptAt,
      note: "provider accepted only",
    });
    assert.equal(store.readHotTerminalOutboxDiagnostics().unacked, 1);

    const acknowledgedAt = "2026-05-02T00:01:00.000Z";
    const ackRes = await fetch(server.baseUrl + "/a2a/tasks/terminal-outbox/ack", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: {
          evidence: "operator_visible",
          acknowledgedAt,
          receiptId: "operator-message-1",
        },
      }),
    });
    assert.equal(ackRes.status, 200);
    persisted = store.readHotTerminalOutbox()[0]!;
    assert.deepEqual(persisted.ack, {
      status: "receipt_confirmed",
      evidence: "operator_visible",
      acknowledgedAt,
      receiptId: "operator-message-1",
    });
    assert.equal(persisted.receipt.status, "operator_visible");
    assert.equal(persisted.attempts, 1);
    diagnostics = store.readHotTerminalOutboxDiagnostics();
    assert.equal(diagnostics.total, 1);
    assert.equal(diagnostics.acked, 1);
    assert.equal(diagnostics.rawUnacked, 0);
    assert.equal(diagnostics.unacked, 0);
    assert.equal(diagnostics.ackEligibleUnacked, 0);
    assert.equal(diagnostics.ackIneligibleUnacked, 0);
    assert.equal(diagnostics.unackedRatio, 0);
    assert.equal(diagnostics.oldestUnackedCreatedAt, null);
    assert.equal(diagnostics.oldestUnackedAgeMs, null);
    assert.deepEqual(diagnostics.warnings, []);

    const duplicateAckRes = await fetch(server.baseUrl + "/a2a/tasks/terminal-outbox/ack", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: {
          evidence: "operator_visible",
          acknowledgedAt,
          receiptId: "operator-message-1",
        },
      }),
    });
    assert.equal(duplicateAckRes.status, 200);
    persisted = store.readHotTerminalOutbox()[0]!;
    assert.equal(persisted.attempts, 1, "duplicate ACK should not create another terminal attempt");
    assert.equal(store.readHotTerminalOutboxDiagnostics().acked, 1);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /a2a/tasks/terminal-outbox reconciles unacknowledged records before cursor", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });

    for (const name of ["one", "two", "three"]) {
      const createRes = await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: hubHeaders,
        body: JSON.stringify({
          intent: "analyze",
          requester: { id: "hub-a", kind: "node", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          assignedWorkerId: "worker-a",
          payload: { githubRepo: "acme/example", githubIssueNumber: 240 },
          message: `task ${name}`,
        }),
      });
      const task = await createRes.json();
      await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify({ workerId: "worker-a" }),
      });
      await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify({ workerId: "worker-a", result: { summary: `done ${name}` } }),
      });
    }

    const firstPollRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox`, { headers: hubHeaders });
    const firstPoll = await firstPollRes.json();
    assert.equal(firstPoll.count, 3);
    const [first, second, third] = firstPoll.events;
    assert.ok(first && second && third);

    const ackRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({ id: first.id, receipt: { evidence: "operator_visible", acknowledgedAt: "2026-05-02T00:00:00.000Z" } }),
    });
    assert.equal(ackRes.status, 200);

    const reconcileRes = await fetch(
      `${server.baseUrl}/a2a/tasks/terminal-outbox?after_id=${encodeURIComponent(second.id)}&reconcile_unacked=true`,
      { headers: hubHeaders },
    );
    const reconcile = await reconcileRes.json();
    assert.equal(reconcile.count, 2);
    assert.equal(reconcile.reconciledUnacked, 1);
    assert.deepEqual(reconcile.events.map((event: any) => event.id), [second.id, third.id]);
    assert.equal(reconcile.cursor, third.id);

    const retryOnlyRes = await fetch(
      `${server.baseUrl}/a2a/tasks/terminal-outbox?after_id=${encodeURIComponent(third.id)}&limit=1&reconcile_unacked=true`,
      { headers: hubHeaders },
    );
    const retryOnly = await retryOnlyRes.json();
    assert.deepEqual(retryOnly.events.map((event: any) => event.id), [second.id]);
    assert.equal(retryOnly.cursor, third.id);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/workers/:id/assignment-events streams queued assignment hints with replay", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    await registerTestWorker(server.baseUrl, "worker-b", "analyst", "test-edge-secret");

    const workerHeaders = {
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    };
    const sseRes = await fetch(`${server.baseUrl}/a2a/workers/worker-a/assignment-events`, {
      headers: workerHeaders,
    });
    assert.equal(sseRes.status, 200);

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        payload: { githubRepo: "acme/example", githubIssueNumber: 377, rawPrompt: "do-not-leak" },
        message: "secret task prompt must not be streamed",
      }),
    });
    assert.equal(taskRes.status, 201);
    const task = await taskRes.json() as { id: string };

    const events = await readSseEventsUntil(
      sseRes,
      (seen) => seen.some((event) => event.event === "worker-assignment"),
    );
    const assignment = events.find((event) => event.event === "worker-assignment");
    assert.ok(assignment);
    assert.ok(assignment.id);
    const data = JSON.parse(assignment.data);
    assert.equal(data.taskId, task.id);
    assert.equal(data.status, "queued");
    assert.equal(data.assignedWorkerId, "worker-a");
    assert.equal(data.metadata.repoFullName, "acme/example");
    assert.equal(data.metadata.issueNumber, 377);
    assert.equal(assignment.data.includes("secret task prompt"), false);
    assert.equal(assignment.data.includes("do-not-leak"), false);

    const replayRes = await fetch(`${server.baseUrl}/a2a/workers/worker-a/assignment-events`, {
      headers: {
        ...workerHeaders,
        "Last-Event-ID": "0",
      },
    });
    assert.equal(replayRes.status, 200);
    const replayEvents = await readSseEventsUntil(
      replayRes,
      (seen) => seen.some((event) => event.event === "worker-assignment"),
    );
    assert.equal(
      replayEvents.some((event) => event.event === "worker-assignment" && JSON.parse(event.data).taskId === task.id),
      true,
    );

    const strangerRes = await fetch(`${server.baseUrl}/a2a/workers/worker-a/assignment-events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-b",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(strangerRes.status, 401);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/terminal-events streams compact terminal events with replay ids", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        payload: { githubRepo: "acme/example", githubIssueNumber: 217, secret: "nope" },
        message: "do not leak this prompt",
      }),
    });
    const task = await taskRes.json();

    const sseRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);

    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          output: {
            prUrl: "https://github.com/acme/example/pull/9",
            doneUrl: "https://github.com/acme/example/issues/217#issuecomment-2",
            testSummary: { status: "passed", total: 1, passed: 1 },
          },
        },
      }),
    });

    const events = await readSseEventsUntil(sseRes, (seen) => seen.some((e) => e.event === "task-terminal"));
    const terminal = events.find((e) => e.event === "task-terminal");
    assert.ok(terminal);
    assert.equal(terminal.id, "1");
    const payload = JSON.parse(terminal.data);
    assert.equal(payload.taskId, task.id);
    assert.equal(payload.status, "succeeded");
    assert.equal(payload.worker, "worker-a");
    assert.equal(payload.repo, "acme/example");
    assert.equal(payload.issue, 217);
    assert.equal(payload.prUrl, "https://github.com/acme/example/pull/9");
    assert.equal(payload.doneUrl, "https://github.com/acme/example/issues/217#issuecomment-2");
    assert.deepEqual(payload.testSummary, { status: "passed", total: 1, passed: 1 });
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("do not leak"));
    assert.ok(!serialized.includes("secret"));

    const replayRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
        "last-event-id": "0",
        accept: "text/event-stream",
      },
    });
    const replayed = await readSseEventsUntil(replayRes, (seen) => seen.some((e) => e.event === "task-terminal"));
    assert.equal(replayed.find((e) => e.event === "task-terminal")?.id, "1");
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/terminal-events preserves parent-owned cross-broker routing metadata", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", brokerId: "gwakga", teamId: "team2" });
  try {
    await registerTestWorker(server.baseUrl, "jingun", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "seoseo",
      "x-a2a-requester-role": "hub",
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "seoseo", kind: "node", role: "hub" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        brokerOfRecord: "gwakga",
        teamId: "team2",
        payload: {
          parentRoundId: "seoseo-led-round",
          parentRoundTotal: 2,
          parentRoundOrder: 2,
          originBrokerId: "seoseo",
          brokerOfRecordId: "seoseo",
          operatorFacingOwner: "parent",
          crossBrokerHandoff: {
            parentRoundId: "seoseo-led-round",
            originBrokerId: "seoseo",
            handoffBrokerId: "gwakga",
            originTaskId: "parent-task-1",
            childWorkerId: "jingun",
          },
        },
        message: "do not leak this prompt",
      }),
    });
    assert.equal(taskRes.status, 201);
    const task = await taskRes.json();

    const sseRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "seoseo",
        "x-a2a-requester-role": "hub",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);

    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "jingun",
      "x-a2a-requester-role": "analyst",
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "jingun" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "jingun", result: { summary: "Team2 child completed" } }),
    });

    const events = await readSseEventsUntil(sseRes, (seen) => seen.some((e) => e.event === "task-terminal"));
    const terminal = events.find((e) => e.event === "task-terminal");
    assert.ok(terminal);
    const payload = JSON.parse(terminal.data);
    assert.equal(payload.taskId, task.id);
    assert.equal(payload.parentRoundId, "seoseo-led-round");
    assert.equal(payload.originBrokerId, "seoseo");
    assert.equal(payload.brokerOfRecordId, "seoseo");
    assert.equal(payload.parentRoundTotal, 2);
    assert.equal(payload.parentRoundOrder, 2);
    assert.equal(payload.parentRoundProgress, 2);
    assert.deepEqual(payload.crossBrokerHandoff, {
      parentRoundId: "seoseo-led-round",
      originBrokerId: "seoseo",
      handoffBrokerId: "gwakga",
      originTaskId: "parent-task-1",
      childWorkerId: "jingun",
    });
    assert.deepEqual(payload.notificationOwnership, {
      ownerBrokerId: "seoseo",
      scope: "parent-broker-only",
      providerSendPermittedByProjection: false,
      terminalAckPermittedByProjection: false,
      reason: "parent-owned cross-broker Terminal Brief; handoff broker event is aggregation evidence only; parent broker owns operator notification and ACK",
    });
  } finally {
    await server.close();
  }
});

test("terminal outbox diagnostics excludes ACK-ineligible cross-broker projection rows from actionable backlog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-outbox-projection-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"), { loadSource: "hot-tables" });
  const server = await startTestServer({
    stateStore: store,
    edgeSecret: "test-edge-secret",
    brokerId: "gwakga",
    teamId: "team2",
  });
  try {
    await registerTestWorker(server.baseUrl, "jingun", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "seoseo",
      "x-a2a-requester-role": "hub",
    });
    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "jingun",
      "x-a2a-requester-role": "analyst",
    });

    const createRes = await fetch(server.baseUrl + "/tasks", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "seoseo", kind: "node", role: "hub" },
        target: { id: "jingun", kind: "node", role: "analyst" },
        assignedWorkerId: "jingun",
        brokerOfRecord: "gwakga",
        teamId: "team2",
        payload: {
          parentRoundId: "seoseo-led-round",
          parentRoundTotal: 2,
          parentRoundOrder: 2,
          originBrokerId: "seoseo",
          brokerOfRecordId: "seoseo",
          operatorFacingOwner: "parent",
          crossBrokerHandoff: {
            parentRoundId: "seoseo-led-round",
            originBrokerId: "seoseo",
            handoffBrokerId: "gwakga",
            originTaskId: "parent-task-1",
            childWorkerId: "jingun",
          },
        },
        message: "projection-only child complete",
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const claimRes = await fetch(server.baseUrl + "/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "jingun" }),
    });
    assert.equal(claimRes.status, 200);

    const completeRes = await fetch(server.baseUrl + "/tasks/" + encodeURIComponent(task.id) + "/complete", {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "jingun", result: { summary: "Team2 child completed" } }),
    });
    assert.equal(completeRes.status, 200);

    const [event] = store.readHotTerminalOutbox();
    assert.ok(event);
    assert.equal(event.payload.notificationOwnership?.terminalAckPermittedByProjection, false);
    const diagnostics = store.readHotTerminalOutboxDiagnostics();
    assert.equal(diagnostics.total, 1);
    assert.equal(diagnostics.acked, 0);
    assert.equal(diagnostics.rawUnacked, 1);
    assert.equal(diagnostics.unacked, 0);
    assert.equal(diagnostics.ackEligibleUnacked, 0);
    assert.equal(diagnostics.ackIneligibleUnacked, 1);
    assert.equal(diagnostics.unackedRatio, 0);
    assert.equal(diagnostics.oldestUnackedCreatedAt, null);
    assert.equal(diagnostics.oldestUnackedAgeMs, null);
    assert.deepEqual(diagnostics.warnings, []);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/:id/events streams snapshot plus lifecycle updates and closes on terminal", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run analysis",
      }),
    });
    const task = await taskRes.json();

    const sseRes = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(sseRes.headers.get("cache-control"), "no-cache, no-store, no-transform");

    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a", result: { summary: "done" } }),
    });

    const events = await readAllSseEvents(sseRes);
    const types = events.map((e) => e.event);
    assert.deepEqual(types, [
      "task-snapshot",
      "task-status-update",
      "task-status-update",
      "task-status-update",
    ]);

    const snapshot = JSON.parse(events[0].data);
    assert.equal(snapshot.task.id, task.id);
    assert.equal(snapshot.task.status.state, "submitted");
    assert.equal(snapshot.reason, "snapshot");
    assert.equal(snapshot.final, false);

    const reasons = events.slice(1).map((e) => JSON.parse(e.data).reason);
    assert.deepEqual(reasons, ["claimed", "started", "succeeded"]);

    const terminal = JSON.parse(events[events.length - 1].data);
    assert.equal(terminal.final, true);
    assert.equal(terminal.task.status.state, "completed");
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/:id/events closes immediately for already-terminal tasks", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run analysis",
      }),
    });
    const task = await taskRes.json();

    await fetch(`${server.baseUrl}/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({ actor: { id: "hub-a", role: "hub", kind: "node" }, reason: "stop" }),
    });

    const sseRes = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(sseRes.status, 200);
    const events = await readAllSseEvents(sseRes);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "task-snapshot");
    const snapshot = JSON.parse(events[0].data);
    assert.equal(snapshot.task.status.state, "canceled");
    assert.equal(snapshot.final, true);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/:id/events rejects unauthorized subscribers", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run analysis",
      }),
    });
    const task = await taskRes.json();

    const strangerRes = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "stranger",
        "x-a2a-requester-role": "researcher",
      },
    });
    assert.equal(strangerRes.status, 401);
    await strangerRes.body?.cancel();

    const missingRes = await fetch(`${server.baseUrl}/a2a/tasks/does-not-exist/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(missingRes.status, 404);
    await missingRes.body?.cancel();
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events streams snapshot with current worker heartbeat alerts", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    workerOfflineAfterSec: 1,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const sseController = new AbortController();
    const sseRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      signal: sseController.signal,
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = await readSseEventsUntil(
      sseRes,
      (seen) => seen.some((event) => event.event === "operator-snapshot"),
    );
    sseController.abort();

    const snapshotEvent = events.find((event) => event.event === "operator-snapshot");
    assert.ok(snapshotEvent, "expected operator-snapshot event");
    const snapshot = JSON.parse(snapshotEvent!.data);
    assert.equal(snapshot.summary.workers.total, 1);
    assert.equal(
      snapshot.alerts.alerts.some(
        (alert: { kind: string; workerId?: string }) =>
          alert.kind === "worker.heartbeat_missed" && alert.workerId === "worker-a",
      ),
      true,
    );
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events skips idle alert replay work and returns a fresh snapshot on subscribe", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    workerOfflineAfterSec: 1,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "operator replay check",
      }),
    });
    assert.equal(createRes.status, 201);

    const heartbeatRes = await fetch(`${server.baseUrl}/workers/worker-a/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatRes.status, 200);

    const replayController = new AbortController();
    const replayRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      signal: replayController.signal,
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
        "Last-Event-ID": "operator:0",
      },
    });
    assert.equal(replayRes.status, 200);

    const replayEvents = await readSseEventsUntil(
      replayRes,
      (events) => events.some((event) => event.event === "operator-snapshot"),
    );
    replayController.abort();

    assert.deepEqual(replayEvents.map((event) => event.event), ["operator-snapshot"]);
    const replaySnapshot = JSON.parse(replayEvents.find((event) => event.event === "operator-snapshot")!.data);
    assert.equal(
      replaySnapshot.alerts.alerts.some((alert: { kind: string }) => alert.kind === "worker.heartbeat_missed"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events does not buffer idle summary projections without subscribers", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const replayController = new AbortController();
    const replayRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      signal: replayController.signal,
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
        "Last-Event-ID": "operator:0",
      },
    });
    assert.equal(replayRes.status, 200);

    const events = await readSseEventsUntil(
      replayRes,
      (seen) => seen.some((event) => event.event === "operator-snapshot"),
    );
    replayController.abort();

    assert.deepEqual(events.map((event) => event.event), ["operator-snapshot"]);
    const snapshot = JSON.parse(events[0]!.data);
    assert.equal(snapshot.summary.workers.total, 1);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events falls back to a fresh snapshot when Last-Event-ID is outside the replay buffer", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });
  try {
    server.runtime.broker.registerWorker({
      nodeId: "worker-a",
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

    for (let i = 0; i < 205; i += 1) {
      server.runtime.broker.createTask({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: `buffered task ${i}`,
      });
    }

    const sseRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
        "Last-Event-ID": "operator:0",
      },
    });
    assert.equal(sseRes.status, 200);

    const events = await readSseEventsUntil(
      sseRes,
      (seen) => seen.some((event) => event.event === "operator-snapshot"),
    );

    assert.deepEqual(events.map((event) => event.event), ["operator-snapshot"]);
    const snapshot = JSON.parse(events[0]!.data);
    assert.equal(snapshot.summary.queue.total, 205);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events rejects non-operator subscribers", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "researcher-1",
        "x-a2a-requester-role": "researcher",
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error.message, /operator\.subscribe requester role must be one of/);
  } finally {
    await server.close();
  }
});

test("JSON-RPC SubscribeToTask returns current task plus SSE subscription URL", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    publicBaseUrl: "https://broker.example.com/",
  });
  try {
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run analysis",
      }),
    });
    const task = await taskRes.json();

    const rpcRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SubscribeToTask",
        params: { taskId: task.id },
      }),
    });
    assert.equal(rpcRes.status, 200);
    const body = await rpcRes.json();
    assert.equal(body.result.task.id, task.id);
    assert.equal(body.result.subscription.transport, "sse");
    assert.equal(
      body.result.subscription.url,
      `https://broker.example.com/a2a/tasks/${task.id}/events`,
    );
    assert.ok(Array.isArray(body.result.subscription.eventTypes));
    assert.ok(body.result.subscription.eventTypes.includes("task-status-update"));
  } finally {
    await server.close();
  }
});

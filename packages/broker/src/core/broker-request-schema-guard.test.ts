// Regression tests for the request-stage schema guard (B1a).
//
// Invariant under test: a payload the persisted-state schema would reject must
// be rejected at request time, so it can never reach the snapshot and break the
// next broker start (#1504, #1725).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import { BrokerError } from "./broker-error.js";
import { proposalSchema, taskSchema, workerSchema } from "./store-schemas.js";
import { serializeBrokerSnapshot, parseSnapshotPayload } from "./store-snapshot-io.js";
import {
  createProposalRequestSchema,
  createTaskRequestSchema,
  registerWorkerRequestSchema,
} from "./store-schemas.js";
import type { CreateProposalRequest, CreateTaskRequest, RegisterWorkerRequest } from "./types.js";

function baseProposal(overrides: Record<string, unknown> = {}): CreateProposalRequest {
  return {
    source: { id: "node-a", kind: "node", role: "operator" },
    target: { id: "node-b", kind: "node", role: "operator" },
    kind: "patch",
    summary: "tighten request validation",
    workspace: { nodeId: "node-b", workspaceId: "default" },
    patchText: "diff --git a b",
    ...overrides,
  } as CreateProposalRequest;
}

function expectBadRequest(fn: () => unknown, needle: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof BrokerError, `expected BrokerError, got ${String(error)}`);
    assert.equal(error.code, "bad_request");
    assert.match(error.message, new RegExp(needle));
    return true;
  });
}

describe("request payload schemas derived from the store schemas", () => {
  it("rejects a proposal whose kind the snapshot schema would refuse (empty string)", () => {
    const broker = new InMemoryA2ABroker();
    const request = baseProposal({ kind: "" });
    // The store schema is the authority we are deriving from.
    assert.equal(proposalSchema.shape.kind.safeParse("").success, false);
    expectBadRequest(() => broker.createProposal(request), "kind");
    assert.equal(broker.listProposals().length, 0);
  });

  it("rejects a proposal whose kind is not a string", () => {
    const broker = new InMemoryA2ABroker();
    expectBadRequest(
      () => broker.createProposal(baseProposal({ kind: 7 as unknown as string })),
      "kind",
    );
  });

  it("rejects a proposal whose summary is not a string", () => {
    const broker = new InMemoryA2ABroker();
    expectBadRequest(
      () => broker.createProposal(baseProposal({ summary: { text: "x" } as unknown as string })),
      "summary",
    );
  });

  it("rejects an artifact attachment with a non-numeric sizeBytes", () => {
    const broker = new InMemoryA2ABroker();
    const proposal = broker.createProposal(baseProposal());
    expectBadRequest(
      () =>
        broker.attachArtifact(proposal.id, {
          kind: "log",
          uri: "https://example.invalid/log",
          sizeBytes: "big" as unknown as number,
        }),
      "sizeBytes",
    );
  });

  it("rejects a validation whose metrics carry non-scalar values", () => {
    const broker = new InMemoryA2ABroker();
    const proposal = broker.createProposal(baseProposal());
    expectBadRequest(
      () =>
        broker.submitValidationResult(proposal.id, {
          nodeId: "node-b",
          kind: "smoke",
          verdict: "pass",
          metrics: { nested: { count: 1 } } as unknown as Record<string, string>,
        }),
      "metrics",
    );
  });

  it("keeps the historical messages for the legacy required-field checks", () => {
    const broker = new InMemoryA2ABroker();
    expectBadRequest(
      () => broker.createProposal(baseProposal({ summary: "" })),
      "summary is required",
    );
    expectBadRequest(
      () => broker.createProposal(baseProposal({ patchText: undefined })),
      "patch proposals require patchText",
    );
  });

  it("accepts a valid proposal and the resulting snapshot still loads", () => {
    const broker = new InMemoryA2ABroker();
    const proposal = broker.createProposal(baseProposal({ rationale: "keeps loads green" }));
    assert.equal(proposal.kind, "patch");

    const payload = serializeBrokerSnapshot(broker.exportSnapshot());
    const reloaded = parseSnapshotPayload(payload, "memory://request-schema-test", 10_000_000);
    assert.equal(reloaded.proposals.length, 1);
    assert.equal(reloaded.proposals[0]?.id, proposal.id);
  });

  it("derives the request schema from the store schema (no request-only field drift)", () => {
    const storeFields = new Set(Object.keys(proposalSchema.shape));
    for (const field of Object.keys(createProposalRequestSchema.shape)) {
      assert.ok(
        storeFields.has(field),
        `request field ${field} is not present in the persisted proposal schema`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// #2051 items 1 and 3: the same derivation applied to the remaining high-risk
// write paths — worker registration and task creation. Both are validated in
// the core writer (`registerWorker` / `assertTaskPayload`), not in the HTTP
// route, so the JSON-RPC and internal callers are covered by the same check
// the way #2044 covered proposals in `broker-proposal-write`.
// ---------------------------------------------------------------------------

function baseCapabilities(): RegisterWorkerRequest["capabilities"] {
  return {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: [],
    environments: [],
  };
}

function baseWorker(overrides: Record<string, unknown> = {}): RegisterWorkerRequest {
  return {
    nodeId: "worker-a",
    role: "analyst",
    capabilities: baseCapabilities(),
    ...overrides,
  } as RegisterWorkerRequest;
}

function baseTask(overrides: Record<string, unknown> = {}): CreateTaskRequest {
  return {
    intent: "chat",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    payload: {},
    ...overrides,
  } as CreateTaskRequest;
}

function brokerWithWorker(): InMemoryA2ABroker {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker(baseWorker());
  return broker;
}

describe("worker registration request schema derived from workerSchema (#2051 item 3)", () => {
  it("rejects a non-string nodeId that the presence check let through", () => {
    const broker = new InMemoryA2ABroker();
    // The store is the authority we derive from: it refuses this record.
    assert.equal(
      workerSchema.safeParse({
        ...baseWorker({ nodeId: 12345 }),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      }).success,
      false,
    );
    // `!12345` is false, so the historical presence check accepted it.
    expectBadRequest(
      () => broker.registerWorker(baseWorker({ nodeId: 12345 })),
      "nodeId",
    );
    assert.equal(broker.listWorkers().length, 0);
  });

  it("rejects a non-string role", () => {
    const broker = new InMemoryA2ABroker();
    expectBadRequest(() => broker.registerWorker(baseWorker({ role: 7 })), "role");
  });

  it("rejects metadata with non-string values (the store requires Record<string,string>)", () => {
    const broker = new InMemoryA2ABroker();
    assert.equal(
      workerSchema.shape.metadata.safeParse({ retries: 3 }).success,
      false,
    );
    expectBadRequest(
      () => broker.registerWorker(baseWorker({ metadata: { retries: 3 } })),
      "metadata",
    );
    assert.equal(broker.listWorkers().length, 0);
  });

  it("keeps the historical presence-check messages", () => {
    const broker = new InMemoryA2ABroker();
    expectBadRequest(() => broker.registerWorker(baseWorker({ nodeId: "" })), "nodeId is required");
    expectBadRequest(() => broker.registerWorker(baseWorker({ role: "" })), "role is required");
    expectBadRequest(
      () => broker.registerWorker(baseWorker({ capabilities: undefined })),
      "capabilities are required",
    );
  });

  it("still accepts the shapes real workers send, including legacy array capabilities", () => {
    const broker = new InMemoryA2ABroker();
    broker.registerWorker(
      baseWorker({
        displayName: "Worker A",
        brokerUrl: "https://broker.test/",
        workerMode: "persistent",
        managementPlane: "reachable",
        metadata: { platform: "linux", workerProfile: "broker-poll-only" },
      }),
    );
    // The capability normalizer accepts a legacy string array; the request
    // schema must not second-guess it (capabilities are deliberately omitted).
    broker.registerWorker(
      baseWorker({ nodeId: "worker-b", capabilities: ["canAnalyze"] }),
    );
    assert.equal(broker.listWorkers().length, 2);

    const payload = serializeBrokerSnapshot(broker.exportSnapshot());
    const reloaded = parseSnapshotPayload(payload, "memory://worker-schema-test", 10_000_000);
    assert.equal(reloaded.workers.length, 2);
  });

  it("derives every request field from the persisted worker schema", () => {
    const storeFields = new Set(Object.keys(workerSchema.shape));
    for (const field of Object.keys(registerWorkerRequestSchema.shape)) {
      assert.ok(
        storeFields.has(field),
        `request field ${field} is not present in the persisted worker schema`,
      );
    }
  });
});

describe("task creation request schema derived from taskSchema (#2051 item 1)", () => {
  it("rejects a non-string intent that the truthiness check let through", () => {
    const broker = brokerWithWorker();
    assert.equal(taskSchema.shape.intent.safeParse(7).success, false);
    expectBadRequest(() => broker.createTask(baseTask({ intent: 7 })), "intent");
    assert.equal(broker.listTasks().length, 0);
  });

  it("rejects a non-string message", () => {
    const broker = brokerWithWorker();
    expectBadRequest(
      () => broker.createTask(baseTask({ message: { text: "hi" } })),
      "message",
    );
    assert.equal(broker.listTasks().length, 0);
  });

  it("rejects non-string artifactIds (uniqueIds de-duplicates but never coerces)", () => {
    const broker = brokerWithWorker();
    expectBadRequest(
      () => broker.createTask(baseTask({ artifactIds: [1, 2] })),
      "artifactIds",
    );
  });

  it("rejects a non-string role on a party ref", () => {
    const broker = brokerWithWorker();
    expectBadRequest(
      () => broker.createTask(baseTask({ requester: { id: "hub", role: 3 } })),
      "requester",
    );
  });

  it("rejects a non-string workspace.branch the presence check ignored", () => {
    const broker = brokerWithWorker();
    expectBadRequest(
      () =>
        broker.createTask(
          baseTask({ workspace: { nodeId: "worker-a", workspaceId: "default", branch: 42 } }),
        ),
      "workspace",
    );
  });

  it("keeps the historical messages for the legacy required-field checks", () => {
    const broker = brokerWithWorker();
    expectBadRequest(() => broker.createTask(baseTask({ intent: "" })), "intent is required");
    expectBadRequest(
      () => broker.createTask(baseTask({ requester: { id: "" } })),
      "requester.id and target.id are required",
    );
  });

  it("still accepts an ordinary task and the resulting snapshot loads", () => {
    const broker = brokerWithWorker();
    const task = broker.createTask(
      baseTask({
        id: "task-1",
        message: "please analyze",
        artifactIds: ["artifact-1", "artifact-1"],
        via: { transport: "http" },
        workspace: { nodeId: "worker-a", workspaceId: "default", branch: "main" },
        taskOrigin: "api",
        payload: { mode: "read_only_analysis", nested: { anything: [1, 2, 3] } },
      }),
    );
    assert.equal(task.id, "task-1");
    assert.deepEqual(task.artifactIds, ["artifact-1"]);

    const payload = serializeBrokerSnapshot(broker.exportSnapshot());
    const reloaded = parseSnapshotPayload(payload, "memory://task-schema-test", 10_000_000);
    assert.equal(reloaded.tasks.length, 1);
    assert.equal(reloaded.tasks[0]?.id, "task-1");
  });

  it("derives every request field from the persisted task schema", () => {
    const storeFields = new Set(Object.keys(taskSchema.shape));
    for (const field of Object.keys(createTaskRequestSchema.shape)) {
      assert.ok(
        storeFields.has(field),
        `request field ${field} is not present in the persisted task schema`,
      );
    }
  });
});

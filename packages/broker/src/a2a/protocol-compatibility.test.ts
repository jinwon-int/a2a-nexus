import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBrokerAgentCard } from "./agent-card.js";
import { projectBrokerTask, projectBrokerTaskForList } from "./task-projection.js";
import type { TaskRecord, TaskStatus } from "../core/types.js";
import {
  A2A_AGENT_CARD_GOLDEN,
  A2A_AGENT_CARD_TRUST_GOLDEN,
  A2A_COMPATIBILITY_PROFILE,
  A2A_TASK_PROJECTION_GOLDEN,
} from "../fixtures/a2a-protocol-compatibility.js";
import type { AgentCapabilities } from "./agent-card.js";
import type { WorkerCapabilities } from "../core/types.js";

const BASE_TIME = "2026-05-04T00:00:00.000Z";
const UPDATED_TIME = "2026-05-04T00:00:05.000Z";
const COMPLETED_TIME = "2026-05-04T00:00:10.000Z";

function makeTask(status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-compat-golden",
    exchangeId: "exchange-compat-golden",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "analyze compatibility",
    assignedWorkerId: "worker-a",
    status,
    targetNodeId: "worker-a",
    payload: {},
    createdAt: BASE_TIME,
    updatedAt: UPDATED_TIME,
    ...overrides,
  };
}

test("A2A compatibility document declares the gated public profile", () => {
  const doc = readFileSync("docs/protocol-compatibility.md", "utf8");

  assert.match(doc, /Current profile: A2A 1\.0-compatible broker alpha profile/);
  assert.match(doc, /protocolVersion: `?"1\.0"`?/);
  assert.match(doc, /push notification capability: `?false`?/i);

  for (const method of A2A_COMPATIBILITY_PROFILE.jsonRpcMethods) {
    assert.match(doc, new RegExp(`\\b${method}\\b`), `${method} must remain documented`);
  }

  for (const state of A2A_COMPATIBILITY_PROFILE.taskStates) {
    assert.match(doc, new RegExp(`\\b${state}\\b`), `${state} must remain documented`);
  }

  assert.match(doc, /A2A 0\.3 compatibility mode/i);
  assert.match(doc, /Full official A2A 1\.0 conformance/i);
});

test("agent card stays aligned with the documented A2A profile", () => {
  const card = createBrokerAgentCard({
    serviceName: "compat-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  assert.deepEqual(
    {
      protocolVersion: card.protocolVersion,
      capabilities: card.capabilities,
      defaultInputModes: card.defaultInputModes,
      defaultOutputModes: card.defaultOutputModes,
      supportedInterfaces: card.supportedInterfaces,
    },
    A2A_AGENT_CARD_GOLDEN,
  );
  assert.equal(card.url, "https://broker.example.com/a2a/jsonrpc");
  // A2A 1.0 transport binding (CARD-PROTO-001 / BIND-FIELD-001): exactly the
  // single JSON-RPC interface the broker serves, at the same URL as card.url.
  assert.deepEqual(card.supportedInterfaces, [
    { protocolBinding: "JSONRPC", url: "https://broker.example.com/a2a/jsonrpc" },
  ]);
});

test("task projection shape is pinned for A2A compatibility", () => {
  const projection = projectBrokerTask(
    makeTask("succeeded", {
      claimedBy: "worker-a",
      completedAt: COMPLETED_TIME,
      result: {
        summary: "completed golden result",
        artifactIds: ["artifact-1"],
      },
    }),
  );

  assert.deepEqual(Object.keys(projection).sort(), [...A2A_COMPATIBILITY_PROFILE.projectionKeys]);
  assert.deepEqual(Object.keys(projection.metadata).sort(), [...A2A_COMPATIBILITY_PROFILE.metadataKeys]);
  assert.deepEqual(projection, A2A_TASK_PROJECTION_GOLDEN);
});

test("task projection exposes A2A context and reference task lineage without expanding prior task internals", () => {
  const projection = projectBrokerTask(makeTask("queued", {
    id: "follow-up-task",
    exchangeId: "context-123",
    referenceTaskIds: ["prior-terminal-task"],
  }));

  assert.equal(projection.metadata.contextId, "context-123");
  assert.deepEqual(projection.metadata.referenceTaskIds, ["prior-terminal-task"]);
  assert.equal(JSON.stringify(projection).includes("prior task result"), false);
});

test("internal broker task statuses keep their documented A2A state mapping", () => {
  for (const [internalStatus, a2aState] of Object.entries(A2A_COMPATIBILITY_PROFILE.internalStatusToA2AState)) {
    const projection = projectBrokerTask(makeTask(internalStatus as TaskStatus));
    assert.equal(projection.status.state, a2aState, `${internalStatus} should project as ${a2aState}`);
  }
});

test("list projection keeps result details summarized and artifacts stable", () => {
  const projection = projectBrokerTaskForList(
    makeTask("succeeded", {
      completedAt: COMPLETED_TIME,
      result: {
        summary: "completed golden result",
        note: "longer private note",
        artifactIds: ["artifact-1"],
        output: { verbose: true },
      },
    }),
  );

  assert.deepEqual(Object.keys(projection.metadata).sort(), [...A2A_COMPATIBILITY_PROFILE.listMetadataKeys]);
  assert.equal(projection.metadata.resultSummary, "completed golden result");
  assert.equal("result" in projection.metadata, false);
  assert.deepEqual(projection.artifacts, [{ id: "artifact-1" }]);
});

// ---------------------------------------------------------------------------
// AgentCard capabilities vs WorkerCapabilities shape guard (#433)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AgentCard trust model — signed metadata evaluation (#952)
// ---------------------------------------------------------------------------

test("AgentCard trust model: broker card is intentionally unsigned (signing deferred)", () => {
  const card = createBrokerAgentCard({
    serviceName: "trust-model-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  // The current implementation does not sign agent cards and no longer exposes
  // placeholder signature fields in the public AgentCard TypeScript shape.
  const cardRecord = card as unknown as Record<string, unknown>;
  assert.equal("signature" in cardRecord, false, "AgentCard must not expose a placeholder signature key");
  assert.equal("signedExtensions" in cardRecord, false, "AgentCard must not expose placeholder signedExtensions");

  // The trust model fixture records the intentional unsigned state.
  assert.equal(A2A_AGENT_CARD_TRUST_GOLDEN.signatureRequired, false);
  assert.equal(A2A_AGENT_CARD_TRUST_GOLDEN.signedExtensionsRequired, false);
  assert.equal(A2A_AGENT_CARD_TRUST_GOLDEN.trustModel, "transport-auth-only");

  // Verify the trust model is documented.
  const trustDoc = readFileSync("docs/agent-card-trust-model.md", "utf8");
  assert.match(trustDoc, /Explicitly deferred/);
  assert.match(trustDoc, /Edge-secret/);
  assert.match(trustDoc, /requester-id/);
  assert.match(trustDoc, /unsigned.*Current default/);
});

test("AgentCard trust model: no secret values in signature fields or serialized card output", () => {
  const card = createBrokerAgentCard({
    serviceName: "no-leak-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  // Even if a signature were populated, the serialized card must not
  // contain secret-like values.
  const secretPatterns = [
    /ghp_[A-Za-z0-9_]+/,
    /-----BEGIN .*PRIVATE KEY-----/,
    /sk-[A-Za-z0-9]{16,}/,
    /edge[_-]?secret/i,
    /xox[baprs]-/,
  ];

  const serialized = JSON.stringify(card);
  for (const pattern of secretPatterns) {
    assert.ok(
      !pattern.test(serialized),
      `Serialized agent card must not contain secret-like patterns: ${pattern}`,
    );
  }

  // The card must not expose broker-internal URLs, workspace IDs, or raw metadata.
  assert.equal(serialized.includes("10.0.0."), false, "must not expose internal IPs");
  assert.equal(serialized.includes("192.168."), false, "must not expose private IPs");
  assert.equal(serialized.includes("workspaceId"), false, "must not expose workspace IDs");
});

test("AgentCard trust model: optional signature fields are backward-compatible", () => {
  // Consumers that don't know about signature fields should parse the card
  // without errors. The signature and signedExtensions fields are optional.
  const card = createBrokerAgentCard({
    serviceName: "compat-broker",
    publicBaseUrl: "https://broker.example.com/",
  });

  const parsed = JSON.parse(JSON.stringify(card));
  assert.equal(typeof parsed.name, "string");
  assert.equal(typeof parsed.url, "string");
  assert.equal(typeof parsed.protocolVersion, "string");
  assert.equal("signature" in parsed, false, "unsigned card must not include signature key");
  assert.equal("signedExtensions" in parsed, false, "unsigned card must not include signedExtensions key");
});

test("AgentCard trust model: design doc covers all four decision questions", () => {
  const doc = readFileSync("docs/agent-card-trust-model.md", "utf8");

  // Decision 1: broker AgentCard signing is deferred.
  assert.match(doc, /Decision 1/);
  assert.match(doc, /Explicitly deferred/);

  // Decision 2: worker capability cards can carry a signature envelope, also deferred.
  assert.match(doc, /Decision 2/);
  assert.match(doc, /Architecturally yes.*deferred/);

  // Decision 3: secure-passport maps orthogonally to edge-secret.
  assert.match(doc, /Decision 3/);
  assert.match(doc, /Orthogonal.*complementary/);
  assert.match(doc, /CallerContext/);

  // Decision 4: operator visibility of trust states.
  assert.match(doc, /Decision 4/);
  assert.match(doc, /unsigned.*signed \+ trusted.*signed \+ untrusted.*expired.*key-rotated/s);

  // External references are cited.
  assert.match(doc, /a2aproject\/a2a-python/);
  assert.match(doc, /a2aproject\/a2a-samples/);
  assert.match(doc, /signing\.py/);
  assert.match(doc, /secure-passport/);

  // Secret exposure guard section exists.
  assert.match(doc, /Secret exposure guard/);
  assert.match(doc, /SECRET_KEY_RE/);
  assert.match(doc, /SECRET_VALUE_RE/);
});

test("AgentCard.capabilities and WorkerCapabilities are disjoint public-seam shapes", () => {
  // AgentCard.capabilities carries A2A protocol-level flags.
  const agentCardCapabilityKeys: ReadonlyArray<keyof AgentCapabilities> = ["streaming", "pushNotifications"] as const;

  // WorkerCapabilities carries broker-internal worker runtime abilities.
  const workerCapabilityKeys: ReadonlyArray<keyof WorkerCapabilities> = [
    "canAnalyze", "canBackfill", "canPatchWorkspace", "canPromoteLive",
    "workspaceIds", "environments",
  ] as const;

  // They MUST NOT share any key names. Accidental overlap would mean a
  // public A2A client could interpret worker runtime data or vice versa.
  const agentCardKeys = new Set<string>(agentCardCapabilityKeys);
  for (const key of workerCapabilityKeys) {
    assert.ok(
      !agentCardKeys.has(key),
      `WorkerCapabilities key "${key}" must not appear in AgentCard.capabilities`,
    );
  }

  // AgentCard.capabilities values are booleans; WorkerCapabilities has arrays too.
  // This structural difference guards against accidental shape convergence.
  assert.ok(
    workerCapabilityKeys.some((k) => k === "workspaceIds" || k === "environments"),
    "WorkerCapabilities must contain array-typed fields distinct from AgentCard.capabilities",
  );
});

test("approval-gated and approval-rejected tasks project the A2A 1.0 spec states", () => {
  // blocked = waiting for an out-of-band operator authorization decision.
  const gated = projectBrokerTask(makeTask("blocked"));
  assert.equal(gated.status.state, "auth-required");

  // A task terminated by an approval rejection is the spec's `rejected`
  // terminal state, not a generic `canceled`.
  const rejected = projectBrokerTask(
    makeTask("canceled", {
      approvalOutcome: {
        status: "rejected",
        approvalId: "approval-golden",
        decidedAt: COMPLETED_TIME,
        decidedBy: "operator-a",
        reason: "policy review failed",
      },
    }),
  );
  assert.equal(rejected.status.state, "rejected");

  // Other approval outcomes (expired/canceled) stay generic canceled.
  const expired = projectBrokerTask(
    makeTask("canceled", {
      approvalOutcome: {
        status: "expired",
        approvalId: "approval-golden-2",
        decidedAt: COMPLETED_TIME,
        decidedBy: "operator-a",
      },
    }),
  );
  assert.equal(expired.status.state, "canceled");
});

test("task projection exposes only via.traceId, never session/channel/node routing detail (a2a-nexus#621 review)", () => {
  const task = makeTask("running", {
    via: { traceId: "trace-abc", transport: "jsonrpc", channel: "telegram", nodeId: "node-secret", sessionId: "sess-secret" },
  });
  for (const projection of [projectBrokerTask(task), projectBrokerTaskForList(task)]) {
    assert.deepEqual(projection.metadata.via, { traceId: "trace-abc" });
    const serialized = JSON.stringify(projection.metadata.via);
    assert.ok(!serialized.includes("node-secret"));
    assert.ok(!serialized.includes("sess-secret"));
    assert.ok(!serialized.includes("telegram"));
  }
});

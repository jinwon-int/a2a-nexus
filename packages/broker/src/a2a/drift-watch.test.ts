/**
 * A2A compatibility drift-watch test suite.
 *
 * This test suite enforces a deterministic drift-watch gate against the
 * broker's advertised A2A profile. It validates that:
 *
 * 1. The pinned compatibility fixture matches the documented profile.
 * 2. Unsupported surfaces (REST, gRPC, push notifications) remain disabled.
 * 3. The advertised AgentCard capabilities have not drifted.
 * 4. The JSON-RPC method inventory matches the documented set.
 * 5. External SDK references are tracked with pinned refs.
 *
 * All tests are deterministic — they do not make live network calls.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBrokerAgentCard } from "./agent-card.js";
import {
  A2A_AGENT_CARD_GOLDEN,
  A2A_COMPATIBILITY_PROFILE,
  A2A_DRIFT_EXTERNAL_REFS,
} from "../fixtures/a2a-protocol-compatibility.js";

// ---------------------------------------------------------------------------
// Profile drift gates
// ---------------------------------------------------------------------------

test("drift: compatibility profile name is pinned to documented value", () => {
  assert.equal(
    A2A_COMPATIBILITY_PROFILE.profileName,
    "A2A 1.0-compatible broker alpha profile",
    "profileName must not drift without updating drift-watch docs",
  );
});

test("drift: protocol version is pinned to 1.0", () => {
  assert.equal(
    A2A_COMPATIBILITY_PROFILE.protocolVersion,
    "1.0",
    "protocolVersion must not drift without updating drift-watch docs",
  );
});

// ---------------------------------------------------------------------------
// Unsupported surfaces guard
// ---------------------------------------------------------------------------

test("drift: REST transport is explicitly unsupported", () => {
  assert.ok(
    A2A_COMPATIBILITY_PROFILE.unsupportedTransports.includes("REST"),
    "REST transport must remain in unsupportedTransports until intentionally added",
  );

  // The broker must not advertise REST endpoints in the AgentCard.
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  // AgentCard.url must be the JSON-RPC endpoint, not a REST endpoint.
  assert.ok(
    card.url.endsWith("/a2a/jsonrpc"),
    "AgentCard.url must point to JSON-RPC endpoint, not a REST surface",
  );
});

test("drift: gRPC transport is explicitly unsupported", () => {
  assert.ok(
    A2A_COMPATIBILITY_PROFILE.unsupportedTransports.includes("gRPC"),
    "gRPC transport must remain in unsupportedTransports until intentionally added",
  );
});

test("drift: push notifications are explicitly unsupported", () => {
  assert.equal(
    A2A_COMPATIBILITY_PROFILE.unsupportedPushNotifications,
    true,
    "unsupportedPushNotifications must remain true until push is implemented",
  );

  // AgentCard must continue to advertise push as disabled.
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  assert.equal(
    card.capabilities.pushNotifications,
    false,
    "AgentCard.capabilities.pushNotifications must be false until push is implemented",
  );
});

test("drift: A2A 0.3 compatibility mode is explicitly unsupported", () => {
  assert.equal(
    A2A_COMPATIBILITY_PROFILE.unsupportedA2A03Compat,
    true,
    "unsupportedA2A03Compat must remain true until 0.3 compat is implemented",
  );
});

// ---------------------------------------------------------------------------
// AgentCard capability drift enforcement
// ---------------------------------------------------------------------------

test("drift: AgentCard golden fixture stays aligned with createBrokerAgentCard", () => {
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
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
    },
    A2A_AGENT_CARD_GOLDEN,
    "AgentCard golden fixture must match createBrokerAgentCard output. " +
    "If this fails intentionally, update A2A_AGENT_CARD_GOLDEN and docs/a2a-drift-watch.md together.",
  );

  // Individual capability assertions for clearer failure messages.
  assert.equal(
    card.capabilities.streaming,
    true,
    "streaming capability must remain true (SSE via SubscribeToTask)",
  );
  assert.equal(
    card.capabilities.pushNotifications,
    false,
    "pushNotifications capability must remain false",
  );
});

// ---------------------------------------------------------------------------
// JSON-RPC method inventory
// ---------------------------------------------------------------------------

test("drift: JSON-RPC method inventory matches documented profile", () => {
  const implemented = [...A2A_COMPATIBILITY_PROFILE.jsonRpcMethods];
  const expected = [
    "SendMessage",
    "GetTask",
    "ListTasks",
    "CancelTask",
    "SubscribeToTask",
    "GetExtendedAgentCard",
  ];

  assert.deepEqual(
    implemented.sort(),
    expected.sort(),
    "jsonRpcMethods must not drift. " +
    "If adding a method, update A2A_COMPATIBILITY_PROFILE.jsonRpcMethods, " +
    "docs/protocol-compatibility.md, and docs/a2a-drift-watch.md together.",
  );
});

test("drift: broker extension methods are tracked separately from A2A 1.0 methods", () => {
  assert.ok(
    A2A_COMPATIBILITY_PROFILE.brokerExtensionMethods.includes("a2a.peer.status"),
    "a2a.peer.status must be tracked as a broker extension, not an A2A 1.0 method",
  );

  // Extension methods must not appear in the A2A 1.0 method list.
  for (const extMethod of A2A_COMPATIBILITY_PROFILE.brokerExtensionMethods) {
    assert.ok(
      !(A2A_COMPATIBILITY_PROFILE.jsonRpcMethods as readonly string[]).includes(extMethod),
      `Extension method "${extMethod}" must not appear in A2A 1.0 jsonRpcMethods`,
    );
  }
});

// ---------------------------------------------------------------------------
// Document alignment
// ---------------------------------------------------------------------------

test("drift: drift-watch document exists and references the fixture", () => {
  const doc = readFileSync("docs/a2a-drift-watch.md", "utf8");

  assert.match(doc, /drift-watch test lives at `src\/a2a\/drift-watch\.test\.ts`/i);
  assert.match(doc, /REST transport/i);
  assert.match(doc, /gRPC transport/i);
  assert.match(doc, /Push notifications/i);
  assert.match(doc, /A2A 0\.3 compatibility mode/i);
  assert.match(doc, /a2aproject\/a2a-js/i);
  assert.match(doc, /a2aproject\/a2a-python/i);
  assert.match(doc, /a2aproject\/a2a-samples/i);
  assert.match(doc, /npm run test:drift-watch/i);
});

test("drift: protocol-compatibility document references drift-watch", () => {
  const doc = readFileSync("docs/protocol-compatibility.md", "utf8");
  // The compatibility doc should reference the drift-watch doc.
  // If this fails, add a reference link to docs/a2a-drift-watch.md.
  assert.match(doc, /drift-watch|a2a-drift-watch/i,
    "docs/protocol-compatibility.md must reference the drift-watch document");
});

// ---------------------------------------------------------------------------
// External reference tracking
// ---------------------------------------------------------------------------

test("drift: external SDK references are tracked with pinned data", () => {
  assert.ok(A2A_DRIFT_EXTERNAL_REFS.length >= 3,
    "At least 3 external SDK references must be tracked (a2a-js, a2a-python, a2a-samples)");

  const repoNames = A2A_DRIFT_EXTERNAL_REFS.map((r) => r.repo);
  assert.ok(repoNames.includes("a2aproject/a2a-js"),
    "must track a2aproject/a2a-js");
  assert.ok(repoNames.includes("a2aproject/a2a-python"),
    "must track a2aproject/a2a-python");
  assert.ok(repoNames.includes("a2aproject/a2a-samples"),
    "must track a2aproject/a2a-samples");

  for (const ref of A2A_DRIFT_EXTERNAL_REFS) {
    assert.ok(ref.repo, "each external ref must have a repo");
    assert.ok(ref.keyModules.length > 0, `${ref.repo} must list keyModules`);
    assert.ok(ref.checkedSurfaces.length > 0, `${ref.repo} must list checkedSurfaces`);
    assert.ok(ref.pinned.kind, `${ref.repo} must have pinned kind`);
    assert.ok(ref.pinned.ref, `${ref.repo} must have pinned ref`);
    assert.ok(ref.pinned.refreshedAt, `${ref.repo} must have pinned refreshedAt`);
  }
});

// ---------------------------------------------------------------------------
// Unsupported surface: no accidental REST/gRPC/push capability
// ---------------------------------------------------------------------------

test("drift: broker does not advertise REST transport capability", () => {
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  // AgentCard JSON must not contain REST or gRPC transport hints.
  const cardJson = JSON.stringify(card);
  assert.ok(
    !cardJson.includes("rest") && !cardJson.includes("REST"),
    "AgentCard must not advertise REST transport",
  );
  assert.ok(
    !cardJson.includes("grpc") && !cardJson.includes("gRPC"),
    "AgentCard must not advertise gRPC transport",
  );
});

test("drift: default input/output modes are text-only", () => {
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  assert.deepEqual(card.defaultInputModes, ["text"]);
  assert.deepEqual(card.defaultOutputModes, ["text"]);
});

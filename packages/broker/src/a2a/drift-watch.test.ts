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
 * All tests are deterministic — they make no live network calls beyond
 * loopback test servers bound to 127.0.0.1:0.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyAgentCardSignature } from "a2a-attestation";
import { createBrokerAgentCard } from "./agent-card.js";
import { a2aStatusTimestamp, compareByA2AStatusTimestampDesc } from "./task-projection.js";
import type { TaskRecord } from "../core/types.js";
import { startTestServer } from "../server-test-helpers.js";
import {
  A2A_AGENT_CARD_GOLDEN,
  A2A_AGENT_CARD_TRUST_GOLDEN,
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

test("drift: push delivery is explicitly unsupported (config CRUD is opt-in, registration only)", () => {
  assert.equal(
    A2A_COMPATIBILITY_PROFILE.unsupportedPushDelivery,
    true,
    "unsupportedPushDelivery must remain true until live push delivery is implemented",
  );
  assert.equal(
    A2A_COMPATIBILITY_PROFILE.pushNotificationConfig.optIn,
    true,
    "push config CRUD stays opt-in (A2A_PUSH_NOTIFICATIONS_ENABLED)",
  );

  // The DEFAULT AgentCard must continue to advertise push as disabled.
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  assert.equal(
    card.capabilities.pushNotifications,
    false,
    "default AgentCard.capabilities.pushNotifications must stay false (opt-in only)",
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
      supportedInterfaces: card.supportedInterfaces,
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
// Trust golden ↔ shipped signing code path
// ---------------------------------------------------------------------------

test("drift: trust golden reflects the shipped opt-in signing code path (#1912 F1)", async () => {
  // Claim side: signing is opt-in and not required, and the profile advertises
  // the exact algorithms/canonicalization the shipped code path must produce.
  assert.equal(A2A_AGENT_CARD_TRUST_GOLDEN.signatureRequired, false);
  assert.equal(A2A_AGENT_CARD_TRUST_GOLDEN.trustModel, "transport-auth-only");
  assert.deepEqual(A2A_COMPATIBILITY_PROFILE.signedAgentCards, {
    optIn: true,
    algs: ["EdDSA", "ES256"],
    canonicalization: "RFC 8785",
  });

  // Code-path side: a broker booted with a signing key serves a card whose JWS
  // verifies against that key and whose alg stays inside the advertised set.
  // This is the server.ts AGENT_CARD_SIGNING_KEY_FILE → signAgentCard path —
  // the drift this suite previously could not see.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyDir = mkdtempSync(join(tmpdir(), "a2a-card-signing-"));
  try {
    const keyFile = join(keyDir, "card-signing.pem");
    writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    const signedServer = await startTestServer({ agentCardSigningKeyFile: keyFile });
    try {
      const card = await (await fetch(`${signedServer.baseUrl}/.well-known/agent-card.json`)).json();
      assert.ok(
        Array.isArray(card.signatures) && card.signatures.length === 1,
        "a broker with a signing key must serve exactly one JWS entry on the card",
      );
      const header = JSON.parse(Buffer.from(card.signatures[0].protected, "base64url").toString("utf8"));
      assert.ok(
        (A2A_COMPATIBILITY_PROFILE.signedAgentCards.algs as readonly string[]).includes(header.alg),
        `served JWS alg ${header.alg} must stay inside the advertised set`,
      );
      assert.equal(
        verifyAgentCardSignature(card, publicPem),
        true,
        "served card signature must verify against the configured key",
      );
    } finally {
      await signedServer.close();
    }

    // Unsigned serving remains the supported default: no key → no signatures
    // field at all (not even a placeholder).
    const unsignedServer = await startTestServer();
    try {
      const card = await (await fetch(`${unsignedServer.baseUrl}/.well-known/agent-card.json`)).json();
      assert.equal(
        "signatures" in card,
        false,
        "default card must not carry a signatures placeholder",
      );
    } finally {
      await unsignedServer.close();
    }
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JSON-RPC method inventory
// ---------------------------------------------------------------------------

test("drift: JSON-RPC method inventory matches documented profile", () => {
  const implemented = [...A2A_COMPATIBILITY_PROFILE.jsonRpcMethods];
  const expected = [
    "SendMessage",
    "SendStreamingMessage",
    "GetTask",
    "ListTasks",
    "CancelTask",
    "SubscribeToTask",
    "GetExtendedAgentCard",
    "CreateTaskPushNotificationConfig",
    "GetTaskPushNotificationConfig",
    "ListTaskPushNotificationConfigs",
    "DeleteTaskPushNotificationConfig",
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
  assert.match(doc, /Push notification delivery/i);
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
    // A floating ref like "main" defeats drift detection: the comparison
    // baseline silently moves. Pins must be full commit SHAs (the
    // refresh:drift-refs script writes these).
    assert.match(
      ref.pinned.ref,
      /^[0-9a-f]{40}$/,
      `${ref.repo} pinned ref must be a 40-hex commit SHA, got "${ref.pinned.ref}"`,
    );
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

// ---------------------------------------------------------------------------
// Trusted Conversation Plane advertisement (#1814 C6 / #1866)
// ---------------------------------------------------------------------------

test("drift: conversation plane advertises support and non-support accurately (#1866)", () => {
  const plane = A2A_COMPATIBILITY_PROFILE.conversationPlane;

  // The plane is deliberately NOT part of the A2A JSON-RPC method surface —
  // SendMessage keeps its pre-existing exchange/task meaning.
  assert.deepEqual(
    plane.a2aJsonRpcMethods,
    [],
    "the conversation plane must not be advertised as A2A JSON-RPC methods",
  );
  for (const supported of plane.supported) {
    assert.ok(!/SendMessage/i.test(supported), "supported list must not reframe SendMessage");
  }

  // The spec's non-goals stay advertised as unsupported.
  const unsupportedJoined = plane.unsupported.join("\n");
  for (const required of ["chat UI", "autonomous agent debate", "worker-to-worker sockets", "replication", "polling exposure"]) {
    assert.ok(
      unsupportedJoined.includes(required),
      `conversationPlane.unsupported must keep advertising: ${required}`,
    );
  }

  // The AgentCard carries the conversation skill with the accurate framing.
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });
  const skill = card.skills.find((entry) => entry.id === "conversation");
  assert.ok(skill, "AgentCard must advertise the conversation skill");
  assert.match(skill.description, /a2a\.conversation-envelope\.v1/);
  assert.match(skill.description, /not as A2A JSON-RPC methods/);

  // And the card must NOT advertise REST/gRPC interfaces for it (transport
  // gates above stay intact: url remains the JSON-RPC endpoint).
  assert.deepEqual(
    card.supportedInterfaces.map((entry) => entry.protocolBinding),
    ["JSONRPC"],
    "conversation surface must not add A2A transport bindings",
  );
});

test("drift: ListTasks ordering claim matches the shipped comparator (#1912 D11)", () => {
  const ordering = A2A_COMPATIBILITY_PROFILE.listTasksOrdering;
  assert.equal(
    ordering.spec,
    "status.timestamp desc, task id asc",
    "the spec-shape ordering claim must not drift without updating the comparator",
  );
  assert.match(
    ordering.legacy,
    /createdAt desc/,
    "the legacy envelope keeps createdAt ordering; changing it is a separate contract decision",
  );

  // Bind the claim to the shipped code path rather than restating it: the
  // comparator must actually order by status timestamp (completedAt ??
  // updatedAt) and must actually fall back to ascending task id.
  const base = {
    intent: "analyze",
    status: "queued",
    requester: { id: "requester-a", kind: "service", role: "researcher" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    payload: {},
    message: "drift",
  } as unknown as TaskRecord;

  const completedEarlyCreated: TaskRecord = {
    ...base,
    id: "created-first-completed-last",
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:30:00.000Z",
    completedAt: "2026-08-21T10:30:00.000Z",
  };
  const createdLater: TaskRecord = {
    ...base,
    id: "created-last-still-queued",
    createdAt: "2026-08-21T10:20:00.000Z",
    updatedAt: "2026-08-21T10:20:00.000Z",
  };

  assert.ok(
    compareByA2AStatusTimestampDesc(completedEarlyCreated, createdLater) < 0,
    "a later-completed task must sort ahead of a later-created one — createdAt ordering would invert this",
  );
  assert.equal(
    a2aStatusTimestamp(completedEarlyCreated),
    "2026-08-21T10:30:00.000Z",
    "the status timestamp must be completedAt when the task is terminal",
  );
  assert.equal(
    a2aStatusTimestamp(createdLater),
    "2026-08-21T10:20:00.000Z",
    "the status timestamp must fall back to updatedAt when the task is not terminal",
  );

  const tieLow: TaskRecord = { ...createdLater, id: "aaa" };
  const tieHigh: TaskRecord = { ...createdLater, id: "bbb" };
  assert.ok(
    compareByA2AStatusTimestampDesc(tieLow, tieHigh) < 0,
    "equal status timestamps must break on ascending task id so the order is total",
  );
  assert.equal(
    compareByA2AStatusTimestampDesc(tieLow, tieLow),
    0,
    "the comparator must be reflexive so sorts stay stable",
  );
});

test("drift: every AgentInterface declares its own protocolVersion (#1912 D7)", () => {
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  // A2A v1.0 moved protocol_version into AgentInterface, where it is REQUIRED
  // (a2a.proto v1.0.1: `string protocol_version = 4 [REQUIRED]`). A v1.0 client
  // picking an interface out of supported_interfaces reads the version from the
  // entry it picked, not from the card.
  assert.ok(card.supportedInterfaces.length > 0, "the card must advertise an interface");
  for (const entry of card.supportedInterfaces) {
    assert.equal(
      entry.protocolVersion,
      A2A_COMPATIBILITY_PROFILE.protocolVersion,
      `interface ${entry.protocolBinding} must declare the advertised protocol version`,
    );
  }

  // The card-level field is retained as a documented deviation for existing
  // readers; the two must not be allowed to disagree.
  assert.equal(
    card.protocolVersion,
    card.supportedInterfaces[0].protocolVersion,
    "card-level and interface-level protocol versions must not drift apart",
  );
});

test("drift: the card declares the edge-secret scheme only when it is enforced (#1912 D8)", () => {
  const base = {
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  } as const;

  // Posture 1 — no edge secret configured. assertEdgeSecret() is a no-op in
  // that case, so there is genuinely no authentication and the card MUST NOT
  // claim any. A card that advertises auth a deployment does not enforce is
  // worse than a card that stays silent.
  const open = createBrokerAgentCard(base);
  assert.equal(Object.hasOwn(open, "securitySchemes"), false);
  assert.equal(Object.hasOwn(open, "securityRequirements"), false);

  // Posture 2 — edge secret enforced. Declared as a ProtoJSON SecurityScheme
  // oneof (`apiKeySecurityScheme`), matching a2a.proto v1.0.1 and the
  // generated schema bundle. Note `location`, not OpenAPI's `in`.
  const secured = createBrokerAgentCard({ ...base, edgeSecretRequired: true });
  // Bind the profile claim to the shipped card rather than restating it.
  const declared = A2A_COMPATIBILITY_PROFILE.declaredSecurity;
  assert.equal(declared.declaredOnlyWhenEnforced, true);
  assert.equal(
    secured.securitySchemes?.[declared.schemeId]?.apiKeySecurityScheme?.name,
    declared.header,
  );
  assert.deepEqual(secured.securitySchemes, {
    edgeSecret: {
      apiKeySecurityScheme: {
        description:
          "Shared edge secret required on every request except liveness and public agent-card discovery.",
        location: "header",
        name: "x-a2a-edge-secret",
      },
    },
  });
  // SecurityRequirement.schemes is map<string, StringList>; the edge secret
  // carries no OAuth-style scopes, so the list is emptyrather than absent.
  assert.deepEqual(secured.securityRequirements, [{ schemes: { edgeSecret: { list: [] } } }]);

  // x-a2a-requester-id is an asserted identity, not a credential. Declaring it
  // as a security scheme would present an unauthenticated, caller-chosen value
  // as though it authenticated the caller.
  assert.equal(
    JSON.stringify(secured.securitySchemes).includes("requester-id"),
    false,
    "the requester-id header must never be declared as a credential",
  );
});

test("drift: a broker booted with an edge secret serves the declaration on the wire (#1912 D8)", async () => {
  // The card route is deliberately public — assertEdgeSecret exempts
  // /.well-known/agent-card.json — so discovery works before a client holds
  // the credential. That is exactly why the declaration has to be there.
  const secured = await startTestServer({ edgeSecret: "drift-edge-secret" });
  try {
    const card = await (await fetch(`${secured.baseUrl}/.well-known/agent-card.json`)).json();
    assert.equal(
      card.securitySchemes?.edgeSecret?.apiKeySecurityScheme?.name,
      "x-a2a-edge-secret",
      "an enforcing broker must publish how to authenticate",
    );
    assert.equal(card.securitySchemes.edgeSecret.apiKeySecurityScheme.location, "header");
    assert.deepEqual(card.securityRequirements, [{ schemes: { edgeSecret: { list: [] } } }]);
  } finally {
    await secured.close();
  }

  const open = await startTestServer({});
  try {
    const card = await (await fetch(`${open.baseUrl}/.well-known/agent-card.json`)).json();
    assert.equal(
      "securitySchemes" in card,
      false,
      "a broker enforcing nothing must not advertise a scheme",
    );
  } finally {
    await open.close();
  }
});

test("drift: multi-tenancy stance stays honest about what is not implemented (#1912 D9)", () => {
  const stance = A2A_COMPATIBILITY_PROFILE.multiTenancy;

  // The claim side must not quietly flip to "supported" while the blockers
  // below are still real. Multi-tenancy is the direction, not the state.
  assert.equal(stance.supported, false);
  assert.equal(stance.requestTenantPolicy, "reject-undeclared");
  assert.ok(stance.blockers.length >= 5, "each unmet prerequisite stays listed");

  // Code-path side: the shipped card declares no interface tenant, which is
  // what makes "reject-undeclared" the correct policy rather than a guess.
  const card = createBrokerAgentCard({
    serviceName: "drift-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });
  for (const entry of card.supportedInterfaces) {
    assert.equal(
      entry.tenant,
      undefined,
      "declaring an interface tenant means multi-tenancy shipped — update this stance with it",
    );
  }
});

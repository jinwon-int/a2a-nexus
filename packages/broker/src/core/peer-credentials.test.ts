import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import {
  assertPeerConversationScope,
  assertPeerHandoffScope,
  loadPeerCredentialRegistryFile,
  parsePeerCredentialRegistry,
  parsePeerHandoffScopeMode,
  peerHasConversationScope,
  peerHasHandoffScope,
  resolvePeerFromRequest,
  sha256Hex,
} from "./request-security.js";

function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function registryFor(scopes: string[], secret = "peer-secret") {
  return parsePeerCredentialRegistry(
    { brokerbeta: { secretSha256: sha256Hex(secret), scopes } },
    "test",
  );
}

test("parsePeerCredentialRegistry accepts digest records with known scopes", () => {
  const registry = registryFor(["handoff:create", "handoff:status"]);
  assert.deepEqual(registry["brokerbeta"]?.scopes, ["handoff:create", "handoff:status"]);
  assert.equal(registry["brokerbeta"]?.secretSha256, sha256Hex("peer-secret"));
});

test("parsePeerCredentialRegistry fails closed on unknown scope tokens and empty scope lists", () => {
  assert.throws(
    () => parsePeerCredentialRegistry({ p: { secretSha256: sha256Hex("s"), scopes: ["handoff:everything"] } }, "test"),
    /unknown peer scope/,
  );
  assert.throws(
    () => parsePeerCredentialRegistry({ p: { secretSha256: sha256Hex("s"), scopes: [] } }, "test"),
    /non-empty array/,
  );
  assert.throws(
    () => parsePeerCredentialRegistry({ p: { secretSha256: "not-a-digest", scopes: ["handoff:status"] } }, "test"),
    /sha256 digest/,
  );
});

test("loadPeerCredentialRegistryFile fails closed on raw secrets and non-root-only permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-peer-creds-"));

  const rawSecretFile = join(dir, "raw.json");
  writeFileSync(rawSecretFile, JSON.stringify({ p: { secret: "raw-value", scopes: ["handoff:status"] } }));
  chmodSync(rawSecretFile, 0o600);
  assert.throws(() => loadPeerCredentialRegistryFile(rawSecretFile), /must store secretSha256, not a raw secret/);

  const wideOpenFile = join(dir, "wide.json");
  writeFileSync(wideOpenFile, JSON.stringify({ p: { secretSha256: sha256Hex("s"), scopes: ["handoff:status"] } }));
  chmodSync(wideOpenFile, 0o644);
  if (process.platform !== "win32") {
    assert.throws(() => loadPeerCredentialRegistryFile(wideOpenFile), /must not be group\/other accessible/);
  }

  const goodFile = join(dir, "good.json");
  writeFileSync(goodFile, JSON.stringify({ brokerbeta: { secretSha256: sha256Hex("s"), scopes: ["handoff:evidence"] } }));
  chmodSync(goodFile, 0o600);
  const registry = loadPeerCredentialRegistryFile(goodFile);
  assert.deepEqual(registry["brokerbeta"]?.scopes, ["handoff:evidence"]);
});

test("resolvePeerFromRequest returns null without peer headers and fails closed on bad credentials", () => {
  const registry = registryFor(["handoff:status"]);

  assert.equal(resolvePeerFromRequest(registry, fakeRequest({})), null);

  // Presenting only one of the two headers is malformed → fail closed.
  assert.throws(
    () => resolvePeerFromRequest(registry, fakeRequest({ "x-a2a-peer-broker-id": "brokerbeta" })),
    /must be presented together/,
  );

  // Unknown peer / wrong secret → identical rejection message (no oracle).
  assert.throws(
    () => resolvePeerFromRequest(registry, fakeRequest({ "x-a2a-peer-broker-id": "ghost", "x-a2a-peer-secret": "peer-secret" })),
    /peer credential rejected/,
  );
  assert.throws(
    () => resolvePeerFromRequest(registry, fakeRequest({ "x-a2a-peer-broker-id": "brokerbeta", "x-a2a-peer-secret": "wrong" })),
    /peer credential rejected/,
  );

  // Peer headers against a broker with no registry → fail closed.
  assert.throws(
    () => resolvePeerFromRequest(null, fakeRequest({ "x-a2a-peer-broker-id": "brokerbeta", "x-a2a-peer-secret": "peer-secret" })),
    /not accepted/,
  );

  const verified = resolvePeerFromRequest(
    registry,
    fakeRequest({ "x-a2a-peer-broker-id": "brokerbeta", "x-a2a-peer-secret": "peer-secret" }),
  );
  assert.deepEqual(verified, { peerBrokerId: "brokerbeta", scopes: ["handoff:status"] });
});

test("revoked peer credentials fail closed even with the correct secret", () => {
  const registry = parsePeerCredentialRegistry(
    { brokerbeta: { secretSha256: sha256Hex("peer-secret"), scopes: ["handoff:status"], status: "revoked" } },
    "test",
  );
  assert.throws(
    () => resolvePeerFromRequest(registry, fakeRequest({ "x-a2a-peer-broker-id": "brokerbeta", "x-a2a-peer-secret": "peer-secret" })),
    /peer credential rejected/,
  );
  assert.equal(peerHasHandoffScope(registry, "brokerbeta", "handoff:status"), false);
});

test("assertPeerHandoffScope implements off/auto/enforce fail-closed semantics", () => {
  const peer = { peerBrokerId: "brokerbeta", scopes: ["handoff:status"] as const };

  // off: never asserts.
  assert.doesNotThrow(() => assertPeerHandoffScope("off", null, "handoff:evidence", "op"));

  // auto: header-less callers fall through; a verified peer without the
  // required scope fails closed.
  assert.doesNotThrow(() => assertPeerHandoffScope("auto", null, "handoff:evidence", "op"));
  assert.throws(
    () => assertPeerHandoffScope("auto", peer, "handoff:evidence", "op"),
    /not granted the handoff:evidence scope/,
  );
  assert.doesNotThrow(() => assertPeerHandoffScope("auto", peer, "handoff:status", "op"));

  // enforce: a missing peer credential fails closed.
  assert.throws(
    () => assertPeerHandoffScope("enforce", null, "handoff:evidence", "op"),
    /requires a peer credential with the handoff:evidence scope/,
  );
  assert.doesNotThrow(() => assertPeerHandoffScope("enforce", peer, "handoff:status", "op"));
});

test("peerHasHandoffScope grants exactly the declared minimum scope subset", () => {
  const registry = registryFor(["handoff:create"]);
  assert.equal(peerHasHandoffScope(registry, "brokerbeta", "handoff:create"), true);
  assert.equal(peerHasHandoffScope(registry, "brokerbeta", "handoff:evidence"), false);
  assert.equal(peerHasHandoffScope(registry, "unknown-peer", "handoff:create"), false);
  assert.equal(peerHasHandoffScope(null, "brokerbeta", "handoff:create"), false);
});

test("parsePeerHandoffScopeMode defaults to auto and rejects unknown modes", () => {
  assert.equal(parsePeerHandoffScopeMode(undefined, "TEST"), "auto");
  assert.equal(parsePeerHandoffScopeMode("", "TEST"), "auto");
  assert.equal(parsePeerHandoffScopeMode("off", "TEST"), "off");
  assert.equal(parsePeerHandoffScopeMode("enforce", "TEST"), "enforce");
  assert.throws(() => parsePeerHandoffScopeMode("always", "TEST"), /must be one of off\|auto\|enforce/);
});

// ---------------------------------------------------------------------------
// Trusted Conversation Plane peer scopes (#1864 slice 1, spec frozen as #1861)
// ---------------------------------------------------------------------------

test("parsePeerCredentialRegistry accepts the additive conversation:* scopes", () => {
  const registry = parsePeerCredentialRegistry(
    {
      p: {
        secretSha256: sha256Hex("s"),
        scopes: ["handoff:create", "conversation:send", "conversation:read", "conversation:relay"],
      },
    },
    "test",
  );
  assert.deepEqual(registry.p.scopes, ["handoff:create", "conversation:send", "conversation:read", "conversation:relay"]);
});

test("parsePeerCredentialRegistry still fails closed on unknown conversation-shaped scope tokens", () => {
  assert.throws(
    () => parsePeerCredentialRegistry({ p: { secretSha256: sha256Hex("s"), scopes: ["conversation:admin"] } }, "test"),
    /unknown peer scope/,
  );
  assert.throws(
    () => parsePeerCredentialRegistry({ p: { secretSha256: sha256Hex("s"), scopes: ["handoff:conversation"] } }, "test"),
    /unknown peer scope/,
  );
});

test("assertPeerConversationScope enforces the conversation plane fail-closed semantics", () => {
  const peer = { peerBrokerId: "broker-beta", scopes: ["conversation:read" as const] };
  // off: no gate
  assert.doesNotThrow(() => assertPeerConversationScope("off", null, "conversation:send", "relay submit"));
  // auto without peer headers: legacy behavior continues
  assert.doesNotThrow(() => assertPeerConversationScope("auto", null, "conversation:send", "relay submit"));
  // enforce without a verified peer fails closed
  assert.throws(
    () => assertPeerConversationScope("enforce", null, "conversation:send", "relay submit"),
    /requires a peer credential with the conversation:send scope/,
  );
  // missing scope on a verified peer fails closed
  assert.throws(
    () => assertPeerConversationScope("enforce", peer, "conversation:send", "relay submit"),
    /is not granted the conversation:send scope/,
  );
  // granted scope passes
  assert.doesNotThrow(() => assertPeerConversationScope("enforce", peer, "conversation:read", "relay read"));
});

test("peerHasConversationScope fails closed for missing peers, revoked records, and absent scopes", () => {
  const registry = parsePeerCredentialRegistry(
    {
      active: { secretSha256: sha256Hex("a"), scopes: ["conversation:send"] },
      revoked: { secretSha256: sha256Hex("r"), scopes: ["conversation:send"], status: "revoked" },
    },
    "test",
  );
  assert.equal(peerHasConversationScope(registry, "active", "conversation:send"), true);
  assert.equal(peerHasConversationScope(registry, "active", "conversation:relay"), false);
  assert.equal(peerHasConversationScope(registry, "revoked", "conversation:send"), false);
  assert.equal(peerHasConversationScope(registry, "missing", "conversation:send"), false);
  assert.equal(peerHasConversationScope(null, "active", "conversation:send"), false);
  assert.equal(peerHasConversationScope(registry, undefined, "conversation:send"), false);
});

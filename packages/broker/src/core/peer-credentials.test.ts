import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import {
  assertPeerHandoffScope,
  loadPeerCredentialRegistryFile,
  parsePeerCredentialRegistry,
  parsePeerHandoffScopeMode,
  peerHasHandoffScope,
  resolvePeerFromRequest,
  sha256Hex,
} from "./peer-credentials.js";

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
    /unknown handoff scope/,
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

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { evaluateVerdictGate } from "./check-finalizer-verdict.mjs";
import { VERDICT_SCHEMA, CANONICALIZATION } from "./verify-finalizer-verdict.mjs";
import { canonicalizeJson } from "./lib/a2a-offline-verify.mjs";

function signJws(payloadObject, privateKey, kid) {
  const protectedHeader = Buffer.from(canonicalizeJson({ alg: "EdDSA", typ: "JOSE", kid })).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(payloadObject)).toString("base64url");
  const signature = sign(null, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), privateKey).toString("base64url");
  return { protected: protectedHeader, signature };
}

function key() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

const HEAD = "headsha-1";

function buildVerdict(signerPriv, keyId, { subject = { kind: "pr", prHeadSha: HEAD }, decision = "go" } = {}) {
  const verdict = {
    schemaVersion: VERDICT_SCHEMA,
    canonicalization: CANONICALIZATION,
    subject,
    decision,
    evidenceRefs: [{ kind: "suite", ref: "ok" }],
    assurance: {
      proves: ["independent-review-occurred"],
      doesNotProve: ["analytical-correctness"],
      disclaimer: "Attests GO, not correctness.",
    },
    finalizerKeyId: keyId,
    producedAt: "2026-07-06T00:00:00.000Z",
  };
  verdict.sig = signJws(verdict, signerPriv, keyId);
  return verdict;
}

test("valid GO verdict bound to the head passes the gate", () => {
  const f = key();
  const verdict = buildVerdict(f.priv, "finalizer-1");
  const r = evaluateVerdictGate({
    verdict, headSha: HEAD,
    finalizerKeyring: { keys: { "finalizer-1": f.pem } },
    producingWorkerKeyIds: ["worker-9"],
    mode: "enforce",
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.blocked, false);
});

test("a NO-GO verdict blocks under enforce", () => {
  const f = key();
  const verdict = buildVerdict(f.priv, "finalizer-1", { decision: "no-go" });
  const r = evaluateVerdictGate({
    verdict, headSha: HEAD, finalizerKeyring: { keys: { "finalizer-1": f.pem } }, mode: "enforce",
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.ok(r.reasons.some((x) => /decision/.test(x)));
});

test("a verdict for a different head SHA is rejected (no stale/transplant)", () => {
  const f = key();
  const verdict = buildVerdict(f.priv, "finalizer-1", { subject: { kind: "pr", prHeadSha: "some-other-sha" } });
  const r = evaluateVerdictGate({
    verdict, headSha: HEAD, finalizerKeyring: { keys: { "finalizer-1": f.pem } }, mode: "enforce",
  });
  assert.equal(r.blocked, true);
  assert.ok(r.reasons.some((x) => /subject-binding/.test(x)));
});

test("self-certification (finalizer key produced the subject) is an independence violation", () => {
  const shared = key(); // same key registered as finalizer AND used as a producing worker
  const verdict = buildVerdict(shared.priv, "dual-role-key");
  const r = evaluateVerdictGate({
    verdict, headSha: HEAD,
    finalizerKeyring: { keys: { "dual-role-key": shared.pem } },
    producingWorkerKeyIds: ["dual-role-key"],
    mode: "enforce",
  });
  assert.equal(r.blocked, true);
  assert.ok(r.reasons.some((x) => /independence/.test(x)));
});

test("an unregistered finalizer key fails closed", () => {
  const f = key();
  const verdict = buildVerdict(f.priv, "rogue-key");
  const r = evaluateVerdictGate({
    verdict, headSha: HEAD,
    finalizerKeyring: { keys: {} }, // rogue-key not registered
    mode: "enforce",
  });
  assert.equal(r.blocked, true);
  assert.ok(r.reasons.some((x) => /finalizer-signature/.test(x)));
});

test("warn mode reports violations without blocking", () => {
  const f = key();
  const verdict = buildVerdict(f.priv, "finalizer-1", { decision: "no-go" });
  const r = evaluateVerdictGate({
    verdict, headSha: HEAD, finalizerKeyring: { keys: { "finalizer-1": f.pem } }, mode: "warn",
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, false, "warn mode never blocks");
  assert.ok(r.reasons.length > 0);
});

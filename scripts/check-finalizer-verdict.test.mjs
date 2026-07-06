import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { evaluateVerdictGate } from "./check-finalizer-verdict.mjs";
import { VERDICT_SCHEMA, CANONICALIZATION } from "./verify-finalizer-verdict.mjs";
import { canonicalizeJson } from "./lib/a2a-offline-verify.mjs";
import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Attester test support is inlined (not imported from the sibling .test.mjs) so
// that file's tests are not re-registered when this file runs.
const ATTESTER_SUBJECT = "repo:jinwon-int/a2a-nexus:workflow_ref:refs/heads/main";

function buildAttestedVerdict(certs, opts = {}) {
  const verdict = {
    schemaVersion: VERDICT_SCHEMA, canonicalization: CANONICALIZATION, kind: "judgment",
    subject: opts.subject ?? { kind: "pr", prHeadSha: "head-1" },
    decision: opts.decision ?? "go", evidenceRefs: [],
    assurance: { proves: ["independent-review-occurred"], doesNotProve: ["analytical-correctness", "reproducibility"], disclaimer: "Attests GO, not correctness." },
    producedAt: new Date().toISOString(),
    attester: { kind: "github-oidc", subject: opts.attesterSubject ?? ATTESTER_SUBJECT, leaf: certs.leafPem, rekor: { logIndex: 123, integratedTime: 1 } },
  };
  verdict.attester.sig = signJws({ ...verdict, attester: { ...verdict.attester } }, certs.leafKey, "oidc");
  return verdict;
}

let s3Certs;
function certsForGate() {
  if (s3Certs !== undefined) return s3Certs;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-gate-"));
    const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
    run(["req", "-x509", "-newkey", "ed25519", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3650", "-nodes", "-subj", "/CN=Test Fulcio Root"]);
    run(["req", "-new", "-newkey", "ed25519", "-keyout", "leaf.key", "-out", "leaf.csr", "-nodes", "-subj", "/CN=ephemeral"]);
    fs.writeFileSync(path.join(dir, "san.ext"), `subjectAltName=URI:${ATTESTER_SUBJECT}\n`);
    run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "3650", "-extfile", "san.ext"]);
    s3Certs = {
      caPem: fs.readFileSync(path.join(dir, "ca.crt"), "utf8"),
      leafPem: fs.readFileSync(path.join(dir, "leaf.crt"), "utf8"),
      leafKey: createPrivateKey(fs.readFileSync(path.join(dir, "leaf.key"))),
    };
  } catch {
    s3Certs = null;
  }
  return s3Certs;
}

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
    kind: "judgment",
    subject,
    decision,
    evidenceRefs: [{ kind: "suite", ref: "ok" }],
    assurance: {
      proves: ["independent-review-occurred"],
      doesNotProve: ["analytical-correctness", "reproducibility"],
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

test("an attested verdict whose subject is in the allowlist passes the gate (S3)", (t) => {
  const certs = certsForGate();
  if (!certs) return t.skip("openssl unavailable");
  const verdict = buildAttestedVerdict(certs, { subject: { kind: "pr", prHeadSha: "head-1" } });
  const r = evaluateVerdictGate({
    verdict, headSha: "head-1", finalizerKeyring: { keys: {}, roots: [certs.caPem] },
    attesterAllowlist: [ATTESTER_SUBJECT], mode: "enforce",
  });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.blocked, false);
  assert.equal(r.attesterSubject, ATTESTER_SUBJECT);
});

test("an attested verdict whose subject is NOT allowlisted is blocked (S3)", (t) => {
  const certs = certsForGate();
  if (!certs) return t.skip("openssl unavailable");
  const verdict = buildAttestedVerdict(certs, { subject: { kind: "pr", prHeadSha: "head-1" } });
  const r = evaluateVerdictGate({
    verdict, headSha: "head-1", finalizerKeyring: { keys: {}, roots: [certs.caPem] },
    attesterAllowlist: ["repo:someone-else/wf:ref:x"], mode: "enforce",
  });
  assert.equal(r.blocked, true);
  assert.ok(r.reasons.some((x) => /allowlist/.test(x)));
});

test("an attested finalizer that also produced the subject is an independence violation (S3)", (t) => {
  const certs = certsForGate();
  if (!certs) return t.skip("openssl unavailable");
  const verdict = buildAttestedVerdict(certs, { subject: { kind: "pr", prHeadSha: "head-1" } });
  const r = evaluateVerdictGate({
    verdict, headSha: "head-1", finalizerKeyring: { keys: {}, roots: [certs.caPem] },
    attesterAllowlist: [ATTESTER_SUBJECT], producingWorkerKeyIds: [ATTESTER_SUBJECT], mode: "enforce",
  });
  assert.equal(r.blocked, true);
  assert.ok(r.reasons.some((x) => /independence/.test(x)));
});

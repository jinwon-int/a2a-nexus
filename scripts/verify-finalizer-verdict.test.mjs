import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyVerdict, VERDICT_SCHEMA, CANONICALIZATION } from "./verify-finalizer-verdict.mjs";
import { canonicalizeJson } from "./lib/a2a-offline-verify.mjs";

// --- S3 attested-identity test helpers: generate a CA (stand-in Fulcio root)
// and a leaf cert whose SAN carries the OIDC subject, via openssl. Skips the
// attester tests gracefully if openssl is unavailable.
export const ATTESTER_SUBJECT = "repo:jinwon-int/a2a-nexus:workflow_ref:refs/heads/main";
let certCache;
function attesterCerts() {
  if (certCache !== undefined) return certCache;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-attester-"));
    const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
    run(["req", "-x509", "-newkey", "ed25519", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3650", "-nodes", "-subj", "/CN=Test Fulcio Root"]);
    run(["req", "-new", "-newkey", "ed25519", "-keyout", "leaf.key", "-out", "leaf.csr", "-nodes", "-subj", "/CN=ephemeral"]);
    fs.writeFileSync(path.join(dir, "san.ext"), `subjectAltName=URI:${ATTESTER_SUBJECT}\n`);
    run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "3650", "-extfile", "san.ext"]);
    certCache = {
      caPem: fs.readFileSync(path.join(dir, "ca.crt"), "utf8"),
      leafPem: fs.readFileSync(path.join(dir, "leaf.crt"), "utf8"),
      leafKey: createPrivateKey(fs.readFileSync(path.join(dir, "leaf.key"))),
    };
  } catch {
    certCache = null;
  }
  return certCache;
}

let altCaCache;
function attesterCertsAlt() {
  if (altCaCache !== undefined) return altCaCache;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-attester-alt-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ed25519", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3650", "-nodes", "-subj", "/CN=Other Root"], { cwd: dir, stdio: "ignore" });
    altCaCache = { caPem: fs.readFileSync(path.join(dir, "ca.crt"), "utf8") };
  } catch {
    altCaCache = null;
  }
  return altCaCache;
}

export function buildAttestedVerdict(certs, opts = {}) {
  const verdict = {
    schemaVersion: VERDICT_SCHEMA,
    canonicalization: CANONICALIZATION,
    kind: "judgment",
    subject: opts.subject ?? { kind: "pr", prHeadSha: "head-1" },
    decision: opts.decision ?? "go",
    evidenceRefs: [],
    assurance: {
      proves: ["independent-review-occurred"],
      doesNotProve: ["analytical-correctness", "reproducibility"],
      disclaimer: "Attests GO, not correctness.",
    },
    producedAt: new Date().toISOString(),
    attester: {
      kind: "github-oidc",
      subject: opts.attesterSubject ?? ATTESTER_SUBJECT,
      leaf: certs.leafPem,
      rekor: { logIndex: 123, integratedTime: 1 },
    },
  };
  verdict.attester.sig = signJws({ ...verdict, attester: { ...verdict.attester } }, certs.leafKey, "oidc");
  return verdict;
}

function signJws(payloadObject, privateKey, kid) {
  const protectedHeader = Buffer.from(canonicalizeJson({ alg: "EdDSA", typ: "JOSE", kid })).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(payloadObject)).toString("base64url");
  const signature = sign(null, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), privateKey).toString("base64url");
  return { protected: protectedHeader, signature };
}

function makeCtx() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    finalizerKeyId: "finalizer-1",
    finalizerPriv: privateKey,
    keyring: { keys: { "finalizer-1": publicKey.export({ type: "spki", format: "pem" }).toString() } },
  };
}

function buildVerdict(ctx, opts = {}) {
  const kind = opts.kind ?? "judgment";
  const verdict = {
    schemaVersion: VERDICT_SCHEMA,
    canonicalization: CANONICALIZATION,
    kind,
    subject: opts.subject ?? { kind: "pr", prHeadSha: "abc123" },
    decision: opts.decision ?? "go",
    evidenceRefs: [{ kind: "suite", ref: "3738/3738" }],
    assurance: {
      proves: ["independent-review-occurred", "verdict-integrity", "subject-binding"],
      doesNotProve: opts.doesNotProve ?? (kind === "judgment"
        ? ["analytical-correctness", "reproducibility"]
        : ["analytical-correctness"]),
      disclaimer: "Attests an independent GO on this exact artifact; does not certify correctness.",
    },
    finalizerKeyId: opts.finalizerKeyId ?? ctx.finalizerKeyId,
    producedAt: "2026-07-06T00:00:00.000Z",
  };
  if (opts.omitAssurance) delete verdict.assurance;
  if (opts.omitKind) delete verdict.kind;
  verdict.sig = signJws(verdict, ctx.finalizerPriv, ctx.finalizerKeyId);
  return verdict;
}

const check = (r, id) => r.checks.find((c) => c.id === id);

test("valid verdict verifies (no subject binding when not requested)", () => {
  const ctx = makeCtx();
  const r = verifyVerdict(buildVerdict(ctx), ctx.keyring);
  assert.equal(r.valid, true, JSON.stringify(r.checks));
  assert.equal(r.decision, "go");
  assert.equal(check(r, "subject-binding"), undefined);
});

test("subject binding passes when expected subject matches", () => {
  const ctx = makeCtx();
  const verdict = buildVerdict(ctx, { subject: { kind: "pr", prHeadSha: "deadbeef" } });
  const r = verifyVerdict(verdict, ctx.keyring, { expectedSubject: { kind: "pr", prHeadSha: "deadbeef" } });
  assert.equal(r.valid, true);
  assert.equal(check(r, "subject-binding").ok, true);
});

test("subject binding fails when the expected artifact differs (no transplant)", () => {
  const ctx = makeCtx();
  const verdict = buildVerdict(ctx, { subject: { kind: "pr", prHeadSha: "aaaa" } });
  const r = verifyVerdict(verdict, ctx.keyring, { expectedSubject: { kind: "pr", prHeadSha: "bbbb" } });
  assert.equal(r.valid, false);
  assert.equal(check(r, "subject-binding").ok, false);
});

test("tampered decision breaks the signature (decision is signed)", () => {
  const ctx = makeCtx();
  const verdict = buildVerdict(ctx, { decision: "go" });
  verdict.decision = "no-go";
  const r = verifyVerdict(verdict, ctx.keyring);
  assert.equal(r.valid, false);
  assert.equal(check(r, "finalizer-signature").ok, false);
});

test("tampered subject breaks the signature", () => {
  const ctx = makeCtx();
  const verdict = buildVerdict(ctx);
  verdict.subject.prHeadSha = "tampered";
  const r = verifyVerdict(verdict, ctx.keyring);
  assert.equal(r.valid, false);
  assert.equal(check(r, "finalizer-signature").ok, false);
});

test("unknown finalizer key fails closed", () => {
  const ctx = makeCtx();
  const r = verifyVerdict(buildVerdict(ctx), { keys: {} });
  assert.equal(r.valid, false);
  assert.equal(check(r, "finalizer-signature").ok, false);
  assert.match(check(r, "finalizer-signature").detail, /not in keyring/);
});

test("a signed verdict without the assurance invariant is still RED", () => {
  const ctx = makeCtx();
  const r = verifyVerdict(buildVerdict(ctx, { omitAssurance: true }), ctx.keyring);
  assert.equal(check(r, "finalizer-signature").ok, true, "signature valid");
  assert.equal(check(r, "assurance-invariant").ok, false);
  assert.equal(r.valid, false);
});

test("assurance that omits analytical-correctness is rejected", () => {
  const ctx = makeCtx();
  const r = verifyVerdict(buildVerdict(ctx, { doesNotProve: ["normative-judgment"] }), ctx.keyring);
  assert.equal(check(r, "assurance-invariant").ok, false);
  assert.equal(r.valid, false);
});

test("a verdict without a kind is rejected at shape (S2)", () => {
  const ctx = makeCtx();
  const r = verifyVerdict(buildVerdict(ctx, { omitKind: true }), ctx.keyring);
  assert.equal(r.valid, false);
  assert.equal(check(r, "shape").ok, false);
});

test("a judgment verdict that does not disclaim reproducibility is rejected (S2/H2)", () => {
  const ctx = makeCtx();
  // Correctly signed, but tries to borrow battery-grade reproducibility by omission.
  const r = verifyVerdict(buildVerdict(ctx, { kind: "judgment", doesNotProve: ["analytical-correctness"] }), ctx.keyring);
  assert.equal(check(r, "finalizer-signature").ok, true, "signature valid");
  assert.equal(check(r, "assurance-invariant").ok, false);
  assert.match(check(r, "assurance-invariant").detail, /reproducibility/);
  assert.equal(r.valid, false);
});

test("a battery verdict verifies without a reproducibility disclaimer", () => {
  const ctx = makeCtx();
  const r = verifyVerdict(buildVerdict(ctx, { kind: "battery" }), ctx.keyring);
  assert.equal(r.valid, true, JSON.stringify(r.checks));
  assert.equal(r.kind, "battery");
});

test("malformed verdict is a fail-closed result, not a crash", () => {
  const ctx = makeCtx();
  for (const bad of [null, {}, { schemaVersion: "wrong" }, 7, "no"]) {
    const r = verifyVerdict(bad, ctx.keyring);
    assert.equal(r.valid, false);
    assert.equal(check(r, "shape").ok, false);
  }
});

test("a verdict with neither a static key nor an attester is rejected at shape (S3)", () => {
  const ctx = makeCtx();
  const bare = {
    schemaVersion: VERDICT_SCHEMA, canonicalization: CANONICALIZATION, kind: "judgment",
    subject: { kind: "pr", prHeadSha: "h" }, decision: "go",
    assurance: { proves: [], doesNotProve: ["analytical-correctness", "reproducibility"], disclaimer: "x" },
    producedAt: "2026-07-06T00:00:00.000Z",
  };
  const r = verifyVerdict(bare, ctx.keyring);
  assert.equal(r.valid, false);
  assert.equal(check(r, "shape").ok, false);
});

test("an attested verdict (OIDC leaf chained to a trusted root) verifies (S3)", (t) => {
  const certs = attesterCerts();
  if (!certs) return t.skip("openssl unavailable — skipping attested-identity crypto");
  const verdict = buildAttestedVerdict(certs);
  const r = verifyVerdict(verdict, { keys: {}, roots: [certs.caPem] }, { expectedSubject: { kind: "pr", prHeadSha: "head-1" } });
  assert.equal(r.valid, true, JSON.stringify(r.checks));
  assert.equal(check(r, "attester-identity").ok, true);
  assert.equal(r.attesterSubject, ATTESTER_SUBJECT);
});

test("an attested verdict fails closed with no trusted root configured (S3)", (t) => {
  const certs = attesterCerts();
  if (!certs) return t.skip("openssl unavailable");
  const r = verifyVerdict(buildAttestedVerdict(certs), { keys: {}, roots: [] });
  assert.equal(r.valid, false);
  assert.equal(check(r, "attester-identity").ok, false);
  assert.match(check(r, "attester-identity").detail, /no trusted attester roots/);
});

test("a self-signed leaf (not chaining to the trusted root) is rejected (S3)", (t) => {
  const certs = attesterCerts();
  if (!certs) return t.skip("openssl unavailable");
  // Present a DIFFERENT CA as the only trusted root — the leaf no longer chains.
  const otherCa = attesterCertsAlt();
  if (!otherCa) return t.skip("openssl unavailable");
  const r = verifyVerdict(buildAttestedVerdict(certs), { keys: {}, roots: [otherCa.caPem] });
  assert.equal(r.valid, false);
  assert.match(check(r, "attester-identity").detail, /chain/);
});

test("a tampered attested verdict fails the attester signature (S3)", (t) => {
  const certs = attesterCerts();
  if (!certs) return t.skip("openssl unavailable");
  const verdict = buildAttestedVerdict(certs);
  verdict.decision = "no-go"; // signed field
  const r = verifyVerdict(verdict, { keys: {}, roots: [certs.caPem] });
  assert.equal(r.valid, false);
  assert.equal(check(r, "attester-identity").ok, false);
});

test("an attester.subject not matching the leaf SAN is rejected (S3)", (t) => {
  const certs = attesterCerts();
  if (!certs) return t.skip("openssl unavailable");
  const verdict = buildAttestedVerdict(certs, { attesterSubject: "repo:evil/repo:workflow_ref:x" });
  const r = verifyVerdict(verdict, { keys: {}, roots: [certs.caPem] });
  assert.equal(check(r, "attester-identity").ok, false);
  assert.match(check(r, "attester-identity").detail, /SAN/);
});

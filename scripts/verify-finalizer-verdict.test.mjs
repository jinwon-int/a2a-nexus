import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { verifyVerdict, VERDICT_SCHEMA, CANONICALIZATION } from "./verify-finalizer-verdict.mjs";
import { canonicalizeJson } from "./lib/a2a-offline-verify.mjs";

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

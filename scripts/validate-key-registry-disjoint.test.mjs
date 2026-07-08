// #1383 V-c: disjoint role registry validator tests.
// Structural independence source: finalizer, worker, and broker keys must live
// in disjoint role registries — distinct keyId prefixes, no shared keyId, and
// (the load-bearing check) no shared public key. The same Ed25519 keypair
// registered as both a worker and a finalizer would let a producer self-certify
// regardless of the gate's belt-and-suspenders check.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { validateKeyRegistryDisjoint } from "./validate-key-registry-disjoint.mjs";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    jwk: publicKey.export({ format: "jwk" }),
    privateKey,
  };
}

function fixtures() {
  const w = keypair();
  const f = keypair();
  const b = keypair();
  return {
    worker: { "worker:alpha:g2:v1": { publicKeyJwk: w.jwk, status: "active" } },
    finalizer: { keys: { "finalizer:panel:v1": f.pem }, roots: [] },
    brokerCountersign: { "broker:hub:agent-card:v1": { pem: b.pem } },
    _keys: { w, f, b },
  };
}

test("three well-formed disjoint registries validate with zero problems", () => {
  const fx = fixtures();
  assert.deepEqual(
    validateKeyRegistryDisjoint({ worker: fx.worker, finalizer: fx.finalizer, brokerCountersign: fx.brokerCountersign }),
    [],
  );
});

test("a keyId without its role prefix fails closed", () => {
  const fx = fixtures();
  fx.finalizer.keys["not-prefixed"] = fx._keys.f.pem;
  const problems = validateKeyRegistryDisjoint({ worker: fx.worker, finalizer: fx.finalizer, brokerCountersign: fx.brokerCountersign });
  assert.ok(problems.some((p) => /not-prefixed/.test(p) && /prefix/.test(p)), problems.join("; "));
});

test("a keyId shared across two registries is rejected", () => {
  const fx = fixtures();
  // A worker-prefixed id must not also appear in the finalizer registry.
  fx.finalizer.keys["worker:alpha:g2:v1"] = fx._keys.w.pem;
  const problems = validateKeyRegistryDisjoint({ worker: fx.worker, finalizer: fx.finalizer, brokerCountersign: fx.brokerCountersign });
  assert.ok(problems.some((p) => /worker:alpha:g2:v1/.test(p)), problems.join("; "));
});

test("the SAME public key registered under two roles is rejected (structural independence)", () => {
  const fx = fixtures();
  // The finalizer registers a DIFFERENT keyId but the SAME keypair the worker uses.
  fx.finalizer.keys["finalizer:panel:v1"] = fx._keys.w.pem;
  const problems = validateKeyRegistryDisjoint({ worker: fx.worker, finalizer: fx.finalizer, brokerCountersign: fx.brokerCountersign });
  assert.ok(
    problems.some((p) => /public key/i.test(p) && /worker/.test(p) && /finalizer/.test(p)),
    `expected shared-public-key problem, got: ${problems.join("; ")}`,
  );
});

test("the same public key serialized as JWK vs PEM is still detected as shared", () => {
  const fx = fixtures();
  // broker registry re-registers the worker's key as PEM; worker holds it as JWK.
  fx.brokerCountersign["broker:hub:agent-card:v1"] = { pem: fx._keys.w.pem };
  const problems = validateKeyRegistryDisjoint({ worker: fx.worker, finalizer: fx.finalizer, brokerCountersign: fx.brokerCountersign });
  assert.ok(
    problems.some((p) => /public key/i.test(p) && /worker/.test(p) && /broker/.test(p)),
    `cross-format shared key must be caught: ${problems.join("; ")}`,
  );
});

test("missing registries are allowed (validate whatever subset is supplied)", () => {
  const fx = fixtures();
  assert.deepEqual(validateKeyRegistryDisjoint({ finalizer: fx.finalizer }), []);
  assert.deepEqual(validateKeyRegistryDisjoint({}), []);
});

test("an unparseable public key fails closed rather than silently skipping", () => {
  const fx = fixtures();
  fx.finalizer.keys["finalizer:bad:v1"] = "-----BEGIN PUBLIC KEY-----\nnot-base64\n-----END PUBLIC KEY-----\n";
  const problems = validateKeyRegistryDisjoint({ finalizer: fx.finalizer });
  assert.ok(problems.some((p) => /finalizer:bad:v1/.test(p) && /parse|invalid/i.test(p)), problems.join("; "));
});

// #2082 A/D: worker idle-poll backoff and one-time signing key import.
// Idle workers used to poll at the fixed interval forever (12·N broker list
// queries per minute with N idle workers), and every signed request (plus
// every result provenance attachment) re-imported the Ed25519 JWK.
import assert from "node:assert/strict";
import test from "node:test";

import { nextIdlePollDelayMs } from "./broker-worker-client.js";
import { workerSigningKey, workerPrivateKeyPem } from "./worker-http-signature.js";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";

const jwkFor = (key: KeyObject) => key.export({ format: "jwk" }) as Record<string, unknown>;

test("nextIdlePollDelayMs: unset ceiling keeps the historical fixed interval", () => {
  const base = { processed: 0, currentIdleDelayMs: 5_000, pollIntervalMs: 5_000 };
  assert.equal(nextIdlePollDelayMs({ ...base }), 5_000);
  assert.equal(nextIdlePollDelayMs({ ...base, maxIdlePollIntervalMs: 0 }), 5_000);
  assert.equal(nextIdlePollDelayMs({ ...base, maxIdlePollIntervalMs: 4_999 }), 5_000);
});

test("nextIdlePollDelayMs: processed > 0 resets to the base interval", () => {
  const base = { processed: 1, currentIdleDelayMs: 30_000, pollIntervalMs: 5_000, maxIdlePollIntervalMs: 30_000 };
  assert.equal(nextIdlePollDelayMs(base), 5_000);
  assert.equal(nextIdlePollDelayMs({ ...base, processed: 7 }), 5_000);
});

test("nextIdlePollDelayMs: empty polls grow x1.5 with jitter, capped at the ceiling", () => {
  const deterministic = () => 0.5; // no jitter
  const base = { processed: 0, pollIntervalMs: 5_000, maxIdlePollIntervalMs: 30_000, random: deterministic };
  let delay = 5_000;
  const sequence: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    delay = nextIdlePollDelayMs({ ...base, currentIdleDelayMs: delay });
    sequence.push(delay);
  }
  assert.deepEqual(sequence.slice(0, 3), [7_500, 11_250, 16_875]);
  // growth caps at the ceiling and stays there
  assert.ok(sequence.every((ms) => ms >= 5_000 && ms <= 30_000), `delays within bounds: ${sequence}`);
  assert.equal(sequence.at(-1), 30_000);
});

test("nextIdlePollDelayMs: jitter stays within ±20% and never below the base interval", () => {
  for (let i = 0; i < 200; i += 1) {
    const delay = nextIdlePollDelayMs({
      processed: 0,
      currentIdleDelayMs: 11_250,
      pollIntervalMs: 5_000,
      maxIdlePollIntervalMs: 30_000,
    });
    const expected = Math.min(11_250 * 1.5 * 1.2, 30_000);
    assert.ok(delay >= 5_000 && delay <= expected, `delay ${delay} outside [5000, ${expected}]`);
  }
});

test("workerSigningKey/workerPrivateKeyPem import the JWK once per config (#2082 D)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = jwkFor(privateKey);
  jwk.kty = "OKP";
  jwk.crv = "Ed25519";

  const config = {
    keyid: "test-key",
    privateKeyJwk: jwk,
    brokerId: "broker-a",
  };

  // The WeakMap cache cannot be observed directly, so pin the contract that
  // matters: the cached object IS the imported KeyObject for this config, the
  // PEM is stable across calls, and a second config gets its own material.
  const first = workerSigningKey(config);
  assert.equal(workerSigningKey(config), first, "same config returns the identical cached KeyObject");
  assert.equal(workerSigningKey(config).asymmetricKeyType, "ed25519");

  const pem1 = workerPrivateKeyPem(config);
  const pem2 = workerPrivateKeyPem(config);
  assert.equal(pem1, pem2);
  assert.match(pem1, /BEGIN PRIVATE KEY/);

  const otherConfig = { ...config, keyid: "other-key" };
  assert.notEqual(workerSigningKey(otherConfig), first, "a different config object gets its own key");

  // The cached key must equal a fresh import of the same JWK material.
  assert.deepEqual(
    first.export({ format: "jwk" }),
    createPrivateKey({ key: jwk, format: "jwk" }).export({ format: "jwk" }),
  );
  assert.ok(publicKey.export({ format: "jwk" }));
});

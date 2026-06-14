import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildWorkerHttpSignatureRolloutPreflight,
  parseWorkerHttpSignaturePreflightArgs,
} from './worker-http-signature-rollout-preflight.mjs';

function signingFixture(workerId = 'worker-a') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyJwk = privateKey.export({ format: 'jwk' });
  const publicKeyJwk = publicKey.export({ format: 'jwk' });
  const keyid = `worker:${workerId}:v1`;
  return {
    keyid,
    privateKeyJwk,
    publicKeyJwk,
    privateKeyText: JSON.stringify(privateKeyJwk),
    registry: {
      [keyid]: {
        keyid,
        workerId,
        publicKeyJwk,
      },
    },
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'worker-http-signature-preflight-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('worker HTTP Signature rollout preflight passes matching worker env and registry without leaking private JWK', async () => {
  const fixture = signingFixture();
  const report = await buildWorkerHttpSignatureRolloutPreflight({
    env: {
      WORKER_ID: 'worker-a',
      A2A_HTTP_SIGNATURE_WORKER_KEY_ID: fixture.keyid,
      A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: fixture.privateKeyText,
      A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    },
    registry: fixture.registry,
    expectedBrokerId: 'seoseo',
  });

  assert.equal(report.ok, true);
  assert.equal(report.workerId, 'worker-a');
  assert.equal(report.keyid, fixture.keyid);
  assert.equal(report.brokerId, 'seoseo');
  assert.equal(report.safety.privateKeyMaterialEmitted, false);
  assert.equal(report.checks.every((check) => check.ok), true);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(fixture.privateKeyJwk.d), false);
  assert.equal(serialized.includes(fixture.privateKeyText), false);
});

test('worker HTTP Signature rollout preflight fails closed for registry owner mismatch and key mismatch', async () => {
  const fixture = signingFixture();
  const wrongKey = signingFixture('worker-a');
  const ownerMismatch = await buildWorkerHttpSignatureRolloutPreflight({
    env: {
      WORKER_ID: 'worker-a',
      A2A_HTTP_SIGNATURE_WORKER_KEY_ID: fixture.keyid,
      A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: fixture.privateKeyText,
      A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    },
    registry: {
      [fixture.keyid]: {
        keyid: fixture.keyid,
        workerId: 'worker-b',
        publicKeyJwk: fixture.publicKeyJwk,
      },
    },
  });
  assert.equal(ownerMismatch.ok, false);
  assert.ok(ownerMismatch.checks.some((check) => !check.ok && check.code === 'owner_mismatch'));

  const keyMismatch = await buildWorkerHttpSignatureRolloutPreflight({
    env: {
      WORKER_ID: 'worker-a',
      A2A_HTTP_SIGNATURE_WORKER_KEY_ID: fixture.keyid,
      A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: wrongKey.privateKeyText,
      A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    },
    registry: fixture.registry,
  });
  assert.equal(keyMismatch.ok, false);
  assert.ok(keyMismatch.checks.some((check) => !check.ok && check.code === 'key_pair_mismatch'));
});

test('worker HTTP Signature rollout preflight fails closed for missing vars unsafe key ids and ambiguous worker ids', async () => {
  const fixture = signingFixture();
  const missing = await buildWorkerHttpSignatureRolloutPreflight({ env: {}, registry: fixture.registry });
  assert.equal(missing.ok, false);
  assert.ok(missing.checks.some((check) => !check.ok && check.code === 'worker_id_missing'));
  assert.ok(missing.checks.some((check) => !check.ok && check.code === 'keyid_missing'));
  assert.ok(missing.checks.some((check) => !check.ok && check.code === 'private_jwk_missing'));
  assert.ok(missing.checks.some((check) => !check.ok && check.code === 'broker_id_missing'));

  const unsafe = await buildWorkerHttpSignatureRolloutPreflight({
    env: {
      WORKER_ID: 'worker-a',
      A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:worker-a:v1";created=1',
      A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: fixture.privateKeyText,
      A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    },
    registry: fixture.registry,
  });
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.checks.some((check) => !check.ok && check.code === 'keyid_unsafe'));

  const ambiguous = await buildWorkerHttpSignatureRolloutPreflight({
    env: {
      WORKER_ID: 'worker-a',
      A2A_WORKER_ID: 'worker-b',
      A2A_HTTP_SIGNATURE_WORKER_KEY_ID: fixture.keyid,
      A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: fixture.privateKeyText,
      A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    },
    registry: fixture.registry,
  });
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.checks.some((check) => !check.ok && check.code === 'worker_id_ambiguous'));
});

test('worker HTTP Signature rollout preflight parses env/registry files and expected broker id', async () => {
  const fixture = signingFixture();
  await withTempDir(async (dir) => {
    const envFile = join(dir, 'worker.env');
    const registryFile = join(dir, 'registry.json');
    await writeFile(envFile, [
      'WORKER_ID=worker-a',
      `A2A_HTTP_SIGNATURE_WORKER_KEY_ID=${fixture.keyid}`,
      `A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK='${fixture.privateKeyText}'`,
      'A2A_HTTP_SIGNATURE_BROKER_ID=seoseo',
    ].join('\n'));
    await writeFile(registryFile, JSON.stringify(fixture.registry));

    const options = parseWorkerHttpSignaturePreflightArgs([
      '--worker-env-file', envFile,
      '--registry-file', registryFile,
      '--expected-broker-id', 'gwakga',
      '--json',
    ]);
    const report = await buildWorkerHttpSignatureRolloutPreflight(options);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => !check.ok && check.code === 'broker_id_mismatch'));
    assert.equal(JSON.stringify(report).includes(fixture.privateKeyJwk.d), false);
  });
});

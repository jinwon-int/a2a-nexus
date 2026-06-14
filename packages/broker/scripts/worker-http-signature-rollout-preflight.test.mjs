import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = 'scripts/worker-http-signature-rollout-preflight.mjs';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
}

function writeRegistry(records) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-http-signature-registry-'));
  const path = join(dir, 'registry.json');
  writeFileSync(path, JSON.stringify(records, null, 2), 'utf8');
  return path;
}

function runPreflight(env, args = ['--json']) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      ...env,
    },
    encoding: 'utf8',
  });
}

function parseJson(result) {
  assert.equal(result.stderr, '', 'preflight should not print secrets/errors to stderr for structured outcomes');
  return JSON.parse(result.stdout);
}

test('worker HTTP Signature rollout preflight passes for a matching worker private key and broker registry record', () => {
  const keys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'sogyo',
      publicKeyJwk: keys.publicJwk,
    },
  });

  const result = runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
    A2A_EXPECTED_BROKER_ID: 'seoseo',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = parseJson(result);
  assert.equal(report.ok, true);
  assert.equal(report.workerId, 'sogyo');
  assert.equal(report.keyid, 'worker:sogyo:v1');
  assert.equal(report.brokerId, 'seoseo');
  assert.equal(report.privateKeyMaterialEmitted, false);
  assert.equal(JSON.stringify(report).includes(String(keys.privateJwk.d)), false);
});

test('worker HTTP Signature rollout preflight fails closed when registry public key does not match worker private key', () => {
  const workerKeys = keyPair();
  const registryKeys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'sogyo',
      publicKeyJwk: registryKeys.publicJwk,
    },
  });

  const result = runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(workerKeys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  });

  assert.notEqual(result.status, 0);
  const report = parseJson(result);
  assert.equal(report.ok, false);
  assert.equal(report.failures.some((failure) => failure.code === 'key_pair_mismatch'), true);
  assert.equal(JSON.stringify(report).includes(String(workerKeys.privateJwk.d)), false);
});

test('worker HTTP Signature rollout preflight fails closed on worker owner mismatch, unsafe key id, and broker mismatch', () => {
  const keys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'bangtong',
      publicKeyJwk: keys.publicJwk,
    },
  });

  const ownerMismatch = parseJson(runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  }));
  assert.equal(ownerMismatch.ok, false);
  assert.equal(ownerMismatch.failures.some((failure) => failure.code === 'worker_owner_mismatch'), true);

  const unsafeKeyId = parseJson(runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1";created=1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  }));
  assert.equal(unsafeKeyId.ok, false);
  assert.equal(unsafeKeyId.failures.some((failure) => failure.code === 'unsafe_keyid'), true);

  const brokerMismatch = parseJson(runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'gwakga',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
    A2A_EXPECTED_BROKER_ID: 'seoseo',
  }));
  assert.equal(brokerMismatch.ok, false);
  assert.equal(brokerMismatch.failures.some((failure) => failure.code === 'broker_id_mismatch'), true);
});

test('worker HTTP Signature rollout preflight supports empty primary env values falling back to worker aliases', () => {
  const keys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'sogyo',
      publicKeyJwk: keys.publicJwk,
    },
  });

  const result = runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: '',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: '',
    A2A_HTTP_SIGNATURE_BROKER_ID: '',
    WORKER_HTTP_SIGNATURE_KEY_ID: 'worker:sogyo:v1',
    WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    WORKER_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = parseJson(result);
  assert.equal(report.ok, true);
  assert.equal(report.envSources.keyid, 'WORKER_HTTP_SIGNATURE_KEY_ID');
  assert.equal(report.envSources.privateKeyJwk, 'WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK');
  assert.equal(report.envSources.brokerId, 'WORKER_HTTP_SIGNATURE_BROKER_ID');
}
);

test('worker HTTP Signature rollout preflight matches runtime env aliases and rejects registry-file alias-only setup', () => {
  const keys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'sogyo',
      publicKeyJwk: keys.publicJwk,
    },
  });

  const report = parseJson(runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    WORKER_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  }));

  assert.equal(report.ok, false);
  assert.equal(report.failures.some((failure) => failure.code === 'missing_registry_file'), true);
});

test('worker HTTP Signature rollout preflight rejects duplicate workerId registry records like broker runtime loader', () => {
  const keys = keyPair();
  const otherKeys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'sogyo',
      publicKeyJwk: keys.publicJwk,
    },
    'worker:sogyo:v2': {
      keyid: 'worker:sogyo:v2',
      workerId: 'sogyo',
      publicKeyJwk: otherKeys.publicJwk,
    },
  });

  const report = parseJson(runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  }));

  assert.equal(report.ok, false);
  assert.equal(report.failures.some((failure) => failure.code === 'duplicate_worker_id'), true);
});

test('worker HTTP Signature rollout preflight rejects broker ids that worker runtime would reject', () => {
  const keys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'sogyo',
      publicKeyJwk: keys.publicJwk,
    },
  });

  for (const badBrokerId of ['-seoseo', 'seo seo', 'x'.repeat(129)]) {
    const report = parseJson(runPreflight({
      WORKER_ID: 'sogyo',
      A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
      A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
      A2A_HTTP_SIGNATURE_BROKER_ID: badBrokerId,
      A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
    }));
    assert.equal(report.ok, false);
    assert.equal(report.failures.some((failure) => failure.code === 'invalid_broker_id'), true);
  }
});

test('worker HTTP Signature rollout preflight markdown output redacts unsafe reflected values', () => {
  const keys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'sogyo',
      publicKeyJwk: keys.publicJwk,
    },
  });
  const unsafeKeyId = 'worker:sogyo:v1";created=1';

  const result = runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: unsafeKeyId,
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  }, []);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes(unsafeKeyId), false);
  assert.equal(result.stdout.includes(registryPath), false);
  assert.match(result.stdout, /<redacted-unsafe>/);
});

test('worker HTTP Signature rollout preflight normalizes embedded registry keyid and workerId like runtime loader', () => {
  const keys = keyPair();
  const registryPath = writeRegistry({
    'worker:sogyo:v1': {
      keyid: ' worker:sogyo:v1 ',
      workerId: ' sogyo ',
      publicKeyJwk: keys.publicJwk,
    },
  });

  const result = runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parseJson(result).ok, true);
});

test('worker HTTP Signature rollout preflight markdown output does not reflect unsafe registry-derived values', () => {
  const keys = keyPair();
  const unsafeRegistryKey = 'bad-key **inject**';
  const unsafeWorkerId = 'sogyo\n## injected';
  const registryPath = writeRegistry({
    [unsafeRegistryKey]: {
      keyid: 'different-key',
      workerId: unsafeWorkerId,
      publicKeyJwk: keys.publicJwk,
    },
    'worker:sogyo:v1': {
      keyid: 'worker:sogyo:v1',
      workerId: 'sogyo',
      publicKeyJwk: keys.publicJwk,
    },
  });

  const result = runPreflight({
    WORKER_ID: 'sogyo',
    A2A_HTTP_SIGNATURE_WORKER_KEY_ID: 'worker:sogyo:v1',
    A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK: JSON.stringify(keys.privateJwk),
    A2A_HTTP_SIGNATURE_BROKER_ID: 'seoseo',
    A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE: registryPath,
  }, []);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes(unsafeRegistryKey), false);
  assert.equal(result.stdout.includes(unsafeWorkerId), false);
  assert.equal(result.stdout.includes('## injected'), false);
});

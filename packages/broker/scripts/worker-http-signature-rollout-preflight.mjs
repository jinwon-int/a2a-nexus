#!/usr/bin/env node
// Source-only A2A HTTP Signature worker rollout preflight.
// Verifies worker private signing key material matches the broker public-key
// registry before an operator enables signed/strict worker control-plane auth.
// Never prints private JWK material.

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const SAFE_SIGNATURE_PARAM_RE = /^[A-Za-z0-9._~:/@-]{1,256}$/;
const BROKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JSON_MODE = process.argv.includes('--json') || process.argv.includes('--format=json');

function optionalTrimmed(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function envFirst(names) {
  for (const name of names) {
    const value = optionalTrimmed(process.env[name]);
    if (value) return { value, source: name };
  }
  return { value: undefined, source: undefined };
}

function failure(code, message, detail = undefined) {
  return { code, message, ...(detail ? { detail } : {}) };
}

function safeJsonParse(raw, code, label) {
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    return { failure: failure(code, `${label} must be valid JSON`) };
  }
}

function validatePrivateJwk(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return failure('invalid_private_jwk', 'worker private JWK must be a JSON object');
  }
  if (input.kty !== 'OKP' || input.crv !== 'Ed25519' || typeof input.x !== 'string' || typeof input.d !== 'string') {
    return failure('invalid_private_jwk', 'worker private JWK must be an Ed25519 private JWK');
  }
  try {
    createPrivateKey({ key: input, format: 'jwk' });
  } catch {
    return failure('invalid_private_jwk', 'worker private JWK is not importable');
  }
  return undefined;
}

function validatePublicJwk(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return failure('invalid_registry_public_jwk', 'registry publicKeyJwk must be a JSON object');
  }
  if ('d' in input) {
    return failure('registry_contains_private_key', 'registry publicKeyJwk must not contain private key material');
  }
  if (input.kty !== 'OKP' || input.crv !== 'Ed25519' || typeof input.x !== 'string' || input.x.length === 0) {
    return failure('invalid_registry_public_jwk', 'registry publicKeyJwk must be an Ed25519 public JWK');
  }
  try {
    createPublicKey({ key: input, format: 'jwk' });
  } catch {
    return failure('invalid_registry_public_jwk', 'registry publicKeyJwk is not importable');
  }
  return undefined;
}

function loadRegistry(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { failure: failure('registry_unreadable', 'A2A HTTP Signature key registry file is unreadable or invalid JSON') };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { failure: failure('registry_invalid', 'A2A HTTP Signature key registry must be a JSON object keyed by keyid') };
  }

  const workerIds = new Set();
  const normalized = {};
  const failures = [];
  for (const [registryKey, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      failures.push(failure('registry_invalid_record', 'registry record must be an object'));
      continue;
    }

    const normalizedKeyid = typeof value.keyid === 'string' ? value.keyid.trim() : undefined;
    const normalizedWorkerId = typeof value.workerId === 'string' ? value.workerId.trim() : undefined;

    if (!normalizedKeyid) {
      failures.push(failure('registry_keyid_missing', 'registry record keyid must be non-empty'));
    } else if (normalizedKeyid !== registryKey) {
      failures.push(failure('registry_keyid_mismatch', 'registry key must match embedded keyid'));
    }

    if (!normalizedWorkerId) {
      failures.push(failure('registry_worker_id_missing', 'registry record workerId must be non-empty'));
    } else {
      if (workerIds.has(normalizedWorkerId)) {
        failures.push(failure('duplicate_worker_id', 'registry contains duplicate workerId'));
      }
      workerIds.add(normalizedWorkerId);
    }

    const publicFailure = validatePublicJwk(value.publicKeyJwk);
    if (publicFailure) failures.push(publicFailure);

    normalized[registryKey] = {
      ...value,
      ...(normalizedKeyid ? { keyid: normalizedKeyid } : {}),
      ...(normalizedWorkerId ? { workerId: normalizedWorkerId } : {}),
    };
  }

  return { value: normalized, failures };
}

function publicKeyMatchesPrivate(privateJwk, publicJwk) {
  try {
    const privateKey = createPrivateKey({ key: privateJwk, format: 'jwk' });
    const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });
    const challenge = Buffer.from('a2a-worker-http-signature-rollout-preflight-v1');
    const signature = sign(null, challenge, privateKey);
    return verify(null, challenge, publicKey, signature);
  } catch {
    return false;
  }
}

function buildReport() {
  const failures = [];
  const workerId = envFirst(['WORKER_ID', 'A2A_WORKER_ID', 'NODE_ID']);
  const keyid = envFirst(['A2A_HTTP_SIGNATURE_WORKER_KEY_ID', 'WORKER_HTTP_SIGNATURE_KEY_ID']);
  const privateKeyJwk = envFirst([
    'A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK',
    'WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK',
  ]);
  const brokerId = envFirst(['A2A_HTTP_SIGNATURE_BROKER_ID', 'WORKER_HTTP_SIGNATURE_BROKER_ID']);
  const registryFile = envFirst(['A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE']);
  const expectedBrokerId = envFirst(['A2A_EXPECTED_BROKER_ID', 'EXPECTED_BROKER_ID']);

  if (!workerId.value) failures.push(failure('missing_worker_id', 'WORKER_ID/A2A_WORKER_ID/NODE_ID is required'));
  if (!keyid.value) failures.push(failure('missing_keyid', 'A2A_HTTP_SIGNATURE_WORKER_KEY_ID is required'));
  if (!privateKeyJwk.value) failures.push(failure('missing_private_jwk', 'A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK is required'));
  if (!brokerId.value) failures.push(failure('missing_broker_id', 'A2A_HTTP_SIGNATURE_BROKER_ID is required'));
  if (!registryFile.value) failures.push(failure('missing_registry_file', 'A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE is required'));

  if (keyid.value && !SAFE_SIGNATURE_PARAM_RE.test(keyid.value)) {
    failures.push(failure('unsafe_keyid', 'worker signing key id contains characters unsafe for Signature-Input'));
  }

  if (brokerId.value && !BROKER_ID_RE.test(brokerId.value)) {
    failures.push(failure('invalid_broker_id', 'worker broker id must use only letters, numbers, dots, underscores, colons, or hyphens and start with an alphanumeric character'));
  }

  if (expectedBrokerId.value && !BROKER_ID_RE.test(expectedBrokerId.value)) {
    failures.push(failure('invalid_expected_broker_id', 'expected broker id must use the worker runtime broker id format'));
  }

  if (expectedBrokerId.value && brokerId.value && expectedBrokerId.value !== brokerId.value) {
    failures.push(failure('broker_id_mismatch', 'worker broker id does not match expected broker id'));
  }

  let privateJwk;
  if (privateKeyJwk.value) {
    const parsed = safeJsonParse(privateKeyJwk.value, 'invalid_private_jwk', 'worker private JWK');
    if (parsed.failure) {
      failures.push(parsed.failure);
    } else {
      privateJwk = parsed.value;
      const validationFailure = validatePrivateJwk(privateJwk);
      if (validationFailure) failures.push(validationFailure);
    }
  }

  let registry;
  if (registryFile.value) {
    const loaded = loadRegistry(registryFile.value);
    if (loaded.failure) {
      failures.push(loaded.failure);
    } else {
      registry = loaded.value;
      failures.push(...(loaded.failures ?? []));
    }
  }

  let registryRecord;
  if (registry && keyid.value) {
    registryRecord = registry[keyid.value];
    if (!registryRecord || typeof registryRecord !== 'object' || Array.isArray(registryRecord)) {
      failures.push(failure('registry_key_missing', 'registry does not contain worker signing key id'));
    } else {
      if (registryRecord.keyid !== keyid.value) {
        failures.push(failure('registry_keyid_mismatch', 'registry key must match embedded keyid'));
      }
      if (workerId.value && registryRecord.workerId !== workerId.value) {
        failures.push(failure('worker_owner_mismatch', 'registry key owner does not match worker id'));
      }
      const publicFailure = validatePublicJwk(registryRecord.publicKeyJwk);
      if (publicFailure) failures.push(publicFailure);
      if (privateJwk && !publicFailure && !publicKeyMatchesPrivate(privateJwk, registryRecord.publicKeyJwk)) {
        failures.push(failure('key_pair_mismatch', 'worker private JWK does not match registry public JWK'));
      }
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    kind: 'a2a-broker.worker-http-signature-rollout-preflight.v1',
    workerId: workerId.value ?? null,
    keyid: keyid.value ?? null,
    brokerId: brokerId.value ?? null,
    registry: registryFile.value ? { configured: true, path: registryFile.value } : { configured: false },
    envSources: {
      workerId: workerId.source ?? null,
      keyid: keyid.source ?? null,
      privateKeyJwk: privateKeyJwk.source ?? null,
      brokerId: brokerId.source ?? null,
      registryFile: registryFile.source ?? null,
      expectedBrokerId: expectedBrokerId.source ?? null,
    },
    checks: {
      requiredEnvPresent: Boolean(workerId.value && keyid.value && privateKeyJwk.value && brokerId.value && registryFile.value),
      safeKeyId: Boolean(keyid.value && SAFE_SIGNATURE_PARAM_RE.test(keyid.value)),
      privateJwkImportable: Boolean(privateJwk && !validatePrivateJwk(privateJwk)),
      registryEntryPresent: Boolean(registryRecord),
      registryOwnerMatches: Boolean(registryRecord && workerId.value && registryRecord.workerId === workerId.value),
      keyPairMatches: Boolean(registryRecord && privateJwk && publicKeyMatchesPrivate(privateJwk, registryRecord.publicKeyJwk)),
      brokerIdMatchesExpected: Boolean(!expectedBrokerId.value || expectedBrokerId.value === brokerId.value),
    },
    failures,
    privateKeyMaterialEmitted: false,
  };
}

function safeDisplay(value) {
  if (typeof value !== 'string' || value.length === 0) return '<missing>';
  return /^[A-Za-z0-9._~:/@-]{1,256}$/.test(value) ? value : '<redacted-unsafe>';
}

function pathDisplay(registry) {
  if (!registry.configured) return 'false';
  return '<configured-redacted>';
}

function renderMarkdown(report) {
  const lines = [
    `# Worker A2A HTTP Signature rollout preflight: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    `workerId: ${safeDisplay(report.workerId)}`,
    `keyid: ${safeDisplay(report.keyid)}`,
    `brokerId: ${safeDisplay(report.brokerId)}`,
    `registry: ${pathDisplay(report.registry)}`,
    '',
  ];
  if (report.failures.length > 0) {
    lines.push('## Failures');
    for (const item of report.failures) {
      lines.push(`- ${item.code}: ${item.message}`);
    }
  } else {
    lines.push('All checks passed. Private signing key material was not emitted.');
  }
  return `${lines.join('\n')}\n`;
}

const report = buildReport();
if (JSON_MODE) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderMarkdown(report));
}
process.exit(report.ok ? 0 : 1);

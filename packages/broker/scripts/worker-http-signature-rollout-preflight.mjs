#!/usr/bin/env node
// Source-only rollout preflight for worker A2A HTTP Signature credentials.
// This script validates local env/config and broker public-key registry material
// before operators enable signed worker control-plane traffic. It never mutates
// services, contacts a broker, moves secrets, or prints private JWK material.

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const SAFE_SIGNATURE_PARAM_RE = /^[A-Za-z0-9._~:/@-]{1,256}$/;
const WORKER_ID_ENV_NAMES = Object.freeze(['WORKER_ID', 'A2A_WORKER_ID', 'NODE_ID']);
const KEY_ID_ENV_NAMES = Object.freeze(['A2A_HTTP_SIGNATURE_WORKER_KEY_ID', 'WORKER_HTTP_SIGNATURE_KEY_ID']);
const PRIVATE_JWK_ENV_NAMES = Object.freeze([
  'A2A_HTTP_SIGNATURE_WORKER_PRIVATE_KEY_JWK',
  'WORKER_HTTP_SIGNATURE_PRIVATE_KEY_JWK',
]);
const BROKER_ID_ENV_NAMES = Object.freeze(['A2A_HTTP_SIGNATURE_BROKER_ID', 'WORKER_HTTP_SIGNATURE_BROKER_ID']);
const REGISTRY_FILE_ENV_NAMES = Object.freeze(['A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE']);

const SAFETY = Object.freeze({
  sourceOnly: true,
  brokerHttpRequested: false,
  deployAttempted: false,
  restartAttempted: false,
  dbMutationAttempted: false,
  providerSendAttempted: false,
  terminalAckAttempted: false,
  replayAttempted: false,
  releaseAttempted: false,
  secretMovementAttempted: false,
  privateKeyMaterialEmitted: false,
});

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseWorkerHttpSignaturePreflightArgs(argv = process.argv.slice(2)) {
  return {
    workerEnvFile: readOption(argv, '--worker-env-file'),
    registryFile: readOption(argv, '--registry-file'),
    expectedBrokerId: readOption(argv, '--expected-broker-id'),
    json: argv.includes('--json') || readOption(argv, '--format') === 'json',
    markdown: argv.includes('--markdown') || readOption(argv, '--format') === 'markdown',
  };
}

function unquote(value) {
  return String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function optionalTrimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseEnvFile(path) {
  const parsed = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    parsed[match[1]] = unquote(match[2]);
  }
  return parsed;
}

function readFirstEnv(env, names) {
  for (const name of names) {
    const value = optionalTrimmed(env[name]);
    if (value) return { name, value };
  }
  return { name: undefined, value: undefined };
}

function readUniqueWorkerId(env) {
  const values = [];
  for (const name of WORKER_ID_ENV_NAMES) {
    const value = optionalTrimmed(env[name]);
    if (value) values.push({ name, value });
  }
  const unique = [...new Set(values.map((entry) => entry.value))];
  if (unique.length === 0) return { value: undefined, ambiguous: false, sources: [] };
  return { value: unique.length === 1 ? unique[0] : undefined, ambiguous: unique.length > 1, sources: values.map((entry) => entry.name) };
}

function readRegistryFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ok(code, detail) {
  return { ok: true, code, detail };
}

function fail(code, detail) {
  return { ok: false, code, detail };
}

function validatePrivateJwk(input) {
  if (!isRecord(input)) return fail('private_jwk_invalid', 'private JWK must be a JSON object');
  if (input.kty !== 'OKP' || input.crv !== 'Ed25519' || typeof input.d !== 'string' || typeof input.x !== 'string') {
    return fail('private_jwk_invalid', 'private JWK must be an Ed25519 private JWK');
  }
  try {
    return { ...ok('private_jwk_valid', 'worker private JWK is valid Ed25519 material'), privateKey: createPrivateKey({ key: input, format: 'jwk' }) };
  } catch (error) {
    return fail('private_jwk_invalid', `private JWK is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePublicJwk(input) {
  if (!isRecord(input)) return fail('public_jwk_invalid', 'registry public JWK must be a JSON object');
  if ('d' in input) return fail('public_jwk_private_material', 'registry public JWK must not contain private key material');
  if (input.kty !== 'OKP' || input.crv !== 'Ed25519' || typeof input.x !== 'string') {
    return fail('public_jwk_invalid', 'registry public JWK must be an Ed25519 public JWK');
  }
  try {
    return { ...ok('public_jwk_valid', 'registry public JWK is valid Ed25519 material'), publicKey: createPublicKey({ key: input, format: 'jwk' }) };
  } catch (error) {
    return fail('public_jwk_invalid', `registry public JWK is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsePrivateJwk(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: `private JWK JSON is invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function normalizeInputs(options) {
  const fileEnv = options.workerEnvFile ? parseEnvFile(options.workerEnvFile) : {};
  const env = { ...process.env, ...fileEnv, ...(options.env ?? {}) };
  const registryFile = options.registryFile
    ?? readFirstEnv(env, REGISTRY_FILE_ENV_NAMES).value;
  const registry = options.registry ?? (registryFile ? readRegistryFile(registryFile) : undefined);
  return { env, registry, registryFile };
}

export async function buildWorkerHttpSignatureRolloutPreflight(options = {}) {
  const checks = [];
  const { env, registry, registryFile } = normalizeInputs(options);
  const workerId = readUniqueWorkerId(env);
  const keyid = readFirstEnv(env, KEY_ID_ENV_NAMES);
  const privateJwkText = readFirstEnv(env, PRIVATE_JWK_ENV_NAMES);
  const brokerId = readFirstEnv(env, BROKER_ID_ENV_NAMES);
  const expectedBrokerId = optionalTrimmed(options.expectedBrokerId);

  if (workerId.ambiguous) {
    checks.push(fail('worker_id_ambiguous', `worker id env vars disagree: ${workerId.sources.join(', ')}`));
  } else if (!workerId.value) {
    checks.push(fail('worker_id_missing', `one of ${WORKER_ID_ENV_NAMES.join(', ')} is required`));
  } else {
    checks.push(ok('worker_id_present', 'worker id is present and unambiguous'));
  }

  if (!keyid.value) {
    checks.push(fail('keyid_missing', `one of ${KEY_ID_ENV_NAMES.join(', ')} is required`));
  } else if (!SAFE_SIGNATURE_PARAM_RE.test(keyid.value)) {
    checks.push(fail('keyid_unsafe', 'key id contains characters unsafe for Signature-Input parameters'));
  } else {
    checks.push(ok('keyid_safe', 'worker key id is present and Signature-Input safe'));
  }

  let privateKey;
  if (!privateJwkText.value) {
    checks.push(fail('private_jwk_missing', `one of ${PRIVATE_JWK_ENV_NAMES.join(', ')} is required`));
  } else {
    const parsed = parsePrivateJwk(privateJwkText.value);
    if (parsed.error) {
      checks.push(fail('private_jwk_invalid', parsed.error));
    } else {
      const validation = validatePrivateJwk(parsed.value);
      checks.push(validation.ok ? ok(validation.code, validation.detail) : validation);
      if (validation.ok) privateKey = validation.privateKey;
    }
  }

  if (!brokerId.value) {
    checks.push(fail('broker_id_missing', `one of ${BROKER_ID_ENV_NAMES.join(', ')} is required`));
  } else if (expectedBrokerId && brokerId.value !== expectedBrokerId) {
    checks.push(fail('broker_id_mismatch', `worker broker id does not match expected broker id ${expectedBrokerId}`));
  } else {
    checks.push(ok('broker_id_present', expectedBrokerId ? 'worker broker id matches expected broker id' : 'worker broker id is present'));
  }

  let registryRecord;
  let publicKey;
  if (!registry) {
    checks.push(fail('registry_missing', 'registry JSON or --registry-file/A2A_HTTP_SIGNATURE_KEY_REGISTRY_FILE is required'));
  } else if (!isRecord(registry)) {
    checks.push(fail('registry_invalid', 'registry must be a JSON object keyed by key id'));
  } else if (keyid.value && isRecord(registry)) {
    const candidate = registry[keyid.value];
    if (!candidate) {
      checks.push(fail('registry_entry_missing', 'registry does not contain the worker key id'));
    } else if (!isRecord(candidate)) {
      checks.push(fail('registry_entry_invalid', 'registry record must be a JSON object'));
    } else {
      registryRecord = candidate;
      if (candidate.keyid !== keyid.value) {
        checks.push(fail('registry_keyid_mismatch', 'registry key id does not match embedded keyid'));
      } else {
        checks.push(ok('registry_entry_present', 'registry contains the worker key id'));
      }
      if (workerId.value && candidate.workerId !== workerId.value) {
        checks.push(fail('owner_mismatch', 'registry key owner does not match worker id'));
      } else if (workerId.value) {
        checks.push(ok('owner_matches', 'registry key owner matches worker id'));
      }
      const publicValidation = validatePublicJwk(candidate.publicKeyJwk);
      checks.push(publicValidation.ok ? ok(publicValidation.code, publicValidation.detail) : publicValidation);
      if (publicValidation.ok) publicKey = publicValidation.publicKey;
    }
  }

  if (privateKey && publicKey) {
    const challenge = Buffer.from('a2a-http-signature-rollout-preflight-v1');
    const signature = sign(null, challenge, privateKey);
    if (verify(null, challenge, publicKey, signature)) {
      checks.push(ok('key_pair_matches', 'private JWK signs a challenge verified by the registry public JWK'));
    } else {
      checks.push(fail('key_pair_mismatch', 'private JWK does not match registry public JWK'));
    }
  } else if (privateJwkText.value || registryRecord) {
    checks.push(fail('key_pair_unverified', 'key pair challenge could not be verified because key material validation failed'));
  }

  const report = {
    ok: checks.every((check) => check.ok),
    workerId: workerId.value,
    keyid: keyid.value,
    brokerId: brokerId.value,
    expectedBrokerId,
    registrySource: registryFile ? 'file' : (options.registry ? 'provided' : 'missing'),
    registryWorkerId: isRecord(registryRecord) && typeof registryRecord.workerId === 'string' ? registryRecord.workerId : undefined,
    checks,
    safety: SAFETY,
  };
  return report;
}

export function renderWorkerHttpSignaturePreflightMarkdown(report) {
  const status = report.ok ? 'PASS' : 'FAIL';
  const rows = report.checks
    .map((check) => `| ${check.ok ? '✅' : '❌'} | ${check.code} | ${check.detail.replace(/\|/g, '\\|')} |`)
    .join('\n');
  return [
    `# Worker A2A HTTP Signature rollout preflight: ${status}`,
    '',
    `- workerId: ${report.workerId ?? '<missing>'}`,
    `- keyid: ${report.keyid ?? '<missing>'}`,
    `- brokerId: ${report.brokerId ?? '<missing>'}`,
    `- expectedBrokerId: ${report.expectedBrokerId ?? '<not supplied>'}`,
    `- registrySource: ${report.registrySource}`,
    '- privateKeyMaterial: [REDACTED / not emitted]',
    '',
    '| OK | Check | Detail |',
    '|---|---|---|',
    rows,
    '',
    'Safety: source-only; no deploy/restart, broker HTTP request, DB mutation, provider send, Terminal ACK/replay, release/tag, credential movement, or private key output.',
  ].join('\n');
}

async function main() {
  const options = parseWorkerHttpSignaturePreflightArgs();
  const report = await buildWorkerHttpSignatureRolloutPreflight(options);
  if (options.markdown) {
    console.log(renderWorkerHttpSignaturePreflightMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`worker HTTP Signature rollout preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * Offline verifier for source-only A2A Agent Work Proof bundles (#1481).
 *
 * This is a composition verifier: it does not invent a new trust primitive. It
 * checks that an agent-work-proof bundle binds an existing verifiable analysis
 * report product package, a deterministic certification battery, a signed
 * completion certificate, an artifact manifest, and a signed finalizer verdict.
 *
 * Safety: local read-only verification only. No broker/API calls, provider
 * sends, releases, registry/badge writes, DB/ACK/replay actions, deploys,
 * restarts, visibility changes, or secret/key movement.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { verifyAnalysisReportProductPackage } from './verify-analysis-report.mjs';
import { verifyVerdict } from './verify-finalizer-verdict.mjs';
import { canonicalizeJson, sha256Prefix } from './lib/a2a-offline-verify.mjs';
import { verifyCertificationBatteryBundle } from './lib/certification-battery-verifier.mjs';
import { verifyCompletionCertificate } from './lib/completion-certificate-verifier.mjs';

export const AGENT_WORK_PROOF_SCHEMA = 'a2a.agent-work-proof.bundle.v0';
export const AGENT_WORK_PROOF_ARTIFACT_MANIFEST_SCHEMA = 'a2a.agent-work-proof.artifactManifest.v0';
export const CANONICALIZATION = 'rfc8785-jcs-v1';

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const EXPECTED_ARTIFACTS = [
  'verifiable-analysis-report-product',
  'certification-battery-fixture',
  'completion-certificate',
];
const PUBLIC_SAFETY_FIELDS = [
  'containsPrivatePaths',
  'containsRawLogs',
  'containsTokens',
  'containsProviderIds',
  'containsPrivateKeys',
  'containsTelegramIds',
];
const FORBIDDEN_RUNTIME_STRINGS = [
  '/root/',
  '/home/',
  '/Users/',
  '.openclaw/',
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
];
const SECRET_LIKE_PATTERNS = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /sk_live_[A-Za-z0-9]+/,
  /rk_live_[A-Za-z0-9]+/,
  /pk_live_[A-Za-z0-9]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /A2A_EDGE_SECRET=/,
  /EDGE_SECRET=/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
];

function pass(checks, id) {
  checks.push({ id, ok: true });
}

function fail(checks, id, detail) {
  checks.push({ id, ok: false, detail });
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function hashObject(value) {
  return sha256Prefix(canonicalizeJson(value));
}

function sameJcs(a, b) {
  try {
    return canonicalizeJson(a) === canonicalizeJson(b);
  } catch {
    return false;
  }
}

function unsafeStringFindings(value, trail = []) {
  const findings = [];
  const visit = (node, pathParts) => {
    if (typeof node === 'string') {
      for (const marker of FORBIDDEN_RUNTIME_STRINGS) {
        if (node.includes(marker)) findings.push({ id: 'private-runtime-marker', marker, path: pathParts.join('.') });
      }
      for (const pattern of SECRET_LIKE_PATTERNS) {
        if (pattern.test(node)) findings.push({ id: 'secret-like-string', marker: String(pattern), path: pathParts.join('.') });
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...pathParts, String(index)]));
    } else if (node && typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        const lower = key.toLowerCase();
        if (item !== false && item !== null && item !== undefined) {
          if (lower.includes('telegram') && lower.includes('id')) {
            findings.push({ id: 'telegram-id-field', marker: key, path: [...pathParts, key].join('.') });
          }
          if (lower.includes('provider') && lower.includes('id')) {
            findings.push({ id: 'provider-id-field', marker: key, path: [...pathParts, key].join('.') });
          }
        }
        visit(item, [...pathParts, key]);
      }
    }
  };
  visit(value, trail);
  return findings;
}

function evidenceHashes(bundle) {
  return {
    reportProductHash: bundle?.evidence?.reportProduct ? hashObject(bundle.evidence.reportProduct) : undefined,
    certificationBatteryHash: bundle?.evidence?.certificationBattery ? hashObject(bundle.evidence.certificationBattery) : undefined,
    completionCertificateHash: bundle?.evidence?.completionCertificate ? hashObject(bundle.evidence.completionCertificate) : undefined,
  };
}

function expectedCompletionSubject(bundle, hashes) {
  return {
    kind: 'task-result',
    taskId: bundle?.task?.taskId,
    workerId: bundle?.task?.workerId,
    resultHash: bundle?.task?.resultHash,
    artifactHashes: [hashes.reportProductHash, hashes.certificationBatteryHash],
  };
}

function expectedWorkProofSubject(bundle, hashes, artifactManifestHash) {
  return {
    kind: 'agent-work-proof-bundle',
    proofId: bundle?.proofId,
    taskId: bundle?.task?.taskId,
    workerId: bundle?.task?.workerId,
    resultHash: bundle?.task?.resultHash,
    reportProductHash: hashes.reportProductHash,
    certificationBatteryHash: hashes.certificationBatteryHash,
    completionCertificateHash: hashes.completionCertificateHash,
    artifactManifestHash,
  };
}

function verifyBundleShape(bundle, checks) {
  if (!isPlainObject(bundle) || bundle.schemaVersion !== AGENT_WORK_PROOF_SCHEMA) {
    fail(checks, 'bundle-shape', `schemaVersion must be ${AGENT_WORK_PROOF_SCHEMA}`);
    return;
  }
  if (bundle.canonicalization !== CANONICALIZATION) fail(checks, 'bundle-shape', `canonicalization must be ${CANONICALIZATION}`);
  else if (typeof bundle.proofId !== 'string' || bundle.proofId.trim() === '') fail(checks, 'bundle-shape', 'proofId required');
  else pass(checks, 'bundle-shape');

  if (bundle.sourceOnly !== true || bundle.noLive !== true) {
    fail(checks, 'bundle-source-only', 'bundle must declare sourceOnly=true and noLive=true');
  } else {
    pass(checks, 'bundle-source-only');
  }

  if (!isPlainObject(bundle.task) || !bundle.task.taskId || !bundle.task.workerId || !isSha256(bundle.task.resultHash)) {
    fail(checks, 'task-binding', 'task must include taskId, workerId, and sha256 resultHash');
  }
}

function verifyEvidenceHashBindings(bundle, hashes, checks) {
  const declared = bundle?.evidenceHashes || {};
  const pairs = Object.entries(hashes);
  let ok = true;
  for (const [key, value] of pairs) {
    if (!isSha256(value) || declared[key] !== value) {
      ok = false;
      fail(checks, 'evidence-hashes', `${key} must equal sha256:JCS(evidence artifact)`);
    }
  }
  if (ok) pass(checks, 'evidence-hashes');
}

function verifyTaskMatchesReport(bundle, checks) {
  const report = bundle?.evidence?.reportProduct?.report;
  const provenance = report?.result?.provenance;
  if (!report || !provenance) {
    fail(checks, 'task-report-binding', 'report product must include a report with result provenance');
    return;
  }
  if (bundle.task?.taskId !== report.taskId || bundle.task?.workerId !== provenance.workerKeyId || bundle.task?.resultHash !== provenance.resultHash) {
    fail(checks, 'task-report-binding', 'bundle.task must bind report.taskId and report.result.provenance worker/result hash');
    return;
  }
  pass(checks, 'task-report-binding');
}

function verifyArtifactManifest(bundle, hashes, checks) {
  const manifest = bundle?.artifactManifest;
  if (!isPlainObject(manifest) || manifest.schemaVersion !== AGENT_WORK_PROOF_ARTIFACT_MANIFEST_SCHEMA) {
    fail(checks, 'artifact-manifest-shape', `schemaVersion must be ${AGENT_WORK_PROOF_ARTIFACT_MANIFEST_SCHEMA}`);
    return undefined;
  }
  pass(checks, 'artifact-manifest-shape');

  if (manifest.sourceOnly !== true || manifest.noLive !== true || manifest.releasePublished !== false || manifest.registryWrite !== false || manifest.badgePublication !== false || manifest.liveBrokerDashboard !== false) {
    fail(checks, 'artifact-manifest-source-only', 'manifest must declare source-only/no-live and no live release/registry/badge/dashboard actions');
  } else {
    pass(checks, 'artifact-manifest-source-only');
  }

  const safety = manifest.publicSafety || {};
  const unsafe = PUBLIC_SAFETY_FIELDS.filter((field) => safety[field] !== false);
  if (unsafe.length > 0) fail(checks, 'artifact-manifest-public-safety', `publicSafety fields must be false: ${unsafe.join(', ')}`);
  else pass(checks, 'artifact-manifest-public-safety');

  const byId = new Map(Array.isArray(manifest.artifacts) ? manifest.artifacts.map((artifact) => [artifact?.id, artifact]) : []);
  const expectedHashes = {
    'verifiable-analysis-report-product': hashes.reportProductHash,
    'certification-battery-fixture': hashes.certificationBatteryHash,
    'completion-certificate': hashes.completionCertificateHash,
  };
  let artifactsOk = Array.isArray(manifest.artifacts) && manifest.artifacts.length === EXPECTED_ARTIFACTS.length;
  for (const id of EXPECTED_ARTIFACTS) {
    const artifact = byId.get(id);
    if (!artifact || artifact.contentHash !== expectedHashes[id]) artifactsOk = false;
  }
  if (artifactsOk) pass(checks, 'artifact-manifest-artifacts');
  else fail(checks, 'artifact-manifest-artifacts', 'manifest must list exactly the expected proof artifacts with matching hashes');

  const actualManifestHash = hashObject(manifest);
  if (bundle.artifactManifestHash === actualManifestHash) pass(checks, 'artifact-manifest-hash');
  else fail(checks, 'artifact-manifest-hash', 'artifactManifestHash must equal sha256:JCS(artifactManifest)');
  return actualManifestHash;
}

function verifyAssurance(bundle, checks) {
  const assurance = bundle?.assurance || {};
  const proves = Array.isArray(assurance.proves) ? assurance.proves : [];
  const doesNotProve = Array.isArray(assurance.doesNotProve) ? assurance.doesNotProve : [];
  const requiredProves = ['work-completion-evidence-bundled', 'subject-binding', 'offline-verification-path'];
  const requiredDisclaims = ['analytical-correctness', 'payment-authorized', 'legal-settlement', 'general-safety', 'llm-judgment-reproducibility'];
  const missing = [
    ...requiredProves.filter((item) => !proves.includes(item)).map((item) => `proves:${item}`),
    ...requiredDisclaims.filter((item) => !doesNotProve.includes(item)).map((item) => `doesNotProve:${item}`),
  ];
  if (missing.length > 0 || typeof assurance.disclaimer !== 'string' || assurance.disclaimer.trim() === '') {
    fail(checks, 'assurance-boundary', `missing assurance boundary entries: ${missing.join(', ') || 'disclaimer'}`);
  } else {
    pass(checks, 'assurance-boundary');
  }
}

function verifyExtractionReadiness(bundle, checks) {
  const readiness = bundle?.extractionReadiness || {};
  if (readiness.registryRequiredForValue !== false || readiness.badgeRequiredForValue !== false || readiness.decision !== 'defer-extraction-until-external-demand') {
    fail(checks, 'extraction-boundary', 'registry/badge must not be required and extraction must remain deferred until external demand');
  } else {
    pass(checks, 'extraction-boundary');
  }
}

export function verifyAgentWorkProofBundle(bundle, keyring, opts = {}) {
  const checks = [];
  verifyBundleShape(bundle, checks);

  const unsafe = unsafeStringFindings(bundle);
  if (unsafe.length > 0) fail(checks, 'public-safe-bundle', `unsafe string(s): ${unsafe.map((f) => `${f.id}@${f.path}`).join(', ')}`);
  else pass(checks, 'public-safe-bundle');

  const hashes = evidenceHashes(bundle);
  verifyEvidenceHashBindings(bundle, hashes, checks);
  verifyTaskMatchesReport(bundle, checks);

  const reportResult = verifyAnalysisReportProductPackage(bundle?.evidence?.reportProduct, keyring);
  if (reportResult.green) pass(checks, 'verifiable-analysis-report-product');
  else fail(checks, 'verifiable-analysis-report-product', `embedded report product failed: ${reportResult.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'unknown'}`);

  const batteryResult = verifyCertificationBatteryBundle(bundle?.evidence?.certificationBattery);
  if (batteryResult.ok) pass(checks, 'certification-battery');
  else fail(checks, 'certification-battery', `embedded certification battery failed: ${batteryResult.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'unknown'}`);

  const completionSubject = expectedCompletionSubject(bundle, hashes);
  const certificateResult = verifyCompletionCertificate(bundle?.evidence?.completionCertificate, keyring, { expectedSubject: completionSubject, now: opts.now });
  if (certificateResult.valid && certificateResult.decision === 'eligible') pass(checks, 'completion-certificate');
  else fail(checks, 'completion-certificate', `completion certificate must be valid, subject-bound, and eligible: ${certificateResult.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || `decision=${certificateResult.decision ?? 'absent'}`}`);

  const artifactManifestHash = verifyArtifactManifest(bundle, hashes, checks);
  const verdictSubject = expectedWorkProofSubject(bundle, hashes, artifactManifestHash);
  const verdictResult = verifyVerdict(bundle?.workProofVerdict, keyring, { expectedSubject: verdictSubject, now: opts.now });
  if (verdictResult.valid && verdictResult.kind === 'judgment' && verdictResult.decision === 'go') pass(checks, 'work-proof-verdict');
  else fail(checks, 'work-proof-verdict', `work proof verdict must be valid judgment decision=go and subject-bound: ${verdictResult.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || `decision=${verdictResult.decision ?? 'absent'}`}`);

  verifyAssurance(bundle, checks);
  verifyExtractionReadiness(bundle, checks);

  return {
    green: checks.every((check) => check.ok),
    checks,
    proofId: bundle?.proofId,
    taskId: bundle?.task?.taskId,
    evidenceHashes: hashes,
  };
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      keyring: { type: 'string' },
      json: { type: 'boolean', default: false },
      now: { type: 'string' },
    },
  });
  const bundlePath = positionals[0];
  if (!bundlePath || !values.keyring) {
    process.stderr.write('usage: verify-agent-work-proof.mjs <bundle.json> --keyring <keyring.json> [--now ISO] [--json]\n');
    return 2;
  }
  let bundle;
  let keyring;
  try {
    bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read bundle: ${err.message}\n`);
    return 2;
  }
  try {
    keyring = JSON.parse(fs.readFileSync(values.keyring, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read keyring: ${err.message}\n`);
    return 2;
  }
  const result = verifyAgentWorkProofBundle(bundle, keyring, { now: values.now });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}${check.detail ? ` — ${check.detail}` : ''}\n`);
    }
    process.stdout.write(`\n${result.green ? 'GREEN — agent work proof bundle verified' : 'RED — agent work proof verification failed (fail-closed)'}\n`);
  }
  return result.green ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

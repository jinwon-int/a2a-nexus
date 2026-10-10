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
import { verifyAnalysisReportProductPackage } from './verify-analysis-report.mjs';
import { verifyVerdict } from './verify-finalizer-verdict.mjs';
import {
  fail,
  hashObject,
  isPlainObject,
  isSha256,
  pass,
  runVerifierCli,
  unsafeStringFindings,
} from './lib/a2a-offline-verify.mjs';
import { verifyCertificationBatteryBundle } from './lib/certification-battery-verifier.mjs';
import { verifyCompletionCertificate } from './lib/completion-certificate-verifier.mjs';

export const AGENT_WORK_PROOF_SCHEMA = 'a2a.agent-work-proof.bundle.v0';
export const AGENT_WORK_PROOF_ARTIFACT_MANIFEST_SCHEMA = 'a2a.agent-work-proof.artifactManifest.v0';
export const CANONICALIZATION = 'rfc8785-jcs-v1';

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
  return runVerifierCli(argv, {
    usage: 'usage: verify-agent-work-proof.mjs <bundle.json> --keyring <keyring.json> [--now ISO] [--json]',
    inputLabel: 'bundle',
    verify: verifyAgentWorkProofBundle,
    summary: (result) => (result.green ? 'GREEN — agent work proof bundle verified' : 'RED — agent work proof verification failed (fail-closed)'),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

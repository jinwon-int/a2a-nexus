import { canonicalizeJson, sha256Prefix } from './a2a-offline-verify.mjs';

export const BATTERY_PACK_SCHEMA = 'a2a.certification-battery.pack.v0';
export const BATTERY_RESULT_SCHEMA = 'a2a.certification-battery.result.v0';
export const BATTERY_FIXTURE_SCHEMA = 'a2a.certification-battery.fixture.v0';
export const FINALIZER_VERDICT_SCHEMA = 'a2a.finalizer.verdict.v1';
export const PRODUCT_ARTIFACT_CERTIFICATE_SCHEMA = 'a2a.product-artifact.certificate.v0';
export const CANONICALIZATION = 'rfc8785-jcs-v1';

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const RESULT_STATUSES = new Set(['pass', 'fail', 'skip']);
const CLAIM_STATUSES = new Set(['pass', 'fail', 'missing', 'not-evaluated']);
const CLAIM_KINDS = new Set([
  'dependency-provenance',
  'secret-scan',
  'capability-boundary',
  'egress-boundary',
  'reproducible-build',
  'independent-review',
]);
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
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function pass(checks, id) {
  checks.push({ id, ok: true });
}

function fail(checks, id, detail) {
  checks.push({ id, ok: false, detail });
}

function subjectHasImmutableBinding(subject) {
  return Boolean(
    subject
    && (COMMIT_RE.test(subject.commitSha || '')
      || (Array.isArray(subject.artifactHashes) && subject.artifactHashes.some(isSha256))),
  );
}

function sameJcs(a, b) {
  try {
    return canonicalizeJson(a) === canonicalizeJson(b);
  } catch {
    return false;
  }
}

function hashObject(value) {
  return sha256Prefix(canonicalizeJson(value));
}

function hashResultSansSelf(result) {
  const { resultHash: _omit, ...unsigned } = result;
  return hashObject(unsigned);
}

function hashVerdictSansSignature(verdict) {
  const { sig: _omit, ...unsigned } = verdict;
  return hashObject(unsigned);
}

function assertTextPublicSafe(checks, text) {
  for (const forbidden of FORBIDDEN_RUNTIME_STRINGS) {
    if (text.includes(forbidden)) fail(checks, 'public-safe-text', `forbidden runtime/private path marker: ${forbidden}`);
  }
  for (const pattern of SECRET_LIKE_PATTERNS) {
    if (pattern.test(text)) fail(checks, 'public-safe-text', `matched forbidden secret-like pattern ${pattern}`);
  }
  if (!checks.some((check) => check.id === 'public-safe-text' && !check.ok)) pass(checks, 'public-safe-text');
}

function verifySafety(bundle, checks) {
  if (bundle?.meta?.schemaVersion !== BATTERY_FIXTURE_SCHEMA) fail(checks, 'fixture-meta', 'schemaVersion mismatch');
  else if (bundle.meta.sourceOnly !== true || bundle.meta.noLive !== true) fail(checks, 'fixture-meta', 'sourceOnly/noLive must be true');
  else pass(checks, 'fixture-meta');

  const safety = bundle?.safety || {};
  const unsafe = Object.entries(safety).filter(([, value]) => value !== false).map(([key]) => key);
  if (unsafe.length) fail(checks, 'safety-flags', `unsafe flags must be false: ${unsafe.join(', ')}`);
  else pass(checks, 'safety-flags');
}

function verifyPack(pack, checks) {
  if (!isPlainObject(pack)) return fail(checks, 'pack-shape', 'batteryPack must be object');
  if (pack.schemaVersion !== BATTERY_PACK_SCHEMA) return fail(checks, 'pack-shape', 'schemaVersion mismatch');
  if (pack.canonicalization !== CANONICALIZATION) return fail(checks, 'pack-shape', 'canonicalization mismatch');
  if (!pack.batteryId || !pack.batteryVersion || !pack.subjectProfile) return fail(checks, 'pack-shape', 'battery identity missing');
  if (pack.deterministic !== true) return fail(checks, 'pack-shape', 'deterministic must be true');
  if (pack.registryRequired !== false || pack.badgeRequired !== false) return fail(checks, 'pack-shape', 'registry/badge must not be required for v0 value');
  if (!subjectHasImmutableBinding(pack.target)) return fail(checks, 'pack-shape', 'target lacks immutable binding');
  if (!Array.isArray(pack.checks) || pack.checks.length === 0) return fail(checks, 'pack-shape', 'checks required');
  const ids = new Set();
  for (const check of pack.checks) {
    if (!check?.id || ids.has(check.id)) return fail(checks, 'pack-checks', 'check ids must be present and unique');
    ids.add(check.id);
    if (check.expected !== 'pass') return fail(checks, 'pack-checks', `${check.id} expected must be pass`);
    if (check.reproducible !== true || check.noLive !== true) return fail(checks, 'pack-checks', `${check.id} must be reproducible and noLive`);
    if (!Array.isArray(check.inputRefs) || check.inputRefs.length === 0) return fail(checks, 'pack-checks', `${check.id} inputRefs required`);
  }
  if (pack.attestationIntegration?.posture !== 'reuse-existing-attestation-infra; do-not-reimplement') {
    return fail(checks, 'attestation-boundary', 'must reuse, not reimplement, commodity attestation infra');
  }
  pass(checks, 'pack-shape');
  pass(checks, 'pack-checks');
  pass(checks, 'attestation-boundary');
}

function verifyResult(pack, result, checks) {
  if (!isPlainObject(result)) return fail(checks, 'result-shape', 'batteryResult must be object');
  if (result.schemaVersion !== BATTERY_RESULT_SCHEMA) return fail(checks, 'result-shape', 'schemaVersion mismatch');
  if (result.canonicalization !== CANONICALIZATION) return fail(checks, 'result-shape', 'canonicalization mismatch');
  if (result.packRef?.batteryId !== pack.batteryId || result.packRef?.batteryVersion !== pack.batteryVersion) {
    return fail(checks, 'result-pack-binding', 'packRef id/version mismatch');
  }
  const packHash = hashObject(pack);
  if (result.packRef.packHash !== packHash) return fail(checks, 'result-pack-binding', `packHash mismatch: expected ${packHash}`);
  if (!sameJcs(result.subject, pack.target)) return fail(checks, 'result-subject-binding', 'result subject must equal pack target');
  if (result.run?.liveNetwork !== false || result.run?.providerSend !== false || result.run?.registryWrite !== false) {
    return fail(checks, 'result-no-live', 'run liveNetwork/providerSend/registryWrite must be false');
  }
  if (!Array.isArray(result.checkResults)) return fail(checks, 'result-checks', 'checkResults required');
  const expectedIds = new Set(pack.checks.map((check) => check.id));
  const byId = new Map();
  for (const entry of result.checkResults) {
    if (!entry?.id || !expectedIds.has(entry.id)) return fail(checks, 'result-checks', `unexpected result id ${entry?.id ?? '<missing>'}`);
    if (byId.has(entry.id)) return fail(checks, 'result-checks', `duplicate result for ${entry.id}`);
    byId.set(entry.id, entry);
  }
  if (byId.size !== pack.checks.length) return fail(checks, 'result-checks', 'result count must exactly match pack checks');
  for (const check of pack.checks) {
    const got = byId.get(check.id);
    if (!got) return fail(checks, 'result-checks', `missing result for ${check.id}`);
    if (!RESULT_STATUSES.has(got.status) || got.status !== 'pass') return fail(checks, 'result-checks', `${check.id} must pass`);
    if (!isSha256(got.outputHash)) return fail(checks, 'result-checks', `${check.id} outputHash must be sha256`);
  }
  if (result.decision !== 'pass') return fail(checks, 'result-decision', 'decision must be pass when all checks pass');
  const expectedResultHash = hashResultSansSelf(result);
  if (result.resultHash !== expectedResultHash) return fail(checks, 'result-hash', `resultHash mismatch: expected ${expectedResultHash}`);
  pass(checks, 'result-pack-binding');
  pass(checks, 'result-subject-binding');
  pass(checks, 'result-no-live');
  pass(checks, 'result-checks');
  pass(checks, 'result-decision');
  pass(checks, 'result-hash');
}

function verifyVerdict(pack, result, verdict, judgment, checks) {
  if (verdict?.schemaVersion !== FINALIZER_VERDICT_SCHEMA || verdict.canonicalization !== CANONICALIZATION) return fail(checks, 'battery-verdict-shape', 'schema/canonicalization mismatch');
  if (verdict.kind !== 'battery') return fail(checks, 'battery-verdict-kind', 'battery verdict kind required');
  if (verdict.decision !== 'go') return fail(checks, 'battery-verdict-decision', 'decision must be go for passing battery');
  const subject = verdict.subject || {};
  if (subject.kind !== 'battery-result' || subject.batteryId !== pack.batteryId || subject.batteryVersion !== pack.batteryVersion || subject.resultHash !== result.resultHash) {
    return fail(checks, 'battery-verdict-subject-binding', 'verdict subject must bind battery result');
  }
  const proves = verdict.assurance?.proves || [];
  const doesNotProve = verdict.assurance?.doesNotProve || [];
  if (!proves.includes('reproducibility')) return fail(checks, 'battery-vs-judgment-boundary', 'battery verdict must prove reproducibility');
  if (doesNotProve.includes('reproducibility')) return fail(checks, 'battery-vs-judgment-boundary', 'battery verdict must not disclaim reproducibility');
  if (!doesNotProve.includes('analytical-correctness') || !doesNotProve.includes('general-safety')) {
    return fail(checks, 'battery-assurance-boundary', 'battery verdict must disclaim analytical correctness and general safety');
  }
  if (judgment?.kind !== 'judgment' || !judgment.assurance?.doesNotProve?.includes('reproducibility')) {
    return fail(checks, 'battery-vs-judgment-boundary', 'judgment example must explicitly disclaim reproducibility');
  }
  pass(checks, 'battery-verdict-shape');
  pass(checks, 'battery-verdict-kind');
  pass(checks, 'battery-verdict-decision');
  pass(checks, 'battery-verdict-subject-binding');
  pass(checks, 'battery-vs-judgment-boundary');
  pass(checks, 'battery-assurance-boundary');
}

function verifyCertificate(pack, result, verdict, certificate, checks) {
  if (certificate?.schemaVersion !== PRODUCT_ARTIFACT_CERTIFICATE_SCHEMA || certificate.canonicalization !== CANONICALIZATION) {
    return fail(checks, 'certificate-shape', 'product certificate schema/canonicalization mismatch');
  }
  if (!sameJcs(certificate.subject, pack.target)) return fail(checks, 'certificate-subject-binding', 'certificate subject must equal battery target');
  if (certificate.batteryVersion !== pack.batteryVersion) return fail(checks, 'certificate-battery-version', 'certificate batteryVersion mismatch');
  if (certificate.decision !== 'certified') return fail(checks, 'certificate-decision', 'sample certificate must be certified');
  if (!Array.isArray(certificate.claims) || certificate.claims.length === 0) return fail(checks, 'certificate-claims', 'claims required');
  const verdictRef = `battery-verdict:${hashVerdictSansSignature(verdict)}`;
  const resultRef = `battery-result:${result.resultHash}`;
  let sawVerdictRef = false;
  let sawResultRef = false;
  for (const claim of certificate.claims) {
    if (!CLAIM_KINDS.has(claim.kind)) return fail(checks, 'certificate-claims', `unknown claim kind ${claim.kind}`);
    if (!CLAIM_STATUSES.has(claim.status) || claim.status !== 'pass') return fail(checks, 'certificate-claims', `claim ${claim.id} must pass`);
    if (claim.evidenceRef === verdictRef) sawVerdictRef = true;
    if (claim.evidenceRef === resultRef) sawResultRef = true;
  }
  if (!sawVerdictRef || !sawResultRef) return fail(checks, 'certificate-claims', 'certificate must cite both battery verdict and result');
  const doesNotProve = certificate.assurance?.doesNotProve || [];
  for (const required of ['general-safety', 'bug-free', 'legal-compliance', 'marketplace-approval']) {
    if (!doesNotProve.includes(required)) return fail(checks, 'certificate-assurance-boundary', `missing ${required}`);
  }
  pass(checks, 'certificate-shape');
  pass(checks, 'certificate-subject-binding');
  pass(checks, 'certificate-battery-version');
  pass(checks, 'certificate-decision');
  pass(checks, 'certificate-claims');
  pass(checks, 'certificate-assurance-boundary');
}

function verifyExtractionReadiness(readiness, checks) {
  if (readiness?.registryRequiredForValue !== false || readiness?.badgeRequiredForValue !== false) {
    return fail(checks, 'value-without-registry', 'registry/badge must not be required for value');
  }
  if (!Array.isArray(readiness.valueWithoutRegistry) || readiness.valueWithoutRegistry.length < 2) {
    return fail(checks, 'value-without-registry', 'valueWithoutRegistry must explain standalone value');
  }
  if (!Array.isArray(readiness.externalDemandSignals) || readiness.externalDemandSignals.length === 0) {
    return fail(checks, 'external-demand-ledger', 'externalDemandSignals ledger entry required');
  }
  const hasExternal = readiness.externalDemandSignals.some((signal) => signal.kind !== 'operator-roadmap' && signal.status === 'observed');
  if (hasExternal && readiness.decision !== 'extraction-ready') return fail(checks, 'external-demand-ledger', 'observed external signal should move decision to extraction-ready');
  if (!hasExternal && readiness.decision !== 'defer-extraction-until-external-demand') {
    return fail(checks, 'external-demand-ledger', 'without external signal, extraction must remain deferred');
  }
  pass(checks, 'value-without-registry');
  pass(checks, 'external-demand-ledger');
}

export function verifyCertificationBatteryBundle(bundle, opts = {}) {
  const checks = [];
  const text = opts.fixtureText ?? canonicalizeJson(bundle);
  assertTextPublicSafe(checks, text);
  verifySafety(bundle, checks);
  verifyPack(bundle?.batteryPack, checks);
  if (isPlainObject(bundle?.batteryPack)) verifyResult(bundle.batteryPack, bundle?.batteryResult, checks);
  if (isPlainObject(bundle?.batteryPack) && isPlainObject(bundle?.batteryResult)) {
    verifyVerdict(bundle.batteryPack, bundle.batteryResult, bundle?.batteryVerdict, bundle?.judgmentBoundaryExample, checks);
    verifyCertificate(bundle.batteryPack, bundle.batteryResult, bundle?.batteryVerdict, bundle?.productArtifactCertificateSample, checks);
  }
  verifyExtractionReadiness(bundle?.extractionReadiness, checks);
  return {
    ok: checks.every((check) => check.ok),
    checks,
    batteryId: bundle?.batteryPack?.batteryId,
    batteryVersion: bundle?.batteryPack?.batteryVersion,
    resultHash: bundle?.batteryResult?.resultHash,
  };
}

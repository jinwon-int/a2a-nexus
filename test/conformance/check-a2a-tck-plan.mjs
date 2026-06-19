#!/usr/bin/env node
/**
 * A2A TCK and v0→v1 compatibility plan conformance check (#916).
 *
 * Safety: read-only validation of the TCK spec, machine-readable
 * compatibility fixture, and existing external-harness fixture reference.
 * No live broker, provider, terminal ACK, deploy, restart, DB access, or
 * secret exposure.
 *
 * Strict-TDD contract: this file is the executable TCK gate for the
 * acceptance criteria of issue #916 inside PR scope. It fails closed if
 * the spec, fixture, fixture-validator/TCK-gate mapping, or external
 * harness reference are missing or inconsistent.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();

const specRel = 'contracts/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.md';
const fixtureRel =
  'fixtures/compatibility/a2a-tck-and-v0-to-v1-compatibility-plan.json';
const externalHarnessFixtureRel = 'fixtures/external-harness/no-live-conformance.json';
const contractsA2aReadmeRel = 'contracts/a2a/README.md';
const compatibilityReadmeRel = 'contracts/compatibility/README.md';

const forbiddenRuntimePaths = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  '.openclaw/',
];

const secretLikePatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

function readRel(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function parseJson(rel) {
  const text = readRel(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectText(value, acc) {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectText(item, acc);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectText(item, acc);
  }
}

// ── 1. Spec presence + structural markers ──────────────────────────────────

const spec = readRel(specRel);
assert(spec !== null, `missing TCK plan spec at ${specRel}`);

// Top-level title and freeze markers
assert(/# A2A TCK and v0→v1 compatibility plan/i.test(spec), 'spec: missing top-level title');
assert(/\bv0 Freeze\b/.test(spec), 'spec: missing v0 freeze marker');
assert(/#916/.test(spec), 'spec: must reference issue #916');
assert(/#922/.test(spec), 'spec: must reference wave tracker #922');

// Required TCK sections
const requiredSections = [
  { name: 'purpose', pattern: /## Purpose/i },
  { name: 'scope', pattern: /## Scope/i },
  { name: 'tck categories', pattern: /## TCK categories/i },
  { name: 'v0→v1 rules', pattern: /## v0→v1 compatibility rules/i },
  { name: 'additive', pattern: /### Additive changes/i },
  { name: 'deprecation', pattern: /### Deprecations/i },
  { name: 'schema versioning', pattern: /### Schema versioning/i },
  { name: 'worker capability', pattern: /### Worker capability evolution/i },
  { name: 'terminal evidence', pattern: /### Terminal evidence semantics/i },
  { name: 'fixture vs gate', pattern: /## Fixture validators vs TCK gates/i },
  { name: 'external harness', pattern: /## External harness fixture/i },
  { name: 'contract citation', pattern: /## Contract section citation/i },
  { name: 'safety', pattern: /## Safety boundary/i },
];
for (const section of requiredSections) {
  assert(section.pattern.test(spec), `spec: missing required section ${section.name}`);
}

// v0→v1 rule invariants — each rule must have at least one explicit allowed/disallowed statement
assert(/additive only/i.test(spec), 'spec: additive rule missing "additive only" wording');
assert(/deprecat/i.test(spec), 'spec: deprecation rule missing "deprecat" wording');
assert(/major version bump/i.test(spec) || /breaking change/i.test(spec), 'spec: schema versioning rule missing breaking-change gate');
assert(/freshnessTimestamp/i.test(spec) || /freshness/i.test(spec), 'spec: worker capability rule must cite freshness handling');
assert(/non-ACK/i.test(spec), 'spec: terminal evidence rule must keep non-ACK boundary');
assert(/fixture validator/i.test(spec), 'spec: must classify fixture validators');
assert(/TCK gate/i.test(spec), 'spec: must classify TCK gates');
assert(/no-live/i.test(spec), 'spec: external harness section must require no-live mode');
assert(/loopback|127\.0\.0\.1/i.test(spec), 'spec: external harness must require loopback URLs');
assert(/contract section id/i.test(spec) || /contract section id/i.test(spec.toLowerCase()), 'spec: contract section citation section missing');
assert(/non-blocking|optional/i.test(spec), 'spec: contract section citation must be non-blocking for small tasks');

// Forbidden runtime / secret leakage
for (const forbidden of forbiddenRuntimePaths) {
  assert(
    !spec.includes(forbidden),
    `spec must not reference OpenClaw runtime/bootstrap path ${forbidden}`,
  );
}
for (const pattern of secretLikePatterns) {
  assert(!pattern.test(spec), `spec matched forbidden pattern ${pattern}`);
}

// ── 2. Machine-readable compatibility fixture ───────────────────────────────

const fixture = parseJson(fixtureRel);
assert(fixture !== null, `missing or invalid JSON at ${fixtureRel}`);
assert(
  fixture.fixtureId === 'a2a-nexus.compatibility.tck-and-v0-to-v1-plan.v1',
  `fixture: invalid fixtureId (got ${fixture.fixtureId})`,
);
assert(fixture.contract === specRel, 'fixture: contract must point at the spec path');
assert(fixture.issue === 916, 'fixture: must reference issue 916');
assert(fixture.waveIssue === 922, 'fixture: must reference wave issue 922');
assert(fixture.v0Freeze?.frozenAt === '2026-05-09', 'fixture: v0Freeze.frozenAt must match contract v0 freeze date');
assert(Array.isArray(fixture.tckCategories), 'fixture: tckCategories must be an array');
assert(fixture.tckCategories.length >= 4, 'fixture: must declare at least 4 TCK categories');
for (const category of fixture.tckCategories) {
  assert(typeof category.id === 'string' && category.id.length > 0, 'fixture: category.id required');
  assert(typeof category.title === 'string' && category.title.length > 0, 'fixture: category.title required');
  assert(Array.isArray(category.frozenContracts), 'fixture: category.frozenContracts must be an array');
  assert(category.frozenContracts.length > 0, `fixture: category ${category.id} must list at least one frozen contract`);
  assert(typeof category.gateType === 'string', `fixture: category ${category.id} gateType required`);
  assert(['fixture-validator', 'tck-gate'].includes(category.gateType),
    `fixture: category ${category.id} gateType must be fixture-validator or tck-gate (got ${category.gateType})`);
  assert(typeof category.checkCommand === 'string' && category.checkCommand.length > 0,
    `fixture: category ${category.id} checkCommand required`);
}

assert(Array.isArray(fixture.v0ToV1Rules), 'fixture: v0ToV1Rules must be an array');
const ruleIds = new Set(fixture.v0ToV1Rules.map((r) => r.id));
for (const required of ['additive', 'deprecation', 'schema-versioning', 'worker-capability', 'terminal-evidence']) {
  assert(ruleIds.has(required), `fixture: v0→v1 rule ${required} missing`);
}
for (const rule of fixture.v0ToV1Rules) {
  assert(typeof rule.id === 'string', 'fixture: rule.id required');
  assert(typeof rule.title === 'string', `fixture: rule ${rule.id} title required`);
  assert(typeof rule.policy === 'string' && rule.policy.length > 0,
    `fixture: rule ${rule.id} policy required`);
  assert(Array.isArray(rule.evidenceContracts) || typeof rule.evidenceContract === 'string',
    `fixture: rule ${rule.id} must list evidence contract(s)`);
}

// Gate mapping
assert(Array.isArray(fixture.gateMapping), 'fixture: gateMapping must be an array');
assert(fixture.gateMapping.length >= 1, 'fixture: gateMapping must list at least one entry');
const gateKinds = new Set(fixture.gateMapping.map((g) => g.kind));
assert(gateKinds.has('fixture-validator'), 'fixture: gateMapping must include fixture-validator kind');
assert(gateKinds.has('tck-gate'), 'fixture: gateMapping must include tck-gate kind');
for (const entry of fixture.gateMapping) {
  assert(typeof entry.checkCommand === 'string' && entry.checkCommand.length > 0,
    'fixture: gateMapping entry checkCommand required');
  assert(['fixture-validator', 'tck-gate'].includes(entry.kind),
    `fixture: gateMapping kind must be fixture-validator or tck-gate (got ${entry.kind})`);
  assert(typeof entry.note === 'string' && entry.note.length > 0,
    'fixture: gateMapping entry note required');
}

// Safety envelope
const safety = fixture.safety || {};
for (const key of [
  'liveProviderSend',
  'terminalAckReplay',
  'gatewayRestart',
  'brokerRestart',
  'databaseMutation',
  'releaseOrPublish',
  'secretMovement',
]) {
  assert(safety[key] === false, `fixture: safety.${key} must be false (got ${safety[key]})`);
}

// Forbidden runtime / secret leakage in fixture
const fixtureText = fs.readFileSync(path.join(root, fixtureRel), 'utf8');
const fixtureStrings = [];
collectText(fixture, fixtureStrings);
const fixtureJoined = fixtureStrings.join('\n') + '\n' + fixtureText;
for (const forbidden of forbiddenRuntimePaths) {
  assert(
    !fixtureJoined.includes(forbidden),
    `fixture must not reference OpenClaw runtime/bootstrap path ${forbidden}`,
  );
}
for (const pattern of secretLikePatterns) {
  assert(!pattern.test(fixtureJoined), `fixture matched forbidden pattern ${pattern}`);
}

// ── 3. External harness fixture reference ───────────────────────────────────

const externalHarness = parseJson(externalHarnessFixtureRel);
assert(externalHarness !== null, `missing or invalid JSON at ${externalHarnessFixtureRel}`);
assert(
  externalHarness.schema === 'a2a.externalHarness.noLiveConformance.v1',
  'external harness fixture: schema must be a2a.externalHarness.noLiveConformance.v1',
);
assert(externalHarness.mode === 'no-live', 'external harness fixture: mode must be no-live');
assert(externalHarness.harness?.usesOpenClawCli === false, 'external harness fixture: must not require OpenClaw CLI');
assert(externalHarness.broker?.baseUrl === 'http://127.0.0.1:8787', 'external harness fixture: broker URL must be loopback');
assert(externalHarness.broker?.production === false, 'external harness fixture: production must be false');
for (const [key, value] of Object.entries(externalHarness.safety || {})) {
  assert(value === false, `external harness fixture: safety.${key} must be false`);
}

// Spec must reference the existing external harness fixture
assert(
  spec.includes('fixtures/external-harness/no-live-conformance.json'),
  'spec: must reference fixtures/external-harness/no-live-conformance.json',
);
assert(
  spec.includes(externalHarnessFixtureRel),
  `spec: must reference ${externalHarnessFixtureRel}`,
);
assert(
  /external[ -_]?harness/i.test(spec),
  'spec: must use the "external harness" phrase',
);

// ── 4. Cross-link from contract READMEs ─────────────────────────────────────

const contractsA2aReadme = readRel(contractsA2aReadmeRel);
assert(contractsA2aReadme !== null, `missing ${contractsA2aReadmeRel}`);
assert(
  contractsA2aReadme.includes('a2a-tck-and-v0-to-v1-compatibility-plan.md'),
  `${contractsA2aReadmeRel}: must link the TCK plan spec`,
);

const compatibilityReadme = readRel(compatibilityReadmeRel);
assert(compatibilityReadme !== null, `missing ${compatibilityReadmeRel}`);
assert(
  compatibilityReadme.includes('a2a-tck-and-v0-to-v1-compatibility-plan.md'),
  `${compatibilityReadmeRel}: must link the TCK plan spec`,
);

console.log('a2a tck plan conformance ok: spec, fixture, gate mapping, and external harness reference validated');

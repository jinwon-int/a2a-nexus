#!/usr/bin/env node
/**
 * Validate the #547 release/package/tag approval packet.
 *
 * Safety: source-only fixture/doc validation. No tag, GitHub Release, npm,
 * Docker/GHCR, package ownership, canonical flip, split repo disposition,
 * deploy, restart, credential, DB, provider send, or Terminal ACK action is
 * performed here.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function readRel(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

function parseJson(rel) {
  const text = readRel(rel);
  if (text === null) {
    fail(`missing ${rel}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${rel}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const fixture = parseJson('fixtures/current-state/monorepo-release-package-tag-approval-packet.json');
const doc = readRel('docs/monorepo-release-package-tag-approval-packet.md');
const currentState = readRel('docs/current-state.md');
const releasePolicy = readRel('docs/release/monorepo-branch-release-package-policy.md');
const splitDisposition = readRel('docs/monorepo-split-repo-disposition-rollback.md');
const readiness = readRel('docs/monorepo-canonical-flip-readiness.md');
const pkg = parseJson('package.json');
const brokerPkg = parseJson('packages/broker/package.json');
const runnerPkg = parseJson('packages/docker-runner/package.json');
const pluginPkg = parseJson('packages/openclaw-plugin-a2a/package.json');
const releaseGate = readRel('scripts/release-gate.mjs') || '';

expect(doc !== null, 'missing docs/monorepo-release-package-tag-approval-packet.md');

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-release-package-tag-approval-packet.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parent issue must be #511');
  expect(fixture.phase7DispositionPr === 'https://github.com/jinwon-int/a2a-plane/pull/546', 'fixture: phase7 PR must be #546');
  expect(fixture.phase8ReleasePacketIssue === 'https://github.com/jinwon-int/a2a-plane/issues/547', 'fixture: phase8 issue must be #547');
  expect(fixture.phase7MergeCommit === '03cb496a145c130186f6d08a3fd9fd12dc04ef31', 'fixture: #546 merge commit mismatch');
  expect(fixture.historicalTagPreserved === 'source-public-20260511', 'fixture: historical tag must be preserved');
  for (const key of [
    'releaseTagDecision',
    'githubReleaseDecision',
    'npmPublishDecision',
    'dockerPublishDecision',
    'packageOwnershipDecision',
    'canonicalFlipDecision',
  ]) {
    expect(fixture[key] === 'NO_GO_WAITING', `fixture: ${key} must be NO_GO_WAITING`);
  }

  const expected = new Map([
    [
      'broker',
      {
        path: 'packages/broker',
        packageName: brokerPkg?.name,
        version: brokerPkg?.version,
        private: brokerPkg?.private,
        binNames: [],
        dryRunCommand: 'npm --workspace packages/broker run build',
      },
    ],
    [
      'docker-runner',
      {
        path: 'packages/docker-runner',
        packageName: runnerPkg?.name,
        version: runnerPkg?.version,
        private: runnerPkg?.private,
        binNames: Object.keys(runnerPkg?.bin || {}),
        dryRunCommand: 'npm --workspace packages/docker-runner run verify:package',
      },
    ],
    [
      'openclaw-plugin-a2a',
      {
        path: 'packages/openclaw-plugin-a2a',
        packageName: pluginPkg?.name,
        version: pluginPkg?.version,
        private: pluginPkg?.private,
        binNames: Object.keys(pluginPkg?.bin || {}).sort(),
        dryRunCommand: 'npm --workspace packages/openclaw-plugin-a2a run prepack',
      },
    ],
  ]);
  const packages = new Map((fixture.candidatePackages || []).map((entry) => [entry.surface, entry]));
  expect(packages.size === expected.size, 'fixture: must contain exactly three package surfaces');
  for (const [surface, expectedEntry] of expected) {
    const entry = packages.get(surface);
    expect(Boolean(entry), `fixture: missing package surface ${surface}`);
    if (!entry) continue;
    expect(entry.path === expectedEntry.path, `fixture: ${surface} path mismatch`);
    expect(entry.packageName === expectedEntry.packageName, `fixture: ${surface} package name mismatch`);
    expect(entry.version === expectedEntry.version, `fixture: ${surface} version mismatch`);
    expect(entry.private === expectedEntry.private, `fixture: ${surface} private flag mismatch`);
    expect(entry.dryRunCommand === expectedEntry.dryRunCommand, `fixture: ${surface} dry-run command mismatch`);
    const entryBins = [...(entry.binNames || [])].sort();
    expect(JSON.stringify(entryBins) === JSON.stringify(expectedEntry.binNames), `fixture: ${surface} bin names mismatch`);
  }
  const brokerEntry = packages.get('broker');
  expect((brokerEntry?.dockerAssets || []).includes('packages/broker/Dockerfile'), 'fixture: broker Dockerfile missing');
  expect((brokerEntry?.dockerAssets || []).includes('packages/broker/docker-compose.yml'), 'fixture: broker docker-compose missing');

  for (const [key, value] of Object.entries(fixture.approvalFields || {})) {
    expect(value === 'unassigned', `fixture: approvalFields.${key} must be unassigned`);
  }

  const goNoGo = fixture.goNoGoFields || {};
  for (const trueField of ['packageInventoryRecorded', 'approvalFieldsRecorded', 'dryRunCommandsRecorded']) {
    expect(goNoGo[trueField] === true, `fixture: go/no-go ${trueField} must be true`);
  }
  for (const falseField of [
    'tagApproved',
    'githubReleaseApproved',
    'npmPublishApproved',
    'dockerPublishApproved',
    'packageOwnershipTransferApproved',
    'rollbackOwnerAssigned',
    'canonicalFlipApproved',
  ]) {
    expect(goNoGo[falseField] === false, `fixture: go/no-go ${falseField} must be false`);
  }
  expect(goNoGo.decision === 'NO_GO_WAITING', 'fixture: go/no-go decision must be NO_GO_WAITING');

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'a2a-plane#547',
    'NO_GO / Waiting',
    'Candidate Package And Artifact Inventory',
    'Approval Fields',
    'source-public-20260511',
    'Docker/GHCR',
    'package ownership',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  for (const packageName of ['a2a-broker', '@openclaw/a2a-docker-runner', 'plugin-a2a']) {
    expect(doc.includes(packageName), `doc: missing package ${packageName}`);
  }
}

for (const [name, text] of [
  ['current-state doc', currentState],
  ['release policy doc', releasePolicy],
  ['split disposition doc', splitDisposition],
  ['canonical readiness doc', readiness],
]) {
  expect(text !== null, `${name}: missing`);
  expect(/a2a-plane#547/.test(text || ''), `${name}: must reference #547`);
  expect(/release\/package\/tag|release package tag|tag\/release|release tags/i.test(text || ''), `${name}: must reference release/package/tag`);
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-release-package-tag-approval'] === 'node scripts/check-monorepo-release-package-tag-approval-packet.mjs',
    'package.json: missing check:monorepo-release-package-tag-approval script'
  );
}
expect(/monorepo-release-package-tag-approval/.test(releaseGate), 'release gate must include release/package/tag approval check');

if (failures.length) {
  console.error(`monorepo release/package/tag approval validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo release/package/tag approval packet ok');

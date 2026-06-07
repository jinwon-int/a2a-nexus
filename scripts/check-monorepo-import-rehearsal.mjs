#!/usr/bin/env node
/**
 * Validate the #513 monorepo import rehearsal packet.
 *
 * Safety: source-only fixture/doc validation. No import, history rewrite,
 * release, publish, visibility, live dispatch, restart, credential, DB, or
 * Terminal ACK action is performed here.
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

const fixturePath = 'fixtures/current-state/monorepo-import-rehearsal.json';
const docPath = 'docs/monorepo-import-rehearsal.md';
const reentryDocPath = 'docs/monorepo-reentry-decision.md';
const packagePath = 'package.json';

const fixture = parseJson(fixturePath);
const doc = readRel(docPath);
const reentryDoc = readRel(reentryDocPath);
const pkg = parseJson(packagePath);

expect(doc !== null, `missing ${docPath}`);
expect(reentryDoc !== null, `missing ${reentryDocPath}`);

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-import-rehearsal.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parentIssue must be #511');
  expect(fixture.childIssue === 'https://github.com/jinwon-int/a2a-plane/issues/513', 'fixture: childIssue must be #513');
  expect(fixture.decision === 'plan_import_rehearsal_before_canonical_flip', 'fixture: decision must require rehearsal before flip');
  expect(fixture.canonicalDuringRehearsal === 'split_repos', 'fixture: split repos must remain canonical');
  expect(fixture.rehearsalWorkspace?.additiveOnly === true, 'fixture: rehearsal workspace must be additive only');
  expect(fixture.rehearsalWorkspace?.reuseExistingA2aMonorepoCheckout === false, 'fixture: must not reuse existing a2a-monorepo checkout');
  expect(fixture.rehearsalWorkspace?.disposableUntilParityPasses === true, 'fixture: rehearsal workspace must stay disposable');

  const mirrors = new Map((fixture.mirrors || []).map((mirror) => [mirror.surface, mirror]));
  for (const [surface, sourceRepo, targetPath] of [
    ['broker', 'jinwon-int/a2a-broker', 'packages/broker'],
    ['docker-runner', 'jinwon-int/a2a-docker-runner', 'packages/docker-runner'],
    ['openclaw-plugin-a2a', 'jinwon-int/openclaw-plugin-a2a', 'packages/openclaw-plugin-a2a'],
  ]) {
    const mirror = mirrors.get(surface);
    expect(Boolean(mirror), `fixture: missing mirror ${surface}`);
    if (!mirror) continue;
    expect(mirror.sourceRepo === sourceRepo, `fixture: ${surface} sourceRepo mismatch`);
    expect(mirror.targetPath === targetPath, `fixture: ${surface} targetPath mismatch`);
    expect(mirror.freshness === 'stale', `fixture: ${surface} must be marked stale until rehearsal`);
    expect(mirror.canonicalNow === 'split_repo', `fixture: ${surface} canonicalNow must be split_repo`);
    expect(Number.isInteger(mirror.splitTrackedFiles) && mirror.splitTrackedFiles > 0, `fixture: ${surface} splitTrackedFiles must be positive`);
    expect(Number.isInteger(mirror.planeTrackedFiles) && mirror.planeTrackedFiles > 0, `fixture: ${surface} planeTrackedFiles must be positive`);
    expect(
      mirror.splitTrackedFiles > mirror.planeTrackedFiles,
      `fixture: ${surface} splitTrackedFiles should exceed planeTrackedFiles in this stale snapshot`
    );
  }

  const strategy = fixture.importStrategy || {};
  expect(strategy.mode === 'history_preserving_prefix_rehearsal', 'fixture: import strategy must preserve history by prefix rehearsal');
  expect(strategy.squashImportDefault === false, 'fixture: squash import must not be default');
  for (const targetPath of ['packages/broker', 'packages/docker-runner', 'packages/openclaw-plugin-a2a']) {
    expect((strategy.targetPaths || []).includes(targetPath), `fixture: import target missing ${targetPath}`);
  }
  expect(/document_before_import/.test(strategy.tagPolicy || ''), 'fixture: tag policy must be documented before import');
  expect(/keep_closed_history_in_original_repos/.test(strategy.closedIssuePrPolicy || ''), 'fixture: closed issue/PR policy must keep original repos');

  for (const field of [
    'sourceRepo',
    'sourceRef',
    'targetPath',
    'importMethod',
    'tagCollisionPolicy',
    'issuePrProvenancePolicy',
    'manifestScriptDifferences',
    'ciParityStatus',
    'scannerGateStatus',
    'rollbackPoint',
    'finalizerDecision',
  ]) {
    expect((fixture.requiredReportFields || []).includes(field), `fixture: missing required report field ${field}`);
  }

  for (const point of [
    'source_ref_collection',
    'prefix_import_rehearsal',
    'manifest_script_comparison',
    'ci_parity_rehearsal',
    'workspace_pr_without_canonical_flip',
  ]) {
    expect((fixture.rollbackPoints || []).includes(point), `fixture: missing rollback point ${point}`);
  }

  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

if (doc) {
  for (const phrase of [
    'Split repos remain canonical',
    'stale mirror',
    'history-preserving prefix',
    'Do not squash by default',
    'Rollback / Discard Points',
    'No-live Boundary',
  ]) {
    expect(doc.toLowerCase().includes(phrase.toLowerCase()), `doc: missing phrase "${phrase}"`);
  }
  expect(/a2a-plane#511/.test(doc), 'doc: must reference #511');
  expect(/a2a-plane#513/.test(doc), 'doc: must reference #513');
}

if (reentryDoc) {
  expect(/a2a-monorepo-next/.test(reentryDoc), 'reentry doc: must retain additive rehearsal workspace wording');
}

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-import-rehearsal'] === 'node scripts/check-monorepo-import-rehearsal.mjs',
    'package.json: missing check:monorepo-import-rehearsal script'
  );
  const releaseGate = readRel('scripts/release-gate.mjs') || '';
  expect(/monorepo-import-rehearsal/.test(releaseGate), 'release gate must include monorepo import rehearsal check');
}

if (failures.length) {
  console.error(`monorepo import rehearsal validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('monorepo import rehearsal ok');

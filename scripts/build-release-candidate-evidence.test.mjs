import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertPublicSafeEvidence,
  buildEvidence,
  renderSummary,
  writeEvidenceFiles,
} from './build-release-candidate-evidence.mjs';

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-rc-evidence-'));
  fs.mkdirSync(path.join(dir, 'packages', 'example', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages', 'example', 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@example/root',
    private: true,
    packageManager: 'npm@10.0.0',
    workspaces: ['packages/*'],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'packages', 'example', 'package.json'), JSON.stringify({
    name: '@example/a2a-candidate',
    version: '0.0.0',
    private: true,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'packages', 'example', 'src', 'index.js'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(dir, 'packages', 'example', 'node_modules', 'ignored', 'x.js'), 'ignored\n');
  return dir;
}

test('buildEvidence creates source-only packet with package contents audit', () => {
  const repoRoot = makeFixtureRepo();
  const evidence = buildEvidence({ repoRoot, candidateRef: 'HEAD', prUrl: 'https://github.com/jinwon-int/a2a-nexus/pull/0' });

  assert.equal(evidence.schemaVersion, 'a2a.release-candidate-evidence.v1');
  assert.equal(evidence.sourceOnly, true);
  assert.equal(evidence.noLiveActionsPerformed, true);
  assert.equal(evidence.validationCommands.every((cmd) => cmd.status === 'not_run_by_design'), true);
  assert.equal(evidence.packageContentsAudit.packages.length, 1);

  const [pkg] = evidence.packageContentsAudit.packages;
  assert.equal(pkg.path, 'packages/example');
  assert.equal(pkg.name, '@example/a2a-candidate');
  assert.ok(pkg.includedFiles.includes('packages/example/package.json'));
  assert.ok(pkg.includedFiles.includes('packages/example/src/index.js'));
  assert.ok(!pkg.includedFiles.some((file) => file.includes('node_modules')));
  assert.deepEqual(pkg.excludedByPolicy, []);
  assert.equal(pkg.riskFindings.length, 0);
  assertPublicSafeEvidence(evidence);
});

test('buildEvidence fails closed when a package contains sensitive candidate paths', () => {
  const repoRoot = makeFixtureRepo();
  fs.writeFileSync(path.join(repoRoot, 'packages', 'example', '.env'), 'SHOULD_NOT_BE_INCLUDED=1\n');
  assert.throws(
    () => buildEvidence({ repoRoot }),
    /release candidate evidence is not public-safe: 1 package risk finding\(s\)/,
  );
});

test('writeEvidenceFiles writes public-safe evidence.json and summary.md', () => {
  const repoRoot = makeFixtureRepo();
  const evidence = buildEvidence({ repoRoot });
  const outDir = path.join(repoRoot, 'artifacts', 'release-candidate');
  const { evidencePath, summaryPath } = writeEvidenceFiles(evidence, outDir);

  assert.equal(fs.existsSync(evidencePath), true);
  assert.equal(fs.existsSync(summaryPath), true);
  const written = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assert.equal(written.schemaVersion, 'a2a.release-candidate-evidence.v1');
  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.match(summary, /Release-candidate evidence summary/);
  assert.match(summary, /No GitHub Release, tag, npm publish/);
});

test('assertPublicSafeEvidence rejects host-private paths in packets', () => {
  const evidence = buildEvidence({ repoRoot: makeFixtureRepo() });
  evidence.candidate.repository = '/root/private/repo';
  assert.throws(() => assertPublicSafeEvidence(evidence), /absolute-root-path/);
});

test('renderSummary keeps validation commands as not-run evidence', () => {
  const evidence = buildEvidence({ repoRoot: makeFixtureRepo() });
  const summary = renderSummary(evidence);
  assert.match(summary, /not_run_by_design/);
  assert.match(summary, /npm run check/);
  assert.match(summary, /source-only evidence builder/);
});

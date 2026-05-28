/**
 * Test for split-repo local demo conformance check.
 *
 * Validates the check-split-repo-local-demo-conformance module's core logic
 * without live network/provider assumptions.
 *
 * Safety: read-only unit tests. No deploy, no restart, no live send.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ── File existence checks ───────────────────────────────────────────────────

test('split-repo local demo doc exists', () => {
  assert.ok(existsSync(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md')));
});

test('split-repo local demo evidence fixture exists', () => {
  assert.ok(existsSync(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json')));
});

test('conformance check script exists', () => {
  assert.ok(existsSync(join(repoRoot, 'scripts', 'check-split-repo-local-demo-conformance.mjs')));
});

// ── Doc structural validation ───────────────────────────────────────────────

test('doc contains required sections', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  assert.match(content, /Split-Repo Local Demo Quickstart/i);
  assert.match(content, /Safety boundary/i);
  assert.match(content, /Repo topology/i);
  assert.match(content, /Prerequisites/i);
  assert.match(content, /Broker.*AgentCard\/profile inspection/i);
  assert.match(content, /Plugin.*diagnostics\/profile visibility/i);
  assert.match(content, /Docker runner.*dry-run evidence/i);
  assert.match(content, /Conformance check/i);
  assert.match(content, /Summary/i);
  assert.match(content, /Safety checklist/i);
});

test('doc uses deterministic local paths only', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  // Loopback broker URL
  assert.match(content, /127\.0\.0\.1:8787/);

  // Deterministic commands
  assert.match(content, /python3 -m json\.tool/);
  assert.match(content, /npm ci --ignore-scripts --include=dev/);
});

test('doc references all three completed upstream issues', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  assert.match(content, /a2a-broker#951/);
  assert.match(content, /openclaw-plugin-a2a#454/);
  assert.match(content, /a2a-docker-runner#343/);
  assert.match(content, /jinwon-int\/a2a-broker\/issues\/951/);
  assert.match(content, /jinwon-int\/openclaw-plugin-a2a\/issues\/454/);
  assert.match(content, /jinwon-int\/a2a-docker-runner\/issues\/343/);
});

test('doc links parent and tracking issues', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  assert.match(content, /a2a-plane\/issues\/473/);
  assert.match(content, /a2a-plane\/issues\/480/);
});

test('doc contains safety constraints', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  assert.match(content, /loopback URLs/i);
  assert.match(content, /Do not point it at production/i);
  assert.match(content, /no production deploy/i);
  assert.match(content, /live provider send/i);
  assert.match(content, /repository visibility/i);
  assert.match(content, /history rewrite/i);
});

test('doc mentions AgentCard endpoint and worker capacity', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  assert.match(content, /\.well-known\/agent-card\.json/);
  assert.match(content, /workers\/capacity/);
});

test('doc mentions plugin config schema and diagnostics', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  assert.match(content, /openclaw\.plugin\.json/);
  assert.match(content, /configSchema/);
});

test('doc mentions docker-runner dry-run evidence and task fixtures', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  assert.match(content, /dry-run evidence/i);
  assert.match(content, /task\.canonical\.json/);
  assert.match(content, /node dist\/cli\.js cleanup --ttl 24h --dry-run/);
  assert.match(content, /--dry-run/);
});

test('doc has safety checklist with bootstrap context warning', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  assert.match(content, /Safety checklist/i);
  assert.match(content, /excluded from the branch/i);
});

// ── Fixture structural validation ───────────────────────────────────────────

test('fixture has correct schema and mode', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json'), 'utf8'));

  assert.strictEqual(fixture.schema, 'a2a.splitRepoLocalDemo.evidence.v1');
  assert.strictEqual(fixture.mode, 'no-live');
  assert.strictEqual(fixture.parentIssue, 'https://github.com/jinwon-int/a2a-plane/issues/473');
  assert.strictEqual(fixture.trackingIssue, 'https://github.com/jinwon-int/a2a-plane/issues/480');
});

test('fixture has correct completed issue references', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json'), 'utf8'));

  assert.strictEqual(fixture.completedIssues.brokerAgentCardProfile, 'https://github.com/jinwon-int/a2a-broker/issues/951');
  assert.strictEqual(fixture.completedIssues.pluginDiagnosticsVisibility, 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/454');
  assert.strictEqual(fixture.completedIssues.dockerRunnerDryRunEvidence, 'https://github.com/jinwon-int/a2a-docker-runner/issues/343');
});

test('fixture broker section uses loopback URLs only', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json'), 'utf8'));

  assert.strictEqual(fixture.broker.agentCardUrl, 'http://127.0.0.1:8787/.well-known/agent-card.json');
  assert.strictEqual(fixture.broker.healthUrl, 'http://127.0.0.1:8787/health');
  assert.strictEqual(fixture.broker.workersCapacityUrl, 'http://127.0.0.1:8787/workers/capacity');
  assert.strictEqual(fixture.broker.baseUrl, 'http://127.0.0.1:8787');
  assert.strictEqual(fixture.broker.prod, false);
});

test('fixture plugin section has expected capabilities', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json'), 'utf8'));

  assert.strictEqual(fixture.plugin.prod, false);
  assert.strictEqual(fixture.plugin.configSchemaUrl, 'packages/openclaw-plugin-a2a/openclaw.plugin.json');
  assert.ok(fixture.plugin.diagnostics.expectedCapabilities.includes('baseUrl'));
  assert.ok(fixture.plugin.diagnostics.expectedCapabilities.includes('edgeSecret'));
  assert.ok(fixture.plugin.diagnostics.expectedCapabilities.includes('requester'));
  assert.ok(fixture.plugin.diagnostics.expectedCapabilities.includes('operatorEvents'));
  assert.ok(fixture.plugin.diagnostics.expectedCapabilities.includes('wakeOnTask'));
});

test('fixture docker-runner section describes dry-run evidence structure', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json'), 'utf8'));

  assert.strictEqual(fixture.dockerRunner.prod, false);
  assert.strictEqual(fixture.dockerRunner.dryRunFlag, '--dry-run');
  assert.strictEqual(fixture.dockerRunner.expectedEvidence.schema, 'a2a.runner.dryRunState.v1');
  assert.ok(fixture.dockerRunner.expectedEvidence.requiredArtifacts.includes('task.json'));
  assert.ok(fixture.dockerRunner.expectedEvidence.requiredArtifacts.includes('run.json'));
  assert.ok(fixture.dockerRunner.expectedEvidence.requiredArtifacts.includes('manifest.json'));
});

test('fixture terminal evidence includes Done and Block', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json'), 'utf8'));

  assert.ok(fixture.expectedTerminalEvidence.includes('Done'));
  assert.ok(fixture.expectedTerminalEvidence.includes('Block'));
});

test('fixture all safety flags are false', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json'), 'utf8'));

  for (const [key, value] of Object.entries(fixture.safety)) {
    assert.strictEqual(value, false, `safety.${key} must be false`);
  }
});

test('fixture is replay-safe and no-live', async () => {
  const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'contract', 'split-repo-local-demo-evidence.json'), 'utf8'));

  assert.strictEqual(fixture.replaySafe, true);
  assert.strictEqual(fixture.noLive, true);
});

// ── Upstream component file existence ───────────────────────────────────────

test('broker AgentCard type definition exists', () => {
  assert.ok(existsSync(join(repoRoot, 'packages', 'broker', 'src', 'a2a', 'agent-card.ts')));
});

test('plugin config schema exists', () => {
  assert.ok(existsSync(join(repoRoot, 'packages', 'openclaw-plugin-a2a', 'openclaw.plugin.json')));
});

test('docker-runner canonical task fixture exists', () => {
  assert.ok(existsSync(join(repoRoot, 'packages', 'docker-runner', 'examples', 'task.canonical.json')));
});

// ── No live network URLs in doc ─────────────────────────────────────────────

test('doc contains no live external endpoints', async () => {
  const content = await readFile(join(repoRoot, 'docs', 'demo', 'split-repo-local-demo.md'), 'utf8');

  // Extract all URLs
  const urls = content.match(/https?:\/\/[^\s)]+/g) || [];

  // Allowed: loopback, localhost, github.com (issue references only)
  const suspicious = urls.filter(
    (u) =>
      !u.startsWith('http://127.0.0.1') &&
      !u.startsWith('http://localhost') &&
      !u.startsWith('https://github.com/jinwon-int/')
  );

  assert.strictEqual(suspicious.length, 0, `live URLs in doc: ${suspicious.join(', ')}`);
});

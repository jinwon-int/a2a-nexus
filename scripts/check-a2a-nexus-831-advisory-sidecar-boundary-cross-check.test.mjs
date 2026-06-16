import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, 'docs', 'validation', 'a2a-nexus-831-advisory-sidecar-boundary-cross-check.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('A2A Nexus #831 evidence includes required structured fields', async () => {
  const content = await doc();

  for (const field of [
    'analysisStatus:',
    'issue:',
    'recommendation:',
    '## evidence',
    '## risks',
    '## proposedSlice',
    '## tests',
    '## closeability',
    '## nonActions',
  ]) {
    assert.match(content, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /jinwon-int\/a2a-nexus#831/);
  assert.match(content, /5c3c0425b1af133af2fc0a2dc33f5f820983c989/);
});

test('A2A Nexus #831 evidence is issue-specific and recommends PR-first closeout', async () => {
  const content = await doc();

  assert.match(content, /needs PR-first implementation slice before closeout/);
  assert.match(content, /not closeable now/);
  assert.match(content, /no-live-sidecar/);
  assert.match(content, /no-provider-send/);
  assert.match(content, /no-routing-influence/);
  assert.doesNotMatch(content, /generic acceptance|wrapper text|accepted by versioned A2A task handler/i);
});

test('A2A Nexus #831 evidence names exact source files, functions, and tests', async () => {
  const content = await doc();

  for (const expected of [
    'packages/broker/src/core/a2a-advisory-sidecar-contract.ts',
    'validateAdvisorySidecarRecommendation()',
    'resolveAdvisorySidecarRecommendation()',
    'packages/broker/src/core/a2a-advisory-sidecar-resolver.ts',
    'ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY',
    'resolveDefaultOffAdvisorySidecarRecommendation()',
    'packages/broker/src/core/a2a-advisory-sidecar-operator-decision.ts',
    'createAdvisorySidecarOperatorDecisionPacket()',
    'packages/broker/scripts/worker-model-policy.mjs',
    'advisorySidecarWorkerModelPolicySnapshot()',
    'resolveAdvisorySidecarRoutingPolicy()',
    'resolveAdvisorySidecarFallbackDecision()',
    'packages/broker/scripts/a2a-task-handler.test.mjs',
  ]) {
    assert.match(content, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('A2A Nexus #831 evidence captures the routing-influence ambiguity', async () => {
  const content = await doc();

  assert.match(content, /ADVISORY_SIDECAR_ROUTING_POLICY\.allowedRoute/);
  assert.match(content, /"advisory_sidecar"/);
  assert.match(content, /status: "allowed"/);
  assert.match(content, /source-level ambiguity/);
  assert.match(content, /routingInfluencePermitted: false/);
});

test('A2A Nexus #831 evidence preserves no-live and runtime hygiene boundaries', async () => {
  const content = await doc();

  assert.match(content, /Did not start a sidecar/);
  assert.match(content, /After the runner-posted Start marker/);
  assert.match(content, /did not call a provider/);
  assert.match(content, /Did not run `git commit`, `git push`, or `gh pr create`/);
  assert.match(content, /Guard check found no repo-relative offending paths/);
  assert.match(content, /AGENTS\.md/);
  assert.match(content, /\.openclaw\/\*\*/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|BROKER_EDGE_SECRET|raw session dump/i);
});

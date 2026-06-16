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
  assert.match(content, /jinwon-int\/a2a-nexus#834/);
  assert.match(content, /a2a-open-cleanup-20260616T204949Z-yukson-issue-831/);
  assert.match(content, /5c3c0425b1af133af2fc0a2dc33f5f820983c989/);
});

test('A2A Nexus #831 evidence records PR-first implementation and closeability', async () => {
  const content = await doc();

  assert.match(content, /PR-first implementation slice is required and included in this branch/);
  assert.match(content, /#831 is closeable after this PR merges/);
  assert.match(content, /#764 should remain open/);
  assert.match(content, /no-live-sidecar/);
  assert.match(content, /no-provider-send/);
  assert.match(content, /routing-influence boundary/);
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

test('A2A Nexus #831 evidence captures the resolved routing-influence boundary', async () => {
  const content = await doc();

  assert.match(content, /ADVISORY_SIDECAR_ROUTING_POLICY\.allowedRoute/);
  assert.match(content, /allowedRoute` is now `"default_worker"/);
  assert.match(content, /advisoryCandidateRoute: "advisory_sidecar"/);
  assert.match(content, /routingInfluencePermitted: false/);
  assert.match(content, /operationalRoutingChanged: false/);
  assert.match(content, /no input combination can return an operational sidecar route/);
});

test('A2A Nexus #831 evidence preserves no-live and runtime hygiene boundaries', async () => {
  const content = await doc();

  assert.match(content, /Did not start a sidecar/);
  assert.match(content, /Did not deploy, restart, mutate DB\/state/);
  assert.match(content, /A2A runner created the PR-first branch\/PR/);
  assert.match(content, /finalizer changes in this branch are limited to source\/docs\/tests/);
  assert.match(content, /No runtime\/bootstrap context files/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|BROKER_EDGE_SECRET|raw session dump:/i);
});

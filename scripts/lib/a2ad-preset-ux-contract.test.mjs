/**
 * Contract tests for the A2AD preset UX spec (#1045).
 *
 * Safety: read-only docs/fixture validation. No broker dispatch, no deploy,
 * no restart, no provider send, no DB/outbox mutation, no secret movement.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const specPath = join(repoRoot, 'docs', 'specs', 'a2ad-preset-ux', 'spec.md');
const schemaPath = join(repoRoot, 'docs', 'specs', 'a2ad-preset-ux', 'preset.schema.json');
const fixturePath = join(repoRoot, 'fixtures', 'contract', 'a2ad-preset-ux.json');

const EXECUTION_MODES = new Set([
  'broker-a2ad',
  'local-multi-model-review',
  'local-subagent-debate',
  'single-agent-structured-review',
]);
const NON_BROKER_MODES = new Set([
  'local-multi-model-review',
  'local-subagent-debate',
  'single-agent-structured-review',
]);
const ALLOWED_SURFACES = new Set(['slash-command', 'cli', 'api', 'gateway-command', 'model-picker']);
const ADVISORY_ROLES = new Set(['thesis', 'antithesis', 'rebuttal', 'reference', 'critic']);

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePreset(preset) {
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(String(preset.presetId || ''))) errors.push('presetId must be kebab-case text');
  if (!hasText(preset.displayName)) errors.push('displayName is required');
  if (!EXECUTION_MODES.has(preset.executionMode)) errors.push('executionMode must be one of the taxonomy modes');
  if (preset.sideEffectPolicy !== 'finalizer-only') errors.push('sideEffectPolicy must be finalizer-only');
  if (!Array.isArray(preset.allowedSurfaces) || preset.allowedSurfaces.length === 0) errors.push('allowedSurfaces must be non-empty');
  for (const surface of preset.allowedSurfaces || []) {
    if (!ALLOWED_SURFACES.has(surface)) errors.push(`unknown allowed surface: ${surface}`);
  }

  if (preset.executionMode === 'broker-a2ad') {
    if (!hasText(preset.brokerOfRecord) || !hasText(preset.workerInventorySource)) {
      errors.push('broker-a2ad requires brokerOfRecord and workerInventorySource');
    }
    if (preset.reportLabel !== 'broker A2AD') errors.push('broker-a2ad reportLabel must be broker A2AD');
  }
  if (NON_BROKER_MODES.has(preset.executionMode)) {
    if ('brokerOfRecord' in preset) errors.push('non-broker modes must not set brokerOfRecord');
    if (String(preset.reportLabel || '').toLowerCase() === 'broker a2ad') {
      errors.push('local modes must not use broker A2AD report label');
    }
  }

  if (!Array.isArray(preset.lanes) || preset.lanes.length === 0) errors.push('lanes must be non-empty');
  const laneRoles = new Set();
  for (const [index, lane] of (preset.lanes || []).entries()) {
    const tag = `lanes[${index}]`;
    if (!hasText(lane.role)) errors.push(`${tag}.role is required`);
    laneRoles.add(lane.role);
    if (!Array.isArray(lane.participants) || lane.participants.length === 0) errors.push(`${tag}.participants must be non-empty`);
    if (ADVISORY_ROLES.has(lane.role) && lane.sideEffects !== 'forbidden') {
      errors.push('non-finalizer lanes forbid side effects');
    }
    if (lane.role !== 'synthesis' && lane.toolPolicy === 'finalizer-only') {
      errors.push(`${tag}.toolPolicy finalizer-only is only valid for synthesis/finalizer lanes`);
    }
  }

  if (!preset.finalizer || preset.finalizer.role !== 'synthesis') errors.push('finalizer.role must be synthesis');
  if (!hasText(preset.finalizer?.owner)) errors.push('finalizer.owner is required');
  if (preset.finalizer?.requiresEvidenceRefs !== true) errors.push('finalizer must require evidence refs');
  if (!laneRoles.has('synthesis')) errors.push('a synthesis lane is required');

  const evidence = preset.evidencePolicy || {};
  if (!Array.isArray(evidence.publicSummaryFields) || evidence.publicSummaryFields.length < 4) errors.push('evidencePolicy.publicSummaryFields must have at least four fields');
  if (!Array.isArray(evidence.requiredEvidenceRefs) || evidence.requiredEvidenceRefs.length === 0) errors.push('evidencePolicy.requiredEvidenceRefs must be non-empty');
  if (evidence.downgradeDisclosure !== true) errors.push('evidencePolicy.downgradeDisclosure must be true');
  if (!['not-published', 'redacted-only'].includes(evidence.privateScratch)) errors.push('evidencePolicy.privateScratch must prevent raw scratch publication');

  const budget = preset.budget || {};
  if (!Number.isInteger(budget.timeoutSeconds) || budget.timeoutSeconds < 60 || budget.timeoutSeconds > 7200) errors.push('budget.timeoutSeconds out of range');
  if (!['low', 'medium', 'high', 'max'].includes(budget.costTier)) errors.push('budget.costTier invalid');
  if (!Number.isInteger(budget.maxLanes) || budget.maxLanes < 1 || budget.maxLanes > 12) errors.push('budget.maxLanes out of range');

  const degraded = preset.degradedModePolicy || {};
  if (degraded.silentDegradeAllowed !== false) errors.push('silent degrade must be disallowed');
  if (degraded.notOfficialBrokerA2adWhenDegraded !== true) errors.push('degraded runs must not be official broker A2AD');

  return errors;
}

test('spec documents execution taxonomy, downgrade rules, side-effect policy, and benchmark track', async () => {
  const content = await readFile(specPath, 'utf8');
  assert.match(content, /broker-a2ad/);
  assert.match(content, /local-multi-model-review/);
  assert.match(content, /local-subagent-debate/);
  assert.match(content, /single-agent-structured-review/);
  assert.match(content, /MUST NOT silently downgrade/);
  assert.match(content, /finalizer-only/);
  assert.match(content, /private scratch/i);
  assert.match(content, /Benchmark \/ evaluation track/);
  assert.match(content, /No production deploy|Production deploy/);
  assert.doesNotMatch(content, /gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/);
  assert.doesNotMatch(content, /Authorization:\s*Bearer/i);
});

test('JSON schema exposes the required preset contract fields and broker/local conditional rules', async () => {
  const schema = await json(schemaPath);
  for (const field of ['presetId', 'displayName', 'executionMode', 'sideEffectPolicy', 'lanes', 'finalizer', 'evidencePolicy', 'budget', 'allowedSurfaces']) {
    assert.ok(schema.required.includes(field), `${field} must be required`);
  }
  assert.deepEqual(schema.properties.sideEffectPolicy, { const: 'finalizer-only' });
  assert.ok(schema.allOf.some((rule) => JSON.stringify(rule).includes('brokerOfRecord')), 'broker-a2ad conditional broker fields required');
  assert.ok(JSON.stringify(schema).includes('silentDegradeAllowed'), 'schema must encode degrade policy');
});

test('valid fixture presets pass semantic contract checks', async () => {
  const fixture = await json(fixturePath);
  assert.equal(fixture.contract, 'docs/specs/a2ad-preset-ux/spec.md');
  assert.ok(fixture.validPresets.length >= 3);
  const modes = new Set(fixture.validPresets.map((preset) => preset.executionMode));
  for (const mode of EXECUTION_MODES) assert.ok(modes.has(mode), `fixture must include ${mode}`);
  for (const preset of fixture.validPresets) {
    assert.deepEqual(validatePreset(preset), [], `${preset.presetId} should be valid`);
  }
});

test('invalid fixture presets fail closed for broker evidence, advisory side effects, and downgrade mislabeling', async () => {
  const fixture = await json(fixturePath);
  assert.ok(fixture.invalidPresets.length >= 3);
  for (const scenario of fixture.invalidPresets) {
    const errors = validatePreset(scenario.preset);
    assert.ok(errors.length > 0, `${scenario.caseId} must fail`);
    assert.ok(errors.some((error) => error.includes(scenario.expectError)), `${scenario.caseId} expected ${scenario.expectError}; got ${errors.join('; ')}`);
  }
});

test('broker A2AD valid preset carries official evidence and finalizer-only closeout requirements', async () => {
  const fixture = await json(fixturePath);
  const preset = fixture.validPresets.find((item) => item.executionMode === 'broker-a2ad');
  assert.ok(preset, 'broker-a2ad preset exists');
  assert.equal(preset.reportLabel, 'broker A2AD');
  assert.equal(preset.finalizer.sideEffects, 'approval-gated');
  assert.ok(preset.evidencePolicy.requiredEvidenceRefs.includes('brokerTaskId'));
  assert.ok(preset.evidencePolicy.requiredEvidenceRefs.includes('phaseEvidenceRefs'));
  assert.ok(preset.evidencePolicy.publicSummaryFields.includes('sideEffectBoundary'));
  assert.equal(preset.degradedModePolicy.silentDegradeAllowed, false);
});

test('non-broker modes disclose they are not official broker A2AD', async () => {
  const fixture = await json(fixturePath);
  for (const preset of fixture.validPresets.filter((item) => NON_BROKER_MODES.has(item.executionMode))) {
    assert.notEqual(preset.reportLabel, 'broker A2AD');
    assert.ok(!('brokerOfRecord' in preset));
    assert.equal(preset.degradedModePolicy.notOfficialBrokerA2adWhenDegraded, true);
  }
});

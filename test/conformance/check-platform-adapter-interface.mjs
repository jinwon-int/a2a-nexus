/**
 * Conformance check: Platform-Independent A2A Adapter Interface fixture
 *
 * Validates:
 *   - fixtures/contract/platform-adapter-interface.json
 *   - Contract guarantees from contracts/a2a/platform-adapter-interface.md
 *
 * Safety: read-only fixture verification. No live adapter, provider send,
 * Gateway restart, DB mutation, or terminal-outbox ACK.
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, 'fixtures', 'contract', 'platform-adapter-interface.json'), 'utf8'),
);

/* ── Safety gate checks ──────────────────────────────────────── */

assert.equal(fixture.meta.redacted, true, 'meta.redacted must be true');
assert.equal(fixture.safety.productionDeploy, false, 'safety.productionDeploy must be false');
assert.equal(fixture.safety.gatewayRestart, false, 'safety.gatewayRestart must be false');
assert.equal(fixture.safety.liveProviderSend, false, 'safety.liveProviderSend must be false');
assert.equal(fixture.safety.terminalOutboxAckMutation, false, 'safety.terminalOutboxAckMutation must be false');
assert.equal(fixture.safety.databaseMutation, false, 'safety.databaseMutation must be false');
assert.equal(fixture.safety.secretMovement, false, 'safety.secretMovement must be false');
assert.equal(fixture.safety.isApproval, false, 'safety.isApproval must be false');
assert.equal(fixture.safety.isTerminalAck, false, 'safety.isTerminalAck must be false');
assert.equal(fixture.safety.isReadReceipt, false, 'safety.isReadReceipt must be false');

/* ── No OpenClaw runtime/bootstrap paths in fixture ────────── */

const fixtureText = JSON.stringify(fixture);
const forbiddenRuntimePaths = [
  'AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md',
  'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/',
];
for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !fixtureText.includes(forbiddenPath),
    `fixture must not contain OpenClaw runtime/bootstrap path: ${forbiddenPath}`,
  );
}

/* ── No secret-like patterns ────────────────────────────────── */

const secretLikePatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

// Skip intentionally redacted placeholders like "REDACTED"
const redactionSnippetOnly = fixtureText
  .replace(/REDACTED/g, '')
  .replace(/redacted-\w+/g, '');

for (const pattern of secretLikePatterns) {
  assert.ok(
    !pattern.test(redactionSnippetOnly),
    `fixture matched forbidden secret-like pattern: ${pattern}`,
  );
}

/* ── Identity checks (PAI-01) ─────────────────────────────── */

assert.ok(fixture.identities, 'fixture must have identities');
const ids = fixture.identities;
const idEntries = Object.entries(ids);
assert.ok(idEntries.length >= 3, `expected >= 3 identities, got ${idEntries.length}`);

for (const [name, identity] of idEntries) {
  assert.ok(typeof identity.id === 'string' && identity.id.length > 0,
    `identity "${name}" must have non-empty id`);
  assert.ok(typeof identity.platform === 'string' && identity.platform.length > 0,
    `identity "${name}" must have non-empty platform`);
}

/* ── Capability checks (PAI-02) ────────────────────────────── */

assert.ok(fixture.capabilities, 'fixture must have capabilities');
const capEntries = Object.entries(fixture.capabilities);
assert.ok(capEntries.length >= 2, `expected >= 2 capabilities, got ${capEntries.length}`);

for (const [name, cap] of capEntries) {
  assert.ok(Array.isArray(cap.transports), `capabilities["${name}"] must have transports array`);
  assert.ok(cap.transports.length >= 1, `capabilities["${name}"] must have >= 1 transport`);
  assert.ok(typeof cap.heartbeatSupported === 'boolean',
    `capabilities["${name}"] must have heartbeatSupported boolean`);
  assert.ok(typeof cap.maxReceiptLevel === 'number' && cap.maxReceiptLevel >= 0 && cap.maxReceiptLevel <= 4,
    `capabilities["${name}"] maxReceiptLevel must be 0-4`);
}

/* ── Task request envelope checks (PAI-03) ────────────────── */

assert.ok(fixture.taskRequests, 'fixture must have taskRequests');
const taskReqMin = fixture.taskRequests.validMinimal;
assert.ok(taskReqMin, 'must have validMinimal task request');
assert.strictEqual(typeof taskReqMin.taskId, 'string', 'validMinimal must have taskId');
assert.strictEqual(typeof taskReqMin.intent, 'string', 'validMinimal must have intent');
assert.ok(taskReqMin.input !== undefined, 'validMinimal must have input');

const taskReqFull = fixture.taskRequests.validFull;
assert.ok(taskReqFull, 'must have validFull task request');
assert.ok(taskReqFull.expectedOutput !== undefined, 'validFull must have expectedOutput');
assert.ok(taskReqFull.requester !== undefined, 'validFull must have requester');
assert.ok(taskReqFull.correlationId !== undefined, 'validFull must have correlationId');
assert.ok(taskReqFull.parentRunId !== undefined, 'validFull must have parentRunId');

/* ── Evidence shape and redaction checks (PAI-04) ────────── */

assert.ok(fixture.evidence, 'fixture must have evidence');
const evidenceEntries = Object.entries(fixture.evidence);
assert.ok(evidenceEntries.length >= 3, `expected >= 3 evidence entries, got ${evidenceEntries.length}`);

for (const [name, ev] of evidenceEntries) {
  assert.ok(['start', 'pr', 'done', 'block'].includes(ev.kind),
    `evidence "${name}" kind must be start/pr/done/block, got ${ev.kind}`);
  assert.strictEqual(typeof ev.summary, 'string', `evidence "${name}" must have summary`);
  assert.strictEqual(ev.redacted, true, `evidence "${name}" must be redacted`);
  assert.ok(ev.timestamp, `evidence "${name}" must have timestamp`);
  assert.ok(ev.dedupeKey, `evidence "${name}" must have dedupeKey`);
}

/* ── Receipt level mapping checks (PAI-05) ────────────────── */

assert.ok(Array.isArray(fixture.receiptLevelMappings), 'must have receiptLevelMappings array');
assert.ok(fixture.receiptLevelMappings.length === 5, 'receipt level model: exactly 5 mappings');

for (const m of fixture.receiptLevelMappings) {
  assert.strictEqual(typeof m.level, 'number', 'receipt level must be a number');
  assert.strictEqual(typeof m.ackSafe, 'boolean', 'ackSafe must be boolean');
  assert.ok(m.level >= 0 && m.level <= 4, 'receipt level must be 0-4');
}

// Claim task accepted is level 0
assert.strictEqual(fixture.receiptLevelMappings[0].level, 0);
// Submit evidence accepted is level 1
assert.strictEqual(fixture.receiptLevelMappings[1].level, 1);
// Only level 4 is ACK-safe
const ackSafeCount = fixture.receiptLevelMappings.filter((m) => m.ackSafe).length;
assert.strictEqual(ackSafeCount, 1, 'exactly one receipt level is ACK-safe');

/* ── Receipt level consistency (PAI-09) ───────────────────── */

assert.ok(fixture.maxReceiptLevels, 'must have maxReceiptLevels');
for (const [adapter, maxLevel] of Object.entries(fixture.maxReceiptLevels)) {
  assert.ok(maxLevel >= 0 && maxLevel <= 4, `maxReceiptLevel for ${adapter} must be 0-4`);
  assert.ok(maxLevel >= fixture.capabilities[adapter]?.maxReceiptLevel,
    `maxReceiptLevels.${adapter} must match capabilities.${adapter}.maxReceiptLevel`);
}

/* ── HTTP-poll transport flow (PAI-06) ────────────────────── */

assert.ok(fixture.transportFlows.httpPoll, 'must have httpPoll transport flow');
const pollSteps = fixture.transportFlows.httpPoll.steps;
assert.ok(Array.isArray(pollSteps) && pollSteps.length >= 3,
  `httpPoll must have >= 3 steps, got ${pollSteps.length}`);
assert.strictEqual(pollSteps[0].action, 'pollTasks', 'first step must be pollTasks');
assert.strictEqual(pollSteps[1].action, 'claimTask', 'second step must be claimTask');
assert.strictEqual(pollSteps[pollSteps.length - 1].action, 'reportStatus',
  'last step must be reportStatus (terminal)');

/* ── SSE push transport flow (PAI-07) ─────────────────────── */

assert.ok(fixture.transportFlows.ssePush, 'must have ssePush transport flow');
const sseSteps = fixture.transportFlows.ssePush.steps;
assert.ok(Array.isArray(sseSteps) && sseSteps.length >= 2,
  `ssePush must have >= 2 steps, got ${sseSteps.length}`);
assert.strictEqual(sseSteps[0].action, 'sseConnect', 'first SSE step must be sseConnect');

/* ── Heartbeat payload shape (PAI-08) ─────────────────────── */

assert.ok(fixture.heartbeats, 'must have heartbeats');
for (const [name, hb] of Object.entries(fixture.heartbeats)) {
  assert.ok(hb.adapterId, `heartbeat "${name}" must have adapterId`);
  assert.ok(hb.adapterId.id, `heartbeat "${name}" adapterId must have id`);
  assert.ok(Array.isArray(hb.activeTasks), `heartbeat "${name}" must have activeTasks array`);
  assert.ok(['ok', 'degraded', 'unavailable'].includes(hb.health),
    `heartbeat "${name}" health must be ok/degraded/unavailable`);
  assert.ok(hb.timestamp, `heartbeat "${name}" must have timestamp`);
}

/* ── Conformance group coverage ───────────────────────────── */

assert.ok(Array.isArray(fixture.conformanceGroups), 'must have conformanceGroups');
assert.ok(fixture.conformanceGroups.length >= 8,
  `expected >= 8 conformance groups, got ${fixture.conformanceGroups.length}`);

const groupIds = fixture.conformanceGroups.map((g) => g.id);
const expectedGroups = ['PAI-01', 'PAI-02', 'PAI-03', 'PAI-04', 'PAI-05', 'PAI-06', 'PAI-07', 'PAI-08'];
for (const expected of expectedGroups) {
  assert.ok(groupIds.includes(expected), `missing conformance group: ${expected}`);
}

console.log('✅ platform-adapter-interface fixture: all conformance checks passed');

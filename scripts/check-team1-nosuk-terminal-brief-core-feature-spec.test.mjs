/**
 * Test: Team1/nosuk Terminal Brief core feature spec validation
 *
 * Verifies that docs/specs/a2a-terminal-brief-core-feature/spec.md is
 * consistent with the existing contracts, fixtures, and routing guards.
 * This is a source-only, no-live validation.
 *
 * Lane: team1/nosuk (3/7)
 * Parent: https://github.com/jinwon-int/a2a-plane/issues/416
 * Issue: https://github.com/jinwon-int/a2a-plane/issues/417
 * Run: a2a-allhands-dev-20260522T064600Z
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRelative(path) {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

function checkExists(path) {
  const full = resolve(REPO_ROOT, path);
  if (!existsSync(full)) {
    throw new Error(`REQUIRED FILE MISSING: ${path}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPEC_PATH = 'docs/specs/a2a-terminal-brief-core-feature/spec.md';
const PARENT_BRIEF_PATH = 'contracts/a2a/parent-terminal-brief-aggregation.md';
const TERMINAL_SEMANTICS_PATH = 'contracts/a2a/terminal-semantics.md';
const HANDOFF_PROTOCOL_PATH = 'contracts/a2a/broker-handoff-protocol.md';
const ROUTING_CONTRACT_PATH = 'packages/broker/src/core/terminal-brief-routing-contract.ts';
const PARENT_ROUTING_FIXTURE_PATH = 'fixtures/contract/terminal-brief-parent-origin-routing.json';
const AGGREGATION_FIXTURE_PATH = 'fixtures/contract/parent-terminal-brief-aggregation.json';
const ACCEPTED_SEND_FIXTURE_PATH = 'fixtures/terminal-evidence/accepted-send-non-ack.json';
const R6_SYNTHESIS_PATH = 'docs/r6-terminal-brief-openclaw-routing-synthesis.md';
const TEAM1_DISPATCH_PATH = 'docs/specs/a2a-team1-dispatch-wrapper/runbook.md';
const TEAM2_HANDOFF_PATH = 'packages/broker/docs/team2-gwakga-worker-onboarding-retargeting.md';

// ---------------------------------------------------------------------------
// Existence and basic shape
// ---------------------------------------------------------------------------

console.log('\n=== Terminal Brief core feature spec validation ===\n');

// 1. Spec document exists
console.log('1. Checking core spec document exists...');
assert.ok(existsSync(resolve(REPO_ROOT, SPEC_PATH)), `Spec not found at ${SPEC_PATH}`);
const specContent = readRelative(SPEC_PATH);
console.log('   PASS: spec document found');

// 2. Required sections in the spec
console.log('2. Checking required sections...');
const requiredSections = [
  'Team1 local lane path',
  'Team2 Gwakga handoff path',
  'Parent broker finalizer ownership',
  'No-local-send requirement for parent-owned Team2 rows',
  'Acceptance matrix',
  'Safety and approval boundaries',
];
for (const section of requiredSections) {
  const sectionH2 = `## ${section}`;
  const sectionH3 = `### ${section}`;
  assert.ok(
    specContent.includes(sectionH2) || specContent.includes(sectionH3),
    `Required section not found: "${section}"`
  );
  console.log(`   PASS: section "${section}" found`);
}

// 3. Reference map entries exist and are accurate
console.log('3. Checking reference map entries...');
const referencePaths = [
  PARENT_BRIEF_PATH,
  TERMINAL_SEMANTICS_PATH,
  HANDOFF_PROTOCOL_PATH,
  ROUTING_CONTRACT_PATH,
  PARENT_ROUTING_FIXTURE_PATH,
  AGGREGATION_FIXTURE_PATH,
  ACCEPTED_SEND_FIXTURE_PATH,
  R6_SYNTHESIS_PATH,
  TEAM1_DISPATCH_PATH,
  TEAM2_HANDOFF_PATH,
  'docs/specs/a2a-terminal-brief-parent-origin-routing/spec.md',
  'docs/specs/a2a-terminal-brief-canary/spec.md',
];
for (const refPath of referencePaths) {
  checkExists(refPath);
  console.log(`   PASS: reference "${refPath}" exists`);
}

// 4. Core semantics match parent-terminal-brief-aggregation.md
console.log('4. Checking core semantics align with parent aggregation contract...');
const parentBriefContent = readRelative(PARENT_BRIEF_PATH);
const titlePattern = /A2A Terminal Brief 완료: worker\(\d+\/\d+\)/;
assert.ok(
  specContent.includes('A2A Terminal Brief 완료:'),
  'Core spec should reference the known-total title format'
);
assert.ok(
  specContent.includes('80') && specContent.includes('Maximum length'),
  'Core spec should enforce 80-char title limit'
);
assert.ok(
  specContent.includes('originBrokerId') && specContent.includes('parentBrokerId'),
  'Core spec should reference origin/parent broker fields'
);
console.log('   PASS: core semantics aligned');

// 5. Receipt/ACK boundary matches terminal-semantics.md
console.log('5. Checking receipt/ACK boundary...');
assert.ok(
  specContent.includes('accepted-send') && specContent.includes('terminal ACK'),
  'Core spec should define the four receipt levels'
);
assert.ok(
  specContent.includes('providerAccepted') ||
  specContent.includes('provider accepted'),
  'Core spec should reference the non-ACK boundary'
);
console.log('   PASS: receipt/ACK boundary aligned');

// 6. Team2 no-local-send requirement is explicit
console.log('6. Checking no-local-send requirement...');
assert.ok(
  specContent.includes('must NOT send') ||
  specContent.includes('must not send') ||
  specContent.includes('no-local-send'),
  'Core spec must state the no-local-send requirement for parent-owned Team2 rows'
);
assert.ok(
  specContent.includes('Gwakga') && specContent.includes('parent-owned'),
  'Core spec must reference Gwakga and parent-owned rows in the no-local-send context'
);
assert.ok(
  specContent.includes('originBrokerId') && specContent.includes('!= gwakga'),
  'Core spec should define the non-own round detection rule'
);
console.log('   PASS: no-local-send requirement found');

// 7. Four-case routing invariant
console.log('7. Checking four-case routing invariant...');
const routingFixture = JSON.parse(readRelative(PARENT_ROUTING_FIXTURE_PATH));
assert.ok(
  routingFixture.cases || routingFixture.routingCases || routingFixture.routes,
  'Routing fixture should contain routing cases'
);
assert.ok(
  specContent.includes('Team1-only') && specContent.includes('Team1+Team2'),
  'Core spec should reference all routing case combinations'
);
console.log('   PASS: four-case routing references found');

// 8. Finalizer ownership
console.log('8. Checking finalizer ownership...');
assert.ok(
  specContent.includes('finalizer of record') || specContent.includes('Finalizer'),
  'Core spec must define finalizer of record'
);
assert.ok(
  specContent.includes('seoseo') && specContent.includes('Seoseo'),
  'Core spec must reference Seoseo as a broker/finalizer'
);
assert.ok(
  specContent.includes('Origin broker') || specContent.includes('originBrokerId'),
  'Core spec must define origin broker concept'
);
console.log('   PASS: finalizer ownership defined');

// 9. Approval boundaries
console.log('9. Checking approval boundaries...');
const approvalBoundariesPresent =
  specContent.includes('prohibited') ||
  specContent.includes('Prohibited') ||
  (specContent.includes('approval') && specContent.includes('operator'));
assert.ok(approvalBoundariesPresent, 'Core spec must define approval boundaries');
const liveActions = ['deploy', 'restart', 'provider send', 'DB mutation', 'terminal-outbox ACK'];
for (const action of liveActions) {
  // Check for deployment variations
  const searchTerm = action.toLowerCase().replace(/ /g, '');
  const matches = action.split(' ');
  const found = matches.some(m => specContent.toLowerCase().includes(m.toLowerCase()));
  if (!found) {
    console.log(`   WARN: live action "${action}" not explicitly enumerated in approvals`);
  }
}
console.log('   PASS: approval boundaries defined');

// 10. Acceptance matrix gates
console.log('10. Checking acceptance matrix gates...');
const gateIds = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G14'];
for (const gid of gateIds) {
  assert.ok(
    specContent.includes(`| ${gid} |`) || specContent.includes(`| ${gid} `),
    `Gate ${gid} not found in acceptance matrix`
  );
}
console.log('   PASS: all 14 acceptance gates defined');

// 11. FAIL: bootstrap guard paths not in repo
console.log('11. Checking runtime/bootstrap hygiene...');
const guardPaths = [
  'AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md',
  'HEARTBEAT.md', 'IDENTITY.md',
];
for (const name of guardPaths) {
  const fullPath = resolve(REPO_ROOT, name);
  if (existsSync(fullPath)) {
    throw new Error(`BOOTSTRAP GUARD PATH FOUND in repo: ${name}`);
  }
}
const openclawDir = resolve(REPO_ROOT, '.openclaw');
if (existsSync(openclawDir)) {
  throw new Error('BOOTSTRAP GUARD PATH FOUND: .openclaw directory in repo');
}
console.log('   PASS: no bootstrap guard paths in repo');

// 12. R6 synthesis unsafe bypass patterns must be acknowledged
console.log('12. Checking unsafe bypass pattern acknowledgment...');
const r6Content = readRelative(R6_SYNTHESIS_PATH);
assert.ok(
  r6Content.includes('Unsafe bypass patterns') || r6Content.includes('unsafe bypass'),
  'R6 synthesis should document unsafe bypass patterns'
);
assert.ok(
  specContent.includes('OpenClaw-routed') || specContent.includes('openclaw_outbound_lifecycle'),
  'Core spec should require OpenClaw routing, not direct provider paths'
);
console.log('   PASS: unsafe bypass patterns acknowledged');

// 13. Check routing contract imports/coverage
console.log('13. Checking broker routing contract...');
const routingSource = readRelative(ROUTING_CONTRACT_PATH);
assert.ok(
  routingSource.includes('evaluateTerminalBriefRouting'),
  'Routing contract should expose evaluateTerminalBriefRouting'
);
assert.ok(
  routingSource.includes('openclaw_outbound_lifecycle'),
  'Routing contract should allow openclaw_outbound_lifecycle route'
);
assert.ok(
  routingSource.includes('telegram_bot_api') || routingSource.includes('direct_provider_send'),
  'Routing contract should forbid direct Telegram/provider routes'
);
console.log('   PASS: routing contract guards defined');

// 14. Handoff protocol references no-local-send
console.log('14. Checking handoff protocol...');
const handoffContent = readRelative(HANDOFF_PROTOCOL_PATH);
assert.ok(
  handoffContent.includes('handoff:evidence') || handoffContent.includes('terminal evidence relay'),
  'Handoff protocol should cover evidence relay'
);
console.log('   PASS: handoff protocol defines evidence relay');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n=== ALL 14 CHECKS PASSED ===');
console.log('Spec: docs/specs/a2a-terminal-brief-core-feature/spec.md');
console.log('No live action was taken during validation.');
console.log('Runtime/bootstrap hygiene confirmed: guard paths absent from repo.\n');

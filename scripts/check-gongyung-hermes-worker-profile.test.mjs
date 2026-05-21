import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const repoRoot = process.cwd();
const profileDir = join(repoRoot, 'docs', 'specs', 'gongyung-hermes-worker-profile');

/**
 * Helper: assert that a string contains all expected substrings.
 */
function assertIncludesAll(content, expected) {
  for (const s of expected) {
    assert.match(content, new RegExp(escapeRegExp(s)));
  }
}

/**
 * Helper: assert that a string does NOT contain any of the given substrings.
 */
function assertExcludesAll(content, forbidden) {
  for (const s of forbidden) {
    assert.doesNotMatch(content, new RegExp(escapeRegExp(s)));
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ──────────────────────────────────────────────────────────
// Profile path tests
// ──────────────────────────────────────────────────────────

test('spec packet exists at docs/specs/gongyung-hermes-worker-profile/', () => {
  for (const file of ['analyze.md', 'plan.md', 'spec.md', 'tasks.md']) {
    const fullPath = join(profileDir, file);
    assert.ok(existsSync(fullPath), `Missing required file: ${file}`);
  }
});

test('spec.md references title "Gongyung Hermes Lightweight Worker Profile"', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /Gongyung Hermes Lightweight Worker Profile/);
});

test('plan.md references title "Gongyung Hermes Lightweight Worker Profile"', async () => {
  const plan = await readFile(join(profileDir, 'plan.md'), 'utf8');
  assert.match(plan, /Gongyung Hermes Lightweight Worker Profile/);
});

// ──────────────────────────────────────────────────────────
// Non-Docker lightweight profile semantics
// ──────────────────────────────────────────────────────────

test('spec documents non-Docker constraint', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /non-Docker/i);
  assert.match(spec, /lightweight/i);
  assert.match(spec, /dockerAvailable/);
  assert.match(spec, /false/);
});

test('spec documents platform as android-termux', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /android-termux|Android Termux|Termux/i);
});

// ──────────────────────────────────────────────────────────
// Allowed task classes
// ──────────────────────────────────────────────────────────

const ALLOWED_CLASSES = [
  'analyze',
  'research',
  'report',
  'review',
  'hermes-ops',
  'canary',
];

test('spec lists allowed task classes', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  for (const cls of ALLOWED_CLASSES) {
    assert.match(spec, new RegExp(escapeRegExp(cls)));
  }
});

// ──────────────────────────────────────────────────────────
// Rejected / handoff task class flags
// ──────────────────────────────────────────────────────────

const REJECT_FLAGS = [
  'dockerRequired',
  'buildRequired',
  'testRequired',
  'repoPatch',
  'untrustedCode',
];

const OPTIONAL_REJECT_FLAGS = [
  'dependencyHeavy',
  'serviceRestart',
  'brokerDBMutation',
  'credentialMovement',
  'productionACK',
];

test('spec documents mandatory reject/handoff flags', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  for (const flag of REJECT_FLAGS) {
    assert.match(spec, new RegExp(escapeRegExp(flag)));
  }
});

test('spec documents optional reject/handoff flags', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  for (const flag of OPTIONAL_REJECT_FLAGS) {
    assert.match(spec, new RegExp(escapeRegExp(flag)));
  }
});

test('spec says rejected tasks must be rejected OR handed off', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /rejected.*handoff|handoff.*rejected/i);
});

// ──────────────────────────────────────────────────────────
// Artifact contract
// ──────────────────────────────────────────────────────────

test('spec documents fixed artifact root', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /~\/\.hermes\/a2a\/artifacts/);
  assert.match(spec, /evidence\.json/);
});

test('spec evidence manifest includes required fields', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  const requiredFields = ['taskId', 'workerId', 'gongyung', 'status', 'accepted', 'rejected', 'handoff', 'files', 'redactionStatement', 'timestamp'];
  for (const field of requiredFields) {
    assert.match(spec, new RegExp(escapeRegExp(field)));
  }
});

// ──────────────────────────────────────────────────────────
// Secret redaction rules
// ──────────────────────────────────────────────────────────

test('spec documents secret redaction rules', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /secret.*redact|redact.*secret|no.*token/i);
  assert.match(spec, /credential/i);
});

// ──────────────────────────────────────────────────────────
// Prior art reference
// ──────────────────────────────────────────────────────────

test('spec references prior art jinwon-int/a2a-plane#384', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /#384/);
  assert.match(spec, /hermes-worker-integration/);
});

// ──────────────────────────────────────────────────────────
// Out-of-scope / no-live actions
// ──────────────────────────────────────────────────────────

test('spec out-of-scope section lists production actions as out of scope, not in scope', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /### Out of scope/);
  // Verify out-of-scope items are listed as prohibited, not as in-scope work
  const outOfScopeSection = spec.split('### Out of scope')[1].split('###')[0];
  const inScopeSection = spec.split('### In scope')[1].split('###')[0];
  assert.match(outOfScopeSection, /production/i);
  assert.match(outOfScopeSection, /deploy/i);
  assert.match(outOfScopeSection, /restart/i);
  assert.match(outOfScopeSection, /DB mutation/i);
  // In-scope section must not claim to perform these
  assertExcludesAll(inScopeSection, [
    'deploy',
    'restart',
    'live canary',
    'DB mutation',
    'ACK',
    'release/tag',
    'secret movement',
  ]);
});

// ──────────────────────────────────────────────────────────
// Safety and approval boundaries
// ──────────────────────────────────────────────────────────

test('spec safety section lists required human approvals as none', async () => {
  const spec = await readFile(join(profileDir, 'spec.md'), 'utf8');
  assert.match(spec, /Human approval required/);
  assert.match(spec, /none of the above/);
});

// ──────────────────────────────────────────────────────────
// Plan consistency
// ──────────────────────────────────────────────────────────

test('plan references spec and prior art', async () => {
  const plan = await readFile(join(profileDir, 'plan.md'), 'utf8');
  assert.match(plan, /gongyung-hermes-worker-profile\/spec\.md/);
  assert.match(plan, /#384/);
  assert.match(plan, /Seoseo/);
  assert.match(plan, /Small/);
});

test('plan says no broker/worker code change', async () => {
  const plan = await readFile(join(profileDir, 'plan.md'), 'utf8');
  assert.match(plan, /no change/);
});

// ──────────────────────────────────────────────────────────
// Tasks consistency
// ──────────────────────────────────────────────────────────

test('tasks references Seoseo as finalizer', async () => {
  const tasks = await readFile(join(profileDir, 'tasks.md'), 'utf8');
  assert.match(tasks, /Seoseo/);
  assert.match(tasks, /Final closeout/i);
});

test('tasks lists all reject flags', async () => {
  const tasks = await readFile(join(profileDir, 'tasks.md'), 'utf8');
  for (const flag of REJECT_FLAGS) {
    assert.match(tasks, new RegExp(escapeRegExp(flag)));
  }
});

// ──────────────────────────────────────────────────────────
// Analyze consistency
// ──────────────────────────────────────────────────────────

test('analyze confirms ready for execution', async () => {
  const analyze = await readFile(join(profileDir, 'analyze.md'), 'utf8');
  assert.match(analyze, /Ready for task execution/);
  assert.match(analyze, /#384/);
});

// ──────────────────────────────────────────────────────────
// Bootstrap hygiene / no workspace leaks
// ──────────────────────────────────────────────────────────

test('spec packet does not contain OpenClaw workspace files', () => {
  const banned = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', 'BOOTSTRAP.md', 'MEMORY.md'];
  const dirContent = readFileSync(join(profileDir, 'spec.md'), 'utf8');
  for (const name of banned) {
    assert.doesNotMatch(dirContent, new RegExp(`\\b${escapeRegExp(name)}\\b`));
  }
});

// ──────────────────────────────────────────────────────────
// Risk and rollback notes
// ──────────────────────────────────────────────────────────

test('tasks includes risk notes section', async () => {
  const tasks = await readFile(join(profileDir, 'tasks.md'), 'utf8');
  assert.match(tasks, /Risk notes|Risk/i);
});

test('plan includes rollback plan', async () => {
  const plan = await readFile(join(profileDir, 'plan.md'), 'utf8');
  assert.match(plan, /Rollback plan|Revert/i);
});

// Conformance check for the bounded PR review lifecycle contracts (#1518 Phase 1).
//
// Validates the fixture against the four JSON schemas, pins the canonicalization
// golden vectors (intentHash stability/sensitivity, diffHash definition), checks
// receipt/ledger/contract binding consistency, and scans for forbidden content.
// Public-safe: no broker URL, secrets, deploy, restart, DB mutation, or live send.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv from 'ajv';

import {
  canonicalize,
  intentHash,
  diffHash,
  findingSignature,
  EMPTY_DIFF_HASH,
} from './lib/canonical-json.mjs';

const root = process.cwd();
const specDir = path.join(root, 'docs', 'specs', 'bounded-pr-review-lifecycle');
const fixturePath = path.join(root, 'fixtures', 'contract', 'bounded-pr-review-lifecycle.json');

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const fixtureText = fs.readFileSync(fixturePath, 'utf8');

const ajv = new Ajv({ allErrors: true });
function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(specDir, 'schemas', name), 'utf8'));
}
const schemas = {
  intentContract: loadSchema('intent-contract-v1.json'),
  budget: loadSchema('review-lineage-budget-v1.json'),
  findingLedger: loadSchema('finding-ledger-v1.json'),
  reviewReceipt: loadSchema('review-receipt-v1.json'),
};

function assertValid(schemaKey, value, label) {
  const validate = ajv.compile(schemas[schemaKey]);
  const ok = validate(value);
  assert.ok(ok, `${label} must validate against ${schemaKey}: ${JSON.stringify(validate.errors)}`);
}
function assertInvalid(schemaKey, value, label) {
  const validate = ajv.compile(schemas[schemaKey]);
  assert.equal(validate(value), false, `${label} must be rejected by ${schemaKey}`);
}

// ---- 1. Schema validation of the fixture ----
assert.equal(fixture.fixtureId, 'a2a-nexus.contract.bounded-pr-review-lifecycle.v1');
assertValid('intentContract', fixture.intentContract, 'fixture.intentContract');
assertValid('budget', fixture.budget, 'fixture.budget');
assertValid('findingLedger', fixture.findingLedger, 'fixture.findingLedger');
assertValid('reviewReceipt', fixture.reviewReceipt, 'fixture.reviewReceipt');

// ---- 2. intentHash golden vectors ----

// 2a. Self-consistency: recomputing the fixture contract hash reproduces the pinned value.
assert.equal(intentHash(fixture.intentContract), fixture.intentContract.intentHash);

// 2b. Key-order independence: different insertion order, same canonical hash.
const contract = fixture.intentContract;
const reordered = {
  intentHash: contract.intentHash,
  createdAt: contract.createdAt,
  headSha: contract.headSha,
  baseSha: contract.baseSha,
  declaredPaths: { forbidden: contract.declaredPaths.forbidden, allowed: contract.declaredPaths.allowed },
  acceptanceCriteria: contract.acceptanceCriteria.map((c) => ({ text: c.text, id: c.id })),
  invariants: contract.invariants,
  nonGoals: contract.nonGoals,
  goal: contract.goal,
  lineageId: contract.lineageId,
  kind: contract.kind,
};
assert.equal(intentHash(reordered), contract.intentHash, 'canonicalization must be key-order independent');

// 2c. Mutation sensitivity: any semantic field change changes the hash.
const mutations = {
  goal: { ...contract, goal: contract.goal + '!' },
  nonGoals: { ...contract, nonGoals: [...contract.nonGoals, 'extra non-goal'] },
  invariants: { ...contract, invariants: [contract.invariants[0]] },
  acceptanceCriteria: {
    ...contract,
    acceptanceCriteria: contract.acceptanceCriteria.map((c) => (c.id === 'AC-1' ? { ...c, text: c.text + '!' } : c)),
  },
  declaredPaths: { ...contract, declaredPaths: { ...contract.declaredPaths, allowed: ['other/**'] } },
  baseSha: { ...contract, baseSha: '0'.repeat(40) },
  headSha: { ...contract, headSha: 'f'.repeat(40) },
};
for (const [field, mutated] of Object.entries(mutations)) {
  assert.notEqual(intentHash(mutated), contract.intentHash, `changing ${field} must change intentHash`);
}

// 2d. Excluded fields: createdAt and intentHash never affect the hash.
assert.equal(intentHash({ ...contract, createdAt: '2030-01-01T00:00:00Z' }), contract.intentHash);
assert.equal(intentHash({ ...contract, intentHash: 'sha256:' + '0'.repeat(64) }), contract.intentHash);

// 2e. Algorithm-drift guard: pinned golden literal (see spec.md canonicalization rules).
const goldenContract = {
  kind: 'IntentContractV1',
  lineageId: 'golden-1',
  goal: 'g',
  nonGoals: [],
  invariants: ['i'],
  acceptanceCriteria: [{ id: 'AC-1', text: 't' }],
  declaredPaths: { allowed: ['a/**'] },
  baseSha: '0'.repeat(40),
  headSha: '1'.repeat(40),
};
assert.equal(intentHash(goldenContract), 'sha256:48eff27dde6b85ef2f531f23a13709eaf1fcd9b52a4e2e8567045bb6368bcf5e');

// ---- 3. diffHash vectors ----

// 3a. Pinned literal for an inline canonical patch.
const goldenPatch = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n';
assert.equal(diffHash(goldenPatch), 'sha256:ce4e4355ad4788f70a1f68697c3ce10d52bdf157bdf71fcd76c4478ec4a0b7e7');

// 3b. Empty diff (metadata-only HEAD change) hashes to the SHA-256 of the empty string.
assert.equal(EMPTY_DIFF_HASH, 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
assert.equal(diffHash(''), EMPTY_DIFF_HASH);

// 3c. Metadata independence: commit metadata is not an input; identical patch bytes
// produced by two different commits yield the same diffHash (clarify Q2).
assert.equal(diffHash(fixture.samplePatch), fixture.reviewReceipt.diffHash);
assert.throws(() => diffHash(undefined), TypeError);

// ---- 4. Binding consistency ----
assert.equal(fixture.reviewReceipt.intentHash, fixture.intentContract.intentHash, 'receipt must bind the frozen intentHash');
assert.equal(fixture.reviewReceipt.findingLedgerRef, fixture.findingLedger.ledgerId, 'receipt must reference the ledger');
assert.equal(fixture.findingLedger.lineageId, fixture.intentContract.lineageId, 'ledger must share the contract lineageId');
for (const finding of fixture.findingLedger.findings) {
  assert.equal(findingSignature(finding), finding.signature, `finding ${finding.findingId} signature must be self-consistent`);
  assert.ok(
    fixture.intentContract.acceptanceCriteria.some((c) => c.id === finding.criterionRef),
    `finding ${finding.findingId} criterionRef must map to an acceptance criterion`,
  );
}

// 4a. Algorithm-drift guard for finding signatures (evidence is trimmed + sorted
// before hashing; pinned literal prevents code/fixture co-drift).
assert.equal(
  findingSignature({ criterionRef: 'AC-9', category: 'regression', evidenceRefs: ['b.ts:2', 'a.ts:1'] }),
  'sha256:3b2d758e35f5538add0fd028b0d24bbacf3f850bbd8abb9ca31c251d4a580e50',
);

// ---- 5. Negative schema cases (fail closed) ----
assertInvalid('intentContract', { ...contract, goal: '' }, 'empty goal');
assertInvalid('intentContract', { ...contract, acceptanceCriteria: [] }, 'empty acceptanceCriteria');
assertInvalid('intentContract', { ...contract, headSha: '1358fb5' }, 'short headSha');
assertInvalid('intentContract', { ...contract, intentHash: 'abcd' }, 'non-sha256 intentHash');
assertInvalid('budget', { ...fixture.budget, maxReviewerRuns: 0 }, 'zero maxReviewerRuns');
assertInvalid('budget', { ...fixture.budget, onExhaustion: 'retry_forever' }, 'non-terminal exhaustion');
assertInvalid('findingLedger', {
  ...fixture.findingLedger,
  findings: [{ ...fixture.findingLedger.findings[0], findingId: 'X-1' }],
}, 'non-stable findingId');
assertInvalid('findingLedger', {
  ...fixture.findingLedger,
  findings: [{ ...fixture.findingLedger.findings[0], disposition: 'maybe' }],
}, 'unknown disposition');
assertInvalid('findingLedger', {
  ...fixture.findingLedger,
  findings: [{ ...fixture.findingLedger.findings[1], blocking: true }],
}, 'style finding must not be blocking (spec.md blocking rule / clarify Q3)');
assertInvalid('findingLedger', {
  ...fixture.findingLedger,
  findings: [{ ...fixture.findingLedger.findings[0], category: 'preference', blocking: true }],
}, 'preference finding must not be blocking');
assertInvalid('reviewReceipt', { ...fixture.reviewReceipt, diffHash: 'sha256:xyz' }, 'bad diffHash');
assertInvalid('reviewReceipt', { ...fixture.reviewReceipt, verdict: 'maybe' }, 'unknown verdict');
const { authorWorkerId: _drop, ...receiptWithoutAuthor } = fixture.reviewReceipt;
assertValid('reviewReceipt', receiptWithoutAuthor, 'receipt without optional authorWorkerId');

// 5a. Fail-closed core: additionalProperties:false and required must survive edits.
assertInvalid('intentContract', { ...contract, sneaky: true }, 'intentContract extra property');
const { goal: _noGoal, ...contractMissingGoal } = contract;
assertInvalid('intentContract', contractMissingGoal, 'intentContract missing required goal');
assertInvalid('budget', { ...fixture.budget, sneaky: true }, 'budget extra property');
const { onExhaustion: _noExhaustion, ...budgetMissingExhaustion } = fixture.budget;
assertInvalid('budget', budgetMissingExhaustion, 'budget missing required onExhaustion');
assertInvalid('findingLedger', { ...fixture.findingLedger, sneaky: true }, 'findingLedger extra property');
assertInvalid('findingLedger', {
  ...fixture.findingLedger,
  findings: [{ ...fixture.findingLedger.findings[0], sneaky: true }],
}, 'finding extra property');
assertInvalid('reviewReceipt', { ...fixture.reviewReceipt, sneaky: true }, 'reviewReceipt extra property');
const { note: _noNote, ...receiptMissingNote } = fixture.reviewReceipt;
assertInvalid('reviewReceipt', receiptMissingNote, 'reviewReceipt missing required note');

// ---- 6. Forbidden content scan ----
const forbiddenRuntimePaths = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/'];
const secretLikePatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];
for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(!fixtureText.includes(forbiddenPath), `fixture must not contain runtime path ${forbiddenPath}`);
}
for (const pattern of secretLikePatterns) {
  assert.ok(!pattern.test(fixtureText), `fixture must not contain secret-like content ${pattern}`);
}

console.log('bounded-pr-review-lifecycle conformance ok: schemas, intentHash/diffHash vectors, binding consistency, negative cases, forbidden content');

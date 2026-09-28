import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SYNTHETIC_FIXTURE_FINDINGS, partitionGitleaksFindings } from './secret-scan-allowlist.mjs';

const allowlist = new Map([['a/fixture.test.ts', { 'generic-api-key': 2 }]]);
const f = (File, RuleID) => ({ File, RuleID });

test('allows exact (file, rule) findings up to the maximum count', () => {
  const out = partitionGitleaksFindings([f('a/fixture.test.ts', 'generic-api-key'), f('./a/fixture.test.ts', 'generic-api-key')], allowlist);
  assert.equal(out.allowed.length, 2);
  assert.equal(out.disallowed.length, 0);
  assert.deepEqual(out.stale, []);
});

test('an extra finding of the same rule in an allowlisted file fails', () => {
  const out = partitionGitleaksFindings([1, 2, 3].map(() => f('a/fixture.test.ts', 'generic-api-key')), allowlist);
  assert.equal(out.allowed.length, 2);
  assert.equal(out.disallowed.length, 1);
});

test('a different rule in an allowlisted file fails (file-only allowlisting is gone)', () => {
  const out = partitionGitleaksFindings([f('a/fixture.test.ts', 'aws-access-token')], allowlist);
  assert.equal(out.disallowed.length, 1);
  assert.deepEqual(out.stale, [{ file: 'a/fixture.test.ts', rule: 'generic-api-key' }]);
});

test('unlisted files and broad-path lookalikes fail', () => {
  const out = partitionGitleaksFindings([f('a/other.test.ts', 'generic-api-key'), f('dist/a/fixture.test.ts', 'generic-api-key')], allowlist);
  assert.equal(out.disallowed.length, 2);
});

test('the shipped allowlist never keys on broad paths or Secret values', () => {
  for (const [file, rules] of SYNTHETIC_FIXTURE_FINDINGS) {
    assert.doesNotMatch(file, /(^|\/)dist\//, file);
    assert.doesNotMatch(file, /[*?]/, file);
    for (const [rule, max] of Object.entries(rules)) {
      assert.ok(rule.length > 0 && Number.isInteger(max) && max > 0, `${file} ${rule}`);
    }
  }
});

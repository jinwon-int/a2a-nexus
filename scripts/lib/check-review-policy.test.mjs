import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateReviewPolicy } from './check-review-policy.mjs';

const OK = [
  '# Governance',
  '',
  '## Review policy',
  '',
  '- Author-independent review: the author cannot be the sole approver; the reviewer must be distinct from the author.',
  '- A backup reviewer covers reviewer unavailability.',
  '- Review-evidence cardinality and closeout completeness are preferred over pull-request velocity.',
  '- Definitions: [metrics](docs/ops/repository-health-metrics.md).',
  '',
  '## Roles and authority',
  '',
  'Body.',
].join('\n');

test('GREEN: a complete Review policy section passes', () => {
  assert.deepEqual(evaluateReviewPolicy(OK), []);
});

test('RED: missing Review policy section fails', () => {
  const text = '# Governance\n\n## Roles and authority\n\nBody.';
  const failures = evaluateReviewPolicy(text);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /missing a "## Review policy" section/);
});

test('RED: missing author-independent commitment fails', () => {
  const text = OK.replace(
    '- Author-independent review: the author cannot be the sole approver; the reviewer must be distinct from the author.',
    '- Reviews happen.',
  );
  assert.match(evaluateReviewPolicy(text).join('\n'), /author-independent review/);
});

test('RED: missing backup reviewer fails', () => {
  const text = OK.replace('- A backup reviewer covers reviewer unavailability.', '- One reviewer only.');
  assert.match(evaluateReviewPolicy(text).join('\n'), /backup reviewer path/);
});

test('RED: missing evidence-over-velocity fails', () => {
  const text = OK.replace(
    '- Review-evidence cardinality and closeout completeness are preferred over pull-request velocity.',
    '- Ship fast.',
  );
  assert.match(evaluateReviewPolicy(text).join('\n'), /review-evidence cardinality \/ closeout completeness is preferred over pull-request velocity/);
});

test('RED: stating the preference without linking the metric definition fails', () => {
  const text = OK.replace('- Definitions: [metrics](docs/ops/repository-health-metrics.md).', '- Definitions: TBD.');
  assert.match(evaluateReviewPolicy(text).join('\n'), /must link the measurable metric definition/);
});

test('edge: missing GOVERNANCE returns a single missing failure', () => {
  assert.deepEqual(evaluateReviewPolicy(null), ['missing GOVERNANCE.md']);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateWarnLogs } from './a2a-warn-log-aggregate.mjs';

test('aggregateWarnLogs counts readiness and projection warnings without exposing secrets', () => {
  const result = aggregateWarnLogs([
    {
      name: 'broker.log',
      text: [
        '[a2a-broker] task readiness spec_underspecified { taskId: "a" } EDGE_SECRET=super-secret',
        '[a2a-broker] task readiness source_projection_empty { taskId: "b" } token=secret-token',
        'worker failed source_projection_blocked quality=zero_files',
        'adapter openclaw_analysis_failed',
        'acceptance_malformed',
      ].join('\n'),
    },
  ]);
  const entry = result['broker.log'];
  assert.equal(entry.lines, 5);
  assert.equal(entry['task readiness spec_underspecified'], 1);
  assert.equal(entry['task readiness source_projection_empty'], 1);
  assert.equal(entry.source_projection_blocked, 1);
  assert.equal(entry.openclaw_analysis_failed, 1);
  assert.equal(entry.acceptance_malformed, 1);
  assert.equal(entry.samples.length, 3);
  assert.ok(entry.samples.every((line) => !line.includes('super-secret')));
  assert.ok(entry.samples.every((line) => !line.includes('secret-token')));
  assert.ok(entry.samples.some((line) => line.includes('EDGE_SECRET=[REDACTED]')));
  assert.ok(entry.samples.some((line) => line.includes('token=[REDACTED]')));
});

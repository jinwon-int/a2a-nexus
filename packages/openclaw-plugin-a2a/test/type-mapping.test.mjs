import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isBrokerTimeoutCode,
  mapBrokerErrorToTaskError,
  mapBrokerStatusToDeliveryStatus,
  mapBrokerStatusToExecutionStatus,
  mapBrokerStatusToReceiptStatus,
  isTerminalReceiptStatus,
  resolveCancelTarget,
} from '../dist/type-mapping.js';

test('type mapping keeps current broker-to-openclaw contract stable', () => {
  assert.equal(mapBrokerStatusToExecutionStatus({ brokerStatus: 'queued' }), 'accepted');
  assert.equal(mapBrokerStatusToExecutionStatus({ brokerStatus: 'claimed' }), 'accepted');
  assert.equal(mapBrokerStatusToExecutionStatus({ brokerStatus: 'running' }), 'running');
  assert.equal(mapBrokerStatusToExecutionStatus({ brokerStatus: 'succeeded' }), 'completed');
  assert.equal(
    mapBrokerStatusToExecutionStatus({ brokerStatus: 'failed', brokerErrorCode: 'timed_out' }),
    'timed_out',
  );
  assert.equal(mapBrokerStatusToExecutionStatus({ brokerStatus: 'failed' }), 'failed');

  assert.equal(mapBrokerStatusToDeliveryStatus('queued'), 'pending');
  assert.equal(mapBrokerStatusToDeliveryStatus('running'), 'pending');
  assert.equal(mapBrokerStatusToDeliveryStatus('succeeded'), 'skipped');
  assert.equal(mapBrokerStatusToDeliveryStatus('canceled'), 'skipped');

  assert.deepEqual(
    mapBrokerErrorToTaskError({ brokerStatus: 'failed', brokerErrorMessage: 'boom' }),
    { code: 'remote_task_failed', message: 'boom' },
  );
  assert.equal(isBrokerTimeoutCode(' timeout '), true);
  assert.equal(isBrokerTimeoutCode('other'), false);
});

test('blocked broker status maps to accepted (A2A has no first-class blocked status)', () => {
  assert.equal(mapBrokerStatusToExecutionStatus({ brokerStatus: 'blocked' }), 'accepted');
  // Evidence-only and no-change outcomes are terminal "succeeded" tasks.
  // The distinction is carried in metadata.evidenceRefs (blockUrl/doneUrl).
  assert.equal(mapBrokerStatusToExecutionStatus({ brokerStatus: 'succeeded' }), 'completed');
});

test('receipt status separates provider-accepted from operator-visible', () => {
  // Pending: broker hasn't accepted yet
  assert.equal(
    mapBrokerStatusToReceiptStatus({ brokerStatus: 'queued' }),
    'pending',
  );
  assert.equal(
    mapBrokerStatusToReceiptStatus({ brokerStatus: 'blocked' }),
    'pending',
  );

  // Accepted: broker claimed/running — provider level, not operator-visible
  assert.equal(
    mapBrokerStatusToReceiptStatus({ brokerStatus: 'claimed' }),
    'accepted',
  );
  assert.equal(
    mapBrokerStatusToReceiptStatus({ brokerStatus: 'running' }),
    'accepted',
  );

  // Provider-delivered: broker says succeeded, but no operator confirmation
  assert.equal(
    mapBrokerStatusToReceiptStatus({ brokerStatus: 'succeeded' }),
    'provider_delivered_if_known',
  );

  // Operator-visible: broker succeeded AND delivery confirmation evidence exists
  assert.equal(
    mapBrokerStatusToReceiptStatus({
      brokerStatus: 'succeeded',
      deliveryConfirmation: true,
    }),
    'operator_visible',
  );

  // Failed task
  assert.equal(
    mapBrokerStatusToReceiptStatus({ brokerStatus: 'failed' }),
    'failed',
  );

  // Cancelled task
  assert.equal(
    mapBrokerStatusToReceiptStatus({ brokerStatus: 'canceled' }),
    'failed',
  );
});

test('receipt status maps timeout and stale-session independently of broker status', () => {
  // Timed out overrides broker status
  assert.equal(
    mapBrokerStatusToReceiptStatus({
      brokerStatus: 'running',
      timedOut: true,
    }),
    'timed_out',
  );

  // Stale session overrides broker status
  assert.equal(
    mapBrokerStatusToReceiptStatus({
      brokerStatus: 'claimed',
      staleSession: true,
    }),
    'stale',
  );
});

test('terminal receipt status check', () => {
  assert.equal(isTerminalReceiptStatus('operator_visible'), true);
  assert.equal(isTerminalReceiptStatus('timed_out'), true);
  assert.equal(isTerminalReceiptStatus('stale'), true);
  assert.equal(isTerminalReceiptStatus('failed'), true);

  assert.equal(isTerminalReceiptStatus('pending'), false);
  assert.equal(isTerminalReceiptStatus('accepted'), false);
  assert.equal(isTerminalReceiptStatus('provider_delivered_if_known'), false);
  assert.equal(isTerminalReceiptStatus('none'), false);
});

test('cancel target resolution prefers explicit payloads but can backfill from session/run ids', () => {
  assert.deepEqual(
    resolveCancelTarget({
      explicit: { kind: 'session_run', sessionKey: 'session-a', runId: 'run-1' },
      targetSessionKey: 'ignored',
      runId: 'ignored',
    }),
    { kind: 'session_run', sessionKey: 'session-a', runId: 'run-1' },
  );

  assert.deepEqual(
    resolveCancelTarget({ targetSessionKey: 'session-b', runId: 'run-2' }),
    { kind: 'session_run', sessionKey: 'session-b', runId: 'run-2' },
  );

  assert.equal(resolveCancelTarget({}), undefined);
});

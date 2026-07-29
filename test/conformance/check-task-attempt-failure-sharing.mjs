#!/usr/bin/env node
// Deterministic, no-network conformance for Task Attempt Failure Sharing V1.
// Source-only: validates a synthetic fixture and pure advisory projections.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'contract', 'task-attempt-failure-sharing.json');
const THIS_PATH = path.join(ROOT, 'test', 'conformance', 'check-task-attempt-failure-sharing.mjs');

const FRAME_HEADER = Buffer.from('A2A-TAFS-FRAME-V1\0', 'ascii');
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BROKER_ID_PATTERN = /^brk_[0-9a-f]{16}$/;
const TASK_ID_PATTERN = /^tsk_[0-9a-f]{32}$/;
const EXPERIMENT_ID_PATTERN = /^exp_[0-9a-f]{32}$/;
const HYPOTHESIS_ID_PATTERN = /^hyp_[0-9a-f]{32}$/;

const PRODUCERS = Object.freeze({
  broker_execution: Object.freeze({
    producerContract: 'a2a.broker-execution.v1',
    identityDigestDomain: 'a2a.task-attempt-record.v1.identity.broker-execution',
    fingerprintDigestDomain: 'a2a.task-attempt-record.v1.fingerprint.broker-execution',
  }),
  bounded_experiment: Object.freeze({
    producerContract: 'a2a.bounded-experiment.v1',
    identityDigestDomain: 'a2a.task-attempt-record.v1.identity.bounded-experiment',
    fingerprintDigestDomain: 'a2a.task-attempt-record.v1.fingerprint.bounded-experiment',
  }),
});

const BROKER_REASONS = Object.freeze({
  failed: Object.freeze({
    execution_failure: Object.freeze(['producer_reported_failure']),
    dependency_failure: Object.freeze(['dependency_unavailable']),
    resource_exhaustion: Object.freeze(['limit_exceeded']),
    contract_rejection: Object.freeze(['invalid_request']),
  }),
  canceled: Object.freeze({
    cancellation: Object.freeze(['before_start', 'during_execution']),
  }),
  superseded: Object.freeze({
    supersession: Object.freeze(['newer_attempt']),
  }),
});

const EXPERIMENT_REASONS = Object.freeze({
  discard: Object.freeze({
    measurement_result: Object.freeze(['no_improvement', 'regression']),
    measurement_validity: Object.freeze(['invalid_measurement']),
  }),
  crash: Object.freeze({
    execution_crash: Object.freeze(['process_exit']),
    resource_exhaustion: Object.freeze(['limit_exceeded']),
    dependency_failure: Object.freeze(['dependency_unavailable']),
  }),
});

const COMMON_RECORD_FIELDS = Object.freeze([
  'attemptOrdinal',
  'brokerOfRecord',
  'fingerprint',
  'fingerprintDigestDomain',
  'identityDigestDomain',
  'kind',
  'producerContract',
  'producerKind',
  'recordKey',
  'retryRootTaskId',
  'taskId',
  'version',
]);

const EXPECTED_CASES = Object.freeze([
  {
    caseId: 'broker_failure_then_retry_success',
    operation: 'validate_sequence',
    recordIndexes: [0, 1],
    mutations: [],
    expected: 'accepted_sequence',
  },
  {
    caseId: 'experiment_discard_then_keep',
    operation: 'validate_sequence',
    recordIndexes: [2, 3],
    mutations: [],
    expected: 'accepted_sequence',
  },
  {
    caseId: 'experiment_crash_stable_class_only',
    operation: 'validate_record',
    recordIndexes: [4],
    mutations: [],
    expected: 'crash_class_only',
  },
  {
    caseId: 'exact_idempotent_replay',
    operation: 'ingest_sequence',
    recordIndexes: [0, 0],
    mutations: [],
    expected: 'idempotent_replay',
  },
  {
    caseId: 'same_key_changed_payload_conflict',
    operation: 'ingest_mutation',
    recordIndexes: [0],
    mutations: ['changed_payload'],
    expected: 'same_key_payload_conflict',
  },
  {
    caseId: 'malformed_free_form_identity_rejection',
    operation: 'reject_mutations',
    recordIndexes: [0],
    mutations: ['malformed_identity'],
    expected: 'contract_rejected',
  },
  {
    caseId: 'domain_outcome_vocabulary_mismatch_rejection',
    operation: 'reject_mutations',
    recordIndexes: [0, 2],
    mutations: [
      'wrong_identity_domain',
      'wrong_fingerprint_domain',
      'cross_vocabulary',
    ],
    expected: 'contract_rejected',
  },
  {
    caseId: 'unknown_extra_private_field_rejection',
    operation: 'reject_mutations',
    recordIndexes: [0],
    mutations: [
      'missing_required',
      'malformed_type',
      'unknown_version',
      'extra_field',
      'private_field',
    ],
    expected: 'contract_rejected',
  },
  {
    caseId: 'deterministic_canonical_fingerprint_verification',
    operation: 'verify_digests',
    recordIndexes: [0, 1, 2, 3, 4],
    mutations: [],
    expected: 'fingerprints_verified',
  },
  {
    caseId: 'advisory_preflight_prior_failures_no_automatic_deny',
    operation: 'verify_advisory_preflight',
    recordIndexes: [2],
    mutations: [],
    expected: 'advisory_without_deny',
  },
]);

// Independent literals prevent the fixture and digest implementation from
// drifting together unnoticed.
const PINNED_DIGESTS = Object.freeze([
  Object.freeze({
    recordKey: 'sha256:48e482d003d6f47b2a3e903f956a1785887ce089217b4bcaab105543f9a80342',
    fingerprint: 'sha256:48df7c9ce869849c8474bd59942b7a2120f502fe3438642f6755fe251ab2a64b',
  }),
  Object.freeze({
    recordKey: 'sha256:85d022f8c8202e226ed3cacdef217ca99af1dbe212872251249065576b187fed',
    fingerprint: 'sha256:3722d0eedc7e6b145ff947c098cdd3cbbd0b33cfa2f1f8c626580499ef1eb0df',
  }),
  Object.freeze({
    recordKey: 'sha256:646c0549036f876dc2acfad38898657ac99f76b916f473bf8378dc2d09f5ac65',
    fingerprint: 'sha256:499498e091d51f515789ad4f15308e136eb5be7febd93a4c40c81a2d3d767420',
  }),
  Object.freeze({
    recordKey: 'sha256:4e48269d22211fb8ef8db2dd0694d511a793e3c56e27557777255d96c0e55430',
    fingerprint: 'sha256:42363092e624685a15c91a510b8c3fc30cdebb1dce01552649e72587b4a05972',
  }),
  Object.freeze({
    recordKey: 'sha256:eda62d79860862f46a033bd1589d0f4b4024d34de2d8e2e97323c1171a0d86ad',
    fingerprint: 'sha256:e08817cdbe01ad924ec72193f5c7a8641c8eea93b9b05a8b6a6e59eacc51c83f',
  }),
]);

class ContractError extends Error {}

function reject(message) {
  throw new ContractError(message);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertClosed(value, expectedFields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject(`${label} must be an object`);
  }
  const expected = [...expectedFields].sort();
  const actual = sortedKeys(value);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject(`${label} fields differ: ${JSON.stringify(actual)}`);
  }
}

function assertAsciiString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !/^[\x20-\x7e]+$/.test(value)) {
    reject(`${label} must be non-empty printable ASCII`);
  }
}

function assertPattern(value, pattern, label) {
  assertAsciiString(value, label);
  if (!pattern.test(value)) reject(`${label} has invalid form`);
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (!/^[\x20-\x7e]*$/.test(value)) reject('canonical strings must be ASCII');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) reject('canonical numbers must be safe integers');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${sortedKeys(value)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  reject('unsupported canonical value');
}

function u32be(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    reject('frame length outside uint32');
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function framedDigest(domain, payload) {
  assertAsciiString(domain, 'digest domain');
  const domainBytes = Buffer.from(domain, 'utf8');
  const payloadBytes = Buffer.from(canonicalize(payload), 'utf8');
  const frame = Buffer.concat([
    FRAME_HEADER,
    u32be(domainBytes.length),
    domainBytes,
    u32be(payloadBytes.length),
    payloadBytes,
  ]);
  return `sha256:${createHash('sha256').update(frame).digest('hex')}`;
}

function identityPayload(record) {
  const common = {
    kind: record.kind,
    version: record.version,
    producerKind: record.producerKind,
    producerContract: record.producerContract,
    brokerOfRecord: record.brokerOfRecord,
    taskId: record.taskId,
    retryRootTaskId: record.retryRootTaskId,
    attemptOrdinal: record.attemptOrdinal,
  };
  if (record.producerKind === 'bounded_experiment') {
    return {
      ...common,
      experimentId: record.experimentId,
      hypothesisId: record.hypothesisId,
    };
  }
  return common;
}

function recordKeyFor(record) {
  return framedDigest(record.identityDigestDomain, identityPayload(record));
}

function fingerprintPayload(record) {
  const { fingerprint: _excluded, ...payload } = record;
  return payload;
}

function fingerprintFor(record) {
  return framedDigest(record.fingerprintDigestDomain, fingerprintPayload(record));
}

function reasonFieldsFor(record) {
  return [
    ...(Object.hasOwn(record, 'reasonClass') ? ['reasonClass'] : []),
    ...(Object.hasOwn(record, 'reasonCode') ? ['reasonCode'] : []),
  ];
}

function validateReason(record, vocabulary, { codeOptional = false } = {}) {
  assertAsciiString(record.reasonClass, 'reasonClass');
  const codes = vocabulary[record.reasonClass];
  if (!codes) reject('unknown reasonClass');
  if (!Object.hasOwn(record, 'reasonCode')) {
    if (!codeOptional) reject('reasonCode is required');
    return;
  }
  assertAsciiString(record.reasonCode, 'reasonCode');
  if (!codes.includes(record.reasonCode)) reject('reasonCode does not match reasonClass');
}

function validateRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    reject('record must be an object');
  }

  if (record.kind !== 'TaskAttemptRecordV1') reject('unknown record kind');
  if (record.version !== 1) reject('unknown record version');
  const producer = PRODUCERS[record.producerKind];
  if (!producer) reject('unknown producer kind');

  const variantFields = record.producerKind === 'broker_execution'
    ? ['brokerOutcome']
    : ['experimentDisposition', 'experimentId', 'hypothesisId'];
  assertClosed(
    record,
    [...COMMON_RECORD_FIELDS, ...variantFields, ...reasonFieldsFor(record)],
    'TaskAttemptRecordV1',
  );

  if (record.producerContract !== producer.producerContract) reject('producer contract mismatch');
  if (record.identityDigestDomain !== producer.identityDigestDomain) reject('identity domain mismatch');
  if (record.fingerprintDigestDomain !== producer.fingerprintDigestDomain) reject('fingerprint domain mismatch');

  assertPattern(record.brokerOfRecord, BROKER_ID_PATTERN, 'brokerOfRecord');
  assertPattern(record.taskId, TASK_ID_PATTERN, 'taskId');
  assertPattern(record.retryRootTaskId, TASK_ID_PATTERN, 'retryRootTaskId');
  if (!Number.isInteger(record.attemptOrdinal)
    || record.attemptOrdinal < 1
    || record.attemptOrdinal > 1024) {
    reject('attemptOrdinal outside 1..1024');
  }

  if (record.producerKind === 'broker_execution') {
    if (!['succeeded', 'failed', 'canceled', 'superseded'].includes(record.brokerOutcome)) {
      reject('unknown broker outcome');
    }
    if (record.brokerOutcome === 'succeeded') {
      if (reasonFieldsFor(record).length !== 0) reject('succeeded must not have reason fields');
    } else {
      validateReason(record, BROKER_REASONS[record.brokerOutcome]);
    }
  } else {
    assertPattern(record.experimentId, EXPERIMENT_ID_PATTERN, 'experimentId');
    assertPattern(record.hypothesisId, HYPOTHESIS_ID_PATTERN, 'hypothesisId');
    if (!['keep', 'discard', 'crash'].includes(record.experimentDisposition)) {
      reject('unknown experiment disposition');
    }
    if (record.experimentDisposition === 'keep') {
      if (reasonFieldsFor(record).length !== 0) reject('keep must not have reason fields');
    } else {
      validateReason(
        record,
        EXPERIMENT_REASONS[record.experimentDisposition],
        { codeOptional: record.experimentDisposition === 'crash' },
      );
    }
  }

  assertPattern(record.recordKey, DIGEST_PATTERN, 'recordKey');
  assertPattern(record.fingerprint, DIGEST_PATTERN, 'fingerprint');
  if (record.recordKey !== recordKeyFor(record)) reject('recordKey mismatch');
  if (record.fingerprint !== fingerprintFor(record)) reject('fingerprint mismatch');
  return record;
}

function validateCompleteSequence(records) {
  if (!Array.isArray(records) || records.length < 1 || records.length > 64) {
    reject('sequence count outside 1..64');
  }
  records.forEach(validateRecord);
  const ordered = [...records].sort((a, b) => a.attemptOrdinal - b.attemptOrdinal);
  if (ordered[0].attemptOrdinal !== 1) reject('complete sequence must start at ordinal 1');
  if (ordered[0].taskId !== ordered[0].retryRootTaskId) reject('ordinal 1 must be retry root');
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].attemptOrdinal !== index + 1) reject('ordinals must be unique and contiguous');
  }
  const first = ordered[0];
  for (const record of ordered) {
    for (const field of ['producerKind', 'producerContract', 'brokerOfRecord', 'retryRootTaskId']) {
      if (record[field] !== first[field]) reject(`retry sequence changed ${field}`);
    }
    if (first.producerKind === 'bounded_experiment') {
      for (const field of ['experimentId', 'hypothesisId']) {
        if (record[field] !== first[field]) reject(`experiment sequence changed ${field}`);
      }
    }
  }
  return ordered;
}

function isFailureChannelEligible(record) {
  return record.producerKind === 'broker_execution'
    ? ['failed', 'canceled', 'superseded'].includes(record.brokerOutcome)
    : ['discard', 'crash'].includes(record.experimentDisposition);
}

function projectEntry(record) {
  validateRecord(record);
  if (!isFailureChannelEligible(record)) reject('record is not failure-channel eligible');
  const common = {
    kind: 'TaskAttemptFailureProjectionEntryV1',
    version: 1,
    producerKind: record.producerKind,
    producerContract: record.producerContract,
    brokerOfRecord: record.brokerOfRecord,
    taskId: record.taskId,
    retryRootTaskId: record.retryRootTaskId,
    attemptOrdinal: record.attemptOrdinal,
    recordKey: record.recordKey,
    fingerprint: record.fingerprint,
  };
  const result = record.producerKind === 'broker_execution'
    ? { brokerOutcome: record.brokerOutcome }
    : {
        experimentId: record.experimentId,
        hypothesisId: record.hypothesisId,
        experimentDisposition: record.experimentDisposition,
      };
  return {
    ...common,
    ...result,
    reasonClass: record.reasonClass,
    ...(Object.hasOwn(record, 'reasonCode') ? { reasonCode: record.reasonCode } : {}),
  };
}

function entrySortTuple(entry) {
  return [
    entry.producerKind,
    entry.brokerOfRecord,
    entry.retryRootTaskId,
    entry.experimentId ?? '',
    entry.hypothesisId ?? '',
    String(entry.attemptOrdinal).padStart(4, '0'),
    entry.recordKey,
  ].join('\0');
}

function compareEntries(left, right) {
  const leftTuple = entrySortTuple(left);
  const rightTuple = entrySortTuple(right);
  return leftTuple < rightTuple ? -1 : leftTuple > rightTuple ? 1 : 0;
}

function buildFailureChannelProjection(records) {
  const entries = records
    .map(validateRecord)
    .filter(isFailureChannelEligible)
    .map(projectEntry)
    .sort(compareEntries);
  if (entries.length > 64) reject('projection count exceeds 64');
  return {
    kind: 'TaskAttemptFailureChannelProjectionV1',
    version: 1,
    viewMode: 'read_only_advisory',
    entries,
  };
}

function validateProjectionEntry(entry) {
  const variantFields = entry.producerKind === 'broker_execution'
    ? ['brokerOutcome']
    : ['experimentDisposition', 'experimentId', 'hypothesisId'];
  assertClosed(
    entry,
    [
      'attemptOrdinal',
      'brokerOfRecord',
      'fingerprint',
      'kind',
      'producerContract',
      'producerKind',
      'reasonClass',
      'recordKey',
      'retryRootTaskId',
      'taskId',
      'version',
      ...variantFields,
      ...(Object.hasOwn(entry, 'reasonCode') ? ['reasonCode'] : []),
    ],
    'TaskAttemptFailureProjectionEntryV1',
  );
  if (entry.kind !== 'TaskAttemptFailureProjectionEntryV1' || entry.version !== 1) {
    reject('projection entry kind/version mismatch');
  }
  assertPattern(entry.recordKey, DIGEST_PATTERN, 'projection recordKey');
  assertPattern(entry.fingerprint, DIGEST_PATTERN, 'projection fingerprint');
  assertPattern(entry.brokerOfRecord, BROKER_ID_PATTERN, 'projection brokerOfRecord');
  assertPattern(entry.taskId, TASK_ID_PATTERN, 'projection taskId');
  assertPattern(entry.retryRootTaskId, TASK_ID_PATTERN, 'projection retryRootTaskId');
  if (!Number.isInteger(entry.attemptOrdinal)
    || entry.attemptOrdinal < 1
    || entry.attemptOrdinal > 1024) {
    reject('projection attemptOrdinal outside 1..1024');
  }
  const producer = PRODUCERS[entry.producerKind];
  if (!producer || entry.producerContract !== producer.producerContract) {
    reject('projection producer binding mismatch');
  }
  if (entry.producerKind === 'broker_execution') {
    if (!['failed', 'canceled', 'superseded'].includes(entry.brokerOutcome)) {
      reject('projection broker outcome is not eligible');
    }
    validateReason(entry, BROKER_REASONS[entry.brokerOutcome]);
  } else if (entry.producerKind === 'bounded_experiment') {
    assertPattern(entry.experimentId, EXPERIMENT_ID_PATTERN, 'projection experimentId');
    assertPattern(entry.hypothesisId, HYPOTHESIS_ID_PATTERN, 'projection hypothesisId');
    if (!['discard', 'crash'].includes(entry.experimentDisposition)) {
      reject('projection experiment disposition is not eligible');
    }
    validateReason(
      entry,
      EXPERIMENT_REASONS[entry.experimentDisposition],
      { codeOptional: entry.experimentDisposition === 'crash' },
    );
  } else {
    reject('projection producer kind mismatch');
  }
}

function validateFailureChannelProjection(projection) {
  assertClosed(
    projection,
    ['entries', 'kind', 'version', 'viewMode'],
    'TaskAttemptFailureChannelProjectionV1',
  );
  if (projection.kind !== 'TaskAttemptFailureChannelProjectionV1'
    || projection.version !== 1
    || projection.viewMode !== 'read_only_advisory') {
    reject('failure-channel projection header mismatch');
  }
  if (!Array.isArray(projection.entries) || projection.entries.length > 64) {
    reject('failure-channel projection count outside 0..64');
  }
  projection.entries.forEach(validateProjectionEntry);
  const sorted = [...projection.entries].sort(compareEntries);
  if (canonicalize(sorted) !== canonicalize(projection.entries)) {
    reject('failure-channel entries are not canonically ordered');
  }
}

function buildPreflight(records, query) {
  const experimentQuery = query.producerKind === 'bounded_experiment';
  assertClosed(
    query,
    [
      'brokerOfRecord',
      'candidateAttemptOrdinal',
      ...(experimentQuery ? ['experimentId', 'hypothesisId'] : []),
      'kind',
      'producerContract',
      'producerKind',
      'retryRootTaskId',
      'version',
    ],
    'TaskAttemptHistoryQueryV1',
  );
  if (query.kind !== 'TaskAttemptHistoryQueryV1' || query.version !== 1) {
    reject('preflight query kind/version mismatch');
  }
  const producer = PRODUCERS[query.producerKind];
  if (!producer || producer.producerContract !== query.producerContract) {
    reject('preflight producer binding mismatch');
  }
  assertPattern(query.brokerOfRecord, BROKER_ID_PATTERN, 'preflight brokerOfRecord');
  assertPattern(query.retryRootTaskId, TASK_ID_PATTERN, 'preflight retryRootTaskId');
  if (!Number.isInteger(query.candidateAttemptOrdinal)
    || query.candidateAttemptOrdinal < 1
    || query.candidateAttemptOrdinal > 1024) {
    reject('preflight candidate ordinal outside 1..1024');
  }
  if (experimentQuery) {
    assertPattern(query.experimentId, EXPERIMENT_ID_PATTERN, 'preflight experimentId');
    assertPattern(query.hypothesisId, HYPOTHESIS_ID_PATTERN, 'preflight hypothesisId');
  }

  const priorFailures = records
    .map(validateRecord)
    .filter((record) => record.producerKind === query.producerKind)
    .filter((record) => record.producerContract === query.producerContract)
    .filter((record) => record.brokerOfRecord === query.brokerOfRecord)
    .filter((record) => record.retryRootTaskId === query.retryRootTaskId)
    .filter((record) => record.attemptOrdinal < query.candidateAttemptOrdinal)
    .filter((record) => !experimentQuery
      || (record.experimentId === query.experimentId && record.hypothesisId === query.hypothesisId))
    .filter(isFailureChannelEligible)
    .map(projectEntry)
    .sort(compareEntries);
  if (priorFailures.length > 32) reject('preflight prior failure count exceeds 32');

  return {
    kind: 'TaskAttemptHistoryPreflightResponseV1',
    version: 1,
    viewMode: 'read_only_advisory',
    query,
    priorFailures,
    automaticDeny: false,
    retryAuthority: 'not_provided',
    finalizerVerdict: 'not_provided',
    successEvidence: false,
    automaticDispatchPolicy: 'none',
  };
}

function validatePreflight(preflight, sourceRecords) {
  assertClosed(
    preflight,
    [
      'automaticDeny',
      'automaticDispatchPolicy',
      'finalizerVerdict',
      'kind',
      'priorFailures',
      'query',
      'retryAuthority',
      'successEvidence',
      'version',
      'viewMode',
    ],
    'TaskAttemptHistoryPreflightResponseV1',
  );
  if (preflight.kind !== 'TaskAttemptHistoryPreflightResponseV1'
    || preflight.version !== 1
    || preflight.viewMode !== 'read_only_advisory') {
    reject('preflight header mismatch');
  }
  if (preflight.automaticDeny !== false
    || preflight.retryAuthority !== 'not_provided'
    || preflight.finalizerVerdict !== 'not_provided'
    || preflight.successEvidence !== false
    || preflight.automaticDispatchPolicy !== 'none') {
    reject('preflight attempted to grant authority');
  }
  if (!Array.isArray(preflight.priorFailures) || preflight.priorFailures.length > 32) {
    reject('preflight prior failure count outside 0..32');
  }
  preflight.priorFailures.forEach(validateProjectionEntry);
  const rebuilt = buildPreflight(sourceRecords, preflight.query);
  assert.deepEqual(preflight, rebuilt, 'preflight must match the source records');
}

class ReplayLedger {
  #records = new Map();

  get size() {
    return this.#records.size;
  }

  ingest(record) {
    validateRecord(record);
    const canonical = canonicalize(record);
    const existing = this.#records.get(record.recordKey);
    if (!existing) {
      this.#records.set(record.recordKey, {
        canonical,
        fingerprint: record.fingerprint,
      });
      return 'accepted';
    }
    if (existing.canonical === canonical && existing.fingerprint === record.fingerprint) {
      return 'idempotent_replay';
    }
    return 'same_key_payload_conflict';
  }
}

function assertContractRejected(candidate, label) {
  assert.throws(() => validateRecord(candidate), ContractError, label);
}

function changedPayload(record) {
  const changed = {
    ...record,
    reasonClass: 'execution_failure',
    reasonCode: 'producer_reported_failure',
  };
  changed.fingerprint = fingerprintFor(changed);
  return changed;
}

function validateFixtureSafety(value) {
  const prohibitedKeys = new Set([
    ['raw', 'Detail'].join(''),
    ['raw', 'Error'].join(''),
    ['raw', 'Reason'].join(''),
    ['reason', 'Text'].join(''),
    'message',
    'prompt',
    'payload',
    ['claim', 'Text'].join(''),
    'credentials',
    'path',
    'url',
    ['requester', 'Id'].join(''),
    ['provider', 'Id'].join(''),
    ['worker', 'Id'].join(''),
    ['person', 'Id'].join(''),
    'labels',
    'metadata',
    'extensions',
    ['created', 'At'].join(''),
    ['updated', 'At'].join(''),
    'timestamp',
    ['attempt', 'Id'].join(''),
  ]);
  const secretPatterns = [
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  const privateValuePatterns = [
    /(?:https?|file):\/\//i,
    /(?:^|[\s"'(])\/(?:home|Users|work|etc)\//,
    /\b[A-Za-z]:\\/,
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  ];

  function visit(item) {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        assert.equal(prohibitedKeys.has(key), false, `fixture contains prohibited key ${key}`);
        visit(child);
      }
      return;
    }
    if (typeof item === 'string') {
      for (const pattern of [...secretPatterns, ...privateValuePatterns]) {
        assert.equal(pattern.test(item), false, `fixture contains prohibited value shape ${pattern}`);
      }
    }
  }

  visit(value);
}

function validateNoNetworkImports() {
  const source = readFileSync(THIS_PATH, 'utf8');
  const importSpecifiers = [...source.matchAll(/^\s*import(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"];?$/gm)]
    .map((match) => match[1]);
  assert.ok(importSpecifiers.length >= 1, 'checker import scan must find built-ins');
  for (const specifier of importSpecifiers) {
    assert.match(specifier, /^node:/, `non-built-in import forbidden: ${specifier}`);
  }
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'network fetch is forbidden');
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|dns|dgram)\b/, 'network built-ins are forbidden');
}

function validateCaseShape(testCase) {
  assertClosed(
    testCase,
    ['caseId', 'expected', 'mutations', 'operation', 'recordIndexes'],
    'fixture case',
  );
  assertAsciiString(testCase.caseId, 'caseId');
  assertAsciiString(testCase.operation, 'operation');
  assertAsciiString(testCase.expected, 'expected');
  if (!Array.isArray(testCase.recordIndexes)
    || testCase.recordIndexes.length < 1
    || testCase.recordIndexes.length > 5
    || !testCase.recordIndexes.every((index) => Number.isInteger(index) && index >= 0 && index <= 4)) {
    reject('case recordIndexes outside fixture bounds');
  }
  if (!Array.isArray(testCase.mutations) || testCase.mutations.length > 5) {
    reject('case mutations outside 0..5');
  }
  testCase.mutations.forEach((mutation) => assertAsciiString(mutation, 'mutation'));
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
assertClosed(
  fixture,
  [
    'cases',
    'dispatcherPreflight',
    'failureChannelProjection',
    'fixtureKind',
    'fixtureVersion',
    'records',
  ],
  'TaskAttemptFailureSharingFixtureV1',
);
assert.equal(fixture.fixtureKind, 'TaskAttemptFailureSharingFixtureV1');
assert.equal(fixture.fixtureVersion, 1);
assert.ok(Array.isArray(fixture.records));
assert.equal(fixture.records.length, 5);
assert.ok(Array.isArray(fixture.cases));
assert.equal(fixture.cases.length, EXPECTED_CASES.length);
fixture.cases.forEach(validateCaseShape);
assert.deepEqual(fixture.cases, EXPECTED_CASES, 'fixture cases must remain exact and canonically ordered');

validateNoNetworkImports();
validateFixtureSafety(fixture);
fixture.records.forEach(validateRecord);

// Retry-root, ordinal, producer, broker, experiment, and hypothesis binding.
validateCompleteSequence([fixture.records[0], fixture.records[1]]);
validateCompleteSequence([fixture.records[2], fixture.records[3]]);
validateCompleteSequence([fixture.records[4]]);

// Explicit crash is honest with a stable class and no invented code.
assert.equal(fixture.records[4].producerKind, 'bounded_experiment');
assert.equal(fixture.records[4].experimentDisposition, 'crash');
assert.equal(fixture.records[4].reasonClass, 'resource_exhaustion');
assert.equal(Object.hasOwn(fixture.records[4], 'reasonCode'), false);

// Pinned canonical identity and full-payload digest vectors, including
// insertion-order independence.
fixture.records.forEach((record, index) => {
  assert.deepEqual(
    { recordKey: record.recordKey, fingerprint: record.fingerprint },
    PINNED_DIGESTS[index],
    `record ${index} pinned digest`,
  );
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  assert.equal(recordKeyFor(reordered), record.recordKey, `record ${index} key must ignore insertion order`);
  assert.equal(fingerprintFor(reordered), record.fingerprint, `record ${index} fingerprint must ignore insertion order`);
});

// Exact replay and a separately valid changed payload under the same identity.
const replayLedger = new ReplayLedger();
assert.equal(replayLedger.ingest(fixture.records[0]), 'accepted');
assert.equal(replayLedger.ingest(fixture.records[0]), 'idempotent_replay');
assert.equal(replayLedger.size, 1);
const conflict = changedPayload(fixture.records[0]);
validateRecord(conflict);
assert.equal(conflict.recordKey, fixture.records[0].recordKey);
assert.notEqual(conflict.fingerprint, fixture.records[0].fingerprint);
assert.equal(replayLedger.ingest(conflict), 'same_key_payload_conflict');
assert.equal(replayLedger.size, 1, 'conflict must not mutate accepted data');

// Malformed/free-form identity is rejected without mutating replay state.
const malformedIdentity = { ...fixture.records[0], taskId: 'not canonical identity' };
assertContractRejected(malformedIdentity, 'free-form identity');
assert.equal(replayLedger.size, 1);

// Domain and result vocabulary cannot cross producer boundaries.
assertContractRejected({
  ...fixture.records[0],
  identityDigestDomain: PRODUCERS.bounded_experiment.identityDigestDomain,
}, 'wrong identity domain');
assertContractRejected({
  ...fixture.records[0],
  fingerprintDigestDomain: PRODUCERS.bounded_experiment.fingerprintDigestDomain,
}, 'wrong fingerprint domain');
const { brokerOutcome: _brokerOutcome, ...brokerWithoutOutcome } = fixture.records[0];
assertContractRejected({
  ...brokerWithoutOutcome,
  experimentDisposition: 'discard',
}, 'broker using experiment vocabulary');
const { experimentDisposition: _experimentDisposition, ...experimentWithoutDisposition } = fixture.records[2];
assertContractRejected({
  ...experimentWithoutDisposition,
  brokerOutcome: 'failed',
}, 'experiment using broker vocabulary');

// Missing, malformed, unknown-version, extra, and private-shaped fields fail
// closed. They never enter the replay ledger.
const { taskId: _taskId, ...missingRequired } = fixture.records[0];
assertContractRejected(missingRequired, 'missing required field');
assertContractRejected({ ...fixture.records[0], attemptOrdinal: '1' }, 'malformed type');
assertContractRejected({ ...fixture.records[0], version: 2 }, 'unknown version');
assertContractRejected({ ...fixture.records[0], unexpectedField: true }, 'extra field');
const privateFieldName = ['raw', 'Detail'].join('');
assertContractRejected({ ...fixture.records[0], [privateFieldName]: 'not admitted' }, 'private field');
assert.equal(replayLedger.size, 1);

// Failure-channel output is an exact, bounded, canonically ordered advisory
// projection. Success and keep stay out.
validateFailureChannelProjection(fixture.failureChannelProjection);
const expectedProjection = buildFailureChannelProjection(fixture.records);
assert.deepEqual(fixture.failureChannelProjection, expectedProjection);
assert.equal(fixture.failureChannelProjection.entries.length, 3);
assert.equal(
  fixture.failureChannelProjection.entries.some((entry) => entry.brokerOutcome === 'succeeded'),
  false,
);
assert.equal(
  fixture.failureChannelProjection.entries.some((entry) => entry.experimentDisposition === 'keep'),
  false,
);

// Dispatcher same-attempt history returns the prior discard but remains wholly
// non-authoritative. Compare with source records rather than treating the view
// as a runtime decision input.
validatePreflight(fixture.dispatcherPreflight, fixture.records);
assert.equal(fixture.dispatcherPreflight.priorFailures.length, 1);
assert.equal(fixture.dispatcherPreflight.priorFailures[0].experimentDisposition, 'discard');
assert.equal(fixture.dispatcherPreflight.automaticDeny, false);
assert.equal(fixture.dispatcherPreflight.retryAuthority, 'not_provided');
assert.equal(fixture.dispatcherPreflight.finalizerVerdict, 'not_provided');
assert.equal(fixture.dispatcherPreflight.successEvidence, false);
assert.equal(fixture.dispatcherPreflight.automaticDispatchPolicy, 'none');

console.log(
  'task-attempt-failure-sharing conformance ok: closed producer domains, public-safe fixture, canonical digests, replay/conflict, advisory projections',
);

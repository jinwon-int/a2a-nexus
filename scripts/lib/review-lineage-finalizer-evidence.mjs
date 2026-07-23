import fs from 'node:fs';

const ENVELOPE_KIND = 'a2a.finalizer-lineage-evidence.v1';
const RECORD_KIND = 'a2a.review-lineage.v1';
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const MODES = new Set(['off', 'record', 'enforce']);
const STATES = new Set([
  'reviewing_initial',
  'correction_pending',
  'reviewing_resolution',
  'passed',
  'blocked_needs_operator',
  'intent_conflict',
  'canceled',
]);
const TERMINAL_REASONS = new Set([
  'budget_wall_clock',
  'budget_correction_generations',
  'budget_reviewer_runs',
  'repeated_findings',
  'intent_drift',
  'scope_drift',
  'operator_cancel',
]);
const FINDING_SEVERITIES = new Set(['critical', 'major', 'minor']);
const FINDING_CATEGORIES = new Set([
  'correctness',
  'security',
  'regression',
  'spec_ambiguity',
  'scope_drift',
  'style',
  'preference',
  'design',
  'other',
]);
const FINDING_DISPOSITIONS = new Set([
  'open',
  'resolved',
  'reopened',
  'overruled_by_finalizer',
]);
const NON_BLOCKING_CATEGORIES = new Set(['style', 'preference', 'design']);

function fail(path, detail) {
  throw new Error(`invalid review-lineage finalizer evidence: ${path} ${detail}`);
}

function objectAt(value, path) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  return value;
}

function exactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is an unexpected field');
  }
}

function textAt(value, path, { pattern } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(path, 'must be a non-empty string');
  }
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
  return value;
}

function nullableTextAt(value, path, options = {}) {
  if (value === null) return null;
  return textAt(value, path, options);
}

function enumAt(value, allowed, path) {
  const text = textAt(value, path);
  if (!allowed.has(text)) fail(path, `must be one of: ${[...allowed].join(', ')}`);
  return text;
}

function booleanAt(value, path) {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function integerAt(value, path, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    fail(path, `must be an integer >= ${minimum}`);
  }
  return value;
}

function arrayAt(value, path, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(path, `must be an array with at least ${minimum} item(s)`);
  }
  return value;
}

function stringArrayAt(value, path, { minimum = 0 } = {}) {
  return arrayAt(value, path, { minimum }).map((item, index) =>
    textAt(item, `${path}[${index}]`));
}

function utcAt(value, path) {
  const text = textAt(value, path, { pattern: UTC_PATTERN });
  if (!Number.isFinite(Date.parse(text))) fail(path, 'must be a valid UTC timestamp');
  return text;
}

function validateContract(value, lineageId) {
  const contract = objectAt(value, 'record.contract');
  if (contract.kind !== 'IntentContractV1') fail('record.contract.kind', 'must equal IntentContractV1');
  if (textAt(contract.lineageId, 'record.contract.lineageId') !== lineageId) {
    fail('record.contract.lineageId', 'must match record.lineageId');
  }
  textAt(contract.goal, 'record.contract.goal');
  stringArrayAt(contract.nonGoals, 'record.contract.nonGoals');
  stringArrayAt(contract.invariants, 'record.contract.invariants', { minimum: 1 });
  for (const [index, criterionValue] of arrayAt(
    contract.acceptanceCriteria,
    'record.contract.acceptanceCriteria',
    { minimum: 1 },
  ).entries()) {
    const criterion = objectAt(criterionValue, `record.contract.acceptanceCriteria[${index}]`);
    textAt(criterion.id, `record.contract.acceptanceCriteria[${index}].id`);
    textAt(criterion.text, `record.contract.acceptanceCriteria[${index}].text`);
  }
  const declaredPaths = objectAt(contract.declaredPaths, 'record.contract.declaredPaths');
  stringArrayAt(declaredPaths.allowed, 'record.contract.declaredPaths.allowed', { minimum: 1 });
  if (declaredPaths.forbidden !== undefined) {
    stringArrayAt(declaredPaths.forbidden, 'record.contract.declaredPaths.forbidden');
  }
  textAt(contract.baseSha, 'record.contract.baseSha', { pattern: SHA_PATTERN });
  textAt(contract.headSha, 'record.contract.headSha', { pattern: SHA_PATTERN });
  utcAt(contract.createdAt, 'record.contract.createdAt');
  textAt(contract.intentHash, 'record.contract.intentHash', { pattern: HASH_PATTERN });
}

function validateBudget(value) {
  const budget = objectAt(value, 'record.budget');
  if (budget.kind !== 'ReviewLineageBudgetV1') {
    fail('record.budget.kind', 'must equal ReviewLineageBudgetV1');
  }
  integerAt(budget.maxWallClockSeconds, 'record.budget.maxWallClockSeconds', 1);
  integerAt(budget.maxCorrectionGenerations, 'record.budget.maxCorrectionGenerations');
  integerAt(budget.maxReviewerRuns, 'record.budget.maxReviewerRuns', 1);
  integerAt(budget.maxReviewerReplacements, 'record.budget.maxReviewerReplacements');
  integerAt(budget.repeatedFindingThreshold, 'record.budget.repeatedFindingThreshold', 1);
  if (budget.onExhaustion !== 'blocked_needs_operator') {
    fail('record.budget.onExhaustion', 'must equal blocked_needs_operator');
  }
}

function validateFinding(value, index) {
  const path = `record.ledger.findings[${index}]`;
  const finding = objectAt(value, path);
  textAt(finding.findingId, `${path}.findingId`, { pattern: /^F-[0-9]+$/ });
  textAt(finding.criterionRef, `${path}.criterionRef`);
  stringArrayAt(finding.evidenceRefs, `${path}.evidenceRefs`, { minimum: 1 });
  enumAt(finding.severity, FINDING_SEVERITIES, `${path}.severity`);
  const category = enumAt(finding.category, FINDING_CATEGORIES, `${path}.category`);
  const blocking = booleanAt(finding.blocking, `${path}.blocking`);
  if (blocking && NON_BLOCKING_CATEGORIES.has(category)) {
    fail(`${path}.blocking`, `must be false for ${category} findings`);
  }
  textAt(finding.introducedAtHead, `${path}.introducedAtHead`, { pattern: SHA_PATTERN });
  textAt(finding.firstSeenAtHead, `${path}.firstSeenAtHead`, { pattern: SHA_PATTERN });
  nullableTextAt(finding.resolvedAtHead, `${path}.resolvedAtHead`, { pattern: SHA_PATTERN });
  enumAt(finding.disposition, FINDING_DISPOSITIONS, `${path}.disposition`);
  textAt(finding.signature, `${path}.signature`, { pattern: HASH_PATTERN });
}

function validateLedger(value, lineageId) {
  const ledger = objectAt(value, 'record.ledger');
  if (ledger.kind !== 'FindingLedgerV1') fail('record.ledger.kind', 'must equal FindingLedgerV1');
  textAt(ledger.ledgerId, 'record.ledger.ledgerId');
  if (textAt(ledger.lineageId, 'record.ledger.lineageId') !== lineageId) {
    fail('record.ledger.lineageId', 'must match record.lineageId');
  }
  for (const [index, finding] of arrayAt(ledger.findings, 'record.ledger.findings').entries()) {
    validateFinding(finding, index);
  }
}

function validateAppeal(value, lineageId) {
  const appeal = objectAt(value, 'record.appeal');
  if (appeal.kind !== 'AppealDispositionStateV1') {
    fail('record.appeal.kind', 'must equal AppealDispositionStateV1');
  }
  if (textAt(appeal.lineageId, 'record.appeal.lineageId') !== lineageId) {
    fail('record.appeal.lineageId', 'must match record.lineageId');
  }
  nullableTextAt(appeal.finalizerOwnerId, 'record.appeal.finalizerOwnerId');
  for (const [index, requestValue] of arrayAt(
    appeal.requests,
    'record.appeal.requests',
  ).entries()) {
    const path = `record.appeal.requests[${index}]`;
    const request = objectAt(requestValue, path);
    if (request.kind !== 'AppealRequestV1') fail(`${path}.kind`, 'must equal AppealRequestV1');
    textAt(request.appealId, `${path}.appealId`);
    if (textAt(request.lineageId, `${path}.lineageId`) !== lineageId) {
      fail(`${path}.lineageId`, 'must match record.lineageId');
    }
    textAt(request.findingId, `${path}.findingId`, { pattern: /^F-[0-9]+$/ });
    textAt(request.requestedBy, `${path}.requestedBy`);
    enumAt(request.requesterRole, new Set(['author', 'operator']), `${path}.requesterRole`);
    textAt(request.reason, `${path}.reason`);
    utcAt(request.requestedAt, `${path}.requestedAt`);
  }
  for (const [index, dispositionValue] of arrayAt(
    appeal.dispositions,
    'record.appeal.dispositions',
  ).entries()) {
    const path = `record.appeal.dispositions[${index}]`;
    const disposition = objectAt(dispositionValue, path);
    if (disposition.kind !== 'FinalizerDispositionV1') {
      fail(`${path}.kind`, 'must equal FinalizerDispositionV1');
    }
    textAt(disposition.dispositionId, `${path}.dispositionId`);
    textAt(disposition.appealId, `${path}.appealId`);
    if (textAt(disposition.lineageId, `${path}.lineageId`) !== lineageId) {
      fail(`${path}.lineageId`, 'must match record.lineageId');
    }
    textAt(disposition.findingId, `${path}.findingId`, { pattern: /^F-[0-9]+$/ });
    textAt(disposition.finalizerId, `${path}.finalizerId`);
    enumAt(
      disposition.disposition,
      new Set(['upheld', 'overruled_by_finalizer']),
      `${path}.disposition`,
    );
    textAt(disposition.justification, `${path}.justification`);
    utcAt(disposition.decidedAt, `${path}.decidedAt`);
  }
}

function validateCounters(value) {
  const counters = objectAt(value, 'record.counters');
  for (const key of [
    'correctionGenerations',
    'reviewerRuns',
    'reviewerReplacements',
    'findingsNew',
    'findingsReopened',
    'findingsResolved',
    'repeatedSignatureHits',
    'goalpostRejections',
    'scopeDriftRejections',
  ]) {
    integerAt(counters[key], `record.counters.${key}`);
  }
}

function validateUnresolvedSignatures(value) {
  const signatures = objectAt(value, 'record.unresolvedSignatures');
  for (const [signature, count] of Object.entries(signatures)) {
    textAt(signature, 'record.unresolvedSignatures key', { pattern: HASH_PATTERN });
    integerAt(count, `record.unresolvedSignatures.${signature}`);
  }
}

export function validateReviewLineageFinalizerEvidence(value) {
  const envelope = objectAt(value, 'evidence');
  exactKeys(envelope, new Set(['kind', 'parentRoundId', 'record']), 'evidence');
  if (envelope.kind !== ENVELOPE_KIND) {
    fail('evidence.kind', `must equal ${ENVELOPE_KIND}`);
  }
  textAt(envelope.parentRoundId, 'evidence.parentRoundId');
  const record = objectAt(envelope.record, 'record');
  if (record.kind !== RECORD_KIND) fail('record.kind', `must equal ${RECORD_KIND}`);
  const lineageId = textAt(record.lineageId, 'record.lineageId');
  enumAt(record.mode, MODES, 'record.mode');
  enumAt(record.state, STATES, 'record.state');
  validateContract(record.contract, lineageId);
  validateBudget(record.budget);
  validateLedger(record.ledger, lineageId);
  validateAppeal(record.appeal, lineageId);
  validateCounters(record.counters);
  textAt(record.currentHeadSha, 'record.currentHeadSha', { pattern: SHA_PATTERN });
  nullableTextAt(record.currentDiffHash, 'record.currentDiffHash', { pattern: HASH_PATTERN });
  const startedAt = utcAt(record.startedAt, 'record.startedAt');
  const updatedAt = utcAt(record.updatedAt, 'record.updatedAt');
  if (Date.parse(updatedAt) < Date.parse(startedAt)) {
    fail('record.updatedAt', 'must not precede record.startedAt');
  }
  if (record.terminalReason !== null) {
    enumAt(record.terminalReason, TERMINAL_REASONS, 'record.terminalReason');
  }
  validateUnresolvedSignatures(record.unresolvedSignatures);
  return envelope;
}

export function readReviewLineageFinalizerEvidence(path) {
  const stat = fs.statSync(path);
  if (!stat.isFile()) throw new Error(`lineage evidence path is not a file: ${path}`);
  if (stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`lineage evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`);
  }
  const text = fs.readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid lineage evidence JSON: ${error.message}`);
  }
  return validateReviewLineageFinalizerEvidence(parsed);
}

function stateReasonMatches(record) {
  switch (record.state) {
    case 'reviewing_initial':
    case 'correction_pending':
    case 'reviewing_resolution':
    case 'passed':
      return record.terminalReason === null;
    case 'blocked_needs_operator':
      return record.terminalReason !== null
        && record.terminalReason !== 'intent_drift'
        && record.terminalReason !== 'operator_cancel';
    case 'intent_conflict':
      return record.terminalReason === 'intent_drift';
    case 'canceled':
      return record.terminalReason === 'operator_cancel';
    default:
      return false;
  }
}

function evaluation(record, parentRoundId, fields) {
  const openBlockingFindings = record.ledger.findings.filter((finding) =>
    finding.blocking === true
    && (finding.disposition === 'open' || finding.disposition === 'reopened')).length;
  const unresolvedSignatureCount = Object.values(record.unresolvedSignatures)
    .filter((count) => count > 0).length;
  return {
    kind: 'a2a.finalizer-lineage-evaluation.v1',
    provided: true,
    parentRoundId,
    lineageId: record.lineageId,
    mode: record.mode,
    state: record.state,
    terminalReason: record.terminalReason,
    openBlockingFindings,
    unresolvedSignatureCount,
    ...fields,
  };
}

export function evaluateReviewLineageFinalizerEvidence(value, expectedRoundId) {
  const evidence = validateReviewLineageFinalizerEvidence(value);
  const { record } = evidence;

  if (evidence.parentRoundId !== expectedRoundId) {
    return evaluation(record, evidence.parentRoundId, {
      outcome: 'invalid_state',
      blocksFinality: true,
      reasonCode: 'lineage_round_mismatch',
    });
  }
  if (!stateReasonMatches(record)) {
    return evaluation(record, evidence.parentRoundId, {
      outcome: 'invalid_state',
      blocksFinality: true,
      reasonCode: 'lineage_state_reason_mismatch',
    });
  }
  if (record.mode !== 'enforce') {
    return evaluation(record, evidence.parentRoundId, {
      outcome: 'not_enforced',
      blocksFinality: false,
      reasonCode: 'mode_not_enforced',
    });
  }

  switch (record.state) {
    case 'reviewing_initial':
    case 'correction_pending':
    case 'reviewing_resolution':
      return evaluation(record, evidence.parentRoundId, {
        outcome: 'review_pending',
        blocksFinality: true,
        reasonCode: 'lineage_active',
      });
    case 'passed': {
      const base = evaluation(record, evidence.parentRoundId, {});
      if (base.openBlockingFindings > 0 || base.unresolvedSignatureCount > 0) {
        return {
          ...base,
          outcome: 'invalid_state',
          blocksFinality: true,
          reasonCode: 'lineage_open_blocking_findings',
        };
      }
      if (record.currentDiffHash === null) {
        return {
          ...base,
          outcome: 'invalid_state',
          blocksFinality: true,
          reasonCode: 'lineage_subject_incomplete',
        };
      }
      return {
        ...base,
        outcome: 'completion_allowed',
        blocksFinality: false,
        reasonCode: 'lineage_passed',
      };
    }
    case 'blocked_needs_operator':
      return evaluation(record, evidence.parentRoundId, {
        outcome: 'blocked_needs_operator',
        blocksFinality: true,
        reasonCode: record.terminalReason,
      });
    case 'intent_conflict':
      return evaluation(record, evidence.parentRoundId, {
        outcome: 'intent_conflict',
        blocksFinality: true,
        reasonCode: 'intent_drift',
      });
    case 'canceled':
      return evaluation(record, evidence.parentRoundId, {
        outcome: 'canceled',
        blocksFinality: true,
        reasonCode: 'operator_cancel',
      });
    default:
      return evaluation(record, evidence.parentRoundId, {
        outcome: 'invalid_state',
        blocksFinality: true,
        reasonCode: 'lineage_state_unknown',
      });
  }
}

export {
  ENVELOPE_KIND,
  RECORD_KIND,
};

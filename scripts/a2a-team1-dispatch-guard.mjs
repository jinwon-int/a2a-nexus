#!/usr/bin/env node
/**
 * A2A Team1 Dispatch Guard — pre-dispatch validation and dry-run for Team1
 * multi-lane parent-round dispatch.
 *
 * Validates that every lane payload carries required parent-round metadata
 * before task creation is allowed. Retry lanes must preserve the same metadata.
 * Dry-run mode exposes the final payload shape without secrets.
 *
 * This command never deploys, restarts Gateway/brokers/workers, sends providers,
 * mutates DB/outbox state, ACKs or replays Terminal Brief records, releases/tags,
 * moves secrets, or enables automatic runtime execution.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';

// ─── Required parent-round metadata fields ──────────────────────────────────

const REQUIRED_PARENT_FIELDS = [
  'parentRoundId',
  'parentRoundTotal',
  'parentRoundOrder',
  'originBrokerId',
  'brokerOfRecordId',
];

// Retry lanes must preserve the same metadata as the original wave.
const RETRY_IMMUTABLE_FIELDS = [
  'parentRoundId',
  'parentRoundTotal',
  'parentRoundOrder',
  'originBrokerId',
  'brokerOfRecordId',
];

// ─── Safety gates ───────────────────────────────────────────────────────────

const PROHIBITED_PATTERNS = [
  { kind: 'secrets', re: /\b(?:ghp_|github_pat_|ghs_|ghr_)[A-Za-z0-9_]{20,}\b/ },
  { kind: 'secret-assignment', re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*['"]?(?!<|\$\{|YOUR_|redacted|REDACTED)[^'"\s#]{8,}/i },
  { kind: 'private-key', re: /-----BEGIN\s*(?:RSA\s+|OPENSSH\s+|EC\s+|DSA\s+)?PRIVATE\s+KEY-----/ },
  { kind: 'host-private-path', re: /\/(?:home|Users)\/[^\s'")\/`]+\/|file:\/\/\/[^\s'")`]+/ },
  { kind: 'runtime-bootstrap-file', re: /\b(?:AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md)\b/ },
];

// ─── Helper utilities ───────────────────────────────────────────────────────

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function collectStrings(obj, accumulator = []) {
  if (typeof obj === 'string') {
    accumulator.push(obj);
  } else if (Array.isArray(obj)) {
    obj.forEach((item) => collectStrings(item, accumulator));
  } else if (obj && typeof obj === 'object') {
    Object.values(obj).forEach((val) => collectStrings(val, accumulator));
  }
  return accumulator;
}

// ─── Validation: lane metadata ──────────────────────────────────────────────

function validateLaneMetadata(lane, index, { isRetry = false, originalLane = null, requireParentRoundMetadata = false } = {}) {
  const blockers = [];

  if (!lane || typeof lane !== 'object') {
    return [{ gate: `lane[${index}]`, status: 'MISSING', reason: 'lane object is required' }];
  }

  const hasRoundContext = requireParentRoundMetadata || lane.parentRoundId != null || lane.parentRoundTotal != null || lane.parentRoundOrder != null;

  if (hasRoundContext) {
    for (const field of REQUIRED_PARENT_FIELDS) {
      const value = lane[field];
      if (value == null || (typeof value === 'string' && String(value).trim().length === 0)) {
        blockers.push({
          gate: `lane[${index}].${field}`,
          status: 'MISSING',
          reason: `Required parent-round metadata field '${field}' is missing or empty on lane ${index}`,
        });
      }
    }
  }

  if (lane.parentRoundId != null && !hasText(lane.parentRoundId)) {
    blockers.push({ gate: `lane[${index}].parentRoundId`, status: 'INVALID', reason: 'parentRoundId must be a non-empty string' });
  }

  if (lane.parentRoundTotal != null && !isPositiveInt(lane.parentRoundTotal)) {
    blockers.push({ gate: `lane[${index}].parentRoundTotal`, status: 'INVALID', reason: 'parentRoundTotal must be a positive integer' });
  }

  if (lane.parentRoundOrder != null && !isPositiveInt(lane.parentRoundOrder)) {
    blockers.push({ gate: `lane[${index}].parentRoundOrder`, status: 'INVALID', reason: 'parentRoundOrder must be a positive integer' });
  }

  if (lane.parentRoundTotal != null && lane.parentRoundOrder != null) {
    const total = lane.parentRoundTotal;
    const order = lane.parentRoundOrder;
    if (isPositiveInt(total) && isPositiveInt(order) && order > total) {
      blockers.push({ gate: `lane[${index}]`, status: 'INVALID', reason: `parentRoundOrder (${order}) exceeds parentRoundTotal (${total}) on lane ${index}` });
    }
  }

  if (lane.originBrokerId != null && !hasText(lane.originBrokerId)) {
    blockers.push({ gate: `lane[${index}].originBrokerId`, status: 'INVALID', reason: 'originBrokerId must be a non-empty string' });
  }

  if (lane.brokerOfRecordId != null && !hasText(lane.brokerOfRecordId)) {
    blockers.push({ gate: `lane[${index}].brokerOfRecordId`, status: 'INVALID', reason: 'brokerOfRecordId must be a non-empty string' });
  }

  if (isRetry && originalLane && hasRoundContext) {
    for (const field of RETRY_IMMUTABLE_FIELDS) {
      const orig = originalLane[field];
      const curr = lane[field];
      if (orig != null && curr != null && String(orig) !== String(curr)) {
        blockers.push({ gate: `lane[${index}].${field}`, status: 'CONFLICT', reason: `Retry lane ${index} changed '${field}' from '${orig}' to '${curr}'; retries must preserve the same metadata` });
      }
    }
  }

  return blockers;
}

// ─── Validation: dispatch spec ──────────────────────────────────────────────

function validateDispatchSpec(spec) {
  const blockers = [];
  const warnings = [];

  if (!spec || typeof spec !== 'object') {
    return { valid: false, blockers: [{ gate: 'spec', status: 'MISSING', reason: 'dispatch spec object is required' }], warnings: [] };
  }

  if (!spec.runId && !hasText(spec.runId)) {
    blockers.push({ gate: 'spec.runId', status: 'MISSING', reason: 'runId is required' });
  }

  if (spec.team && spec.team !== 'team1') {
    warnings.push(`spec.team is '${spec.team}', expected 'team1'`);
  }

  const lanes = Array.isArray(spec.lanes) ? spec.lanes : [];
  if (lanes.length === 0) {
    blockers.push({ gate: 'spec.lanes', status: 'MISSING', reason: 'at least one lane is required' });
  }

  const hasRoundContext = spec.parentRoundId != null
    || spec.parentRoundTotal != null
    || lanes.length > 1
    || lanes.some((l) => l.parentRoundId != null || l.parentRoundOrder != null || l.parentRoundTotal != null);

  if (hasRoundContext && lanes.length > 1) {
    for (const field of ['parentRoundId', 'parentRoundTotal']) {
      if (spec[field] == null) {
        blockers.push({ gate: `spec.${field}`, status: 'MISSING', reason: `When dispatching multi-lane rounds, spec-level '${field}' is required` });
      }
    }
  }

  const originalRunLanes = (spec.originalRun && Array.isArray(spec.originalRun.lanes)) ? spec.originalRun.lanes : null;
  const isRetryBatch = Array.isArray(spec.originalRun?.lanes) || !!spec.parentRetryOf;

  for (const [index, lane] of lanes.entries()) {
    const isRetry = isRetryBatch && !!(lane.parentRetryOf || spec.parentRetryOf);
    const originalLane = isRetry && originalRunLanes && index < originalRunLanes.length ? originalRunLanes[index] : null;
    blockers.push(...validateLaneMetadata(lane, index, { isRetry, originalLane, requireParentRoundMetadata: hasRoundContext }));

    if (!hasText(lane.worker)) {
      blockers.push({ gate: `lane[${index}].worker`, status: 'MISSING', reason: 'lane worker is required' });
    }

    const strings = collectStrings(lane);
    for (const str of strings) {
      for (const rule of PROHIBITED_PATTERNS) {
        if (rule.re.test(str)) {
          blockers.push({ gate: `lane[${index}]`, status: 'BLOCKED', reason: `Lane ${index} contains prohibited pattern: ${rule.kind}` });
        }
      }
    }
  }

  const dryRunPayload = hasRoundContext ? buildDryRunPayload(spec, lanes, blockers.length === 0) : null;

  return { valid: blockers.length === 0, blockers, warnings, dryRunPayload };
}

// ─── Dry-run payload builder ────────────────────────────────────────────────

function buildDryRunPayload(spec, lanes, isValid) {
  const total = Number(spec.parentRoundTotal) || lanes.length;

  const lanePayloads = lanes.map((lane, index) => {
    const order = lane.parentRoundOrder != null ? Number(lane.parentRoundOrder) : index + 1;
    return {
      order,
      worker: lane.worker || '(unknown)',
      parentRoundId: lane.parentRoundId || spec.parentRoundId || null,
      parentRoundTotal: lane.parentRoundTotal != null ? Number(lane.parentRoundTotal) : total,
      parentRoundOrder: order,
      parentRoundProgress: `${order}/${total}`,
      originBrokerId: lane.originBrokerId || spec.originBrokerId || null,
      brokerOfRecordId: lane.brokerOfRecordId || spec.brokerOfRecordId || null,
      parentRetryOf: lane.parentRetryOf || spec.parentRetryOf || null,
      role: lane.role || null,
      repo: lane.repo || null,
      issueTitle: lane.issueTitle ? `${lane.issueTitle.slice(0, 40)}…` : null,
    };
  });

  return {
    $schema: 'a2a.team1.dispatch-guard.dry-run.v1',
    runId: spec.runId || '(auto-generated)',
    team: spec.team || 'team1',
    executionMode: 'dry-run',
    lanesCount: lanes.length,
    lanePayloads,
    summary: { valid: isValid, totalLanes: lanes.length, payloadErrors: isValid ? 0 : 'spec validation failed — see blockers' },
    safetyConfirmation: {
      noProductionDeploy: true,
      noGatewayRestart: true,
      noBrokerWorkerRestart: true,
      noLiveProviderSend: true,
      noDbMutation: true,
      noTerminalAck: true,
      noOutboxReplay: true,
      noReleaseTagPublish: true,
      noCredentialMovement: true,
      noSecretDisclosure: true,
      noVisibilityChange: true,
      noHistoryRewrite: true,
      noForcePush: true,
    },
    redactionNote: 'Secret values, provider targets, host-private paths, and full command output are redacted.',
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function formatResult(result, format) {
  if (format === 'markdown') {
    const lines = [];
    lines.push('# A2A Team1 Dispatch Guard — Validation Result\n');
    lines.push(`| Field | Value |`);
    lines.push('|---|---|');
    lines.push(`| Valid | ${result.valid ? '✅ Yes' : '❌ No'} |`);
    lines.push(`| Blockers | ${result.blockers.length} |`);
    lines.push(`| Warnings | ${result.warnings.length} |\n`);

    if (result.blockers.length > 0) {
      lines.push('## Blockers\n');
      for (const b of result.blockers) lines.push(`- **${b.gate}**: ${b.status} — ${b.reason}`);
      lines.push('');
    }
    if (result.warnings.length > 0) {
      lines.push('## Warnings\n');
      for (const w of result.warnings) lines.push(`- ${w}`);
      lines.push('');
    }
    if (result.dryRunPayload) {
      lines.push('## Dry-run payload (sanitized)\n');
      lines.push('```json\n' + JSON.stringify(result.dryRunPayload, null, 2) + '\n```\n');
      lines.push('> Note: Issue titles are truncated. Secret values, provider targets, host-private paths, and full command output are redacted.\n');
    }
    return lines.join('\n');
  }
  const output = { valid: result.valid, blockers: result.blockers, warnings: result.warnings, dryRunPayload: result.dryRunPayload };
  return `${JSON.stringify(output, null, 2)}\n`;
}

function main() {
  const { values } = parseArgs({
    options: {
      spec: { type: 'string', short: 's', default: '' },
      input: { type: 'string', short: 'i', default: '' },
      format: { type: 'string', default: 'json' },
      mode: { type: 'string', default: 'dry-run' },
    },
  });

  const allowedModes = new Set(['dry-run', 'validate']);
  if (!allowedModes.has(values.mode)) {
    process.stderr.write(JSON.stringify({ valid: false, error: `unsupported mode '${values.mode}'` }, null, 2) + '\n');
    process.exit(1);
  }

  const specFile = values.input || values.spec;
  if (!specFile) {
    process.stderr.write(JSON.stringify({ valid: false, error: 'No spec file provided. Use --input or --spec.' }, null, 2) + '\n');
    process.exit(1);
  }

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  } catch (error) {
    process.stderr.write(JSON.stringify({ valid: false, error: `cannot read/parse spec: ${error.message}` }, null, 2) + '\n');
    process.exit(1);
  }

  const result = validateDispatchSpec(spec);
  const output = formatResult(result, values.format);

  if (result.valid) {
    process.stdout.write(output);
    process.exit(0);
  }
  process.stderr.write(output);
  process.exit(1);
}

// Direct invocation
if (process.argv[1] && (process.argv[1].endsWith('a2a-team1-dispatch-guard.mjs') || process.argv[1].endsWith('a2a-team1-dispatch-guard'))) {
  main();
}

export {
  validateDispatchSpec,
  validateLaneMetadata,
  REQUIRED_PARENT_FIELDS,
  RETRY_IMMUTABLE_FIELDS,
};

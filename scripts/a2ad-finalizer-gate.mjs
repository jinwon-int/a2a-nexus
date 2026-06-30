#!/usr/bin/env node
/**
 * A2AD finalizer gate — fail-closed GitHub publication guard.
 *
 * A GitHub-visible finalizer review/comment must never look like an A2AD
 * consensus result unless the A2A worker quorum is actually satisfied. This
 * gate evaluates the round's lane task records (offline, from an operator JSON
 * dump) and decides whether a draft body may be published as FINAL.
 *
 * Verdict:
 *   FINAL    quorum satisfied: succeeded >= quorum AND (when parentRoundTotal
 *            is known) every expected lane is terminal, AND the draft cites at
 *            least one evidence id (task id of a succeeded lane).
 *   BLOCKED  anything else — pending lanes always block finality; failed/
 *            timeout lanes never count toward quorum but are always enumerated.
 *
 * Publication contract: this gate NEVER posts to GitHub. It only gates.
 *   - exit 0 + verdict FINAL    → caller may publish the draft as-is.
 *   - exit 1 + verdict BLOCKED  → caller must NOT publish a consensus result.
 *   - --allow-preliminary       → exit 0, but the draft is REWRITTEN with a loud
 *                                 PRELIMINARY banner so it cannot masquerade as
 *                                 an A2AD consensus result.
 *
 * Safety: read-only. No GitHub posting, no live broker access, no deploy, no
 * restart, no provider send, no DB mutation, no secret movement.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';

// ─── Lane status taxonomy ───────────────────────────────────────────────────

// Statuses that count as a satisfied lane (evidence toward quorum).
const SUCCEEDED_STATUSES = new Set(['succeeded']);
// Statuses that are terminal but never count toward quorum.
const FAILED_STATUSES = new Set(['failed', 'canceled', 'blocked', 'timeout']);
// Non-terminal statuses — their presence always blocks finality.
const PENDING_STATUSES = new Set(['queued', 'approval_pending', 'claimed', 'running']);

function classify(status) {
  const s = String(status || '').trim().toLowerCase();
  if (SUCCEEDED_STATUSES.has(s)) return 'succeeded';
  if (FAILED_STATUSES.has(s)) return 'failed';
  if (PENDING_STATUSES.has(s)) return 'pending';
  // Unknown statuses are treated as pending (fail-closed: they block finality).
  return 'pending';
}

// ─── Input parsing ──────────────────────────────────────────────────────────

function readTasks(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read --tasks file '${file}': ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse --tasks JSON '${file}': ${error.message}`);
  }
  let items;
  if (Array.isArray(parsed)) items = parsed;
  else if (parsed && Array.isArray(parsed.items)) items = parsed.items;
  else throw new Error(`--tasks file '${file}' must be a JSON array or an object with an 'items' array`);
  for (const [i, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`--tasks file '${file}': item ${i} is not a task-record object`);
    }
    if (!hasText(item.id)) {
      throw new Error(`--tasks file '${file}': item ${i} is missing a string 'id'`);
    }
  }
  return items;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nestedText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(nestedText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(nestedText).join(' ');
  return '';
}

function workerOf(lane) {
  return lane.assignedWorkerId || lane.targetNodeId || lane.target?.id || null;
}

function supplementOf(lane) {
  const payload = lane.payload || {};
  const value = payload.supplementOf || payload.supersedesTaskId || payload.compactSupplementOf;
  return hasText(value) ? String(value).trim() : '';
}

function classifySourceProjectionEvidence(text) {
  if (/manifest\s+(?:missing|lacked)|sourceBundle\.files\[\]|files\s+array\s+missing/i.test(text)) {
    return { evidenceClass: 'source_projection_manifest_missing', reason: 'source bundle manifest was missing files before projection' };
  }
  if (/payload\s+(?:dropped|lost)\s+files|bridge\s+dropped\s+files|worker\s+saw\s+0\s+files|0\s+files/i.test(text)) {
    return { evidenceClass: 'source_projection_payload_dropped', reason: 'source bundle files were present upstream but dropped before worker/model visibility' };
  }
  if (/prompt\s+budget|token\s+budget|truncat(?:ed|ion)|too\s+large|exceed(?:ed|s)/i.test(text)) {
    return { evidenceClass: 'source_projection_prompt_budget_truncated', reason: 'source bundle likely exceeded prompt/model-visible budget and was truncated' };
  }
  if (/worker\s+(?:reported|classified).*insufficient|source\s+(?:insufficient|unusable)|missing\s+source\s+evidence/i.test(text)) {
    return { evidenceClass: 'source_projection_worker_insufficient', reason: 'worker reported source as insufficient even though the lane reached analysis' };
  }
  if (/source\s+projection|sourceBundle\.files|source\s+bundle/i.test(text)) {
    return { evidenceClass: 'source_projection_blocked', reason: 'source projection / source bundle block' };
  }
  return null;
}

function hasEmptySubstantiveOutput(output) {
  const analysisStatus = String(output.analysisStatus ?? output.status ?? '').trim().toLowerCase();
  if (analysisStatus !== 'done') return false;
  const arrayFields = ['findings', 'risks', 'recommendations', 'evidenceRefs', 'blockerFindings', 'nonBlockingFindings'];
  const allArraysEmpty = arrayFields.every((key) => !Array.isArray(output[key]) || output[key].length === 0);
  const summary = String(output.analysisSummary ?? output.summary ?? '').trim().toLowerCase();
  return allArraysEmpty && (!summary || summary === 'analysis complete' || summary === 'analysis-only completed');
}

function classifyLaneEvidence(lane) {
  const output = lane.output ?? lane.result?.output ?? {};
  const error = lane.error ?? lane.result?.error ?? {};
  // Evidence-class regexes must not scan payload.sourceBundle content: source
  // files often quote historical wrapper/error phrases and would otherwise
  // poison classification for real analysis lanes (#960).
  const evidenceText = nestedText({
    intent: lane.intent,
    output,
    error,
    message: lane.message,
  });
  const worker = String(workerOf(lane) || '').toLowerCase();
  const statusBucket = classify(lane.status);
  const analysisStatus = String(output.analysisStatus ?? output.status ?? '').trim().toLowerCase();
  const sourceProjectionQuality = String(output.sourceProjection?.quality ?? '').trim().toLowerCase();
  const sourceProjectionReason = String(output.sourceProjection?.budgetReason ?? '').trim();
  const sourceProjectionCanonicalFileCount = Number(output.sourceProjection?.canonicalFileCount ?? 0);
  const sourceProjectionRequiredCount = Array.isArray(output.sourceProjection?.requiredPaths) ? output.sourceProjection.requiredPaths.length : 0;
  const sourceProjectionMissingRequiredCount = Array.isArray(output.sourceProjection?.requiredFilesMissing) ? output.sourceProjection.requiredFilesMissing.length : 0;

  if ((sourceProjectionQuality === 'insufficient' || sourceProjectionQuality === 'zero_files')
    && (sourceProjectionCanonicalFileCount > 0 || sourceProjectionRequiredCount > 0 || sourceProjectionMissingRequiredCount > 0 || analysisStatus === 'blocked')) {
    return {
      evidenceClass: sourceProjectionQuality === 'zero_files' ? 'source_projection_payload_dropped' : 'source_projection_worker_insufficient',
      countsTowardQuorum: false,
      reason: sourceProjectionReason ? `source projection telemetry: ${sourceProjectionReason}` : 'source projection telemetry reports insufficient worker-visible source',
    };
  }

  if (statusBucket === 'pending' && worker === 'daegyo') {
    const laneStatus = String(lane.status || '').trim().toLowerCase();
    if (laneStatus === 'claimed' || laneStatus === 'running') {
      return {
        evidenceClass: 'nonterminal_claimed_missing_evidence',
        countsTowardQuorum: false,
        reason: 'Daegyo/mobile lane is claimed or running without terminal result; classify as missing evidence rather than waiting indefinitely.',
      };
    }
    return {
      evidenceClass: 'mobile_limited',
      countsTowardQuorum: false,
      reason: 'Daegyo lane is mobile/policy-limited and pending; exclude from formal A2AD quorum unless the task mode is explicitly supported.',
    };
  }
  if (analysisStatus === 'provider_or_model_failure' || /provider_or_model_failure|provider\s+failure|model\s+failure/i.test(evidenceText)) {
    return {
      evidenceClass: 'provider_or_model_failure',
      countsTowardQuorum: false,
      reason: 'provider/model failure is reportable infrastructure evidence, not substantive worker opinion',
    };
  }
  if (statusBucket === 'succeeded' && hasEmptySubstantiveOutput(output)) {
    return {
      evidenceClass: 'empty_substantive_output',
      countsTowardQuorum: false,
      reason: 'analysisStatus=done with empty findings/recommendations/evidenceRefs is not substantive worker evidence',
    };
  }
  if (analysisStatus === 'blocked' || analysisStatus === 'block' || analysisStatus === 'source_blocked') {
    const sourceProjection = classifySourceProjectionEvidence(evidenceText);
    if (sourceProjection) {
      return {
        evidenceClass: sourceProjection.evidenceClass,
        countsTowardQuorum: false,
        reason: sourceProjection.reason,
      };
    }
    return {
      evidenceClass: 'analysis_blocked',
      countsTowardQuorum: false,
      reason: 'analysis bridge returned blocked status',
    };
  }
  if (/generic\s+a2ad-review\s+task\s+accepted/i.test(evidenceText)) {
    return {
      evidenceClass: 'wrapper_only',
      countsTowardQuorum: false,
      reason: 'generic a2ad-review task accepted by versioned A2A task handler',
    };
  }
  if (/\b(wrapper_only|analysis-only completed|echo handled task|prompt echo)\b/i.test(evidenceText)) {
    return {
      evidenceClass: 'wrapper_only',
      countsTowardQuorum: false,
      reason: 'wrapper/echo output is not substantive worker analysis',
    };
  }
  if (/openclaw_analysis_failed|Hermes analysis bridge response did not contain valid JSON|invalid Hermes analysis JSON schema|Hermes response JSON must be an object|JSON must be an object|candidate was not valid JSON|not valid JSON/i.test(evidenceText)) {
    return {
      evidenceClass: 'analysis_bridge_invalid_json',
      countsTowardQuorum: false,
      reason: 'analysis bridge failed to project strict JSON evidence; treat as transport/contract failure, not worker opinion',
    };
  }
  if (/docker_runner_failed|without\s+PR\/Done\/Block\s+evidence|PR\/Done\/Block evidence/i.test(evidenceText)) {
    return {
      evidenceClass: 'evidence_contract_failure',
      countsTowardQuorum: false,
      reason: 'docker_runner_failed / missing PR/Done/Block evidence contract',
    };
  }
  if (statusBucket === 'succeeded') return { evidenceClass: 'substantive', countsTowardQuorum: true, reason: '' };
  if (statusBucket === 'failed') return { evidenceClass: 'failed', countsTowardQuorum: false, reason: 'lane failed or blocked' };
  return { evidenceClass: 'missing_evidence', countsTowardQuorum: false, reason: 'lane is non-terminal' };
}

// Derive the per-target key for --per-target accounting.
function targetKey(task) {
  const payload = task.payload || {};
  if (hasText(payload.reviewTarget)) return payload.reviewTarget.trim();
  if (hasText(task.intent)) return task.intent.trim();
  if (hasText(payload.intent)) return payload.intent.trim();
  return '(untargeted)';
}

// ─── Verdict computation ────────────────────────────────────────────────────

function computeVerdict(tasks, options) {
  const { round, quorum, perTarget, draft } = options;

  if (!hasText(round)) {
    throw new Error('--round <parentRoundId> is required');
  }

  // Collect the lanes that belong to this round.
  const lanes = tasks.filter((t) => {
    const payload = t.payload || {};
    return String(payload.parentRoundId || '') === String(round);
  });

  // parentRoundTotal — take the max declared on any lane (lanes agree by contract).
  let expectedTotal = null;
  for (const lane of lanes) {
    const total = Number(lane.payload && lane.payload.parentRoundTotal);
    if (Number.isInteger(total) && total > 0) {
      expectedTotal = expectedTotal == null ? total : Math.max(expectedTotal, total);
    }
  }

  const succeededLanes = [];
  const failedLanes = [];
  const pendingLanes = [];
  const nonSubstantiveLanes = [];
  const supersededLanes = [];

  for (const lane of lanes) {
    lane.__bucket = classify(lane.status);
    lane.__evidence = classifyLaneEvidence(lane);
  }

  const substantiveSupplementsByOriginalId = new Map();
  for (const lane of lanes) {
    const originalId = supplementOf(lane);
    if (!originalId) continue;
    if (lane.__bucket === 'succeeded' && lane.__evidence?.countsTowardQuorum) {
      substantiveSupplementsByOriginalId.set(originalId, lane);
    }
  }

  for (const lane of lanes) {
    const bucket = lane.__bucket;
    const evidence = lane.__evidence;
    const supplement = substantiveSupplementsByOriginalId.get(lane.id);
    if (supplement && evidence?.countsTowardQuorum === false) {
      lane.__supersededBy = supplement.id;
      supersededLanes.push(lane);
      continue;
    }
    if (bucket === 'succeeded' && evidence.countsTowardQuorum) succeededLanes.push(lane);
    else if (bucket === 'succeeded') nonSubstantiveLanes.push(lane);
    else if (bucket === 'failed') failedLanes.push(lane);
    else pendingLanes.push(lane);
  }

  // Effective quorum: explicit --quorum, else parentRoundTotal, else lane count.
  const effectiveQuorum = quorum != null
    ? quorum
    : (expectedTotal != null ? expectedTotal : lanes.length);

  const reasons = [];

  // 1) Succeeded count must reach the quorum.
  const quorumMet = succeededLanes.length >= effectiveQuorum && effectiveQuorum > 0;
  if (effectiveQuorum <= 0) {
    reasons.push('quorum is zero or undefined; refusing to treat finalizer-only review as consensus');
  } else if (!quorumMet) {
    reasons.push(`succeeded lanes ${succeededLanes.length} < required quorum ${effectiveQuorum}`);
  }

  // 2) Dispatch-completeness: when parentRoundTotal is known, every expected
  //    lane must exist AND be terminal. Pending lanes always block.
  if (expectedTotal != null && lanes.length < expectedTotal) {
    reasons.push(`dispatch gap: only ${lanes.length} of ${expectedTotal} expected lanes exist for round ${round}`);
  }
  if (pendingLanes.length > 0) {
    reasons.push(`${pendingLanes.length} lane(s) still pending (non-terminal); finality blocked`);
  }
  if (nonSubstantiveLanes.length > 0) {
    reasons.push(`${nonSubstantiveLanes.length} succeeded lane(s) were wrapper-only/non-substantive and excluded from quorum`);
  }

  // 3) Per-target quorum (optional).
  const perTargetReport = {};
  if (perTarget != null) {
    const byTarget = new Map();
    for (const lane of lanes) {
      const key = targetKey(lane);
      if (!byTarget.has(key)) byTarget.set(key, { succeeded: 0, total: 0 });
      const entry = byTarget.get(key);
      entry.total += 1;
      if (classify(lane.status) === 'succeeded' && classifyLaneEvidence(lane).countsTowardQuorum) entry.succeeded += 1;
    }
    for (const [key, entry] of byTarget.entries()) {
      perTargetReport[key] = entry;
      if (entry.succeeded < perTarget) {
        reasons.push(`per-target '${key}' succeeded ${entry.succeeded} < required ${perTarget}`);
      }
    }
  }

  // 4) Evidence-first: a FINAL verdict must cite at least one succeeded-lane id.
  const succeededIds = succeededLanes.map((l) => l.id);
  const evidenceIdsCitedInDraft = citedEvidenceIds(draft, succeededIds);
  if (succeededLanes.length > 0 && evidenceIdsCitedInDraft.length === 0) {
    reasons.push('draft cites no succeeded-lane evidence id (fail-closed, evidence-first)');
  }

  const missingLanes = [...failedLanes, ...pendingLanes, ...nonSubstantiveLanes].map((l) => ({
    taskId: l.id,
    status: String(l.status || '').trim().toLowerCase() || 'unknown',
    worker: workerOf(l),
    evidenceClass: l.__evidence?.evidenceClass ?? classifyLaneEvidence(l).evidenceClass,
    reason: l.__evidence?.reason ?? classifyLaneEvidence(l).reason,
  }));
  const supersededLaneRecords = supersededLanes.map((l) => ({
    taskId: l.id,
    status: String(l.status || '').trim().toLowerCase() || 'unknown',
    worker: workerOf(l),
    evidenceClass: 'superseded_by_supplement',
    reason: `${l.__evidence?.evidenceClass || 'non_substantive'} superseded by compact supplement ${l.__supersededBy}`,
    supersededBy: l.__supersededBy,
  }));

  const verdict = reasons.length === 0 ? 'FINAL' : 'BLOCKED';

  return {
    verdict,
    round,
    expectedTotal,
    effectiveQuorum,
    succeeded: succeededLanes.length,
    failed: failedLanes.length,
    pending: pendingLanes.length,
    nonSubstantive: nonSubstantiveLanes.length,
    laneCount: lanes.length,
    succeededIds,
    missingLanes,
    supersededLanes: supersededLaneRecords,
    perTarget: perTarget != null ? perTargetReport : undefined,
    evidenceIdsCitedInDraft,
    reasons,
  };
}

// Find which succeeded-lane ids are actually referenced in the draft body.
function citedEvidenceIds(draft, succeededIds) {
  if (!hasText(draft) || succeededIds.length === 0) return [];
  const cited = [];
  for (const id of succeededIds) {
    // Substring match: drafts cite raw task ids (e.g. "task-abc123").
    if (draft.includes(id)) cited.push(id);
  }
  return cited;
}

// ─── Output rendering ───────────────────────────────────────────────────────

function preliminaryBanner(result) {
  const pendingList = result.missingLanes
    .filter((l) => PENDING_STATUSES.has(l.status))
    .map((l) => l.taskId);
  const pendingDesc = pendingList.length ? pendingList.join(', ') : 'none';
  return `> ⚠️ PRELIMINARY — finalizer-only analysis; A2AD worker quorum NOT satisfied `
    + `(${result.succeeded}/${result.effectiveQuorum} succeeded, lanes pending: ${pendingDesc})`;
}

function renderMissing(result) {
  const lines = [];
  lines.push('Missing / non-succeeded evidence lanes:');
  if (result.missingLanes.length === 0) {
    lines.push('  (none)');
  } else {
    for (const lane of result.missingLanes) {
      lines.push(`  - ${lane.taskId} [${lane.status}]${lane.worker ? ` worker=${lane.worker}` : ''}${lane.evidenceClass ? ` class=${lane.evidenceClass}` : ''}${lane.reason ? ` reason=${lane.reason}` : ''}`);
    }
  }
  if (result.supersededLanes?.length) {
    lines.push('Superseded evidence lanes:');
    for (const lane of result.supersededLanes) {
      lines.push(`  - ${lane.taskId} [${lane.status}]${lane.worker ? ` worker=${lane.worker}` : ''} class=${lane.evidenceClass} supersededBy=${lane.supersededBy}${lane.reason ? ` reason=${lane.reason}` : ''}`);
    }
  }
  if (result.expectedTotal != null && result.laneCount < result.expectedTotal) {
    lines.push(`  ! dispatch gap: ${result.laneCount}/${result.expectedTotal} expected lanes present`);
  }
  return lines.join('\n');
}

function usage() {
  return `Usage: node scripts/a2ad-finalizer-gate.mjs --tasks <file> --round <parentRoundId> [options]

Fail-closed gate: a GitHub finalizer review may be published as an A2AD
consensus result only when the worker quorum is actually satisfied. Reads task
records offline from an operator dump; never posts to GitHub, never accesses a
live broker, never deploys/restarts/sends/mutates.

Required:
  --tasks <file>         JSON array of task records or { items: [...] }
  --round <id>           parentRoundId to evaluate

Quorum policy:
  --quorum <N>           min succeeded lanes (default: parentRoundTotal, else lane count)
  --per-target <N>       min succeeded lanes per reviewTarget/intent key (optional)

Draft / publication:
  --draft <file>         would-post markdown body (required for FINAL evidence check)
  --allow-preliminary    exit 0 but rewrite draft with a loud PRELIMINARY banner
  --out <file>           write rewritten/draft body here (default: stdout)
  --dry-run              print would-post body + missing-evidence list, no verdict side effects
  --json                 emit machine-readable verdict JSON
  --help                 show this help

Exit codes:
  0  FINAL (quorum satisfied) — or --allow-preliminary / --dry-run
  1  BLOCKED (quorum not satisfied) — do NOT publish a consensus result`;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        tasks: { type: 'string' },
        round: { type: 'string' },
        quorum: { type: 'string' },
        'per-target': { type: 'string' },
        draft: { type: 'string' },
        out: { type: 'string' },
        'allow-preliminary': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (!hasText(values.tasks)) {
    process.stderr.write('error: --tasks <file> is required\n');
    return 2;
  }
  if (!hasText(values.round)) {
    process.stderr.write('error: --round <parentRoundId> is required\n');
    return 2;
  }

  const quorum = values.quorum != null ? parseCount('--quorum', values.quorum) : null;
  const perTarget = values['per-target'] != null ? parseCount('--per-target', values['per-target']) : null;

  let tasks;
  let draft = '';
  try {
    tasks = readTasks(values.tasks);
    if (hasText(values.draft)) {
      draft = fs.readFileSync(values.draft, 'utf8');
    }
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 2;
  }

  let result;
  try {
    result = computeVerdict(tasks, { round: values.round, quorum, perTarget, draft });
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 2;
  }

  // Dry-run: print the would-post body + missing-evidence list, no side effects.
  if (values['dry-run']) {
    if (values.json) {
      process.stdout.write(`${JSON.stringify(toJson(result), null, 2)}\n`);
    } else {
      process.stdout.write('=== would-post body ===\n');
      process.stdout.write(`${draft}\n`);
      process.stdout.write('=== gate evaluation ===\n');
      process.stdout.write(`verdict (informational): ${result.verdict}\n`);
      process.stdout.write(`${renderMissing(result)}\n`);
    }
    return 0;
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(toJson(result), null, 2)}\n`);
  }

  if (result.verdict === 'FINAL') {
    if (!values.json) {
      writeBody(draft, values.out);
      process.stderr.write(`verdict: FINAL — quorum satisfied (${result.succeeded}/${result.effectiveQuorum} succeeded)\n`);
    }
    return 0;
  }

  // BLOCKED.
  if (values['allow-preliminary']) {
    const banner = preliminaryBanner(result);
    const rewritten = `${banner}\n\n${draft}`;
    writeBody(rewritten, values.out);
    if (!values.json) {
      process.stderr.write('verdict: BLOCKED — emitted PRELIMINARY-banner draft (--allow-preliminary)\n');
      for (const reason of result.reasons) process.stderr.write(`  - ${reason}\n`);
    }
    return 0;
  }

  if (!values.json) {
    process.stderr.write('verdict: BLOCKED — must NOT publish A2AD consensus result\n');
    for (const reason of result.reasons) process.stderr.write(`  - ${reason}\n`);
    process.stderr.write(`${renderMissing(result)}\n`);
  }
  return 1;
}

function parseCount(flag, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    process.stderr.write(`error: ${flag} must be a non-negative integer\n`);
    process.exit(2);
  }
  return n;
}

function writeBody(body, outFile) {
  if (hasText(outFile)) {
    fs.writeFileSync(outFile, body.endsWith('\n') ? body : `${body}\n`);
  } else {
    process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
  }
}

function toJson(result) {
  return {
    verdict: result.verdict,
    round: result.round,
    expectedTotal: result.expectedTotal,
    succeeded: result.succeeded,
    failed: result.failed,
    pending: result.pending,
    nonSubstantive: result.nonSubstantive,
    missingLanes: result.missingLanes,
    supersededLanes: result.supersededLanes,
    evidenceIdsCitedInDraft: result.evidenceIdsCitedInDraft,
  };
}

// Direct invocation guard (so the test can import without running main).
if (process.argv[1] && /a2ad-finalizer-gate(\.mjs)?$/.test(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}

export {
  computeVerdict,
  classify,
  readTasks,
  targetKey,
  citedEvidenceIds,
  preliminaryBanner,
  SUCCEEDED_STATUSES,
  FAILED_STATUSES,
  PENDING_STATUSES,
};

/**
 * source-public-gate-kit: shared pieces for the source-public gate family of
 * read-only validators (#2350 PR-3 lane A3).
 *
 * Consumers:
 *   - scripts/a2a-source-dryrun-aggregator.mjs
 *   - scripts/a2a-source-public-approval-rehearsal.mjs
 *   - scripts/a2a-source-public-execution-orchestrator.mjs
 *   - scripts/a2a-source-public-final-go-nogo-gate.mjs
 *   - scripts/a2a-team2-source-public-approval-rehearsal.mjs
 *   - scripts/check-parent-round-closeout-go-nogo-matrix.mjs
 *
 * Every helper here was lifted verbatim from copies that had drifted apart
 * only in comments, a message suffix, or a gate id. The known per-script
 * differences are explicit parameters (see each helper's JSDoc) so the
 * observable behaviour of each CLI — stdout/stderr text, JSON shapes, exit
 * codes, error messages — stays byte-identical to the pre-dedup scripts.
 *
 * Nothing in this module performs live actions: no deploy, Gateway restart,
 * Telegram/provider send, DB mutation, terminal ACK, release, or visibility
 * change.
 */
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${file}: ${error.message}`);
  }
}

export function hasEvidence(value) {
  return Array.isArray(value?.evidence) && value.evidence.some((entry) => typeof entry === 'string' && entry.trim());
}

/** Redaction rules shared by every gate validator (team2 appends one extra rule). */
export const unredactedEvidenceRules = [
  {
    kind: 'secret-assignment',
    re: /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*['"]?(?!<|\$\{|YOUR_|redacted|REDACTED)[^'"\s#]{12,}/i,
  },
  { kind: 'github-token-shape', re: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'aws-access-key-shape', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'absolute-private-path', re: /\/(?:home|Users)\/[^\s'")`]+|\/root\/private\/[^\s'")`]+/ },
  { kind: 'raw-session-dump', re: /(?:^|\n)\s*(?:system|developer|assistant|user|tool)\s*<\|/i },
];

/** Runtime/bootstrap context files that must never enter evidence or a branch. */
export const RUNTIME_BOOTSTRAP_DENY_PATHS = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**'];

/** Live-action flags every spec must list under `forbiddenLiveFlags` (closeout appends more). */
export const BASE_FORBIDDEN_LIVE_FLAGS = [
  'approvalExecution', 'releasePublication', 'repositoryVisibilityChange',
  'productionDeploy', 'gatewayRestart', 'brokerRestart', 'workerRestart',
  'terminalAck', 'liveProviderSend', 'productionDbMutation', 'forcePush',
  'communityPost', 'automaticMerge', 'automaticApproval',
];

/** Normalised gate status: `MISSING` when absent, otherwise upper-cased. */
export function gateStatus(gate) {
  return String(gate?.status || 'MISSING').toUpperCase();
}

export function evidenceEntries(gateStatuses) {
  return Object.entries(gateStatuses || {}).flatMap(([gateId, gate]) => {
    if (!Array.isArray(gate?.evidence)) return [];
    return gate.evidence
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .map((entry) => ({ gateId, entry }));
  });
}

/**
 * Every (gate, evidence entry, rule) hit, in gate → entry → rule order.
 * Callers map hits onto their own blocker shape.
 */
export function findUnredactedEvidence(gateStatuses, rules = unredactedEvidenceRules) {
  const hits = [];
  for (const { gateId, entry } of evidenceEntries(gateStatuses)) {
    for (const rule of rules) {
      if (rule.re.test(entry)) hits.push({ gateId, entry, kind: rule.kind });
    }
  }
  return hits;
}

export function unredactedReason(kind) {
  return `evidence is not redacted (${kind})`;
}

/**
 * Leading spec checks: failClosed → decisionOutputs (when `decisionOutputs`
 * is given) → defaultDecision. The dry-run aggregator has no decisionOutputs
 * check and uses the hyphenated `NO-GO` token; both are parameters.
 */
export function collectSpecHeadFailures(spec, { decisionOutputs, defaultDecision }) {
  const failures = [];
  if (spec.failClosed !== true) failures.push('spec.failClosed must be true');
  if (decisionOutputs) {
    if (!spec.decisionOutputs || !Array.isArray(spec.decisionOutputs)) {
      failures.push('spec.decisionOutputs must be an array');
    } else {
      for (const output of decisionOutputs) {
        if (!spec.decisionOutputs.includes(output)) failures.push(`spec.decisionOutputs missing ${output}`);
      }
    }
  }
  if (spec.defaultDecision !== defaultDecision) failures.push(`spec.defaultDecision must be ${defaultDecision}`);
  return failures;
}

/**
 * Required-gate spec checks shared by the dry-run, rehearsal, orchestrator and
 * final-gate validators: goDecisionRequires/gates non-empty → mandatory gates
 * present → each required gate fail-closed with documented evidence →
 * runtimeBootstrapHygiene denyPaths.
 */
export function collectRequiredGateSpecFailures(spec, mandatoryGoGates) {
  const failures = [];
  if (!Array.isArray(spec.goDecisionRequires) || spec.goDecisionRequires.length === 0) {
    failures.push('spec.goDecisionRequires must list required GO gates');
  }
  if (!Array.isArray(spec.gates) || spec.gates.length === 0) failures.push('spec.gates must be non-empty');

  const goDecisionRequires = new Set(spec.goDecisionRequires || []);
  for (const id of mandatoryGoGates) {
    if (!goDecisionRequires.has(id)) failures.push(`spec.goDecisionRequires missing mandatory gate: ${id}`);
  }

  const gates = new Map((spec.gates || []).map((gate) => [gate.id, gate]));
  for (const id of spec.goDecisionRequires || []) {
    const gate = gates.get(id);
    if (!gate) {
      failures.push(`required gate missing from spec.gates: ${id}`);
      continue;
    }
    if (gate.failClosed !== true) failures.push(`${id}: failClosed must be true`);
    if (gate.requiredForGo !== true) failures.push(`${id}: requiredForGo must be true`);
    if (!gate.blockedWhenMissing) failures.push(`${id}: blockedWhenMissing is required`);
    if (!hasEvidence(gate)) failures.push(`${id}: gate evidence requirements must be documented`);
  }

  const hygiene = gates.get('runtimeBootstrapHygiene');
  if (hygiene) {
    const denyPaths = new Set(hygiene.denyPaths || []);
    for (const requiredPath of RUNTIME_BOOTSTRAP_DENY_PATHS) {
      if (!denyPaths.has(requiredPath)) failures.push(`runtimeBootstrapHygiene.denyPaths missing ${requiredPath}`);
    }
  }

  return failures;
}

export function collectForbiddenLiveFlagFailures(spec, flags) {
  const failures = [];
  const forbidden = new Set(spec.forbiddenLiveFlags || []);
  for (const flag of flags) {
    if (!forbidden.has(flag)) failures.push(`forbiddenLiveFlags missing ${flag}`);
  }
  return failures;
}

/**
 * Validate broker readiness evidence packet.
 * `passedDetail` is the success detail text (the orchestrator copy worded it
 * differently; the value is never surfaced as a blocker).
 */
export function validateBrokerReadiness(evidence, { passedDetail = 'broker health, workers, queue/stale, and migration checks passed' } = {}) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, check: 'brokerReadiness', detail: 'missing broker readiness evidence packet' };
  }
  const blockers = [];
  const health = evidence.health ?? evidence.liveReadiness?.health ?? {};
  if (health.ok !== true && health.status !== 'ok' && health.status !== 200) {
    blockers.push('health: not ok');
  }
  const expectedWorkers = evidence.expectedWorkers ?? [];
  const onlineIds = evidence.onlineWorkerIds ?? evidence.workerMatrix?.onlineIds ?? [];
  if (Array.isArray(expectedWorkers) && expectedWorkers.length > 0) {
    const missing = expectedWorkers.filter((id) => !onlineIds.includes(id));
    if (missing.length > 0) blockers.push(`workers: missing ${missing.join(', ')}`);
  } else if (Array.isArray(onlineIds) && onlineIds.length === 0) {
    blockers.push('workers: no online workers');
  }
  const queue = evidence.queue ?? evidence.capacity?.queue ?? {};
  const queued = Number(queue.queued ?? 0);
  const claimed = Number(queue.claimed ?? 0);
  const running = Number(queue.running ?? 0);
  const stale = Number(evidence.stale ?? queue.stale ?? 0);
  if (queued !== 0 || claimed !== 0 || running !== 0 || stale !== 0) {
    blockers.push(`queue/stale: queued=${queued}, claimed=${claimed}, running=${running}, stale=${stale}`);
  }
  if (evidence.migrationHealthGate && evidence.migrationHealthGate.ok === false) {
    blockers.push('migrationHealthGate: failed');
  }
  if (blockers.length > 0) {
    return { ok: false, check: 'brokerReadiness', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'brokerReadiness', detail: passedDetail };
}

/**
 * Validate plugin readiness evidence packet.
 * `contextSuffix` is appended to the two "must be disabled" blockers
 * (`' for dry-run'`, `' for approval rehearsal'`, or `''`).
 */
export function validatePluginReadiness(evidence, { contextSuffix = '' } = {}) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, check: 'pluginReadiness', detail: 'missing plugin readiness evidence packet' };
  }
  const blockers = [];
  if (evidence.liveTelegramConfigured === true || evidence.providerDeliveryEnabled === true || evidence.notificationEnabled === true) {
    blockers.push(`live Telegram/provider delivery is configured; must be disabled${contextSuffix}`);
  }
  if (evidence.operatorEventsEnabled === true) {
    blockers.push(`operator events are enabled; must be disabled${contextSuffix}`);
  }
  if (evidence.gatewayHealth && evidence.gatewayHealth.ok !== true) {
    blockers.push('gateway health: not ok');
  }
  if (evidence.operatorApproval === true) {
    blockers.push('operator approval is bundled into plugin evidence; must be a separate gate');
  }
  if (blockers.length > 0) {
    return { ok: false, check: 'pluginReadiness', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'pluginReadiness', detail: 'plugin read-only projection verified; no live delivery configured' };
}

/**
 * Validate runner readiness evidence packet.
 */
export function validateRunnerReadiness(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, check: 'runnerReadiness', detail: 'missing runner readiness evidence packet' };
  }
  const blockers = [];
  if (!evidence.artifactManifest) {
    blockers.push('missing artifact manifest');
  } else if (evidence.artifactManifest.ok !== true) {
    blockers.push('artifact manifest: not ok');
  }
  if (!evidence.scannerProfile) {
    blockers.push('missing deterministic scanner/history scan profile');
  } else if (evidence.scannerProfile.ok !== true) {
    blockers.push('scanner profile: not ok');
  }
  if (evidence.productionDeploy === true) blockers.push('production deploy flag is set');
  if (evidence.providerCalled === true) blockers.push('provider called flag is set');
  if (blockers.length > 0) {
    return { ok: false, check: 'runnerReadiness', detail: blockers.join('; ') };
  }
  return { ok: true, check: 'runnerReadiness', detail: 'artifact manifest, scanner profile, and runner state passed' };
}

/**
 * Domain-specific deep validation dispatch for the three readiness gates.
 * Returns `undefined` for any other gate id.
 * `options`: `{ pluginContextSuffix, brokerPassedDetail }`.
 */
export function validateReadinessGate(id, evidencePacket, { pluginContextSuffix, brokerPassedDetail } = {}) {
  switch (id) {
    case 'brokerReadiness':
      return validateBrokerReadiness(evidencePacket, brokerPassedDetail === undefined ? {} : { passedDetail: brokerPassedDetail });
    case 'pluginReadiness':
      return validatePluginReadiness(evidencePacket, pluginContextSuffix === undefined ? {} : { contextSuffix: pluginContextSuffix });
    case 'runnerReadiness':
      return validateRunnerReadiness(evidencePacket);
    default:
      return undefined;
  }
}

/**
 * Per required gate: status blocker, missing-evidence blocker, then (when
 * `validateDomain` is given and the gate is GO with an evidencePacket) the
 * domain blocker. Returns a fresh blockers array callers keep appending to.
 */
export function collectRequiredGateBlockers(spec, gateStatuses, { validateDomain } = {}) {
  const blockers = [];
  for (const id of spec.goDecisionRequires || []) {
    const gate = gateStatuses[id];
    const status = gateStatus(gate);

    if (status !== 'GO') {
      blockers.push({ gate: id, status, reason: `status is ${status}` });
    }
    if (!hasEvidence(gate)) {
      blockers.push({ gate: id, status, reason: 'redacted evidence link is missing' });
    }

    if (validateDomain && status === 'GO' && gate?.evidencePacket) {
      const domainResult = validateDomain(id, gate.evidencePacket);
      if (domainResult && !domainResult.ok) {
        blockers.push({ gate: id, status, reason: domainResult.detail });
      }
    }
  }
  return blockers;
}

/**
 * Determine the GO_CANDIDATE / NEEDS_OPERATOR_APPROVAL / NO_GO decision.
 *
 * - GO_CANDIDATE: all required gates are GO with evidence, operator gate GO with evidence
 * - NEEDS_OPERATOR_APPROVAL: all gates GO except the operator gate
 * - NO_GO: any required gate is not GO (including MISSING)
 *
 * `operatorGateId` is `operatorApproval` (rehearsal) or `operatorExecutionGate` (orchestrator).
 */
export function computeDecision(gateStatuses, spec, operatorGateId) {
  const operatorGate = gateStatuses[operatorGateId];
  const operatorGo = operatorGate?.status === 'GO';
  const operatorHasEvidence = hasEvidence(operatorGate);

  let allOtherGo = true;
  for (const id of spec.goDecisionRequires || []) {
    if (id === operatorGateId) continue;
    const gate = gateStatuses[id];
    const status = gateStatus(gate);
    if (status !== 'GO') {
      allOtherGo = false;
      break;
    }
    if (!hasEvidence(gate)) {
      allOtherGo = false;
      break;
    }
  }

  if (allOtherGo && operatorGo && operatorHasEvidence) {
    return 'GO_CANDIDATE';
  }
  if (allOtherGo && !operatorGo) {
    return 'NEEDS_OPERATOR_APPROVAL';
  }
  return 'NO_GO';
}

/** Per-gate status summary rows for the report (`gateStatuses` may be any gate lookup). */
export function buildGateResults(spec, gateStatuses) {
  const gateNames = new Map((spec.gates || []).map((gate) => [gate.id, gate.title]));
  const gateResults = [];
  for (const id of spec.goDecisionRequires || []) {
    const gate = gateStatuses?.[id];
    const status = gateStatus(gate);
    const evidenceUrls = Array.isArray(gate?.evidence) ? gate.evidence.filter((e) => typeof e === 'string') : [];
    gateResults.push({
      gate: id,
      title: gateNames.get(id) || id,
      status,
      ok: status === 'GO' && evidenceUrls.length > 0,
      evidenceCount: evidenceUrls.length,
    });
  }
  return gateResults;
}

/** Trimmed, non-empty evidence strings of the operator-approval gate. */
export function collectOperatorEvidence(operatorGate) {
  return new Set(
    (operatorGate?.evidence || [])
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/** Evidence entries of other gates that reuse an operator-approval evidence string. */
export function findOperatorEvidenceOverlap(gateStatuses, operatorGateId, operatorEvidence) {
  return evidenceEntries(gateStatuses).filter(
    ({ gateId, entry }) => gateId !== operatorGateId && operatorEvidence.has(entry.trim()),
  );
}

/** Redact an idempotency key for public evidence (show prefix only). */
export function redactKey(key) {
  if (key.length <= 12) return `${key.substring(0, 4)}...`;
  return `${key.substring(0, 12)}...`;
}

/** Simple hash for idempotency keys (not cryptographic; for reference only). */
export function hashKey(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `sha256:${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/** `${prefix}-${truthy components joined by '-'}`; never includes secrets or raw evidence. */
export function deriveIdempotencyKey(prefix, ...components) {
  return `${prefix}-${components.filter(Boolean).join('-')}`;
}

/** Print the report (markdown or JSON) to stdout when ok, stderr otherwise; exit accordingly. */
export function emitGateReport(report, format, renderMarkdown) {
  if (format === 'markdown') {
    (report.ok ? console.log : console.error)(renderMarkdown(report));
  } else {
    (report.ok ? console.log : console.error)(JSON.stringify(report, null, 2));
  }

  process.exit(report.ok ? 0 : 1);
}

/**
 * Shared CLI tail: resolve + read spec → validateSpec (phase `spec` failures)
 * → optional mode rejection (phase `spec` error) → spec-only payload when no
 * input was given → load inputs → build → emit. Any throw prints
 * `{ ok: false, error }` and exits 1.
 *
 * - `rejectMode(spec, values)` returns an error string to reject, or a falsy value.
 * - `hasInput(values)` defaults to `Boolean(values.input)`.
 * - `loadInputs(values)` defaults to `[readJson(path.resolve(values.input))]`;
 *   its elements are spread into `buildReport(spec, ...inputs)`.
 * - `run({ spec, specPath, values })` replaces everything after the spec-only
 *   check for scripts whose body is not build → emit.
 */
export function runGateCli({
  values,
  validateSpec,
  rejectMode,
  hasInput = (opts) => Boolean(opts.input),
  specOnlyPayload,
  loadInputs = (opts) => [readJson(path.resolve(opts.input))],
  buildReport,
  renderMarkdown,
  run,
}) {
  try {
    const specPath = path.resolve(values.spec);
    const spec = readJson(specPath);
    const specFailures = validateSpec(spec);
    if (specFailures.length) {
      console.error(JSON.stringify({ ok: false, phase: 'spec', failures: specFailures }, null, 2));
      process.exit(1);
    }

    if (rejectMode) {
      const error = rejectMode(spec, values);
      if (error) {
        console.error(JSON.stringify({ ok: false, phase: 'spec', error }, null, 2));
        process.exit(1);
      }
    }

    if (!hasInput(values)) {
      console.log(JSON.stringify(specOnlyPayload(spec, values), null, 2));
      process.exit(0);
    }

    if (run) {
      run({ spec, specPath, values });
      return;
    }

    const report = buildReport(spec, ...loadInputs(values));
    emitGateReport(report, values.format, renderMarkdown);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  }
}

#!/usr/bin/env node
// Broker terminal-outbox preflight for receipt-gated smoke readiness.
// This script is intentionally read-only: it checks /health and polls/replays
// terminal-outbox state, but it never calls the ACK endpoint or any notifier.
// Uses an embedded legacy residue classifier (#886) to distinguish current-window
// rows from legacy residue so that legacy rows do not block preflight health.

import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_LIMIT = 5;
const REQUESTER_ID = 'terminal-outbox-preflight';

// ---------------------------------------------------------------------------
// Legacy residue classifier (embedded, mirrors src/core/terminal-outbox-legacy-classifier.ts)
// Classifies terminal_outbox rows as current-window, legacy-residue, or unclassifiable.
// ---------------------------------------------------------------------------

const DEFAULT_LEGACY_RESIDUE_CUTOFF = '2026-05-04T07:10:00.000Z';
const EVIDENCE_URL_KEYS = ['prUrl', 'doneUrl', 'blockUrl'];

function classifyOutboxRow(row, cutoffMs) {
  const id = typeof row?.id === 'string' ? row.id : null;
  const effectiveCutoffMs = Number.isFinite(cutoffMs)
    ? cutoffMs
    : Date.parse(DEFAULT_LEGACY_RESIDUE_CUTOFF);

  const createdAtMs = typeof row?.createdAt === 'string' ? Date.parse(row.createdAt) : NaN;
  const preCutoff = Number.isFinite(createdAtMs) ? createdAtMs < effectiveCutoffMs : null;

  const taskBrief = row?.payload?.taskBrief;
  const hasTaskBrief = typeof taskBrief === 'string' && taskBrief.length > 0;
  const hasAnyEvidenceUrl = EVIDENCE_URL_KEYS.some((key) => {
    const value = row?.payload?.[key];
    return typeof value === 'string' && value.length > 0;
  });
  const missingEvidence = !hasAnyEvidenceUrl;

  const receiptStatus = row?.receipt?.status;
  const legacyReceiptStatus = receiptStatus === 'sent' || receiptStatus === 'provider_delivered_if_known';
  const ackEvidence = row?.ack?.evidence;
  const legacyAckEvidence = ackEvidence === 'provider_delivery_receipt';
  const receiptConfirmed = row?.ack?.status === 'receipt_confirmed';

  const hasAnySignal = preCutoff !== null || hasTaskBrief || !missingEvidence || legacyReceiptStatus || legacyAckEvidence || receiptConfirmed;
  if (!hasAnySignal) {
    return {
      id, origin: 'unclassifiable',
      signals: { preCutoff, hasTaskBrief, missingEvidence, legacyReceiptStatus, legacyAckEvidence, receiptConfirmed },
      reason: 'insufficient data to classify',
    };
  }

  const strongLegacySignals = (preCutoff === true ? 1 : 0) + (legacyReceiptStatus ? 1 : 0) + (legacyAckEvidence ? 1 : 0);
  const parts = [];
  let origin;
  let reason;

  if (strongLegacySignals >= 1) {
    origin = 'legacy-residue';
    if (preCutoff === true) parts.push('pre-cutoff');
    if (!hasTaskBrief) parts.push('missing taskBrief');
    if (missingEvidence) parts.push('missing evidence');
    if (legacyReceiptStatus) parts.push('legacy receipt status');
    if (legacyAckEvidence) parts.push('legacy ACK evidence');
    reason = `legacy residue: ${parts.join(', ')}`;
  } else if (!hasTaskBrief && missingEvidence) {
    origin = 'legacy-residue';
    parts.push('missing taskBrief', 'missing evidence');
    reason = `legacy residue: ${parts.join(', ')}`;
  } else if (!hasTaskBrief && preCutoff !== false && !receiptConfirmed) {
    origin = 'legacy-residue';
    parts.push('missing taskBrief');
    if (preCutoff === null) parts.push('cutoff unknown');
    reason = `legacy residue: ${parts.join(', ')}`;
  } else {
    origin = 'current-window';
    if (preCutoff === false) parts.push('post-cutoff');
    if (hasTaskBrief) parts.push('has taskBrief');
    if (!missingEvidence) parts.push('has evidence');
    if (receiptConfirmed) parts.push('receipt-confirmed');
    reason = `current window: ${parts.join(', ')}`;
  }

  return {
    id, origin,
    signals: { preCutoff, hasTaskBrief, missingEvidence, legacyReceiptStatus, legacyAckEvidence, receiptConfirmed },
    reason,
  };
}

function classifyOutboxRows(rows, cutoffMs) {
  const classifications = rows.map((row) => classifyOutboxRow(row, cutoffMs));
  const currentWindow = classifications.filter((c) => c.origin === 'current-window');
  const legacyResidue = classifications.filter((c) => c.origin === 'legacy-residue');
  const unclassifiable = classifications.filter((c) => c.origin === 'unclassifiable');
  const currentWindowBlockers = {
    missingEvidenceIds: currentWindow.filter((c) => c.signals.missingEvidence).map((c) => c.id).filter(Boolean),
    missingTaskBriefIds: currentWindow.filter((c) => !c.signals.hasTaskBrief).map((c) => c.id).filter(Boolean),
  };
  const legacyResidueSummary = legacyResidue.map((c) => ({ id: c.id, reason: c.reason }));
  return {
    total: classifications.length,
    currentWindow: currentWindow.length,
    legacyResidue: legacyResidue.length,
    unclassifiable: unclassifiable.length,
    classifications,
    currentWindowBlockers,
    legacyResidueSummary,
  };
}

// ---------------------------------------------------------------------------
// Preflight helpers
// ---------------------------------------------------------------------------

function ok(check, detail, extra = {}) {
  return { ok: true, check, detail, ...extra };
}

function fail(check, detail, extra = {}) {
  return { ok: false, check, detail, ...extra };
}

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const limitRaw = readOption('--limit') ?? process.env.TERMINAL_OUTBOX_PREFLIGHT_LIMIT;
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);

  return {
    baseUrl: readOption('--base-url') ?? process.env.BROKER_URL ?? DEFAULT_BASE_URL,
    edgeSecret: readOption('--edge-secret') ?? process.env.BROKER_EDGE_SECRET ?? process.env.EDGE_SECRET,
    afterId: readOption('--after-id') ?? process.env.TERMINAL_OUTBOX_AFTER_ID,
    limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
    json: argv.includes('--json'),
    noLive: argv.includes('--no-live') || argv.includes('--dry-run'),
  };
}

function buildHeaders(edgeSecret) {
  const headers = {
    'accept': 'application/json',
    'x-a2a-requester-id': REQUESTER_ID,
    'x-a2a-requester-role': 'operator',
  };
  if (edgeSecret) {
    headers['x-a2a-edge-secret'] = edgeSecret;
    // Older docs/examples used this spelling; include both to keep preflight
    // compatible with already-deployed protected brokers.
    headers['x-edge-secret'] = edgeSecret;
  }
  return headers;
}

function outboxUrl(baseUrl, { afterId, limit, reconcileUnacked }) {
  const url = new URL('/a2a/tasks/terminal-outbox', ensureTrailingSlash(baseUrl));
  url.searchParams.set('limit', String(limit));
  if (afterId) url.searchParams.set('after_id', afterId);
  if (reconcileUnacked) url.searchParams.set('reconcile_unacked', 'true');
  return url;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

async function readJsonResponse(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parseError: true, preview: text.slice(0, 160) };
  }
  return { response, body };
}

function summarizeEvent(event) {
  const payload = event?.payload ?? {};
  return {
    id: typeof event?.id === 'string' ? event.id : null,
    status: typeof payload.status === 'string' ? payload.status : null,
    worker: typeof payload.worker === 'string' ? payload.worker : undefined,
    repo: typeof payload.repo === 'string' ? payload.repo : undefined,
    issue: Number.isInteger(payload.issue) ? payload.issue : undefined,
    taskBrief: typeof payload.taskBrief === 'string' ? payload.taskBrief : undefined,
    evidenceUrl: firstEvidenceUrl(payload) ?? undefined,
    ackStatus: typeof event?.ack?.status === 'string' ? event.ack.status : 'unacknowledged',
  };
}

function firstEvidenceUrl(payload) {
  for (const key of ['prUrl', 'doneUrl', 'blockUrl']) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function containsUnsafeEvidenceUrl(event) {
  const payload = event?.payload ?? {};
  return ['prUrl', 'doneUrl', 'blockUrl'].some((key) => {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0 && !/^https?:\/\//.test(value);
  });
}

function isReceiptConfirmed(event) {
  return event?.ack?.status === 'receipt_confirmed';
}

function terminalReadiness(body, { reconcile }) {
  const events = Array.isArray(body?.events) ? body.events : [];
  const staleReceipt = events.filter((event) => event?.receipt?.status === 'stale');
  const unsafeEvidence = events.filter(containsUnsafeEvidenceUrl);
  const replayCandidates = Number.isInteger(body?.reconciledUnacked) ? body.reconciledUnacked : 0;

  // Run the legacy residue classifier to separate current-window rows from
  // legacy residue. Only current-window issues block the preflight; legacy
  // residue is reported but tolerated (#886).
  const classification = classifyOutboxRows(events);

  // Block only on non-receipt-confirmed rows that are either:
  //   - current-window (should have complete payload)
  //   - unclassifiable (can't safely assume legacy — err on blocking side)
  // Skip receipt-confirmed rows entirely (they are already terminal).
  // Legacy-residue rows are reported but do not block (#886).
  const blockerOriginSet = new Set(['current-window', 'unclassifiable']);
  const blockerIdSet = new Set();
  for (const c of classification.classifications) {
    if (!c.signals.receiptConfirmed && blockerOriginSet.has(c.origin) && c.id !== null) {
      blockerIdSet.add(c.id);
    }
  }

  const blockerCandidates = events.filter(
    (event) => event?.id && blockerIdSet.has(event.id),
  );

  const currentWindowBlockers = [];
  const blockerMissingEvidence = blockerCandidates.filter((event) => !firstEvidenceUrl(event?.payload));
  const blockerMissingTaskBrief = blockerCandidates.filter(
    (event) => typeof event?.payload?.taskBrief !== 'string' || event.payload.taskBrief.length === 0,
  );
  const blockerMissingWorker = blockerCandidates.filter(
    (event) => typeof event?.payload?.worker !== 'string' || event.payload.worker.length === 0,
  );

  if (unsafeEvidence.length > 0) currentWindowBlockers.push(`unsafe/non-HTTP evidence URLs=${unsafeEvidence.length}`);
  if (blockerMissingEvidence.length > 0) currentWindowBlockers.push(`current-window/unclassifiable missing evidence=${blockerMissingEvidence.length}`);
  if (blockerMissingWorker.length > 0) currentWindowBlockers.push(`current-window/unclassifiable missing worker=${blockerMissingWorker.length}`);
  if (blockerMissingTaskBrief.length > 0) currentWindowBlockers.push(`current-window/unclassifiable missing task brief=${blockerMissingTaskBrief.length}`);

  // Legacy residue counts (reported but do not block preflight)
  const legacyResidue = classification.legacyResidueSummary;
  const legacyMissingTaskBrief = legacyResidue.filter((r) => r.reason.includes('missing taskBrief'));
  const legacyMissingEvidence = legacyResidue.filter((r) => r.reason.includes('missing evidence'));

  const staleCursorOrReplayCandidates = reconcile ? replayCandidates + staleReceipt.length : staleReceipt.length;

  // Total counts for backward compatibility
  const allUnacked = events.filter((event) => !isReceiptConfirmed(event));
  const allMissingEvidence = events.filter((event) => !firstEvidenceUrl(event?.payload));
  const allMissingTaskBrief = events.filter(
    (event) => typeof event?.payload?.taskBrief !== 'string' || event.payload.taskBrief.length === 0,
  );

  return {
    unackedCount: allUnacked.length,
    receiptConfirmedCount: events.length - allUnacked.length,
    staleCursorOrReplayCandidates,
    // Current-window breakdown (these block preflight when unacked)
    currentWindowCount: classification.currentWindow,
    currentWindowMissingEvidenceCount: blockerMissingEvidence.length,
    currentWindowMissingWorkerCount: blockerMissingWorker.length,
    currentWindowMissingTaskBriefCount: blockerMissingTaskBrief.length,
    // Legacy residue breakdown (these do not block)
    legacyResidueCount: classification.legacyResidue,
    legacyResidueSummary: legacyResidue,
    legacyMissingTaskBriefCount: legacyMissingTaskBrief.length,
    legacyMissingEvidenceCount: legacyMissingEvidence.length,
    unclassifiableCount: classification.unclassifiable,
    // Total counts for backward compatibility
    missingEvidenceCount: allMissingEvidence.length,
    missingWorkerCount: allUnacked.filter(
      (event) => typeof event?.payload?.worker !== 'string' || event.payload.worker.length === 0,
    ).length,
    missingTaskBriefCount: allMissingTaskBrief.length,
    receiptConfirmedMissingTaskBriefCount: events.filter(isReceiptConfirmed).filter(
      (event) => typeof event?.payload?.taskBrief !== 'string' || event.payload.taskBrief.length === 0,
    ).length,
    unsafeEvidenceUrlCount: unsafeEvidence.length,
    blockers: currentWindowBlockers,
  };
}

function evaluateHealth(body, status) {
  if (status !== 200) return fail('broker health', `expected HTTP 200, got ${status}`);
  if (body?.ok === true || body?.status === 'ok') {
    const persistence = body.persistence?.kind ? `; persistence=${body.persistence.kind}` : '';
    const edge = body.requestSecurity?.edgeSecretRequired === true ? '; edge secret required' : '';
    return ok('broker health', `healthy${persistence}${edge}`);
  }
  return fail('broker health', 'health payload did not report ok');
}

function evaluateOutbox(body, status, { reconcile }) {
  const label = reconcile ? 'terminal-outbox replay' : 'terminal-outbox poll';
  if (status !== 200) return fail(label, `expected HTTP 200, got ${status}`);
  if (body?.kind !== 'task.terminal.outbox') return fail(label, 'unexpected outbox kind');
  if (!Array.isArray(body.events)) return fail(label, 'outbox events must be an array');
  const readiness = terminalReadiness(body, { reconcile });
  const unsafe = body.events.filter(containsUnsafeEvidenceUrl).map((event) => event.id ?? '<missing-id>');
  if (unsafe.length > 0) return fail(label, `found non-HTTP evidence URLs in ${unsafe.join(', ')}`, { readiness });
  const missingIds = body.events.filter((event) => typeof event?.id !== 'string' || event.id.length === 0).length;
  if (missingIds > 0) return fail(label, `${missingIds} event(s) missing stable id`, { readiness });
  if (readiness.blockers.length > 0) return fail(label, `terminal readiness blocked: ${readiness.blockers.join('; ')}`, { readiness });

  const summaries = body.events.map(summarizeEvent);
  const count = Number.isInteger(body.count) ? body.count : body.events.length;
  const replayNote = reconcile && Number.isInteger(body.reconciledUnacked)
    ? `; reconciledUnacked=${body.reconciledUnacked}`
    : '';
  const cwNote = `; current-window=${readiness.currentWindowCount}, legacy-residue=${readiness.legacyResidueCount}`;
  const readyNote = `; readiness unacked=${readiness.unackedCount}, receiptConfirmed=${readiness.receiptConfirmedCount}, staleReplay=${readiness.staleCursorOrReplayCandidates}`;
  return ok(label, `${count} event(s), cursor=${body.cursor ?? 'null'}${replayNote}${cwNote}${readyNote}`, {
    count, cursor: body.cursor ?? null, events: summaries, readiness,
  });
}

function sampleNoLiveOutboxBody() {
  return {
    kind: 'task.terminal.outbox',
    count: 1,
    cursor: 'terminal:no-live-task:succeeded:2026-05-04T00%3A00%3A00.000Z',
    events: [{
      id: 'terminal:no-live-task:succeeded:2026-05-04T00%3A00%3A00.000Z',
      kind: 'task.terminal',
      taskEventId: 1,
      createdAt: '2026-05-04T00:00:00.000Z',
      attempts: 0,
      receipt: { status: 'accepted', updatedAt: '2026-05-04T00:00:00.000Z' },
      payload: {
        taskId: 'no-live-task',
        status: 'succeeded',
        run: 'release-dryrun',
        worker: 'sogyo',
        repo: 'jinwon-int/a2a-broker',
        issue: 318,
        taskBrief: 'broker terminal payload no-live proof',
        doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/318#issuecomment-example',
        testSummary: 'synthetic broker payload; no provider call; no terminal ACK',
        createdAt: '2026-05-04T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:00.000Z',
        completedAt: '2026-05-04T00:00:00.000Z',
      },
    }],
  };
}

export function runNoLiveProof(options = {}) {
  const body = options.body ?? sampleNoLiveOutboxBody();
  const poll = evaluateOutbox(body, 200, { reconcile: false });
  const replay = evaluateOutbox({ ...body, reconciledUnacked: body.events?.length ?? 0 }, 200, { reconcile: true });
  const terminalPreviews = Array.isArray(body.events)
    ? body.events.map((event) => ({
        dryRun: true,
        wouldSendTo: 'operator-terminal-notifier',
        cursor: event.id,
        status: event.payload?.status,
        worker: event.payload?.worker,
        repo: event.payload?.repo,
        issue: event.payload?.issue,
        prUrl: event.payload?.prUrl,
        doneUrl: event.payload?.doneUrl,
        blockUrl: event.payload?.blockUrl,
        testSummary: event.payload?.testSummary,
      }))
    : [];
  const checks = [
    ok('run mode', 'no-live proof; no broker HTTP request, deploy, Gateway restart, Telegram send, DB mutation, or terminal ACK attempted'),
    poll,
    replay,
    ok('terminal payload dry-run', `${terminalPreviews.length} notifier preview(s); providerCalled=false; productionAckAttempted=false`, { terminalPreviews }),
    ok('ack safety', 'read-only synthetic proof only; no terminal-outbox ACK or notifier send attempted'),
  ];
  return {
    kind: 'terminal-outbox.no-live-proof',
    mode: 'no-live',
    providerCalled: false,
    productionAckAttempted: false,
    brokerHttpRequested: false,
    limit: options.limit ?? DEFAULT_LIMIT,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export async function runPreflight(options = {}) {
  if (options.noLive) return runNoLiveProof(options);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node runtime');

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const headers = buildHeaders(options.edgeSecret);
  const checks = [];

  const health = await readJsonResponse(fetchImpl, new URL('/health', ensureTrailingSlash(baseUrl)), headers);
  checks.push(evaluateHealth(health.body, health.response.status));

  const first = await readJsonResponse(fetchImpl, outboxUrl(baseUrl, { afterId: options.afterId, limit }), headers);
  const firstCheck = evaluateOutbox(first.body, first.response.status, { reconcile: false });
  checks.push(firstCheck);

  const replayAfterId = options.afterId ?? first.body?.cursor ?? undefined;
  const replay = await readJsonResponse(fetchImpl, outboxUrl(baseUrl, { afterId: replayAfterId, limit, reconcileUnacked: true }), headers);
  checks.push(evaluateOutbox(replay.body, replay.response.status, { reconcile: true }));

  checks.push(ok('ack safety', 'read-only preflight only; no terminal-outbox ACK or notifier send attempted'));
  return {
    kind: 'terminal-outbox.preflight',
    baseUrl,
    afterId: options.afterId ?? null,
    limit,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function printHuman(report) {
  console.log('A2A Broker terminal-outbox preflight (read-only)');
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.detail}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runPreflight(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}

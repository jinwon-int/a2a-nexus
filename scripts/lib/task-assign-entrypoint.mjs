/**
 * A2A task-assignment entrypoint — single-call facade over the existing
 * dispatch pipeline (#2187, parent #1601 S1).
 *
 * Problem it solves: an agent that receives a work request currently has to
 * assemble the manifest by hand, collect worker readiness separately, run the
 * dry-run, dispatch, and read tasks back — several error-prone steps that
 * historically produced trial-and-error dispatch scripts. This module gives
 * hosts and skills ONE programmatic entry point with three operations:
 *
 *   prepareAssignment()  → validate input, collect readiness, build and
 *                          validate the dispatcher manifest. ZERO broker
 *                          mutations; live mode performs GET-only reads.
 *   submitAssignment()   → journal-first, then prepare → re-check → dispatch
 *                          through the EXISTING a2a-dispatch-round engine →
 *                          readback → durable receipt.
 *   resumeAssignment()   → look up a preserved request by requestId and read
 *                          its tasks back. Never mints new IDs, never re-POSTs
 *                          terminal work.
 *
 * Reuse contract (#2187 §"확인한 소스 기준선"): the manifest shape, validation,
 * sequential submission, result classification and task readback are the
 * existing `scripts/a2a-dispatch-round.mjs` exports. Readiness records are
 * evaluated with the existing `scripts/a2a-worker-readiness-preflight.mjs`
 * evaluator when offline records are provided. This module adds only the
 * missing glue: input normalization with batched missingFields, readiness
 * collection (live GET /workers or offline snapshot), deterministic candidate
 * selection with recorded rationale, a durable crash-safe request journal,
 * admission readback/recovery, and a request-received→receipt timeline.
 *
 * Safety contract:
 *   - Broker credentials arrive ONLY via the trusted host context
 *     (`context.secret`); they are never logged, never returned in a receipt,
 *     never written to the journal, and never accepted from request text.
 *     `brokerUrl` likewise comes only from the trusted local routing profile
 *     carried in `context`; a brokerUrl inside the request text is rejected.
 *   - `prepare` is side-effect free (offline mode: no network at all; live
 *     mode: GET /workers only). Only `submit` creates tasks, and only for
 *     `execution: 'submit'` with a secret present.
 *   - Readiness fields the live broker API does not provide stay `unknown`;
 *     implementation (patch) lanes additionally require a trusted offline
 *     readiness record satisfying the existing #1034/#1597 gates (final
 *     authority: the dispatcher's own validateManifest, mirrored here only as
 *     a non-authoritative screening filter so obviously ineligible candidates
 *     are not selected).
 *   - The request journal is written BEFORE the first POST with the request
 *     id, deterministic lane ids and the canonical spec digest; retries reuse
 *     exactly those ids; a digest conflict fails closed instead of
 *     overwriting. Journal files are 0600 in a 0700 directory, symlink-
 *     rejected, written atomically (tmp+rename) under a per-request lock.
 *   - Ambiguous POST outcomes are never reported as success: lost responses
 *     and failed readbacks yield `admission_unconfirmed`, and an existing
 *     task that cannot be field-verified yields `existing` with an explicit
 *     `existing_task_match_unverified` reason code.
 *   - `nextAction` values come from a fixed allowlist; error text is
 *     control-character-stripped, length-capped and secret-redacted before it
 *     reaches a receipt, so hostile issue/error text cannot inject commands
 *     or secrets into agent-consumed output.
 *
 * Read-only with respect to everything except the broker POST performed by
 * `submitAssignment` and the journal directory it owns. It never deploys,
 * restarts, mutates DB/outbox state, ACKs/replays Terminal Brief records,
 * releases/tags, or moves secrets.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  A2A_REQUESTER_ROLES,
} from '../../packages/broker/src/core/requester-role-contract.mjs';
import {
  CLASS_ACCEPTED_UNCONFIRMED,
  CLASS_ALREADY_EXISTS,
  CLASS_CREATED,
  CLASS_FAILED,
  CLASS_PREFLIGHT_EXCLUDED,
  deriveLaneId,
  fetchTask,
  runDispatch,
  validateManifest,
} from '../a2a-dispatch-round.mjs';
import { evaluateWorkerReadiness } from '../a2a-worker-readiness-preflight.mjs';

// ─── Schema versions & constants ────────────────────────────────────────────

export const REQUEST_SCHEMA_VERSION = 'a2a.task-assign-request.v1';
export const RECEIPT_SCHEMA_VERSION = 'a2a.task-assign-receipt.v1';
/** Bumped when the deterministic lane message/payload templates change. */
export const LANE_TEMPLATE_VERSION = 1;

export const STATE_NEEDS_INPUT = 'needs_input';
export const STATE_BLOCKED = 'blocked';
export const STATE_PREPARED = 'prepared';
export const STATE_ADMITTED = 'admitted';
export const STATE_ADMISSION_UNCONFIRMED = 'admission_unconfirmed';
export const STATE_EXISTING = 'existing';
export const STATE_FAILED = 'failed';

export const ASSIGNEE_STATES = new Set([
  STATE_NEEDS_INPUT,
  STATE_BLOCKED,
  STATE_PREPARED,
  STATE_ADMITTED,
  STATE_ADMISSION_UNCONFIRMED,
  STATE_EXISTING,
  STATE_FAILED,
]);

/** Fixed allowlist — receipts never emit any other nextAction code. */
export const NEXT_ACTIONS = Object.freeze([
  'none',
  'provide_missing_fields',
  'resolve_worker_readiness',
  'retry_prepare',
  'resume_existing_task',
  'poll_task_readback',
  'verify_admission',
  'new_request_id_required',
]);

export const TIMELINE_EVENTS = Object.freeze([
  'requestReceived',      // host received the user request (host clock; may be missing)
  'intentReady',          // task specification (request input) normalized
  'toolEntered',          // entrypoint call started
  'readinessReady',       // registration/compatibility/readiness evaluation done
  'manifestValidated',    // the would-be dispatch manifest passed validation
  'firstSubmit',          // first POST attempt issued
  'admissionConfirmed',   // matching broker task admission evidence obtained
  'workerStarted',        // observed execution start; NEVER substituted/fabricated
]);

/** Task statuses treated as an observed execution start (never fabricated). */
const WORKER_STARTED_STATUSES = new Set(['claimed', 'running', 'started', 'active']);

/** How long an offline readiness snapshot may drive decisions. */
export const DEFAULT_READINESS_TTL_MS = 5 * 60_000;
/** Bounded retry budget for network/429 POST failures (auth/schema: zero). */
export const DEFAULT_MAX_SUBMIT_RETRIES = 1;
export const DEFAULT_RETRY_CAP_MS = 5_000;
/** A per-request lock older than this is considered abandoned (crashed). */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/** Receipts retained per journal record. */
const RECEIPT_HISTORY_LIMIT = 10;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SECRET_FIELD_PATTERN = /secret|token|password|authorization|credential/i;

// ─── Small helpers ──────────────────────────────────────────────────────────

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic JSON: sorted object keys, stable output for digests. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Sanitize untrusted detail text: flatten control chars, cap, redact secret. */
export function sanitizeDetail(detail, { secret, limit = 300 } = {}) {
  if (!hasText(detail)) return undefined;
  let text = String(detail)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (hasText(secret)) text = text.replaceAll(secret, '[REDACTED]');
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/** Deep-strip any secret-shaped key before a receipt leaves this module. */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_FIELD_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(child);
    }
    return out;
  }
  return value;
}

function normalizeIso(value, fallbackIso) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  if (!Number.isFinite(ms)) return fallbackIso;
  return new Date(ms).toISOString();
}

/**
 * Distinguish a trusted readiness RECORD (the preflight contract: node/
 * workerId keyed, carrying ok and capability fields) from a broker-view-shaped
 * row. Records drive the patch gates; view rows only carry view-level signals.
 */
function isReadinessRecordShape(record) {
  if (!isPlainObject(record)) return false;
  if (hasText(record.node)) return true;
  if (record.ok !== undefined) return true;
  return hasText(record.workerId) && !hasText(record.id);
}

// ─── Request normalization (batched missing fields) ─────────────────────────

/**
 * Normalize the assignment request. ALL missing fields are reported in one
 * batch (`missingFields[]`); present-but-invalid values land in
 * `invalidFields[]`. Neither request text nor issue bodies are trusted for
 * broker routing or authorization: a `brokerUrl` or secret-shaped field in
 * the request is reported and dropped (#2187 §2.1).
 *
 * Returns { ok, request, missingFields, invalidFields, reasonCodes, errors }.
 */
export function normalizeAssignRequest(raw) {
  const missingFields = [];
  const invalidFields = [];
  const reasonCodes = [];
  const errors = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      request: null,
      missingFields: ['request'],
      invalidFields,
      reasonCodes: [],
      errors: ['request must be a JSON object'],
    };
  }

  // Untrusted routing/credential material never enters the normalized request.
  for (const key of Object.keys(raw)) {
    if (key === 'brokerUrl' || SECRET_FIELD_PATTERN.test(key)) {
      invalidFields.push(`request.${key}`);
      reasonCodes.push('untrusted_broker_or_secret_input');
    }
  }

  const requestId = raw.requestId;
  if (!hasText(requestId)) missingFields.push('requestId');
  else if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    invalidFields.push('requestId');
  }

  const kind = raw.kind;
  if (!hasText(kind)) missingFields.push('kind');
  else if (kind !== 'analysis' && kind !== 'patch') invalidFields.push('kind');

  if (!hasText(raw.objective)) missingFields.push('objective');
  if (!hasText(raw.requestRef)) missingFields.push('requestRef');

  const target = isPlainObject(raw.target) ? raw.target : undefined;
  if (kind === 'patch') {
    if (!target) {
      missingFields.push('target', 'target.repo', 'target.declaredScope.paths', 'target.repoTests');
    } else {
      if (!hasText(target.repo)) missingFields.push('target.repo');
      else if (!REPO_PATTERN.test(target.repo.trim())) invalidFields.push('target.repo');
      const paths = target.declaredScope?.paths;
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every(hasText)) {
        missingFields.push('target.declaredScope.paths');
      }
      const tests = target.repoTests;
      if (!Array.isArray(tests) || tests.length === 0 || !tests.every(hasText)) {
        missingFields.push('target.repoTests');
      }
    }
  }

  let lanes;
  if (raw.lanes !== undefined) {
    if (!Array.isArray(raw.lanes) || raw.lanes.length === 0) {
      invalidFields.push('lanes');
    } else {
      lanes = raw.lanes.map((lane, index) => {
        if (!isPlainObject(lane)) {
          invalidFields.push(`lanes[${index}]`);
          return null;
        }
        const normalized = {};
        if (hasText(lane.id)) normalized.id = String(lane.id).trim();
        if (hasText(lane.intent)) normalized.intent = lane.intent.trim();
        if (hasText(lane.message)) normalized.message = lane.message;
        if (lane.payload !== undefined) {
          if (isPlainObject(lane.payload)) normalized.payload = lane.payload;
          else invalidFields.push(`lanes[${index}].payload`);
        }
        return normalized;
      }).filter((lane) => lane !== null);
    }
  }

  let workerPolicy;
  if (raw.workerPolicy !== undefined) {
    if (!isPlainObject(raw.workerPolicy)) invalidFields.push('workerPolicy');
    else {
      workerPolicy = {};
      const preferred = raw.workerPolicy.preferredWorkers;
      if (preferred !== undefined) {
        if (Array.isArray(preferred) && preferred.every(hasText)) {
          workerPolicy.preferredWorkers = preferred.map((id) => id.trim());
        } else invalidFields.push('workerPolicy.preferredWorkers');
      }
      const records = raw.workerPolicy.readinessRecords;
      if (records !== undefined) {
        if (Array.isArray(records) && records.every(isPlainObject)) {
          workerPolicy.readinessRecords = records;
        } else invalidFields.push('workerPolicy.readinessRecords');
      }
    }
  }

  let budget;
  if (raw.budget !== undefined) {
    if (!isPlainObject(raw.budget)) invalidFields.push('budget');
    else {
      budget = {};
      if (raw.budget.timeoutMs !== undefined) {
        if (Number.isFinite(raw.budget.timeoutMs) && raw.budget.timeoutMs > 0) {
          budget.timeoutMs = raw.budget.timeoutMs;
        } else invalidFields.push('budget.timeoutMs');
      }
    }
  }

  let correlation;
  if (raw.correlation !== undefined) {
    if (!isPlainObject(raw.correlation)) invalidFields.push('correlation');
    else {
      correlation = {};
      if (raw.correlation.requestReceivedAt !== undefined) {
        const ms = Date.parse(raw.correlation.requestReceivedAt);
        if (Number.isFinite(ms)) correlation.requestReceivedAt = new Date(ms).toISOString();
        else invalidFields.push('correlation.requestReceivedAt');
      }
      if (hasText(raw.correlation.correlationId)) {
        correlation.correlationId = raw.correlation.correlationId;
      }
    }
  }

  if (missingFields.length === 0 && invalidFields.length === 0) {
    const request = {
      schemaVersion: REQUEST_SCHEMA_VERSION,
      requestId: requestId.trim(),
      kind,
      objective: String(raw.objective).trim(),
      requestRef: String(raw.requestRef).trim(),
    };
    if (target) {
      request.target = { repo: target.repo.trim() };
      if (Array.isArray(target.declaredScope?.paths)) {
        request.target.declaredScope = { paths: target.declaredScope.paths.map((p) => String(p).trim()) };
      }
      if (Array.isArray(target.repoTests)) request.target.repoTests = target.repoTests.map(String);
      if (hasText(target.baseBranch)) request.target.baseBranch = target.baseBranch.trim();
      if (hasText(target.baseRevision)) {
        request.target.baseRevision = target.baseRevision.trim();
        if (!FULL_SHA_PATTERN.test(request.target.baseRevision)) {
          // A branch name is not a pinned revision: recorded, never guessed.
          reasonCodes.push('base_revision_unpinned');
        }
      }
      if (isPlainObject(target.hostSmoke)) request.target.hostSmoke = target.hostSmoke;
      if (hasText(target.title)) request.target.title = target.title.trim();
    }
    if (lanes) request.lanes = lanes;
    if (workerPolicy) request.workerPolicy = workerPolicy;
    if (budget) request.budget = budget;
    if (correlation) request.correlation = correlation;
    return { ok: true, request, missingFields, invalidFields, reasonCodes, errors };
  }

  return { ok: false, request: null, missingFields, invalidFields, reasonCodes, errors };
}

/**
 * Canonical digest over the SEMANTIC task specification. Same requestId with a
 * different digest is a conflict (fail-closed); this deliberately excludes
 * readiness evidence, mode, correlation and requester context.
 */
export function specDigestOf(request) {
  const semantic = {
    kind: request.kind,
    objective: request.objective,
    requestRef: request.requestRef,
    target: request.target,
    lanes: request.lanes,
    budget: request.budget,
    preferredWorkers: request.workerPolicy?.preferredWorkers,
  };
  return `sha256:${sha256Hex(stableJson(semantic))}`;
}

// ─── Durable request journal ────────────────────────────────────────────────

export class JournalLockedError extends Error {
  constructor(requestId) {
    super(`another submit holds the journal lock for request '${requestId}'`);
    this.name = 'JournalLockedError';
    this.requestId = requestId;
  }
}

export class JournalConflictError extends Error {
  constructor(requestId, existing) {
    super(`request '${requestId}' already recorded with a different specification`);
    this.name = 'JournalConflictError';
    this.requestId = requestId;
    this.existing = existing;
  }
}

/**
 * Crash-safe, owner-only request journal. One JSON record per request:
 * recorded BEFORE the first POST (id + deterministic lane ids + spec digest)
 * so a restart can recover exactly what was about to be admitted.
 */
export class TaskAssignJournal {
  constructor({ dir, now = Date.now, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = {}) {
    if (!hasText(dir)) throw new Error('TaskAssignJournal requires a directory');
    this.dir = dir;
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#assertSafeDir(dir);
  }

  #assertSafeDir(dir) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error(`journal dir must not be a symlink: ${dir}`);
    fs.chmodSync(dir, 0o700);
  }

  #recordPath(requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error(`invalid requestId: ${String(requestId)}`);
    }
    return path.join(this.dir, `${requestId}.json`);
  }

  #lockPath(requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      throw new Error(`invalid requestId: ${String(requestId)}`);
    }
    return path.join(this.dir, `${requestId}.lock`);
  }

  #assertNoSymlink(filePath) {
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) throw new Error(`journal path must not be a symlink: ${filePath}`);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }

  /** Atomic write (tmp + rename) with fsync, 0600, symlink-rejected. */
  #writeJsonAtomic(filePath, value) {
    this.#assertNoSymlink(filePath);
    const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  }

  read(requestId) {
    const filePath = this.#recordPath(requestId);
    this.#assertNoSymlink(filePath);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupt record: surface it instead of silently re-initializing.
      return { corrupt: true, requestId };
    }
  }

  /**
   * First-write-wins initialization. Throws JournalConflictError when the
   * same requestId was recorded with a different spec digest (#2187 §3.2).
   */
  recordInitial(requestId, initial) {
    const existing = this.read(requestId);
    if (existing) {
      if (existing.corrupt) {
        throw new JournalConflictError(requestId, existing);
      }
      if (existing.specDigest !== initial.specDigest) {
        throw new JournalConflictError(requestId, existing);
      }
      return { created: false, record: existing };
    }
    const nowIso = new Date(this.now()).toISOString();
    const record = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      requestId,
      specDigest: initial.specDigest,
      kind: initial.kind,
      laneIds: initial.laneIds,
      brokerUrl: initial.brokerUrl,
      requesterId: initial.requesterId,
      selectedWorkerId: initial.selectedWorkerId ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
      firstSubmitAt: initial.firstSubmitAt ?? null,
      taskIds: [],
      receipts: [],
    };
    this.#writeJsonAtomic(this.#recordPath(requestId), record);
    return { created: true, record };
  }

  /** Merge-update the record (read-modify-write; caller holds the lock). */
  update(requestId, patch) {
    const record = this.read(requestId);
    if (!record || record.corrupt) return null;
    const next = { ...record, ...patch, updatedAt: new Date(this.now()).toISOString() };
    if (Array.isArray(next.receipts) && next.receipts.length > RECEIPT_HISTORY_LIMIT) {
      next.receipts = next.receipts.slice(0, RECEIPT_HISTORY_LIMIT);
    }
    this.#writeJsonAtomic(this.#recordPath(requestId), next);
    return next;
  }

  /**
   * Run fn under an exclusive per-request lock. Concurrent callers receive
   * JournalLockedError (mapped to a blocked receipt by submitAssignment);
   * a lock older than lockTimeoutMs is treated as crash debris and broken.
   */
  async withLock(requestId, fn) {
    const lockPath = this.#lockPath(requestId);
    this.#assertNoSymlink(lockPath);
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: this.now() }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try {
        const stat = fs.statSync(lockPath);
        age = this.now() - stat.mtimeMs;
      } catch {
        age = Infinity;
      }
      if (age > this.lockTimeoutMs) {
        // Stale lock from a crashed holder — move it aside and take over.
        try {
          fs.renameSync(lockPath, `${lockPath}.stale-${this.now()}`);
        } catch {
          /* another process broke it first; fall through to retry once */
        }
        return this.withLock(requestId, fn);
      }
      throw new JournalLockedError(requestId);
    }
    try {
      return await fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* best-effort release; a leftover lock expires via lockTimeoutMs */
      }
    }
  }
}

// ─── Readiness collection (live GET / offline snapshot) ─────────────────────

function normalizeObservation(worker, observedAt) {
  if (!isPlainObject(worker)) return null;
  const workerId = hasText(worker.id) ? worker.id : (hasText(worker.nodeId) ? worker.nodeId : null);
  if (!workerId) return null;
  return {
    workerId,
    status: hasText(worker.status) ? worker.status : 'unknown',
    managementPlane: hasText(worker.managementPlane) ? worker.managementPlane : 'unknown',
    substantiveAnalysisReady: typeof worker.substantiveAnalysisReady === 'boolean'
      ? worker.substantiveAnalysisReady
      : null,
    lastSeenAt: hasText(worker.lastSeenAt) ? worker.lastSeenAt : null,
    capabilities: isPlainObject(worker.capabilities) ? worker.capabilities : null,
    metadata: isPlainObject(worker.metadata) ? worker.metadata : null,
    observedAt,
    source: 'broker:GET /workers',
  };
}

/**
 * Collect readiness observations.
 *
 * - mode 'live': GET {brokerUrl}/workers (read-only, edge-secret headers).
 *   Fields the API does not provide stay unknown — nothing is fabricated.
 * - mode 'offline': use the provided snapshot { observedAt, records } only.
 *   No network at all. A snapshot older than ttlMs is reported stale:true and
 *   MUST block submission decisions upstream.
 *
 * `records` always maps to plain observations so selection never depends on
 * raw broker response shape. Offline snapshot records keep their raw shape
 * under `record` for the dispatcher's workerReadiness gate.
 */
export async function collectReadiness({
  mode = 'live',
  fetchImpl,
  brokerUrl,
  authHeaders,
  snapshot,
  now = () => new Date().toISOString(),
  ttlMs = DEFAULT_READINESS_TTL_MS,
} = {}) {
  const nowValue = typeof now === 'function' ? now() : now;
  const observedAt = typeof nowValue === 'number' ? new Date(nowValue).toISOString() : nowValue;
  const nowMs = Date.parse(observedAt);
  if (mode === 'offline') {
    if (!isPlainObject(snapshot) || !Array.isArray(snapshot.records)) {
      return { source: 'offline', observedAt, stale: false, observations: [], errors: [{ code: 'offline_snapshot_missing' }] };
    }
    const snapshotAge = Date.parse(snapshot.observedAt ?? observedAt);
    const stale = Number.isFinite(snapshotAge) && Number.isFinite(nowMs) && (nowMs - snapshotAge) > ttlMs;
    const observations = snapshot.records
      .map((record) => {
        const base = normalizeObservation(record, snapshot.observedAt ?? observedAt);
        const observation = base ?? {
          workerId: hasText(record?.node) ? record.node : hasText(record?.workerId) ? record.workerId : null,
          status: 'unknown',
          managementPlane: 'unknown',
          substantiveAnalysisReady: null,
          lastSeenAt: null,
          capabilities: null,
          metadata: null,
          observedAt: snapshot.observedAt ?? observedAt,
          source: 'offline-snapshot',
        };
        if (!observation) return null;
        const evidence = isPlainObject(record?.record)
          ? record.record
          : (isReadinessRecordShape(record) ? record : undefined);
        return { ...observation, record: evidence };
      })
      .filter((observation) => observation !== null);
    return { source: 'offline', observedAt, stale, observations, errors: [] };
  }

  // live: GET-only contract. Never POSTs, never mutates.
  if (typeof fetchImpl !== 'function' || !hasText(brokerUrl)) {
    return { source: 'live', observedAt, stale: false, observations: [], errors: [{ code: 'live_read_unavailable' }] };
  }
  let res;
  try {
    res = await fetchImpl(`${String(brokerUrl).replace(/\/+$/, '')}/workers`, {
      method: 'GET',
      headers: isPlainObject(authHeaders) ? authHeaders : {},
    });
  } catch (error) {
    return {
      source: 'live',
      observedAt,
      stale: false,
      observations: [],
      errors: [{ code: 'workers_read_failed', detail: sanitizeDetail(error?.message) }],
    };
  }
  if (res.status !== 200) {
    return {
      source: 'live',
      observedAt,
      stale: false,
      observations: [],
      errors: [{ code: 'workers_read_failed', status: res.status }],
    };
  }
  let body;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return { source: 'live', observedAt, stale: false, observations: [], errors: [{ code: 'workers_read_invalid_body' }] };
  }
  const list = Array.isArray(body) ? body : (Array.isArray(body?.workers) ? body.workers : (Array.isArray(body?.rows) ? body.rows : null));
  if (!list) {
    return { source: 'live', observedAt, stale: false, observations: [], errors: [{ code: 'workers_read_invalid_body' }] };
  }
  const observations = list.map((worker) => normalizeObservation(worker, observedAt)).filter((o) => o !== null);
  return { source: 'live', observedAt, stale: false, observations, errors: [] };
}

// ─── Candidate selection (deterministic, rationale recorded) ────────────────

/**
 * Non-authoritative screening mirror of the dispatcher's #1034/#1597 patch
 * gates. FINAL authority is validateManifest inside the dispatch pipeline —
 * this exists only so an obviously ineligible candidate is not selected when
 * another candidate would pass.
 */
export function patchReadinessBlockers(record) {
  if (!isPlainObject(record)) return ['readiness record missing or malformed'];
  const blockers = [];
  if (record.ok !== true) blockers.push('ok is not true');
  const patchOk = record.githubPatch === true || record.githubPatch === 'ok'
    || (isPlainObject(record.githubPatch) && (record.githubPatch.ok === true || record.githubPatch.status === 'ok'));
  if (!patchOk) blockers.push('githubPatch is not ok');
  if (record.canPatchWorkspace !== true && record.canWritePatchPR !== true) blockers.push('no patch/PR write capability flag');
  if (record.canOpenPullRequest !== true && record.canWritePatchPR !== true) blockers.push('no open-PR capability flag');
  if (record.runnerTrustedOperator !== true && record.trustedOperator !== true) blockers.push('no trusted operator flag');
  if (record.githubTokenFileReadable !== true && record.githubTokenFileMounted !== false) blockers.push('github token file not confirmed readable');
  if (!(record.bridgeMode === 'patch' || record.patchBridge === true || record.canWritePatchPR === true)) blockers.push('no patch bridge flag');
  const capability = record.implementationCapability;
  if (!isPlainObject(capability)) blockers.push('implementationCapability profile missing');
  else {
    if (capability.capable !== true) blockers.push('implementationCapability.capable is not true');
    if (capability.availability !== 'canary_passed') blockers.push('implementationCapability.availability is not canary_passed');
  }
  return blockers;
}

/**
 * Deterministically pick one eligible candidate:
 *   1. preferredWorkers order (explicit user/operator preference), then
 *   2. lexicographic workerId (stable fallback — never a hardcoded node).
 * Failure-rate or latency rankings are advisory data and are NOT used here.
 */
export function selectWorker({ request, readiness, offlineEvaluator = evaluateWorkerReadiness } = {}) {
  const kind = request.kind;
  const preferred = Array.isArray(request.workerPolicy?.preferredWorkers) ? request.workerPolicy.preferredWorkers : [];
  const excluded = [];

  const rankOf = (workerId) => {
    const index = preferred.indexOf(workerId);
    return index === -1 ? preferred.length : index;
  };

  const eligible = [];
  for (const observation of readiness.observations) {
    const workerId = observation.workerId;
    if (observation.status !== 'online') {
      excluded.push({ workerId, reasonCode: 'worker_not_online' });
      continue;
    }
    if (observation.managementPlane === 'disconnected') {
      excluded.push({ workerId, reasonCode: 'management_plane_disconnected' });
      continue;
    }
    if (kind === 'analysis') {
      if (observation.source === 'broker:GET /workers') {
        if (observation.substantiveAnalysisReady !== true) {
          excluded.push({ workerId, reasonCode: 'substantive_analysis_not_ready' });
          continue;
        }
      } else if (observation.record) {
        // Offline observation with a trusted readiness record: evaluate it.
        const verdict = offlineEvaluator(observation.record, {});
        if (verdict?.ok !== true) {
          excluded.push({ workerId, reasonCode: 'offline_readiness_failed' });
          continue;
        }
      } else if (observation.substantiveAnalysisReady !== true) {
        // View-shaped offline row: only the view-level signal is available;
        // anything less fails closed.
        excluded.push({ workerId, reasonCode: 'substantive_analysis_not_ready' });
        continue;
      }
    } else {
      const record = observation.record;
      if (!record) {
        excluded.push({ workerId, reasonCode: 'patch_readiness_record_missing' });
        continue;
      }
      // The dispatcher's own #1034/#1597 checks on workerReadiness rows are
      // the final authority; this mirrors their row contract (ok + patch
      // flags + canary profile) without imposing the stricter host-collection
      // evaluator, so selection parity with the dispatcher is preserved.
      if (record.ok !== true) {
        excluded.push({ workerId, reasonCode: 'offline_readiness_failed' });
        continue;
      }
      const blockers = patchReadinessBlockers(record);
      if (blockers.length > 0) {
        excluded.push({ workerId, reasonCode: 'patch_readiness_ineligible', detail: sanitizeDetail(blockers.join('; ')) });
        continue;
      }
    }
    eligible.push(observation);
  }

  eligible.sort((a, b) => {
    const rankDelta = rankOf(a.workerId) - rankOf(b.workerId);
    if (rankDelta !== 0) return rankDelta;
    return String(a.workerId).localeCompare(String(b.workerId));
  });

  const selected = eligible[0] ?? null;
  if (!selected) return { selected: null, excluded, rationale: [] };

  const preferenceIndex = preferred.indexOf(selected.workerId);
  const rationale = [
    'eligible: online',
    kind === 'analysis' ? 'eligible: analysis capability confirmed' : 'eligible: patch readiness record passes #1034/#1597 screening',
    preferenceIndex >= 0 ? `order: preference_rank_${preferenceIndex}` : 'order: lexicographic_fallback',
  ];
  return { selected, excluded, rationale };
}

// ─── Manifest construction (versioned templates) ────────────────────────────

function patchLaneMessage(request) {
  const paths = request.target.declaredScope.paths.join(', ');
  const tests = request.target.repoTests.join(' && ');
  const lines = [
    `Implement ${request.objective}`,
    `Reference: ${request.requestRef}`,
    `Scope: change only ${paths}. Do not remove or weaken scope checks.`,
    `Tests: run ${tests} from the repository root and include the evidence in the PR.`,
    'Open a scoped PR; the finalizer owns review, merge and issue closure.',
  ];
  return lines.join('\n');
}

function analysisLaneMessage(request) {
  return [
    `${request.objective}`,
    `Reference: ${request.requestRef}`,
    'Report substantive analysis with evidence; do not treat admission or a host ACK as a result.',
  ].join('\n');
}

/**
 * Build a manifest in the EXISTING a2a-dispatch-round shape. Lane ids are
 * deterministic from the requestId so retries reuse exactly the recorded ids.
 */
export function buildManifest({ request, context, selected }) {
  const roundId = `assign-${request.requestId}`;
  const lanesInput = (request.lanes && request.lanes.length > 0 ? request.lanes : [{}]);

  const lanes = lanesInput.map((lane, index) => {
    const order = index + 1;
    const id = lane.id ?? deriveLaneId(roundId, {}, order);
    const intent = lane.intent ?? (request.kind === 'patch' ? 'propose_patch' : 'analyze');
    const message = lane.message ?? (request.kind === 'patch' ? patchLaneMessage(request) : analysisLaneMessage(request));
    const built = {
      id,
      target: { id: selected.workerId, kind: 'agent', role: 'analyst' },
      assignedWorkerId: selected.workerId,
      intent,
      message,
      payload: { ...(lane.payload ?? {}) },
    };

    if (request.kind === 'patch') {
      built.taskOrigin = 'github';
      const payload = built.payload;
      payload.mode = 'github-propose-patch';
      payload.repo = request.target.repo;
      if (request.target.title) payload.title = request.target.title;
      if (request.target.baseBranch) payload.baseBranch = request.target.baseBranch;
      if (request.target.declaredScope) payload.declaredScope = { paths: [...request.target.declaredScope.paths] };
      if (request.target.hostSmoke) payload.acceptance = { ...request.target.hostSmoke };
      payload.evidenceGate = 'Declared scope only, with repository test evidence. Finalizer verifies scope, independent review and CI before merge.';
      if (/^https:\/\/github\.com\//.test(request.requestRef)) payload.issueUrl = request.requestRef;
      if (request.budget?.timeoutMs !== undefined) payload.timeoutMs = request.budget.timeoutMs;
    } else if (request.budget?.timeoutMs !== undefined) {
      built.payload.timeoutMs = request.budget.timeoutMs;
    }
    return built;
  });

  const manifest = {
    roundId,
    brokerUrl: context.brokerUrl,
    requester: { id: context.requester.id, role: context.requester.role },
    lanes,
    laneTemplateVersion: LANE_TEMPLATE_VERSION,
  };
  if (request.kind === 'patch' && selected.record) {
    // Trusted offline readiness record: the dispatcher's #1034/#1597 gates are
    // the final authority over this row before any task is created.
    manifest.workerReadiness = { rows: [selected.record] };
  } else if (Array.isArray(request.workerPolicy?.readinessRecords) && request.workerPolicy.readinessRecords.length > 0) {
    manifest.workerReadiness = { rows: request.workerPolicy.readinessRecords };
  }
  return manifest;
}

// ─── Timeline (S1 instrumentation, #2187 §4) ────────────────────────────────

/**
 * Request→receipt event timeline. `requestReceived` exists only when the host
 * supplied a reception timestamp — it is recorded as missing otherwise and
 * never replaced by the tool-call start time.
 */
export function createTimeline({ correlation = {}, now = () => Date.now() } = {}) {
  const events = [];
  const at = () => new Date(now()).toISOString();
  if (correlation?.requestReceivedAt) {
    // Lazy fallback: a present host timestamp must not consume a clock tick.
    events.push({ event: 'requestReceived', at: normalizeIso(correlation.requestReceivedAt, undefined) ?? at(), source: 'host' });
  } else {
    events.push({ event: 'requestReceived', missing: true, source: 'host' });
  }
  if (correlation?.correlationId) {
    events.push({ event: 'requestReceived', at: at(), correlationId: correlation.correlationId, note: 'correlation id assigned by host' });
  }
  let enteredAtMs = null;
  return {
    events,
    mark(event, extra = {}) {
      const nowMs = now();
      if (event === 'toolEntered' && enteredAtMs === null) enteredAtMs = nowMs;
      events.push({ event, at: new Date(nowMs).toISOString(), ...extra });
    },
    durations() {
      const find = (name) => events.find((e) => e.event === name && e.at && !e.missing);
      const msBetween = (fromEvent, toEvent) => {
        const from = find(fromEvent);
        const to = find(toEvent);
        if (!from || !to) return null;
        const delta = Date.parse(to.at) - Date.parse(from.at);
        return Number.isFinite(delta) && delta >= 0 ? delta : null;
      };
      return {
        requestToFirstSubmitMs: msBetween('requestReceived', 'firstSubmit'),
        toolToReadinessMs: msBetween('toolEntered', 'readinessReady'),
        toolToManifestValidatedMs: msBetween('toolEntered', 'manifestValidated'),
        firstSubmitToAdmissionMs: msBetween('firstSubmit', 'admissionConfirmed'),
      };
    },
  };
}

// ─── Existing-task match verification ───────────────────────────────────────

/**
 * Verify a fetched broker task matches what we intended to submit. Only
 * fields PRESENT on the task are compared; a task that exposes none of them
 * is reported unverified rather than assumed to match (#2187 §3.3).
 */
export function existingTaskMatch(task, { requesterId, lane }) {
  if (!isPlainObject(task)) return { verified: false, compared: [] };
  const compared = [];
  let mismatches = 0;
  let verifiedAny = false;
  const compare = (label, expected, actual) => {
    compared.push(label);
    if (actual === undefined || actual === null) return;
    verifiedAny = true;
    if (String(actual) !== String(expected)) mismatches += 1;
  };
  compare('requester.id', requesterId, task.requester?.id);
  compare('target.id', lane.target.id, task.target?.id ?? task.assignedWorkerId);
  compare('intent', lane.intent, task.intent);
  compare('payload.repo', lane.payload?.repo, task.payload?.repo);
  if (!verifiedAny) return { verified: false, compared };
  return { verified: mismatches === 0, compared };
}

// ─── Receipt assembly ───────────────────────────────────────────────────────

function makeReceipt({
  requestId,
  state,
  reasonCodes = [],
  missingFields = [],
  nextAction = 'none',
  detail,
  planDigest,
  taskIds = [],
  lanes = [],
  readiness,
  manifest,
  plannedLanes,
  validationErrors,
  timeline,
  journalFile,
}) {
  if (!ASSIGNEE_STATES.has(state)) throw new Error(`unknown assign state: ${state}`);
  if (!NEXT_ACTIONS.includes(nextAction)) throw new Error(`nextAction '${nextAction}' is not allowlisted`);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    requestId,
    state,
    reasonCodes: [...reasonCodes],
    missingFields: [...missingFields],
    nextAction: { code: nextAction, ...(detail ? { detail } : {}) },
    taskIds: [...taskIds],
    lanes,
  };
  if (planDigest) receipt.planDigest = planDigest;
  if (readiness) {
    receipt.readiness = {
      source: readiness.source,
      observedAt: readiness.observedAt,
      ...(readiness.stale ? { stale: true } : {}),
      candidatesConsidered: readiness.observations.length,
      unknownFields: readiness.unknownFields ?? [],
      ...(Array.isArray(readiness.excluded) ? { excluded: readiness.excluded } : {}),
      ...(isPlainObject(readiness.selected) ? { selected: readiness.selected } : {}),
    };
  }
  if (manifest) receipt.manifest = manifest;
  if (plannedLanes) receipt.plannedLanes = plannedLanes;
  if (validationErrors) receipt.validationErrors = validationErrors;
  if (timeline) {
    receipt.timeline = timeline.events;
    receipt.timings = timeline.durations();
  }
  if (journalFile) receipt.journalFile = journalFile;
  return redactSecrets(receipt);
}

function readinessSummary(readiness) {
  return {
    source: readiness.source,
    observedAt: readiness.observedAt,
    stale: readiness.stale === true,
    observations: readiness.observations,
    errors: readiness.errors,
    unknownFields: readiness.unknownFields ?? [],
  };
}

/**
 * Attach trusted offline readiness records (request.workerPolicy.
 * readinessRecords — e.g. locally collected #1034/#1597 evidence) to live
 * observations by worker id. Live GET /workers proves online/freshness;
 * the trusted records carry the capability fields the live API does not.
 * Records already attached to an observation are never overwritten.
 */
function mergeTrustedRecords(readiness, records) {
  if (!Array.isArray(records) || records.length === 0) return readiness;
  const byId = new Map();
  for (const record of records) {
    const id = hasText(record?.node) ? record.node : (hasText(record?.workerId) ? record.workerId : null);
    if (id) byId.set(id, record);
  }
  return {
    ...readiness,
    observations: readiness.observations.map((o) => (o.record ? o : { ...o, record: byId.get(o.workerId) })),
  };
}

function computeUnknownFields(kind) {
  // Fields the current GET /workers API does not carry are named honestly.
  return kind === 'patch'
    ? ['githubPatch', 'canPatchWorkspace', 'canOpenPullRequest', 'runnerTrustedOperator', 'githubTokenFileReadable', 'bridgeMode', 'implementationCapability']
    : [];
}

async function resolveReadiness({ request, mode, context, secret, fetchImpl, providedReadiness, now, ttlMs }) {
  if (providedReadiness) {
    return collectReadiness({ mode: 'offline', snapshot: providedReadiness, now, ttlMs });
  }
  if (mode === 'offline') {
    return collectReadiness({ mode: 'offline', snapshot: null, now, ttlMs });
  }
  const authHeaders = hasText(secret)
    ? {
        'content-type': 'application/json',
        'x-a2a-edge-secret': secret,
        'x-a2a-requester-id': context.requester.id,
        'x-a2a-requester-role': context.requester.role,
      }
    : {};
  return collectReadiness({ mode: 'live', fetchImpl, brokerUrl: context.brokerUrl, authHeaders, now, ttlMs });
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Prepare an assignment without creating anything. Offline mode performs zero
 * network; live mode performs GET-only reads. Returns a `prepared` receipt
 * carrying the validated manifest, or `needs_input` / `blocked` receipts that
 * explain exactly what is missing.
 */
export async function prepareAssignment({
  request: rawRequest,
  mode = 'live',
  context,
  readiness: providedReadiness,
  journal,
  fetchImpl,
  secret,
  now = Date.now,
  ttlMs = DEFAULT_READINESS_TTL_MS,
} = {}) {
  const timeline = createTimeline({ correlation: rawRequest?.correlation, now });
  timeline.mark('toolEntered');

  const normalized = normalizeAssignRequest(rawRequest);
  if (!normalized.ok) {
    return makeReceipt({
      requestId: hasText(rawRequest?.requestId) ? rawRequest.requestId : null,
      state: STATE_NEEDS_INPUT,
      reasonCodes: [...normalized.reasonCodes, ...(normalized.invalidFields.length > 0 ? ['invalid_request_fields'] : [])],
      missingFields: normalized.missingFields,
      nextAction: 'provide_missing_fields',
      detail: normalized.invalidFields.length > 0 ? `invalid fields: ${normalized.invalidFields.join(', ')}` : undefined,
      timeline,
    });
  }
  const request = normalized.request;
  timeline.mark('intentReady', { requestId: request.requestId });

  if (!isPlainObject(context) || !hasText(context.brokerUrl) || !isPlainObject(context.requester)
    || !hasText(context.requester.id) || !hasText(context.requester.role)) {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_NEEDS_INPUT,
      reasonCodes: ['context_missing'],
      nextAction: 'provide_missing_fields',
      detail: 'trusted host context (brokerUrl, requester) is required',
      timeline,
    });
  }
  if (!A2A_REQUESTER_ROLES.includes(context.requester.role)) {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_NEEDS_INPUT,
      reasonCodes: ['requester_role_invalid'],
      nextAction: 'provide_missing_fields',
      timeline,
    });
  }

  const readiness = await resolveReadiness({ request, mode, context, secret, fetchImpl, providedReadiness, now, ttlMs });
  timeline.mark('readinessReady', { source: readiness.source });
  if (readiness.errors.length > 0) {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_BLOCKED,
      reasonCodes: [readiness.errors[0].code],
      nextAction: mode === 'offline' ? 'retry_prepare' : 'resolve_worker_readiness',
      detail: sanitizeDetail(readiness.errors[0].detail),
      planDigest: specDigestOf(request),
      readiness: readinessSummary(readiness),
      timeline,
    });
  }
  if (readiness.stale) {
    // Expired evidence never drives a submission decision (#2187 §2.5).
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_BLOCKED,
      reasonCodes: ['readiness_expired'],
      nextAction: 'retry_prepare',
      detail: `offline readiness snapshot older than ttlMs=${ttlMs}`, 
      planDigest: specDigestOf(request),
      readiness: readinessSummary(readiness),
      timeline,
    });
  }

  const selection = selectWorker({ request, readiness });
  if (!selection.selected) {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_BLOCKED,
      reasonCodes: ['no_eligible_worker'],
      nextAction: 'resolve_worker_readiness',
      planDigest: specDigestOf(request),
      readiness: { ...readinessSummary(readiness), excluded: selection.excluded },
      timeline,
    });
  }
  timeline.mark('readinessReady', { selectedWorkerId: selection.selected.workerId, rationale: selection.rationale });

  const manifest = buildManifest({ request, context, selected: selection.selected });
  const validation = validateManifest(manifest);
  if (validation.errors.length > 0) {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_NEEDS_INPUT,
      reasonCodes: ['manifest_validation_failed'],
      nextAction: 'provide_missing_fields',
      planDigest: specDigestOf(request),
      validationErrors: validation.errors.map((e) => sanitizeDetail(e)),
      readiness: readinessSummary(readiness),
      timeline,
    });
  }
  timeline.mark('manifestValidated');

  let journalFile;
  if (journal) {
    try {
      journal.recordInitial(request.requestId, {
        specDigest: specDigestOf(request),
        kind: request.kind,
        laneIds: validation.lanes.map((lane) => lane.id),
        brokerUrl: context.brokerUrl,
        requesterId: context.requester.id,
        selectedWorkerId: selection.selected.workerId,
      });
      journalFile = `${request.requestId}.json`;
    } catch (error) {
      if (error instanceof JournalConflictError) {
        return makeReceipt({
          requestId: request.requestId,
          state: STATE_FAILED,
          reasonCodes: ['request_spec_conflict'],
          nextAction: 'new_request_id_required',
          detail: sanitizeDetail(error.message),
          timeline,
        });
      }
      throw error;
    }
  }

  const reasonCodes = [...normalized.reasonCodes];
  if (request.kind === 'patch' && !request.target?.hostSmoke) reasonCodes.push('host_smoke_missing');
  return makeReceipt({
    requestId: request.requestId,
    state: STATE_PREPARED,
    reasonCodes,
    nextAction: 'none',
    planDigest: specDigestOf(request),
    plannedLanes: validation.lanes,
    manifest,
    readiness: { ...readinessSummary(readiness), selected: { workerId: selection.selected.workerId, rationale: selection.rationale }, excluded: selection.excluded },
    timeline,
    journalFile,
  });
}

// ─── Submit ─────────────────────────────────────────────────────────────────

async function readbackLane({ fetchImpl, manifest, secret, laneId }) {
  if (typeof fetchImpl !== 'function' || !hasText(secret)) return { task: null, reachable: false };
  const task = await fetchTask(fetchImpl, manifest, secret, laneId);
  return { task: task ?? null, reachable: task != null };
}

/**
 * Submit a fully-specified, authorized assignment in ONE call:
 * journal → prepare → re-check → dispatch via the existing engine → readback
 * → durable receipt. The journal record (ids + digest) precedes the first
 * POST; ambiguous outcomes stay `admission_unconfirmed`; existing tasks are
 * verified field-by-field; network/429 failures get a bounded retry ONLY
 * after a readback shows the task was not created; auth/schema failures never
 * retry.
 */
export async function submitAssignment({
  request: rawRequest,
  context,
  journal,
  fetchImpl,
  secret,
  execution = 'submit',
  readiness: providedReadiness,
  now = Date.now,
  ttlMs = DEFAULT_READINESS_TTL_MS,
  maxRetries = DEFAULT_MAX_SUBMIT_RETRIES,
  retryCapMs = DEFAULT_RETRY_CAP_MS,
} = {}) {
  const timeline = createTimeline({ correlation: rawRequest?.correlation, now });
  timeline.mark('toolEntered');

  const normalized = normalizeAssignRequest(rawRequest);
  if (!normalized.ok) {
    return makeReceipt({
      requestId: hasText(rawRequest?.requestId) ? rawRequest.requestId : null,
      state: STATE_NEEDS_INPUT,
      reasonCodes: [...normalized.reasonCodes, ...(normalized.invalidFields.length > 0 ? ['invalid_request_fields'] : [])],
      missingFields: normalized.missingFields,
      nextAction: 'provide_missing_fields',
      detail: normalized.invalidFields.length > 0 ? `invalid fields: ${normalized.invalidFields.join(', ')}` : undefined,
      timeline,
    });
  }
  const request = normalized.request;
  timeline.mark('intentReady', { requestId: request.requestId });

  if (!isPlainObject(context) || !hasText(context.brokerUrl) || !isPlainObject(context.requester)
    || !hasText(context.requester.id) || !hasText(context.requester.role)
    || !A2A_REQUESTER_ROLES.includes(context.requester.role)) {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_NEEDS_INPUT,
      reasonCodes: ['context_missing'],
      nextAction: 'provide_missing_fields',
      detail: 'trusted host context (brokerUrl, requester with valid role) is required',
      timeline,
    });
  }
  if (!journal) {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_NEEDS_INPUT,
      reasonCodes: ['journal_required'],
      nextAction: 'provide_missing_fields',
      detail: 'submit requires a durable journal; refusing fire-and-forget dispatch',
      timeline,
    });
  }
  if (execution !== 'submit') {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_BLOCKED,
      reasonCodes: ['prepare_only_no_submit'],
      nextAction: 'retry_prepare',
      planDigest: specDigestOf(request),
      timeline,
    });
  }
  if (!hasText(secret)) {
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_BLOCKED,
      reasonCodes: ['submit_not_authorized'],
      nextAction: 'none',
      detail: 'no broker credential in the trusted host context; no task was created',
      planDigest: specDigestOf(request),
      timeline,
    });
  }
  if (providedReadiness) {
    // Submit decisions must be based on fresh live evidence, not a caller snapshot.
    return makeReceipt({
      requestId: request.requestId,
      state: STATE_BLOCKED,
      reasonCodes: ['submit_requires_live_readiness'],
      nextAction: 'retry_prepare',
      planDigest: specDigestOf(request),
      timeline,
    });
  }

  const planDigest = specDigestOf(request);
  const laneIds = plannedLaneIds(request);

  try {
    return await journal.withLock(request.requestId, async () => {
      // Journal BEFORE any POST. First-write-wins; digest conflict fails closed.
      let record;
      try {
        const initial = journal.recordInitial(request.requestId, {
          specDigest: planDigest,
          kind: request.kind,
          laneIds,
          brokerUrl: context.brokerUrl,
          requesterId: context.requester.id,
        });
        record = initial.record;
      } catch (error) {
        if (error instanceof JournalConflictError) {
          return makeReceipt({
            requestId: request.requestId,
            state: STATE_FAILED,
            reasonCodes: ['request_spec_conflict'],
            nextAction: 'new_request_id_required',
            detail: sanitizeDetail(error.message),
            planDigest,
            timeline,
          });
        }
        throw error;
      }

      const readiness = mergeTrustedRecords(
        await resolveReadiness({ request, mode: 'live', context, secret, fetchImpl, now, ttlMs }),
        request.workerPolicy?.readinessRecords,
      );
      timeline.mark('readinessReady', { source: readiness.source });
      if (readiness.errors.length > 0) {
        const receipt = makeReceipt({
          requestId: request.requestId,
          state: STATE_BLOCKED,
          reasonCodes: [readiness.errors[0].code],
          nextAction: 'resolve_worker_readiness',
          detail: sanitizeDetail(readiness.errors[0].detail),
          planDigest,
          readiness: readinessSummary(readiness),
          timeline,
          journalFile: `${request.requestId}.json`,
        });
        journal.update(request.requestId, { receipts: [receipt, ...(record.receipts ?? [])] });
        return receipt;
      }

      const selection = selectWorker({ request, readiness });
      if (!selection.selected) {
        const receipt = makeReceipt({
          requestId: request.requestId,
          state: STATE_BLOCKED,
          reasonCodes: ['no_eligible_worker'],
          nextAction: 'resolve_worker_readiness',
          planDigest,
          readiness: { ...readinessSummary(readiness), excluded: selection.excluded },
          timeline,
          journalFile: `${request.requestId}.json`,
        });
        journal.update(request.requestId, { receipts: [receipt, ...(record.receipts ?? [])] });
        return receipt;
      }
      journal.update(request.requestId, { selectedWorkerId: selection.selected.workerId });

      const manifest = buildManifest({ request, context, selected: selection.selected });
      const validation = validateManifest(manifest);
      if (validation.errors.length > 0) {
        const receipt = makeReceipt({
          requestId: request.requestId,
          state: STATE_NEEDS_INPUT,
          reasonCodes: ['manifest_validation_failed'],
          nextAction: 'provide_missing_fields',
          planDigest,
          validationErrors: validation.errors.map((e) => sanitizeDetail(e)),
          readiness: readinessSummary(readiness),
          timeline,
          journalFile: `${request.requestId}.json`,
        });
        journal.update(request.requestId, { receipts: [receipt, ...(record.receipts ?? [])] });
        return receipt;
      }
      timeline.mark('manifestValidated');

      // ── Dispatch through the existing engine, with bounded recovery. ──
      timeline.mark('firstSubmit');
      if (!record.firstSubmitAt) journal.update(request.requestId, { firstSubmitAt: new Date(now()).toISOString() });

      const laneStates = [];
      const taskIds = [];
      let attempt = 0;
      let retryAfterMs = null;
      const lanes = validation.lanes;

      const dispatchOnce = async () => runDispatch(manifest, { fetchImpl, secret, dryRun: false, verify: false });
      let outcome = await dispatchOnce();

      const retryable = (result) => result?.classification === CLASS_FAILED
        && (result.errorCode === 'network_error' || result.errorCode === 'http_429' || result.errorCode === 'rate_limited');

      // Recovery loop: only for retryable failures, and only after a readback
      // proves the lane task was NOT created (never blind-retry an ambiguous
      // POST; never retry auth/schema failures).
      let anyRetried = false;
      while (attempt < maxRetries && outcome.results.some((r) => retryable(r))) {
        const failedLane = outcome.results.find((r) => retryable(r));
        const lane = lanes[failedLane.order - 1];
        const { task, reachable } = await readbackLane({ fetchImpl, manifest, secret, laneId: lane.id });
        if (reachable) {
          // The task exists despite the failure classification — treat as
          // ambiguous-but-present; do NOT re-POST.
          failedLane.retryReclassified = 'task_present_after_failed_post';
          break;
        }
        attempt += 1;
        anyRetried = true;
        const waitMs = Math.min(Number.isFinite(failedLane.retryAfterMs) ? failedLane.retryAfterMs : 0, retryCapMs);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        outcome = await dispatchOnce();
        if (attempt >= maxRetries) {
          retryAfterMs = failedLane.retryAfterMs ?? null;
          void retryAfterMs;
        }
      }

      // ── Map classifications → receipt states, with readback recovery. ──
      for (const result of outcome.results) {
        const lane = lanes[result.order - 1];
        if (result.classification === CLASS_CREATED) {
          laneStates.push({ laneId: lane.id, state: STATE_ADMITTED, classification: CLASS_CREATED, taskId: result.taskId ?? lane.id });
          taskIds.push(result.taskId ?? lane.id);
          timeline.mark('admissionConfirmed', { laneId: lane.id, taskId: result.taskId ?? lane.id, via: 'create_response' });
          continue;
        }
        if (result.classification === CLASS_ALREADY_EXISTS) {
          const { task } = await readbackLane({ fetchImpl, manifest, secret, laneId: result.taskId ?? lane.id });
          const match = existingTaskMatch(task ?? null, { requesterId: context.requester.id, lane });
          laneStates.push({
            laneId: lane.id,
            state: STATE_EXISTING,
            classification: CLASS_ALREADY_EXISTS,
            taskId: result.taskId ?? lane.id,
            matchVerified: match.verified,
            compared: match.compared,
            ...(match.verified ? {} : { reasonCodes: ['existing_task_match_unverified'] }),
          });
          taskIds.push(result.taskId ?? lane.id);
          continue;
        }
        if (result.classification === CLASS_ACCEPTED_UNCONFIRMED) {
          const { task, reachable } = await readbackLane({ fetchImpl, manifest, secret, laneId: result.taskId ?? lane.id });
          if (reachable) {
            const match = existingTaskMatch(task, { requesterId: context.requester.id, lane });
            if (match.verified) {
              laneStates.push({ laneId: lane.id, state: STATE_ADMITTED, classification: CLASS_ACCEPTED_UNCONFIRMED, taskId: task.id ?? lane.id, reasonCodes: ['durable_ack_unconfirmed_confirmed_via_readback'] });
              taskIds.push(task.id ?? lane.id);
              timeline.mark('admissionConfirmed', { laneId: lane.id, taskId: task.id ?? lane.id, via: 'readback' });
            } else {
              laneStates.push({ laneId: lane.id, state: STATE_ADMISSION_UNCONFIRMED, classification: CLASS_ACCEPTED_UNCONFIRMED, taskId: result.taskId ?? lane.id, reasonCodes: ['existing_task_match_unverified'] });
              taskIds.push(result.taskId ?? lane.id);
            }
          } else {
            laneStates.push({ laneId: lane.id, state: STATE_ADMISSION_UNCONFIRMED, classification: CLASS_ACCEPTED_UNCONFIRMED, taskId: result.taskId ?? lane.id, reasonCodes: ['readback_unavailable'] });
            taskIds.push(result.taskId ?? lane.id);
          }
          continue;
        }
        if (result.classification === CLASS_PREFLIGHT_EXCLUDED) {
          laneStates.push({ laneId: lane.id, state: STATE_BLOCKED, classification: CLASS_PREFLIGHT_EXCLUDED, reasonCodes: [result.errorCode ?? 'worker_readiness_failed'], detail: sanitizeDetail(result.detail) });
          continue;
        }
        // CLASS_FAILED — classify retry posture honestly.
        const noRetry = result.errorCode !== 'network_error' && result.errorCode !== 'http_429' && result.errorCode !== 'rate_limited';
        const readback = retryable(result) ? await readbackLane({ fetchImpl, manifest, secret, laneId: lane.id }) : { task: null, reachable: false };
        if (readback.reachable) {
          const match = existingTaskMatch(readback.task, { requesterId: context.requester.id, lane });
          laneStates.push({
            laneId: lane.id,
            state: match.verified ? STATE_ADMITTED : STATE_ADMISSION_UNCONFIRMED,
            classification: CLASS_FAILED,
            taskId: readback.task.id ?? lane.id,
            reasonCodes: match.verified ? ['post_error_confirmed_via_readback'] : ['existing_task_match_unverified'],
          });
          taskIds.push(readback.task.id ?? lane.id);
          if (match.verified) timeline.mark('admissionConfirmed', { laneId: lane.id, taskId: readback.task.id ?? lane.id, via: 'readback_after_error' });
          continue;
        }
        laneStates.push({
          laneId: lane.id,
          state: STATE_FAILED,
          classification: CLASS_FAILED,
          reasonCodes: noRetry ? ['submit_failed_no_retry'] : ['submit_failed_retry_budget_exhausted'],
          detail: sanitizeDetail(result.detail),
          errorCode: result.errorCode ?? null,
          status: result.status ?? null,
        });
      }

      const admittedCount = laneStates.filter((l) => l.state === STATE_ADMITTED).length;
      const failedCount = laneStates.filter((l) => l.state === STATE_FAILED).length;
      const unconfirmedCount = laneStates.filter((l) => l.state === STATE_ADMISSION_UNCONFIRMED).length;
      const existingCount = laneStates.filter((l) => l.state === STATE_EXISTING).length;
      let state;
      if (failedCount > 0) state = STATE_FAILED;
      else if (admittedCount === lanes.length) state = STATE_ADMITTED;
      else if (unconfirmedCount > 0) state = STATE_ADMISSION_UNCONFIRMED;
      else if (admittedCount + existingCount === lanes.length) state = STATE_EXISTING;
      else state = STATE_BLOCKED;

      // Observed execution start only — never fabricated.
      const startedLane = laneStates.find((l) => l.taskId && l.state !== STATE_FAILED);
      if (startedLane) {
        const { task } = await readbackLane({ fetchImpl, manifest, secret, laneId: startedLane.taskId });
        const status = (task?.status ?? task?.state ?? '').toString().toLowerCase();
        if (WORKER_STARTED_STATUSES.has(status)) {
          timeline.mark('workerStarted', { taskId: startedLane.taskId, observedStatus: status });
        }
      }

      if (taskIds.length > 0) {
        journal.update(request.requestId, { taskIds: Array.from(new Set([...(record.taskIds ?? []), ...taskIds])) });
      }
      const receipt = makeReceipt({
        requestId: request.requestId,
        state,
        reasonCodes: [
          ...normalized.reasonCodes,
          ...(anyRetried ? ['submit_retried_within_budget'] : []),
        ],
        nextAction: state === STATE_ADMITTED ? 'poll_task_readback'
          : state === STATE_EXISTING ? 'resume_existing_task'
          : state === STATE_ADMISSION_UNCONFIRMED ? 'verify_admission'
          : state === STATE_BLOCKED ? 'resolve_worker_readiness'
          : state === STATE_NEEDS_INPUT ? 'provide_missing_fields'
          : 'none',
        planDigest,
        taskIds,
        lanes: laneStates,
        manifest,
        readiness: { ...readinessSummary(readiness), selected: { workerId: selection.selected.workerId, rationale: selection.rationale }, excluded: selection.excluded },
        timeline,
        journalFile: `${request.requestId}.json`,
      });
      journal.update(request.requestId, { admissionState: state, receipts: [receipt, ...(record.receipts ?? [])] });
      return receipt;
    });
  } catch (error) {
    if (error instanceof JournalLockedError) {
      return makeReceipt({
        requestId: request.requestId,
        state: STATE_BLOCKED,
        reasonCodes: ['submit_in_progress'],
        nextAction: 'resume_existing_task',
        planDigest,
        timeline,
      });
    }
    throw error;
  }
}

function plannedLaneIds(request) {
  const roundId = `assign-${request.requestId}`;
  const lanesInput = (request.lanes && request.lanes.length > 0 ? request.lanes : [{}]);
  return lanesInput.map((lane, index) => lane.id ?? deriveLaneId(roundId, {}, index + 1));
}

// ─── Resume ─────────────────────────────────────────────────────────────────

/**
 * Resume a previously journaled request. Reads the durable record, reads the
 * recorded tasks back, and reports current state. NEVER mints new ids and
 * NEVER re-submits terminal work. A record without task ids means the crash
 * happened before the first POST: the original lane ids are returned so a
 * retry reuses them.
 */
export async function resumeAssignment({
  requestId,
  journal,
  context,
  fetchImpl,
  secret,
  now = Date.now,
} = {}) {
  const timeline = createTimeline({ correlation: {}, now });
  timeline.mark('toolEntered');

  if (!journal || !hasText(requestId)) {
    return makeReceipt({
      requestId: hasText(requestId) ? requestId : null,
      state: STATE_NEEDS_INPUT,
      reasonCodes: ['resume_input_missing'],
      nextAction: 'provide_missing_fields',
      timeline,
    });
  }

  const record = journal.read(requestId);
  if (!record) {
    return makeReceipt({
      requestId,
      state: STATE_BLOCKED,
      reasonCodes: ['resume_record_missing'],
      nextAction: 'none',
      detail: 'no durable record for this requestId; nothing was ever submitted under it',
      timeline,
    });
  }
  if (record.corrupt) {
    return makeReceipt({
      requestId,
      state: STATE_ADMISSION_UNCONFIRMED,
      reasonCodes: ['journal_record_corrupt'],
      nextAction: 'verify_admission',
      timeline,
    });
  }

  const taskIds = Array.isArray(record.taskIds) ? record.taskIds : [];
  if (taskIds.length === 0) {
    return makeReceipt({
      requestId,
      state: STATE_PREPARED,
      reasonCodes: ['no_task_ids_recorded'],
      nextAction: 'retry_prepare',
      planDigest: record.specDigest,
      taskIds: [],
      lanes: (record.laneIds ?? []).map((laneId) => ({ laneId })),
      timeline,
      journalFile: `${requestId}.json`,
    });
  }

  const manifest = {
    roundId: `assign-${requestId}`,
    brokerUrl: record.brokerUrl,
    requester: { id: context?.requester?.id ?? record.requesterId, role: context?.requester?.role ?? 'operator' },
    lanes: (record.laneIds ?? taskIds).map((laneId) => ({
      id: laneId,
      target: { id: laneId, kind: 'agent', role: 'analyst' },
      intent: 'analyze',
      message: 'resume readback',
    })),
  };

  const lanes = [];
  let reachableCount = 0;
  for (const taskId of taskIds) {
    const { task, reachable } = await readbackLane({ fetchImpl, manifest, secret, laneId: taskId });
    if (!reachable) {
      lanes.push({ laneId: taskId, taskId, state: STATE_ADMISSION_UNCONFIRMED, reasonCodes: ['readback_unavailable'] });
      continue;
    }
    reachableCount += 1;
    const status = (task.status ?? task.state ?? 'present').toString();
    const started = WORKER_STARTED_STATUSES.has(status.toLowerCase());
    if (started) timeline.mark('workerStarted', { taskId, observedStatus: status });
    lanes.push({
      laneId: taskId,
      taskId: task.id ?? taskId,
      state: STATE_EXISTING,
      brokerStatus: status,
      matchVerified: existingTaskMatch(task, { requesterId: record.requesterId, lane: { target: { id: task.target?.id ?? task.assignedWorkerId }, intent: task.intent, payload: task.payload } }).verified || undefined,
      ...(started ? { reasonCodes: ['worker_started_observed'] } : {}),
    });
  }

  const state = reachableCount === 0 ? STATE_ADMISSION_UNCONFIRMED : STATE_EXISTING;
  const receipt = makeReceipt({
    requestId,
    state,
    reasonCodes: state === STATE_ADMISSION_UNCONFIRMED ? ['readback_unavailable'] : [],
    nextAction: state === STATE_ADMISSION_UNCONFIRMED ? 'verify_admission' : 'poll_task_readback',
    planDigest: record.specDigest,
    taskIds,
    lanes,
    timeline,
    journalFile: `${requestId}.json`,
  });
  journal.update(requestId, { receipts: [receipt, ...(record.receipts ?? [])] });
  return receipt;
}

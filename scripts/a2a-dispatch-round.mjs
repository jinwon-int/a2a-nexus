#!/usr/bin/env node
/**
 * A2A round-dispatch CLI — manifest-driven, fail-closed parent-round dispatch.
 *
 * Replaces fragile shell/Python string-interpolation wrappers. Every prompt and
 * message lives as a plain string inside the JSON manifest; there is zero shell
 * interpolation. The edge secret is read from the A2A_EDGE_SECRET environment
 * variable only — never a CLI flag, never logged, never printed.
 *
 * Lanes are dispatched sequentially (one POST /tasks at a time) to avoid the
 * queue-drain stampede. Each lane is classified deterministically:
 *   - created             : 201/202 returning a task
 *   - accepted-unconfirmed: durable-ack timed out but the task exists
 *                           (202 {durable:false} OR 503 queue_drain_timeout +
 *                           a follow-up GET /tasks/:id that finds the task)
 *   - already-exists      : POST conflict but GET /tasks/:id finds the task
 *   - failed              : anything else (HTTP status + error code recorded)
 *
 * EXIT CONTRACT (fail-closed):
 *   exit 0 ONLY when every lane is created / already-exists / accepted-unconfirmed
 *   AND (created + already-exists + accepted-unconfirmed) === lanes.length.
 *   ANY failed lane => exit 1. No all-clear banner is printed when anything failed.
 *
 * This command creates broker tasks (the dispatch itself). It never deploys,
 * restarts Gateway/brokers/workers, mutates DB/outbox state outside task
 * creation, ACKs/replays Terminal Brief records, releases/tags, or moves
 * secrets. The edge secret is never written to stdout/stderr.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';

// ─── Classifications ────────────────────────────────────────────────────────

const CLASS_CREATED = 'created';
const CLASS_ACCEPTED_UNCONFIRMED = 'accepted-unconfirmed';
const CLASS_ALREADY_EXISTS = 'already-exists';
const CLASS_FAILED = 'failed';

// A lane that counts toward a clean round.
const OK_CLASSES = new Set([CLASS_CREATED, CLASS_ALREADY_EXISTS, CLASS_ACCEPTED_UNCONFIRMED]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Derive a deterministic lane id so re-running the same manifest is idempotent.
 */
function deriveLaneId(roundId, lane, order) {
  if (hasText(lane.id)) return lane.id;
  return `${roundId}:${order}`;
}

// ─── Manifest validation ────────────────────────────────────────────────────

/**
 * Validate manifest shape. Returns { errors:[], lanes:[{order,id,...}] }.
 * Does no network. `lanes` is the normalized lane list (ids/orders stamped).
 */
function validateManifest(manifest) {
  const errors = [];

  if (!isPlainObject(manifest)) {
    return { errors: ['manifest must be a JSON object'], lanes: [] };
  }

  if (!hasText(manifest.roundId)) {
    errors.push('roundId is required and must be a non-empty string');
  }
  if (!hasText(manifest.brokerUrl)) {
    errors.push('brokerUrl is required and must be a non-empty string');
  }
  if (!isPlainObject(manifest.requester) || !hasText(manifest.requester.id) || !hasText(manifest.requester.role)) {
    errors.push('requester.id and requester.role are required non-empty strings');
  }
  if (manifest.defaults != null && !isPlainObject(manifest.defaults)) {
    errors.push('defaults, when present, must be an object');
  }

  const lanesInput = Array.isArray(manifest.lanes) ? manifest.lanes : null;
  if (!lanesInput || lanesInput.length === 0) {
    errors.push('lanes must be a non-empty array');
    return { errors, lanes: [] };
  }

  const roundId = hasText(manifest.roundId) ? manifest.roundId : '(invalid-roundId)';
  const defaults = isPlainObject(manifest.defaults) ? manifest.defaults : {};
  const total = lanesInput.length;

  const seenIds = new Set();
  const lanes = [];

  lanesInput.forEach((lane, index) => {
    const order = index + 1;
    const tag = `lanes[${index}]`;

    if (!isPlainObject(lane)) {
      errors.push(`${tag} must be an object`);
      return;
    }

    if (!isPlainObject(lane.target) || !hasText(lane.target.id) || !hasText(lane.target.role)) {
      errors.push(`${tag}.target.id and ${tag}.target.role are required non-empty strings`);
    }
    if (!hasText(lane.message)) {
      errors.push(`${tag}.message is required and must be a non-empty string`);
    }
    const intent = hasText(lane.intent) ? lane.intent : defaults.intent;
    if (!hasText(intent)) {
      errors.push(`${tag}.intent is required (set lane.intent or defaults.intent)`);
    }
    if (lane.payload != null && !isPlainObject(lane.payload)) {
      errors.push(`${tag}.payload, when present, must be an object`);
    }

    const laneId = deriveLaneId(roundId, lane, order);
    if (seenIds.has(laneId)) {
      errors.push(`${tag} duplicate lane id '${laneId}' (lane ids and derived ids must be unique)`);
    }
    seenIds.add(laneId);

    // Merge defaults.payload then lane.payload (explicit values win), then
    // auto-stamp parent-round metadata for any field the manifest left unset.
    const merged = {
      ...(isPlainObject(defaults.payload) ? defaults.payload : {}),
      ...(isPlainObject(lane.payload) ? lane.payload : {}),
    };
    const payload = { ...merged };
    if (merged.parentRoundId === undefined) payload.parentRoundId = roundId;
    if (merged.parentRoundTotal === undefined) payload.parentRoundTotal = total;
    if (merged.parentRoundOrder === undefined) payload.parentRoundOrder = order;

    lanes.push({
      order,
      id: laneId,
      target: lane.target,
      assignedWorkerId: lane.assignedWorkerId,
      intent,
      message: lane.message,
      payload,
    });
  });

  return { errors, lanes };
}

// ─── Request building ───────────────────────────────────────────────────────

function buildCreateTaskBody(manifest, lane) {
  const body = {
    id: lane.id,
    intent: lane.intent,
    requester: { id: manifest.requester.id, kind: 'agent', role: manifest.requester.role },
    target: { id: lane.target.id, kind: lane.target.kind ?? 'agent', role: lane.target.role },
    message: lane.message,
    payload: lane.payload,
  };
  if (hasText(lane.assignedWorkerId)) body.assignedWorkerId = lane.assignedWorkerId;
  return body;
}

function authHeaders(manifest, secret) {
  return {
    'content-type': 'application/json',
    'x-a2a-edge-secret': secret,
    'x-a2a-requester-id': manifest.requester.id,
    'x-a2a-requester-role': manifest.requester.role,
  };
}

function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, '')}${suffix}`;
}

async function readJsonBody(res) {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Confirm a lane task exists via GET /tasks/:id. Returns the task object or null.
 */
async function fetchTask(fetchImpl, manifest, secret, laneId) {
  const url = joinUrl(manifest.brokerUrl, `/tasks/${encodeURIComponent(laneId)}`);
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: authHeaders(manifest, secret) });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  const body = await readJsonBody(res);
  if (!body) return null;
  // Broker may return the task directly or wrapped as { task }.
  if (isPlainObject(body.task)) return body.task;
  if (hasText(body.id)) return body;
  return null;
}

/**
 * Dispatch a single lane. Returns a classification record.
 */
async function dispatchLane(fetchImpl, manifest, secret, lane) {
  const url = joinUrl(manifest.brokerUrl, '/tasks');
  const base = { order: lane.order, id: lane.id, target: lane.target.id };

  let res;
  let body;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: authHeaders(manifest, secret),
      body: JSON.stringify(buildCreateTaskBody(manifest, lane)),
    });
  } catch (error) {
    return { ...base, classification: CLASS_FAILED, taskId: null, status: null, errorCode: 'network_error', detail: error.message };
  }

  body = await readJsonBody(res);
  const task = body && (isPlainObject(body.task) ? body.task : (hasText(body.id) ? body : null));

  // 201 / 200 — created.
  if (res.status === 201 || res.status === 200) {
    if (task) {
      return { ...base, classification: CLASS_CREATED, taskId: task.id ?? lane.id, status: res.status };
    }
    return { ...base, classification: CLASS_FAILED, taskId: null, status: res.status, errorCode: 'missing_task_in_response' };
  }

  // 202 — new shape: { task, durable:false, ackTimeout:true } OR plain created.
  if (res.status === 202) {
    const durableFalse = body && (body.durable === false || body.ackTimeout === true);
    if (task && durableFalse) {
      return {
        ...base,
        classification: CLASS_ACCEPTED_UNCONFIRMED,
        taskId: task.id ?? lane.id,
        status: res.status,
        verifyHint: `GET ${joinUrl(manifest.brokerUrl, `/tasks/${lane.id}`)} to confirm durability`,
      };
    }
    if (task) {
      return { ...base, classification: CLASS_CREATED, taskId: task.id ?? lane.id, status: res.status };
    }
    // 202 with no task body — fall through to GET confirmation below.
  }

  // 409 conflict — duplicate. Confirm via GET => already-exists.
  if (res.status === 409) {
    const existing = await fetchTask(fetchImpl, manifest, secret, lane.id);
    if (existing) {
      return { ...base, classification: CLASS_ALREADY_EXISTS, taskId: existing.id ?? lane.id, status: res.status };
    }
    return { ...base, classification: CLASS_FAILED, taskId: null, status: res.status, errorCode: errorCodeOf(body) ?? 'conflict' };
  }

  // 503 queue_drain_timeout / queue_saturated — the task may still exist.
  // 202 with no task body also lands here for a GET confirmation.
  if (res.status === 503 || res.status === 202) {
    const code = errorCodeOf(body);
    const existing = await fetchTask(fetchImpl, manifest, secret, lane.id);
    if (existing) {
      return {
        ...base,
        classification: CLASS_ACCEPTED_UNCONFIRMED,
        taskId: existing.id ?? lane.id,
        status: res.status,
        errorCode: code,
        verifyHint: `GET ${joinUrl(manifest.brokerUrl, `/tasks/${lane.id}`)} confirmed task exists; durable ack was not received`,
      };
    }
    return { ...base, classification: CLASS_FAILED, taskId: null, status: res.status, errorCode: code ?? 'queue_drain_unconfirmed' };
  }

  // Anything else — failed.
  return { ...base, classification: CLASS_FAILED, taskId: null, status: res.status, errorCode: errorCodeOf(body) ?? `http_${res.status}` };
}

function errorCodeOf(body) {
  if (isPlainObject(body) && isPlainObject(body.error) && hasText(body.error.code)) return body.error.code;
  return null;
}

// ─── Verify (re-fetch round) ────────────────────────────────────────────────

async function verifyRound(fetchImpl, manifest, secret, lanes) {
  const rows = [];
  const counts = {};
  for (const lane of lanes) {
    const task = await fetchTask(fetchImpl, manifest, secret, lane.id);
    const state = task ? (task.status ?? task.state ?? 'present') : 'not-found';
    counts[state] = (counts[state] ?? 0) + 1;
    rows.push({ order: lane.order, id: lane.id, target: lane.target.id, state, taskId: task ? (task.id ?? lane.id) : null });
  }
  return { rows, counts };
}

// ─── Summary / formatting ───────────────────────────────────────────────────

function summarize(results, lanesLength) {
  const counts = {
    [CLASS_CREATED]: 0,
    [CLASS_ACCEPTED_UNCONFIRMED]: 0,
    [CLASS_ALREADY_EXISTS]: 0,
    [CLASS_FAILED]: 0,
  };
  for (const r of results) counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  const okCount = results.filter((r) => OK_CLASSES.has(r.classification)).length;
  const allOk = counts[CLASS_FAILED] === 0 && okCount === lanesLength;
  return { counts, okCount, allOk };
}

function pad(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function renderTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join('  ');
  const out = [];
  out.push(line(columns.map((c) => c.header)));
  out.push(line(columns.map((_, i) => '-'.repeat(widths[i]))));
  for (const r of rows) out.push(line(columns.map((c) => c.get(r))));
  return out.join('\n');
}

function renderDispatchTable(results) {
  return renderTable(results, [
    { header: 'order', get: (r) => r.order },
    { header: 'lane id', get: (r) => r.id },
    { header: 'target', get: (r) => r.target },
    { header: 'classification', get: (r) => r.classification },
    { header: 'taskId', get: (r) => r.taskId ?? '-' },
  ]);
}

function renderVerifyTable(verify) {
  const table = renderTable(verify.rows, [
    { header: 'order', get: (r) => r.order },
    { header: 'lane id', get: (r) => r.id },
    { header: 'target', get: (r) => r.target },
    { header: 'state', get: (r) => r.state },
    { header: 'taskId', get: (r) => r.taskId ?? '-' },
  ]);
  const countLine = Object.entries(verify.counts).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${table}\n\nround status counts: ${countLine}`;
}

// ─── Core run (testable) ────────────────────────────────────────────────────

/**
 * Run a dispatch round.
 * @param {object} manifest parsed manifest object
 * @param {object} opts
 * @param {function} opts.fetchImpl fetch implementation (url, init) => Response
 * @param {string}   opts.secret edge secret (required for live dispatch)
 * @param {boolean}  opts.dryRun validate + plan only, no network
 * @param {boolean}  opts.verify after dispatch, re-fetch each lane
 * @returns {Promise<{ ok, exitCode, mode, errors, lanes, results, summary, verify }>}
 */
async function runDispatch(manifest, opts = {}) {
  const { fetchImpl, secret, dryRun = false, verify = false } = opts;
  const { errors, lanes } = validateManifest(manifest);

  if (errors.length > 0) {
    return { ok: false, exitCode: 1, mode: dryRun ? 'dry-run' : 'dispatch', errors, lanes: [], results: [], summary: null, verify: null };
  }

  if (dryRun) {
    return {
      ok: true,
      exitCode: 0,
      mode: 'dry-run',
      errors: [],
      lanes: lanes.map((l) => ({ order: l.order, id: l.id, target: l.target.id, intent: l.intent, payload: l.payload })),
      results: [],
      summary: null,
      verify: null,
    };
  }

  if (!hasText(secret)) {
    return { ok: false, exitCode: 1, mode: 'dispatch', errors: ['A2A_EDGE_SECRET is not set; refusing to dispatch'], lanes: [], results: [], summary: null, verify: null };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, exitCode: 1, mode: 'dispatch', errors: ['no fetch implementation available'], lanes: [], results: [], summary: null, verify: null };
  }

  // Sequential dispatch — avoid the queue-drain stampede.
  const results = [];
  for (const lane of lanes) {
    results.push(await dispatchLane(fetchImpl, manifest, secret, lane));
  }

  const summary = summarize(results, lanes.length);
  let verifyResult = null;
  if (verify) {
    verifyResult = await verifyRound(fetchImpl, manifest, secret, lanes);
  }

  return {
    ok: summary.allOk,
    exitCode: summary.allOk ? 0 : 1,
    mode: 'dispatch',
    errors: [],
    lanes,
    results,
    summary,
    verify: verifyResult,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function printHuman(outcome, { json }) {
  if (json) {
    // Strip nothing secret here — results/verify never contain the secret.
    process.stdout.write(`${JSON.stringify(serializeOutcome(outcome), null, 2)}\n`);
    return;
  }

  if (outcome.errors.length > 0) {
    process.stderr.write('manifest validation failed:\n');
    for (const e of outcome.errors) process.stderr.write(`  - ${e}\n`);
    return;
  }

  if (outcome.mode === 'dry-run') {
    process.stdout.write('dry-run: manifest valid. Would create the following lanes:\n\n');
    const table = renderTable(outcome.lanes, [
      { header: 'order', get: (r) => r.order },
      { header: 'lane id', get: (r) => r.id },
      { header: 'target', get: (r) => r.target },
      { header: 'intent', get: (r) => r.intent },
    ]);
    process.stdout.write(`${table}\n\n`);
    process.stdout.write(`dry-run ok: ${outcome.lanes.length} lane(s) validated, no network performed.\n`);
    return;
  }

  process.stdout.write(`${renderDispatchTable(outcome.results)}\n\n`);
  const c = outcome.summary.counts;
  process.stdout.write(
    `counts: created=${c[CLASS_CREATED]} accepted-unconfirmed=${c[CLASS_ACCEPTED_UNCONFIRMED]} `
    + `already-exists=${c[CLASS_ALREADY_EXISTS]} failed=${c[CLASS_FAILED]} / total=${outcome.results.length}\n`,
  );

  // Surface verify hints for accepted-unconfirmed lanes.
  for (const r of outcome.results) {
    if (r.classification === CLASS_ACCEPTED_UNCONFIRMED && r.verifyHint) {
      process.stdout.write(`  verify lane ${r.id}: ${r.verifyHint}\n`);
    }
    if (r.classification === CLASS_FAILED) {
      process.stderr.write(`  FAILED lane ${r.id}: status=${r.status ?? 'n/a'} code=${r.errorCode ?? 'n/a'}${r.detail ? ` detail=${r.detail}` : ''}\n`);
    }
  }

  if (outcome.verify) {
    process.stdout.write(`\nround verify:\n${renderVerifyTable(outcome.verify)}\n`);
  }

  if (outcome.summary.allOk) {
    // Fail-closed: only an all-clear when nothing failed. The forbidden banner
    // string is intentionally never emitted anywhere in this tool.
    process.stdout.write(`\nround dispatch complete: all ${outcome.results.length} lane(s) accounted for.\n`);
  } else {
    process.stderr.write(`\nround dispatch INCOMPLETE: ${outcome.summary.counts[CLASS_FAILED]} lane(s) failed. Exit 1.\n`);
  }
}

function serializeOutcome(outcome) {
  return {
    ok: outcome.ok,
    exitCode: outcome.exitCode,
    mode: outcome.mode,
    errors: outcome.errors,
    summary: outcome.summary,
    results: outcome.results,
    plannedLanes: outcome.mode === 'dry-run' ? outcome.lanes : undefined,
    verify: outcome.verify,
  };
}

function usage(exitCode) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage: npm run dispatch:round -- --manifest <file> [--dry-run] [--verify] [--json]

Manifest-driven, fail-closed parent-round dispatch. Prompts/messages live in the
manifest as plain strings (zero shell interpolation). The edge secret is read
from A2A_EDGE_SECRET only (never a CLI flag, never logged).

Options:
  --manifest <file>  JSON manifest: { roundId, brokerUrl, requester, defaults?, lanes[] }
  --dry-run          Validate the manifest and print the would-create table; no network.
  --verify           After dispatch, re-fetch each lane and print a round status table.
  --json             Emit machine-readable JSON instead of tables.

Exit: 0 only when every lane is created / already-exists / accepted-unconfirmed
and the total is fully accounted for; any failed lane exits 1.
`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        manifest: { type: 'string', short: 'm', default: '' },
        'dry-run': { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    usage(1);
    process.exit(1);
  }

  const { values } = parsed;
  if (values.help) {
    usage(0);
    process.exit(0);
  }
  if (!hasText(values.manifest)) {
    process.stderr.write('error: --manifest <file> is required\n');
    usage(1);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(values.manifest, 'utf8'));
  } catch (error) {
    process.stderr.write(`error: cannot read/parse manifest: ${error.message}\n`);
    process.exit(1);
  }

  const dryRun = values['dry-run'];
  const secret = process.env.A2A_EDGE_SECRET;

  const outcome = await runDispatch(manifest, {
    fetchImpl: typeof fetch === 'function' ? fetch : undefined,
    secret,
    dryRun,
    verify: values.verify,
  });

  printHuman(outcome, { json: values.json });
  process.exit(outcome.exitCode);
}

const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith('a2a-dispatch-round.mjs') || process.argv[1].endsWith('a2a-dispatch-round'));
if (invokedDirectly) {
  main();
}

export {
  runDispatch,
  validateManifest,
  dispatchLane,
  fetchTask,
  verifyRound,
  deriveLaneId,
  summarize,
  CLASS_CREATED,
  CLASS_ACCEPTED_UNCONFIRMED,
  CLASS_ALREADY_EXISTS,
  CLASS_FAILED,
};

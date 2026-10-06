#!/usr/bin/env node
// Fast-lane bench pilot runner (stage-5 prep, #2208 / parent #1601).
//
// Produces an a2a.fast-lane-bench-measurement.v1 artifact for the offline gate
// fast-lane-bench-remeasure.mjs. Stages: preflight -> corpus generation with a
// fail-closed laneAssignment check right after each POST /tasks -> solo arm ->
// a2a arm (each >= 2 passes) -> read-only audit sqlite measurement -> export +
// self-verification by spawning the existing remeasure gate.
//
// Safety (default is --dry-run: zero HTTP, zero DB, zero file writes):
// - Live mode needs BOTH --execute and --broker-url plus an operator corpus,
//   environment research|staging, worker ids, --audit-db and --out.
// - Never sets, reads or toggles broker env flags (A2A_FAST_LANE_SKIP_REVIEW_ROUND,
//   A2A_FAST_LANE_SINGLE_WORKER_FINALIZE); enabling them is a separate approval.
// - Only HTTP calls: GET /health, POST /tasks, GET /tasks/:id. No cancel, claim,
//   approve, ACK, replay, restart, deploy, provider or Telegram call.
// - The audit sqlite is opened with readOnly: true. --synthetic writes only a
//   fresh, SYNTHETIC-labelled fixture DB inside --out.
// - The edge secret is read from the env var NAMED by --edge-secret-env and is
//   never printed or written; artifacts carry no broker URL.
// Exit codes: 0 ok | 1 remeasure gate FAIL (artifact valid, honest result) |
// 2 usage | 3 refused by safety gate | 4 live run aborted fail-closed |
// 5 measurement/export failure.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RUNNER_SCHEMA = 'a2a.fast-lane-bench-pilot.v1';
const MEASUREMENT_SCHEMA = 'a2a.fast-lane-bench-measurement.v1';
const REMEASURE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fast-lane-bench-remeasure.mjs');
const ENVIRONMENTS = ['research', 'staging'];
const ARMS = ['solo', 'a2a'];
const TWINS = ['fast', 'full'];
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const PRIVILEGED_ROLES = new Set(['hub', 'operator']);
const MIN_PASSES = 2;
export const EXIT = { OK: 0, GATE_FAIL: 1, USAGE: 2, REFUSED: 3, ABORTED: 4, MEASURE: 5 };
// Closed v1 set, mirrors TASK_LANE_REASON_CODES in src/task-lane-classifier.ts
// (post-#2253: 19 full-lane triggers + all_fast_conditions_met).
export const LANE_REASON_CODES = new Set([
  'all_fast_conditions_met', 'requester_lane_facts_present', 'intent_not_analyze', 'mode_missing',
  'mode_not_read_only_analysis', 'write_or_implementation_marker_present', 'worker_assignment_conflict',
  'round_marker_present', 'fanout_marker_present', 'multi_worker_marker_present',
  'delegated_workflow_marker_present', 'policy_decision_missing', 'policy_decision_unknown',
  'policy_requires_approval', 'policy_denied', 'approval_marker_present', 'sensitive_marker_present',
  'live_marker_present', 'external_send_marker_present', 'credential_access_marker_present',
]);
// Full twin = fast twin + exactly ONE behaviour-neutral classifier trigger.
const FULL_TRIGGERS = {
  requester_lane_facts_present: (payload) => ({ ...payload, laneShadow: 'full' }),
  mode_missing: ({ mode, ...rest }) => rest,
};
// Placeholder corpus: dry-run/synthetic only. Prompt approval is item 5 of
// #2208 and not granted, so --execute refuses this corpus.
const PLACEHOLDER_CORPUS = [
  { id: 'placeholder-1', message: 'PLACEHOLDER read-only analysis prompt 1 (operator corpus required for --execute)' },
  { id: 'placeholder-2', message: 'PLACEHOLDER read-only analysis prompt 2 (operator corpus required for --execute)' },
  { id: 'placeholder-3', message: 'PLACEHOLDER read-only analysis prompt 3 (operator corpus required for --execute)' },
];

const HELP = `fast-lane-bench-pilot.mjs - stage-5 fast-lane bench pilot runner (#2208)

Modes (default --dry-run):
  --dry-run          Print plan + corpus. No HTTP, no DB, no file writes.
  --execute          Live pilot. Requires --broker-url and all live flags below.
  --measure-only     Re-measure an existing --ledger against --audit-db (no HTTP).
  --synthetic        Build a SYNTHETIC fixture DB in --out and run the real
                     measurement/export/self-verification path (no HTTP).
Options:
  --broker-url <url>       Broker base URL (http/https). Contacted only with --execute.
  --environment <env>      research|staging (artifact environment; required live).
  --corpus <file>          JSON [{"id","message"}] operator corpus (required live).
  --audit-db <path>        Broker sqlite, opened read-only (live/measure-only).
  --out <dir>              Output dir for ledger/artifact/report (not dry-run).
  --ledger <file>          Pilot ledger for --measure-only.
  --solo-worker <id>       Target worker for the solo arm (required live).
  --a2a-worker <id>        Target worker for the a2a arm (required live).
  --runs <n>               Passes per arm (default 2, minimum 2).
  --full-trigger <code>    ${Object.keys(FULL_TRIGGERS).join('|')} (default requester_lane_facts_present).
  --requester-id <id>      Body requester.id, mirrored to x-a2a-requester-id (default fast-lane-bench-pilot).
  --requester-role <role>  Unprivileged role (default researcher; "none" omits it; hub/operator refused).
  --edge-secret-env <NAME> Env var NAME holding the edge secret (value never printed).
  --run-tag <tag>          Task-id tag [a-z0-9-] (default UTC timestamp).
  --poll-interval-sec <n>  Default 15.   --task-timeout-sec <n>  Default 1800.
  --json                   Machine-readable output.   --help  This text.
Exit: 0 ok, 1 gate FAIL (valid artifact), 2 usage, 3 refused, 4 aborted, 5 measure/export failure.`;

class RunnerError extends Error {
  constructor(code, message) { super(message); this.exitCode = code; }
}
const usage = (msg) => new RunnerError(EXIT.USAGE, msg);
const refuse = (msg) => new RunnerError(EXIT.REFUSED, `refused: ${msg}`);
const abort = (msg) => new RunnerError(EXIT.ABORTED, `aborted (fail-closed): ${msg}`);
const measureFail = (msg) => new RunnerError(EXIT.MEASURE, `measurement/export failed: ${msg}`);

export function parseArgs(argv) {
  const o = { mode: null, runs: 2, fullTrigger: 'requester_lane_facts_present', requesterId: 'fast-lane-bench-pilot', requesterRole: 'researcher', pollIntervalSec: 15, taskTimeoutSec: 1800, json: false, help: false };
  const values = { '--broker-url': 'brokerUrl', '--environment': 'environment', '--corpus': 'corpus', '--audit-db': 'auditDb', '--out': 'out', '--ledger': 'ledger', '--solo-worker': 'soloWorker', '--a2a-worker': 'a2aWorker', '--full-trigger': 'fullTrigger', '--requester-id': 'requesterId', '--requester-role': 'requesterRole', '--edge-secret-env': 'edgeSecretEnv', '--run-tag': 'runTag' };
  const numbers = { '--runs': 'runs', '--poll-interval-sec': 'pollIntervalSec', '--task-timeout-sec': 'taskTimeoutSec' };
  const modes = { '--dry-run': 'dry-run', '--execute': 'execute', '--measure-only': 'measure-only', '--synthetic': 'synthetic' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') o.help = true;
    else if (flag === '--json') o.json = true;
    else if (modes[flag]) {
      if (o.mode && o.mode !== modes[flag]) throw usage(`conflicting modes ${o.mode} and ${modes[flag]}`);
      o.mode = modes[flag];
    } else if (values[flag] || numbers[flag]) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw usage(`${flag} requires a value`);
      if (numbers[flag]) {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) throw usage(`${flag} must be a positive integer`);
        o[numbers[flag]] = n;
      } else o[values[flag]] = value;
    } else throw usage(`unknown flag: ${flag}`);
  }
  o.mode ??= 'dry-run';
  if (o.runs < MIN_PASSES) throw usage(`--runs must be >= ${MIN_PASSES} (each arm needs >= ${MIN_PASSES} passes)`);
  if (!FULL_TRIGGERS[o.fullTrigger]) throw usage(`--full-trigger must be one of ${Object.keys(FULL_TRIGGERS).join('|')}`);
  if (o.requesterRole === 'none') o.requesterRole = undefined;
  else if (PRIVILEGED_ROLES.has(o.requesterRole)) throw refuse(`privileged requester role ${o.requesterRole}; use an unprivileged role such as researcher or "none"`);
  if (o.environment !== undefined && !ENVIRONMENTS.includes(o.environment)) throw refuse(`--environment must be ${ENVIRONMENTS.join('|')}`);
  o.runTag ??= new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  if (!/^[a-z0-9-]{1,32}$/i.test(o.runTag)) throw usage('--run-tag must match [a-z0-9-]{1,32}');
  return o;
}

export function loadCorpus(file) {
  if (!file) return { prompts: PLACEHOLDER_CORPUS, placeholder: true };
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf-8')); } catch (error) { throw usage(`cannot read --corpus: ${error.message}`); }
  if (!Array.isArray(raw) || raw.length === 0) throw usage('--corpus must be a non-empty JSON array');
  const seen = new Set();
  for (const p of raw) {
    if (typeof p?.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.id) || seen.has(p.id)) throw usage('--corpus ids must be unique [a-z0-9-]{1,40}');
    if (typeof p.message !== 'string' || p.message.length === 0 || p.message.length > 4000) throw usage(`--corpus ${p.id}: message must be 1..4000 chars`);
    if (p.id.startsWith('placeholder')) throw usage('--corpus must not reuse placeholder ids');
    seen.add(p.id);
  }
  return { prompts: raw.map(({ id, message }) => ({ id, message })), placeholder: false };
}

/** One task request. No teamId, no parent/round/fanout keys, assignedWorkerId == target.id. */
export function buildTaskRequest({ taskId, twin, arm, pass, prompt, worker, runTag, fullTrigger, requesterId, requesterRole }) {
  const base = { mode: 'read-only-analysis', sourceOnly: true, noLive: true, benchPilot: { schema: RUNNER_SCHEMA, runTag, arm, pass, promptId: prompt.id, twin } };
  return {
    id: taskId,
    intent: 'analyze',
    requester: { id: requesterId, kind: 'service', ...(requesterRole ? { role: requesterRole } : {}) },
    target: { id: worker, kind: 'node' },
    message: prompt.message,
    payload: twin === 'fast' ? base : FULL_TRIGGERS[fullTrigger](base),
  };
}

export function buildCorpus(prompts, o) {
  const items = [];
  for (const arm of ARMS) {
    const worker = (arm === 'solo' ? o.soloWorker : o.a2aWorker) ?? `<${arm}-bench-worker>`;
    for (let pass = 1; pass <= o.runs; pass += 1) {
      for (const prompt of prompts) {
        for (const twin of TWINS) {
          const taskId = `flb-${o.runTag}-${arm}-p${pass}-${prompt.id}-${twin}`;
          const expected = twin === 'fast' ? { decision: 'fast', reasonCodes: ['all_fast_conditions_met'] } : { decision: 'full', reasonCodes: [o.fullTrigger] };
          items.push({ taskId, arm, pass, promptId: prompt.id, twin, expected, request: buildTaskRequest({ taskId, twin, arm, pass, prompt, worker, runTag: o.runTag, fullTrigger: o.fullTrigger, requesterId: o.requesterId, requesterRole: o.requesterRole }) });
        }
      }
    }
  }
  return items;
}

/** Fail-closed check of the broker-recorded laneAssignment against the twin's expectation. */
export function checkLaneAssignment(task, expected) {
  const la = task?.laneAssignment;
  if (typeof la !== 'object' || la === null) return 'laneAssignment missing on created task';
  if (la.version !== 'fast-lane.v1' || la.mode !== 'shadow') return `laneAssignment is not fast-lane.v1/shadow (${la.version}/${la.mode})`;
  if (!Array.isArray(la.reasonCodes) || la.reasonCodes.some((c) => !LANE_REASON_CODES.has(c))) return 'laneAssignment.reasonCodes outside the closed v1 set';
  if (la.decision !== expected.decision) return `decision ${la.decision} != expected ${expected.decision} (reasonCodes ${la.reasonCodes.join(',')})`;
  if (la.reasonCodes.join(',') !== expected.reasonCodes.join(',')) return `reasonCodes ${la.reasonCodes.join(',')} != expected ${expected.reasonCodes.join(',')}`;
  return null;
}

function stagePlan(o, corpus, items) {
  return {
    kind: 'broker.fast-lane.bench-pilot', schema: RUNNER_SCHEMA, mode: o.mode, issue: '#2208', parent: '#1601',
    stages: [
      '1 preflight: arg/safety gates, corpus + audit DB checks; live adds one GET /health (dry-run: 0 HTTP)',
      '2 corpus generation: per prompt a fast twin (closed fast conditions only) and a full twin (exactly one minimal trigger); POST /tasks then fail-closed laneAssignment check, abort on first mismatch',
      `3 solo arm: ${o.runs} passes -> target ${o.soloWorker ?? '<solo-bench-worker>'}; poll GET /tasks/:id to terminal`,
      `4 a2a arm: ${o.runs} passes -> target ${o.a2aWorker ?? '<a2a-bench-worker>'}; poll GET /tasks/:id to terminal`,
      '5 measurement: audit sqlite opened readOnly; broker_tasks + broker_audit_events (task.lane_assigned / task.claimed) joined by task id',
      `6 export ${MEASUREMENT_SCHEMA} + self-verification via fast-lane-bench-remeasure.mjs --measurement <file> --json`,
    ],
    safety: {
      httpRequestsInThisMode: o.mode === 'execute' ? 'GET /health, POST /tasks, GET /tasks/:id only' : 0,
      brokerEnvFlagsTouched: false,
      flagPreconditionNote: 'A2A_FAST_LANE_SKIP_REVIEW_ROUND / A2A_FAST_LANE_SINGLE_WORKER_FINALIZE enablement is a separate operator approval; this runner never sets them',
      auditDbOpen: 'readOnly',
      requester: { id: o.requesterId, role: o.requesterRole ?? '(omitted)', headerMirrorsBody: true },
      edgeSecret: o.edgeSecretEnv ? `from env ${o.edgeSecretEnv} (${process.env[o.edgeSecretEnv] ? 'set' : 'unset'}; value never printed)` : 'none',
      teamIdUsed: false,
    },
    cohortDesign: { fullTrigger: o.fullTrigger, fastTwinExpected: ['all_fast_conditions_met'], reasonCodeSetSize: LANE_REASON_CODES.size },
    corpus: { placeholder: corpus.placeholder, prompts: corpus.prompts.length, passesPerArm: o.runs, tasks: items.length },
    tasks: items.map(({ taskId, arm, pass, promptId, twin, expected }) => ({ taskId, arm, pass, promptId, twin, expected: `${expected.decision}:${expected.reasonCodes.join(',')}` })),
    sampleRequests: { fast: items[0]?.request, full: items[1]?.request },
  };
}

function printPlan(plan, json) {
  if (json) return console.log(JSON.stringify(plan, null, 2));
  const lines = [`fast-lane bench pilot runner (#2208 stage-5 prep) - mode: ${plan.mode}`, '', 'Stages:', ...plan.stages.map((s) => `  ${s}`), '', 'Safety:'];
  for (const [k, v] of Object.entries(plan.safety)) lines.push(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  lines.push('', `Cohort design: full twin trigger ${plan.cohortDesign.fullTrigger}; fast twin expects all_fast_conditions_met; closed set ${plan.cohortDesign.reasonCodeSetSize} codes`);
  lines.push(`Corpus: ${plan.corpus.prompts} prompts${plan.corpus.placeholder ? ' (PLACEHOLDER - --execute refuses it)' : ''} x 2 twins x 2 arms x ${plan.corpus.passesPerArm} passes = ${plan.corpus.tasks} tasks`);
  for (const t of plan.tasks) lines.push(`  ${t.taskId}  expect ${t.expected}`);
  lines.push('', 'Sample fast-twin request:', JSON.stringify(plan.sampleRequests.fast), 'Sample full-twin request:', JSON.stringify(plan.sampleRequests.full));
  lines.push('', plan.mode === 'dry-run' ? 'HTTP requests made: 0; DB opened: no; files written: none' : '');
  console.log(lines.join('\n'));
}

function headersFor(o) {
  const h = { accept: 'application/json', 'content-type': 'application/json', 'x-a2a-requester-id': o.requesterId, 'x-a2a-requester-kind': 'service' };
  if (o.requesterRole) h['x-a2a-requester-role'] = o.requesterRole;
  if (o.edgeSecretEnv) h['x-a2a-edge-secret'] = process.env[o.edgeSecretEnv];
  return h;
}

async function http(o, method, path, body) {
  const url = `${o.brokerUrl.replace(/\/+$/, '')}/${path}`;
  let res;
  try {
    res = await fetch(url, { method, headers: headersFor(o), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  } catch (error) { throw abort(`${method} /${path.split('/')[0]} transport error: ${error.name}`); }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); }

function requireLive(o, corpus) {
  if (!o.brokerUrl) throw refuse('--execute requires --broker-url');
  let url;
  try { url = new URL(o.brokerUrl); } catch { throw refuse('--broker-url is not a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw refuse('--broker-url must be http(s)');
  for (const [flag, key] of [['--environment', 'environment'], ['--audit-db', 'auditDb'], ['--out', 'out'], ['--solo-worker', 'soloWorker'], ['--a2a-worker', 'a2aWorker']]) {
    if (!o[key]) throw refuse(`--execute requires ${flag}`);
  }
  if (corpus.placeholder) throw refuse('--execute requires an operator --corpus (placeholder corpus is dry-run/synthetic only)');
  if (o.edgeSecretEnv && !process.env[o.edgeSecretEnv]) throw refuse(`env ${o.edgeSecretEnv} is unset`);
}

export async function runLive(o, items) {
  (await openAuditDb(o.auditDb)).close(); // preflight: audit DB readable read-only before any submission
  mkdirSync(o.out, { recursive: true });
  const ledgerFile = join(o.out, 'pilot-ledger.json');
  if (existsSync(ledgerFile)) throw refuse(`${ledgerFile} exists; use a fresh --out`);
  const ledger = { schema: RUNNER_SCHEMA, runTag: o.runTag, environment: o.environment, fullTrigger: o.fullTrigger, startedAt: new Date().toISOString(), synthetic: false, items: [] };
  const save = () => writeJson(ledgerFile, ledger);
  try {
    const health = await http(o, 'GET', 'health');
    if (health.status !== 200) throw abort(`preflight GET /health returned ${health.status}`);
    for (const arm of ARMS) {
      for (let pass = 1; pass <= o.runs; pass += 1) {
        const batch = items.filter((i) => i.arm === arm && i.pass === pass);
        for (const item of batch) {
          const res = await http(o, 'POST', 'tasks', item.request);
          if (![200, 201, 202].includes(res.status)) throw abort(`POST /tasks ${item.taskId} returned ${res.status}${res.json?.error?.code ? ` (${res.json.error.code})` : ''}`);
          const laneError = checkLaneAssignment(res.json, item.expected);
          ledger.items.push({ taskId: item.taskId, arm, pass, promptId: item.promptId, twin: item.twin, laneDecision: res.json?.laneAssignment?.decision ?? null, status: res.json?.status ?? null });
          save();
          if (laneError) throw abort(`laneAssignment check failed for ${item.taskId}: ${laneError}`);
        }
        const deadline = Date.now() + o.taskTimeoutSec * 1000;
        let pending = ledger.items.filter((e) => e.arm === arm && e.pass === pass);
        while (pending.some((e) => !TERMINAL.has(e.status))) {
          if (Date.now() > deadline) throw abort(`${arm} pass ${pass}: tasks not terminal within ${o.taskTimeoutSec}s`);
          await sleep(o.pollIntervalSec * 1000);
          for (const e of pending.filter((p) => !TERMINAL.has(p.status))) {
            const res = await http(o, 'GET', `tasks/${encodeURIComponent(e.taskId)}`);
            if (res.status !== 200) throw abort(`GET /tasks/${e.taskId} returned ${res.status}`);
            e.status = res.json?.status ?? e.status;
          }
          save();
          pending = ledger.items.filter((x) => x.arm === arm && x.pass === pass);
        }
      }
    }
    ledger.completedAt = new Date().toISOString();
    save();
    return { ledger, ledgerFile };
  } catch (error) {
    ledger.aborted = { at: new Date().toISOString(), reason: error.message };
    save();
    throw error;
  }
}

async function openAuditDb(path, write = false) {
  const { DatabaseSync } = await import('node:sqlite');
  if (!write && !existsSync(path)) throw measureFail(`audit DB not found: ${path}`);
  try { return new DatabaseSync(path, write ? {} : { readOnly: true }); } catch (error) { throw measureFail(`cannot open audit DB read-only: ${error.message}`); }
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/** Read-only measurement: join ledger task ids with broker_tasks + broker_audit_events. */
export function measureFromDb(db, ledger) {
  const ids = ledger.items.map((i) => i.taskId);
  const tasks = new Map();
  const audit = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const marks = chunk.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT id, payload FROM broker_tasks WHERE id IN (${marks})`).all(...chunk)) tasks.set(row.id, JSON.parse(row.payload));
    for (const row of db.prepare(`SELECT target_id, action, payload FROM broker_audit_events WHERE target_type = 'task' AND action IN ('task.lane_assigned', 'task.claimed') AND target_id IN (${marks})`).all(...chunk)) {
      const entry = audit.get(row.target_id) ?? { claimed: false, laneDecision: null };
      if (row.action === 'task.claimed') entry.claimed = true;
      else { try { entry.laneDecision = JSON.parse(JSON.parse(row.payload).note).decision; } catch { entry.laneDecision = 'unparseable'; } }
      audit.set(row.target_id, entry);
    }
  }
  const errors = [];
  const cohorts = Object.fromEntries(TWINS.map((l) => [l, { terminal: 0, succeeded: 0, failed: 0, canceled: 0, executionFailures: 0, gateFailures: 0, e2e: [] }]));
  const passOk = new Map();
  let nonTerminal = 0;
  for (const item of ledger.items) {
    const rec = tasks.get(item.taskId);
    const key = `${item.arm}:${item.pass}`;
    if (!passOk.has(key)) passOk.set(key, true);
    if (!rec) { errors.push(`${item.taskId}: not found in broker_tasks`); continue; }
    const decision = rec.laneAssignment?.decision;
    if (decision !== item.twin) errors.push(`${item.taskId}: recorded lane ${decision} != twin ${item.twin}`);
    if (audit.get(item.taskId)?.laneDecision !== decision) errors.push(`${item.taskId}: task.lane_assigned audit missing or disagrees`);
    if (rec.status !== 'succeeded') passOk.set(key, false);
    if (!TERMINAL.has(rec.status)) { nonTerminal += 1; continue; }
    const c = cohorts[decision];
    if (!c) continue;
    c.terminal += 1;
    c[rec.status] += 1;
    if (rec.status === 'failed') {
      if (rec.claimedAt || rec.claimedBy || audit.get(item.taskId)?.claimed) c.executionFailures += 1;
      else c.gateFailures += 1;
    }
    const e2e = Date.parse(rec.completedAt ?? rec.updatedAt) - Date.parse(rec.createdAt);
    if (Number.isFinite(e2e) && e2e > 0) c.e2e.push(e2e);
    else errors.push(`${item.taskId}: cannot derive e2e from createdAt/completedAt`);
  }
  for (const lane of TWINS) if (cohorts[lane].e2e.length === 0) errors.push(`cohort ${lane}: no terminal task with a positive e2e (p50 undefined)`);
  if (errors.length) throw measureFail(`${errors.length} problem(s); first: ${errors[0]}`);
  const bench = Object.fromEntries(ARMS.map((arm) => {
    const passes = [...passOk].filter(([k]) => k.startsWith(`${arm}:`));
    return [arm, { runs: passes.length, succeeded: passes.filter(([, v]) => v).length }];
  }));
  const out = {};
  for (const lane of TWINS) {
    const { e2e, ...counts } = cohorts[lane];
    out[lane] = { ...counts, p50E2eMs: median(e2e) };
  }
  return { cohorts: out, bench, nonTerminal };
}

export function buildArtifact(measurement, { environment, ledger, synthetic }) {
  return {
    schemaVersion: MEASUREMENT_SCHEMA,
    measuredAt: new Date().toISOString(),
    environment,
    cohorts: measurement.cohorts,
    bench: measurement.bench,
    provenance: { runner: 'packages/broker/scripts/fast-lane-bench-pilot.mjs', runnerSchema: RUNNER_SCHEMA, runTag: ledger.runTag, synthetic, label: synthetic ? 'SYNTHETIC - fixture data, not a measurement; never use as stage-5/6 evidence' : 'pilot measurement from read-only broker audit sqlite', nonTerminalExcluded: measurement.nonTerminal },
  };
}

/** Export artifact + spawn the existing remeasure gate on it (self-verification). */
export function exportAndVerify(artifact, outDir, prefix = '') {
  const artifactFile = join(outDir, `${prefix}measurement.json`);
  const reportFile = join(outDir, `${prefix}remeasure-report.json`);
  writeJson(artifactFile, artifact);
  const run = spawnSync(process.execPath, [REMEASURE_SCRIPT, '--measurement', resolve(artifactFile), '--json'], { encoding: 'utf-8' });
  let report;
  try { report = JSON.parse(run.stdout); } catch { throw measureFail(`remeasure produced no JSON (exit ${run.status}): ${run.stderr.trim()}`); }
  writeJson(reportFile, report);
  const hygiene = report.checks?.find((c) => c.check === 'measurement hygiene');
  if (!hygiene?.ok) throw measureFail(`exported artifact rejected by remeasure hygiene: ${hygiene?.detail ?? 'no hygiene check'}`);
  return { artifactFile, reportFile, remeasureExit: run.status, report };
}

function synthesizeDb(dbFile, items, environment) {
  return openAuditDb(dbFile, true).then((db) => {
    db.exec('CREATE TABLE broker_tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, intent TEXT NOT NULL, target_node_id TEXT NOT NULL, assigned_worker_id TEXT, task_origin TEXT NOT NULL DEFAULT \'unknown\', updated_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE broker_audit_events (id TEXT PRIMARY KEY, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);');
    const putTask = db.prepare('INSERT INTO broker_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const putAudit = db.prepare('INSERT INTO broker_audit_events VALUES (?, ?, ?, ?, ?, ?)');
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    items.forEach((item, n) => {
      // Deterministic SYNTHETIC outcomes: one claimed fast failure, one unclaimed full failure.
      const status = n === 2 ? 'failed' : n === 5 ? 'failed' : 'succeeded';
      const claimed = n !== 5;
      const createdAt = new Date(t0 + n * 600000).toISOString();
      const e2e = (item.twin === 'fast' ? 40000 : 60000) + (n % 7) * 1000;
      const completedAt = new Date(t0 + n * 600000 + e2e).toISOString();
      const laneAssignment = { version: 'fast-lane.v1', mode: 'shadow', ...item.expected };
      const rec = { ...item.request, targetNodeId: item.request.target.id, assignedWorkerId: item.request.target.id, laneAssignment, status, createdAt, updatedAt: completedAt, completedAt, ...(claimed ? { claimedAt: createdAt, claimedBy: item.request.target.id } : {}), synthetic: true, environment };
      putTask.run(item.taskId, status, 'analyze', rec.targetNodeId, rec.assignedWorkerId, 'unknown', completedAt, JSON.stringify(rec));
      putAudit.run(`syn-la-${n}`, 'task.lane_assigned', 'task', item.taskId, createdAt, JSON.stringify({ action: 'task.lane_assigned', targetId: item.taskId, note: JSON.stringify(laneAssignment) }));
      if (claimed) putAudit.run(`syn-cl-${n}`, 'task.claimed', 'task', item.taskId, createdAt, JSON.stringify({ action: 'task.claimed', targetId: item.taskId }));
    });
    db.close();
  });
}

async function measureAndExport(o, ledger, synthetic) {
  const db = await openAuditDb(o.auditDb);
  let measurement;
  try { measurement = measureFromDb(db, ledger); } finally { db.close(); }
  const artifact = buildArtifact(measurement, { environment: o.environment, ledger, synthetic });
  return exportAndVerify(artifact, o.out, synthetic ? 'SYNTHETIC-' : '');
}

function summarize(o, result, extra = {}) {
  const gates = result.report.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.check}`);
  const summary = { mode: o.mode, ...extra, artifactFile: result.artifactFile, reportFile: result.reportFile, remeasureExit: result.remeasureExit, remeasureOk: result.report.ok, gates };
  console.log(o.json ? JSON.stringify(summary, null, 2) : [`mode: ${o.mode}${o.mode === 'synthetic' ? ' (SYNTHETIC fixture - not evidence)' : ''}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`), `artifact: ${result.artifactFile}`, `remeasure report: ${result.reportFile}`, `remeasure exit ${result.remeasureExit}, ok=${result.report.ok}`, ...gates.map((g) => `  ${g}`)].join('\n'));
  return result.report.ok ? EXIT.OK : EXIT.GATE_FAIL;
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(HELP); return EXIT.OK; }
  if (o.mode !== 'execute' && o.brokerUrl) console.error('note: --broker-url is ignored outside --execute (not contacted)');
  if (o.mode === 'measure-only') {
    for (const [flag, key] of [['--ledger', 'ledger'], ['--audit-db', 'auditDb'], ['--out', 'out'], ['--environment', 'environment']]) if (!o[key]) throw usage(`--measure-only requires ${flag}`);
    let ledger;
    try { ledger = JSON.parse(readFileSync(o.ledger, 'utf-8')); } catch (error) { throw usage(`cannot read --ledger: ${error.message}`); }
    if (ledger?.schema !== RUNNER_SCHEMA || !Array.isArray(ledger.items) || ledger.items.length === 0) throw usage(`--ledger is not a non-empty ${RUNNER_SCHEMA} ledger`);
    if (ledger.aborted) throw refuse('ledger records an aborted run; aborted pilots are not measurable evidence');
    mkdirSync(o.out, { recursive: true });
    return summarize(o, await measureAndExport(o, ledger, ledger.synthetic === true), { ledger: o.ledger });
  }
  const corpus = loadCorpus(o.corpus);
  const items = buildCorpus(corpus.prompts, o);
  if (o.mode === 'dry-run') { printPlan(stagePlan(o, corpus, items), o.json); return EXIT.OK; }
  if (o.mode === 'synthetic') {
    if (!o.out) throw usage('--synthetic requires --out');
    o.environment ??= 'research';
    o.soloWorker ??= 'synthetic-solo-worker';
    o.a2aWorker ??= 'synthetic-a2a-worker';
    const synthItems = buildCorpus(corpus.prompts, o);
    mkdirSync(o.out, { recursive: true });
    o.auditDb = join(o.out, 'SYNTHETIC-audit.sqlite');
    if (existsSync(o.auditDb)) throw refuse(`${o.auditDb} exists; use a fresh --out`);
    await synthesizeDb(o.auditDb, synthItems, o.environment);
    const ledger = { schema: RUNNER_SCHEMA, runTag: o.runTag, environment: o.environment, fullTrigger: o.fullTrigger, synthetic: true, items: synthItems.map(({ taskId, arm, pass, promptId, twin }) => ({ taskId, arm, pass, promptId, twin })) };
    writeJson(join(o.out, 'SYNTHETIC-pilot-ledger.json'), ledger);
    return summarize(o, await measureAndExport(o, ledger, true), { httpRequests: 0, tasks: synthItems.length });
  }
  requireLive(o, corpus);
  const { ledger, ledgerFile } = await runLive(o, items);
  return summarize(o, await measureAndExport(o, ledger, false), { ledger: ledgerFile, tasks: ledger.items.length });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`fast-lane-bench-pilot: ${error.message}`);
    process.exit(error instanceof RunnerError ? error.exitCode : EXIT.ABORTED);
  });
}

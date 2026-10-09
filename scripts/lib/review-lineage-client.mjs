#!/usr/bin/env node
/**
 * Review-lineage operator client (#2274) — the first producer slice for the
 * bounded PR review lifecycle (#1518).
 *
 * Why this exists: the broker has accepted authenticated lineage sources since
 * Phases 14-18, and the T2 broker runs `A2A_REVIEW_LINEAGE_MODE=record`, but no
 * client ever called them, so the record-mode store stayed at count 0 while
 * real review loops ran outside it. Per producer-admission-v1.md the broker
 * must not derive lineage facts from generic task terminal state; the loop
 * owner (the orchestrator) has to report them explicitly. This CLI is that
 * explicit, operator-role reporting path for the two operator-owned sources:
 *
 *   binding  offline: build the IntentContractV1, compute intentHash/diffHash
 *            and print the binding. No network, no secret.
 *   create   POST /review-lineages            (source kind lineage_create)
 *   cancel   POST /review-lineages/{id}/operator-cancel (operator_cancel)
 *
 * It deliberately does not post review reports (reviewer-signed, worker-owned)
 * or correction/replacement events; those are later slices. create + cancel
 * alone only ever yields `canceled` terminals, so it proves the recording path
 * but is not, by itself, scorecard evidence for DEFAULT_LINEAGE_BUDGET.
 *
 * Hashes reuse the Phase-1 reference primitives (test/conformance/lib/
 * canonical-json.mjs), which the broker's TypeScript port is locked to.
 * diffHash hashes the exact bytes of
 *   git diff --no-color --no-ext-diff --no-renames --unified=3 <base> <head>
 * with system/global git config neutralized so a user's diff settings cannot
 * change the patch.
 *
 * Auth: the edge secret is read from A2A_EDGE_SECRET only (never a flag, never
 * printed or written to the record file); the requester role is always
 * `operator`, the only role the broker accepts for these routes.
 *
 * Exit codes: 0 created/replayed (or dry-run/binding ok) · 1 broker rejected,
 * HTTP or network failure · 2 usage or local validation error · 3
 * A2A_EDGE_SECRET missing.
 *
 * Boundary: this command writes only to the broker named in the spec/record
 * and to the --out record file. It never deploys, restarts, changes broker
 * mode, migrates or prunes, and it does not change DEFAULT_LINEAGE_BUDGET.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { intentHash } from '../../test/conformance/lib/canonical-json.mjs';

export const RECORD_SCHEMA = 'a2a.review-lineage-client-record.v1';

// Mirrors DEFAULT_LINEAGE_BUDGET in packages/broker/src/review-lifecycle/
// types.ts; a test pins the two together so they cannot drift.
export const DEFAULT_BUDGET = Object.freeze({
  kind: 'ReviewLineageBudgetV1',
  maxWallClockSeconds: 21600,
  maxCorrectionGenerations: 1,
  maxReviewerRuns: 2,
  maxReviewerReplacements: 1,
  repeatedFindingThreshold: 2,
  onExhaustion: 'blocked_needs_operator',
});

// Local pre-checks mirror packages/broker/src/review-lifecycle/observation.ts
// so obvious mistakes fail before any network call. The broker stays the
// authoritative validator.
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const CRITERION_PATTERN = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const SPEC_FIELDS = new Set([
  'brokerUrl', 'requesterId', 'dispatchRef', 'lineageId', 'goal', 'nonGoals',
  'invariants', 'acceptanceCriteria', 'declaredPaths', 'baseSha', 'headSha',
  'repo', 'diffFile', 'budget', 'createdAt',
]);

export class ClientError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, name, pattern) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClientError(`${name} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ClientError(`${name} has an invalid format`);
  }
  return value;
}

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ClientError(`${name} must be an array of strings`);
  }
  return [...value];
}

function utcNow(now) {
  return (now ? now() : new Date()).toISOString();
}

function brokerUrlOf(value) {
  const text = requireText(value, 'brokerUrl');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ClientError('brokerUrl must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ClientError('brokerUrl must be an absolute http(s) URL');
  }
  return text.replace(/\/+$/, '');
}

/** Exact bytes of the canonical patch, hashed as bytes (`sha256:<hex>`). */
export function diffHashFromBytes(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

export function canonicalPatch(repo, baseSha, headSha, spawn = spawnSync) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C',
  };
  for (const sha of [baseSha, headSha]) {
    const probe = spawn('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { env });
    if (probe.status !== 0) {
      throw new ClientError(`commit ${sha.slice(0, 12)} is not present in ${repo}`);
    }
  }
  const result = spawn('git', [
    '-C', repo, 'diff', '--no-color', '--no-ext-diff', '--no-renames', '--unified=3',
    baseSha, headSha,
  ], { env, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new ClientError(`git diff failed for ${repo}`);
  }
  return Buffer.from(result.stdout);
}

/**
 * Build the create request from an operator spec. Pure apart from reading the
 * diff (repo or diffFile) and the clock.
 */
export function buildCreateRequest(spec, { now, spawn } = {}) {
  if (!isPlainObject(spec)) throw new ClientError('spec must be a JSON object');
  for (const key of Object.keys(spec)) {
    if (!SPEC_FIELDS.has(key)) throw new ClientError(`unknown spec field: ${key}`);
  }
  const lineageId = requireText(spec.lineageId, 'lineageId', IDENTIFIER_PATTERN);
  const dispatchRef = requireText(spec.dispatchRef, 'dispatchRef', IDENTIFIER_PATTERN);
  const baseSha = requireText(spec.baseSha, 'baseSha', SHA_PATTERN);
  const headSha = requireText(spec.headSha, 'headSha', SHA_PATTERN);
  if (!Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.length === 0
      || spec.acceptanceCriteria.length > 100) {
    throw new ClientError('acceptanceCriteria must hold 1-100 criteria');
  }
  const seen = new Set();
  const acceptanceCriteria = spec.acceptanceCriteria.map((item, index) => {
    if (!isPlainObject(item)) throw new ClientError(`acceptanceCriteria[${index}] must be an object`);
    const id = requireText(item.id, `acceptanceCriteria[${index}].id`, CRITERION_PATTERN);
    if (seen.has(id)) throw new ClientError(`duplicate acceptance criterion id ${id}`);
    seen.add(id);
    return { id, text: requireText(item.text, `acceptanceCriteria[${index}].text`) };
  });
  if (!isPlainObject(spec.declaredPaths)) throw new ClientError('declaredPaths must be an object');
  const declaredPaths = { allowed: requireStringArray(spec.declaredPaths.allowed, 'declaredPaths.allowed') };
  if (declaredPaths.allowed.length === 0) throw new ClientError('declaredPaths.allowed must not be empty');
  if (spec.declaredPaths.forbidden !== undefined) {
    declaredPaths.forbidden = requireStringArray(spec.declaredPaths.forbidden, 'declaredPaths.forbidden');
  }

  let patch;
  if (spec.diffFile !== undefined && spec.repo !== undefined) {
    throw new ClientError('give either repo or diffFile, not both');
  } else if (spec.diffFile !== undefined) {
    patch = fs.readFileSync(requireText(spec.diffFile, 'diffFile'));
  } else if (spec.repo !== undefined) {
    patch = canonicalPatch(requireText(spec.repo, 'repo'), baseSha, headSha, spawn);
  } else {
    throw new ClientError('spec needs repo (a git checkout holding base and head) or diffFile');
  }

  const createdAt = spec.createdAt === undefined ? utcNow(now) : requireText(spec.createdAt, 'createdAt');
  const contract = {
    kind: 'IntentContractV1',
    lineageId,
    goal: requireText(spec.goal, 'goal'),
    nonGoals: requireStringArray(spec.nonGoals ?? [], 'nonGoals'),
    invariants: requireStringArray(spec.invariants ?? [], 'invariants'),
    acceptanceCriteria,
    declaredPaths,
    baseSha,
    headSha,
    createdAt,
    intentHash: '',
  };
  contract.intentHash = intentHash(contract);
  const budget = spec.budget === undefined ? { ...DEFAULT_BUDGET } : spec.budget;
  if (!isPlainObject(budget) || budget.kind !== 'ReviewLineageBudgetV1') {
    throw new ClientError('budget must be a ReviewLineageBudgetV1 object');
  }
  const binding = { intentHash: contract.intentHash, headSha, diffHash: diffHashFromBytes(patch) };
  return {
    brokerUrl: spec.brokerUrl === undefined ? undefined : brokerUrlOf(spec.brokerUrl),
    requesterId: spec.requesterId,
    request: { dispatchRef, observedAt: utcNow(now), binding, contract, budget },
  };
}

export function buildCancelRequest(record, { decisionRef, detail, now } = {}) {
  if (!isPlainObject(record) || record.schema !== RECORD_SCHEMA) {
    throw new ClientError(`record must be a ${RECORD_SCHEMA} file written by create --out`);
  }
  requireText(record.lineageId, 'record.lineageId', IDENTIFIER_PATTERN);
  if (!isPlainObject(record.binding)) throw new ClientError('record.binding is missing');
  return {
    decisionRef: requireText(decisionRef, '--decision-ref', IDENTIFIER_PATTERN),
    observedAt: utcNow(now),
    binding: {
      intentHash: requireText(record.binding.intentHash, 'record.binding.intentHash'),
      headSha: requireText(record.binding.headSha, 'record.binding.headSha', SHA_PATTERN),
      diffHash: requireText(record.binding.diffHash, 'record.binding.diffHash'),
    },
    detail: requireText(detail, '--detail'),
  };
}

/** The edge secret comes from A2A_EDGE_SECRET only; exit 3 when it is unset. */
function edgeCredential(env) {
  const value = env.A2A_EDGE_SECRET;
  if (!value) throw new ClientError('A2A_EDGE_SECRET is not set; refusing to post', 3);
  return value;
}

function operatorHeaders(secret, requesterId) {
  return {
    'content-type': 'application/json',
    'x-a2a-edge-secret': secret,
    'x-a2a-requester-id': requesterId,
    'x-a2a-requester-role': 'operator',
  };
}

/** POST one operator source; returns { ok, httpStatus, status, error }. Never echoes the secret. */
export async function postOperatorSource(fetchImpl, url, secret, requesterId, body) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: operatorHeaders(secret, requesterId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, httpStatus: null, status: null, error: `network: ${error?.name ?? 'error'}` };
  }
  let payload = null;
  try {
    const text = await res.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const result = payload?.result ?? null;
  const status = result?.status ?? null;
  // A replay answers 200 for whatever the first attempt did; only a replay of
  // an applied event is a success.
  const applied = status === 'applied'
    || (status === 'replayed' && result?.originalOutcome === 'applied');
  if ((res.status === 201 || res.status === 200) && applied) {
    return { ok: true, httpStatus: res.status, status, state: result?.state ?? null, error: null };
  }
  const code = payload?.error?.code ?? payload?.code ?? null;
  const message = payload?.error?.message ?? payload?.message ?? null;
  return {
    ok: false,
    httpStatus: res.status,
    status,
    error: [code, message].filter(Boolean).join(': ') || `unexpected response (http ${res.status})`,
  };
}

function readJsonFile(path, label) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new ClientError(`cannot read ${label}: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientError(`${label} is not valid JSON: ${path}`);
  }
}

function writeRecord(path, record) {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, path);
}

const USAGE = `Usage:
  review-lineage-client.mjs binding --spec <spec.json>
  review-lineage-client.mjs create  --spec <spec.json> --out <record.json> [--dry-run]
  review-lineage-client.mjs cancel  --record <record.json> --decision-ref <ref> --detail <text> [--dry-run]
The edge secret is read from A2A_EDGE_SECRET only.`;

/** Testable entry point: returns { exitCode, output } and never prints the secret. */
export async function run(argv, { env = process.env, fetchImpl = globalThis.fetch, now, spawn } = {}) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        spec: { type: 'string' },
        out: { type: 'string' },
        record: { type: 'string' },
        'decision-ref': { type: 'string' },
        detail: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    return { exitCode: 2, output: { ok: false, error: error.message, usage: USAGE } };
  }
  try {
    if (command === 'binding' || command === 'create') {
      if (!values.spec) throw new ClientError('--spec is required');
      const built = buildCreateRequest(readJsonFile(values.spec, 'spec'), { now, spawn });
      const { lineageId } = built.request.contract;
      if (command === 'binding') {
        return { exitCode: 0, output: { ok: true, command, lineageId, binding: built.request.binding } };
      }
      if (!values.out) throw new ClientError('--out is required for create');
      const brokerUrl = brokerUrlOf(built.brokerUrl);
      const requesterId = requireText(built.requesterId, 'requesterId', IDENTIFIER_PATTERN);
      if (values['dry-run']) {
        return { exitCode: 0, output: { ok: true, command, dryRun: true, lineageId, request: built.request } };
      }
      const edge = edgeCredential(env);
      // The request is persisted before it is sent. A retry after a timeout or
      // crash must resend the identical bytes so the broker answers `replayed`;
      // rebuilding it would stamp a new createdAt/observedAt and turn an
      // already-applied create into a conflict with no record to cancel from.
      let request = built.request;
      let resumed = false;
      if (fs.existsSync(values.out)) {
        const existing = readJsonFile(values.out, 'record');
        if (existing?.schema !== RECORD_SCHEMA || existing.lineageId !== lineageId
            || existing.brokerUrl !== brokerUrl || !isPlainObject(existing.request)) {
          throw new ClientError(`--out ${values.out} already holds a different record; refusing to overwrite`);
        }
        if (existing.state === 'created') {
          return { exitCode: 0, output: { ok: true, command, lineageId, status: 'already-created', binding: existing.binding } };
        }
        request = existing.request;
        resumed = true;
      }
      const record = {
        schema: RECORD_SCHEMA,
        state: 'pending',
        brokerUrl,
        requesterId,
        lineageId,
        dispatchRef: request.dispatchRef,
        binding: request.binding,
        request,
      };
      if (!resumed) writeRecord(values.out, record);
      const result = await postOperatorSource(fetchImpl, `${brokerUrl}/review-lineages`, edge, requesterId, request);
      if (result.ok) writeRecord(values.out, { ...record, state: 'created', createStatus: result.status });
      return {
        exitCode: result.ok ? 0 : 1,
        output: { ok: result.ok, command, lineageId, resumed, ...result, binding: request.binding },
      };
    }
    if (command === 'cancel') {
      if (!values.record) throw new ClientError('--record is required');
      const record = readJsonFile(values.record, 'record');
      const request = buildCancelRequest(record, { decisionRef: values['decision-ref'], detail: values.detail, now });
      const brokerUrl = brokerUrlOf(record.brokerUrl);
      const requesterId = requireText(record.requesterId, 'record.requesterId', IDENTIFIER_PATTERN);
      if (values['dry-run']) {
        return { exitCode: 0, output: { ok: true, command, dryRun: true, lineageId: record.lineageId, request } };
      }
      const edge = edgeCredential(env);
      const url = `${brokerUrl}/review-lineages/${encodeURIComponent(record.lineageId)}/operator-cancel`;
      const result = await postOperatorSource(fetchImpl, url, edge, requesterId, request);
      return { exitCode: result.ok ? 0 : 1, output: { ok: result.ok, command, lineageId: record.lineageId, ...result } };
    }
    throw new ClientError(`unknown command: ${command ?? '(none)'}`);
  } catch (error) {
    if (error instanceof ClientError) {
      return { exitCode: error.exitCode, output: { ok: false, command, error: error.message, ...(error.exitCode === 2 ? { usage: USAGE } : {}) } };
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { exitCode, output } = await run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = exitCode;
}

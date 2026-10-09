// Tests for scripts/lib/review-lineage-client.mjs (#2274).
//
// Part 1 is hermetic: a local HTTP stub records what the client sends, and a
// throwaway git repository provides real base/head commits for diffHash.
// Part 2 runs the client against the real broker (packages/broker/dist) in
// record mode with a temporary SQLite store and is skipped when dist has not
// been built.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { diffHash, intentHash } from '../../test/conformance/lib/canonical-json.mjs';
import {
  DEFAULT_BUDGET,
  RECORD_SCHEMA,
  buildCreateRequest,
  diffHashFromBytes,
  run,
} from './review-lineage-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'review-lineage-client-test-secret';
const FIXED_NOW = () => new Date('2026-10-09T10:00:00.000Z');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(repo, ...args) {
  const res = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function makeRepo(dir) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'head');
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

function writeSpec(dir, overrides = {}) {
  const { repo, base, head } = makeRepo(dir);
  const spec = {
    brokerUrl: 'http://127.0.0.1:1',
    requesterId: 'operator-jingun',
    dispatchRef: 'round-2274-test',
    lineageId: 'lineage-2274-test',
    goal: 'Record the first operator-owned review lineage.',
    nonGoals: ['No worker-side review reports.'],
    invariants: ['Task completion semantics stay unchanged.'],
    acceptanceCriteria: [{ id: 'AC-1', text: 'The broker records the lineage.' }],
    declaredPaths: { allowed: ['scripts/**'] },
    baseSha: base,
    headSha: head,
    repo,
    ...overrides,
  };
  const file = path.join(dir, 'spec.json');
  fs.writeFileSync(file, JSON.stringify(spec));
  return { file, spec, repo, base, head };
}

/** Local stub broker: records requests and answers with the scripted reply. */
async function stubBroker(t, reply) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const { status, payload } = reply(calls.at(-1));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

const applied = () => ({ status: 201, payload: { result: { status: 'applied', outcome: 'applied', state: 'reviewing_initial' } } });

// ─── Part 1: hermetic ───────────────────────────────────────────────────────

test('binding: intentHash and diffHash follow the reference primitives over real git commits', (t) => {
  const dir = tmpDir(t);
  const { spec, repo, base, head } = writeSpec(dir);
  const built = buildCreateRequest(spec, { now: FIXED_NOW });
  const { contract, binding } = built.request;
  assert.equal(contract.intentHash, intentHash(contract));
  assert.equal(binding.intentHash, contract.intentHash);
  assert.equal(binding.headSha, head);
  const patch = spawnSync('git', ['-C', repo, 'diff', '--no-color', '--no-ext-diff', '--no-renames',
    '--unified=3', base, head], { encoding: 'utf8' }).stdout;
  assert.ok(patch.length > 0);
  assert.equal(binding.diffHash, diffHash(patch), 'UTF-8 patch bytes hash like the reference text hash');
  assert.deepEqual(Object.keys(built.request).sort(), ['binding', 'budget', 'contract', 'dispatchRef', 'observedAt']);
  assert.deepEqual(built.request.budget, DEFAULT_BUDGET);
  assert.equal(built.request.observedAt, '2026-10-09T10:00:00.000Z');
});

test('binding: a global git diff setting cannot change diffHash', (t) => {
  const dir = tmpDir(t);
  const { spec } = writeSpec(dir);
  const clean = buildCreateRequest(spec, { now: FIXED_NOW }).request.binding.diffHash;
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; });
  assert.equal(buildCreateRequest(spec, { now: FIXED_NOW }).request.binding.diffHash, clean);
});

test('diffHashFromBytes hashes raw bytes', () => {
  assert.equal(diffHashFromBytes(Buffer.from('')), diffHash(''));
});

test('DEFAULT_BUDGET mirrors DEFAULT_LINEAGE_BUDGET in the broker types', () => {
  const source = fs.readFileSync(path.join(ROOT, 'packages/broker/src/review-lifecycle/types.ts'), 'utf8');
  const block = source.match(/DEFAULT_LINEAGE_BUDGET: ReviewLineageBudgetV1 = \{([\s\S]*?)\};/);
  assert.ok(block, 'DEFAULT_LINEAGE_BUDGET literal not found');
  const fields = Object.fromEntries([...block[1].matchAll(/(\w+):\s*("?)([\w_]+)\2/g)]
    .map(([, key, quote, value]) => [key, quote ? value : Number(value)]));
  assert.deepEqual(fields, { ...DEFAULT_BUDGET });
});

test('create posts the exact operator request, writes an owner-only record, never echoes the secret', async (t) => {
  const dir = tmpDir(t);
  const broker = await stubBroker(t, applied);
  const { file } = writeSpec(dir, { brokerUrl: broker.url });
  const out = path.join(dir, 'record.json');
  const { exitCode, output } = await run(['create', '--spec', file, '--out', out],
    { env: { A2A_EDGE_SECRET: SECRET }, now: FIXED_NOW });
  assert.equal(exitCode, 0, JSON.stringify(output));
  assert.equal(broker.calls.length, 1);
  const [call] = broker.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/review-lineages');
  assert.equal(call.headers['x-a2a-edge-secret'], SECRET);
  assert.equal(call.headers['x-a2a-requester-role'], 'operator');
  assert.equal(call.headers['x-a2a-requester-id'], 'operator-jingun');
  assert.equal(call.body.contract.lineageId, 'lineage-2274-test');
  const record = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(record.schema, RECORD_SCHEMA);
  assert.deepEqual(record.binding, call.body.binding);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(out, 'utf8').includes(SECRET));
  assert.ok(!JSON.stringify(output).includes(SECRET));
});

test('create without A2A_EDGE_SECRET exits 3 before any request', async (t) => {
  const dir = tmpDir(t);
  const broker = await stubBroker(t, applied);
  const { file } = writeSpec(dir, { brokerUrl: broker.url });
  const { exitCode } = await run(['create', '--spec', file, '--out', path.join(dir, 'r.json')], { env: {} });
  assert.equal(exitCode, 3);
  assert.equal(broker.calls.length, 0);
});

test('--dry-run builds the request without contacting the broker', async (t) => {
  const dir = tmpDir(t);
  const broker = await stubBroker(t, applied);
  const { file } = writeSpec(dir, { brokerUrl: broker.url });
  const out = path.join(dir, 'r.json');
  const { exitCode, output } = await run(['create', '--spec', file, '--out', out, '--dry-run'],
    { env: { A2A_EDGE_SECRET: SECRET } });
  assert.equal(exitCode, 0);
  assert.equal(output.dryRun, true);
  assert.equal(broker.calls.length, 0);
  assert.ok(!fs.existsSync(out));
});

test('a broker rejection exits 1 and leaves only a pending record', async (t) => {
  const dir = tmpDir(t);
  const broker = await stubBroker(t, () => ({ status: 409,
    payload: { error: { code: 'invalid_transition', message: 'review lineage recording is disabled' } } }));
  const { file } = writeSpec(dir, { brokerUrl: broker.url });
  const out = path.join(dir, 'r.json');
  const { exitCode, output } = await run(['create', '--spec', file, '--out', out], { env: { A2A_EDGE_SECRET: SECRET } });
  assert.equal(exitCode, 1);
  assert.match(output.error, /recording is disabled/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).state, 'pending', 'only a pending record, never created');
});

test('a retry resends the persisted request byte-for-byte instead of rebuilding it', async (t) => {
  const dir = tmpDir(t);
  let fail = true;
  const broker = await stubBroker(t, () => (fail ? { status: 503, payload: { error: { code: 'unavailable' } } } : applied()));
  const { file } = writeSpec(dir, { brokerUrl: broker.url });
  const out = path.join(dir, 'record.json');
  const env = { A2A_EDGE_SECRET: SECRET };
  assert.equal((await run(['create', '--spec', file, '--out', out], { env, now: FIXED_NOW })).exitCode, 1);
  fail = false;
  const later = () => new Date('2026-10-09T12:00:00.000Z');
  const retry = await run(['create', '--spec', file, '--out', out], { env, now: later });
  assert.equal(retry.exitCode, 0, JSON.stringify(retry.output));
  assert.equal(retry.output.resumed, true);
  assert.deepEqual(broker.calls[1].body, broker.calls[0].body);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).state, 'created');
  const done = await run(['create', '--spec', file, '--out', out], { env, now: later });
  assert.equal(done.output.status, 'already-created');
  assert.equal(broker.calls.length, 2, 'a created record is never re-posted');
});

test('create refuses to overwrite a record for a different lineage', async (t) => {
  const dir = tmpDir(t);
  const broker = await stubBroker(t, applied);
  const { file } = writeSpec(dir, { brokerUrl: broker.url });
  const out = path.join(dir, 'record.json');
  fs.writeFileSync(out, JSON.stringify({ schema: RECORD_SCHEMA, lineageId: 'other', brokerUrl: broker.url, request: {} }));
  const res = await run(['create', '--spec', file, '--out', out], { env: { A2A_EDGE_SECRET: SECRET } });
  assert.equal(res.exitCode, 2);
  assert.match(res.output.error, /refusing to overwrite/);
  assert.equal(broker.calls.length, 0);
});

test('a replay of a non-applied event is not a success', async (t) => {
  const dir = tmpDir(t);
  const broker = await stubBroker(t, () => ({ status: 200,
    payload: { result: { status: 'replayed', originalOutcome: 'transition_rejected' } } }));
  const { file } = writeSpec(dir, { brokerUrl: broker.url });
  const { exitCode } = await run(['create', '--spec', file, '--out', path.join(dir, 'r.json')],
    { env: { A2A_EDGE_SECRET: SECRET } });
  assert.equal(exitCode, 1);
});

test('cancel posts the record binding to the encoded operator-cancel route', async (t) => {
  const dir = tmpDir(t);
  const broker = await stubBroker(t, applied);
  const binding = { intentHash: `sha256:${'1'.repeat(64)}`, headSha: 'a'.repeat(40), diffHash: `sha256:${'2'.repeat(64)}` };
  const recordFile = path.join(dir, 'record.json');
  fs.writeFileSync(recordFile, JSON.stringify({ schema: RECORD_SCHEMA, brokerUrl: broker.url,
    requesterId: 'operator-jingun', lineageId: 'pr/2274:x', binding }));
  const { exitCode } = await run(['cancel', '--record', recordFile, '--decision-ref', 'abandon-1',
    '--detail', 'Superseded by a new head.'], { env: { A2A_EDGE_SECRET: SECRET } });
  assert.equal(exitCode, 0);
  assert.equal(broker.calls[0].url, '/review-lineages/pr%2F2274%3Ax/operator-cancel');
  assert.deepEqual(Object.keys(broker.calls[0].body).sort(), ['binding', 'decisionRef', 'detail', 'observedAt']);
  assert.deepEqual(broker.calls[0].body.binding, binding);
});

test('local validation rejects malformed specs with exit 2', async (t) => {
  const dir = tmpDir(t);
  for (const [overrides, pattern] of [
    [{ surprise: true }, /unknown spec field/],
    [{ headSha: 'ABC' }, /headSha/],
    [{ acceptanceCriteria: [{ id: 'ac1', text: 'x' }] }, /acceptanceCriteria\[0\]\.id/],
    [{ headSha: 'f'.repeat(40) }, /not present/],
    [{ diffFile: '/nonexistent' }, /either repo or diffFile/],
  ]) {
    const sub = fs.mkdtempSync(path.join(dir, 'case-'));
    const { file } = writeSpec(sub, overrides);
    const { exitCode, output } = await run(['create', '--spec', file, '--out', path.join(sub, 'r.json')],
      { env: { A2A_EDGE_SECRET: SECRET } });
    assert.equal(exitCode, 2, JSON.stringify(overrides));
    assert.match(output.error, pattern);
  }
  assert.equal((await run(['bogus'])).exitCode, 2);
});

// ─── Part 2: against the real broker ────────────────────────────────────────

const DIST_SERVER = path.join(ROOT, 'packages/broker/dist/server.js');
const distReason = fs.existsSync(DIST_SERVER) ? false : 'packages/broker/dist not built';

async function realBroker(t, reviewLineageMode) {
  const { createBrokerServer } = await import(DIST_SERVER);
  const dir = tmpDir(t);
  const runtime = createBrokerServer({
    host: '127.0.0.1', port: 0, publicBaseUrl: 'http://127.0.0.1/',
    sqliteFile: path.join(dir, 'broker.sqlite'), persistenceBackend: 'sqlite',
    stateFile: path.join(dir, 'state.json'), staleReaperEnabled: false,
    edgeSecret: SECRET, reviewLineageMode,
  });
  runtime.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => runtime.server.on('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => runtime.server.close(resolve));
    await runtime.close?.();
  });
  return `http://127.0.0.1:${runtime.server.address().port}`;
}

async function readLineages(url, id) {
  const headers = { 'x-a2a-edge-secret': SECRET, 'x-a2a-requester-id': 'operator-jingun', 'x-a2a-requester-role': 'operator' };
  const list = await (await fetch(`${url}/review-lineages`, { headers })).json();
  const one = await fetch(`${url}/review-lineages/${encodeURIComponent(id)}`, { headers });
  return { list, one: one.status === 200 ? await one.json() : null };
}

test('real broker (record mode): create → replay → cancel lands one canceled lineage', { skip: distReason }, async (t) => {
  const url = await realBroker(t, 'record');
  const dir = tmpDir(t);
  const { file } = writeSpec(dir, { brokerUrl: url });
  const out = path.join(dir, 'record.json');
  const env = { A2A_EDGE_SECRET: SECRET };

  // The broker applies the create but the response is lost on the way back.
  const lossyFetch = async (...args) => { await fetch(...args); throw new TypeError('socket hang up'); };
  const lost = await run(['create', '--spec', file, '--out', out], { env, now: FIXED_NOW, fetchImpl: lossyFetch });
  assert.equal(lost.exitCode, 1);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).state, 'pending');

  // The retry runs later; it must resend the persisted request and get a replay.
  const later = () => new Date('2026-10-09T11:00:00.000Z');
  const replay = await run(['create', '--spec', file, '--out', out], { env, now: later });
  assert.equal(replay.exitCode, 0, JSON.stringify(replay.output));
  assert.equal(replay.output.httpStatus, 200);
  assert.equal(replay.output.status, 'replayed');
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).state, 'created');

  // Rebuilding the request instead (new createdAt/observedAt) is a conflict.
  const changed = await run(['create', '--spec', file, '--out', path.join(dir, 'other.json')], { env, now: later });
  assert.equal(changed.exitCode, 1, 'the same dispatchRef with a changed payload is a conflict, not a second lineage');

  const before = await readLineages(url, 'lineage-2274-test');
  assert.equal(before.list.count, 1);
  assert.equal(before.one.lineage.state, 'reviewing_initial');

  const cancel = await run(['cancel', '--record', out, '--decision-ref', 'abandon-2274',
    '--detail', 'Operator abandoned the loop.'], { env });
  assert.equal(cancel.exitCode, 0, JSON.stringify(cancel.output));
  assert.equal(cancel.output.status, 'applied');

  const after = await readLineages(url, 'lineage-2274-test');
  assert.equal(after.list.count, 1);
  assert.equal(after.one.lineage.state, 'canceled');
});

test('real broker (off mode): create is refused and the record stays pending', { skip: distReason }, async (t) => {
  const url = await realBroker(t, 'off');
  const dir = tmpDir(t);
  const { file } = writeSpec(dir, { brokerUrl: url });
  const out = path.join(dir, 'record.json');
  const res = await run(['create', '--spec', file, '--out', out], { env: { A2A_EDGE_SECRET: SECRET } });
  assert.equal(res.exitCode, 1);
  assert.match(res.output.error, /disabled/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).state, 'pending');
});

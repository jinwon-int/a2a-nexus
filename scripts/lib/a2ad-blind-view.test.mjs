import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import {
  BLIND_SHADOW_SCHEMA,
  blindLabel,
  blindOrder,
  buildBlindView,
  dropReason,
  parsePick,
  resolvePick,
  shadowRecord,
} from './a2ad-blind-view.mjs';

// #2386: remove every temp directory this file created once its tests finish.
const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scriptPath = join(repoRoot, 'scripts', 'lib', 'a2ad-blind-view.mjs');
const ROUND = 'plan-round-2396-r1';
// Node words are assembled so this file does not carry them literally.
const NODE_A = ['dun', 'gae'].join('');
const NODE_B = ['jin', 'gun'].join('');
const NODE_C = ['so', 'gyo'].join('');

function lane(id, worker, overrides = {}) {
  return {
    id,
    status: 'succeeded',
    intent: 'plan',
    assignedWorkerId: worker,
    payload: { parentRoundId: ROUND, parentRoundTotal: 5 },
    output: {
      analysisSummary: `Plan from ${id}`,
      findings: [`finding of ${id}`],
      risks: [],
      recommendations: [`recommend ${id}`],
      evidenceRefs: ['https://github.com/jinwon-int/a2a-nexus/pull/2416'],
      bridgeAdapter: 'claude-a2a-analysis-bridge',
      harness: { runtime: 'claude-code', model: 'model-x' },
      actualRuntimeModel: 'model-x',
      completion: { marked: true },
      ...overrides.output,
    },
    ...overrides.lane,
  };
}

function roundTasks() {
  return [
    lane('lane-1', NODE_A, { output: { findings: [`${NODE_A} saw a race in worker-alpha`] } }),
    lane('lane-2', NODE_B),
    lane('lane-3', NODE_C, { output: { completion: undefined } }), // pre-#2393 legacy: kept
    lane('lane-4', NODE_A, { lane: { status: 'failed' } }),
    lane('lane-5', NODE_B, { output: { completion: { marked: false, reason: 'no_final_json' } } }),
    lane('lane-6', NODE_C, { output: { analysisSummary: '', findings: [], recommendations: [], evidenceRefs: [] } }),
    lane('other-round', NODE_A, { lane: { payload: { parentRoundId: 'another' } } }),
  ];
}

test('build drops non-responders before anonymising and hides identity', () => {
  const { bundle, idMap } = buildBlindView(roundTasks(), { round: ROUND });
  assert.deepEqual(
    idMap.dropped.map((d) => [d.laneId, d.reason]).sort(),
    [['lane-4', 'status:failed'], ['lane-5', 'unmarked:no_final_json'], ['lane-6', 'empty']],
  );
  assert.deepEqual(Object.keys(idMap.candidates), ['A', 'B', 'C']);
  assert.deepEqual(Object.values(idMap.candidates).map((c) => c.laneId).sort(), ['lane-1', 'lane-2', 'lane-3']);
  for (const word of [NODE_A, NODE_B, NODE_C, 'worker-alpha', 'claude-code', 'model-x', 'bridgeAdapter', 'lane-1', 'lane-2', 'lane-3']) {
    assert.equal(bundle.toLowerCase().includes(word.toLowerCase()), false, `bundle leaks ${word}`);
  }
  assert.ok(idMap.maskCount >= 2, 'node word and worker-* token in finding text are masked');
  assert.match(bundle, /COMPLETE -- nothing trimmed/);
  assert.match(bundle, /pre-#2393 lanes without a completion marker: 1/);
  assert.match(bundle, /https:\/\/github\.com\/jinwon-int\/a2a-nexus\/pull\/2416/, 'evidence links stay readable');
  assert.match(bundle, /```pick/);
});

test('blind ids are stable across reruns and independent of input order', () => {
  const first = buildBlindView(roundTasks(), { round: ROUND }).idMap.candidates;
  const reversed = buildBlindView([...roundTasks()].reverse(), { round: ROUND }).idMap.candidates;
  assert.deepEqual(reversed, first);
  assert.deepEqual(blindOrder(['x', 'y', 'z'], 's'), blindOrder(['z', 'x', 'y'], 's'));
  assert.equal(blindLabel(0), 'A');
  assert.equal(blindLabel(25), 'Z');
  assert.equal(blindLabel(26), 'A1');
});

test('a round with several targets needs an explicit --target', () => {
  const tasks = [...roundTasks(), lane('lane-7', NODE_B, { lane: { intent: 'review' } })];
  assert.throws(() => buildBlindView(tasks, { round: ROUND }), /choose one with --target/);
  const view = buildBlindView(tasks, { round: ROUND, target: 'review' });
  assert.deepEqual(Object.values(view.idMap.candidates).map((c) => c.laneId), ['lane-7']);
  assert.throws(() => buildBlindView(tasks, { round: 'missing' }), /no lanes/);
});

test('dropReason follows the gate completion semantics', () => {
  assert.equal(dropReason(lane('x', NODE_A)), '');
  assert.equal(dropReason(lane('x', NODE_A, { lane: { status: 'running' } })), 'status:running');
  assert.equal(
    dropReason(lane('x', NODE_A, { lane: { status: 'succeeded', error: { code: 'handler_timeout' } }, output: { completion: undefined } })),
    'unmarked:handler_timeout',
  );
});

test('strict pick parsing flags every malformed answer instead of defaulting', () => {
  const ids = ['A', 'B', 'C'];
  const block = (obj) => `reasoning...\n\`\`\`pick\n${JSON.stringify(obj)}\n\`\`\`\n`;
  const ok = parsePick(block({ id: 'B', criterion: 'FIDELITY', runnerUp: 'A', runnerUpLoss: 'cites a file the source lacks' }), ids);
  assert.equal(ok.fallback, false);
  assert.deepEqual(ok.pick, { id: 'B', criterion: 'FIDELITY', runnerUp: 'A', runnerUpLoss: 'cites a file the source lacks' });
  const cases = [
    ['no block here', 'no_pick_block'],
    [block({ id: 'A' }) + block({ id: 'B' }), 'multiple_pick_blocks'],
    ['```pick\n{not json}\n```', 'pick_not_json'],
    ['```pick\n["A"]\n```', 'pick_not_object'],
    [block({ id: 'D', criterion: 'x', runnerUp: 'A', runnerUpLoss: 'y' }), 'unknown_id'],
    [block({ id: 'A', runnerUp: 'B', runnerUpLoss: 'y' }), 'missing_criterion'],
    [block({ id: 'A', criterion: 'x' }), 'missing_runner_up'],
    [block({ id: 'A', criterion: 'x', runnerUp: 'A', runnerUpLoss: 'y' }), 'invalid_runner_up'],
    [block({ id: 'A', criterion: 'x', runnerUp: 'B' }), 'missing_runner_up_loss'],
  ];
  for (const [text, reason] of cases) {
    const parsed = parsePick(text, ids);
    assert.equal(parsed.fallback, true, reason);
    assert.equal(parsed.fallbackReason, reason);
    assert.equal(parsed.pick, null);
  }
  const single = parsePick(block({ id: 'A', criterion: 'DELIVERY', runnerUp: null }), ['A']);
  assert.equal(single.fallback, false);
});

test('resolve maps the blind pick back to lane and worker; the shadow record stays anonymous', () => {
  const { idMap } = buildBlindView(roundTasks(), { round: ROUND });
  const [first, second] = Object.keys(idMap.candidates);
  const verdict = `\`\`\`pick\n${JSON.stringify({ id: first, criterion: 'DELIVERY', runnerUp: second, runnerUpLoss: 'skips the rollback step' })}\n\`\`\``;
  const resolution = resolvePick(idMap, verdict);
  assert.equal(resolution.resolved.laneId, idMap.candidates[first].laneId);
  assert.equal(resolution.resolved.workerId, idMap.candidates[first].workerId);
  assert.equal(resolution.resolved.runnerUpLaneId, idMap.candidates[second].laneId);

  const agree = shadowRecord(idMap, resolution, idMap.candidates[first].laneId, new Date('2026-10-20T08:00:00Z'));
  assert.equal(agree.schema, BLIND_SHADOW_SCHEMA);
  assert.equal(agree.agree, true);
  assert.equal(agree.candidateCount, 3);
  assert.equal(agree.droppedCount, 3);
  assert.deepEqual(agree.droppedReasons, ['empty', 'status', 'unmarked']);
  const text = JSON.stringify(agree);
  for (const word of [NODE_A, NODE_B, NODE_C, 'lane-1', 'lane-2', 'lane-3']) assert.equal(text.includes(word), false, word);

  assert.equal(shadowRecord(idMap, resolution, 'some-other-lane').agree, false);
  const fallback = resolvePick(idMap, 'no pick');
  assert.equal(shadowRecord(idMap, fallback, 'x').agree, null);
  assert.throws(() => shadowRecord({ ...idMap, round: `${NODE_A}-round` }, resolution, 'x'), /identity token/);
});

test('CLI build writes a 0600 id map, resolve exits 1 on fallback and appends the shadow ledger', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'a2ad-blind-view-'));
  tempDirs.push(dir);
  const tasksFile = join(dir, 'tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify({ items: roundTasks() }));
  const out = join(dir, 'view');
  const build = spawnSync(process.execPath, [scriptPath, 'build', '--tasks', tasksFile, '--round', ROUND, '--out', out], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const summary = JSON.parse(build.stdout);
  assert.equal(summary.candidates, 3);
  assert.equal(fs.statSync(join(out, 'id-map.json')).mode & 0o777, 0o600);
  const idMap = JSON.parse(fs.readFileSync(join(out, 'id-map.json'), 'utf8'));

  const verdictFile = join(dir, 'verdict.md');
  fs.writeFileSync(verdictFile, '```pick\n{"id":"A","criterion":"FIDELITY","runnerUp":"B","runnerUpLoss":"overclaims"}\n```\n');
  const ledger = join(dir, 'shadow.jsonl');
  const ok = spawnSync(
    process.execPath,
    [scriptPath, 'resolve', '--out', out, '--verdict', verdictFile, '--named-pick', idMap.candidates.A.laneId, '--shadow-ledger', ledger],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).resolved.laneId, idMap.candidates.A.laneId);

  fs.writeFileSync(verdictFile, 'I think A is best.\n');
  const bad = spawnSync(
    process.execPath,
    [scriptPath, 'resolve', '--out', out, '--verdict', verdictFile, '--named-pick', idMap.candidates.A.laneId, '--shadow-ledger', ledger],
    { encoding: 'utf8' },
  );
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).fallbackReason, 'no_pick_block');

  const records = fs.readFileSync(ledger, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((r) => [r.agree, r.fallback]), [[true, false], [null, true]]);

  const usage = spawnSync(process.execPath, [scriptPath, 'build', '--round', ROUND, '--out', out], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});

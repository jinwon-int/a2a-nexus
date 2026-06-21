import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { computeVerdict, classify, citedEvidenceIds } from './a2ad-finalizer-gate.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(repoRoot, 'scripts', 'a2ad-finalizer-gate.mjs');

const ROUND = 'pr-review-20260612-abc';

// Build a lane task record for the round under test.
function lane(id, status, extra = {}) {
  return {
    id,
    status,
    assignedWorkerId: extra.worker || `worker-${id}`,
    payload: {
      parentRoundId: ROUND,
      parentRoundTotal: extra.total ?? 3,
      parentRoundOrder: extra.order ?? 1,
      reviewTarget: extra.reviewTarget,
      ...(extra.payload || {}),
    },
    ...(extra.top || {}),
  };
}

function writeTmp(prefix, content) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'a2ad-gate-'));
  const file = join(dir, prefix);
  fs.writeFileSync(file, content);
  return file;
}

function writeTasks(items) {
  return writeTmp('tasks.json', JSON.stringify({ items }));
}

function runGate(extraArgs, draftBody) {
  const args = [scriptPath, ...extraArgs];
  if (draftBody != null) {
    const draftFile = writeTmp('draft.md', draftBody);
    args.push('--draft', draftFile);
  }
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

// ─── Unit-level verdict ──────────────────────────────────────────────────────

test('classify maps statuses into succeeded/failed/pending buckets', () => {
  assert.equal(classify('succeeded'), 'succeeded');
  assert.equal(classify('failed'), 'failed');
  assert.equal(classify('canceled'), 'failed');
  assert.equal(classify('blocked'), 'failed');
  assert.equal(classify('timeout'), 'failed');
  assert.equal(classify('queued'), 'pending');
  assert.equal(classify('running'), 'pending');
  assert.equal(classify('approval_pending'), 'pending');
  // Unknown statuses fail closed → pending (block finality).
  assert.equal(classify('weird'), 'pending');
});

test('all workers complete and draft cites evidence → FINAL', () => {
  const tasks = [
    lane('t1', 'succeeded'),
    lane('t2', 'succeeded'),
    lane('t3', 'succeeded'),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Consensus over lanes t1, t2, t3.',
  });
  assert.equal(result.verdict, 'FINAL');
  assert.equal(result.succeeded, 3);
  assert.equal(result.expectedTotal, 3);
  assert.deepEqual(result.evidenceIdsCitedInDraft.sort(), ['t1', 't2', 't3']);
  assert.deepEqual(result.missingLanes, []);
});

test('partial complete → BLOCKED with missing lanes listed', () => {
  const tasks = [
    lane('t1', 'succeeded'),
    lane('t2', 'running'),
    lane('t3', 'queued'),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Cites t1.',
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.pending, 2);
  const ids = result.missingLanes.map((l) => l.taskId).sort();
  assert.deepEqual(ids, ['t2', 't3']);
  assert.ok(result.reasons.some((r) => /pending/i.test(r)));
});

test('dispatch failure (fewer lanes than parentRoundTotal) → BLOCKED naming the gap', () => {
  // Only 2 lanes exist but each declares parentRoundTotal=3.
  const tasks = [
    lane('t1', 'succeeded'),
    lane('t2', 'succeeded'),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Cites t1 and t2.',
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.reasons.some((r) => /dispatch gap.*2 of 3/i.test(r)), result.reasons.join('; '));
});

test('worker timeout/failed lanes are enumerated and never counted toward quorum', () => {
  const tasks = [
    lane('t1', 'succeeded'),
    lane('t2', 'failed'),
    lane('t3', 'timeout'),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: 3,
    perTarget: null,
    draft: 'Cites t1.',
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 2);
  const failedIds = result.missingLanes.map((l) => l.taskId).sort();
  assert.deepEqual(failedIds, ['t2', 't3']);
  // Quorum of 3 not met because failed lanes do not count.
  assert.ok(result.reasons.some((r) => /succeeded lanes 1 < required quorum 3/.test(r)));
});

test('generic a2ad-review wrapper success is non-substantive and blocks quorum (#958)', () => {
  const tasks = [
    lane('t1', 'succeeded', {
      payload: { mode: 'a2ad-review' },
      top: {
        intent: 'a2ad-review',
        output: {
          summary: 'generic a2ad-review task accepted by versioned A2A task handler',
          artifactIds: [],
        },
      },
    }),
    lane('t2', 'succeeded'),
    lane('t3', 'succeeded'),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Cites t1 t2 t3.',
  });

  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.succeeded, 2);
  assert.equal(result.nonSubstantive, 1);
  const t1 = result.missingLanes.find((l) => l.taskId === 't1');
  assert.equal(t1?.evidenceClass, 'wrapper_only');
  assert.match(t1?.reason ?? '', /generic a2ad-review/i);
});

test('docker-runner evidence-contract failure is classified separately from A2AD opinion evidence (#958)', () => {
  const tasks = [
    lane('t1', 'succeeded'),
    lane('t2', 'failed', {
      payload: { mode: 'github-propose-patch' },
      top: {
        error: {
          code: 'handler_exit_nonzero',
          details: {
            error: {
              code: 'docker_runner_failed',
              message: 'GitHub patch task completed without PR/Done/Block evidence. Treating as failed closed until canonical evidence is available.',
            },
          },
        },
      },
    }),
    lane('t3', 'succeeded'),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Cites t1 and t3.',
  });

  assert.equal(result.verdict, 'BLOCKED');
  const t2 = result.missingLanes.find((l) => l.taskId === 't2');
  assert.equal(t2?.evidenceClass, 'evidence_contract_failure');
  assert.match(t2?.reason ?? '', /PR\/Done\/Block|docker_runner_failed/);
});

test('analysis bridge invalid JSON failure is classified separately from worker opinion evidence', () => {
  const tasks = [
    lane('t1', 'succeeded', { worker: 'nosuk' }),
    lane('t2', 'failed', {
      worker: 'bangtong',
      payload: { mode: 'analysis-only' },
      top: {
        error: {
          code: 'handler_exit_nonzero',
          message: 'handler exited with code 1',
          details: {
            stdout: JSON.stringify({
              error: {
                code: 'openclaw_analysis_failed',
                message: 'Hermes analysis bridge response did not contain valid JSON: Unexpected token "[", "[Roadmap]" is not valid JSON',
              },
            }),
          },
        },
      },
    }),
    lane('t3', 'succeeded', { worker: 'sogyo' }),
  ];

  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Cites t1 and t3.',
  });

  assert.equal(result.verdict, 'BLOCKED');
  const t2 = result.missingLanes.find((l) => l.taskId === 't2');
  assert.equal(t2?.worker, 'bangtong');
  assert.equal(t2?.evidenceClass, 'analysis_bridge_invalid_json');
  assert.match(t2?.reason ?? '', /valid JSON|analysis bridge/i);
});

test('queued Daegyo lane is labeled mobile_limited and cannot satisfy quorum (#958)', () => {
  const tasks = [
    lane('t1', 'succeeded', { worker: 'dungae' }),
    lane('t2', 'succeeded', { worker: 'jingun' }),
    lane('t3', 'queued', { worker: 'daegyo', payload: { mode: 'analysis-only' } }),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Cites t1 and t2.',
  });

  assert.equal(result.verdict, 'BLOCKED');
  const t3 = result.missingLanes.find((l) => l.taskId === 't3');
  assert.equal(t3?.worker, 'daegyo');
  assert.equal(t3?.evidenceClass, 'mobile_limited');
});

test('FINAL refused when draft cites no succeeded-lane task ids', () => {
  const tasks = [
    lane('t1', 'succeeded'),
    lane('t2', 'succeeded'),
    lane('t3', 'succeeded'),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Looks good to me. Approving. (no task ids cited)',
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.evidenceIdsCitedInDraft.length, 0);
  assert.ok(result.reasons.some((r) => /evidence id/i.test(r)));
});

test('per-target quorum blocks when one target is short', () => {
  const tasks = [
    lane('t1', 'succeeded', { reviewTarget: 'pr-100' }),
    lane('t2', 'succeeded', { reviewTarget: 'pr-100' }),
    lane('t3', 'failed', { reviewTarget: 'pr-200' }),
  ];
  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: 1,
    perTarget: 1,
    draft: 'Cites t1 t2.',
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(result.reasons.some((r) => /per-target 'pr-200'/.test(r)), result.reasons.join('; '));
});

test('citedEvidenceIds returns only ids present in the draft', () => {
  assert.deepEqual(citedEvidenceIds('refs t1 only', ['t1', 't2']), ['t1']);
  assert.deepEqual(citedEvidenceIds('', ['t1']), []);
  assert.deepEqual(citedEvidenceIds('text', []), []);
});


test('analysis bridge blocked source-projection lane is non-substantive and listed with reason (#960)', () => {
  const tasks = [
    lane('t1', 'succeeded', {
      worker: 'nosuk',
      top: { output: { analysisStatus: 'done', analysisKind: 'analysis_bridge', summary: 'source reviewed' } },
    }),
    lane('t2', 'succeeded', {
      worker: 'bangtong',
      top: {
        output: {
          analysisStatus: 'blocked',
          analysisKind: 'analysis_bridge',
          summary: 'analysis bridge blocked: source projection failed: explicit sourceBundle.files could not be projected into the model prompt budget',
          risks: ['source projection budget exhausted'],
        },
      },
    }),
    lane('t3', 'succeeded', {
      worker: 'sogyo',
      top: { output: { analysisStatus: 'done', analysisKind: 'analysis_bridge', summary: 'source reviewed' } },
    }),
  ];

  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: 3,
    perTarget: null,
    draft: 'Cites t1 and t3.',
  });

  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.succeeded, 2);
  assert.equal(result.nonSubstantive, 1);
  const blocked = result.missingLanes.find((l) => l.taskId === 't2');
  assert.equal(blocked?.worker, 'bangtong');
  assert.equal(blocked?.status, 'succeeded');
  assert.equal(blocked?.evidenceClass, 'source_projection_blocked');
  assert.match(blocked?.reason ?? '', /source projection.*budget/i);
});

test('classifier ignores wrapper phrases embedded inside sourceBundle payload content (#960)', () => {
  const tasks = [
    lane('t1', 'succeeded', {
      top: { output: { analysisStatus: 'done', analysisKind: 'analysis_bridge', summary: 'real source analysis' } },
      payload: {
        sourceBundle: {
          files: [{
            path: 'virtual/issues/960.md',
            contentText: 'Historical incident text: generic a2ad-review task accepted by versioned A2A task handler. This is source evidence, not this lane output.',
          }],
        },
      },
    }),
    lane('t2', 'succeeded', { top: { output: { analysisStatus: 'done', analysisKind: 'analysis_bridge', summary: 'real source analysis' } } }),
    lane('t3', 'succeeded', { top: { output: { analysisStatus: 'done', analysisKind: 'analysis_bridge', summary: 'real source analysis' } } }),
  ];

  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: null,
    perTarget: null,
    draft: 'Consensus cites t1 t2 t3.',
  });

  assert.equal(result.verdict, 'FINAL');
  assert.equal(result.succeeded, 3);
  assert.equal(result.nonSubstantive, 0);
  assert.deepEqual(result.missingLanes, []);
});


test('compact supplement supersedes a source-projection blocked lane without hiding it (#960)', () => {
  const tasks = [
    lane('t1', 'succeeded', {
      worker: 'nosuk',
      top: { output: { analysisStatus: 'done', analysisKind: 'analysis_bridge', summary: 'primary source reviewed' } },
    }),
    lane('t2', 'succeeded', {
      worker: 'bangtong',
      top: {
        output: {
          analysisStatus: 'blocked',
          analysisKind: 'analysis_bridge',
          summary: 'analysis bridge blocked: source projection failed: sourceBundle.files could not fit prompt budget',
          risks: ['source projection prompt budget exhausted'],
        },
      },
    }),
    lane('t3', 'succeeded', {
      worker: 'sogyo',
      top: { output: { analysisStatus: 'done', analysisKind: 'analysis_bridge', summary: 'primary source reviewed' } },
    }),
    lane('t2-supplement', 'succeeded', {
      worker: 'bangtong',
      payload: {
        parentRoundOrder: 4,
        supplementOf: 't2',
        sourceBundle: {
          kind: 'a2a-nexus.sourceBundleProjection.compactSupplement.v1',
          files: [
            { path: 'packages/broker/scripts/hermes-a2a-analysis-bridge.mjs', contentText: 'compact bridge source' },
            { path: 'scripts/a2ad-finalizer-gate.mjs', contentText: 'compact finalizer source' },
          ],
        },
      },
      top: { output: { analysisStatus: 'done', analysisKind: 'analysis_bridge', summary: 'compact supplement reviewed' } },
    }),
  ];

  const result = computeVerdict(tasks, {
    round: ROUND,
    quorum: 3,
    perTarget: null,
    draft: 'Consensus cites t1 t3 t2-supplement.',
  });

  assert.equal(result.verdict, 'FINAL');
  assert.equal(result.succeeded, 3);
  assert.equal(result.nonSubstantive, 0);
  assert.deepEqual(result.missingLanes, []);
  assert.deepEqual(result.supersededLanes, [{
    taskId: 't2',
    status: 'succeeded',
    worker: 'bangtong',
    evidenceClass: 'superseded_by_supplement',
    reason: 'source_projection_blocked superseded by compact supplement t2-supplement',
    supersededBy: 't2-supplement',
  }]);
});

// ─── CLI-level behavior ──────────────────────────────────────────────────────

test('CLI exits 0 with FINAL when quorum satisfied', () => {
  const tasksFile = writeTasks([
    lane('t1', 'succeeded'),
    lane('t2', 'succeeded'),
    lane('t3', 'succeeded'),
  ]);
  const result = runGate(['--tasks', tasksFile, '--round', ROUND], 'Consensus from t1 t2 t3.');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /FINAL/);
});

test('CLI exits 1 with BLOCKED when lanes pending', () => {
  const tasksFile = writeTasks([
    lane('t1', 'succeeded'),
    lane('t2', 'running'),
    lane('t3', 'queued'),
  ]);
  const result = runGate(['--tasks', tasksFile, '--round', ROUND], 'Cites t1.');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BLOCKED/);
  assert.match(result.stderr, /t2/);
  assert.match(result.stderr, /t3/);
});

test('--allow-preliminary exits 0 and prepends the loud PRELIMINARY banner', () => {
  const tasksFile = writeTasks([
    lane('t1', 'succeeded'),
    lane('t2', 'running'),
    lane('t3', 'queued'),
  ]);
  const result = runGate(
    ['--tasks', tasksFile, '--round', ROUND, '--allow-preliminary'],
    'Finalizer-only summary.',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /⚠️ PRELIMINARY/);
  assert.match(result.stdout, /A2AD worker quorum NOT satisfied/);
  assert.match(result.stdout, /1\/3 succeeded/);
  assert.match(result.stdout, /lanes pending: t2, t3/);
  // The original body is preserved after the banner.
  assert.match(result.stdout, /Finalizer-only summary\./);
});

test('--dry-run prints would-post body + missing-evidence list, exits 0, no banner', () => {
  const tasksFile = writeTasks([
    lane('t1', 'succeeded'),
    lane('t2', 'failed'),
    lane('t3', 'queued'),
  ]);
  const result = runGate(
    ['--tasks', tasksFile, '--round', ROUND, '--dry-run'],
    'Would post this body.',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would-post body/);
  assert.match(result.stdout, /Would post this body\./);
  assert.match(result.stdout, /t2 \[failed\]/);
  assert.match(result.stdout, /t3 \[queued\]/);
  assert.doesNotMatch(result.stdout, /PRELIMINARY/);
});

test('--json emits the structured verdict contract', () => {
  const tasksFile = writeTasks([
    lane('t1', 'succeeded'),
    lane('t2', 'failed'),
    lane('t3', 'queued'),
  ]);
  const result = runGate(['--tasks', tasksFile, '--round', ROUND, '--json'], 'Cites t1.');
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.verdict, 'BLOCKED');
  assert.equal(parsed.round, ROUND);
  assert.equal(parsed.expectedTotal, 3);
  assert.equal(parsed.succeeded, 1);
  assert.equal(parsed.failed, 1);
  assert.equal(parsed.pending, 1);
  assert.deepEqual(parsed.evidenceIdsCitedInDraft, ['t1']);
  const ids = parsed.missingLanes.map((l) => l.taskId).sort();
  assert.deepEqual(ids, ['t2', 't3']);
});

test('malformed dump fails loudly (exit 2)', () => {
  const badFile = writeTmp('bad.json', '{ not valid json ');
  const result = runGate(['--tasks', badFile, '--round', ROUND], 'x');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /parse|read/i);
});

test('dump that is neither array nor {items} fails loudly', () => {
  const badFile = writeTmp('shape.json', JSON.stringify({ tasks: [] }));
  const result = runGate(['--tasks', badFile, '--round', ROUND], 'x');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /array|items/i);
});

test('task record missing id fails loudly', () => {
  const badFile = writeTmp('noid.json', JSON.stringify({ items: [{ status: 'succeeded' }] }));
  const result = runGate(['--tasks', badFile, '--round', ROUND], 'x');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /id/);
});

test('accepts a bare JSON array dump', () => {
  const file = writeTmp('arr.json', JSON.stringify([
    lane('t1', 'succeeded'),
    lane('t2', 'succeeded'),
    lane('t3', 'succeeded'),
  ]));
  const result = runGate(['--tasks', file, '--round', ROUND], 'Consensus t1 t2 t3.');
  assert.equal(result.status, 0, result.stderr);
});

test('--help documents the fail-closed publication contract', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /fail-closed/i);
  assert.match(result.stdout, /never posts to GitHub/i);
  assert.match(result.stdout, /allow-preliminary/);
});

test('missing required flags fail loudly', () => {
  const noTasks = spawnSync(process.execPath, [scriptPath, '--round', ROUND], { encoding: 'utf8' });
  assert.equal(noTasks.status, 2);
  assert.match(noTasks.stderr, /--tasks/);
  const tasksFile = writeTasks([lane('t1', 'succeeded')]);
  const noRound = spawnSync(process.execPath, [scriptPath, '--tasks', tasksFile], { encoding: 'utf8' });
  assert.equal(noRound.status, 2);
  assert.match(noRound.stderr, /--round/);
});

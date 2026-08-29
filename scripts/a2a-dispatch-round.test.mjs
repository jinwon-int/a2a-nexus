import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  runDispatch,
  validateManifest,
  deriveLaneId,
  CLASS_CREATED,
  CLASS_ACCEPTED_UNCONFIRMED,
  CLASS_ALREADY_EXISTS,
  CLASS_FAILED,
  CLASS_PREFLIGHT_EXCLUDED,
  A2A_REQUESTER_ROLES,
} from './a2a-dispatch-round.mjs';
import { A2A_REQUESTER_ROLES as BROKER_REQUESTER_ROLES } from '../packages/broker/src/core/requester-role-contract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'a2a-dispatch-round.mjs');
const MOCK_BROKER = join(__dirname, 'a2a-dispatch-round.mock-broker.mjs');
const SECRET = 'edge-secret-do-not-leak-9f3a';

/**
 * Spawn the standalone mock broker as its own process (required for child-
 * process CLI tests — an in-process server would deadlock under spawnSync).
 */
function startBrokerProcess(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_BROKER, mode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('mock broker did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        const { port } = JSON.parse(buf.slice(0, nl));
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { child.once('exit', r); child.kill(); }) });
      }
    });
    child.on('error', reject);
  });
}

// ─── Mock broker (node:http) ─────────────────────────────────────────────────

/**
 * Build a local mock broker.
 * @param {object} behavior
 *   behavior.post(req, body) => { status, json } controls POST /tasks per call.
 *   behavior.store is a Map of taskId -> task used to back GET /tasks/:id.
 */
function startMockBroker(behavior) {
  const store = behavior.store ?? new Map();
  let postCalls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(obj == null ? '' : JSON.stringify(obj));
      };
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/tasks') {
        const body = raw ? JSON.parse(raw) : {};
        const result = behavior.post(body, { call: postCalls++ , store });
        return send(result.status, result.json);
      }
      if (req.method === 'GET' && url.startsWith('/tasks/')) {
        const id = decodeURIComponent(url.slice('/tasks/'.length));
        if (store.has(id)) return send(200, store.get(id));
        return send(404, { error: { code: 'not_found' } });
      }
      return send(404, { error: { code: 'not_found' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        store,
        getPostCalls: () => postCalls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeManifest(brokerUrl, laneCount = 3) {
  return {
    roundId: 'pr-review-r2-20260612-195514',
    brokerUrl,
    requester: { id: 'libero', role: 'operator' },
    defaults: { intent: 'pr-review' },
    lanes: Array.from({ length: laneCount }, (_, i) => ({
      target: { id: `worker-${i + 1}`, role: 'analyst' },
      message: `Please review lane ${i + 1}`,
    })),
  };
}

// ─── validateManifest / deriveLaneId ─────────────────────────────────────────

test('deriveLaneId uses explicit id, else roundId:order', () => {
  assert.equal(deriveLaneId('r1', { id: 'explicit' }, 2), 'explicit');
  assert.equal(deriveLaneId('r1', {}, 2), 'r1:2');
});

test('validateManifest stamps parent-round metadata and derives ids', () => {
  const { errors, lanes } = validateManifest(makeManifest('http://x', 3));
  assert.equal(errors.length, 0);
  assert.equal(lanes.length, 3);
  assert.equal(lanes[0].id, 'pr-review-r2-20260612-195514:1');
  assert.equal(lanes[1].payload.parentRoundOrder, 2);
  assert.equal(lanes[1].payload.parentRoundTotal, 3);
  assert.equal(lanes[1].payload.parentRoundId, 'pr-review-r2-20260612-195514');
});

test('validateManifest honors explicit parentRoundOrder in lane payload', () => {
  const m = makeManifest('http://x', 2);
  m.lanes[0].payload = { parentRoundOrder: 9 };
  const { lanes } = validateManifest(m);
  assert.equal(lanes[0].payload.parentRoundOrder, 9);
  assert.equal(lanes[0].payload.parentRoundTotal, 2);
});

// ─── runDispatch: dry-run ────────────────────────────────────────────────────

test('dispatcher consumes the broker requester-role contract without drift', () => {
  assert.strictEqual(A2A_REQUESTER_ROLES, BROKER_REQUESTER_ROLES);
  assert.deepEqual(A2A_REQUESTER_ROLES, [
    'hub',
    'live-trader',
    'researcher',
    'analyst',
    'operator',
    'publisher',
    'reviewer',
    'orchestrator',
  ]);
});

test('dry-run accepts every broker requester role for requester and target', async () => {
  for (const role of A2A_REQUESTER_ROLES) {
    const manifest = makeManifest('http://unused', 1);
    manifest.requester.role = role;
    manifest.lanes[0].target.role = role;

    const out = await runDispatch(manifest, { dryRun: true });
    assert.equal(out.exitCode, 0, `${role} should pass`);
  }
});

test('invalid requester role fails locally with the broker allowed set and no POST', async () => {
  const manifest = makeManifest('http://unused', 1);
  manifest.requester.role = 'stranger';
  const expectedErrors = [
    'requester.role must be one of: hub, live-trader, researcher, analyst, operator, publisher, reviewer, orchestrator',
  ];
  let fetchCalls = 0;

  const dryRunOut = await runDispatch(manifest, { dryRun: true });
  assert.equal(dryRunOut.exitCode, 1);
  assert.deepEqual(dryRunOut.errors, expectedErrors);

  const out = await runDispatch(manifest, {
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('validation must prevent network access');
    },
    secret: SECRET,
  });

  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.errors, expectedErrors);
  assert.equal(fetchCalls, 0);
});

test('invalid target role fails locally with the broker allowed set and no POST', async () => {
  const manifest = makeManifest('http://unused', 1);
  manifest.lanes[0].target.role = 'stranger';
  const expectedErrors = [
    'lanes[0].target.role must be one of: hub, live-trader, researcher, analyst, operator, publisher, reviewer, orchestrator',
  ];
  let fetchCalls = 0;

  const dryRunOut = await runDispatch(manifest, { dryRun: true });
  assert.equal(dryRunOut.exitCode, 1);
  assert.deepEqual(dryRunOut.errors, expectedErrors);

  const out = await runDispatch(manifest, {
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('validation must prevent network access');
    },
    secret: SECRET,
  });

  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.errors, expectedErrors);
  assert.equal(fetchCalls, 0);
});

test('dry-run validates and plans without network', async () => {
  const out = await runDispatch(makeManifest('http://unused', 2), { dryRun: true });
  assert.equal(out.exitCode, 0);
  assert.equal(out.mode, 'dry-run');
  assert.equal(out.lanes.length, 2);
});

test('dry-run rejects duplicate lane ids', async () => {
  const m = makeManifest('http://unused', 2);
  m.lanes[0].id = 'dup';
  m.lanes[1].id = 'dup';
  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /duplicate lane id/.test(e)));
});

test('dry-run rejects empty message', async () => {
  const m = makeManifest('http://unused', 1);
  m.lanes[0].message = '   ';
  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /message is required/.test(e)));
});

test('dry-run rejects source-only analysis lanes whose sourceBundle has no files array', async () => {
  const m = makeManifest('http://unused', 1);
  m.lanes[0].payload = {
    mode: 'analysis-only',
    sourceOnly: true,
    readOnlyValidation: true,
    sourceBundle: {
      roundId: 'r1',
      sourceSnippets: [{ path: 'packages/broker/src/server.ts', content: 'snippet only' }],
    },
  };
  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /sourceBundle\.files must be a non-empty array/.test(e)));
});

test('dry-run accepts source-only analysis lanes with files carrying path and content', async () => {
  const m = makeManifest('http://unused', 1);
  m.lanes[0].payload = {
    mode: 'analysis-only',
    sourceOnly: true,
    readOnlyValidation: true,
    sourceBundle: {
      roundId: 'r1',
      files: [{ path: 'packages/broker/src/server.ts', content: 'export const ok = true;\n' }],
    },
  };
  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 0);
});

test('dry-run accepts source-only analysis file contentText as canonical content', async () => {
  const m = makeManifest('http://unused', 1);
  m.lanes[0].payload = {
    mode: 'analysis-only',
    sourceOnly: true,
    readOnlyValidation: true,
    sourceBundle: {
      roundId: 'r1',
      files: [{ path: 'packages/broker/src/server.ts', contentText: 'export const ok = true;\n' }],
    },
  };
  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 0);
});


test('dry-run accepts the #960 canonical sourceBundle projection contract fixture', async () => {
  const fixtureUrl = new URL('../fixtures/contract/source-bundle-projection-guard.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
  const m = makeManifest('http://unused', fixture.lanes.length);
  m.roundId = fixture.roundId;
  m.defaults.intent = 'analyze';
  m.defaults.terminalBrief = { notificationOwnership: 'parent' };
  m.defaults.payload = {
    originBrokerId: 'brokerAlpha',
    brokerOfRecordId: 'brokerAlpha',
    operatorFacingOwner: 'parent',
  };
  m.lanes = fixture.lanes.map((lane) => ({
    id: lane.id,
    target: lane.target,
    intent: lane.intent,
    message: `Validate source bundle projection fixture lane ${lane.id}`,
    payload: lane.payload,
  }));

  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 0, out.errors.join('\n'));
  assert.equal(out.lanes.length, 2);
  assert.equal(out.lanes[0].payload.sourceBundle.files.length, 2);
  assert.equal(out.lanes[1].payload.supplementOf, 'a2a-960-sourcebundle-contract-fixture-2-blocked');
  assert.ok(out.lanes.every((lane) => lane.intent === 'analyze'));
  assert.ok(out.lanes.every((lane) => lane.payload.mode === 'analysis-only'));
  assert.ok(out.lanes.every((lane) => lane.payload.sourceOnly === true));
  assert.ok(out.lanes.every((lane) => lane.payload.noLive === true));
});

test('dry-run rejects source-only analysis files without path or content', async () => {
  const missingPath = makeManifest('http://unused', 1);
  missingPath.lanes[0].payload = {
    sourceBundle: { files: [{ content: 'const ok = true;\n' }] },
  };
  const missingPathOut = await runDispatch(missingPath, { dryRun: true });
  assert.equal(missingPathOut.exitCode, 1);
  assert.ok(missingPathOut.errors.some((e) => /sourceBundle\.files\[0\]\.path is required/.test(e)));

  const missingContent = makeManifest('http://unused', 1);
  missingContent.lanes[0].payload = {
    sourceBundle: { files: [{ path: 'packages/broker/src/server.ts' }] },
  };
  const missingContentOut = await runDispatch(missingContent, { dryRun: true });
  assert.equal(missingContentOut.exitCode, 1);
  assert.ok(missingContentOut.errors.some((e) => /sourceBundle\.files\[0\]\.content or .*contentText is required/.test(e)));
});

test('dry-run rejects legacy a2ad-review intent without explicit analysis bridge mode (#958)', async () => {
  const m = makeManifest('http://unused', 1);
  m.defaults.intent = 'a2ad-review';
  m.lanes[0].payload = {
    roundMode: 'a2ad',
    sourceOnly: true,
    noLive: true,
    sourceBundle: { files: [{ path: 'README.md', content: '# A2A Nexus\n' }] },
  };

  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /intent=analyze.*payload\.mode=analysis-only/i.test(e)), out.errors.join('\n'));
});

function makeA2adAnalysisManifest(brokerUrl) {
  const m = makeManifest(brokerUrl, 1);
  m.defaults.intent = 'analyze';
  m.defaults.terminalBrief = { notificationOwnership: 'parent' };
  m.defaults.payload = {
    mode: 'analysis-only',
    roundMode: 'a2ad',
    sourceOnly: true,
    noLive: true,
    originBrokerId: 'brokerAlpha',
    brokerOfRecordId: 'brokerAlpha',
    operatorFacingOwner: 'parent',
    sourceBundle: { files: [{ path: 'README.md', content: '# A2A Nexus\n' }] },
  };
  return m;
}

test('dry-run accepts A2AD opinion lanes only as analyze + analysis-only (#958)', async () => {
  const m = makeA2adAnalysisManifest('http://unused');

  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 0, out.errors.join('\n'));
  assert.equal(out.lanes[0].intent, 'analyze');
  assert.equal(out.lanes[0].payload.mode, 'analysis-only');
});

test('dry-run rejects A2AD analysis lanes missing live broker Terminal Brief ownership metadata (#963)', async () => {
  const cases = [
    ['payload.originBrokerId', (m) => { delete m.defaults.payload.originBrokerId; }, /payload\.originBrokerId is required for A2AD analysis lanes/],
    ['payload.brokerOfRecordId', (m) => { delete m.defaults.payload.brokerOfRecordId; }, /payload\.brokerOfRecordId is required for A2AD analysis lanes/],
    ['payload.operatorFacingOwner', (m) => { delete m.defaults.payload.operatorFacingOwner; }, /payload\.operatorFacingOwner is required for A2AD analysis lanes/],
    ['terminalBrief.notificationOwnership', (m) => { delete m.defaults.terminalBrief.notificationOwnership; }, /terminalBrief\.notificationOwnership is required for A2AD analysis lanes/],
  ];

  for (const [name, mutate, pattern] of cases) {
    const m = makeA2adAnalysisManifest('http://unused');
    mutate(m);
    const out = await runDispatch(m, { dryRun: true });
    assert.equal(out.exitCode, 1, `${name} should fail dry-run`);
    assert.ok(out.errors.some((e) => pattern.test(e)), `${name} error not found in: ${out.errors.join('\n')}`);
  }
});

test('dry-run requires A2AD ownership metadata even when a source-only workModeDecision is present (#963)', async () => {
  const m = makeA2adAnalysisManifest('http://unused');
  m.defaults.payload.workModeDecision = {
    mode: 'team1',
    idempotencyKey: 'a2ad-analysis-r1',
    finalizerOwner: 'brokerAlpha',
    generatedAt: '2026-06-21T00:00:00Z',
    capacityState: 'healthy',
    capacitySnapshotSource: 'fixture',
    capacitySnapshotAt: '2026-06-21T00:00:00Z',
    sourceOnlyDecision: true,
    workerDispatchAllowedByThisPacket: false,
  };
  delete m.defaults.payload.originBrokerId;

  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /payload\.originBrokerId is required for A2AD analysis lanes/.test(e)), out.errors.join('\n'));
});

test('dry-run rejects pure A2AD opinion lanes routed through GitHub evidence modes (#958)', async () => {
  const m = makeManifest('http://unused', 1);
  m.defaults.intent = 'analyze';
  m.lanes[0].payload = {
    mode: 'github-verify',
    roundMode: 'a2ad',
    sourceOnly: true,
    noLive: true,
    sourceBundle: { files: [{ path: 'README.md', content: '# A2A Nexus\n' }] },
  };

  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /pure A2AD opinion.*analysis-only.*GitHub evidence/i.test(e)), out.errors.join('\n'));
});

function makeGitHubVerifyManifest(brokerUrl) {
  const manifest = makeManifest(brokerUrl, 1);
  manifest.roundId = 'a2a-github-verify-r1';
  manifest.requester = { id: 'brokerAlpha', role: 'operator' };
  manifest.defaults = {
    intent: 'verify',
    taskOrigin: 'github',
    workspace: { nodeId: 'workerGamma', workspaceId: 'workspace-workerGamma' },
    terminalBrief: { notificationOwnership: 'parent' },
    payload: {
      mode: 'github-verify',
      repo: 'jinwon-int/a2a-nexus',
      issue: '#869',
      readOnlyValidation: true,
      sourceOnly: true,
      noLive: true,
      originBrokerId: 'brokerAlpha',
      brokerOfRecordId: 'brokerAlpha',
      operatorFacingOwner: 'parent',
      workModeDecision: {
        mode: 'team1',
        idempotencyKey: 'a2a-github-verify-r1-workerGamma',
        finalizerOwner: 'brokerAlpha',
        generatedAt: '2026-06-17T00:00:00Z',
        capacityState: 'healthy',
        capacitySnapshotSource: 'fixture',
        capacitySnapshotAt: '2026-06-17T00:00:00Z',
        sourceOnlyDecision: true,
        workerDispatchAllowedByThisPacket: false,
      },
    },
  };
  manifest.lanes[0] = {
    target: { id: 'workerGamma', role: 'analyst' },
    assignedWorkerId: 'workerGamma',
    message: 'Validate issue #869 with a read-only GitHub verify lane',
  };
  return manifest;
}

test('dry-run rejects GitHub verify lanes missing broker-required schema fields (#869)', async () => {
  const missingTaskOrigin = makeGitHubVerifyManifest('http://unused');
  delete missingTaskOrigin.defaults.taskOrigin;
  const missingTaskOriginOut = await runDispatch(missingTaskOrigin, { dryRun: true });
  assert.equal(missingTaskOriginOut.exitCode, 1);
  assert.ok(missingTaskOriginOut.errors.some((e) => /taskOrigin.*github/.test(e)));

  const missingWorkspace = makeGitHubVerifyManifest('http://unused');
  delete missingWorkspace.defaults.workspace.workspaceId;
  const missingWorkspaceOut = await runDispatch(missingWorkspace, { dryRun: true });
  assert.equal(missingWorkspaceOut.exitCode, 1);
  assert.ok(missingWorkspaceOut.errors.some((e) => /workspace\.workspaceId/.test(e)));

  const missingWorkModeDecision = makeGitHubVerifyManifest('http://unused');
  delete missingWorkModeDecision.defaults.payload.workModeDecision;
  const missingWorkModeDecisionOut = await runDispatch(missingWorkModeDecision, { dryRun: true });
  assert.equal(missingWorkModeDecisionOut.exitCode, 1);
  assert.ok(missingWorkModeDecisionOut.errors.some((e) => /workModeDecision/.test(e)));
});

test('dry-run stamps GitHub verify parent-round and ownership metadata (#869)', async () => {
  const out = await runDispatch(makeGitHubVerifyManifest('http://unused'), { dryRun: true });
  assert.equal(out.exitCode, 0);
  const lane = out.lanes[0];
  assert.equal(lane.taskOrigin, 'github');
  assert.deepEqual(lane.workspace, { nodeId: 'workerGamma', workspaceId: 'workspace-workerGamma' });
  assert.equal(lane.parentRoundId, 'a2a-github-verify-r1');
  assert.equal(lane.parentRoundTotal, 1);
  assert.equal(lane.parentRoundOrder, 1);
  assert.equal(lane.payload.parentRoundId, 'a2a-github-verify-r1');
  assert.equal(lane.payload.parentRoundTotal, 1);
  assert.equal(lane.payload.parentRoundOrder, 1);
  assert.equal(lane.payload.operatorFacingOwner, 'parent');
  assert.deepEqual(lane.terminalBrief, { notificationOwnership: 'parent' });
});

// ─── runDispatch: live (mock broker) ─────────────────────────────────────────

function makeGitHubPatchManifest(brokerUrl) {
  const manifest = makeManifest(brokerUrl, 1);
  manifest.roundId = 'a2a-github-patch-r1';
  manifest.requester = { id: 'brokerAlpha', role: 'operator' };
  manifest.defaults = {
    intent: 'propose_patch',
    taskOrigin: 'github',
    workspace: { nodeId: 'brokerAlpha', workspaceId: 'workspace-shared' },
    terminalBrief: { notificationOwnership: 'parent' },
    payload: {
      mode: 'github-propose-patch',
      repo: 'jinwon-int/a2a-nexus',
      issue: '#884',
      issueNumber: 884,
      runId: 'a2a-github-patch-r1',
    },
  };
  manifest.lanes[0] = {
    target: { id: 'workerDelta', role: 'analyst' },
    assignedWorkerId: 'workerDelta',
    message: 'Propose a source-only patch for issue #884',
  };
  return manifest;
}

function addPatchReadyWorker(manifest, workerId = 'workerDelta') {
  manifest.workerReadiness = {
    rows: [
      {
        node: workerId,
        ok: true,
        githubPatch: 'ok',
        canPatchWorkspace: true,
        canOpenPullRequest: true,
        runnerTrustedOperator: true,
        githubTokenFileReadable: true,
        patchCommandProfile: 'claude-code',
        bridgeMode: 'patch',
        violations: [],
      },
    ],
  };
  return manifest;
}

test('dry-run rejects github-propose-patch lanes without patch-readiness proof (#1034)', async () => {
  const manifest = makeGitHubPatchManifest('http://unused');

  const out = await runDispatch(manifest, { dryRun: true });

  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /github-propose-patch.*workerReadiness.*#1034/.test(e)), out.errors.join('\n'));
});

test('dry-run accepts github-propose-patch lanes with proven PR capability (#1034)', async () => {
  const manifest = addPatchReadyWorker(makeGitHubPatchManifest('http://unused'));

  const out = await runDispatch(manifest, { dryRun: true });

  assert.equal(out.exitCode, 0, out.errors.join('\n'));
});

test('dry-run rejects github-propose-patch lanes whose readiness lacks PR capability (#1034)', async () => {
  const manifest = makeGitHubPatchManifest('http://unused');
  manifest.workerReadiness = {
    rows: [{ node: 'workerDelta', ok: true, githubPatch: 'ok', canPatchWorkspace: true, canOpenPullRequest: false }],
  };

  const out = await runDispatch(manifest, { dryRun: true });

  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /#1034.*canOpenPullRequest/.test(e)), out.errors.join('\n'));
});

test('dry-run rejects github-propose-patch lanes declared read-only/no-write (#889)', async () => {
  const manifest = makeGitHubPatchManifest('http://unused');
  manifest.defaults.payload = {
    ...manifest.defaults.payload,
    sourceOnly: true,
    noLive: true,
    readOnlyValidation: true,
    noGitHubWrites: true,
  };

  const out = await runDispatch(manifest, { dryRun: true });

  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /github-propose-patch.*write-capable.*#889/.test(e)));
});

test('dry-run rejects sourceOnly github-propose-patch even with explicit write flags (#1355)', async () => {
  const manifest = addPatchReadyWorker(makeGitHubPatchManifest('http://unused'));
  manifest.defaults.payload = {
    ...manifest.defaults.payload,
    sourceOnly: true,
    allowGitHubWrites: true,
    patchIntent: true,
  };

  const out = await runDispatch(manifest, { dryRun: true });

  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /sourceOnly=true.*github-propose-patch.*#1355/.test(e)), out.errors.join('\n'));
});

test('dry-run derives GitHub workspace nodeId from target worker when defaults use orchestrator node (#884)', async () => {
  const manifest = makeGitHubVerifyManifest('http://unused');
  manifest.defaults.workspace = { nodeId: 'brokerAlpha', workspaceId: 'workspace-shared' };
  manifest.lanes[0].target = { id: 'workerDelta', role: 'analyst' };
  manifest.lanes[0].assignedWorkerId = 'workerDelta';

  const out = await runDispatch(manifest, { dryRun: true });

  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.lanes[0].workspace, { nodeId: 'workerDelta', workspaceId: 'workspace-shared' });
});

test('GitHub propose-patch dispatch derives worker workspace before POST (#884)', async () => {
  const seenBodies = [];
  const broker = await startMockBroker({
    post: (body, ctx) => {
      seenBodies.push(body);
      ctx.store.set(body.id, { id: body.id, status: 'queued' });
      return { status: 201, json: { task: { id: body.id, status: 'queued' } } };
    },
  });
  try {
    const manifest = addPatchReadyWorker(makeGitHubPatchManifest(broker.url));
    const out = await runDispatch(manifest, { fetchImpl: fetch, secret: SECRET, verify: true });
    assert.equal(out.exitCode, 0);
    assert.equal(seenBodies.length, 1);
    const body = seenBodies[0];
    assert.equal(body.taskOrigin, 'github');
    assert.equal(body.intent, 'propose_patch');
    assert.deepEqual(body.workspace, { nodeId: 'workerDelta', workspaceId: 'workspace-shared' });
    assert.equal(body.assignedWorkerId, 'workerDelta');
    assert.equal(body.payload.mode, 'github-propose-patch');
    assert.equal(body.payload.parentRoundId, 'a2a-github-patch-r1');
    assert.equal(body.payload.parentRoundTotal, 1);
    assert.equal(body.payload.parentRoundOrder, 1);
  } finally {
    await broker.close();
  }
});

test('dry-run rejects explicit GitHub lane workspace node mismatch (#884)', async () => {
  const manifest = makeGitHubPatchManifest('http://unused');
  manifest.lanes[0].workspace = { nodeId: 'brokerAlpha', workspaceId: 'workspace-shared' };

  const out = await runDispatch(manifest, { dryRun: true });

  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /workspace\.nodeId must match target\.id 'workerDelta'/.test(e)));
});

test('GitHub verify dispatch POST includes top-level schema/readback fields (#869)', async () => {
  const seenBodies = [];
  const broker = await startMockBroker({
    post: (body, ctx) => {
      seenBodies.push(body);
      ctx.store.set(body.id, { id: body.id, status: 'queued' });
      return { status: 201, json: { task: { id: body.id, status: 'queued' } } };
    },
  });
  try {
    const out = await runDispatch(makeGitHubVerifyManifest(broker.url), { fetchImpl: fetch, secret: SECRET, verify: true });
    assert.equal(out.exitCode, 0);
    assert.equal(seenBodies.length, 1);
    const body = seenBodies[0];
    assert.equal(body.taskOrigin, 'github');
    assert.deepEqual(body.workspace, { nodeId: 'workerGamma', workspaceId: 'workspace-workerGamma' });
    assert.equal(body.assignedWorkerId, 'workerGamma');
    assert.equal(body.parentRoundId, 'a2a-github-verify-r1');
    assert.equal(body.parentRoundTotal, 1);
    assert.equal(body.parentRoundOrder, 1);
    assert.deepEqual(body.terminalBrief, { notificationOwnership: 'parent' });
    assert.equal(body.payload.parentRoundId, 'a2a-github-verify-r1');
    assert.equal(out.verify.rows[0].state, 'queued');
  } finally {
    await broker.close();
  }
});

test('all lanes 201 -> exit 0, all created', async () => {
  const broker = await startMockBroker({
    post: (body) => ({ status: 201, json: { task: { id: body.id, status: 'queued' } } }),
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 3), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 0);
    assert.equal(out.ok, true);
    assert.equal(out.summary.counts[CLASS_CREATED], 3);
    assert.equal(broker.getPostCalls(), 3);
  } finally {
    await broker.close();
  }
});

test('one lane 500 -> exit 1, that lane failed, others still attempted', async () => {
  const broker = await startMockBroker({
    post: (body, ctx) => {
      if (ctx.call === 1) return { status: 500, json: { error: { code: 'internal' } } };
      return { status: 201, json: { task: { id: body.id, status: 'queued' } } };
    },
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 3), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 1);
    assert.equal(out.summary.counts[CLASS_FAILED], 1);
    assert.equal(out.summary.counts[CLASS_CREATED], 2);
    assert.equal(broker.getPostCalls(), 3, 'all lanes attempted despite the failure');
    const failed = out.results.find((r) => r.classification === CLASS_FAILED);
    assert.equal(failed.status, 500);
  } finally {
    await broker.close();
  }
});

test('broker 400 error.message is surfaced as a redacted bounded lane detail (#1593)', async () => {
  const broker = await startMockBroker({
    post: () => ({
      status: 400,
      json: {
        error: {
          code: 'bad_request',
          message: `x-a2a-requester-role must be one of:\n orchestrator, worker\t${SECRET}`,
        },
      },
    }),
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 1), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 1);
    assert.equal(out.results[0].errorCode, 'bad_request');
    assert.equal(
      out.results[0].detail,
      'x-a2a-requester-role must be one of: orchestrator, worker [REDACTED]',
    );
    assert.ok(!out.results[0].detail.includes(SECRET));
  } finally {
    await broker.close();
  }
});

test('broker error detail is capped before it reaches lane output (#1593)', async () => {
  const broker = await startMockBroker({
    post: () => ({
      status: 400,
      json: { error: { code: 'bad_request', message: `invalid request: ${'x'.repeat(600)}` } },
    }),
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 1), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.results[0].detail.length, 500);
    assert.match(out.results[0].detail, /\.\.\.$/);
  } finally {
    await broker.close();
  }
});

test('503 queue_drain_timeout + task found on GET -> accepted-unconfirmed, exit 0', async () => {
  const store = new Map();
  const broker = await startMockBroker({
    store,
    post: (body, ctx) => {
      // Task IS created in memory; durable ack timed out.
      ctx.store.set(body.id, { id: body.id, status: 'queued' });
      return { status: 503, json: { error: { code: 'queue_drain_timeout' } } };
    },
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 0);
    assert.equal(out.summary.counts[CLASS_ACCEPTED_UNCONFIRMED], 2);
    const r = out.results[0];
    assert.equal(r.classification, CLASS_ACCEPTED_UNCONFIRMED);
    assert.ok(r.verifyHint, 'includes a verify hint');
  } finally {
    await broker.close();
  }
});

test('503 + task NOT found on GET -> failed, exit 1', async () => {
  const broker = await startMockBroker({
    post: () => ({ status: 503, json: { error: { code: 'queue_drain_timeout' } } }),
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 1);
    assert.equal(out.summary.counts[CLASS_FAILED], 2);
    assert.equal(out.results[0].errorCode, 'queue_drain_timeout');
  } finally {
    await broker.close();
  }
});

test('202 {task,durable:false} shape -> accepted-unconfirmed', async () => {
  const broker = await startMockBroker({
    post: (body) => ({ status: 202, json: { task: { id: body.id, status: 'queued' }, durable: false, ackTimeout: true } }),
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 0);
    assert.equal(out.summary.counts[CLASS_ACCEPTED_UNCONFIRMED], 2);
    assert.ok(out.results[0].verifyHint);
  } finally {
    await broker.close();
  }
});

test('duplicate (POST 409, GET finds task) -> already-exists', async () => {
  const store = new Map();
  const broker = await startMockBroker({
    store,
    post: (body, ctx) => {
      ctx.store.set(body.id, { id: body.id, status: 'queued' });
      return { status: 409, json: { error: { code: 'duplicate_task' } } };
    },
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET });
    assert.equal(out.exitCode, 0);
    assert.equal(out.summary.counts[CLASS_ALREADY_EXISTS], 2);
  } finally {
    await broker.close();
  }
});

test('preflight-excluded worker lanes are not POSTed and are reported separately (#659)', async () => {
  const broker = await startMockBroker({
    post: (body) => ({ status: 201, json: { task: { id: body.id, status: 'queued' } } }),
  });
  try {
    const manifest = makeManifest(broker.url, 2);
    manifest.workerReadiness = {
      rows: [
        { node: 'worker-1', ok: true, violations: [] },
        {
          node: 'worker-2',
          ok: false,
          violations: [
            {
              code: 'handler_missing',
              reason: 'required handler hermes-a2a-analysis-bridge.mjs is present but not executable (EACCES on spawn)',
            },
          ],
        },
      ],
    };

    const out = await runDispatch(manifest, { fetchImpl: fetch, secret: SECRET });

    assert.equal(out.exitCode, 0);
    assert.equal(out.ok, true);
    assert.equal(broker.getPostCalls(), 1, 'preflight-excluded lane must not create a broker task');
    assert.equal(out.summary.counts[CLASS_CREATED], 1);
    assert.equal(out.summary.counts[CLASS_PREFLIGHT_EXCLUDED], 1);
    const excluded = out.results.find((row) => row.classification === CLASS_PREFLIGHT_EXCLUDED);
    assert.equal(excluded.target, 'worker-2');
    assert.equal(excluded.errorCode, 'handler_missing');
    assert.match(excluded.detail, /EACCES/);
  } finally {
    await broker.close();
  }
});

test('--verify re-fetches each lane and counts states', async () => {
  const store = new Map();
  const broker = await startMockBroker({
    store,
    post: (body, ctx) => {
      ctx.store.set(body.id, { id: body.id, status: 'queued' });
      return { status: 201, json: { task: { id: body.id, status: 'queued' } } };
    },
  });
  try {
    const out = await runDispatch(makeManifest(broker.url, 2), { fetchImpl: fetch, secret: SECRET, verify: true });
    assert.equal(out.exitCode, 0);
    assert.ok(out.verify);
    assert.equal(out.verify.rows.length, 2);
    assert.equal(out.verify.counts.queued, 2);
  } finally {
    await broker.close();
  }
});

test('missing A2A_EDGE_SECRET refuses to dispatch', async () => {
  const out = await runDispatch(makeManifest('http://unused', 1), { fetchImpl: fetch, secret: '' });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /A2A_EDGE_SECRET/.test(e)));
});

// ─── Secret never leaks (child process, full output capture) ─────────────────

test('CLI --worker-readiness excludes failed workers before POST /tasks', async () => {
  const broker = await startBrokerProcess('ok');
  const dir = mkdtempSync(join(tmpdir(), 'a2a-dispatch-round-'));
  const manifestPath = join(dir, 'manifest.json');
  const readinessPath = join(dir, 'worker-readiness.json');
  writeFileSync(manifestPath, JSON.stringify(makeManifest(broker.url, 2)));
  writeFileSync(readinessPath, JSON.stringify({
    rows: [
      { node: 'worker-1', ok: true, violations: [] },
      { node: 'worker-2', ok: false, violations: [{ code: 'handler_missing', reason: 'bridge EACCES' }] },
    ],
  }));
  try {
    const proc = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestPath, '--worker-readiness', readinessPath, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, A2A_EDGE_SECRET: SECRET },
    });
    assert.equal(proc.status, 0, `${proc.stdout}\n${proc.stderr}`);
    const report = JSON.parse(proc.stdout);
    assert.equal(report.summary.counts[CLASS_CREATED], 1);
    assert.equal(report.summary.counts[CLASS_PREFLIGHT_EXCLUDED], 1);
    assert.equal(report.results.find((row) => row.classification === CLASS_PREFLIGHT_EXCLUDED).errorCode, 'handler_missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await broker.close();
  }
});

test('secret never appears in CLI output', async () => {
  const broker = await startBrokerProcess('ok');
  const dir = mkdtempSync(join(tmpdir(), 'a2a-dispatch-round-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(makeManifest(broker.url, 2)));
  try {
    const proc = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestPath, '--verify'], {
      encoding: 'utf8',
      env: { ...process.env, A2A_EDGE_SECRET: SECRET },
    });
    const combined = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 0, combined);
    assert.ok(!combined.includes(SECRET), 'secret must not appear in output');
    assert.ok(!combined.includes('ALL DISPATCHED'), 'forbidden banner must not appear');
    assert.ok(/created=2/.test(combined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await broker.close();
  }
});

test('CLI exits 1 when a lane fails and prints no all-clear', async () => {
  const broker = await startBrokerProcess('fail-first');
  const dir = mkdtempSync(join(tmpdir(), 'a2a-dispatch-round-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(makeManifest(broker.url, 2)));
  try {
    const proc = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestPath], {
      encoding: 'utf8',
      env: { ...process.env, A2A_EDGE_SECRET: SECRET },
    });
    const combined = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 1, combined);
    assert.ok(!combined.includes('ALL DISPATCHED'));
    assert.ok(/INCOMPLETE/.test(combined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await broker.close();
  }
});

test('CLI failure output includes the broker bad_request message (#1593)', async () => {
  const broker = await startBrokerProcess('bad-request-first');
  const dir = mkdtempSync(join(tmpdir(), 'a2a-dispatch-round-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(makeManifest(broker.url, 1)));
  try {
    const proc = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestPath], {
      encoding: 'utf8',
      env: { ...process.env, A2A_EDGE_SECRET: SECRET },
    });
    const combined = `${proc.stdout}\n${proc.stderr}`;
    assert.equal(proc.status, 1, combined);
    assert.match(combined, /code=bad_request/);
    assert.match(combined, /detail=x-a2a-requester-role must be one of: orchestrator, worker/);
    assert.ok(!combined.includes(SECRET), 'secret must not appear in failure detail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await broker.close();
  }
});

// ─── #1518 (routed from #1725 finding 3): review lane dry-run contract ──────

test('dry-run rejects self-contained A2AD review lanes without review.authorWorkerId (#1518)', async () => {
  const m = makeA2adAnalysisManifest('http://unused');
  m.lanes[0].payload = {
    ...m.defaults.payload,
    review: { required: true, kind: 'antithesis', targetLaneId: 'thesis-1' },
  };

  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(
    out.errors.some((e) => /review\.authorWorkerId is required for self-contained A2AD review lanes/.test(e)),
    out.errors.join('\n'),
  );
});

test('dry-run rejects review lanes whose author equals the completing worker (#1518 review_author_conflict)', async () => {
  const m = makeA2adAnalysisManifest('http://unused');
  m.lanes[0].payload = {
    ...m.defaults.payload,
    review: { required: true, kind: 'antithesis', authorWorkerId: 'worker-1' },
  };

  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 1);
  assert.ok(out.errors.some((e) => /review_author_conflict/.test(e)), out.errors.join('\n'));
});

test('dry-run accepts a well-formed antithesis lane with a distinct declared author (#1518)', async () => {
  const m = makeA2adAnalysisManifest('http://unused');
  m.lanes[0].payload = {
    ...m.defaults.payload,
    review: { required: true, kind: 'antithesis', authorWorkerId: 'author-a', targetLaneId: 'thesis-1' },
  };

  const out = await runDispatch(m, { dryRun: true });
  assert.equal(out.exitCode, 0, out.errors.join('\n'));
});

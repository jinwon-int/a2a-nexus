import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreflightResult,
  evaluateSafetyGates,
  fetchBrokerHealth,
  fetchWorkerList,
  findDuplicateOnlineWorkerIds,
  findStaleOrInactiveCrossBrokerWorkerIds,
  onlineWorkers,
  parseArgs,
} from './two-broker-worker-preflight.mjs';

describe('two-broker worker cutover preflight', () => {
  it('flags worker ids that are online on both brokeralpha and brokerbeta', () => {
    const duplicates = findDuplicateOnlineWorkerIds(
      [
        { nodeId: 'shared-worker', status: 'online', role: 'analyst', lastSeenAt: '2026-05-07T02:00:00.000Z', metadata: { revision: 'brokeralpha-r1' } },
        { nodeId: 'brokeralpha-only', status: 'online', role: 'analyst' },
        { nodeId: 'stale-shared', status: 'stale', role: 'analyst' },
      ],
      [
        { nodeId: 'shared-worker', status: 'online', role: 'analyst', lastSeenAt: '2026-05-07T02:00:05.000Z', metadata: { revision: 'brokerbeta-r2' } },
        { nodeId: 'brokerbeta-only', status: 'online', role: 'analyst' },
        { nodeId: 'stale-shared', status: 'online', role: 'analyst' },
      ],
    );

    assert.deepEqual(duplicates.map((worker) => worker.workerId), ['shared-worker']);
    assert.equal(duplicates[0].brokeralpha.lastSeenAt, '2026-05-07T02:00:00.000Z');
    assert.equal(duplicates[0].brokerbeta.lastSeenAt, '2026-05-07T02:00:05.000Z');
    assert.equal(duplicates[0].brokeralpha.revision, 'brokeralpha-r1');
    assert.equal(duplicates[0].brokerbeta.revision, 'brokerbeta-r2');
  });

  it('distinguishes stale cross-broker workers from duplicate-online blockers', () => {
    const stale = findStaleOrInactiveCrossBrokerWorkerIds(
      [
        { nodeId: 'retargeted-worker', status: 'stale', metadata: { buildRevision: 'old-r1', brokerId: 'brokeralpha' } },
        { nodeId: 'both-online', status: 'online' },
      ],
      [
        { nodeId: 'retargeted-worker', status: 'online', metadata: { buildRevision: 'new-r2', brokerId: 'brokerbeta' } },
        { nodeId: 'both-online', status: 'online' },
      ],
    );

    assert.deepEqual(stale.map((worker) => worker.workerId), ['retargeted-worker']);
    assert.equal(stale[0].brokeralpha.status, 'stale');
    assert.equal(stale[0].brokerbeta.status, 'online');
    assert.match(stale[0].distinction, /non-blocking/);
  });

  it('ignores stale workers and malformed ids for online counts', () => {
    const workers = onlineWorkers([
      { nodeId: 'online-worker', status: 'online' },
      { nodeId: 'stale-worker', status: 'stale' },
      { status: 'online' },
      null,
    ]);

    assert.deepEqual(workers.map((entry) => entry.workerId), ['online-worker']);
  });

  it('reads broker urls and safety evidence path from args before environment', () => {
    assert.deepEqual(
      parseArgs(['--brokeralpha-url', 'http://brokeralpha.example', '--brokerbeta-url=http://brokerbeta.example', '--safety-evidence', 'safe.json'], {
        brokeralpha_BROKER_URL: 'http://env-brokeralpha.example',
        brokerbeta_BROKER_URL: 'http://env-brokerbeta.example',
      }),
      { brokeralphaUrl: 'http://brokeralpha.example', brokerbetaUrl: 'http://brokerbeta.example', safetyEvidence: 'safe.json', json: false },
    );
  });

  it('fetches /workers and /health without sending a mutating request', async () => {
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push({ url: String(url), options });
      if (String(url).endsWith('/workers')) {
        return new Response(JSON.stringify({ items: [{ nodeId: 'w1', status: 'online' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, brokerId: 'brokeralpha', build: { revision: 'rev-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const workers = await fetchWorkerList('http://broker.example/base/', fetchImpl);
    const health = await fetchBrokerHealth('http://broker.example/base/', fetchImpl);

    assert.deepEqual(workers, [{ nodeId: 'w1', status: 'online' }]);
    assert.equal(health.build.revision, 'rev-1');
    assert.deepEqual(seen.map((entry) => entry.url), [
      'http://broker.example/base/workers',
      'http://broker.example/base/health',
    ]);
    assert.deepEqual(seen.map((entry) => entry.options.method), ['GET', 'GET']);
  });

  it('reports broker and worker revisions plus rollback notes in the aggregate result', () => {
    const result = buildPreflightResult({
      brokeralphaHealth: { brokerId: 'brokeralpha', version: '0.1.0', build: { revision: 'broker-old' } },
      brokerbetaHealth: { brokerId: 'brokerbeta', version: '0.1.0', build: { revision: 'broker-new' } },
      brokeralphaWorkers: [{ nodeId: 'w1', status: 'stale', metadata: { revision: 'worker-old', brokerId: 'brokeralpha' } }],
      brokerbetaWorkers: [{ nodeId: 'w1', status: 'online', metadata: { revision: 'worker-new', brokerId: 'brokerbeta' } }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.brokerRevisions.brokeralpha.revision, 'broker-old');
    assert.equal(result.brokerRevisions.brokerbeta.revision, 'broker-new');
    assert.equal(result.workerRevisionSummary.brokeralpha[0].revision, 'worker-old');
    assert.equal(result.workerRevisionSummary.brokerbeta[0].revision, 'worker-new');
    assert.match(result.rollbackNotes.join('\n'), /does not execute rollback/);
    assert.match(result.rollbackNotes.join('\n'), /Provider accepted\/message-id evidence is non-ACK/);
  });

  it('fails closed when sanitized evidence reports deploy/restart/canary/DB/ACK/release risk', () => {
    const safety = evaluateSafetyGates({
      productionDeploy: true,
      gatewayRestart: true,
      liveProviderCanary: true,
      dbMutation: true,
      terminalAckOrReplay: true,
      release: true,
      providerAcceptedMessageIdAsAck: true,
    });

    assert.equal(safety.ok, false);
    assert.equal(safety.blockers.length, 7);
    assert.match(safety.blockers.join('\n'), /production deploy/);
    assert.match(safety.blockers.join('\n'), /terminal ACK\/replay/);
    assert.match(safety.blockers.join('\n'), /provider accepted\/message-id counted as terminal ACK/);
  });
});

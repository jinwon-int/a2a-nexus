import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runNoLiveProof, runPreflight } from './terminal-outbox-preflight.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('terminal outbox preflight', () => {
  it('produces no-live terminal payload proof without broker calls or ACK attempts', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      throw new Error('no-live proof must not call fetch');
    };

    const report = await runPreflight({ noLive: true, fetchImpl });

    assert.equal(report.ok, true);
    assert.equal(report.mode, 'no-live');
    assert.equal(report.providerCalled, false);
    assert.equal(report.productionAckAttempted, false);
    assert.equal(report.brokerHttpRequested, false);
    assert.equal(called, false);
    assert.match(report.checks[0].detail, /no broker HTTP request/);
    const dryRun = report.checks.find((check) => check.check === 'terminal payload dry-run');
    assert.ok(dryRun);
    assert.equal(dryRun.terminalPreviews[0].dryRun, true);
    assert.equal(dryRun.terminalPreviews[0].repo, 'jinwon-int/a2a-broker');
    assert.equal(dryRun.terminalPreviews[0].issue, 318);
    assert.doesNotMatch(JSON.stringify(report), /token|secret|chat_id|\/work\/repo/);
  });

  it('fails no-live proof when synthetic payload includes non-HTTP evidence URL', () => {
    const report = runNoLiveProof({
      body: {
        kind: 'task.terminal.outbox',
        count: 1,
        cursor: 'terminal-unsafe',
        events: [{ id: 'terminal-unsafe', payload: { status: 'blocked', blockUrl: 'file:///work/repo/private.log' } }],
      },
    });

    assert.equal(report.ok, false);
    assert.match(report.checks.find((check) => check.check === 'terminal-outbox poll')?.detail ?? '', /non-HTTP evidence URLs/);
  });

  it('polls health and replay state without acknowledging outbox records', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, query: parsed.searchParams.toString(), headers: init?.headers ?? {} });
      if (parsed.pathname === '/health') {
        return jsonResponse({ ok: true, persistence: { kind: 'sqlite' }, requestSecurity: { edgeSecretRequired: true } });
      }
      if (parsed.pathname === '/a2a/tasks/terminal-outbox') {
        const reconcile = parsed.searchParams.get('reconcile_unacked') === 'true';
        return jsonResponse({
          kind: 'task.terminal.outbox',
          count: 1,
          cursor: 'terminal-1',
          reconciledUnacked: reconcile ? 1 : undefined,
          events: [{
            id: 'terminal-1',
            kind: 'task.terminal',
            taskEventId: 7,
            createdAt: '2026-05-02T00:00:00.000Z',
            attempts: 0,
            payload: {
              taskId: 'task-1',
              status: 'succeeded',
              worker: 'bangtong',
              repo: 'jinwon-int/a2a-broker',
              issue: 276,
              taskBrief: 'broker receipt/evidence gate',
              prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/1',
              createdAt: '2026-05-02T00:00:00.000Z',
              updatedAt: '2026-05-02T00:00:00.000Z',
            },
          }],
        });
      }
      throw new Error(`unexpected request ${parsed.pathname}`);
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', edgeSecret: 'redacted', fetchImpl });

    assert.equal(report.ok, true);
    assert.deepEqual(calls.map((call) => call.path), [
      '/health',
      '/a2a/tasks/terminal-outbox',
      '/a2a/tasks/terminal-outbox',
    ]);
    assert.equal(calls.some((call) => call.path.endsWith('/ack')), false);
    assert.equal(calls[2].query.includes('reconcile_unacked=true'), true);
    assert.equal(calls[1].headers['x-a2a-requester-role'], 'operator');
    assert.equal(report.checks[1].events[0].taskBrief, 'broker receipt/evidence gate');
    assert.equal(calls[1].headers['x-a2a-edge-secret'], 'redacted');
  });

  it('fails when terminal outbox evidence URLs are not HTTP(S)', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 1,
        cursor: 'terminal-1',
        events: [{ id: 'terminal-1', payload: { status: 'blocked', doneUrl: 'file:///tmp/private-log' } }],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, false);
    assert.match(report.checks.find((check) => check.check === 'terminal-outbox poll')?.detail ?? '', /non-HTTP evidence URLs/);
  });

  it('summarizes terminal readiness counts for unacked, receipt-confirmed, and replay candidates', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      const reconcile = parsed.searchParams.get('reconcile_unacked') === 'true';
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 2,
        cursor: 'terminal-2',
        reconciledUnacked: reconcile ? 1 : undefined,
        events: [
          {
            id: 'terminal-1',
            receipt: { status: 'accepted', updatedAt: '2026-05-04T00:00:00.000Z' },
            payload: { status: 'succeeded', worker: 'sogyo', taskBrief: 'terminal readiness unacked proof', doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/323#issuecomment-1' },
          },
          {
            id: 'terminal-2',
            ack: { status: 'receipt_confirmed', evidence: 'operator_visible', acknowledgedAt: '2026-05-04T00:00:01.000Z' },
            receipt: { status: 'operator_visible', updatedAt: '2026-05-04T00:00:01.000Z' },
            payload: { status: 'succeeded', worker: 'bangtong', taskBrief: 'terminal readiness receipt proof', prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/323' },
          },
        ],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, true);
    assert.equal(report.checks[1].readiness.unackedCount, 1);
    assert.equal(report.checks[1].readiness.receiptConfirmedCount, 1);
    assert.equal(report.checks[2].readiness.staleCursorOrReplayCandidates, 1);
    assert.match(report.checks[1].detail, /readiness unacked=1, receiptConfirmed=1/);
  });

  it('blocks terminal readiness when evidence, worker, or task brief is missing', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 1,
        cursor: 'terminal-incomplete',
        events: [{ id: 'terminal-incomplete', payload: { status: 'blocked' } }],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, false);
    const poll = report.checks.find((check) => check.check === 'terminal-outbox poll');
    // The sparse row (no createdAt, no receipt, no evidence, no worker, no taskBrief)
    // is unclassifiable and still blocks preflight as a current-window/unclassifiable candidate.
    assert.match(poll?.detail ?? '', /current-window\/unclassifiable missing evidence=1/);
    assert.match(poll?.detail ?? '', /current-window\/unclassifiable missing worker=1/);
    assert.match(poll?.detail ?? '', /current-window\/unclassifiable missing task brief=1/);
    assert.equal(poll?.readiness.unclassifiableCount, 1);
  });

  it('does not block fresh preflight on receipt-confirmed rows missing task brief', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 1,
        cursor: 'terminal-receipt-confirmed',
        events: [{
          id: 'terminal-receipt-confirmed',
          ack: { status: 'receipt_confirmed', evidence: 'operator_visible', acknowledgedAt: '2026-05-04T00:00:01.000Z' },
          receipt: { status: 'operator_visible', updatedAt: '2026-05-04T00:00:01.000Z' },
          payload: {
            status: 'succeeded',
            worker: 'bangtong',
            prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/323',
          },
        }],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, true);
    const poll = report.checks.find((check) => check.check === 'terminal-outbox poll');
    // The row is receipt-confirmed, so it is not a blocker candidate.
    // currentWindowMissingTaskBriefCount counts only blocker candidates (unacked + current-window).
    assert.equal(poll?.readiness.currentWindowMissingTaskBriefCount, 0);
    // receiptConfirmedMissingTaskBriefCount tracks the total receipt-confirmed rows missing taskBrief.
    assert.equal(poll?.readiness.receiptConfirmedMissingTaskBriefCount, 1);
    assert.equal(poll?.readiness.currentWindowCount, 1); // classified as current-window
    assert.equal(poll?.readiness.legacyResidueCount, 0); // not legacy
    assert.match(poll?.detail ?? '', /receiptConfirmed=1/);
  });

  it('does not block preflight on legacy-unacked row missing taskBrief (pre-cutoff)', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 1,
        cursor: 'terminal-legacy-unacked',
        events: [{
          id: 'terminal-legacy-unacked',
          createdAt: '2026-05-01T00:00:00.000Z',
          receipt: { status: 'accepted', updatedAt: '2026-05-01T00:00:00.000Z' },
          payload: {
            status: 'succeeded',
            worker: 'old-worker',
            prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/1',
          },
        }],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, true);
    const poll = report.checks.find((check) => check.check === 'terminal-outbox poll');
    // Legacy-unacked row pre-cutoff: classified as legacy-residue, does not block
    assert.equal(poll?.readiness.legacyResidueCount, 1);
    assert.equal(poll?.readiness.currentWindowCount, 0);
    assert.equal(poll?.readiness.currentWindowMissingTaskBriefCount, 0);
    assert.equal(poll?.readiness.legacyMissingTaskBriefCount, 1); // missing taskBrief is noted but non-blocking
    assert.match(poll?.detail ?? '', /legacy-residue=1/);
  });

  it('blocks preflight on current-window unacked row missing taskBrief', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 1,
        cursor: 'terminal-current-no-brief',
        events: [{
          id: 'terminal-current-no-brief',
          createdAt: '2026-05-06T00:00:00.000Z',
          receipt: { status: 'accepted', updatedAt: '2026-05-06T00:00:00.000Z' },
          payload: {
            status: 'succeeded',
            worker: 'new-worker',
            prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/2',
          },
        }],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, false);
    const poll = report.checks.find((check) => check.check === 'terminal-outbox poll');
    assert.match(poll?.detail ?? '', /current-window.*missing task brief=1/);
    assert.equal(poll?.readiness.currentWindowCount, 1);
    assert.equal(poll?.readiness.legacyResidueCount, 0);
    assert.equal(poll?.readiness.currentWindowMissingTaskBriefCount, 1);
  });

  it('does not block on legacy row with legacy receipt status and no evidence', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 1,
        cursor: 'terminal-legacy-receipt-status',
        events: [{
          id: 'terminal-legacy-receipt-status',
          createdAt: '2026-05-06T00:00:00.000Z',
          receipt: { status: 'sent', updatedAt: '2026-05-06T00:00:00.000Z' },
          payload: {
            status: 'succeeded',
            worker: 'old-worker',
            taskBrief: 'legacy receipt format',
          },
        }],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, true);
    const poll = report.checks.find((check) => check.check === 'terminal-outbox poll');
    // Legacy receipt status (sent) marks it as legacy residue despite post-cutoff createdAt
    assert.equal(poll?.readiness.legacyResidueCount, 1);
    assert.equal(poll?.readiness.currentWindowCount, 0);
  });

  it('blocks on current-window issues even when legacy residue is also present', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 2,
        cursor: 'terminal-mixed',
        events: [
          {
            id: 'terminal-legacy-part',
            createdAt: '2026-05-01T00:00:00.000Z',
            receipt: { status: 'accepted', updatedAt: '2026-05-01T00:00:00.000Z' },
            payload: {
              status: 'succeeded',
              worker: 'old-worker',
              prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/10',
            },
          },
          {
            id: 'terminal-current-bad',
            createdAt: '2026-05-06T00:00:00.000Z',
            receipt: { status: 'accepted', updatedAt: '2026-05-06T00:00:00.000Z' },
            payload: {
              status: 'succeeded',
              worker: 'new-worker',
              prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/11',
              // No taskBrief — blocks on this current-window row
            },
          },
        ],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, false);
    const poll = report.checks.find((check) => check.check === 'terminal-outbox poll');
    // Legacy row does not block, current-window missing taskBrief does
    assert.equal(poll?.readiness.legacyResidueCount, 1);
    assert.equal(poll?.readiness.currentWindowCount, 1);
    assert.equal(poll?.readiness.currentWindowMissingTaskBriefCount, 1);
    // legacyResidueSummary contains the classified legacy entry
    assert.equal(poll?.readiness.legacyResidueSummary.length, 1);
    assert.match(poll?.readiness.legacyResidueSummary[0]?.reason ?? '', /legacy residue/);
    assert.match(poll?.detail ?? '', /missing task brief=1/);
  });

});

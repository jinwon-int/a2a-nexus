import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_WORKERS,
  buildLiberoPublicPreflightCloseout,
  renderLiberoPublicPreflightCloseoutMarkdown,
} from './libero-public-preflight-closeout.mjs';

const URLS = {
  bangtong: 'https://evidence.example.invalid/a2a-plane-44-bangtong',
  sogyo: 'https://evidence.example.invalid/a2a-plane-pr-45-sogyo',
  nosuk: 'https://evidence.example.invalid/a2a-plane-44-nosuk',
};

function cleanEvidence(overrides = {}) {
  return deepMerge({
    repository: { private: true },
    safety: {
      visibilityChanged: false,
      publicVisibilityChanged: false,
      npmPublished: false,
      dockerPublished: false,
      releaseCreated: false,
      deployed: false,
      gatewayRestarted: false,
      brokerRestarted: false,
      workerRestarted: false,
      productionDbMutated: false,
      providerMessageSent: false,
      telegramMessageSent: false,
      terminalOutboxAcked: false,
      secretRotated: false,
      secretDisclosed: false,
      historyRewritten: false,
      forcePushed: false,
    },
    scanners: {
      publicReadiness: { ok: true },
      externalSecretHistory: { ok: true },
    },
    approval: {
      operatorApprovalSeparated: true,
      visibilityExecutionSeparated: true,
      explicitVisibilityApproval: false,
    },
    lanes: REQUIRED_WORKERS.map((worker) => ({ worker, status: 'succeeded', doneCommentUrl: URLS[worker] })),
  }, overrides);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base?.[key] ?? {}, value)
      : value;
  }
  return out;
}

describe('libero public preflight closeout', () => {
  it('aggregates bangtong/sogyo/nosuk and keeps public visibility NO-GO without explicit approval', () => {
    const report = buildLiberoPublicPreflightCloseout(cleanEvidence(), { nowMs: Date.parse('2026-05-07T22:11:51Z') });

    assert.equal(report.ok, true);
    assert.equal(report.state, 'ready-no-go');
    assert.deepEqual(report.requiredWorkers, ['bangtong', 'sogyo', 'nosuk']);
    assert.equal(report.counts.completed, 3);
    assert.equal(report.scanner.ok, true);
    assert.equal(report.approval.separated, true);
    assert.match(report.visibilityDecision, /NO-GO/);

    const markdown = renderLiberoPublicPreflightCloseoutMarkdown(report);
    assert.match(markdown, /^Done: Team1 P0 libero public preflight aggregate/);
    assert.match(markdown, /Required lanes: bangtong,sogyo,nosuk/);
    assert.match(markdown, /Scanners: public-readiness=clean; external-secret\/history=clean/);
    assert.match(markdown, /explicit-visibility-approval=no/);
    assert.doesNotMatch(markdown, /Final GO|\/work\/repo|ghp_|github_pat_|BROKER_EDGE_SECRET|chat_id/i);
  });

  it('declares GO only when scanners are clean and approval remains separated', () => {
    const report = buildLiberoPublicPreflightCloseout(cleanEvidence({
      approval: { explicitVisibilityApproval: true },
    }));

    assert.equal(report.ok, true);
    assert.equal(report.state, 'go-review-only');
    assert.match(report.visibilityDecision, /GO authorized/);
  });

  it('fails closed when external scanner evidence is missing or blocked', () => {
    const report = buildLiberoPublicPreflightCloseout(cleanEvidence({
      scanners: { externalSecretHistory: { ok: false } },
    }));

    assert.equal(report.ok, false);
    assert.equal(report.state, 'blocked');
    assert.equal(report.scanner.externalSecretHistory, false);
    assert.match(report.blockers.join('\n'), /scanner evidence is not clean/);
  });

  it('waits rather than producing false Done when a sibling lane is unresolved', () => {
    const report = buildLiberoPublicPreflightCloseout(cleanEvidence({
      lanes: [
        { worker: 'bangtong', status: 'succeeded', prUrl: URLS.bangtong },
        { worker: 'sogyo', status: 'running' },
        { worker: 'nosuk', status: 'succeeded', doneCommentUrl: URLS.nosuk },
      ],
    }));

    assert.equal(report.ok, false);
    assert.equal(report.state, 'waiting');
    assert.equal(report.lanes.find((lane) => lane.workerId === 'sogyo')?.state, 'waiting');
    assert.match(renderLiberoPublicPreflightCloseoutMarkdown(report), /^Waiting:/);
  });

  it('blocks when approval is not separated from visibility execution', () => {
    const report = buildLiberoPublicPreflightCloseout(cleanEvidence({
      approval: { operatorApprovalSeparated: true, visibilityExecutionSeparated: false },
    }));

    assert.equal(report.ok, false);
    assert.equal(report.state, 'blocked');
    assert.match(report.blockers.join('\n'), /approval is not explicitly separated/);
  });
});

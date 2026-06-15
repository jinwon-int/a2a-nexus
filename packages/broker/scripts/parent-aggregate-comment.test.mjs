import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MARKER,
  buildParentAggregateMarkdown,
  findManagedComment,
  upsertManagedIssueComment,
  upsertManagedIssueCommentGuarded,
} from './parent-aggregate-comment.mjs';

function taskReport(overrides = {}) {
  return {
    generatedAt: '2026-05-05T17:01:00.000Z',
    total: 2,
    active: 1,
    terminal: 1,
    stale: 1,
    reportable: 2,
    allTerminal: false,
    items: [
      { taskId: 'task-1', status: 'succeeded', final: true, stale: false, reportable: true, reportLine: '완료: dungae / #369 — https://github.com/jinwon-int/a2a-broker/pull/370' },
      { taskId: 'task-2', status: 'running', final: false, stale: true, reportable: true, reportLine: '중간보고 필요: nosuk / #371 — running 상태 20m 동안 갱신 없음' },
    ],
    ...overrides,
  };
}

function mockGithub(initialComments = []) {
  const calls = [];
  const comments = [...initialComments];
  return {
    calls,
    listIssueComments(repo, issue) {
      calls.push(['list', repo, issue]);
      return comments;
    },
    createIssueComment(repo, issue, body) {
      calls.push(['create', repo, issue, body]);
      return { id: 42, html_url: `https://github.com/${repo}/issues/${issue}#issuecomment-42` };
    },
    updateIssueComment(repo, id, body) {
      calls.push(['update', repo, id, body]);
      return { id, html_url: `https://github.com/${repo}/issues/comments/${id}` };
    },
  };
}

describe('parent aggregate comment helper', () => {
  it('renders a preview with task-report and closeout markdown without leaking secrets or local paths', () => {
    const markdown = buildParentAggregateMarkdown({
      taskReport: taskReport(),
      closeoutMarkdown: 'Done: closeout\nTOKEN=<fake-token-placeholder>\npath=/work/repo/secret.txt',
      repo: 'jinwon-int/a2a-broker',
      issue: '#364',
    });

    assert.match(markdown, new RegExp(DEFAULT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(markdown, /Parent issue: jinwon-int\/a2a-broker#364/);
    assert.match(markdown, /Tasks: total=2 active=1 terminal=1 stale=1 reportable=2/);
    assert.match(markdown, /완료: dungae \/ #369/);
    assert.match(markdown, /Done: closeout/);
    assert.doesNotMatch(markdown, /fake-token-placeholder/);
    assert.doesNotMatch(markdown, /TOKEN=<fake-token-placeholder>/);
    assert.doesNotMatch(markdown, /\/work\/repo/);
  });

  it('creates one managed parent comment when no marker exists', () => {
    const github = mockGithub([{ id: 1, body: 'unmanaged comment' }]);
    const body = buildParentAggregateMarkdown({ taskReport: taskReport(), repo: 'jinwon-int/a2a-broker', issue: '364' });

    const result = upsertManagedIssueComment({ repo: 'jinwon-int/a2a-broker', issue: '364', body, github });

    assert.equal(result.action, 'created');
    assert.deepEqual(github.calls.map((call) => call[0]), ['list', 'create']);
    assert.equal(github.calls[1][2], '364');
  });

  it('updates the existing managed parent comment instead of creating a duplicate', () => {
    const github = mockGithub([{ id: 99, html_url: 'https://github.com/o/r/issues/1#issuecomment-99', body: `${DEFAULT_MARKER}\nold aggregate` }]);
    const body = buildParentAggregateMarkdown({ taskReport: taskReport({ active: 0, stale: 0, allTerminal: true }), repo: 'jinwon-int/a2a-broker', issue: '364' });

    const result = upsertManagedIssueComment({ repo: 'jinwon-int/a2a-broker', issue: '#364', body, github });

    assert.equal(result.action, 'updated');
    assert.equal(result.id, 99);
    assert.deepEqual(github.calls.map((call) => call[0]), ['list', 'update']);
    assert.equal(github.calls[1][2], 99);
  });

  it('finds managed comments only by the configured marker', () => {
    const managed = { id: 2, body: `${DEFAULT_MARKER}\naggregate` };
    assert.equal(findManagedComment([{ id: 1, body: 'other' }, managed]), managed);
    assert.equal(findManagedComment([{ id: 3, body: 'other' }]), undefined);
  });

  it('fails closed for A2A-required parent comments without finalizer provenance (#555)', async () => {
    const github = mockGithub([{ id: 1, body: 'unmanaged comment' }]);
    const body = buildParentAggregateMarkdown({ taskReport: taskReport(), repo: 'jinwon-int/a2a-nexus', issue: '753' });

    await assert.rejects(
      () => upsertManagedIssueCommentGuarded({
        repo: 'jinwon-int/a2a-nexus',
        issue: '753',
        body,
        github,
        executionPolicyInput: {
          intent: 'a2ad 로 넥서스 레포 오픈 이슈 피알로 구현하고 미머지 피알 검토후 머지하자',
          requestedAction: 'issue_closeout_comment',
        },
      }),
      /a2a_execution_policy_denied: issue_closeout_comment/,
    );
    assert.deepEqual(github.calls, []);
  });

  it('allows A2A-required parent comments only with substantive finalizer provenance (#555)', async () => {
    const github = mockGithub([{ id: 1, body: 'unmanaged comment' }]);
    const body = buildParentAggregateMarkdown({ taskReport: taskReport(), repo: 'jinwon-int/a2a-nexus', issue: '753' });

    const result = await upsertManagedIssueCommentGuarded({
      repo: 'jinwon-int/a2a-nexus',
      issue: '753',
      body,
      github,
      executionPolicyInput: {
        intent: 'a2ad 로 넥서스 레포 오픈 이슈 피알로 구현하고 미머지 피알 검토후 머지하자',
        requestedAction: 'issue_closeout_comment',
        finalizerDecision: {
          finalizerDecisionId: 'fd-753',
          finalizerOwner: 'seoseo',
          parentRoundId: 'a2ad-nexus-open-backlog-20260615T0958Z',
          parentRoundTotal: 9,
          parentRoundOrder: 9,
          brokerOfRecordId: 'seoseo',
          executionLane: 'a2ad',
          allowedActions: ['issue_closeout_comment'],
          workerEvidenceIds: ['bangtong', 'yukson', 'dungae'],
        },
      },
    });

    assert.equal(result.action, 'created');
    assert.deepEqual(github.calls.map((call) => call[0]), ['list', 'create']);
  });

  it('CLI post mode defaults to A2A-required and fails closed without provenance (#555)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'parent-aggregate-comment-'));
    try {
      const reportPath = join(tmp, 'report.json');
      const ghMarker = join(tmp, 'gh-called');
      const fakeGh = join(tmp, 'gh');
      writeFileSync(reportPath, JSON.stringify(taskReport()), 'utf8');
      writeFileSync(fakeGh, `#!/usr/bin/env sh\ntouch ${JSON.stringify(ghMarker)}\nprintf '[]'\n`, { mode: 0o755 });

      assert.throws(
        () => execFileSync(process.execPath, [
          'scripts/parent-aggregate-comment.mjs',
          '--task-report-json', reportPath,
          '--repo', 'jinwon-int/a2a-nexus',
          '--issue', '753',
          '--mode=post',
        ], {
          cwd: process.cwd(),
          env: { ...process.env, PATH: `${tmp}:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
          stdio: 'pipe',
        }),
        /a2a_execution_policy_denied: issue_closeout_comment/,
      );
      assert.equal(existsSync(ghMarker), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

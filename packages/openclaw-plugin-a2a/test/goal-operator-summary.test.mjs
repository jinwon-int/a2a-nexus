import test from 'node:test';
import assert from 'node:assert/strict';

import { buildA2AGoalOperatorSummary } from '../dist/src/goal-operator-summary.js';

const childTasks = [
  {
    brokerTaskId: 'broker-task-1',
    status: 'completed',
    summary: 'Implementation PR opened',
    githubIssueUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/194',
    githubPrUrl: 'https://github.com/jinwon-int/openclaw-plugin-a2a/pull/200',
    artifactUrl: 'https://ci.example/artifacts/200',
    evidenceUrl: 'https://ci.example/runs/200',
  },
];

function build(state, overrides = {}) {
  return buildA2AGoalOperatorSummary({
    goalId: `goal-${state}`,
    title: 'Ship goal-level operator UX',
    state,
    summary: 'Goal is being coordinated across broker child tasks.',
    nextAction: 'Review latest child task evidence.',
    childTasks,
    ...overrides,
  });
}

test('active goal summary is concise and does not infer goal achievement from child success', () => {
  const summary = build('active');

  assert.equal(summary.headline, 'Active goal: Ship goal-level operator UX');
  assert.equal(summary.taskProgress.succeeded, 1);
  assert.equal(summary.taskProgress.total, 1);
  assert.match(summary.taskProgress.note, /child tasks are evidence, not final achievement/);
  assert.equal(summary.childTaskLinks[0].brokerTaskId, 'broker-task-1');
  assert.equal(summary.childTaskLinks[0].githubIssueUrl, 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/194');
  assert.equal(summary.childTaskLinks[0].githubPrUrl, 'https://github.com/jinwon-int/openclaw-plugin-a2a/pull/200');
  assert.equal(summary.childTaskLinks[0].artifactUrl, 'https://ci.example/artifacts/200');
  assert.equal(summary.childTaskLinks[0].evidenceUrl, 'https://ci.example/runs/200');
});

test('paused goal summary names intentional pause separately from task status', () => {
  const summary = build('paused', { stopReason: 'Operator paused before rollout approval.' });

  assert.equal(summary.headline, 'Paused goal: Ship goal-level operator UX');
  assert.equal(summary.stopReason, 'Operator paused before rollout approval.');
  assert.match(summary.taskProgress.note, /does not resume it automatically/);
});

test('blocked goal summary surfaces blocker and keeps task success distinct', () => {
  const summary = build('blocked', { stopReason: 'Needs explicit production restart approval.' });

  assert.equal(summary.headline, 'Blocked goal: Ship goal-level operator UX');
  assert.equal(summary.stopReason, 'Needs explicit production restart approval.');
  assert.match(summary.taskProgress.note, /blocked until/);
});

test('budget_limited goal summary treats budget exhaustion as not success', () => {
  const summary = build('budget_limited', {
    stopReason: 'A2A orchestration budget exhausted.',
    taskSuccessCount: 3,
    taskTotalCount: 4,
  });

  assert.equal(summary.state, 'budget_limited');
  assert.equal(summary.taskProgress.succeeded, 3);
  assert.equal(summary.taskProgress.total, 4);
  assert.match(summary.taskProgress.note, /budget was exhausted; this is not success/);
});

test('goal summary fails loud when visible summary is missing', () => {
  assert.throws(
    () => buildA2AGoalOperatorSummary({
      goalId: 'goal-empty',
      title: 'Empty summary goal',
      state: 'active',
      summary: '   ',
    }),
    /missing goal summary/,
  );
});

test('cross-broker projection-aware summary notes child tasks as evidence, not achievement', () => {
  // Cross-broker projections are bounded terminal evidence; operator-facing
  // wording must not conflate child task success with goal achievement.
  const summary = build('active', {
    title: 'Cross-broker projection-only handling',
    summary: 'Lane 2: cross-broker projection-only verified — parent-owned remote rows, no direct ACK, localBrokerId safety.',
    taskSuccessCount: 2,
    taskTotalCount: 7,
  });

  assert.equal(summary.headline, 'Active goal: Cross-broker projection-only handling');
  assert.equal(summary.taskProgress.succeeded, 2);
  assert.equal(summary.taskProgress.total, 7);
  // Operator must see that child success is not final achievement
  assert.match(
    summary.taskProgress.note,
    /child tasks are evidence, not final achievement/,
    'operator-facing note must separate child success from goal achievement for cross-broker projection rounds',
  );
});

test('cross-broker projection with partial task success shows correct ratio', () => {
  // After a cross-broker round with some lanes done, some pending:
  const summary = build('active', {
    title: 'Cross-broker projection-only round',
    summary: '2/7 lanes terminal, 5 pending projection relay.',
    taskSuccessCount: 2,
    taskTotalCount: 7,
    childTasks: [
      {
        brokerTaskId: 'lane-1',
        status: 'succeeded',
        summary: 'Lane 1: projection-only handler',
      },
      {
        brokerTaskId: 'lane-3',
        status: 'running',
        summary: 'Lane 3: in progress',
      },
    ],
  });

  assert.equal(summary.taskProgress.succeeded, 2);
  assert.equal(summary.taskProgress.total, 7);
  assert.ok(
    summary.taskProgress.note.startsWith('2/7'),
    'partial task ratio must be visible in operator summary',
  );
});

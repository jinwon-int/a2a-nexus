import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BrokerError } from "./broker-error.js";
import {
  TASK_LINEAGE_ANOMALY_KIND,
  TASK_LINEAGE_CHILD_KIND,
  TASK_LINEAGE_DEFAULT_LIMIT,
  TASK_LINEAGE_DIAGNOSTICS_KIND,
  TASK_LINEAGE_FILTERS_KIND,
  TASK_LINEAGE_HARD_MAX_DEPTH,
  TASK_LINEAGE_MAX_DIAGNOSTIC_CODES,
  TASK_LINEAGE_NODE_KIND,
  TASK_LINEAGE_PAGE_KIND,
  TASK_LINEAGE_PAGINATION_KIND,
  TASK_LINEAGE_ROUND_HINT_KIND,
  TaskLineageCycleError,
  TaskLineageValidationError,
  buildTaskLineageReadProjection,
  parseTaskLineageAnomalyV1,
  parseTaskLineageChildV1,
  parseTaskLineageChildrenRequestV1,
  parseTaskLineageChildrenV1,
  parseTaskLineageCursorV1,
  parseTaskLineageDiagnosticsV1,
  parseTaskLineageFiltersV1,
  parseTaskLineageLeavesRequestV1,
  parseTaskLineageLeavesV1,
  parseTaskLineageLineageRequestV1,
  parseTaskLineageLineageV1,
  parseTaskLineageNodeV1,
  parseTaskLineagePageV1,
  parseTaskLineagePaginationV1,
  parseTaskLineageRoundCompletenessHintV1,
  type TaskLineageChildrenRequestV1,
  type TaskLineageLeavesRequestV1,
  type TaskLineageLineageRequestV1,
} from "./task-lineage-read.js";
import type { TaskRecord } from "./types.js";

const T0 = "2026-07-28T00:00:00.000Z";

function task(
  id: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id,
    intent: "analyze",
    status: "queued",
    requester: { id: "requester-a", kind: "service", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: { secretPayload: `payload-${id}` },
    message: `message-${id}`,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function childrenRequest(
  anchor: { taskId: string } | { parentRoundId: string },
  limit = TASK_LINEAGE_DEFAULT_LIMIT,
  cursor?: string,
): TaskLineageChildrenRequestV1 {
  return parseTaskLineageChildrenRequestV1({
    ...anchor,
    limit,
    ...(cursor ? { cursor } : {}),
  });
}

function lineageRequest(
  taskId: string,
  maxDepth?: number,
): TaskLineageLineageRequestV1 {
  return parseTaskLineageLineageRequestV1({
    taskId,
    ...(maxDepth === undefined ? {} : { maxDepth }),
  });
}

function leavesRequest(
  input: Record<string, unknown> = {},
): TaskLineageLeavesRequestV1 {
  return parseTaskLineageLeavesRequestV1(input);
}

function validationCode(
  action: () => unknown,
): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof TaskLineageValidationError);
    return error.validationCode;
  }
}

test("task-lineage children type canonical/reference edges, deduplicate dual matches, and detect a reference rejoin", () => {
  const records = [
    task("root"),
    task("branch-a", { parentTaskId: "root" }),
    task("branch-b", { parentTaskId: "root" }),
    task("rejoin", {
      parentTaskId: "branch-b",
      referenceTaskIds: ["branch-a"],
    }),
    task("duplicate-follow-up", {
      parentTaskId: "root",
      referenceTaskIds: ["root", "root"],
      status: "succeeded",
    }),
  ];
  const projection = buildTaskLineageReadProjection(records);

  const rootChildren = projection.children(childrenRequest({ taskId: "root" }));
  assert.deepEqual(
    rootChildren.children.map((child) => child.node.taskId),
    ["branch-a", "branch-b", "duplicate-follow-up"],
  );
  const duplicate = rootChildren.children.find(
    (child) => child.node.taskId === "duplicate-follow-up",
  );
  assert.deepEqual(
    duplicate?.edges,
    ["canonical_parent", "reference"],
    "a child matching both relations is emitted once with both typed edges",
  );
  assert.equal(duplicate?.rejoin, false);

  const referenceChildren = projection.children(
    childrenRequest({ taskId: "branch-a" }),
  );
  assert.equal(referenceChildren.children.length, 1);
  assert.equal(referenceChildren.children[0]?.node.taskId, "rejoin");
  assert.deepEqual(referenceChildren.children[0]?.edges, ["reference"]);
  assert.equal(referenceChildren.children[0]?.rejoin, true);
});

test("task-lineage children fail closed for an unknown round anchor", () => {
  const projection = buildTaskLineageReadProjection([task("visible")]);
  const failureFor = (
    anchor: { taskId: string } | { parentRoundId: string },
  ): BrokerError => {
    try {
      projection.children(childrenRequest(anchor));
    } catch (error) {
      assert.ok(error instanceof BrokerError);
      return error;
    }
    assert.fail("expected missing anchor to fail closed");
  };

  const missingTask = failureFor({ taskId: "missing-task" });
  const missingRound = failureFor({ parentRoundId: "missing-round" });
  assert.deepEqual(
    {
      code: missingRound.code,
      message: missingRound.message,
      details: missingRound.details,
    },
    {
      code: missingTask.code,
      message: missingTask.message,
      details: missingTask.details,
    },
  );
  assert.deepEqual(
    {
      code: missingRound.code,
      message: missingRound.message,
      details: missingRound.details,
    },
    {
      code: "not_found",
      message: "task not found",
      details: undefined,
    },
  );
});

test("task-lineage canonical lineage ignores reference parents and preserves orphan semantics", () => {
  const projection = buildTaskLineageReadProjection([
    task("root"),
    task("branch-a", { parentTaskId: "root" }),
    task("branch-b", { parentTaskId: "root" }),
    task("rejoin", {
      parentTaskId: "branch-b",
      referenceTaskIds: ["branch-a"],
    }),
    task("orphan", { parentTaskId: "missing-parent" }),
  ]);

  const rejoin = projection.lineage(lineageRequest("rejoin"));
  assert.deepEqual(
    rejoin.lineage.map((node) => node.taskId),
    ["rejoin", "branch-b", "root"],
  );
  assert.equal(rejoin.rootReached, true);
  assert.equal(rejoin.truncated, false);

  const orphan = projection.lineage(lineageRequest("orphan"));
  assert.equal(orphan.lineage.length, 1);
  assert.equal(orphan.lineage[0]?.parentTaskId, null);
  assert.equal(orphan.lineage[0]?.parentMissing, true);
  assert.equal(orphan.rootReached, false);
  assert.equal(orphan.truncated, false);
  assert.doesNotMatch(JSON.stringify(orphan), /missing-parent/);
});

test("task-lineage canonical cycles fail closed with the structured task_lineage_cycle code", () => {
  const projection = buildTaskLineageReadProjection([
    task("cycle-a", { parentTaskId: "cycle-b" }),
    task("cycle-b", { parentTaskId: "cycle-a" }),
  ]);

  assert.throws(
    () => projection.lineage(lineageRequest("cycle-a")),
    (error: unknown) =>
      error instanceof TaskLineageCycleError
      && error.code === "task_lineage_cycle"
      && error.message === "task lineage cycle detected",
  );
});

test("task-lineage detects a canonical cycle beyond the response depth hard maximum", () => {
  const records: TaskRecord[] = [];
  for (let index = 0; index <= TASK_LINEAGE_HARD_MAX_DEPTH + 2; index += 1) {
    records.push(
      task(`long-${String(index).padStart(3, "0")}`, {
        parentTaskId:
          index === TASK_LINEAGE_HARD_MAX_DEPTH + 2
            ? "long-001"
            : `long-${String(index + 1).padStart(3, "0")}`,
      }),
    );
  }
  const projection = buildTaskLineageReadProjection(records);
  assert.throws(
    () => projection.lineage(lineageRequest("long-000")),
    (error: unknown) =>
      error instanceof TaskLineageCycleError
      && error.code === "task_lineage_cycle",
  );
});

test("task-lineage lineage depth is bounded and reports truncation without re-rooting", () => {
  const projection = buildTaskLineageReadProjection([
    task("root"),
    task("middle", { parentTaskId: "root" }),
    task("leaf", { parentTaskId: "middle" }),
  ]);

  const result = projection.lineage(lineageRequest("leaf", 1));
  assert.deepEqual(
    result.lineage.map((node) => [node.taskId, node.depth]),
    [
      ["leaf", 0],
      ["middle", 1],
    ],
  );
  assert.equal(result.truncated, true);
  assert.equal(result.rootReached, false);
});

test("task-lineage leaves use canonical and reference children and AND-combine all filters", () => {
  const projection = buildTaskLineageReadProjection([
    task("root", {
      parentRoundId: "round-1",
      status: "succeeded",
      createdAt: "2026-07-28T00:00:00.000Z",
    }),
    task("canonical-child", {
      parentTaskId: "root",
      parentRoundId: "round-1",
      status: "succeeded",
      createdAt: "2026-07-28T00:01:00.000Z",
    }),
    task("reference-target", {
      parentRoundId: "round-1",
      status: "succeeded",
      createdAt: "2026-07-28T00:02:00.000Z",
    }),
    task("reference-child", {
      parentTaskId: "canonical-child",
      referenceTaskIds: ["reference-target"],
      parentRoundId: "round-1",
      status: "failed",
      createdAt: "2026-07-28T00:03:00.000Z",
    }),
    task("other-round", {
      parentRoundId: "round-2",
      status: "succeeded",
      createdAt: "2026-07-28T00:02:00.000Z",
    }),
  ]);

  const result = projection.leaves(
    leavesRequest({
      parentRoundId: "round-1",
      intent: "analyze",
      status: ["failed", "succeeded"],
      since: "2026-07-28T00:01:00Z",
      until: "2026-07-28T00:03:00Z",
    }),
  );
  assert.deepEqual(
    result.leaves.map((node) => node.taskId),
    ["reference-child"],
    "a task referenced by any visible child is not a leaf",
  );
});

test("task-lineage pagination is stable for equal createdAt, opaque, deterministic, and query-bound", () => {
  const projection = buildTaskLineageReadProjection([
    task("task-c", {
      parentRoundId: "round-1",
      payload: { secret: "must-not-enter-cursor" },
    }),
    task("task-a"),
    task("task-b"),
  ]);
  const first = projection.leaves(leavesRequest({ limit: 2 }));
  assert.deepEqual(
    first.leaves.map((node) => node.taskId),
    ["task-a", "task-b"],
  );
  assert.ok(first.page.nextCursor);
  assert.doesNotMatch(first.page.nextCursor, /task-b|must-not-enter-cursor/);
  const decoded = parseTaskLineageCursorV1(first.page.nextCursor);
  assert.equal(decoded.createdAt, T0);
  assert.match(decoded.taskIdHash, /^[0-9a-f]{64}$/);

  const repeat = projection.leaves(leavesRequest({ limit: 2 }));
  assert.equal(repeat.page.nextCursor, first.page.nextCursor);

  const second = projection.leaves(
    leavesRequest({ limit: 2, cursor: first.page.nextCursor }),
  );
  assert.deepEqual(second.leaves.map((node) => node.taskId), ["task-c"]);
  assert.equal(second.page.nextCursor, null);

  assert.equal(
    validationCode(() =>
      projection.leaves(
        leavesRequest({ limit: 1, cursor: first.page.nextCursor }),
      ),
    ),
    "cursor_mismatch",
  );
  assert.equal(
    validationCode(() =>
      projection.children(
        childrenRequest(
          { parentRoundId: "round-1" },
          2,
          first.page.nextCursor!,
        ),
      ),
    ),
    "cursor_mismatch",
  );

  const differentProjection = buildTaskLineageReadProjection([
    task("task-a"),
    task("task-c"),
  ]);
  assert.equal(
    validationCode(() =>
      differentProjection.leaves(
        leavesRequest({ limit: 2, cursor: first.page.nextCursor }),
      ),
    ),
    "cursor_position_unavailable",
  );
});

test("task-lineage request parsers fail closed on anchors, fields, dates, statuses, limits, cursors, and depths", () => {
  const invalid: Array<[() => unknown, string]> = [
    [
      () => parseTaskLineageChildrenRequestV1({}),
      "unknown_anchor",
    ],
    [
      () =>
        parseTaskLineageChildrenRequestV1({
          taskId: "task-a",
          parentRoundId: "round-a",
        }),
      "ambiguous_anchor",
    ],
    [
      () =>
        parseTaskLineageChildrenRequestV1({
          taskId: "task-a",
          anchor: "unknown",
        }),
      "unexpected_field",
    ],
    [
      () => parseTaskLineageLeavesRequestV1({ status: ["completed"] }),
      "invalid_enum",
    ],
    [
      () => parseTaskLineageLeavesRequestV1({ status: ["failed", "failed"] }),
      "duplicate_value",
    ],
    [
      () => parseTaskLineageLeavesRequestV1({ since: "July 28" }),
      "invalid_string",
    ],
    [
      () =>
        parseTaskLineageLeavesRequestV1({
          since: "2026-07-29T00:00:00Z",
          until: "2026-07-28T00:00:00Z",
        }),
      "invalid_timestamp",
    ],
    [
      () => parseTaskLineageLeavesRequestV1({ limit: 0 }),
      "invalid_integer",
    ],
    [
      () => parseTaskLineageLeavesRequestV1({ limit: 1_001 }),
      "invalid_integer",
    ],
    [
      () => parseTaskLineageLeavesRequestV1({ cursor: "not-a-cursor" }),
      "invalid_cursor",
    ],
    [
      () => parseTaskLineageLineageRequestV1({ taskId: "task-a", maxDepth: 0 }),
      "invalid_integer",
    ],
    [
      () =>
        parseTaskLineageLineageRequestV1({
          taskId: "task-a",
          maxDepth: TASK_LINEAGE_HARD_MAX_DEPTH + 1,
        }),
      "invalid_integer",
    ],
  ];

  for (const [action, expected] of invalid) {
    assert.equal(validationCode(action), expected);
  }
});

test("task-lineage pagination parser rejects malformed cursor encodings", () => {
  assert.equal(
    validationCode(() =>
      parseTaskLineagePaginationV1({
        kind: TASK_LINEAGE_PAGINATION_KIND,
        limit: TASK_LINEAGE_DEFAULT_LIMIT,
        cursor: "bounded-but-not-a-task-lineage-cursor",
      }),
    ),
    "invalid_cursor",
  );
});

test("task-lineage closed response parsers reject undeclared fields across every v1 record", () => {
  const projection = buildTaskLineageReadProjection([
    task("root"),
    task("child", {
      parentTaskId: "root",
      parentRoundId: "round-1",
      parentRoundTotal: 1,
    }),
  ]);
  const children = projection.children(childrenRequest({ taskId: "root" }));
  const lineage = projection.lineage(lineageRequest("child"));
  const leaves = projection.leaves(leavesRequest());
  const node = children.children[0]!.node;
  const child = children.children[0]!;
  const page = children.page;
  const filters = leaves.filters;
  const round = children.round!;
  const diagnostics = children.diagnostics;
  const anomaly = diagnostics.anomalies[0] ?? {
    kind: TASK_LINEAGE_ANOMALY_KIND,
    code: "task_lineage.duplicate_edge",
    count: 1,
  };
  const pagination = {
    kind: TASK_LINEAGE_PAGINATION_KIND,
    limit: 10,
  };

  const cases: Array<[string, (value: unknown) => unknown, unknown]> = [
    ["node", parseTaskLineageNodeV1, node],
    ["child", parseTaskLineageChildV1, child],
    ["page", parseTaskLineagePageV1, page],
    ["pagination", parseTaskLineagePaginationV1, pagination],
    ["filters", parseTaskLineageFiltersV1, filters],
    ["round", parseTaskLineageRoundCompletenessHintV1, round],
    ["anomaly", parseTaskLineageAnomalyV1, anomaly],
    ["diagnostics", parseTaskLineageDiagnosticsV1, diagnostics],
    ["children", parseTaskLineageChildrenV1, children],
    ["lineage", parseTaskLineageLineageV1, lineage],
    ["leaves", parseTaskLineageLeavesV1, leaves],
  ];

  for (const [name, parser, value] of cases) {
    assert.throws(
      () => parser({ ...(value as Record<string, unknown>), undeclared: true }),
      (error: unknown) =>
        error instanceof TaskLineageValidationError
        && error.validationCode === "unexpected_field",
      `${name} must be closed`,
    );
  }
});

test("task-lineage diagnostics are bounded aggregates and never contain task content or unavailable ids", () => {
  const projection = buildTaskLineageReadProjection([
    task("visible", {
      parentTaskId: "secret-parent-id",
      referenceTaskIds: [
        "secret-reference-id",
        "secret-reference-id",
      ],
      payload: { secret: "TOP-SECRET-PAYLOAD" },
      message: "TOP-SECRET-MESSAGE",
    }),
  ]);
  const result = projection.leaves(leavesRequest());
  assert.ok(
    result.diagnostics.anomalies.length <=
      TASK_LINEAGE_MAX_DIAGNOSTIC_CODES,
  );
  assert.deepEqual(
    result.diagnostics.anomalies.map((anomaly) => anomaly.code),
    [
      "task_lineage.duplicate_edge",
      "task_lineage.parent_missing",
      "task_lineage.reference_unavailable",
    ],
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /TOP-SECRET|secret-parent-id|secret-reference-id/,
  );
});

interface RecordedRoundFixture {
  manifest: {
    roundLabel: string;
    lanes: Array<{ workerId: string }>;
  };
  tasks: TaskRecord[];
}

function recordedRoundFixture(name: string): RecordedRoundFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../fixtures/round-coordinator-closeout/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as RecordedRoundFixture;
}

test("task-lineage replays the two recorded round-shaped datasets with completeness hints", () => {
  for (const [fixtureName, expectedComplete] of [
    ["all-complete", true],
    ["mixed-states", false],
  ] as const) {
    const fixture = recordedRoundFixture(fixtureName);
    const stamped = fixture.tasks.map((record) => ({
      ...record,
      parentRoundId: fixture.manifest.roundLabel,
      parentRoundTotal: fixture.manifest.lanes.length,
    }));
    const result = buildTaskLineageReadProjection(stamped).children(
      childrenRequest({ parentRoundId: fixture.manifest.roundLabel }),
    );
    const expectedIds = [...fixture.tasks]
      .sort((left, right) => {
        const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
        return time || left.id.localeCompare(right.id);
      })
      .map((record) => record.id);
    assert.deepEqual(
      result.children.map((child) => child.node.taskId),
      expectedIds,
      fixtureName,
    );
    assert.deepEqual(
      result.children.flatMap((child) => child.edges),
      Array.from({ length: fixture.tasks.length }, () => "round_stamp"),
    );
    assert.equal(result.round?.stampedTotal, fixture.manifest.lanes.length);
    assert.equal(result.round?.observedChildren, fixture.tasks.length);
    assert.equal(result.round?.complete, expectedComplete);
  }
});

test("task-lineage duplicate-follow-up dry-run reports the prior terminal child", () => {
  const projection = buildTaskLineageReadProjection([
    task("dispatch-anchor"),
    task("prior-terminal-follow-up", {
      parentTaskId: "dispatch-anchor",
      status: "succeeded",
    }),
  ]);
  const dryRun = projection.children(
    childrenRequest({ taskId: "dispatch-anchor" }),
  );
  assert.deepEqual(
    dryRun.children.map((child) => ({
      taskId: child.node.taskId,
      status: child.node.status,
      edges: child.edges,
    })),
    [
      {
        taskId: "prior-terminal-follow-up",
        status: "succeeded",
        edges: ["canonical_parent"],
      },
    ],
  );
});

test("task-lineage omits inconsistent round hints and reports only a safe anomaly code", () => {
  const result = buildTaskLineageReadProjection([
    task("child-a", {
      parentRoundId: "round-1",
      parentRoundTotal: 2,
    }),
    task("child-b", {
      parentRoundId: "round-1",
      parentRoundTotal: 3,
    }),
  ]).children(childrenRequest({ parentRoundId: "round-1" }));

  assert.equal(result.round, undefined);
  assert.ok(
    result.diagnostics.anomalies.some(
      (anomaly) =>
        anomaly.code === "task_lineage.round_total_conflict"
        && anomaly.count === 1,
    ),
  );
});

test("task-lineage v1 discriminants remain task-lineage-qualified", () => {
  assert.deepEqual(
    [
      TASK_LINEAGE_NODE_KIND,
      TASK_LINEAGE_CHILD_KIND,
      TASK_LINEAGE_FILTERS_KIND,
      TASK_LINEAGE_PAGE_KIND,
      TASK_LINEAGE_ROUND_HINT_KIND,
      TASK_LINEAGE_ANOMALY_KIND,
      TASK_LINEAGE_DIAGNOSTICS_KIND,
    ].some((kind) => kind.includes("ReviewLineage")),
    false,
  );
});

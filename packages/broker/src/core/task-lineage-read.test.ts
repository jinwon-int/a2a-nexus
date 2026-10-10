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
  arrayAt,
  booleanAt,
  buildTaskLineageReadProjection,
  enumAt,
  exactKeys,
  fail,
  identifierAt,
  integerAt,
  objectAt,
  optionalIdentifierAt,
  stringAt,
  timestampAt,
  uniqueEnumArrayAt,
  parseTaskLineageChildrenRequestV1,
  parseTaskLineageCursorV1,
  parseTaskLineageLeavesRequestV1,
  parseTaskLineageLineageRequestV1,
  type TaskLineageChildrenRequestV1,
  type TaskLineageLeavesRequestV1,
  type TaskLineageLineageRequestV1,
  TASK_LINEAGE_ANOMALY_CODE_SET,
  TASK_LINEAGE_CHILDREN_ANCHOR_KIND,
  TASK_LINEAGE_CHILDREN_KIND,
  TASK_LINEAGE_EDGE_TYPES,
  TASK_LINEAGE_EDGE_TYPE_SET,
  TASK_LINEAGE_INTENT_SET,
  TASK_LINEAGE_LEAVES_KIND,
  TASK_LINEAGE_LINEAGE_KIND,
  TASK_LINEAGE_MAX_CURSOR_LENGTH,
  TASK_LINEAGE_MAX_LIMIT,
  TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE,
  TASK_LINEAGE_STATUSES,
  TASK_LINEAGE_STATUS_SET,
  type TaskLineageAnomalyV1,
  type TaskLineageChildrenAnchorV1,
  type TaskLineageChildrenV1,
  type TaskLineageChildV1,
  type TaskLineageDiagnosticsV1,
  type TaskLineageFiltersV1,
  type TaskLineageLeavesV1,
  type TaskLineageLineageV1,
  type TaskLineageNodeV1,
  type TaskLineagePageV1,
  type TaskLineagePaginationV1,
  type TaskLineageRoundCompletenessHintV1,
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

// ---------------------------------------------------------------------------
// Output-shape validators (#2350 B7). These used to live in task-lineage-read.ts
// and ran on every children/lineage/leaves response to re-validate the object
// the service had just built. No runtime caller consumed them; the round-trip
// test below is their only consumer, so they live with it now. The service
// returns its typed result directly; this suite keeps proving every response
// shape still satisfies the closed contract.
// ---------------------------------------------------------------------------

function parseTaskLineageNodeAt(
  input: unknown,
  path: string,
): TaskLineageNodeV1 {
  const node = objectAt(input, path);
  exactKeys(
    node,
    new Set([
      "kind",
      "taskId",
      "parentTaskId",
      "parentMissing",
      "parentRoundId",
      "referenceTaskIds",
      "intent",
      "status",
      "requesterId",
      "assignedWorkerId",
      "createdAt",
      "depth",
    ]),
    path,
  );
  if (node.kind !== TASK_LINEAGE_NODE_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  const parentTaskId =
    node.parentTaskId === null
      ? null
      : identifierAt(node.parentTaskId, `${path}.parentTaskId`);
  const parentMissing = booleanAt(
    node.parentMissing,
    `${path}.parentMissing`,
  );
  if (parentTaskId !== null && parentMissing) {
    fail("invalid_boolean", `${path}.parentMissing`);
  }
  const referenceTaskIds = arrayAt(
    node.referenceTaskIds,
    `${path}.referenceTaskIds`,
    { max: TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE },
  ).map((value, index) =>
    identifierAt(value, `${path}.referenceTaskIds[${index}]`),
  );
  if (new Set(referenceTaskIds).size !== referenceTaskIds.length) {
    fail("duplicate_value", `${path}.referenceTaskIds`);
  }
  return {
    kind: TASK_LINEAGE_NODE_KIND,
    taskId: identifierAt(node.taskId, `${path}.taskId`),
    parentTaskId,
    parentMissing,
    ...(node.parentRoundId === undefined
      ? {}
      : {
          parentRoundId: identifierAt(
            node.parentRoundId,
            `${path}.parentRoundId`,
          ),
        }),
    referenceTaskIds,
    intent: enumAt(node.intent, TASK_LINEAGE_INTENT_SET, `${path}.intent`),
    status: enumAt(node.status, TASK_LINEAGE_STATUS_SET, `${path}.status`),
    requesterId: identifierAt(node.requesterId, `${path}.requesterId`),
    ...(node.assignedWorkerId === undefined
      ? {}
      : {
          assignedWorkerId: identifierAt(
            node.assignedWorkerId,
            `${path}.assignedWorkerId`,
          ),
        }),
    createdAt: timestampAt(node.createdAt, `${path}.createdAt`),
    depth: integerAt(
      node.depth,
      `${path}.depth`,
      0,
      TASK_LINEAGE_HARD_MAX_DEPTH,
    ),
  };
}

export function parseTaskLineageNodeV1(input: unknown): TaskLineageNodeV1 {
  return parseTaskLineageNodeAt(input, "$");
}

function parseTaskLineageChildAt(
  input: unknown,
  path: string,
): TaskLineageChildV1 {
  const child = objectAt(input, path);
  exactKeys(child, new Set(["kind", "node", "edges", "rejoin"]), path);
  if (child.kind !== TASK_LINEAGE_CHILD_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  return {
    kind: TASK_LINEAGE_CHILD_KIND,
    node: parseTaskLineageNodeAt(child.node, `${path}.node`),
    edges: uniqueEnumArrayAt(
      child.edges,
      TASK_LINEAGE_EDGE_TYPE_SET,
      `${path}.edges`,
      TASK_LINEAGE_EDGE_TYPES.length,
    ),
    rejoin: booleanAt(child.rejoin, `${path}.rejoin`),
  };
}

export function parseTaskLineageChildV1(input: unknown): TaskLineageChildV1 {
  return parseTaskLineageChildAt(input, "$");
}

function parseTaskLineageChildrenAnchorAt(
  input: unknown,
  path: string,
): TaskLineageChildrenAnchorV1 {
  const anchor = objectAt(input, path);
  exactKeys(
    anchor,
    new Set(["kind", "taskId", "parentRoundId"]),
    path,
  );
  if (anchor.kind !== TASK_LINEAGE_CHILDREN_ANCHOR_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  const taskId = optionalIdentifierAt(anchor.taskId, `${path}.taskId`);
  const parentRoundId = optionalIdentifierAt(
    anchor.parentRoundId,
    `${path}.parentRoundId`,
  );
  if (taskId && parentRoundId) fail("ambiguous_anchor", path);
  if (!taskId && !parentRoundId) fail("unknown_anchor", path);
  return taskId
    ? { kind: TASK_LINEAGE_CHILDREN_ANCHOR_KIND, taskId }
    : {
        kind: TASK_LINEAGE_CHILDREN_ANCHOR_KIND,
        parentRoundId: parentRoundId!,
      };
}

function parseTaskLineagePageAt(
  input: unknown,
  path: string,
): TaskLineagePageV1 {
  const page = objectAt(input, path);
  exactKeys(
    page,
    new Set(["kind", "limit", "returned", "nextCursor"]),
    path,
  );
  if (page.kind !== TASK_LINEAGE_PAGE_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  const nextCursor =
    page.nextCursor === null
      ? null
      : stringAt(page.nextCursor, `${path}.nextCursor`, {
          max: TASK_LINEAGE_MAX_CURSOR_LENGTH,
        });
  if (nextCursor !== null) parseTaskLineageCursorV1(nextCursor);
  return {
    kind: TASK_LINEAGE_PAGE_KIND,
    limit: integerAt(page.limit, `${path}.limit`, 1, TASK_LINEAGE_MAX_LIMIT),
    returned: integerAt(
      page.returned,
      `${path}.returned`,
      0,
      TASK_LINEAGE_MAX_LIMIT,
    ),
    nextCursor,
  };
}

export function parseTaskLineagePaginationV1(
  input: unknown,
): TaskLineagePaginationV1 {
  const pagination = objectAt(input, "$");
  exactKeys(pagination, new Set(["kind", "limit", "cursor"]), "$");
  if (pagination.kind !== TASK_LINEAGE_PAGINATION_KIND) {
    fail("invalid_enum", "$.kind");
  }
  const cursor =
    pagination.cursor === undefined
      ? undefined
      : stringAt(pagination.cursor, "$.cursor", {
          max: TASK_LINEAGE_MAX_CURSOR_LENGTH,
        });
  if (cursor !== undefined) parseTaskLineageCursorV1(cursor);
  return {
    kind: TASK_LINEAGE_PAGINATION_KIND,
    limit: integerAt(
      pagination.limit,
      "$.limit",
      1,
      TASK_LINEAGE_MAX_LIMIT,
    ),
    ...(cursor ? { cursor } : {}),
  };
}

export function parseTaskLineagePageV1(input: unknown): TaskLineagePageV1 {
  return parseTaskLineagePageAt(input, "$");
}

function parseTaskLineageFiltersAt(
  input: unknown,
  path: string,
): TaskLineageFiltersV1 {
  const filters = objectAt(input, path);
  exactKeys(
    filters,
    new Set(["kind", "parentRoundId", "intent", "status", "since", "until"]),
    path,
  );
  if (filters.kind !== TASK_LINEAGE_FILTERS_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  const since =
    filters.since === undefined
      ? undefined
      : timestampAt(filters.since, `${path}.since`, true);
  const until =
    filters.until === undefined
      ? undefined
      : timestampAt(filters.until, `${path}.until`, true);
  if (
    since !== undefined
    && until !== undefined
    && Date.parse(since) > Date.parse(until)
  ) {
    fail("invalid_timestamp", `${path}.until`);
  }
  return {
    kind: TASK_LINEAGE_FILTERS_KIND,
    ...(filters.parentRoundId === undefined
      ? {}
      : {
          parentRoundId: identifierAt(
            filters.parentRoundId,
            `${path}.parentRoundId`,
          ),
        }),
    ...(filters.intent === undefined
      ? {}
      : {
          intent: enumAt(
            filters.intent,
            TASK_LINEAGE_INTENT_SET,
            `${path}.intent`,
          ),
        }),
    ...(filters.status === undefined
      ? {}
      : {
          status: uniqueEnumArrayAt(
            filters.status,
            TASK_LINEAGE_STATUS_SET,
            `${path}.status`,
            TASK_LINEAGE_STATUSES.length,
          ).sort(),
        }),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}

export function parseTaskLineageFiltersV1(
  input: unknown,
): TaskLineageFiltersV1 {
  return parseTaskLineageFiltersAt(input, "$");
}

function parseTaskLineageRoundCompletenessHintAt(
  input: unknown,
  path: string,
): TaskLineageRoundCompletenessHintV1 {
  const hint = objectAt(input, path);
  exactKeys(
    hint,
    new Set([
      "kind",
      "parentRoundId",
      "stampedTotal",
      "observedChildren",
      "complete",
    ]),
    path,
  );
  if (hint.kind !== TASK_LINEAGE_ROUND_HINT_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  return {
    kind: TASK_LINEAGE_ROUND_HINT_KIND,
    parentRoundId: identifierAt(
      hint.parentRoundId,
      `${path}.parentRoundId`,
    ),
    stampedTotal: integerAt(
      hint.stampedTotal,
      `${path}.stampedTotal`,
      1,
    ),
    observedChildren: integerAt(
      hint.observedChildren,
      `${path}.observedChildren`,
      0,
    ),
    complete: booleanAt(hint.complete, `${path}.complete`),
  };
}

export function parseTaskLineageRoundCompletenessHintV1(
  input: unknown,
): TaskLineageRoundCompletenessHintV1 {
  return parseTaskLineageRoundCompletenessHintAt(input, "$");
}

function parseTaskLineageAnomalyAt(
  input: unknown,
  path: string,
): TaskLineageAnomalyV1 {
  const anomaly = objectAt(input, path);
  exactKeys(anomaly, new Set(["kind", "code", "count"]), path);
  if (anomaly.kind !== TASK_LINEAGE_ANOMALY_KIND) {
    fail("invalid_enum", `${path}.kind`);
  }
  return {
    kind: TASK_LINEAGE_ANOMALY_KIND,
    code: enumAt(
      anomaly.code,
      TASK_LINEAGE_ANOMALY_CODE_SET,
      `${path}.code`,
    ),
    count: integerAt(anomaly.count, `${path}.count`, 1),
  };
}

export function parseTaskLineageAnomalyV1(
  input: unknown,
): TaskLineageAnomalyV1 {
  return parseTaskLineageAnomalyAt(input, "$");
}

function parseTaskLineageDiagnosticsAt(
  input: unknown,
  path: string,
): TaskLineageDiagnosticsV1 {
  const diagnostics = objectAt(input, path);
  exactKeys(
    diagnostics,
    new Set([
      "kind",
      "source",
      "scannedVisibleTasks",
      "returnedNodes",
      "anomalies",
    ]),
    path,
  );
  if (
    diagnostics.kind !== TASK_LINEAGE_DIAGNOSTICS_KIND
    || diagnostics.source !== "task_record_read_projection"
  ) {
    fail("invalid_enum", `${path}.kind`);
  }
  const anomalies = arrayAt(
    diagnostics.anomalies,
    `${path}.anomalies`,
    { max: TASK_LINEAGE_MAX_DIAGNOSTIC_CODES },
  ).map((value, index) =>
    parseTaskLineageAnomalyAt(value, `${path}.anomalies[${index}]`),
  );
  const codes = anomalies.map((anomaly) => anomaly.code);
  if (new Set(codes).size !== codes.length) {
    fail("duplicate_value", `${path}.anomalies`);
  }
  return {
    kind: TASK_LINEAGE_DIAGNOSTICS_KIND,
    source: "task_record_read_projection",
    scannedVisibleTasks: integerAt(
      diagnostics.scannedVisibleTasks,
      `${path}.scannedVisibleTasks`,
      0,
    ),
    returnedNodes: integerAt(
      diagnostics.returnedNodes,
      `${path}.returnedNodes`,
      0,
      TASK_LINEAGE_MAX_LIMIT + 1,
    ),
    anomalies,
  };
}

export function parseTaskLineageDiagnosticsV1(
  input: unknown,
): TaskLineageDiagnosticsV1 {
  return parseTaskLineageDiagnosticsAt(input, "$");
}

export function parseTaskLineageChildrenV1(
  input: unknown,
): TaskLineageChildrenV1 {
  const result = objectAt(input, "$");
  exactKeys(
    result,
    new Set(["kind", "anchor", "children", "page", "round", "diagnostics"]),
    "$",
  );
  if (result.kind !== TASK_LINEAGE_CHILDREN_KIND) {
    fail("invalid_enum", "$.kind");
  }
  return {
    kind: TASK_LINEAGE_CHILDREN_KIND,
    anchor: parseTaskLineageChildrenAnchorAt(result.anchor, "$.anchor"),
    children: arrayAt(result.children, "$.children", {
      max: TASK_LINEAGE_MAX_LIMIT,
    }).map((value, index) =>
      parseTaskLineageChildAt(value, `$.children[${index}]`),
    ),
    page: parseTaskLineagePageAt(result.page, "$.page"),
    ...(result.round === undefined
      ? {}
      : {
          round: parseTaskLineageRoundCompletenessHintAt(
            result.round,
            "$.round",
          ),
        }),
    diagnostics: parseTaskLineageDiagnosticsAt(
      result.diagnostics,
      "$.diagnostics",
    ),
  };
}

export function parseTaskLineageLineageV1(
  input: unknown,
): TaskLineageLineageV1 {
  const result = objectAt(input, "$");
  exactKeys(
    result,
    new Set([
      "kind",
      "lineage",
      "truncated",
      "rootReached",
      "diagnostics",
    ]),
    "$",
  );
  if (result.kind !== TASK_LINEAGE_LINEAGE_KIND) {
    fail("invalid_enum", "$.kind");
  }
  return {
    kind: TASK_LINEAGE_LINEAGE_KIND,
    lineage: arrayAt(result.lineage, "$.lineage", {
      min: 1,
      max: TASK_LINEAGE_HARD_MAX_DEPTH + 1,
    }).map((value, index) =>
      parseTaskLineageNodeAt(value, `$.lineage[${index}]`),
    ),
    truncated: booleanAt(result.truncated, "$.truncated"),
    rootReached: booleanAt(result.rootReached, "$.rootReached"),
    diagnostics: parseTaskLineageDiagnosticsAt(
      result.diagnostics,
      "$.diagnostics",
    ),
  };
}

export function parseTaskLineageLeavesV1(
  input: unknown,
): TaskLineageLeavesV1 {
  const result = objectAt(input, "$");
  exactKeys(
    result,
    new Set(["kind", "filters", "leaves", "page", "diagnostics"]),
    "$",
  );
  if (result.kind !== TASK_LINEAGE_LEAVES_KIND) {
    fail("invalid_enum", "$.kind");
  }
  return {
    kind: TASK_LINEAGE_LEAVES_KIND,
    filters: parseTaskLineageFiltersAt(result.filters, "$.filters"),
    leaves: arrayAt(result.leaves, "$.leaves", {
      max: TASK_LINEAGE_MAX_LIMIT,
    }).map((value, index) =>
      parseTaskLineageNodeAt(value, `$.leaves[${index}]`),
    ),
    page: parseTaskLineagePageAt(result.page, "$.page"),
    diagnostics: parseTaskLineageDiagnosticsAt(
      result.diagnostics,
      "$.diagnostics",
    ),
  };
}

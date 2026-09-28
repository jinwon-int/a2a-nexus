// #2253 read compatibility: records persisted by a broker that still emitted
// the retired worker-mode lane reasons must keep loading after the upgrade.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryA2ABroker } from "./broker.js";
import { RETIRED_TASK_LANE_REASON_CODES, taskLaneRejudgmentSchema, taskSchema } from "./store-schemas.js";
import { parseSnapshotPayload, serializeBrokerSnapshot } from "./store-snapshot-io.js";
import { TASK_LANE_REASON_CODES } from "../task-lane-classifier.js";
import { validateLaneAssignmentForStats } from "./task-stats.js";
import type { CreateTaskRequest, RegisterWorkerRequest } from "./types.js";

const LEGACY_ASSIGNMENT = {
  version: "fast-lane.v1",
  mode: "shadow",
  decision: "full",
  reasonCodes: ["mode_missing", "worker_mode_missing", "worker_not_persistent"],
} as const;

function snapshotWithLegacyAssignment(): string {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: [], environments: [] },
  } as RegisterWorkerRequest);
  broker.createTask({
    intent: "chat",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    payload: {},
  } as CreateTaskRequest);
  const snapshot = JSON.parse(serializeBrokerSnapshot(broker.exportSnapshot())) as { tasks: Array<Record<string, unknown>> };
  assert.equal(snapshot.tasks.length, 1);
  snapshot.tasks[0]!.laneAssignment = { ...LEGACY_ASSIGNMENT, reasonCodes: [...LEGACY_ASSIGNMENT.reasonCodes] };
  return JSON.stringify(snapshot);
}

describe("#2253 retired lane reason codes stay readable", () => {
  it("a snapshot whose task carries retired codes loads without dropping the task", () => {
    const reloaded = parseSnapshotPayload(snapshotWithLegacyAssignment(), "memory://retired-lane-codes", 10_000_000);
    assert.equal(reloaded.tasks.length, 1);
    assert.deepEqual(reloaded.tasks[0]?.laneAssignment?.reasonCodes, [...LEGACY_ASSIGNMENT.reasonCodes]);
  });

  it("the hot-row task schema accepts the retired codes", () => {
    const snapshot = JSON.parse(snapshotWithLegacyAssignment()) as { tasks: unknown[] };
    assert.equal(taskSchema.safeParse(snapshot.tasks[0]).success, true);
  });

  it("the classifier never emits retired codes and the rejudge schema still rejects them", () => {
    for (const code of RETIRED_TASK_LANE_REASON_CODES) {
      assert.equal((TASK_LANE_REASON_CODES as readonly string[]).includes(code), false, code);
      const rejudge = taskLaneRejudgmentSchema.safeParse({ at: "2026-09-28T00:00:00Z", actorId: "op", from: "full", to: "fast", reasonCode: code });
      assert.equal(rejudge.success, false, `rejudge must reject ${code}`);
    }
  });

  it("an unknown (never-valid) code is still rejected by the persistence schema", () => {
    const snapshot = JSON.parse(snapshotWithLegacyAssignment()) as { tasks: Array<Record<string, unknown>> };
    snapshot.tasks[0]!.laneAssignment = { ...LEGACY_ASSIGNMENT, reasonCodes: ["not_a_real_code"] };
    assert.equal(taskSchema.safeParse(snapshot.tasks[0]).success, false);
  });

  it("the strict task-stats read model counts legacy assignments as invalid, not as a cohort", () => {
    assert.deepEqual(validateLaneAssignmentForStats({ ...LEGACY_ASSIGNMENT, reasonCodes: [...LEGACY_ASSIGNMENT.reasonCodes] }), { state: "invalid" });
  });
});

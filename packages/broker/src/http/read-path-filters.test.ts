import test from "node:test";
import assert from "node:assert/strict";

import {
  auditFiltersFromUrl,
  proposalFiltersFromUrl,
  taskFiltersFromUrl,
  taskIdsFromUrl,
  workerFiltersFromUrl,
} from "./read-path-filters.js";

test("read-path filters normalize task status aliases and bounded limits", () => {
  const filters = taskFiltersFromUrl(new URL("http://broker.local/tasks?status=pending&worker=workeralpha&limit=9999&include=stale_read_path"), {
    defaultLimit: 25,
  });

  assert.equal(filters.status, "queued");
  assert.equal(filters.assignedWorkerId, "workeralpha");
  assert.equal(filters.includeStaleReadPath, true);
  assert.equal(filters.limit, 500);
  assert.equal(filters.exchangeId, undefined);
});

test("read-path filters ignore invalid enum values and trim optional strings", () => {
  const proposal = proposalFiltersFromUrl(new URL("http://broker.local/proposals?status=bogus&kind=patch&sourceNodeId=%20workerbeta%20"));
  const worker = workerFiltersFromUrl(new URL("http://broker.local/workers?role=bogus&environment=research&workspaceId=%20lab%20&providerId=%20xai%20&modelFamily=grok&modelId=grok-4.2&providerAvailability=canary_passed"));
  const audit = auditFiltersFromUrl(new URL("http://broker.local/audit?action=task.claimed&actorId=%20broker%20"));

  assert.deepEqual(proposal, {
    status: undefined,
    sourceNodeId: "workerbeta",
    targetNodeId: undefined,
    kind: "patch",
  });
  assert.deepEqual(worker, {
    role: undefined,
    environment: "research",
    workspaceId: "lab",
  });
  assert.deepEqual(audit, {
    proposalId: undefined,
    actorId: "broker",
    targetId: undefined,
    action: "task.claimed",
  });
});

test("audit filters expose the broker-owned lane assignment action", () => {
  const audit = auditFiltersFromUrl(
    new URL("http://broker.local/audit?action=task.lane_assigned&targetId=task-1"),
  );
  assert.equal(audit.action, "task.lane_assigned");
  assert.equal(audit.targetId, "task-1");
});

test("read-path filters reject invalid explicit task limits", () => {
  assert.throws(
    () => taskFiltersFromUrl(new URL("http://broker.local/tasks?limit=1.5")),
    /limit must be an integer/,
  );
  assert.throws(
    () => taskFiltersFromUrl(new URL("http://broker.local/tasks?limit=-1")),
    /limit must be a non-negative number/,
  );
});

test("read-path task id parser merges repeated and csv query params", () => {
  const ids = taskIdsFromUrl(new URL("http://broker.local/tasks/diagnostics?task_id=a,b&task_id=b&task_ids=c,%20d,,a"));

  assert.deepEqual(ids, ["a", "b", "c", "d"]);
});

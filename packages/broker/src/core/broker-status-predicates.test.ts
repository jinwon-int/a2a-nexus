import assert from "node:assert/strict";
import test from "node:test";

import {
  SETTLED_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  isSettledTaskStatus,
  isTerminalTaskStatus,
} from "./broker-status-predicates.js";
import type { TaskStatus } from "./types.js";

// Exhaustive over TaskStatus: adding a status without classifying it here is a
// compile error.
const EXPECTED: Record<TaskStatus, { terminal: boolean; settled: boolean }> = {
  blocked: { terminal: false, settled: true },
  queued: { terminal: false, settled: false },
  claimed: { terminal: false, settled: false },
  running: { terminal: false, settled: false },
  succeeded: { terminal: true, settled: true },
  failed: { terminal: true, settled: true },
  canceled: { terminal: true, settled: true },
};

test("TERMINAL_TASK_STATUSES is exactly succeeded, failed, canceled", () => {
  assert.deepEqual([...TERMINAL_TASK_STATUSES].sort(), ["canceled", "failed", "succeeded"]);
});

test("SETTLED_TASK_STATUSES is the terminal set plus approval-pending blocked", () => {
  assert.deepEqual([...SETTLED_TASK_STATUSES].sort(), ["blocked", "canceled", "failed", "succeeded"]);
  for (const status of TERMINAL_TASK_STATUSES) assert.ok(SETTLED_TASK_STATUSES.has(status), status);
});

test("isTerminalTaskStatus and isSettledTaskStatus classify every TaskStatus", () => {
  for (const [status, expected] of Object.entries(EXPECTED) as [TaskStatus, { terminal: boolean; settled: boolean }][]) {
    assert.equal(isTerminalTaskStatus(status), expected.terminal, `terminal(${status})`);
    assert.equal(isSettledTaskStatus(status), expected.settled, `settled(${status})`);
  }
});

test("blocked is settled but not terminal", () => {
  assert.equal(isTerminalTaskStatus("blocked"), false);
  assert.equal(isSettledTaskStatus("blocked"), true);
});

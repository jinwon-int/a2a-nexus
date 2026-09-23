// Canonical terminal-status consistency guards (issue #2239).
//
// `TERMINAL_TASK_STATUSES` (succeeded/failed/canceled) is the single source of
// truth for "the task lifecycle has ended"; `SETTLED_TASK_STATUSES` extends it
// with `blocked` for reporting/closeout sites that treat a parked lane as
// settled for its current exchange leg. These tests pin the canonical
// vocabulary, keep the `TaskStatus` union aligned with the runtime sets, and
// force every inline `["succeeded", "failed", "canceled"]` literal outside the
// canonical definition to be consciously reviewed and allowlisted.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { SETTLED_TASK_STATUSES, TERMINAL_TASK_STATUSES } from "./types.js";
import type { TaskStatus } from "./types.js";
import { isSettledTaskStatus, isTerminalTaskStatus } from "./broker-status-predicates.js";
import { WAVE_PLAN_DAG_V2_BOUND_TASK_TERMINAL_STATUSES } from "../wave-plan-dag-v2/stage-task-binding.js";

// Test sources run with the broker package root as the working directory
// (same convention as src/config-env-alignment.test.ts).
const BROKER_ROOT = process.cwd();

function readBrokerSource(relativePath: string): string {
  return readFileSync(join(BROKER_ROOT, relativePath), "utf8");
}

test("canonical terminal and settled status sets are pinned", () => {
  assert.deepEqual([...TERMINAL_TASK_STATUSES], ["succeeded", "failed", "canceled"]);
  assert.deepEqual([...SETTLED_TASK_STATUSES], ["succeeded", "failed", "canceled", "blocked"]);
  // SETTLED must remain a strict extension of the terminal vocabulary.
  assert.deepEqual(
    SETTLED_TASK_STATUSES.slice(0, TERMINAL_TASK_STATUSES.length),
    TERMINAL_TASK_STATUSES,
  );
});

test("status predicates partition the TaskStatus vocabulary", () => {
  const terminal: TaskStatus[] = ["succeeded", "failed", "canceled"];
  const parked: TaskStatus[] = ["blocked"];
  const inFlight: TaskStatus[] = ["queued", "claimed", "running"];

  for (const status of terminal) {
    assert.equal(isTerminalTaskStatus(status), true, `isTerminalTaskStatus(${status})`);
    assert.equal(isSettledTaskStatus(status), true, `isSettledTaskStatus(${status})`);
  }
  for (const status of parked) {
    // `blocked` is parked awaiting operator approval: settled for reporting,
    // but never lifecycle-terminal.
    assert.equal(isTerminalTaskStatus(status), false, `isTerminalTaskStatus(${status})`);
    assert.equal(isSettledTaskStatus(status), true, `isSettledTaskStatus(${status})`);
  }
  for (const status of inFlight) {
    assert.equal(isTerminalTaskStatus(status), false, `isTerminalTaskStatus(${status})`);
    assert.equal(isSettledTaskStatus(status), false, `isSettledTaskStatus(${status})`);
  }
});

test("TaskStatus union literals stay aligned with the canonical runtime sets", () => {
  const source = readBrokerSource(join("src", "core", "types.ts"));
  const unionMatch = source.match(/export type TaskStatus =([\s\S]*?);/);
  assert.ok(unionMatch, "TaskStatus union declaration not found in src/core/types.ts");
  const literals = [...new Set([...unionMatch[1]!.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!))];
  // The lifecycle vocabulary is frozen: the settled set plus the in-flight
  // statuses, and nothing else.
  assert.deepEqual(
    literals.sort(),
    [...SETTLED_TASK_STATUSES, "queued", "claimed", "running"].sort(),
  );
});

const TERMINAL_TRIPLE = /\[\s*"succeeded"\s*,\s*"failed"\s*,\s*"canceled"\s*,?\s*\]/;

/**
 * Reviewed inline sites for a `["succeeded", "failed", "canceled"]` literal.
 * Each entry records why the site does not simply import
 * {@link TERMINAL_TASK_STATUSES}; any new site matching the triple must be
 * added here (or converted to the canonical import) on purpose.
 */
const ALLOWED_TERMINAL_TRIPLE_SITES: Record<string, string> = {
  "src/core/types.ts": "canonical definition of TERMINAL_TASK_STATUSES itself",
  "src/core/task-event-stream.ts":
    "NOTIFIABLE_TERMINAL_STATUSES gates newly minted outbox events; `blocked` must not be newly minted (legacy persisted rows still admit it via TerminalTaskEventStatus)",
  "src/core/terminal-event-outbox.ts":
    "TERMINAL_TASK_EVENT_KINDS is a TaskStatusEvent kind set (event vocabulary), not a task-status gate",
  "src/wave-plan-dag-v2/stage-task-binding.ts":
    "\u00a74.2 spec-scoped closed vocabulary, deliberately re-declared as plain strings; runtime drift against the canonical set is asserted separately below",
};

function listNonTestSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listNonTestSourceFiles(child));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(child);
    }
  }
  return files;
}

test("inline terminal-status triples only exist at reviewed sites", () => {
  const hits = new Map<string, number>();
  for (const absolutePath of listNonTestSourceFiles(join(BROKER_ROOT, "src"))) {
    const repoPath = relative(BROKER_ROOT, absolutePath).split("\\").join("/");
    const content = readFileSync(absolutePath, "utf8");
    const count = [...content.matchAll(new RegExp(TERMINAL_TRIPLE.source, "g"))].length;
    if (count > 0) hits.set(repoPath, count);
  }

  const unknown = [...hits.keys()].filter((repoPath) => !(repoPath in ALLOWED_TERMINAL_TRIPLE_SITES));
  assert.deepEqual(
    unknown,
    [],
    `unreviewed inline terminal-status triple(s): ${unknown.join(", ")}`,
  );

  const stale = Object.keys(ALLOWED_TERMINAL_TRIPLE_SITES).filter((repoPath) => !hits.has(repoPath));
  assert.deepEqual(
    stale,
    [],
    `allowlisted site(s) no longer contain the terminal triple: ${stale.join(", ")}`,
  );
});

test("wave-plan-dag-v2 spec terminal vocabulary tracks the canonical set", () => {
  // The DAG v2 module re-declares its \u00a74.2 vocabulary as spec-frozen strings
  // on purpose; this only alarms if the two ever drift apart.
  assert.deepEqual([...WAVE_PLAN_DAG_V2_BOUND_TASK_TERMINAL_STATUSES], [...TERMINAL_TASK_STATUSES]);
});

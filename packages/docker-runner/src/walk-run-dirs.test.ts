// #2083 item 2: the shared run-directory walker. Every consumer
// (scanHistory / readinessScan / cleanup) sees each run's run.json parsed
// exactly once, plus non-directory entries and unreadable roots as explicit
// classifications instead of silent skips.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { walkRunDirs } from "./scanner.js";

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "a2a-walk-"));
  // well-formed task root with two runs
  await mkdir(join(root, "task-a", "run-1"), { recursive: true });
  await writeFile(
    join(root, "task-a", "run-1", "run.json"),
    JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", exitCode: 0 }),
  );
  await mkdir(join(root, "task-a", "run-2"), { recursive: true });
  await writeFile(join(root, "task-a", "run-2", "run.json"), "{not-json");
  // strays at the task-root level
  await writeFile(join(root, "task-a", "loose-file.txt"), "x");
  // empty task root
  await mkdir(join(root, "task-b"), { recursive: true });
  // non-directory entry at the root level
  await writeFile(join(root, "root-file.txt"), "x");
  return root;
}

test("walkRunDirs parses run.json once and classifies strays explicitly", async () => {
  const root = await makeFixture();
  const roots: Array<{ name: string; isDirectory: boolean; entries: Array<{ name: string; isDirectory: boolean; runMeta: unknown }> | undefined }> = [];
  for await (const walked of walkRunDirs(root)) {
    roots.push({
      name: walked.name,
      isDirectory: walked.isDirectory,
      entries: walked.entries?.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        runMeta: entry.runMeta,
      })),
    });
  }

  const byName = new Map(roots.map((root_) => [root_.name, root_]));
  // Root-level loose files are reported as non-directory task roots.
  const rootFile = byName.get("root-file.txt");
  assert.ok(rootFile);
  assert.equal(rootFile.isDirectory, false);

  const taskA = byName.get("task-a");
  assert.ok(taskA?.entries);
  const runNames = taskA.entries.map((entry) => entry.name);
  assert.deepEqual(runNames, ["loose-file.txt", "run-1", "run-2"]);
  const run1 = taskA.entries.find((entry) => entry.name === "run-1");
  assert.ok(run1?.isDirectory);
  assert.equal((run1.runMeta as { exitCode?: number }).exitCode, 0);
  // A malformed run.json surfaces as undefined — the readiness "malformed"
  // classification uses exactly this signal.
  const run2 = taskA.entries.find((entry) => entry.name === "run-2");
  assert.equal(run2?.runMeta, undefined);
  const loose = taskA.entries.find((entry) => entry.name === "loose-file.txt");
  assert.equal(loose?.isDirectory, false);

  const taskB = byName.get("task-b");
  assert.ok(taskB?.entries);
  assert.equal(taskB.entries.length, 0);
});

test("scanner outputs are unchanged versus a hand-built fixture (walker parity)", async () => {
  const { scanHistory } = await import("./scanner.js");
  const root = await makeFixture();
  const profile = await scanHistory({ rootDir: root });

  assert.equal(profile.totalRunDirs, 2, "only directories under task roots count as runs");
  assert.deepEqual(
    profile.runs.map((run) => run.runToken).sort(),
    ["run-1", "run-2"],
  );
  // run-1's run.json is valid with a createdAt; the entry carries it.
  const run1 = profile.runs.find((run) => run.runToken === "run-1");
  assert.equal(run1?.createdAt, "2026-01-01T00:00:00.000Z");
  const run2 = profile.runs.find((run) => run.runToken === "run-2");
  assert.equal(run2?.createdAt, "unknown", "malformed run.json falls back to the unknown label");

  // The fixture file is still readable (no destructive behavior from scan).
  await readFile(join(root, "task-a", "loose-file.txt"), "utf8");
});

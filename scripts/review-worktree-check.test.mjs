import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, dependenciesInstalled } from "./review-worktree-check.mjs";

test("review:check defaults to the broker workspace with install enabled", () => {
  assert.deepEqual(parseArgs([]), { workspaces: ["a2a-broker"], install: true });
});

test("review:check accepts repeated --workspace and --no-install", () => {
  assert.deepEqual(parseArgs(["--workspace", "a2a-broker", "-w", "a2a-docker-runner", "--no-install"]), {
    workspaces: ["a2a-broker", "a2a-docker-runner"],
    install: false,
  });
});

test("review:check rejects unknown arguments and dangling --workspace", () => {
  assert.throws(() => parseArgs(["--frobnicate"]), /unknown argument/);
  assert.throws(() => parseArgs(["--workspace"]), /requires a value/);
});

test("dependency detection requires @types/node, not just node_modules", () => {
  const empty = mkdtempSync(join(tmpdir(), "review-check-"));
  assert.equal(dependenciesInstalled(empty), false, "no node_modules at all");

  mkdirSync(join(empty, "node_modules"));
  assert.equal(
    dependenciesInstalled(empty),
    false,
    "bare node_modules without @types/node still produces the misleading tsc failure",
  );

  mkdirSync(join(empty, "node_modules", "@types", "node"), { recursive: true });
  assert.equal(dependenciesInstalled(empty), true);
});

test("release-gate inventory wires this suite so it cannot orphan again", async () => {
  // a2a-nexus#1832: this suite passed standalone but ran nowhere. The
  // inventory step is the only runner; pin the wiring from inside.
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const inventory = JSON.parse(
    await readFile(join(repoRoot, "docs", "ops", "release-gate-step-inventory.json"), "utf8"),
  );
  const entry = inventory.entries.find((step) =>
    step.args?.includes("scripts/review-worktree-check.test.mjs"),
  );
  assert.ok(entry, "release-gate inventory must run scripts/review-worktree-check.test.mjs");
  assert.equal(entry.command, "node");
  assert.ok(
    ["core", "public-readiness"].includes(entry.tier),
    "the step must run on the default release-gate path",
  );
});

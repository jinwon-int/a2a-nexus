import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

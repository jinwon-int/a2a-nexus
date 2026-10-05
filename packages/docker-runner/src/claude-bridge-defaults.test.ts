import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLAUDE_TURN_BUDGET_DEFAULTS, projectClaudeCodeTurnBudgets } from "./config.js";
import {
  CLAUDE_BRIDGE_TURN_DEFAULTS_READER,
  checkClaudeBridgeDefaults,
  checkGitHubPatchReadiness,
  compareClaudeBridgeTurnDefaults,
  parseClaudeBridgeTurnDefaults,
} from "./ops.js";
import type { RunnerConfig } from "./types.js";

/**
 * a2a-nexus#2320: the claude runner image bakes its own copy of the patch
 * bridge. An image built from older code silently runs older turn defaults
 * (cf2c218 image: analysis 10 / agentic-patch 40 while main said 80), and the
 * doctor turnBudgets projection — computed from runner source — cannot show it.
 */

const SOURCE_BRIDGE = new URL("../../broker/scripts/claude-a2a-patch-bridge.mjs", import.meta.url);
// The literal exactly as baked into a2a-docker-runner-claude:cf2c218-claude-2.1.280.
const CF2C218_LITERAL = 'const CLAUDE_TURN_BUDGET_DEFAULTS = { analysis: 10, "agentic-patch": 40, "deterministic-single-shot": 6, "fanout-patch": 40 };\n';

function readDefaultsFromFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "a2a-bridge-defaults-"));
  try {
    const file = join(dir, "bridge.mjs");
    writeFileSync(file, contents);
    // Same embedding as the in-image probe: the program is a single-quoted sh argument.
    const result = spawnSync("sh", ["-c", `node -e '${CLAUDE_BRIDGE_TURN_DEFAULTS_READER}' "$1"`, "sh", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function claudeConfig(env: NodeJS.ProcessEnv = {}): RunnerConfig {
  return {
    rootDir: "/tmp/a2a-runner-test",
    image: "a2a-docker-runner-claude:test",
    defaultTimeoutMs: 1000,
    commandProfile: "claude-code",
    commandScript: "#!/usr/bin/env bash\nnode /opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs\n",
    claudeCodeProfile: { configDir: "/srv/claude-profile", turnBudgets: projectClaudeCodeTurnBudgets(env) },
    containedSubagents: { enabled: false, maxCount: 0, outputBytes: 12000, reasons: [], roles: [] },
  } as RunnerConfig;
}

function probe(bridgeTurnDefaults: string | undefined, bridgeExists = true) {
  return () => ({
    cliOnPath: true,
    cliPath: "/usr/local/bin/claude",
    cliVersionOk: true,
    cliVersion: "2.1.280 (Claude Code)",
    profileMountExists: true,
    expectedMountPath: "/run/secrets/claude-dir",
    bridgeExists,
    bridgePath: "/opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs",
    bridgeSha256: "a".repeat(64),
    bridgeTurnDefaults,
    errors: [],
  });
}

test("the in-image reader has no single quotes, so it survives sh single-quote embedding", () => {
  assert.ok(!CLAUDE_BRIDGE_TURN_DEFAULTS_READER.includes("'"));
});

test("the reader parses the current source bridge and agrees with the runner defaults", () => {
  const raw = readDefaultsFromFile(readFileSync(SOURCE_BRIDGE, "utf8"));
  const parsed = parseClaudeBridgeTurnDefaults(raw);
  assert.deepEqual(parsed, {
    analysis: CLAUDE_TURN_BUDGET_DEFAULTS.analysis,
    "agentic-patch": CLAUDE_TURN_BUDGET_DEFAULTS.agenticPatch,
    "deterministic-single-shot": CLAUDE_TURN_BUDGET_DEFAULTS.deterministicSingleShot,
    "fanout-patch": CLAUDE_TURN_BUDGET_DEFAULTS.fanoutPatch,
  }, "runner CLAUDE_TURN_BUDGET_DEFAULTS must track the bridge source; update both together");
  assert.equal(compareClaudeBridgeTurnDefaults(parsed, projectClaudeCodeTurnBudgets({})).status, "match");
});

test("the reader parses the one-line literal of older images (cf2c218) and the comparison flags the drift", () => {
  const raw = readDefaultsFromFile(`// header\n${CF2C218_LITERAL}const other = { a: 1 };\n`);
  assert.equal(raw, "analysis:10,agentic-patch:40,deterministic-single-shot:6,fanout-patch:40");
  const comparison = compareClaudeBridgeTurnDefaults(parseClaudeBridgeTurnDefaults(raw), projectClaudeCodeTurnBudgets({}));
  assert.equal(comparison.status, "drift");
  assert.deepEqual(comparison.drift, [
    { mode: "analysis", image: 10, runner: 80, effective: true },
    { mode: "agentic-patch", image: 40, runner: 80, effective: true },
  ]);
});

test("explicit env overrides mask a drift: still reported, marked not effective", () => {
  const masked = compareClaudeBridgeTurnDefaults(
    parseClaudeBridgeTurnDefaults("analysis:10,agentic-patch:40,deterministic-single-shot:6,fanout-patch:40"),
    projectClaudeCodeTurnBudgets({ A2A_CLAUDE_CODE_MAX_TURNS: "80" }),
  );
  assert.equal(masked.status, "drift");
  assert.deepEqual(masked.drift.map((entry) => [entry.mode, entry.effective]), [["analysis", false], ["agentic-patch", false]]);
});

test("unreadable or garbage probe output is unknown, not a match", () => {
  assert.equal(parseClaudeBridgeTurnDefaults(undefined), null);
  assert.equal(parseClaudeBridgeTurnDefaults(""), null);
  assert.equal(parseClaudeBridgeTurnDefaults("rm -rf /,unknown-mode:5,analysis:abc"), null);
  assert.equal(readDefaultsFromFile("export const nothing = 1;\n"), "");
  assert.equal(compareClaudeBridgeTurnDefaults(null, undefined).status, "unknown");
  // A missing mode in the image is drift, not silently ignored.
  const partial = compareClaudeBridgeTurnDefaults(parseClaudeBridgeTurnDefaults("analysis:80,agentic-patch:80"), undefined);
  assert.equal(partial.status, "drift");
  assert.deepEqual(partial.drift.map((entry) => [entry.mode, entry.image]), [["deterministic-single-shot", null], ["fanout-patch", null]]);
});

test("doctor: githubPatch stays ok on drift; claudeBridgeDefaults warns with the drifted modes", () => {
  const config = claudeConfig();
  const githubPatch = checkGitHubPatchReadiness(config, {
    claudeCodeProfileProbe: probe("analysis:10,agentic-patch:40,deterministic-single-shot:6,fanout-patch:40"),
  });
  assert.equal(githubPatch.status, "ok", "fan-out gates on githubPatch.status; drift must not flip it");
  assert.equal((githubPatch.detail as Record<string, unknown>).bridgeSha256, "a".repeat(64));

  const check = checkClaudeBridgeDefaults(config, githubPatch);
  assert.equal(check?.status, "warn");
  assert.match(check!.message, /analysis image=10 runner=80, agentic-patch image=40 runner=80/);
  assert.match(check!.message, /tasks use the image values/);
});

test("doctor: matching defaults are ok; masked drift and unreadable defaults warn; non-claude profiles skip the check", () => {
  const matching = claudeConfig();
  const ok = checkClaudeBridgeDefaults(matching, checkGitHubPatchReadiness(matching, {
    claudeCodeProfileProbe: probe("analysis:80,agentic-patch:80,deterministic-single-shot:6,fanout-patch:40"),
  }));
  assert.equal(ok?.status, "ok");

  const overridden = claudeConfig({ A2A_CLAUDE_CODE_MAX_TURNS: "80" });
  const masked = checkClaudeBridgeDefaults(overridden, checkGitHubPatchReadiness(overridden, {
    claudeCodeProfileProbe: probe("analysis:10,agentic-patch:40,deterministic-single-shot:6,fanout-patch:40"),
  }));
  assert.equal(masked?.status, "warn");
  assert.match(masked!.message, /masked by explicit env overrides/);

  const unreadable = checkClaudeBridgeDefaults(matching, checkGitHubPatchReadiness(matching, { claudeCodeProfileProbe: probe(undefined) }));
  assert.equal(unreadable?.status, "warn");
  assert.match(unreadable!.message, /could not be read/);

  // Bridge missing: githubPatch already fails; the derived check does not double-report.
  const missing = checkClaudeBridgeDefaults(matching, checkGitHubPatchReadiness(matching, { claudeCodeProfileProbe: probe(undefined, false) }));
  assert.equal(missing?.status, "skip");

  assert.equal(checkClaudeBridgeDefaults({ ...matching, commandProfile: "codex" } as RunnerConfig, { status: "ok", message: "" }), undefined);
});

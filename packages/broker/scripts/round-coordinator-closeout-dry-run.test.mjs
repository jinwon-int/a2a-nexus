/**
 * round-coordinator-closeout-dry-run.test.mjs — Dry-run closeout CLI tests
 *
 * Tests the source-only closeout CLI: fixture loading, manifest extraction,
 * safety validation, enhanced bundle rendering, and edge cases.
 *
 * This test never executes live GitHub actions, deploys, sends, or DB writes.
 */

import { describe, it } from "node:test";
import { equal, ok, deepEqual, rejects, doesNotReject } from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  parseArgs,
  redactSensitiveStrings,
  redactSensitive,
  validateSafety,
  extractManifestAndTasks,
  renderEnhancedCloseoutBundle,
  HELP_TEXT,
} from "./round-coordinator-closeout-dry-run.mjs";

// ---------------------------------------------------------------------------
// Fixture loading (safe: loads from disk, source-only)
// ---------------------------------------------------------------------------

describe("loadFixture (via extractManifestAndTasks)", () => {
  it("loads and parses all-complete fixture correctly", async () => {
    const { loadFixture } = await import("./round-coordinator-closeout-dry-run.mjs");
    const fixture = await loadFixture("fixtures/round-coordinator-closeout/all-complete.json");
    const { manifest, tasks } = extractManifestAndTasks(fixture);

    equal(manifest.roundLabel, "a2a-team1-round-coordinator-20260526T201140KST");
    equal(manifest.lanes.length, 3);
    equal(tasks.length, 3);
  });

  it("loads and parses mixed-states fixture correctly", async () => {
    const { loadFixture } = await import("./round-coordinator-closeout-dry-run.mjs");
    const fixture = await loadFixture("fixtures/round-coordinator-closeout/mixed-states.json");
    const { manifest, tasks } = extractManifestAndTasks(fixture);

    equal(manifest.lanes.length, 4);
    equal(tasks.length, 3);
  });

  it("loads and parses empty-no-tasks fixture correctly", async () => {
    const { loadFixture } = await import("./round-coordinator-closeout-dry-run.mjs");
    const fixture = await loadFixture("fixtures/round-coordinator-closeout/empty-no-tasks.json");
    const { manifest, tasks } = extractManifestAndTasks(fixture);

    equal(manifest.lanes.length, 5);
    equal(tasks.length, 0);
  });

  it("loads and parses timeout-scenario fixture correctly", async () => {
    const { loadFixture } = await import("./round-coordinator-closeout-dry-run.mjs");
    const fixture = await loadFixture("fixtures/round-coordinator-closeout/timeout-scenario.json");
    const { manifest, tasks } = extractManifestAndTasks(fixture);

    equal(manifest.lanes.length, 2);
    equal(tasks.length, 2);
    equal(manifest.timeoutAt, "2026-05-26T20:00:00.000Z");
  });

  it("rejects non-existent fixture file", async () => {
    const { loadFixture } = await import("./round-coordinator-closeout-dry-run.mjs");
    await rejects(
      () => loadFixture("fixtures/round-coordinator-closeout/nonexistent.json"),
      { message: /File not found/ },
    );
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses --input path", () => {
    const args = parseArgs(["--input", "fixture.json"]);
    equal(args.input, "fixture.json");
    equal(args.markdown, true); // default
    equal(args.json, false);
  });

  it("parses --json flag", () => {
    const args = parseArgs(["--input", "f.json", "--json"]);
    equal(args.input, "f.json");
    equal(args.json, true);
    equal(args.markdown, false);
  });

  it("parses --markdown flag", () => {
    const args = parseArgs(["--input", "f.json", "--markdown"]);
    equal(args.markdown, true);
    equal(args.json, false);
  });

  it("parses --now timestamp", () => {
    const args = parseArgs(["--input", "f.json", "--now", "2026-05-28T00:00:00.000Z"]);
    equal(args.now, "2026-05-28T00:00:00.000Z");
  });

  it("parses --validate-only flag", () => {
    const args = parseArgs(["--input", "f.json", "--validate-only"]);
    equal(args.validateOnly, true);
  });

  it("parses --manifest and --tasks", () => {
    const args = parseArgs(["--manifest", "m.json", "--tasks", "t.json"]);
    equal(args.manifest, "m.json");
    equal(args.tasks, "t.json");
  });

  it("parses --help", () => {
    const args = parseArgs(["--help"]);
    equal(args.help, true);
  });

  it("defaults to markdown when neither flag specified", () => {
    const args = parseArgs(["--input", "f.json"]);
    equal(args.markdown, true);
    equal(args.json, false);
  });

  it("handles inline values with = syntax", () => {
    const args = parseArgs(["--input=fixture.json"]);
    equal(args.input, "fixture.json");
  });
});

// ---------------------------------------------------------------------------
// extractManifestAndTasks
// ---------------------------------------------------------------------------

describe("extractManifestAndTasks", () => {
  it("extracts from { manifest, tasks } shape", () => {
    const fixture = {
      manifest: { roundLabel: "test", lanes: [{ workerId: "sogyo" }] },
      tasks: [{ id: "task-1", status: "succeeded" }],
    };
    const { manifest, tasks } = extractManifestAndTasks(fixture);
    equal(manifest.roundLabel, "test");
    equal(tasks.length, 1);
  });

  it("extracts from bare manifest shape", () => {
    const fixture = { roundLabel: "test", lanes: [{ workerId: "sogyo" }], tasks: [{ id: "task-1" }] };
    const { manifest, tasks } = extractManifestAndTasks(fixture);
    equal(manifest.roundLabel, "test");
    equal(tasks.length, 1);
  });

  it("returns empty tasks array when bare manifest has no tasks", () => {
    const fixture = { roundLabel: "test", lanes: [{ workerId: "sogyo" }] };
    const { manifest, tasks } = extractManifestAndTasks(fixture);
    equal(tasks.length, 0);
  });

  it("throws on unrecognized shape", () => {
    const fixture = { unknown: true };
    ok(throws(() => extractManifestAndTasks(fixture)));
  });
});

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

// ---------------------------------------------------------------------------
// validateSafety
// ---------------------------------------------------------------------------

describe("validateSafety", () => {
  it("passes safe fixture with no violations", () => {
    const fixture = { manifest: { roundLabel: "test" }, tasks: [] };
    const errors = validateSafety(fixture);
    equal(errors.length, 0);
  });

  it("blocks _executeAction flag", () => {
    const fixture = { manifest: {}, tasks: [], _executeAction: true };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("_executeAction")));
  });

  it("blocks postComment action", () => {
    const fixture = { manifest: {}, tasks: [], postComment: { body: "test" } };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("postComment")));
  });

  it("blocks closeIssue action", () => {
    const fixture = { manifest: {}, tasks: [], closeIssue: true };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("closeIssue")));
  });

  it("blocks mergePr action", () => {
    const fixture = { manifest: {}, tasks: [], mergePr: true };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("mergePr")));
  });

  it("blocks deploy action", () => {
    const fixture = { manifest: {}, tasks: [], deploy: true };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("deploy")));
  });

  it("blocks liveSend action", () => {
    const fixture = { manifest: {}, tasks: [], liveSend: { channel: "test" } };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("liveSend")));
  });

  it("blocks ackReplay action", () => {
    const fixture = { manifest: {}, tasks: [], ackReplay: true };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("ackReplay")));
  });

  it("blocks dbWrite action", () => {
    const fixture = { manifest: {}, tasks: [], dbWrite: { collection: "test" } };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("dbWrite")));
  });

  it("blocks dbMutate action", () => {
    const fixture = { manifest: {}, tasks: [], dbMutate: { collection: "test" } };
    const errors = validateSafety(fixture);
    ok(errors.some((e) => e.includes("dbMutate")));
  });

  it("passes all actual fixture files with no violations", async () => {
    const { loadFixture } = await import("./round-coordinator-closeout-dry-run.mjs");
    const fixtures = [
      "fixtures/round-coordinator-closeout/all-complete.json",
      "fixtures/round-coordinator-closeout/mixed-states.json",
      "fixtures/round-coordinator-closeout/empty-no-tasks.json",
      "fixtures/round-coordinator-closeout/timeout-scenario.json",
    ];
    for (const path of fixtures) {
      const fixture = await loadFixture(path);
      const errors = validateSafety(fixture);
      equal(errors.length, 0, `Fixture ${path} should have 0 safety violations`);
    }
  });
});

// ---------------------------------------------------------------------------
// redactSensitive
// ---------------------------------------------------------------------------

describe("redactSensitive", () => {
  it("redacts GitHub tokens", () => {
    const token = ['ghp', 'abc123DEF456ghi789jkl'].join('_');
    const result = redactSensitiveStrings(`token ${token}`);
    ok(result.includes("[redacted-token]"));
    ok(!result.includes(token));
  });

  it("redacts TOKEN environment assignments", () => {
    const result = redactSensitiveStrings("TOKEN=super-secret-value");
    ok(result.includes("TOKEN=[redacted]"));
    ok(!result.includes("super-secret-value"));
  });

  it("redacts nested objects recursively", () => {
    const token = ['ghp', 'abc123def456'].join('_');
    const obj = {
      level1: {
        secret: token,
        normal: "hello",
      },
    };
    const cleaned = redactSensitive(obj);
    ok(cleaned.level1.secret.includes("[redacted-token]"));
    equal(cleaned.level1.normal, "hello");
  });

  it("handles arrays", () => {
    const token = ['ghp', 'abc123def456'].join('_');
    const arr = [token, "normal"];
    const cleaned = redactSensitive(arr);
    ok(cleaned[0].includes("[redacted-token]"));
    equal(cleaned[1], "normal");
  });

  it("handles null/undefined", () => {
    equal(redactSensitive(null), null);
    equal(redactSensitive(undefined), undefined);
  });

  it("handles non-object primitives", () => {
    equal(redactSensitive(42), 42);
    equal(redactSensitive("hello"), "hello");
    equal(redactSensitive(true), true);
  });
});

// ---------------------------------------------------------------------------
// renderEnhancedCloseoutBundle
// ---------------------------------------------------------------------------

describe("renderEnhancedCloseoutBundle", () => {
  function makeMockOutput(overrides = {}) {
    return {
      kind: "a2a-broker.round-result-collector.projection",
      version: 1,
      generatedAt: "2026-05-26T12:00:00.000Z",
      roundLabel: "test-round",
      parentIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/934",
      summary: { totalLanes: 3, completed: 3, blocked: 0, stale: 0, timeout: 0, running: 0, pending: 0 },
      lanes: [],
      missingLanes: [],
      staleLanes: [],
      timeoutLanes: [],
      blockedLanes: [],
      closeoutBundle: {
        title: "Finalizer review: test-round",
        body: [
          "## Finalizer review: test-round",
          "",
          "Generated: 2026-05-26T12:00:00.000Z",
          "Parent: https://github.com/jinwon-int/a2a-broker/issues/934",
          "",
          "**3/3 lanes completed.** Ready for finalizer closeout.",
        ].join("\n"),
      },
      approvalSensitiveActionsExcluded: [
        "GitHub comment/post",
        "GitHub close",
        "GitHub merge",
        "Deploy",
        "Live send",
        "Terminal ACK",
        "DB mutation",
      ],
      ...overrides,
    };
  }

  it("includes dry-run header", () => {
    const output = makeMockOutput();
    const enhanced = renderEnhancedCloseoutBundle(output, { markdown: true });
    ok(enhanced.body.includes("Dry-Run Closeout: test-round"));
    ok(enhanced.body.includes("Source-only projection"));
  });

  it("includes safety gates table", () => {
    const output = makeMockOutput();
    const enhanced = renderEnhancedCloseoutBundle(output, { markdown: true });
    ok(enhanced.body.includes("Safety Gates"));
    ok(enhanced.body.includes("GitHub comment/close/merge"));
    ok(enhanced.body.includes("source-only dry-run"));
    ok(enhanced.body.includes("Blocked"));
  });

  it("includes draft-only disclaimer", () => {
    const output = makeMockOutput();
    const enhanced = renderEnhancedCloseoutBundle(output, { markdown: true });
    ok(enhanced.body.includes("draft-only closeout bundle"));
  });
});

// ---------------------------------------------------------------------------
// CLI invocation (subprocess, source-only)
// ---------------------------------------------------------------------------

describe("CLI invocation (subprocess)", () => {
  const script = "scripts/round-coordinator-closeout-dry-run.mjs";
  const fixturesDir = "fixtures/round-coordinator-closeout";

  it("exits 0 with all-complete fixture", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/all-complete.json`, "--json",
    ], { encoding: "utf8", cwd: process.cwd() });
    const output = JSON.parse(stdout);
    equal(output.summary.totalLanes, 3);
    equal(output.summary.completed, 3);
    ok(output.closeoutBundle);
    ok(output.closeoutBundle.body.length > 0);
  });

  it("exits 0 with mixed-states fixture (1/4 completed)", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/mixed-states.json`, "--json",
    ], { encoding: "utf8", cwd: process.cwd() });
    const output = JSON.parse(stdout);
    equal(output.summary.totalLanes, 4);
    equal(output.summary.completed, 1);
    equal(output.summary.blocked, 1);
    ok(output.missingLanes.length > 0);
    ok(output.staleLanes.length > 0);
  });

  it("exits 0 with empty-no-tasks fixture (all pending)", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/empty-no-tasks.json`, "--json",
    ], { encoding: "utf8", cwd: process.cwd() });
    const output = JSON.parse(stdout);
    equal(output.summary.totalLanes, 5);
    equal(output.summary.completed, 0);
    equal(output.summary.pending, 5);
    equal(output.missingLanes.length, 5);
  });

  it("detects timeout when --now is past deadline", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/timeout-scenario.json`,
      "--now", "2026-05-27T00:00:00.000Z", "--json",
    ], { encoding: "utf8", cwd: process.cwd() });
    const output = JSON.parse(stdout);
    equal(output.summary.totalLanes, 2);
    equal(output.summary.completed, 1);
    ok(output.timeoutLanes.includes("nosuk"));
  });

  it("exits 0 with --validate-only flag", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/all-complete.json`, "--validate-only",
    ], { encoding: "utf8", cwd: process.cwd() });
    const parsed = JSON.parse(stdout);
    equal(parsed.valid, true);
    equal(parsed.lanes, 3);
    equal(parsed.tasks, 3);
  });

  it("exits 2 on missing --input", async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("node", [script], { encoding: "utf8", cwd: process.cwd() });
      ok(false, "should have thrown");
    } catch (err) {
      equal(err.status, 2);
    }
  });

  it("exits 1 on non-existent fixture", async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("node", [
        script, "--input", "fixtures/round-coordinator-closeout/nonexistent.json",
      ], { encoding: "utf8", cwd: process.cwd() });
      ok(false, "should have thrown");
    } catch (err) {
      equal(err.status, 1);
    }
  });

  it("exits 0 with --help", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [script, "--help"], { encoding: "utf8", cwd: process.cwd() });
    ok(stdout.includes("round-coordinator-closeout-dry-run"));
  });

  it("(--json) emits sogyo lane with PR evidence in all-complete", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/all-complete.json`, "--json",
    ], { encoding: "utf8", cwd: process.cwd() });
    const output = JSON.parse(stdout);
    const sogyoLane = output.lanes.find((l) => l.workerId === "sogyo");
    ok(sogyoLane);
    ok(sogyoLane.prUrl, "sogyo lane should have prUrl");
    ok(sogyoLane.prUrl.includes("pull/937"));
  });

  it("(--json) includes safety disclaimer", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/all-complete.json`, "--json",
    ], { encoding: "utf8", cwd: process.cwd() });
    const output = JSON.parse(stdout);
    ok(output.approvalSensitiveActionsExcluded.length > 0);
    ok(output.closeoutBundle.body.includes("No comments, closes, merges, deploys"));
  });

  it("(--markdown) output contains safety gates for all-complete", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/all-complete.json`, "--markdown",
    ], { encoding: "utf8", cwd: process.cwd() });
    ok(stdout.includes("Safety Gates"));
    ok(stdout.includes("GitHub comment/close/merge"));
    ok(stdout.includes("draft-only closeout bundle"));
  });

  it("(--markdown) output shows mixed states for mixed-states fixture", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/mixed-states.json`, "--markdown",
    ], { encoding: "utf8", cwd: process.cwd() });
    ok(stdout.includes("🚫")); // blocked
    ok(stdout.includes("⚠️")); // stale
    ok(stdout.includes("⏳")); // pending
    ok(stdout.includes("Blocked lanes"));
    ok(stdout.includes("Stale lanes"));
    ok(stdout.includes("Missing lanes"));
  });

  it("(--markdown) output shows zero completed for empty-no-tasks", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/empty-no-tasks.json`, "--markdown",
    ], { encoding: "utf8", cwd: process.cwd() });
    ok(stdout.includes("0/5 lanes completed"));
  });

  it("(--markdown) with --now past deadline shows timeout", async () => {
    const { execFileSync } = await import("node:child_process");
    const stdout = execFileSync("node", [
      script, "--input", `${fixturesDir}/timeout-scenario.json`,
      "--now", "2026-05-27T00:00:00.000Z", "--markdown",
    ], { encoding: "utf8", cwd: process.cwd() });
    ok(stdout.includes("⏰"));
    ok(stdout.includes("Timeout lanes (1)"));
  });
});

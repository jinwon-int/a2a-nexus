#!/usr/bin/env node
/**
 * Regression tests for the terminal-brief operator surface dispatcher
 * (a2a-nexus#1503 Wave 1). The manifest is the contract: every retired npm
 * alias maps to an existing wrapper, build flags match the historical
 * `npm run build &&` prefix, and the runner preserves passthrough
 * semantics (unknown tool fails closed, --list discovers, exit codes pass
 * through).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "terminal-brief.mjs");
const manifest = JSON.parse(readFileSync(join(HERE, "terminal-brief-manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

test("manifest covers exactly the 59 retired terminal-brief approval tools", () => {
  const names = Object.keys(manifest.tools);
  assert.equal(names.length, 59, `expected 59 tools, got ${names.length}`);
  // Spot-check the three sub-families are all present.
  assert.ok(names.includes("terminal_brief_approval_request"));
  assert.ok(names.includes("terminal_brief_sidecar_dry_run_gate"));
  assert.ok(names.includes("terminal_receipt_gap_matrix"));
});

test("every manifest entry points at an existing wrapper script", () => {
  for (const [name, entry] of Object.entries(manifest.tools)) {
    assert.ok(
      existsSync(join(HERE, entry.script)),
      `${name}: missing script ${entry.script}`,
    );
  }
});

test("build flags match the historical npm alias commands", () => {
  // The no-build set is the handful of wrappers whose npm alias did not
  // prefix `npm run build &&`. Drift here would surprise operators whose
  // runbooks assume a fresh dist.
  const noBuild = Object.entries(manifest.tools)
    .filter(([, e]) => !e.build)
    .map(([n]) => n)
    .sort();
  assert.deepEqual(noBuild, [
    "closeout_release_report",
    "command_center_closeout_checklist",
    "rehearsal_manifest",
    "terminal_brief_activation_report",
    "terminal_receipt_closeout_report",
    "terminal_receipt_gap_matrix",
  ]);
});

test("package.json exposes the single dispatcher entry and none of the retired aliases", () => {
  assert.equal(pkg.scripts.terminal_brief, "node scripts/terminal-brief.mjs");
  for (const name of Object.keys(manifest.tools)) {
    assert.ok(!(name in pkg.scripts), `retired alias still present: ${name}`);
  }
});

test("--list discovers every tool and exits zero", () => {
  const r = spawnSync(process.execPath, [RUNNER, "--list"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const name of Object.keys(manifest.tools)) {
    assert.ok(r.stdout.includes(name), `--list missing ${name}`);
  }
});

test("unknown tool fails closed with exit 2", () => {
  const r = spawnSync(process.execPath, [RUNNER, "terminal_brief_no_such_tool"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown tool/);
});

test("dispatch passes argv, stdio, and the wrapper's exit code through (--no-build)", () => {
  // Wrappers exit non-zero with a usage error when required args are
  // missing — a convenient no-side-effect probe of passthrough semantics.
  const direct = spawnSync(
    process.execPath,
    [join(HERE, "terminal-brief-sidecar-dry-run-gate.mjs")],
    { encoding: "utf8" },
  );
  const viaRunner = spawnSync(
    process.execPath,
    [RUNNER, "--no-build", "terminal_brief_sidecar_dry_run_gate"],
    { encoding: "utf8" },
  );
  assert.equal(viaRunner.status, direct.status);
  assert.equal(viaRunner.stderr, direct.stderr);
});

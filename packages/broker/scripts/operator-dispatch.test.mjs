#!/usr/bin/env node
/**
 * Regression tests for the shared operator dispatcher and the Wave 2
 * family surfaces (a2a-nexus#1503): orchestration.mjs and rollout.mjs,
 * plus the terminal-brief.mjs runner refactored onto the shared lib.
 * Manifests are the contract: every retired alias maps to an existing
 * wrapper, retired aliases are absent from package.json, discovery works,
 * unknown tools fail closed, and dispatch preserves passthrough semantics.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const SURFACES = [
  {
    name: "terminal-brief",
    runner: join(HERE, "terminal-brief.mjs"),
    manifest: join(HERE, "terminal-brief-manifest.json"),
    npmEntry: "terminal_brief",
    // 59 -> 22 (#1665): the 37 terminal_brief_sidecar_* tools retired with the
    // ceremony modules they wrapped. The spot check moved off a sidecar tool for
    // the same reason — it now pins a surviving product-surface tool.
    expectedTools: 22,
    spotTool: "broker_terminal_receipt_parity",
    spotWrapper: "broker-terminal-receipt-parity.mjs",
  },
  {
    name: "orchestration",
    runner: join(HERE, "orchestration.mjs"),
    manifest: join(HERE, "orchestration-manifest.json"),
    npmEntry: "orchestration",
    expectedTools: 21,
    spotTool: "orchestration_intelligence_validation_scorer",
    spotWrapper: "orchestration-intelligence-validation-scorer.mjs",
  },
  {
    name: "rollout",
    runner: join(HERE, "rollout.mjs"),
    manifest: join(HERE, "rollout-preflight-manifest.json"),
    npmEntry: "rollout",
    expectedTools: 22,
    spotTool: "worker_subagent_redaction_gate",
    spotWrapper: "worker-subagent-redaction-gate.mjs",
  },
];

for (const surface of SURFACES) {
  const manifest = JSON.parse(readFileSync(surface.manifest, "utf8"));

  test(`${surface.name}: manifest covers exactly its retired family`, () => {
    const names = Object.keys(manifest.tools);
    assert.equal(names.length, surface.expectedTools, `expected ${surface.expectedTools}, got ${names.length}`);
    assert.ok(names.includes(surface.spotTool));
  });

  test(`${surface.name}: every manifest entry resolves to an existing target`, () => {
    for (const [name, entry] of Object.entries(manifest.tools)) {
      const target = entry.script.startsWith("dist/")
        ? join(HERE, "..", entry.script)
        : join(HERE, entry.script);
      assert.ok(existsSync(target), `${name}: missing ${entry.script} (run npm run build first for dist entries)`);
    }
  });

  test(`${surface.name}: package.json exposes only the dispatcher entry`, () => {
    assert.equal(pkg.scripts[surface.npmEntry], `node scripts/${surface.name}.mjs`);
    for (const name of Object.keys(manifest.tools)) {
      assert.ok(!(name in pkg.scripts), `retired alias still present: ${name}`);
    }
  });

  test(`${surface.name}: --list discovers every tool and exits zero`, () => {
    const r = spawnSync(process.execPath, [surface.runner, "--list"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (const name of Object.keys(manifest.tools)) {
      assert.ok(r.stdout.includes(name), `--list missing ${name}`);
    }
  });

  test(`${surface.name}: unknown tool fails closed with exit 2`, () => {
    const r = spawnSync(process.execPath, [surface.runner, "no_such_tool_xyz"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown tool/);
  });

  test(`${surface.name}: dispatch passes argv and the wrapper's exit code through (--no-build)`, () => {
    const direct = spawnSync(process.execPath, [join(HERE, surface.spotWrapper)], { encoding: "utf8" });
    const viaRunner = spawnSync(
      process.execPath,
      [surface.runner, "--no-build", surface.spotTool],
      { encoding: "utf8" },
    );
    assert.equal(viaRunner.status, direct.status);
    assert.equal(viaRunner.stderr, direct.stderr);
  });
}

test("manifest-required gates stay direct npm scripts, not dispatcher tools", () => {
  const rollout = JSON.parse(readFileSync(join(HERE, "rollout-preflight-manifest.json"), "utf8"));
  for (const kept of ["scan:public-readiness", "rollout_guard", "worker_signature_rollout_preflight"]) {
    assert.ok(kept in pkg.scripts, `${kept} must stay a direct npm script`);
    assert.ok(!(kept in rollout.tools), `${kept} must not be a dispatcher tool`);
  }
});

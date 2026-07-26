#!/usr/bin/env node
/**
 * Regression tests for scripts/core-hotspot-report.mjs (a2a-nexus#1503).
 * Pure functions are exercised on synthetic source trees (multi-line imports,
 * .js specifiers, cycles, upward edges); a child-process smoke test proves the
 * real broker tree reports successfully with the required sections.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildImportGraph,
  buildReport,
  collectSourceFiles,
  computeFan,
  extractRelativeSpecifiers,
  findDirectionViolations,
  findImportCycles,
  formatText,
  resolveSpecifier,
} from "./core-hotspot-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTER = join(HERE, "core-hotspot-report.mjs");

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "hotspot-report-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("extractRelativeSpecifiers handles single-line, multi-line, export-from, bare, dynamic", () => {
  const text = [
    'import { a } from "./a.js";',
    "import {",
    "  b,",
    '} from "./b.js";',
    'export { c } from "../c.ts";',
    'import "./side-effect.js";',
    'const d = await import("./d.js");',
    'import type { T } from "./types.js";',
    'import path from "node:path";',
    'import { x } from "@scope/pkg";',
  ].join("\n");
  const specifiers = extractRelativeSpecifiers(text);
  assert.deepEqual(
    specifiers.sort(),
    ["../c.ts", "./a.js", "./b.js", "./d.js", "./side-effect.js", "./types.js"].sort(),
  );
});

test("collectSourceFiles excludes test files", () => {
  const root = makeTree({
    "a.ts": "export {};\n",
    "a.test.ts": "import test from 'node:test';\n",
    "sub/b.ts": "export {};\n",
  });
  try {
    const files = collectSourceFiles(root).map((f) => f.slice(root.length + 1));
    assert.deepEqual(files.sort(), ["a.ts", join("sub", "b.ts")].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSpecifier maps .js specifiers and directory index files", () => {
  const root = makeTree({
    "a.ts": "export {};\n",
    "dir/index.ts": "export {};\n",
  });
  try {
    const fileSet = new Set([join(root, "a.ts"), join(root, "dir", "index.ts")]);
    const from = join(root, "main.ts");
    assert.equal(resolveSpecifier(from, "./a.js", fileSet), join(root, "a.ts"));
    assert.equal(resolveSpecifier(from, "./dir", fileSet), join(root, "dir", "index.ts"));
    assert.equal(resolveSpecifier(from, "./missing.js", fileSet), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fan, cycles, and direction violations on a synthetic graph", () => {
  const root = makeTree({
    "core/types.ts": "export {};\n",
    "core/a.ts": 'import { t } from "./types.js";\nimport { b } from "./b.js";\nexport {};\n',
    "core/b.ts": 'import { a } from "./a.js";\nexport {};\n',
    "core/leak.ts": 'import { s } from "../server.js";\nexport {};\n',
    "server.ts": 'import { t } from "./core/types.js";\nimport { a } from "./core/a.js";\nexport {};\n',
  });
  try {
    const files = collectSourceFiles(root);
    const graph = buildImportGraph(files);
    const { fanIn, fanOut } = computeFan(graph);

    assert.equal(fanIn.get(join(root, "core", "types.ts")), 2);
    assert.equal(fanOut.get(join(root, "server.ts")), 2);

    const cycles = findImportCycles(graph);
    assert.equal(cycles.length, 1);
    assert.deepEqual(
      cycles[0].map((f) => f.slice(root.length + 1)).sort(),
      [join("core", "a.ts"), join("core", "b.ts")].sort(),
    );

    const violations = findDirectionViolations(graph, root);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].importer, join("core", "leak.ts"));
    assert.equal(violations[0].imported, "server.ts");

    const report = buildReport({ srcDir: root, top: 3 });
    assert.equal(report.files, 5);
    // types.ts and a.ts tie at fan-in 2; both must outrank the rest.
    assert.deepEqual(
      report.topFanIn.slice(0, 2).map((item) => item.file),
      ["core/a.ts", "core/types.ts"],
    );
    assert.equal(report.cycles[0].size, 2);
    assert.equal(report.directionViolations.length, 1);
    const text = formatText(report);
    assert.match(text, /coupling hotspots/);
    assert.match(text, /import cycles/);
    assert.match(text, /layer-direction violations/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI smoke: real broker tree reports all sections and exits 0", () => {
  const result = spawnSync(process.execPath, [REPORTER, "--top", "3"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /broker core hotspot report: \d+ modules, \d+ in-tree import edges/);
  assert.match(result.stdout, /top 3 by fan-in/);
  assert.match(result.stdout, /top 3 by fan-out/);
  assert.match(result.stdout, /coupling hotspots/);
  assert.match(result.stdout, /import cycles \(strongly-connected components > 1\): \d+/);
  assert.match(result.stdout, /layer-direction violations \(core -> outside core\): \d+/);
  // The graph root type module is the long-standing top fan-in anchor.
  assert.match(result.stdout, /core\/types\.ts/);
});

test("CLI --json emits a parseable report", () => {
  const result = spawnSync(process.execPath, [REPORTER, "--json", "--top", "2"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.files > 300, "real broker tree should have hundreds of modules");
  assert.equal(report.topFanIn.length, 2);
  assert.ok(Array.isArray(report.cycles));
  assert.ok(Array.isArray(report.directionViolations));
});

test("CLI fails closed when the source dir is missing", () => {
  const result = spawnSync(process.execPath, [REPORTER], {
    encoding: "utf8",
    env: { ...process.env, BROKER_SRC_DIR: join(HERE, "does-not-exist") },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /source dir not found/);
});

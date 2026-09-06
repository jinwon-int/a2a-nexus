import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import {
  PROFILE_PLACEHOLDER_PATTERN,
  PROFILE_SCRIPT_DIR,
  PROFILE_SCRIPT_NAMES,
  readProfileScriptTemplate,
  renderProfileScript,
} from "./profile-scripts.js";

/**
 * Byte-identity safety net for the `profiles/*.sh` extraction (a2a-nexus#2049).
 *
 * `fixtures/patch-command-scripts/*.sh` were captured from the pre-extraction
 * implementation (main @ 4999551) by running `loadConfig(env)` for each case in
 * `cases.mjs`. These tests replay the same matrix against the extracted
 * implementation and compare bytes and SHA-256, so any escaping, whitespace, or
 * dropped-substitution drift in the container scripts fails closed.
 */

const FIXTURE_DIR = "fixtures/patch-command-scripts";

interface GoldenCase {
  readonly name: string;
  readonly env: Record<string, string>;
}

interface GoldenIndexEntry {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface GoldenIndex {
  readonly schema: string;
  readonly cases: readonly GoldenIndexEntry[];
}

const { PATCH_COMMAND_SCRIPT_GOLDEN_CASES } = (await import(
  `../${FIXTURE_DIR}/cases.mjs`
)) as { PATCH_COMMAND_SCRIPT_GOLDEN_CASES: readonly GoldenCase[] };

const goldenIndex = JSON.parse(readFileSync(join(FIXTURE_DIR, "index.json"), "utf8")) as GoldenIndex;

function goldenText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.sh`), "utf8");
}

async function renderCase(entry: GoldenCase): Promise<string> {
  const config = await loadConfig({ A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1", ...entry.env });
  assert.equal(typeof config.commandScript, "string", `${entry.name}: loadConfig produced no commandScript`);
  return config.commandScript as string;
}

test("golden fixture matrix covers every extracted profile", () => {
  assert.equal(goldenIndex.schema, "a2a-nexus.patch-command-script-goldens.v1");
  assert.equal(goldenIndex.cases.length, PATCH_COMMAND_SCRIPT_GOLDEN_CASES.length);
  assert.deepEqual(
    goldenIndex.cases.map((entry) => entry.name),
    PATCH_COMMAND_SCRIPT_GOLDEN_CASES.map((entry) => entry.name),
  );
  for (const profile of PROFILE_SCRIPT_NAMES) {
    const covering = PATCH_COMMAND_SCRIPT_GOLDEN_CASES.filter(
      (entry) => entry.env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE === profile,
    );
    assert.ok(covering.length >= 2, `profile ${profile} needs >=2 golden cases, got ${covering.length}`);
  }
});

for (const entry of PATCH_COMMAND_SCRIPT_GOLDEN_CASES) {
  test(`patch-command script is byte-identical to the pre-extraction golden: ${entry.name}`, async () => {
    const rendered = await renderCase(entry);
    const golden = goldenText(entry.name);
    const indexEntry = goldenIndex.cases.find((candidate) => candidate.name === entry.name);
    assert.ok(indexEntry, `${entry.name}: missing index.json entry`);

    // Byte comparison first so a diff is readable, then the recorded digest and
    // length, which also fail closed if the checked-in golden itself was edited.
    assert.equal(rendered, golden);
    assert.equal(Buffer.byteLength(rendered), indexEntry.bytes);
    assert.equal(createHash("sha256").update(rendered).digest("hex"), indexEntry.sha256);
  });
}

test("every rendered script consumes all placeholders and stays executable shell", async () => {
  for (const entry of PATCH_COMMAND_SCRIPT_GOLDEN_CASES) {
    const rendered = await renderCase(entry);
    assert.equal(
      PROFILE_PLACEHOLDER_PATTERN.test(rendered),
      false,
      `${entry.name}: unsubstituted __A2A_PROFILE_*__ placeholder survived`,
    );
    PROFILE_PLACEHOLDER_PATTERN.lastIndex = 0;
    assert.equal(rendered.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n"), true, entry.name);
    assert.equal(rendered.endsWith("\n"), true, entry.name);
  }
});

test("profile templates declare every placeholder the renderer is asked to fill", () => {
  for (const profile of PROFILE_SCRIPT_NAMES) {
    const template = readProfileScriptTemplate(profile);
    const names = [...template.matchAll(PROFILE_PLACEHOLDER_PATTERN)].map((match) => match[1] as string);
    assert.ok(names.length > 0, `${profile}: template has no substitution slots`);

    // Unknown slot -> throw (never silently emit the literal placeholder).
    assert.throws(
      () => renderProfileScript(profile, Object.fromEntries(names.slice(1).map((name) => [name, "x"]))),
      /references unknown substitution/,
      `${profile}: missing substitution must fail closed`,
    );
    // Extra value -> throw (never silently drop a value the script needs).
    assert.throws(
      () =>
        renderProfileScript(profile, {
          ...Object.fromEntries(names.map((name) => [name, "x"])),
          notAPlaceholder: "y",
        }),
      /ignores supplied substitution/,
      `${profile}: unused substitution must fail closed`,
    );
  }
});

test("substituted values are inserted literally (no $& / $' replacement-pattern expansion)", () => {
  const template = readProfileScriptTemplate("codex");
  const names = [...template.matchAll(PROFILE_PLACEHOLDER_PATTERN)].map((match) => match[1] as string);
  const hostile = "$&$'$`$1'\\\"";
  const rendered = renderProfileScript(
    "codex",
    Object.fromEntries([...new Set(names)].map((name) => [name, hostile])),
  );
  assert.equal(rendered.includes(hostile), true);
  assert.equal(rendered.split(hostile).length - 1, names.length);
});

test("dist/profiles mirrors the checked-in profiles/ directory byte-for-byte", () => {
  const sourceDir = "profiles";
  const sourceNames = readdirSync(sourceDir).filter((name) => name.endsWith(".sh")).sort();
  assert.deepEqual(sourceNames, [...PROFILE_SCRIPT_NAMES].map((name) => `${name}.sh`).sort());

  // PROFILE_SCRIPT_DIR resolves next to the *compiled* module, so this asserts
  // the built artifact a deployed runner actually reads — not the source tree.
  assert.equal(PROFILE_SCRIPT_DIR.replace(/\\/g, "/").endsWith("/dist/profiles"), true, PROFILE_SCRIPT_DIR);
  for (const name of sourceNames) {
    const distFile = join(PROFILE_SCRIPT_DIR, name);
    assert.equal(existsSync(distFile), true, `missing built profile script: ${distFile}`);
    assert.equal(readFileSync(distFile, "utf8"), readFileSync(join(sourceDir, name), "utf8"), name);
  }
  assert.deepEqual(readdirSync(PROFILE_SCRIPT_DIR).filter((name) => name.endsWith(".sh")).sort(), sourceNames);
});

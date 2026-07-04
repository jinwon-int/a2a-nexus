#!/usr/bin/env node
// Manifest-driven release gate runner (issue #646).
//
// Reads scripts/release-gate-manifest.json, validates every listed file exists
// (missing file = fail loudly), then runs `node --test <all files>` as ONE
// process — identical to the historical hand-enumerated `test:release-gate`.
//
// Flags:
//   --list   Print the resolved file list (manifest order) and exit 0. Used for
//            before/after list-equality verification. No tests are run.
//   --include-archived
//            Opt into historical/archived manifest entries. Used when an operator
//            intentionally wants to re-run completed round validators.
//
// Per-entry `"archived": true` skips that entry loudly (one warning line) by
// default, but keeps the file available through `--include-archived`.

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const MANIFEST_PATH = join(SCRIPT_DIR, 'release-gate-manifest.json');

const VALID_CLASSES = new Set(['gate', 'tool', 'round']);

function fail(message) {
  console.error(`release-gate: ${message}`);
  process.exit(1);
}

export function loadManifest(manifestPath = MANIFEST_PATH) {
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    fail(`cannot read manifest at ${manifestPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`manifest is not valid JSON (${manifestPath}): ${err.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`manifest must be a JSON object with an "entries" array (${manifestPath})`);
  }
  if (!Array.isArray(parsed.entries)) {
    fail(`manifest "entries" must be an array (${manifestPath})`);
  }
  if (parsed.entries.length === 0) {
    fail(`manifest "entries" is empty (${manifestPath})`);
  }

  const seen = new Set();
  parsed.entries.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`manifest entry #${i} must be an object`);
    }
    if (typeof entry.file !== 'string' || entry.file.length === 0) {
      fail(`manifest entry #${i} is missing a non-empty "file" string`);
    }
    if (seen.has(entry.file)) {
      fail(`manifest lists "${entry.file}" more than once`);
    }
    seen.add(entry.file);
    if (typeof entry.class !== 'string' || !VALID_CLASSES.has(entry.class)) {
      fail(
        `manifest entry "${entry.file}" has invalid "class" (expected one of ${[...VALID_CLASSES].join(', ')})`,
      );
    }
    if (entry.archived !== undefined && typeof entry.archived !== 'boolean') {
      fail(`manifest entry "${entry.file}" has non-boolean "archived"`);
    }
  });

  return parsed;
}

// Returns { active: [...files], skipped: [{file, ...}] }.
export function resolveEntries(manifest, { repoRoot = REPO_ROOT, includeArchived = false } = {}) {
  const active = [];
  const skipped = [];
  const missing = [];

  for (const entry of manifest.entries) {
    if (entry.archived === true && !includeArchived) {
      skipped.push(entry);
      continue;
    }
    if (!existsSync(join(repoRoot, entry.file))) {
      missing.push(entry.file);
    }
    active.push(entry.file);
  }

  if (missing.length > 0) {
    fail(
      `manifest references ${missing.length} missing file(s):\n  ${missing.join('\n  ')}`,
    );
  }

  return { active, skipped };
}

function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const includeArchived = args.includes('--include-archived');
  const unknownArgs = args.filter((arg) => !['--list', '--include-archived'].includes(arg));
  if (unknownArgs.length) fail(`unknown argument(s): ${unknownArgs.join(', ')}`);

  const manifest = loadManifest();
  const { active, skipped } = resolveEntries(manifest, { includeArchived });

  if (!includeArchived) {
    for (const entry of skipped) {
      console.warn(
        `release-gate: SKIP archived entry ${entry.file}` +
          (entry.round ? ` (round ${entry.round})` : ''),
      );
    }
  }

  if (listOnly) {
    for (const file of active) {
      console.log(file);
    }
    return;
  }

  if (active.length === 0) {
    fail('no active test files to run');
  }

  console.log(
    `release-gate: running ${active.length} test file(s) via node --test` +
      (skipped.length ? ` (${skipped.length} archived, skipped)` : ''),
  );

  const result = spawnSync(process.execPath, ['--test', ...active], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });

  if (result.error) {
    fail(`failed to spawn node --test: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}

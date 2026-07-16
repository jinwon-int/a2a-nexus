// Coverage for the manifest-driven release gate runner (issue #646).
//
// Tests exercise the runner as a child process (for fail-loud / --list /
// archived behavior) plus a direct import of the real manifest to assert it
// parses and stays in sync with what `--list` resolves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'run-release-gate.mjs');
const MANIFEST = join(HERE, 'release-gate-manifest.json');
const REPO_ROOT = resolve(HERE, '..');

function runRunner(args = [], opts = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    ...opts,
  });
}

// A tiny harness that runs the runner against an arbitrary manifest+root by
// writing a throwaway copy of run-release-gate.mjs that points at a temp
// manifest. Instead we import the exported helpers directly.
async function importRunner() {
  return import(`./run-release-gate.mjs?cachebust=${Math.random()}`);
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'release-gate-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('real manifest parses and matches schema expectations', () => {
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.ok(Array.isArray(parsed.entries), 'entries is an array');
  assert.ok(parsed.entries.length > 0, 'entries is non-empty');
  const valid = new Set(['gate', 'tool', 'round']);
  for (const e of parsed.entries) {
    assert.equal(typeof e.file, 'string');
    assert.ok(e.file.length > 0);
    assert.ok(valid.has(e.class), `class ${e.class} is valid for ${e.file}`);
    assert.ok('round' in e, `${e.file} has round key`);
    assert.ok('note' in e, `${e.file} has note key`);
    if (e.class === 'round') {
      assert.ok(e.round, `round entry ${e.file} has a non-null round id`);
    }
  }
});

test('--list output matches manifest order exactly (non-archived default path)', () => {
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const expected = parsed.entries
    .filter((e) => e.archived !== true)
    .map((e) => e.file);
  const res = runRunner(['--list']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n').filter((l) => l.length > 0);
  assert.deepEqual(lines, expected);
});



test('--include-archived --list output includes historical entries in manifest order', () => {
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const expected = parsed.entries.map((e) => e.file);
  const archivedCount = parsed.entries.filter((e) => e.archived === true).length;
  assert.ok(archivedCount > 0, 'manifest declares at least one archived entry');
  const res = runRunner(['--include-archived', '--list']);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n').filter((l) => l.length > 0);
  assert.deepEqual(lines, expected);
});

test('default --list excludes the #1288 historical opt-in candidate set', () => {
  // Assert the invariant (default path excludes the archived candidate set and
  // the split is consistent) rather than absolute counts, which drift as the
  // manifest grows — see #1570. The archived-exclusion behavior is verified
  // against the runner in the '--list' / '--include-archived --list' tests above.
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const active = parsed.entries.filter((e) => e.archived !== true);
  const archived = parsed.entries.filter((e) => e.archived === true);
  assert.ok(archived.length > 0, 'there is a historical opt-in candidate set to exclude');
  assert.ok(active.length < parsed.entries.length, 'default path excludes the archived set');
  assert.equal(active.length + archived.length, parsed.entries.length, 'active + archived == total');
});

test('loadManifest accepts a well-formed temp manifest', async () => {
  const mod = await importRunner();
  withTempDir((dir) => {
    const p = join(dir, 'm.json');
    writeFileSync(
      p,
      JSON.stringify({
        entries: [
          { file: 'scripts/run-release-gate.mjs', class: 'gate', round: null, note: 'self' },
        ],
      }),
    );
    const m = mod.loadManifest(p);
    assert.equal(m.entries.length, 1);
  });
});

test('resolveEntries fails loudly on a missing file', () => {
  // Build a temp manifest + temp root that references a non-existent file,
  // and drive it through a small inline script that imports the helpers.
  withTempDir((dir) => {
    const manifestPath = join(dir, 'm.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        entries: [
          { file: 'scripts/does-not-exist.test.mjs', class: 'gate', round: null, note: '' },
        ],
      }),
    );
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      `import { loadManifest, resolveEntries } from ${JSON.stringify(RUNNER)};\n` +
        `const m = loadManifest(${JSON.stringify(manifestPath)});\n` +
        `resolveEntries(m, { repoRoot: ${JSON.stringify(dir)} });\n` +
        `console.log('SHOULD-NOT-REACH');\n`,
    );
    const res = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
    assert.equal(res.status, 1, 'missing file must exit non-zero');
    assert.match(res.stderr, /missing file/i);
    assert.doesNotMatch(res.stdout, /SHOULD-NOT-REACH/);
  });
});

test('archived entries are skipped with a loud warning and excluded from --list', () => {
  withTempDir((dir) => {
    // Real, existing file so the active path validates.
    const realFile = 'scripts/run-release-gate.mjs';
    const manifestPath = join(dir, 'm.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        entries: [
          { file: realFile, class: 'gate', round: null, note: 'active' },
          {
            file: 'scripts/release-gate.mjs',
            class: 'round',
            round: 'team9-r99',
            note: 'retired',
            archived: true,
          },
        ],
      }),
    );
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      `import { loadManifest, resolveEntries } from ${JSON.stringify(RUNNER)};\n` +
        `const m = loadManifest(${JSON.stringify(manifestPath)});\n` +
        `const { active, skipped } = resolveEntries(m, { repoRoot: ${JSON.stringify(REPO_ROOT)} });\n` +
        `const included = resolveEntries(m, { repoRoot: ${JSON.stringify(REPO_ROOT)}, includeArchived: true });\n` +
        `for (const e of skipped) console.warn('SKIP ' + e.file + ' ' + e.round);\n` +
        `console.log(JSON.stringify({ active, skippedCount: skipped.length, included: included.active }));\n`,
    );
    const res = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /SKIP scripts\/release-gate\.mjs team9-r99/);
    const out = JSON.parse(res.stdout.trim());
    assert.deepEqual(out.active, [realFile]);
    assert.equal(out.skippedCount, 1);
    assert.deepEqual(out.included, [realFile, 'scripts/release-gate.mjs']);
  });
});

test('malformed JSON manifest fails loudly', () => {
  withTempDir((dir) => {
    const manifestPath = join(dir, 'm.json');
    writeFileSync(manifestPath, '{ this is not json ');
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      `import { loadManifest } from ${JSON.stringify(RUNNER)};\n` +
        `loadManifest(${JSON.stringify(manifestPath)});\n`,
    );
    const res = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not valid JSON/i);
  });
});

test('manifest with non-array entries fails loudly', () => {
  withTempDir((dir) => {
    const manifestPath = join(dir, 'm.json');
    writeFileSync(manifestPath, JSON.stringify({ entries: 'nope' }));
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      `import { loadManifest } from ${JSON.stringify(RUNNER)};\n` +
        `loadManifest(${JSON.stringify(manifestPath)});\n`,
    );
    const res = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /"entries" must be an array/);
  });
});

test('manifest entry with invalid class fails loudly', () => {
  withTempDir((dir) => {
    const manifestPath = join(dir, 'm.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        entries: [{ file: 'x.test.mjs', class: 'bogus', round: null, note: '' }],
      }),
    );
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      `import { loadManifest } from ${JSON.stringify(RUNNER)};\n` +
        `loadManifest(${JSON.stringify(manifestPath)});\n`,
    );
    const res = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /invalid "class"/);
  });
});

test('duplicate file entries fail loudly', () => {
  withTempDir((dir) => {
    const manifestPath = join(dir, 'm.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        entries: [
          { file: 'dup.test.mjs', class: 'gate', round: null, note: '' },
          { file: 'dup.test.mjs', class: 'gate', round: null, note: '' },
        ],
      }),
    );
    const driver = join(dir, 'driver.mjs');
    writeFileSync(
      driver,
      `import { loadManifest } from ${JSON.stringify(RUNNER)};\n` +
        `loadManifest(${JSON.stringify(manifestPath)});\n`,
    );
    const res = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /more than once/);
  });
});
#!/usr/bin/env node
/**
 * Manifest-driven broker package test runner (#1288 unit 4).
 *
 * Preserves the historical `npm test` command sequence while making the surface
 * reviewable and partially runnable through `--list`.
 *
 * An entry may declare `skipWhenEnv: "<VAR>"`. When that environment variable
 * is set to `1`, the step is reported as skipped instead of executed. The
 * command set itself is unchanged (`--list` still prints every command, and the
 * manifest still matches `legacyEquivalent`), so the reviewable surface and the
 * broker-test-manifest gate stay intact. Used by CI to keep a warm
 * `packages/broker/dist` cache: `npm run clean:dist` (step-01) otherwise
 * deletes the just-restored cache and forces a full recompile every run.
 *
 * Silent-test-loss guard (#2453 PR-0, analyze.md Risks 1). `node --test` exits
 * 0 when its patterns match nothing (`tests 0`), so a moved or renamed test
 * file could stop running while CI stays green. Before the first step that
 * runs compiled tests, the runner therefore expands every `node --test`
 * pattern of the manifest (the same glob semantics node uses) and fails when
 *   - a test step matches 0 files in total, or
 *   - a compiled `dist/**\/*.test.js` whose `src/**\/*.test.ts` still exists
 *     is matched by no step (stale cache output without a source is ignored).
 * A single pattern that matches nothing is reported as a warning. Each step
 * prints its test-file count so before/after counts can be compared.
 */
import { existsSync, globSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunTmpdir, describeCleanup } from '../../../scripts/lib/test-tmpdir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const MANIFEST_PATH = process.env.BROKER_TEST_MANIFEST_PATH || join(HERE, 'test-manifest.json');

function fail(message) {
  console.error(`broker test manifest: ${message}`);
  process.exit(1);
}

export function loadTestManifest(path = MANIFEST_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read manifest: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('manifest must be an object');
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) fail('manifest.entries must be a non-empty array');
  for (const [index, entry] of parsed.entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`entry #${index} must be an object`);
    if (typeof entry.name !== 'string' || entry.name.length === 0) fail(`entry #${index} missing name`);
    if (typeof entry.command !== 'string' || entry.command.length === 0) fail(`entry ${entry.name} missing command`);
    if (entry.skipWhenEnv !== undefined && (typeof entry.skipWhenEnv !== 'string' || entry.skipWhenEnv.length === 0)) {
      fail(`entry ${entry.name} has an invalid skipWhenEnv`);
    }
  }
  return parsed;
}

export function commandsFromManifest(manifest) {
  return manifest.entries.map((entry) => entry.command);
}

export function isEntrySkipped(entry, env = process.env) {
  return Boolean(entry.skipWhenEnv) && env[entry.skipWhenEnv] === '1';
}

/** Split one shell command segment into words, honouring single and double quotes. */
export function shellWords(segment) {
  const words = [];
  let current = '';
  let quote = null;
  let inWord = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

/** File patterns passed to every `node --test` invocation in a manifest command. */
export function testFilePatterns(command) {
  const patterns = [];
  for (const segment of command.split(/&&|\|\||;/)) {
    const words = shellWords(segment.trim());
    if (words[0] !== 'node' || !words.includes('--test')) continue;
    for (const word of words.slice(1)) if (!word.startsWith('-')) patterns.push(word);
  }
  return patterns;
}

/** Expand test patterns relative to cwd; returns matched files and patterns with no match. */
export function expandTestPatterns(patterns, cwd = PACKAGE_ROOT) {
  const files = new Set();
  const empty = [];
  for (const pattern of patterns) {
    const matches = /[*?[\]{}]/.test(pattern)
      ? globSync(pattern, { cwd })
      : existsSync(join(cwd, pattern)) ? [pattern] : [];
    if (matches.length === 0) empty.push(pattern);
    for (const match of matches) files.add(normalize(match));
  }
  return { files: [...files].sort(), empty };
}

/**
 * Pre-flight the whole manifest's test patterns against the built tree.
 * Returns per-entry counts, errors (fatal) and warnings.
 */
export function auditTestCoverage(manifest, cwd = PACKAGE_ROOT) {
  const errors = [];
  const warnings = [];
  const perEntry = new Map();
  const covered = new Set();
  for (const entry of manifest.entries) {
    const patterns = testFilePatterns(entry.command);
    if (patterns.length === 0) continue;
    const { files, empty } = expandTestPatterns(patterns, cwd);
    perEntry.set(entry.name, files.length);
    for (const file of files) covered.add(file);
    if (files.length === 0) errors.push(`${entry.name} runs node --test but its patterns match 0 test files: ${patterns.join(' ')}`);
    for (const pattern of empty) warnings.push(`${entry.name}: pattern matches no file: ${pattern}`);
  }
  const compiled = globSync('dist/**/*.test.js', { cwd }).map((file) => normalize(file)).sort();
  const uncovered = compiled.filter(
    (file) => !covered.has(file) && existsSync(join(cwd, file.replace(/^dist([\\/])/, 'src$1').replace(/\.js$/, '.ts'))),
  );
  for (const file of uncovered) errors.push(`compiled test ${file} is not matched by any manifest step (it would silently stop running)`);
  return { perEntry, total: covered.size, compiled: compiled.length, uncovered, errors, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const unknown = args.filter((arg) => arg !== '--list');
  if (unknown.length) fail(`unknown argument(s): ${unknown.join(', ')}`);
  const manifest = loadTestManifest();
  const commands = commandsFromManifest(manifest);
  if (listOnly) {
    for (const command of commands) console.log(command);
    return;
  }
  // #2386: one run-scoped TMPDIR for every step, removed when the run ends.
  const runTmp = createRunTmpdir('a2a-broker-tests-');
  let exitCode = 0;
  let audit = null;
  try {
    for (const [index, command] of commands.entries()) {
      const entry = manifest.entries[index];
      if (isEntrySkipped(entry)) {
        console.log(
          `broker test manifest: step ${index + 1}/${commands.length}: skipped (${entry.skipWhenEnv}=1): ${command}`,
        );
        continue;
      }
      if (testFilePatterns(command).length > 0) {
        if (!audit) {
          // First test step: the build steps have run, so dist/ is current.
          audit = auditTestCoverage(manifest);
          for (const warning of audit.warnings) console.log(`broker test manifest: warning: ${warning}`);
          console.log(
            `broker test manifest: test files: ${audit.total} matched by ${audit.perEntry.size} step(s); ` +
              `${audit.compiled} compiled dist test files, ${audit.uncovered.length} uncovered`,
          );
          if (audit.errors.length > 0) {
            for (const error of audit.errors) console.error(`broker test manifest: ${error}`);
            exitCode = 1;
            break;
          }
        }
        console.log(`broker test manifest: step ${index + 1}/${commands.length}: ${audit.perEntry.get(entry.name) ?? 0} test files`);
      }
      console.log(`broker test manifest: step ${index + 1}/${commands.length}: ${command}`);
      const result = spawnSync(command, { cwd: PACKAGE_ROOT, stdio: 'inherit', shell: true, env: runTmp.env });
      if (result.error) {
        console.error(`broker test manifest: failed to spawn step ${index + 1}: ${result.error.message}`);
        exitCode = 1;
        break;
      }
      if ((result.status ?? 1) !== 0) {
        exitCode = result.status ?? 1;
        break;
      }
    }
  } finally {
    console.log(describeCleanup('broker test manifest', runTmp.cleanup()));
  }
  if (exitCode !== 0) process.exit(exitCode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

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
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  for (const [index, command] of commands.entries()) {
    const entry = manifest.entries[index];
    if (isEntrySkipped(entry)) {
      console.log(
        `broker test manifest: step ${index + 1}/${commands.length}: skipped (${entry.skipWhenEnv}=1): ${command}`,
      );
      continue;
    }
    console.log(`broker test manifest: step ${index + 1}/${commands.length}: ${command}`);
    const result = spawnSync(command, { cwd: PACKAGE_ROOT, stdio: 'inherit', shell: true });
    if (result.error) fail(`failed to spawn step ${index + 1}: ${result.error.message}`);
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

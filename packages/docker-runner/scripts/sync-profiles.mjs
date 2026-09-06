#!/usr/bin/env node
/**
 * Mirror `profiles/*.sh` into `dist/profiles/` after `tsc` (a2a-nexus#2049).
 *
 * `tsc` only emits `.ts` output, so the extracted container scripts would be
 * absent from a built package without this step. `dist/` is the shipped
 * surface (`package.json` `files`), and `dist/profile-scripts.js` resolves the
 * scripts next to itself, so the mirror is what makes a built runner work.
 *
 * The copy is unconditional and content-compared, so a restored `dist` build
 * cache (whose key only hashes `*.ts` + tsconfig) can never leave a stale or
 * missing script behind.
 *
 * Safety: local file copy inside the package only. No network, no repo, no
 * release, publish, deploy, restart, credential, DB, or ACK action.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_DIR = path.join(PACKAGE_DIR, 'profiles');
export const TARGET_DIR = path.join(PACKAGE_DIR, 'dist', 'profiles');

/** Sorted `*.sh` basenames in `profiles/`. */
export function listProfileScripts(sourceDir = SOURCE_DIR) {
  return fs
    .readdirSync(sourceDir)
    .filter((name) => name.endsWith('.sh'))
    .sort();
}

/**
 * Copy every `profiles/*.sh` into `dist/profiles/`, drop `.sh` files that no
 * longer exist in the source, and return the per-file action taken.
 */
export function syncProfiles({ sourceDir = SOURCE_DIR, targetDir = TARGET_DIR } = {}) {
  const names = listProfileScripts(sourceDir);
  if (names.length === 0) throw new Error(`no profile scripts found in ${sourceDir}`);
  fs.mkdirSync(targetDir, { recursive: true });

  const actions = [];
  for (const name of names) {
    const from = path.join(sourceDir, name);
    const to = path.join(targetDir, name);
    const source = fs.readFileSync(from);
    const existing = fs.existsSync(to) ? fs.readFileSync(to) : undefined;
    if (existing && existing.equals(source)) {
      actions.push({ name, action: 'unchanged' });
      continue;
    }
    fs.writeFileSync(to, source);
    actions.push({ name, action: existing ? 'updated' : 'created' });
  }

  const keep = new Set(names);
  for (const stale of fs.readdirSync(targetDir)) {
    if (!stale.endsWith('.sh') || keep.has(stale)) continue;
    fs.rmSync(path.join(targetDir, stale));
    actions.push({ name: stale, action: 'removed' });
  }
  return actions;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const actions = syncProfiles();
  const changed = actions.filter((entry) => entry.action !== 'unchanged');
  process.stdout.write(
    `sync-profiles: ${actions.length} script(s) in dist/profiles`
      + (changed.length > 0 ? ` (${changed.map((e) => `${e.name}=${e.action}`).join(', ')})` : ' (unchanged)')
      + '\n',
  );
}

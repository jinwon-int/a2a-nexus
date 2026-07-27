import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractDistSpecifiers,
  distPathToSourcePath,
  isWorkspaceDistPath,
  resolveSpecifier,
  collectUnresolved,
} from './check-dist-import-resolution.mjs';

const existsIn = (set) => (candidate) => set.has(candidate);

/** Absolute synthetic root, since resolveSpecifier resolves against the cwd. */
const ROOT = path.resolve(path.sep, 'synthetic-repo');

// Fixture specifiers below use the `./dist/...` form on purpose. This file lives
// in scripts/, which is not a workspace root, so when the live guard scans its
// own test file these strings resolve to "not workspace output" and are ignored.
// Using `../dist/...` here would make the guard fail on its own fixtures.

test('extracts static and dynamic compiled-output specifiers', () => {
  const source = `
    import { a } from "./dist/core/a.js";
    import b from './dist/core/b.js';
    const c = await import("./dist/core/c.js");
  `;
  assert.deepEqual(extractDistSpecifiers(source), [
    './dist/core/a.js',
    './dist/core/b.js',
    './dist/core/c.js',
  ]);
});

test('ignores specifiers that are not relative compiled-output JavaScript', () => {
  const source = `
    import pkg from "a2a-attestation";       // package specifier — node resolves it
    import fs from "node:fs";                // builtin
    import cfg from "./dist/core/cfg.json";  // not JavaScript
    import src from "./src/core/thing.ts";   // source, not compiled output
  `;
  assert.deepEqual(extractDistSpecifiers(source), []);
});

test('maps a compiled path back to its TypeScript source', () => {
  const p = path.join('repo', 'packages', 'broker', 'dist', 'core', 'store.js');
  assert.equal(
    distPathToSourcePath(p),
    path.join('repo', 'packages', 'broker', 'src', 'core', 'store.ts'),
  );
});

test('maps only the last dist segment, so a package named dist is not mangled', () => {
  const p = path.join('dist', 'packages', 'broker', 'dist', 'core', 'store.js');
  assert.equal(
    distPathToSourcePath(p),
    path.join('dist', 'packages', 'broker', 'src', 'core', 'store.ts'),
  );
});

test('distPathToSourcePath returns null when there is no dist segment', () => {
  assert.equal(distPathToSourcePath(path.join('repo', 'src', 'a.js')), null);
});

test('a dist path counts as workspace output only when a package.json sits beside it', () => {
  const pkgDist = path.join('repo', 'packages', 'broker', 'dist', 'core', 'store.js');
  const scriptsDist = path.join('repo', 'packages', 'broker', 'scripts', 'dist', 'core', 'store.js');
  const exists = existsIn(new Set([path.join('repo', 'packages', 'broker', 'package.json')]));

  assert.equal(isWorkspaceDistPath(pkgDist, exists), true);
  assert.equal(isWorkspaceDistPath(scriptsDist, exists), false);
});

test('a specifier resolves through its source when the build has not run', () => {
  const script = path.join(ROOT, 'packages', 'broker', 'scripts', 'tool.mjs');
  const exists = existsIn(
    new Set([
      path.join(ROOT, 'packages', 'broker', 'package.json'),
      path.join(ROOT, 'packages', 'broker', 'src', 'core', 'store.ts'),
    ]),
  );
  const ruling = resolveSpecifier(script, '../dist/core/store.js', exists);
  assert.equal(ruling.ok, true);
  assert.equal(ruling.via, 'source');
});

test('a specifier resolves through a directory index', () => {
  const script = path.join(ROOT, 'packages', 'broker', 'scripts', 'tool.mjs');
  const exists = existsIn(
    new Set([
      path.join(ROOT, 'packages', 'broker', 'package.json'),
      path.join(ROOT, 'packages', 'broker', 'src', 'core', 'sidecar', 'index.ts'),
    ]),
  );
  assert.equal(resolveSpecifier(script, '../dist/core/sidecar.js', exists).ok, true);
});

test('the flattened-vs-subdirectory mistake is caught', () => {
  // This is the exact shape of the #1601 regression: seventeen scripts kept
  // importing a flat path after the modules moved into a subdirectory.
  const script = path.join(ROOT, 'packages', 'broker', 'scripts', 'tool.mjs');
  const exists = existsIn(
    new Set([
      path.join(ROOT, 'packages', 'broker', 'package.json'),
      path.join(ROOT, 'packages', 'broker', 'src', 'core', 'group', 'member.ts'),
    ]),
  );

  assert.equal(resolveSpecifier(script, '../dist/core/group/member.js', exists).ok, true);
  assert.equal(resolveSpecifier(script, '../dist/core/group-member.js', exists).ok, false);
});

test('code embedded in a template literal is not ruled on', () => {
  // packages/broker/scripts/release-gate.mjs embeds a store import inside a
  // container script whose working directory is the package root. Resolving it
  // here would point at scripts/dist, which is nobody's build output.
  const script = path.join(ROOT, 'packages', 'broker', 'scripts', 'release-gate.mjs');
  const exists = existsIn(new Set([path.join(ROOT, 'packages', 'broker', 'package.json')]));
  const ruling = resolveSpecifier(script, './dist/core/store.js', exists);
  assert.equal(ruling.ok, true);
  assert.equal(ruling.via, 'not workspace output');
});

test('collectUnresolved reports the offending script, specifier and expected source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-import-'));
  const pkg = path.join(root, 'packages', 'broker');
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"broker"}');
  fs.writeFileSync(path.join(pkg, 'src', 'core', 'present.ts'), '');
  // Interpolated so the fixture specifier is not a literal in this file's own
  // source — the live guard scans scripts/ including its own tests, and a bare
  // "../dist/core/absent.js" here would be reported as a real broken import.
  const dist = `..${path.posix.sep}dist/core`;
  fs.writeFileSync(
    path.join(pkg, 'scripts', 'tool.mjs'),
    `import a from "${dist}/present.js";\nimport b from "${dist}/absent.js";\n`,
  );

  const result = collectUnresolved(root, { scriptDirs: ['packages/broker/scripts'] });
  assert.equal(result.checked, 2);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].specifier, '../dist/core/absent.js');
  assert.equal(result.unresolved[0].script, path.join('packages', 'broker', 'scripts', 'tool.mjs'));
  assert.equal(
    result.unresolved[0].expectedSource,
    path.join('packages', 'broker', 'src', 'core', 'absent.ts'),
  );
});

test('the live repository resolves every compiled-output specifier', () => {
  const { checked, unresolved } = collectUnresolved(process.cwd());
  assert.ok(checked > 0, 'expected the guard to find specifiers to check');
  assert.deepEqual(
    unresolved.map((u) => `${u.script} -> ${u.specifier}`),
    [],
  );
});

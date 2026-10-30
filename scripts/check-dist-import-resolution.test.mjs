import { test, after } from 'node:test';
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
  extractCorePathReferences,
  checkCorePathConsumers,
  CORE_PATH_CONSUMERS,
} from './check-dist-import-resolution.mjs';

// #2386: remove every temp dir this file creates.
const trackedTempDirs = [];
function trackTempDir(dir) {
  trackedTempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of trackedTempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
  const root = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dist-import-')));
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

// ---------------------------------------------------------------------------
// Computed broker-core path consumers (#2453 PR-0, analyze.md Risks 4).

test('extractCorePathReferences sees computed and source core paths but not literal compiled imports or comments', () => {
  const dist = `..${path.posix.sep}dist/core`;
  const source = [
    'const m = await import(`${rootDir}/dist/core/store.js`);',
    'const p = join(ROOT, "dist/core/operator-approval-request.js");',
    "import { R } from '../packages/broker/src/core/requester-role-contract.mjs';",
    `import { x } from "${dist}/covered.js";`,
    ' * see dist/core/commented.js',
    '// dist/core/also-commented.js',
    "const floors = { 'dist/core/release-evidence.js': 97 };",
  ].join('\n');
  assert.deepEqual(extractCorePathReferences(source), [
    'dist/core/operator-approval-request.js',
    'dist/core/release-evidence.js',
    'dist/core/store.js',
    'src/core/requester-role-contract.mjs',
  ]);
});

function corePathFixture() {
  const root = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'core-path-consumers-')));
  fs.mkdirSync(path.join(root, 'packages', 'broker', 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'broker', 'src', 'core', 'store.ts'), '');
  fs.writeFileSync(path.join(root, 'tools', 'export.mjs'), 'await import(`${root}/dist/core/store.js`);\n');
  fs.writeFileSync(path.join(root, 'tools', 'export.test.mjs'), 'await import(`${root}/dist/core/ignored.js`);\n');
  return root;
}

test('checkCorePathConsumers passes an inventoried computed consumer whose module exists', () => {
  const root = corePathFixture();
  const result = checkCorePathConsumers(root, { scanDirs: ['tools'], inventory: { 'tools/export.mjs': ['dist/core/store.js'] } });
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 1);
});

test('checkCorePathConsumers fails on an uninventoried computed consumer', () => {
  const root = corePathFixture();
  const result = checkCorePathConsumers(root, { scanDirs: ['tools'], inventory: {} });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /tools\/export\.mjs references 'dist\/core\/store\.js'/);
});

test('checkCorePathConsumers fails when the core module moves (the computed path no longer resolves)', () => {
  const root = corePathFixture();
  fs.mkdirSync(path.join(root, 'packages', 'broker', 'src', 'core', 'store'), { recursive: true });
  fs.renameSync(
    path.join(root, 'packages', 'broker', 'src', 'core', 'store.ts'),
    path.join(root, 'packages', 'broker', 'src', 'core', 'store', 'store.ts'),
  );
  const result = checkCorePathConsumers(root, { scanDirs: ['tools'], inventory: { 'tools/export.mjs': ['dist/core/store.js'] } });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /no longer resolves/);
});

test('checkCorePathConsumers fails on a stale inventory entry', () => {
  const root = corePathFixture();
  const result = checkCorePathConsumers(root, {
    scanDirs: ['tools'],
    inventory: { 'tools/export.mjs': ['dist/core/store.js'], 'tools/gone.mjs': ['dist/core/store.js'] },
  });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /stale: tools\/gone\.mjs/);
});

test('the live repository inventories every computed core-path consumer named in #2453 Risks 4', () => {
  const { checked, problems } = checkCorePathConsumers(process.cwd());
  assert.deepEqual(problems, []);
  for (const file of [
    'packages/broker/scripts/export-sqlite-state.mjs',
    'test/conformance/check-three-component-e2e.mjs',
    'test/conformance/check-trace-propagation.mjs',
    'test/conformance/lib/ensure-built.mjs',
    'scripts/a2a-dispatch-round.mjs',
    'scripts/lib/task-assign-entrypoint.mjs',
  ]) {
    assert.ok(CORE_PATH_CONSUMERS[file], `${file} must stay inventoried`);
  }
  assert.ok(checked >= 9);
});

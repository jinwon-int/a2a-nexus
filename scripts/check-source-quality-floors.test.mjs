import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  ASYNC_SAFETY_PACKAGES,
  FLOOR_SCHEMA,
  classifyFile,
  collectFloatingPromises,
  collectMeasured,
  countUnsafeSuppressions,
  evaluateFloatingPromiseFloor,
  evaluateFloor,
  parseAsyncSafetyScope,
} from './check-source-quality-floors.mjs';
import { analyzeProject, isProductionSource } from './lib/async-safety.mjs';
import { PACKAGE_CI_SURFACES } from './run-monorepo-package-ci-parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, 'check-source-quality-floors.mjs');

test('classifyFile buckets source vs test/generated/archive/other', () => {
  assert.equal(classifyFile('packages/broker/src/core/policy.ts'), 'source');
  assert.equal(classifyFile('packages/broker/src/core/policy.test.ts'), 'test');
  assert.equal(classifyFile('packages/broker/dist/core/policy.js'), 'generated');
  assert.equal(classifyFile('packages/broker/src/build-info.json'), 'generated');
  assert.equal(classifyFile('docs/history/archive/old.ts'), 'archive');
  assert.equal(classifyFile('scripts/check-source-quality-floors.mjs'), 'other');
  // Non-src .ts is not source (suppressions only enforced in the src bundle).
  assert.equal(classifyFile('packages/broker/tools/gen.ts'), 'other');
});

function asyncSafetyFixture(t, source, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-async-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  fs.writeFileSync(path.join(src, 'main.ts'), source);
  for (const [relative, contents] of Object.entries(extra)) {
    fs.writeFileSync(path.join(root, relative), contents);
  }
  return {
    packageRoot: root,
    configPath: path.join(root, 'tsconfig.json'),
  };
}

test('async-safety source bucket excludes tests, declarations, and non-source paths', () => {
  const root = '/tmp/example-package';
  assert.equal(isProductionSource(`${root}/src/main.ts`, root), true);
  assert.equal(isProductionSource(`${root}/src/main.mts`, root), true);
  assert.equal(isProductionSource(`${root}/src/main.cts`, root), true);
  assert.equal(isProductionSource(`${root}/src/main.test.ts`, root), false);
  assert.equal(isProductionSource(`${root}/src/types.d.ts`, root), false);
  assert.equal(isProductionSource(`${root}/src/types.d.mts`, root), false);
  assert.equal(isProductionSource(`${root}/scripts/check.ts`, root), false);
});

test('async-safety finds bare Promise calls, conditionals, and logical branches', (t) => {
  const project = asyncSafetyFixture(t, `
    declare function work(): Promise<void>;
    declare const enabled: boolean;
    work();
    enabled ? work() : Promise.resolve();
    enabled && work();
  `);
  const findings = analyzeProject(project);
  assert.equal(findings.length, 3);
  assert.deepEqual(findings.map((finding) => finding.line), [4, 5, 6]);
});

test('async-safety allows awaited, handled, assigned, returned, and explicit-void Promises', (t) => {
  const project = asyncSafetyFixture(t, `
    declare function work(): Promise<void>;
    declare function onError(error: unknown): void;
    async function safe(): Promise<void> {
      await work();
      void work();
      work().catch(onError);
      work().then(undefined, onError);
      const pending = work();
      await pending;
      return work();
    }
    void safe();
  `);
  assert.deepEqual(analyzeProject(project), []);
});

test('async-safety does not accept missing rejection handlers or finally as handled', (t) => {
  const project = asyncSafetyFixture(t, `
    declare function work(): Promise<void>;
    work().catch(undefined);
    work().then(() => {});
    work().catch(() => {}).finally(() => {});
  `);
  assert.equal(analyzeProject(project).length, 3);
});

test('async-safety fails closed when a TypeScript config cannot be read', () => {
  assert.throws(
    () => analyzeProject({ configPath: '/definitely/missing/tsconfig.json' }),
    /cannot read TypeScript config/,
  );
});

test('async-safety rejects source symlinks that resolve outside the package', (t) => {
  const project = asyncSafetyFixture(t, 'export const safe = true;\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-async-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'outside.ts'), 'Promise.resolve();\n');
  fs.symlinkSync(path.join(outside, 'outside.ts'), path.join(project.packageRoot, 'src', 'linked.ts'));
  assert.throws(
    () => analyzeProject(project),
    /source symlink resolves outside the package/,
  );
});

test('countUnsafeSuppressions counts @ts-ignore / @ts-nocheck / eslint-disable', () => {
  const text = [
    'const a = 1;',
    '// @ts-ignore because reasons',
    '/* @ts-nocheck */',
    'foo(); // eslint-disable-line no-console',
    '/* eslint-disable */',
    'bar();',
  ].join('\n');
  assert.equal(countUnsafeSuppressions(text), 4);
});

test('countUnsafeSuppressions flags bare @ts-expect-error but allows explained ones', () => {
  assert.equal(countUnsafeSuppressions('// @ts-expect-error'), 1);
  assert.equal(countUnsafeSuppressions('// @ts-expect-error   '), 1);
  assert.equal(countUnsafeSuppressions('// @ts-expect-error: '), 1);
  // Explained forms are the SAFE alternative and must not count.
  assert.equal(countUnsafeSuppressions('// @ts-expect-error upstream types are wrong'), 0);
  assert.equal(countUnsafeSuppressions('// @ts-expect-error: legacy API shape'), 0);
  assert.equal(countUnsafeSuppressions('/* @ts-expect-error */\nconst value: string = 1;'), 1);
});

test('countUnsafeSuppressions ignores directive-like text outside actual comments', () => {
  const text = [
    'const a = "// @ts-ignore";',
    'const b = `/* @ts-nocheck */`;',
    'const c = "// @ts-expect-error";',
  ].join('\n');
  assert.equal(countUnsafeSuppressions(text), 0);
});

function diagnosticCodes(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-source-floor-ts-'));
  const file = path.join(root, 'probe.ts');
  fs.writeFileSync(file, text);
  try {
    const program = ts.createProgram([file], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    });
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('scanner covers every TypeScript physical line terminator recognized by the compiler', () => {
  for (const terminator of ['\r', '\n', '\r\n', '\u2028', '\u2029']) {
    const suppressed = `// @ts-expect-error${terminator}const value: string = 1;`;
    const unsuppressed = `// ordinary comment${terminator}const value: string = 1;`;
    assert.equal(diagnosticCodes(suppressed).includes(2322), false, `directive should suppress across ${JSON.stringify(terminator)}`);
    assert.equal(diagnosticCodes(unsuppressed).includes(2322), true, `control should fail across ${JSON.stringify(terminator)}`);
    assert.equal(countUnsafeSuppressions(suppressed), 1, `scanner should count across ${JSON.stringify(terminator)}`);
  }
});

const MANIFEST_AT_ZERO = {
  $schema: FLOOR_SCHEMA,
  floors: {
    unsafeSuppressions: { max: 0 },
    floatingPromises: { max: 0, packages: [...ASYNC_SAFETY_PACKAGES] },
  },
};

test('evaluateFloor passes when measured equals the floor', () => {
  assert.deepEqual(evaluateFloor(0, MANIFEST_AT_ZERO), { ok: true, failures: [] });
  assert.deepEqual(evaluateFloor(3, { $schema: FLOOR_SCHEMA, floors: { unsafeSuppressions: { max: 3 } } }), {
    ok: true,
    failures: [],
  });
});

test('evaluateFloor fails closed when measured exceeds the floor', () => {
  const result = evaluateFloor(1, MANIFEST_AT_ZERO);
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /exceeds floor 0/);
});

test('evaluateFloor demands a ratchet-down when measured drops below the floor', () => {
  const result = evaluateFloor(1, { $schema: FLOOR_SCHEMA, floors: { unsafeSuppressions: { max: 3 } } });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /Ratchet the floor down/);
});

test('evaluateFloor fails closed on a malformed or wrong-schema manifest', () => {
  assert.equal(evaluateFloor(0, null).ok, false);
  assert.equal(evaluateFloor(0, {}).ok, false);
  assert.equal(evaluateFloor(0, { $schema: 'wrong', floors: { unsafeSuppressions: { max: 0 } } }).ok, false);
  assert.equal(evaluateFloor(0, { $schema: FLOOR_SCHEMA, floors: {} }).ok, false);
  assert.equal(
    evaluateFloor(0, { $schema: FLOOR_SCHEMA, floors: { unsafeSuppressions: { max: -1 } } }).ok,
    false,
  );
});

test('floating-Promise floor passes only at the exact measured zero ratchet', () => {
  assert.deepEqual(evaluateFloatingPromiseFloor(0, MANIFEST_AT_ZERO), {
    ok: true,
    failures: [],
  });
  assert.match(
    evaluateFloatingPromiseFloor(1, MANIFEST_AT_ZERO).failures[0],
    /exceeds floor 0/,
  );
  const stale = {
    ...MANIFEST_AT_ZERO,
    floors: {
      ...MANIFEST_AT_ZERO.floors,
      floatingPromises: {
        max: 1,
        packages: [...ASYNC_SAFETY_PACKAGES],
      },
    },
  };
  assert.match(evaluateFloatingPromiseFloor(0, stale).failures[0], /Ratchet/);
});

test('floating-Promise floor fails closed on package-scope drift', () => {
  const drifted = {
    ...MANIFEST_AT_ZERO,
    floors: {
      ...MANIFEST_AT_ZERO.floors,
      floatingPromises: { max: 0, packages: ['packages/broker'] },
    },
  };
  assert.match(
    evaluateFloatingPromiseFloor(0, drifted).failures[0],
    /packages must equal/,
  );
});

test('async-safety scope accepts the full gate or one canonical package only', () => {
  assert.deepEqual(parseAsyncSafetyScope([]), [...ASYNC_SAFETY_PACKAGES]);
  assert.deepEqual(
    parseAsyncSafetyScope(['--package', 'packages/broker']),
    ['packages/broker'],
  );
  assert.throws(
    () => parseAsyncSafetyScope(['--package', 'packages/unknown']),
    /usage:/,
  );
  assert.throws(() => parseAsyncSafetyScope(['--all']), /usage:/);
});

test('live production packages stay at the zero floating-Promise floor', () => {
  assert.deepEqual(collectFloatingPromises(process.cwd()), []);
});

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('tracked src/tmp and symlinked source are counted and a matching nonzero floor passes the CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-source-floor-e2e-'));
  try {
    const sourceDir = path.join(root, 'packages/docker-runner/src');
    fs.mkdirSync(path.join(sourceDir, 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/ops'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'tmp/probe.ts'), '// @ts-ignore\nconst first: string = 1;\n');
    fs.writeFileSync(path.join(sourceDir, 'hermes-symlink-target.txt'), '// @ts-ignore\nconst second: string = 2;\n');
    fs.symlinkSync('hermes-symlink-target.txt', path.join(sourceDir, 'hermes-symlink-probe.ts'));
    for (const packageRel of ASYNC_SAFETY_PACKAGES) {
      const packageRoot = path.join(root, packageRel);
      const packageSource = path.join(packageRoot, 'src');
      fs.mkdirSync(packageSource, { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            skipLibCheck: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      const probe = path.join(packageSource, 'async-safety-probe.ts');
      if (!fs.existsSync(probe)) fs.writeFileSync(probe, 'export const safe = true;\n');
    }
    fs.writeFileSync(
      path.join(root, 'docs/ops/source-quality-floors.json'),
      JSON.stringify({
        $schema: FLOOR_SCHEMA,
        floors: {
          unsafeSuppressions: { max: 2 },
          floatingPromises: { max: 0, packages: [...ASYNC_SAFETY_PACKAGES] },
        },
      }),
    );
    runGit(root, ['init', '-q']);
    runGit(root, ['add', '.']);

    const measured = collectMeasured(root);
    assert.equal(measured.measured, 2);
    assert.deepEqual(measured.offenders.map((entry) => entry.file), [
      'packages/docker-runner/src/hermes-symlink-probe.ts',
      'packages/docker-runner/src/tmp/probe.ts',
    ]);

    const cli = spawnSync(process.execPath, [CHECKER], { cwd: root, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /unsafe-suppressions=2\/2/);
    assert.match(cli.stdout, /hermes-symlink-probe\.ts: 1 unsafe suppression/);
    assert.match(cli.stdout, /source quality floor ok/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every package-only CI parity route scopes async analysis to that package', () => {
  for (const [surface, config] of Object.entries(PACKAGE_CI_SURFACES)) {
    assert.ok(
      config.commands.some(([command, args]) =>
        command === 'npm' &&
        args.join(' ') ===
          `run check:source-quality-floors -- --package ${config.packageDir}`),
      `${surface}: package CI parity must scope check:source-quality-floors`,
    );
  }
});

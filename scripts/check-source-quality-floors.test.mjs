import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  FLOOR_SCHEMA,
  classifyFile,
  collectMeasured,
  countUnsafeSuppressions,
  evaluateFloor,
} from './check-source-quality-floors.mjs';
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
  floors: { unsafeSuppressions: { max: 0 } },
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
    fs.writeFileSync(
      path.join(root, 'docs/ops/source-quality-floors.json'),
      JSON.stringify({
        $schema: FLOOR_SCHEMA,
        floors: { unsafeSuppressions: { max: 2 } },
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

test('every package-only CI parity route runs the root source-quality floor', () => {
  for (const [surface, config] of Object.entries(PACKAGE_CI_SURFACES)) {
    assert.ok(
      config.commands.some(([command, args]) =>
        command === 'npm' && args.join(' ') === 'run check:source-quality-floors'),
      `${surface}: package CI parity must run check:source-quality-floors`,
    );
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const inventoryPath = new URL('./npm-scripts-inventory.mjs', import.meta.url).pathname;

test('npm scripts inventory emits caller audit refs without reading package files as callers', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'npm-scripts-inventory-'));
  try {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'fixture-package',
      scripts: {
        build: 'tsc -p tsconfig.json',
        terminal_brief_sidecar_dry_run_gate: 'npm run build && node scripts/terminal-brief-sidecar-dry-run-gate.mjs',
        orchestration_intelligence_runtime_design_review: 'npm run build && node scripts/orchestration-intelligence-runtime-design-review.mjs',
      },
    }, null, 2));
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'runbook.md'), [
      '# Runbook',
      'Use `npm run terminal_brief_sidecar_dry_run_gate -- --json` before activation.',
      '',
    ].join('\n'));
    writeFileSync(join(tempDir, '.github', 'workflows', 'ci.yml'), [
      'name: ci',
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: npm run orchestration_intelligence_runtime_design_review -- --input fixture.json',
      '',
    ].join('\n'));

    const result = spawnSync(process.execPath, [inventoryPath, '--json', '--caller-audit'], {
      cwd: tempDir,
      env: { ...process.env, PACKAGE_JSON_PATH: join(tempDir, 'package.json'), REPO_ROOT: tempDir },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.summary.package, 'fixture-package');
    assert.equal(payload.summary.total, 3);
    assert.equal(payload.summary.callerAudit.totalCallerRefs, 2);

    const sidecar = payload.items.find((item) => item.name === 'terminal_brief_sidecar_dry_run_gate');
    assert.equal(sidecar.group, 'terminal_brief_sidecar');
    assert.equal(sidecar.callerRefCount, 1);
    assert.equal(sidecar.callerRefs[0].path, 'docs/runbook.md');

    const orchestration = payload.items.find((item) => item.name === 'orchestration_intelligence_runtime_design_review');
    assert.equal(orchestration.group, 'orchestration_intelligence');
    assert.equal(orchestration.callerRefCount, 1);
    assert.equal(orchestration.callerRefs[0].path, '.github/workflows/ci.yml');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

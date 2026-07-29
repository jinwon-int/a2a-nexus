#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(
  readFileSync(new URL('../fixtures/golden/manifest.json', import.meta.url), 'utf8'),
);
if (
  manifest?.schemaVersion !== 'a2a.policy-referee.golden-fixtures.v1' ||
  !Array.isArray(manifest.cases)
) {
  console.error('golden fixture replay failed: invalid manifest');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'a2a-policy-referee-fixtures-'));
try {
  for (const fixture of manifest.cases) {
    const policyPath = join(work, `${fixture.id}.policy.json`);
    const taskPath = join(work, `${fixture.id}.task.json`);
    const workerPath = join(work, `${fixture.id}.worker.json`);
    writeFileSync(policyPath, `${JSON.stringify(fixture.policy)}\n`);
    writeFileSync(taskPath, `${JSON.stringify(fixture.task)}\n`);
    writeFileSync(workerPath, `${JSON.stringify(fixture.worker)}\n`);

    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'check', policyPath, taskPath, workerPath],
      { encoding: 'utf8' },
    );
    const expectedStdout = `${JSON.stringify(fixture.expected.decision)}\n`;
    if (
      result.status !== fixture.expected.exitCode ||
      result.stdout !== expectedStdout ||
      result.stderr !== ''
    ) {
      console.error(`golden fixture replay failed: ${fixture.id}`);
      process.exit(1);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`golden fixture replay ok: ${manifest.cases.length} cases`);

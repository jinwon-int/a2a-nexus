import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SCRIPT = new URL('./pr-review-healthcheck.mjs', import.meta.url).pathname;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('pr-review-healthcheck', () => {
  it('prints usage without touching GitHub when --help is passed', () => {
    const output = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.match(output, /Usage: node scripts\/pr-review-healthcheck\.mjs/);
    assert.match(output, /Read-only by default/);
    assert.match(output, /GraphQL/);
    assert.match(output, /--stash/);
  });

  it('rejects unknown arguments', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--definitely-not-real'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /unknown argument/);
  });

  it('release-gate inventory wires this suite so it cannot orphan again', async () => {
    // a2a-nexus#1832: this suite passed standalone but ran nowhere. The
    // inventory step is the only runner; pin the wiring from inside.
    const inventory = JSON.parse(
      await readFile(join(REPO_ROOT, 'docs', 'ops', 'release-gate-step-inventory.json'), 'utf8'),
    );
    const entry = inventory.entries.find((step) =>
      step.args?.includes('scripts/pr-review-healthcheck.test.mjs'),
    );
    assert.ok(entry, 'release-gate inventory must run scripts/pr-review-healthcheck.test.mjs');
    assert.equal(entry.command, 'node');
    assert.ok(['core', 'public-readiness'].includes(entry.tier), 'the step must run on the default release-gate path');
  });
});

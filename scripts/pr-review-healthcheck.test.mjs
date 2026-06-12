import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const SCRIPT = new URL('./pr-review-healthcheck.mjs', import.meta.url).pathname;

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
});

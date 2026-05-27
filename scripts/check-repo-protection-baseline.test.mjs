/**
 * Tests for the repo protection baseline check script.
 *
 * Verifies that the check script runs without errors and produces
 * expected output format.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const scriptPath = './scripts/check-repo-protection-baseline.mjs';

describe('repo-protection-baseline check', () => {
  it('should run without throwing', () => {
    // The script may exit 1 if protections are missing (that's expected for some repos)
    // but it should not throw, crash, or hang
    let result;
    try {
      result = execFileSync('node', [scriptPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // Exit code 1 is acceptable (missing protections)
      result = e.stdout || '';
    }
    assert.ok(result, 'should produce output');
    assert.ok(result.includes('Repo Protection Baseline Check'), 'should include check header');
    assert.ok(
      result.includes('File-representable protections') || result.includes('file-representable'),
      'should list file-representable protections'
    );
    assert.ok(
      result.includes('Settings-change requirements') || result.includes('settings-change'),
      'should list settings-change requirements'
    );
    assert.ok(result.includes('NO-GO'), 'should state NO-GO for settings changes');
  });

  it('should exit 0 or 1 (not crash)', () => {
    let exitCode;
    try {
      execFileSync('node', [scriptPath], {
        encoding: 'utf8',
        stdio: 'ignore',
      });
      exitCode = 0;
    } catch (e) {
      exitCode = e.status;
    }
    assert.ok(exitCode === 0 || exitCode === 1, `exit code should be 0 or 1, got ${exitCode}`);
  });

  it('should reference the baseline doc', () => {
    const docExists = existsSync('./docs/release/repo-protection-baseline.md');
    assert.ok(docExists, 'docs/release/repo-protection-baseline.md should exist');
  });
});

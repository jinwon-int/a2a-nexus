/**
 * Tests for the repo protection baseline check script.
 *
 * Verifies that the check script runs without errors and produces
 * expected output format.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const scriptPath = './scripts/check-repo-protection-baseline.mjs';
const issueTemplateDir = './.github/ISSUE_TEMPLATE';

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
    // The script used to print a blanket "NO-GO" for the settings-change
    // section. It now reports each settings-only item as informational and
    // says explicitly that a file check cannot assert it — which is the
    // accurate contract, since branch protection lives in GitHub settings and
    // not in the tree. Assert that boundary is still stated rather than the
    // old verdict string, which went away when the script was rewritten and
    // left this assertion failing unnoticed (nothing runs this file in CI).
    assert.ok(
      result.includes('not asserted by this file check'),
      'should mark settings-only protections as outside what a file check can assert',
    );
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

  it('issue forms should use GitHub-renderable metadata', () => {
    const files = readdirSync(issueTemplateDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .filter((f) => f !== 'config.yml');
    assert.ok(files.length > 0, 'should have issue form YAML files');

    for (const file of files) {
      const body = readFileSync(join(issueTemplateDir, file), 'utf8');
      assert.match(body, /^name:\s*\S/m, `${file} should define name`);
      assert.match(body, /^description:\s*\S/m, `${file} should define description for GitHub Issue Forms`);
      assert.match(body, /^title:\s*".+"/m, `${file} should define a default title`);
      assert.doesNotMatch(body, /^about:/m, `${file} should not use legacy about metadata`);
      assert.match(body, /^body:\s*$/m, `${file} should define an Issue Form body`);
    }
  });

  it('current public-facing docs should not claim the repo remains private', () => {
    const currentDocs = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md'];
    const stalePatterns = [
      /remains private/i,
      /public-readiness prep/i,
      /when access is available/i,
      /not a repository visibility change/i,
      /before any future visibility change/i,
    ];

    for (const doc of currentDocs) {
      const text = readFileSync(doc, 'utf8');
      for (const pattern of stalePatterns) {
        assert.doesNotMatch(text, pattern, `${doc} should be updated for the public repository state`);
      }
    }
  });
});

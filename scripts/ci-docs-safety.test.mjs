import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const ciText = () => readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const packageJson = () => JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

test('docs/root-doc CI path runs markdown links and external secret scan', () => {
  const ci = ciText();
  assert.match(ci, /README\.md/);
  assert.match(ci, /SECURITY\.md/);
  assert.match(ci, /SUPPORT\.md/);
  assert.match(ci, /CONTRIBUTING\.md/);
  assert.match(ci, /npm run check:markdown-links/);
  assert.match(ci, /npm run scan:external-secrets/);
});

test('package exposes tracked markdown link validation script', () => {
  const scripts = packageJson().scripts ?? {};
  assert.equal(scripts['check:markdown-links'], 'node scripts/check-markdown-links.mjs');
});

test('external secret scan fails arbitrary test/dist findings instead of broad path allowlisting', () => {
  const temp = mkdtempSync(join(tmpdir(), 'external-secret-scan-'));
  try {
    mkdirSync(join(temp, 'bin'), { recursive: true });
    writeFileSync(join(temp, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
    const fake = join(temp, 'bin', 'gitleaks');
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('version')) process.exit(0);
const out = process.argv[process.argv.indexOf('--report-path') + 1];
fs.mkdirSync(require('node:path').dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify([
  { RuleID: 'generic-api-key', File: 'tests/leak.test.ts', StartLine: 1, Fingerprint: 'fixture-test' },
  { RuleID: 'generic-api-key', File: 'dist/leak.js', StartLine: 1, Fingerprint: 'fixture-dist' }
]));
process.exit(0);
`);
    chmodSync(fake, 0o755);
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/external-secret-scan.mjs')], {
      cwd: temp,
      env: { ...process.env, PATH: `${join(temp, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /gitleaks found 2 non-allowlisted finding/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('tracked markdown link checker rejects missing relative links', () => {
  const temp = mkdtempSync(join(tmpdir(), 'markdown-links-'));
  try {
    writeFileSync(join(temp, 'README.md'), '[missing](docs/missing.md)\n[external](https://example.com)\n');
    mkdirSync(join(temp, 'docs'), { recursive: true });
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/check-markdown-links.mjs')], {
      cwd: temp,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /README\.md:1 -> docs\/missing\.md/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

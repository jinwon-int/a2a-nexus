import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const ciText = () => readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const packageJson = () => JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const implementationPipelineText = () => readFileSync(join(repoRoot, 'docs/implementation-pipeline.md'), 'utf8');
const externalSecretScanText = () => readFileSync(join(repoRoot, 'scripts/external-secret-scan.mjs'), 'utf8');

test('docs/root-doc CI path runs markdown links and external secret scan', () => {
  const ci = ciText();
  assert.match(ci, /README\.md/);
  assert.match(ci, /SECURITY\.md/);
  assert.match(ci, /SUPPORT\.md/);
  assert.match(ci, /CONTRIBUTING\.md/);
  assert.match(ci, /npm run check:markdown-links/);
  assert.match(ci, /npm run scan:external-secrets/);
});

test('auto-merge squashes, because main requires linear history (#2050)', () => {
  const autoMerge = readFileSync(join(repoRoot, '.github/workflows/auto-merge.yml'), 'utf8');
  const mergeCommands = autoMerge.match(/gh pr merge[^\n]*/g) ?? [];
  assert.equal(mergeCommands.length, 1, 'expected exactly one gh pr merge invocation');
  const [command] = mergeCommands;
  assert.match(command, /--squash/);
  // `--merge` creates a merge commit, which main's required_linear_history
  // rejects. The workflow shipped with `--merge` from its first commit and
  // never hit the line, so nothing caught it until the repo review.
  assert.doesNotMatch(command, /(^|\s)--merge(\s|$)/);
  assert.doesNotMatch(command, /(^|\s)--rebase(\s|$)/);
});

// #2050 item 3. package.json declared `packageManager` while no workflow
// enforced or even checked it, so the npm CI ran was the image's npm by
// coincidence. `corepack enable` was rejected in favour of a zero-network
// assertion; these tests pin both halves of that decision — the assertion
// exists in the job every other ci.yml job depends on, and no setup-node block
// anywhere may float to a different Node line (a different Node line is what
// changes npm's major/minor and therefore its install semantics).
test('package.json declares packageManager as an exact npm version (#2050)', () => {
  const declared = packageJson().packageManager;
  assert.match(String(declared), /^npm@\d+\.\d+\.\d+$/);
});

test('ci.yml setup job asserts the running npm matches packageManager (#2050)', () => {
  const ci = ciText();
  const setupJob = ci.match(/\n {2}setup:\n[\s\S]*?(?=\n {2}[a-z][a-z0-9-]*:\n)/)?.[0];
  assert.ok(setupJob, 'expected a setup job in ci.yml');
  assert.match(setupJob, /enforce packageManager contract \(#2050\)/);
  assert.match(setupJob, /require\('\.\/package\.json'\)\.packageManager/);
  assert.match(setupJob, /npm --version/);
  // The assertion must be able to fail. A drift that only prints is the
  // warn-only failure mode this issue exists to remove.
  assert.match(setupJob, /declared_minor" != "\$running_minor"[\s\S]*?exit 1/);
  // No executable corepack step: the rejection of (a) is part of the contract,
  // not just a comment. Prose mentioning corepack in the rationale is fine.
  const executableLines = setupJob.split('\n').filter((line) => !/^\s*#/.test(line));
  assert.equal(
    executableLines.some((line) => /corepack/.test(line)),
    false,
    'setup job must not shell out to corepack',
  );
});

test('every setup-node block pins the same Node line, so npm cannot float (#2050)', () => {
  const workflowsDir = join(repoRoot, '.github/workflows');
  const files = readdirSync(workflowsDir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
  assert.ok(files.length > 0);
  const versions = new Set();
  let blocks = 0;
  for (const file of files) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    const matches = text.matchAll(/uses:\s*actions\/setup-node@[^\n]*\n(?:[^\n]*\n){0,4}?\s*node-version:\s*(\S+)/g);
    for (const match of matches) {
      blocks += 1;
      versions.add(match[1].replace(/^['"]|['"]$/g, ''));
    }
    const declarations = (text.match(/uses:\s*actions\/setup-node@/g) ?? []).length;
    assert.equal(
      (text.match(/node-version:/g) ?? []).length >= declarations,
      true,
      `${file}: every actions/setup-node block must declare node-version`,
    );
  }
  assert.ok(blocks > 0, 'expected at least one setup-node block');
  assert.deepEqual([...versions], ['22'], `setup-node node-version drift: ${[...versions].join(', ')}`);
});

test('package exposes tracked markdown link validation script', () => {
  const scripts = packageJson().scripts ?? {};
  assert.equal(scripts['check:markdown-links'], 'node scripts/check-markdown-links.mjs');
});

test('implementation verifier receives clean-slate inputs and re-derives its checks (#1596)', () => {
  const contract = implementationPipelineText();
  assert.match(contract, /Verifier clean-slate input boundary/);
  assert.match(contract, /original issue text and acceptance criteria/);
  assert.match(contract, /exact diff or immutable head under review/);
  assert.match(contract, /MUST NOT.*explorer note, implementation rationale/);
  assert.match(contract, /pre-derived checklist, expected verdict, confirm-the-answer wording/);
  assert.match(contract, /re-derives the failure mode, relevant call sites,\s+checks, and verdict/);
  assert.match(contract, /excluded from verifier input/);
});

test('headless pipeline waits for terminal gate results before completion (#1596)', () => {
  const contract = implementationPipelineText();
  assert.match(contract, /Headless gate completion boundary/);
  assert.match(contract, /run every declared\s+mandatory build, test, lint, or conformance gate in the foreground/);
  assert.match(contract, /wait for\s+its terminal exit code before the session terminates/);
  assert.match(contract, /MUST NOT.*report `PASS`, `Done`, `PR-ready`/);
  assert.match(contract, /backgrounded, detached, pending/);
  assert.match(contract, /pipeline result is `BLOCKED` or\s+`incomplete` and names the unfinished gate/);
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

test('external secret scan keeps exact fixture allowlisting only in the scanner script (#1928)', () => {
  const config = readFileSync(join(repoRoot, '.gitleaks.toml'), 'utf8');
  const scanner = externalSecretScanText();
  // Single source of truth: EXACT_SYNTHETIC_FIXTURE_FILES in the scanner
  // script decides allowlisted paths; a [[allowlists]] paths block in
  // .gitleaks.toml never reaches the exit decision (#1928).
  for (const fixture of [
    'packages/broker/src/server-live-task-admission.test.ts',
    'packages/broker/dist/server-live-task-admission.test.js',
  ]) {
    assert.ok(scanner.includes(`'${fixture}'`), `${fixture} missing from exact scanner allowlist`);
  }
  assert.doesNotMatch(config, /^paths\s*=/m, '.gitleaks.toml must not carry a paths allowlist; use EXACT_SYNTHETIC_FIXTURE_FILES in scripts/external-secret-scan.mjs');
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

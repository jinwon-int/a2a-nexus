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

test('required workflows accept queue events and pin path-filter comparison', () => {
  for (const file of ['ci.yml', 'codeql.yml', 'tck-promoted-gate.yml', 'finalizer-verdict-gate.yml']) {
    const text = readFileSync(join(repoRoot, '.github/workflows', file), 'utf8');
    const events = text.split('\non:\n')[1].split(/\n\S/)[0];
    assert.match(events, /^  merge_group:/m, file);
    assert.doesNotMatch(events, /^\s+paths(?:-ignore)?:/m, file);
    if (text.includes('dorny/paths-filter@')) {
      assert.match(text, /base: \$\{\{ github\.event\.merge_group\.base_sha \|\| github\.ref \}\}/, file);
      assert.match(text, /ref: \$\{\{ github\.event\.merge_group\.head_sha \|\| github\.ref \}\}/, file);
    }
  }
});

// Evaluate the checked-in two-term input expressions, not a parallel fixture
// configuration. dorny v4 selects before/last-commit only when branch inputs
// are equal; a branch name vs its SHA instead selects a zero merge-base diff.
function filterInputs(text, event) {
  return ['base', 'ref'].map((key) => {
    const expression = text.match(new RegExp(`^          ${key}: \\$\\{\\{ (.+) \\}\\}$`, 'm'))?.[1];
    assert.ok(expression, `missing ${key}`);
    return expression.split(' || ').map((term) => {
      assert.ok(Object.hasOwn(event, term), `unsupported input expression: ${term}`);
      return event[term];
    }).find(Boolean);
  });
}

function assertFilterEventMatrix(text) {
  const ordinary = {
    'github.event.merge_group.base_sha': '',
    'github.event.merge_group.head_sha': '',
    'github.ref': 'refs/heads/main',
    'github.sha': 'b'.repeat(40),
  };
  // On push, equal branch names select event.before; manual dispatch selects
  // the last commit. PR events keep the action's PR-files API (inputs ignored).
  for (const eventName of ['push', 'workflow_dispatch']) {
    assert.deepEqual(filterInputs(text, ordinary), ['refs/heads/main', 'refs/heads/main'], eventName);
  }
  assert.deepEqual(filterInputs(text, {
    ...ordinary,
    'github.event.merge_group.base_sha': 'a'.repeat(40),
    'github.event.merge_group.head_sha': 'c'.repeat(40),
    'github.ref': 'refs/heads/gh-readonly-queue/main/pr-1',
  }), ['a'.repeat(40), 'c'.repeat(40)]);
}

test('path-filter event matrix preserves push/manual and immutable queue comparisons', () => {
  for (const file of ['ci.yml', 'tck-promoted-gate.yml']) {
    const text = readFileSync(join(repoRoot, '.github/workflows', file), 'utf8');
    assertFilterEventMatrix(text);
    assert.throws(() => assertFilterEventMatrix(text.replace(
      'github.event.merge_group.head_sha || github.ref',
      'github.event.merge_group.head_sha || github.sha',
    )));
  }
});

function assertVerdictWorkflow(text) {
  const job = text.match(/^  finalizer-verdict-gate:\n[\s\S]*?(?=^  [\w-]+:\n|(?![\s\S]))/m)?.[0];
  assert.ok(job);
  // No job OR step skip conditions, including folded YAML expressions.
  assert.doesNotMatch(job, /^\s*if:|continue-on-error|--mode warn/m);
  assert.match(job, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(job, /--head-sha "\$HEAD_SHA"/);
  assert.match(job, /--mode enforce/);
  assert.match(job, /^          set -euo pipefail$/m);
  assert.match(job, /^            node scripts\/check-finalizer-verdict\.mjs "\$\{args\[@\]\}"$/m);
}

test('queue verdict workflow rejects skip conditions and swallowed verifier failures', () => {
  const text = readFileSync(join(repoRoot, '.github/workflows/finalizer-verdict-gate.yml'), 'utf8');
  assertVerdictWorkflow(text);
  assert.throws(() => assertVerdictWorkflow(text.replace(
    '  finalizer-verdict-gate:\n',
    "  finalizer-verdict-gate:\n    if: >-\n      github.event_name != 'merge_group'\n",
  )));
  assert.throws(() => assertVerdictWorkflow(text.replace(
    'node scripts/check-finalizer-verdict.mjs "${args[@]}"',
    'node scripts/check-finalizer-verdict.mjs "${args[@]}" || true',
  )));
});

test('auto-merge squashes, because main requires linear history (#2050)', () => {
  const autoMerge = readFileSync(join(repoRoot, '.github/workflows/auto-merge.yml'), 'utf8');
  const mergeCommands = autoMerge.match(/gh pr merge[^\n]*/g) ?? [];
  assert.equal(mergeCommands.length, 1, 'expected exactly one gh pr merge invocation');
  const [command] = mergeCommands;
  assert.match(command, /--squash/);
  assert.match(command, /--auto/);
  assert.match(command, /--match-head-commit "\$HEAD_SHA"/);
  assert.doesNotMatch(command, /--admin|--delete-branch/);
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
    // #2085: the scanner exports `git archive HEAD` to pin the scan to tracked
    // files, so the fixture needs a commit to scan.
    spawnSync('git', ['init', '-q'], { cwd: temp });
    spawnSync('git', ['-C', temp, 'config', 'user.email', 'fixture@example.invalid'], { cwd: temp });
    spawnSync('git', ['-C', temp, 'config', 'user.name', 'fixture'], { cwd: temp });
    spawnSync('git', ['-C', temp, 'add', '.'], { cwd: temp });
    spawnSync('git', ['-C', temp, 'commit', '-q', '-m', 'fixture'], { cwd: temp });
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

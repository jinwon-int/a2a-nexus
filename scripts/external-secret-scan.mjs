import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { partitionGitleaksFindings } from './lib/secret-scan-allowlist.mjs';

function hasCommand(command) {
  const versionArgs = command === 'gitleaks' ? ['version'] : ['--version'];
  return spawnSync(command, versionArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;
}

function runGitleaks() {
  // #2085: scan exactly the tracked tree, not the working directory.
  // `--no-git` ignores .gitignore, so a restored node_modules (38 MB) and
  // whichever build output happened to exist entered the scan surface — and
  // because package steps compile concurrently, whether dist/ was inside the
  // scan was a race, making the gate's input non-deterministic. Exporting
  // `git archive HEAD` pins the scan to tracked files: the result no longer
  // depends on untracked build artifacts lying around. Uncommitted files are
  // not scanned — CI always checks out a commit.
  mkdirSync('.tmp', { recursive: true });
  const scanDir = '.tmp/gitleaks-tracked-tree';
  rmSync(scanDir, { force: true, recursive: true });
  mkdirSync(scanDir, { recursive: true });
  const archive = spawnSync('git', ['archive', 'HEAD'], { maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) {
    console.error('git archive HEAD failed — cannot build the tracked-tree scan snapshot');
    process.exit(archive.status ?? 1);
  }
  const untar = spawnSync('tar', ['-x', '-C', scanDir], { input: archive.stdout, stdio: ['pipe', 'inherit', 'inherit'] });
  if (untar.status !== 0) {
    console.error('tar extraction of the tracked-tree snapshot failed');
    process.exit(untar.status ?? 1);
  }
  const reportPath = '.tmp/gitleaks-external-secret-scan.json';
  rmSync(reportPath, { force: true });
  const args = [
    'detect',
    '--source', scanDir,
    '--redact',
    '--no-banner',
    '--verbose',
    '--no-git',
    '--config', '.gitleaks.toml',
    '--report-format', 'json',
    '--report-path', reportPath,
    '--exit-code', '0',
  ];

  const result = spawnSync('gitleaks', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);

  let findings = [];
  try {
    const raw = readFileSync(reportPath, 'utf8').trim();
    findings = raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.error(`gitleaks report parse failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // Report paths are relative to --source, which is the tracked-tree snapshot;
  // strip the snapshot prefix so allowlist matching and fingerprints stay
  // identical to repo-relative paths.
  for (const finding of findings) {
    for (const key of ['File', 'file']) {
      if (typeof finding[key] === 'string') {
        finding[key] = finding[key].replace(/^\.tmp\/[\w-]+\//, '');
      }
    }
    if (typeof finding.Fingerprint === 'string') {
      finding.Fingerprint = finding.Fingerprint.replace(/^\.tmp\/[\w-]+\//, '');
    }
  }

  // #2256 A5: allowlisted by exact (file, RuleID) with a maximum count.
  const { allowed, disallowed, stale } = partitionGitleaksFindings(findings);
  for (const entry of stale) {
    console.warn(`gitleaks allowlist entry matched nothing (stale, remove it): ${entry.file} ${entry.rule}`);
  }
  if (disallowed.length > 0) {
    console.error(`gitleaks found ${disallowed.length} non-allowlisted finding(s)`);
    for (const finding of disallowed) {
      console.error(JSON.stringify({
        rule: finding.RuleID ?? finding.ruleID,
        file: finding.File ?? finding.file,
        line: finding.StartLine ?? finding.line,
        fingerprint: finding.Fingerprint ?? finding.fingerprint,
      }));
    }
    process.exit(1);
  }

  console.log(`gitleaks ok: ${findings.length} finding(s), ${allowed.length} exact synthetic fixture finding(s)`);
}

function runTrufflehog() {
  const result = spawnSync('trufflehog', ['filesystem', '.', '--only-verified', '--no-update'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const scanners = [];
if (hasCommand('gitleaks')) scanners.push({ name: 'gitleaks-filesystem', run: runGitleaks });
if (hasCommand('trufflehog')) scanners.push({ name: 'trufflehog-filesystem-verified', run: runTrufflehog });

if (scanners.length === 0) {
  console.error([
    'external secret/history scan blocked: no supported external scanner found.',
    'Install gitleaks or trufflehog in the operator environment, then re-run:',
    '  npm run scan:external-secrets',
    'This script intentionally fails closed instead of substituting the local public-readiness scanner for external evidence.',
  ].join('\n'));
  process.exit(1);
}

for (const scanner of scanners) {
  console.log(`external scan: ${scanner.name}`);
  scanner.run();
}

console.log('external secret/history scan ok');

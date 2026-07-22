import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function hasCommand(command) {
  const versionArgs = command === 'gitleaks' ? ['version'] : ['--version'];
  return spawnSync(command, versionArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;
}

const EXACT_SYNTHETIC_FIXTURE_FILES = new Set([
  'packages/broker/dist/core/orchestration-intelligence-worker-subagent-spawn-bridge.test.js',
  'packages/broker/dist/github/handoff-receiver.test.js',
  'packages/broker/scripts/round-coordinator-closeout-dry-run.test.mjs',
  'packages/broker/src/core/orchestration-intelligence-worker-subagent-spawn-bridge.test.ts',
  'packages/broker/src/github/handoff-receiver.test.ts',
  'packages/broker/src/server-live-task-admission.test.ts',
  'packages/broker/dist/server-live-task-admission.test.js',
  'packages/docker-runner/dist/engine-contract.test.js',
  'packages/docker-runner/src/engine-contract.test.ts',
  'packages/docker-runner/dist/github-evidence.test.js',
  'packages/docker-runner/src/github-evidence.test.ts',
  'packages/docker-runner/dist/runner-manifest.test.js',
  'packages/docker-runner/src/runner-manifest.test.ts',
  'packages/docker-runner/dist/scanner.test.js',
  'packages/docker-runner/src/scanner.test.ts',
  'packages/openclaw-plugin-a2a/tests/cross-broker-terminal-relay.test.ts',
  'packages/openclaw-plugin-a2a/tests/proposal-marker-bridge.test.ts',
]);

function isAllowedGitleaksFinding(finding) {
  const file = String(finding.File ?? finding.file ?? '').replace(/^\.\//, '');

  // NOTE: never allowlist on the Secret field — the scan runs with --redact,
  // which rewrites every finding's Secret to "REDACTED", so a secret-based
  // allowlist would accept every finding and neutralize the gate.
  // Do not allowlist by broad path (dist/, tests/, *.test.*). A real
  // credential pasted into generated output or a fixture must still fail the
  // public-source gate unless it is listed as an exact synthetic fixture here.
  return EXACT_SYNTHETIC_FIXTURE_FILES.has(file);
}

function runGitleaks() {
  mkdirSync('.tmp', { recursive: true });
  const reportPath = '.tmp/gitleaks-external-secret-scan.json';
  rmSync(reportPath, { force: true });
  const args = [
    'detect',
    '--source', '.',
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

  const disallowed = findings.filter((finding) => !isAllowedGitleaksFinding(finding));
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

  console.log(`gitleaks ok: ${findings.length} finding(s), ${findings.length - disallowed.length} exact synthetic fixture finding(s)`);
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

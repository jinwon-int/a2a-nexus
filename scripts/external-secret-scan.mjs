import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function hasCommand(command) {
  const versionArgs = command === 'gitleaks' ? ['version'] : ['--version'];
  return spawnSync(command, versionArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;
}

function isAllowedGitleaksFinding(finding) {
  const file = String(finding.File ?? finding.file ?? '');
  const secret = String(finding.Secret ?? finding.secret ?? '');

  if (secret === 'REDACTED') return true;
  if (/(^|\/)dist\//.test(file)) return true;
  if (/(^|\/)(?:test|tests|__tests__)\//.test(file)) return true;
  if (/\.(?:test|spec)\.(?:ts|mts|cts|js|mjs|cjs)$/.test(file)) return true;

  return false;
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

  console.log(`gitleaks ok: ${findings.length} finding(s), ${findings.length - disallowed.length} allowlisted synthetic finding(s)`);
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

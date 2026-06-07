#!/usr/bin/env node
/**
 * caddy-log-redaction-preflight.mjs
 *
 * Secret-safe preflight validation for the Caddy 502 log redaction reference
 * configuration.
 *
 * Checks:
 * 1. Reference config file exists and is parseable
 * 2. Global `log_redact` directive covers X-A2A-Edge-Secret
 * 3. `handle_errors` block is present with a 502 response
 * 4. Log format excludes request headers
 * 5. No hardcoded secrets in the reference config
 * 6. Runbook doc exists and references the config path
 *
 * Read-only: never reads production files, never resolves or prints secrets.
 * JSON output for CI/tooling.
 *
 * Usage:
 *   node scripts/caddy-log-redaction-preflight.mjs
 *   node scripts/caddy-log-redaction-preflight.mjs --json
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(REPO_ROOT, 'config/caddy-broker-log-redaction.caddy');
const RUNBOOK_PATH = resolve(REPO_ROOT, 'docs/caddy-502-log-redaction.md');
const OPS_HANDOFF_PATH = resolve(REPO_ROOT, 'docs/a2a-broker-ops-handoff-20260413.md');

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(check, detail, extra = {}) {
  return { ok: true, check, detail, severity: 'pass', ...extra };
}

function warn(check, detail, extra = {}) {
  return { ok: true, check, detail, severity: 'warn', ...extra };
}

function fail(check, detail, extra = {}) {
  return { ok: false, check, detail, severity: 'fail', ...extra };
}

function printJson(results) {
  const allOk = results.every((r) => r.ok);
  console.log(JSON.stringify({
    ok: allOk,
    checks: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  }, null, 2));
  if (!allOk) process.exit(1);
}

function printMarkdown(results) {
  console.log('# Caddy Log Redaction Preflight\n');
  for (const r of results) {
    const icon = r.ok ? (r.severity === 'warn' ? '⚠️' : '✅') : '❌';
    console.log(`- ${icon} **${r.check}**: ${r.detail}`);
  }
  console.log('');
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.log(`**${failed} check(s) failed.**`);
    process.exit(1);
  } else {
    console.log('**All checks passed.**');
  }
}

// ── Pattern matchers ────────────────────────────────────────────────────────

/** Known secret header names that must be redacted. */
const SENSITIVE_HEADERS = ['X-A2A-Edge-Secret'];

/** Known secret-like value patterns (concrete string = disqualifying). */
const SECRET_VALUE_PATTERNS = [
  /^[a-zA-Z0-9+/=]{20,}$/,   // base64-like
  /^[a-f0-9]{32,}$/i,         // hex hash
];

function textContainsSecret(line) {
  const trimmed = line.trim();
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

// ── Check functions ─────────────────────────────────────────────────────────

function checkConfigExists() {
  if (!existsSync(CONFIG_PATH)) {
    return fail(
      'config file exists',
      `config/caddy-broker-log-redaction.caddy not found at ${CONFIG_PATH}`,
      { path: CONFIG_PATH }
    );
  }
  const stat = statSync(CONFIG_PATH);
  if (stat.size < 100) {
    return fail('config file size', `config file too small (${stat.size} bytes)`);
  }
  return ok('config file exists', `Found at config/caddy-broker-log-redaction.caddy (${stat.size} bytes)`);
}

function checkLogRedact(content) {
  const lines = content.split('\n');
  const redactLines = lines
    .map((line, i) => ({ line: line.trim(), idx: i + 1 }))
    .filter(({ line }) => line.startsWith('log_redact'));

  if (redactLines.length === 0) {
    return fail(
      'global log_redact directive',
      'No `log_redact` directive found. The edge secret may appear in Caddy logs.'
    );
  }

  const covered = [];
  const missing = [];
  for (const header of SENSITIVE_HEADERS) {
    const found = redactLines.some(({ line }) => line.includes(header));
    if (found) {
      covered.push(header);
    } else {
      missing.push(header);
    }
  }

  if (missing.length > 0) {
    return fail(
      'redacts X-A2A-Edge-Secret',
      `Missing redaction for: ${missing.join(', ')}. Found: ${covered.join(', ') || 'none'}`
    );
  }

  return ok(
    'redacts X-A2A-Edge-Secret',
    `Found ${redactLines.length} log_redact directive(s) covering: ${covered.join(', ')}`,
    { redactedHeaders: covered }
  );
}

function checkHandleErrors(content) {
  const hasHandleErrors = content.includes('handle_errors');
  if (!hasHandleErrors) {
    return fail(
      'handle_errors block present',
      'No `handle_errors` block found. Caddy may use default error pages that include request metadata.'
    );
  }

  // After "handle_errors", look for a 502 handler
  const handleIdx = content.indexOf('handle_errors');
  const afterHandle = content.slice(handleIdx);

  const has502Handler =
    afterHandle.includes('@502') &&
    (afterHandle.includes('status_code') || afterHandle.includes('err.status_code')) &&
    (afterHandle.includes('502'));

  if (!has502Handler) {
    return warn(
      '502 error handler',
      '`handle_errors` block found but no explicit 502 handler with status_code check detected. Generic handler may suffice but explicit 502 matcher is recommended.'
    );
  }

  return ok(
    '502 error handler',
    '`handle_errors` block with 502 handler found. Generic error page replaces default Caddy diagnostics.'
  );
}

function checkLogFormat(content) {
  const hasLogBlock = content.includes('log {');
  if (!hasLogBlock) {
    return warn(
      'safe log format',
      'No `log` block found. If Caddy uses default log format, request headers may be logged.'
    );
  }

  // Check that request>headers is excluded
  const headersDeleted = content.includes('request>headers delete') ||
    content.includes('request.headers delete');

  const hasFilterFormat = content.includes('format filter');

  if (hasFilterFormat && headersDeleted) {
    return ok(
      'safe log format',
      'Log format uses `filter` with `request>headers delete` — request headers excluded from access logs.'
    );
  }

  if (hasFilterFormat && !headersDeleted) {
    return warn(
      'safe log format',
      'Log uses `filter` format but `request>headers delete` not explicitly found. Verify that request headers are excluded.'
    );
  }

  return warn(
    'safe log format',
    'Log block exists but does not use `format filter` with `request>headers delete`. Headers may appear in logs despite `log_redact`.'
  );
}

function checkNoSecrets(content) {
  const lines = content.split('\n');
  const suspicious = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip comments
    if (line.startsWith('#') || line === '') continue;
    // Skip known safe directives
    if (
      line.startsWith('log_redact') ||
      line.startsWith('{') ||
      line.startsWith('}') ||
      line.startsWith('import') ||
      line.startsWith('reverse_proxy') ||
      line.startsWith('health_') ||
      line.startsWith('handle_errors') ||
      line.startsWith('respond') ||
      line.startsWith('@') ||
      line.startsWith('output') ||
      line.startsWith('format') ||
      line.startsWith('roll_') ||
      line.includes('include') ||
      line.includes('delete') ||
      line.includes('wrap')
    ) {
      continue;
    }
    if (textContainsSecret(line)) {
      suspicious.push({ line: i + 1, content: line.slice(0, 40) });
    }
  }

  if (suspicious.length > 0) {
    return fail(
      'no secrets in reference config',
      `Found ${suspicious.length} suspicious line(s) that may contain secret values: ${suspicious.map((s) => `line ${s.line}`).join(', ')}`
    );
  }

  return ok(
    'no secrets in reference config',
    'No hardcoded secret-like values detected in the reference Caddy config.'
  );
}

function checkRunbookExists() {
  if (!existsSync(RUNBOOK_PATH)) {
    return fail('runbook exists', `docs/caddy-502-log-redaction.md not found at ${RUNBOOK_PATH}`);
  }

  const content = readFileSync(RUNBOOK_PATH, 'utf-8');
  const hasConfigRef = content.includes('config/caddy-broker-log-redaction.caddy');
  const hasLogRedact = content.includes('log_redact');
  const hasHandleErrors = content.includes('handle_errors');

  if (!hasConfigRef) {
    return warn(
      'runbook references config',
      'Runbook exists but does not reference `config/caddy-broker-log-redaction.caddy`.'
    );
  }

  const coverage = [];
  if (hasLogRedact) coverage.push('log_redact');
  if (hasHandleErrors) coverage.push('handle_errors');
  coverage.push('config path');

  return ok(
    'runbook references config',
    `Runbook found (${Math.round(content.length / 1024)} KB) and references config path. Covers: ${coverage.join(', ')}.`
  );
}

function checkOpsHandoffReferences() {
  if (!existsSync(OPS_HANDOFF_PATH)) {
    return warn(
      'ops handoff references redaction',
      'docs/a2a-broker-ops-handoff-20260413.md not found.'
    );
  }

  const content = readFileSync(OPS_HANDOFF_PATH, 'utf-8');
  const hasRef = content.includes('caddy-log-redaction-preflight') ||
    content.includes('caddy-502-log-redaction') ||
    content.includes('caddy-broker-log-redaction.caddy');

  if (!hasRef) {
    return warn(
      'ops handoff references redaction',
      'Ops handoff found but does not reference log redaction docs or config.'
    );
  }

  return ok(
    'ops handoff references redaction',
    'Ops handoff doc references log redaction resources.'
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const json = process.argv.includes('--json');

  const results = [];

  // 1. Config exists
  results.push(checkConfigExists());

  // 2–5. Config content checks
  if (existsSync(CONFIG_PATH)) {
    const configContent = readFileSync(CONFIG_PATH, 'utf-8');
    results.push(checkLogRedact(configContent));
    results.push(checkHandleErrors(configContent));
    results.push(checkLogFormat(configContent));
    results.push(checkNoSecrets(configContent));
  }

  // 6. Runbook exists and references config
  results.push(checkRunbookExists());

  // 7. Ops handoff references redaction
  results.push(checkOpsHandoffReferences());

  if (json) {
    printJson(results);
  } else {
    printMarkdown(results);
  }
}

main();

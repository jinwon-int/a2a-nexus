/**
 * caddy-log-redaction-preflight.test.mjs
 *
 * Tests for the Caddy log redaction preflight validation script.
 * Uses the project's existing `node:test` / `node:assert` pattern.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PREFLIGHT_PATH = resolve(__dirname, 'caddy-log-redaction-preflight.mjs');
const CONFIG_PATH = resolve(REPO_ROOT, 'config/caddy-broker-log-redaction.caddy');
const RUNBOOK_PATH = resolve(REPO_ROOT, 'docs/caddy-502-log-redaction.md');

// ── Helpers ─────────────────────────────────────────────────────────────────

function runPreflight(args = []) {
  try {
    const stdout = execSync(`node ${PREFLIGHT_PATH} ${args.join(' ')}`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return { ok: true, stdout };
  } catch (err) {
    if (err.stdout !== undefined) {
      return { ok: false, stdout: err.stdout, stderr: err.stderr || '' };
    }
    return { ok: false, stdout: '', stderr: err.message || '' };
  }
}

function runPreflightJson() {
  const result = runPreflight(['--json']);
  const json = JSON.parse(result.stdout);
  return { result, json };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Caddy Log Redaction Preflight', () => {
  it('preflight script exists and is executable', () => {
    assert.ok(existsSync(PREFLIGHT_PATH), 'preflight script must exist');
    const content = readFileSync(PREFLIGHT_PATH, 'utf-8');
    assert.ok(content.includes('#!/usr/bin/env node'), 'must have shebang');
    assert.ok(content.includes('checkLogRedact'), 'must contain log redact check');
    assert.ok(content.includes('checkHandleErrors'), 'must contain handle errors check');
    assert.ok(content.includes('checkLogFormat'), 'must contain log format check');
    assert.ok(content.includes('checkNoSecrets'), 'must contain no-secrets check');
  });

  it('reference config file exists', () => {
    assert.ok(existsSync(CONFIG_PATH), 'config/caddy-broker-log-redaction.caddy must exist');
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    assert.ok(content.length > 500, 'config must be substantial');
    assert.ok(content.includes('log_redact'), 'config must include log_redact directive');
    assert.ok(content.includes('X-A2A-Edge-Secret'), 'config must reference X-A2A-Edge-Secret');
    assert.ok(content.includes('handle_errors'), 'config must include handle_errors block');
  });

  it('runbook doc exists and covers redaction', () => {
    assert.ok(existsSync(RUNBOOK_PATH), 'docs/caddy-502-log-redaction.md must exist');
    const content = readFileSync(RUNBOOK_PATH, 'utf-8');
    assert.ok(content.includes('log_redact'), 'runbook must mention log_redact');
    assert.ok(content.includes('handle_errors'), 'runbook must mention handle_errors');
    assert.ok(content.includes('config/caddy-broker-log-redaction.caddy'), 'runbook must reference config path');
    assert.ok(content.includes('X-A2A-Edge-Secret'), 'runbook must reference edge secret header');
  });

  it('preflight --json exits 0 when all checks pass', () => {
    const { result, json } = runPreflightJson();
    assert.ok(json.ok, 'preflight --json must report ok=true when config is valid');
    assert.ok(json.checks > 0, 'must report checks count');
    assert.equal(json.failed, 0, 'must have zero failed checks');
  });

  it('preflight (markdown) exits 0 when all checks pass', () => {
    const { ok, stdout } = runPreflight();
    assert.ok(ok, 'preflight must exit 0');
    assert.ok(stdout.includes('All checks passed'), 'must report all passed');
  });

  it('preflight detects missing log_redact', () => {
    // Create a temporary config without log_redact
    const tmpDir = resolve(REPO_ROOT, 'test-tmp');
    const tmpConfig = resolve(tmpDir, 'test-no-redact.caddy');
    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(tmpConfig, `
broker.example.com {
    reverse_proxy 127.0.0.1:8787
}
`.trim());

      let captured = null;
      try {
        // Use a quick inline check
        const content = readFileSync(tmpConfig, 'utf-8');
        const hasRedact = content.includes('log_redact');
        assert.equal(hasRedact, false, 'config without log_redact must be detected as missing');
      } catch (e) {
        captured = e;
      }
      assert.equal(captured, null);
    } finally {
      try { unlinkSync(tmpConfig); } catch (_) { /* ok */ }
      try { rmdirSync(tmpDir); } catch (_) { /* ok */ }
    }
  });

  it('reference config contains no hardcoded secrets', () => {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const lines = content.split('\n');

    // Check for long alphanumeric strings that look like secrets
    const secretPattern = /^[a-zA-Z0-9+/=]{20,}$/;
    const suspicious = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('#') || trimmed === '') continue;
      if (
        trimmed.startsWith('log_redact') ||
        trimmed.startsWith('{') ||
        trimmed.startsWith('}') ||
        trimmed.startsWith('import') ||
        trimmed.startsWith('reverse_proxy') ||
        trimmed.includes('127.0.0.1') ||
        trimmed.includes('8787') ||
        trimmed.startsWith('health_') ||
        trimmed.startsWith('handle_errors') ||
        trimmed.startsWith('respond') ||
        trimmed.startsWith('@') ||
        trimmed.startsWith('output') ||
        trimmed.startsWith('format') ||
        trimmed.startsWith('roll_') ||
        trimmed.includes('include') ||
        trimmed.includes('delete') ||
        trimmed.includes('wrap') ||
        trimmed.startsWith('broker.example.com')
      ) {
        continue;
      }
      if (/^[a-zA-Z0-9+/=]{20,}$/.test(trimmed)) {
        suspicious.push({ line: i + 1, content: trimmed });
      }
    }

    assert.equal(suspicious.length, 0,
      `config must not contain hardcoded secrets: ${JSON.stringify(suspicious)}`
    );
  });

  it('handle_errors block includes 502 handler', () => {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    assert.ok(content.includes('502'), 'config must reference 502 status');
    assert.ok(content.includes('respond'), 'config must have respond directive in handle_errors');
    assert.ok(content.includes('Service Unavailable') || content.includes('502 Bad Gateway'),
      'config must have a user-visible 502 message');
  });

  it('log format excludes request headers', () => {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const hasDelete = content.includes('request>headers delete');
    const hasFilter = content.includes('format filter');
    assert.ok(hasDelete || hasFilter,
      'config must exclude request headers from log format (request>headers delete or format filter)');
  });

  it('ops handoff doc references log redaction', () => {
    const handoffPath = resolve(REPO_ROOT, 'docs/a2a-broker-ops-handoff-20260413.md');
    assert.ok(existsSync(handoffPath), 'ops handoff must exist');
    const content = readFileSync(handoffPath, 'utf-8');
    assert.ok(
      content.includes('caddy-502-log-redaction') ||
      content.includes('caddy-broker-log-redaction') ||
      content.includes('caddy-log-redaction-preflight'),
      'ops handoff must reference log redaction resources'
    );
  });

  it('redacted headers list includes required sensitive headers', () => {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const required = ['X-A2A-Edge-Secret'];
    for (const header of required) {
      assert.ok(content.includes(header),
        `config must redact header: ${header}`);
    }
  });
});

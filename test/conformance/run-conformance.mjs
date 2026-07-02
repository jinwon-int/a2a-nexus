#!/usr/bin/env node
// Parallel runner for the public-safe A2A Nexus contract-conformance suite.
//
// The explicit check allowlist is intentionally stable: it exposes local
// fixture/contract validators that require no production broker URL, edge
// secret, provider token, Telegram configuration, database mutation,
// deploy/restart, live send, or Terminal Brief ACK/replay.
//
// check-a2a-tck-plan.mjs and public-readiness-go-nogo.test.mjs are
// intentionally NOT part of this conformance command. They are planning / release
// decision surfaces, not a third-party worker/broker compatibility check.

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

export const SCHEMA_VERSION = 'a2a-nexus-conformance.v1';

export const CHECKS = [
  'check-contract-fixtures.mjs',
  'check-terminal-evidence-ack-boundary.mjs',
  'check-platform-adapter-interface.mjs',
  'check-adapter-conformance-matrix.mjs',
  'check-a2ad-review-mode.mjs',
  'check-canonical-progress-validation-matrix.mjs',
  'check-github-evidence-projection.mjs',
  'check-terminal-brief-canary-acceptance.mjs',
  'check-terminal-brief-core-contract.mjs',
  'check-trace-propagation.mjs',
  'check-three-component-e2e.mjs',
];

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function runCheck(file, { baseDir = HERE, cwd = process.cwd() } = {}) {
  return new Promise((resolveCheck) => {
    const startedAt = nowMs();
    const child = spawn(process.execPath, [join(baseDir, file)], { cwd });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => {
      resolveCheck({
        name: file,
        status: 'fail',
        exitCode: 1,
        durationMs: Math.max(0, nowMs() - startedAt),
        output: `${err.message}\n`,
      });
    });
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      resolveCheck({
        name: file,
        status: exitCode === 0 ? 'pass' : 'fail',
        exitCode,
        durationMs: Math.max(0, nowMs() - startedAt),
        output: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
}

export async function runChecks(checks = CHECKS, opts = {}) {
  const startedAt = nowMs();
  const results = await Promise.all(checks.map((file) => runCheck(file, opts)));
  const failedChecks = results.filter((r) => r.status !== 'pass');
  const exitCode = failedChecks.length > 0 ? (failedChecks[0].exitCode || 1) : 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: failedChecks.length === 0,
    total: results.length,
    passed: results.length - failedChecks.length,
    failed: failedChecks.length,
    durationMs: Math.max(0, nowMs() - startedAt),
    exitCode,
    checks: results,
    safety: {
      sourceOnly: true,
      noLive: true,
      productionBrokerRequired: false,
      providerSend: false,
      telegramSend: false,
      databaseMutation: false,
      terminalAckReplay: false,
      deployOrRestart: false,
      secretRequired: false,
    },
  };
}

export function renderHuman(result) {
  const lines = [];
  for (const check of result.checks) {
    lines.push(`conformance: ${check.name}${check.status === 'pass' ? '' : ' (FAILED)'}`);
    if (check.output.length) lines.push(check.output.endsWith('\n') ? check.output.slice(0, -1) : check.output);
  }
  if (!result.ok) {
    lines.push(`conformance: ${result.failed} check(s) failed`);
  } else {
    lines.push(`conformance ok: ${result.total} checks`);
  }
  return `${lines.join('\n')}\n`;
}

function printUsage() {
  console.log(`Usage: node test/conformance/run-conformance.mjs [--list] [--json]\n\nPublic-safe local A2A Nexus conformance runner. No production broker credentials, live provider sends, DB mutation, deploy/restart, or Terminal Brief ACK/replay are required.\n\nOptions:\n  --list   Print the stable check allowlist and exit.\n  --json   Emit one machine-readable JSON summary object.\n`);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return 0;
  }
  if (argv.includes('--list')) {
    for (const check of CHECKS) console.log(check);
    return 0;
  }
  const jsonMode = argv.includes('--json');
  const result = await runChecks(CHECKS, { baseDir: HERE, cwd: resolve(HERE, '../..') });
  if (jsonMode) {
    const publicResult = {
      ...result,
      checks: result.checks.map((check) => ({
        name: check.name,
        status: check.status,
        exitCode: check.exitCode,
        durationMs: check.durationMs,
        ...(check.status === 'fail' ? { output: check.output } : {}),
      })),
    };
    console.log(JSON.stringify(publicResult, null, 2));
  } else {
    process.stdout.write(renderHuman(result));
  }
  return result.exitCode;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === THIS_FILE;
if (invokedDirectly) {
  const exitCode = await main();
  process.exit(exitCode);
}

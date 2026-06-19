#!/usr/bin/env node
// Parallel runner for the contract-conformance suite (perf follow-up).
//
// Previously `test:conformance` chained ten independent `node` validators with
// `&&`, paying a fresh process start serially for each. They share no mutable
// state — every check reads fixtures/contracts and asserts — so they are run
// concurrently here. Output is buffered per check and flushed in the listed
// order once all finish so logs stay deterministic and readable.
//
// The explicit list is preserved verbatim from the historical chain:
// check-a2a-tck-plan.mjs and public-readiness-go-nogo.test.mjs are
// intentionally NOT part of test:conformance and stay excluded here.
//
// Safety: read-only validators. No deploy/restart/live-send/ACK/DB mutation.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CHECKS = [
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
];

function runCheck(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, file)], { cwd: process.cwd() });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => resolve({ file, status: 1, output: `${err.message}\n` }));
    child.on('close', (code) =>
      resolve({ file, status: code ?? 1, output: Buffer.concat(chunks).toString('utf8') }),
    );
  });
}

const results = await Promise.all(CHECKS.map(runCheck));

let failed = 0;
for (const { file, status, output } of results) {
  console.log(`conformance: ${file}${status === 0 ? '' : ' (FAILED)'}`);
  if (output.length) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  if (status !== 0) failed = status;
}

if (failed !== 0) {
  console.error(`conformance: ${results.filter((r) => r.status !== 0).length} check(s) failed`);
  process.exit(failed);
}

console.log(`conformance ok: ${CHECKS.length} checks`);

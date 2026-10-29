#!/usr/bin/env node
/**
 * Coverage floors for a2a-review-lifecycle (#2477, #2454 decision record §3).
 * The engine moved verbatim out of packages/broker/src/review-lifecycle; the
 * floors pin the line coverage measured right after the move (2026-10-29),
 * rounded down with a small margin, so they only ratchet upward. The
 * canonical-json golden vectors and the fixtures/review-lifecycle/ replays are
 * the behavioral anchors; these floors guard against coverage-eroding
 * refactors of the wire-contract modules.
 * Safety: local build/test only. No network, no writes outside dist.
 */
import { spawnSync } from 'node:child_process';

const FLOORS = new Map([
  ['canonical-json.js', 95], // measured 96.43
  ['lifecycle.js', 94], // measured 95.55
  ['observation.js', 92], // measured 94.37
  ['enforcement.js', 93], // measured 94.96
  ['source-carrier.js', 94], // measured 96.02
  ['producer-contract.js', 94], // measured 95.60
  ['privacy-retention.js', 92], // measured 93.91
  ['scorecard.js', 91], // measured 93.37
]);

const run = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', '--experimental-test-coverage', 'dist/*.test.js'],
  { encoding: 'utf8', shell: false },
);
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
if (run.status !== 0) {
  console.error(output);
  process.exit(run.status ?? 1);
}
const lines = output.split('\n');
const failures = [];
for (const [file, floor] of FLOORS) {
  const escaped = file.replace(/[.]/g, '\\.');
  const pattern = new RegExp(`(?:^|\\s)${escaped}\\s+\\|\\s+([\\d.]+)`);
  const match = lines.map((entry) => entry.match(pattern)).find(Boolean);
  const pct = Number(match?.[1]);
  if (!match || !Number.isFinite(pct)) {
    failures.push(`${file}: coverage row missing`);
  } else if (pct < floor) {
    failures.push(`${file}: ${pct}% < ${floor}%`);
  }
}
if (failures.length) {
  console.error(`coverage floor: ${failures.join('; ')}`);
  process.exit(1);
}
console.log(`coverage floor ok: ${FLOORS.size} modules at or above floor`);

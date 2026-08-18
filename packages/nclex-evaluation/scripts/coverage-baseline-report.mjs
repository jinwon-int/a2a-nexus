#!/usr/bin/env node
/**
 * Coverage floor for a2a-nclex-evaluation (#1601 first slice): pins the
 * receipt-contract.js line coverage measured when the module moved out of the
 * broker core (87.01%), at a conservative floor (85%). The golden JCS vectors
 * in receipt-contract.test.js are the behavioral anchor; this floor guards
 * against coverage-eroding refactors of the verification path.
 * Safety: local build/test only. No network, no writes outside dist.
 */
import { spawnSync } from 'node:child_process';

const FLOOR = 85;
const run = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', '--experimental-test-coverage', 'dist/receipt-contract.test.js'],
  { encoding: 'utf8' },
);
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
if (run.status !== 0) {
  console.error(output);
  process.exit(run.status ?? 1);
}
const line = output.split('\n').find((entry) => /receipt-contract\.js\s+\|/.test(entry));
const match = line?.match(/receipt-contract\.js\s+\|\s*([\d.]+)/);
const pct = Number(match?.[1]);
if (!line || !Number.isFinite(pct)) {
  console.error('coverage floor: receipt-contract.js row missing from coverage report');
  process.exit(1);
}
if (pct < FLOOR) {
  console.error(`coverage floor: receipt-contract.js ${pct}% < ${FLOOR}%`);
  process.exit(1);
}
console.log(`coverage floor ok: receipt-contract.js ${pct}% >= ${FLOOR}%`);

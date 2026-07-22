#!/usr/bin/env node
/**
 * Coverage floor for a2a-policy-referee (#1601 P1): preserves the broker-era
 * broker-policy.js line floor (84%) after the package extraction.
 * Safety: local build/test only. No network, no writes outside dist.
 */
import { spawnSync } from 'node:child_process';

const FLOOR = 84;
const run = spawnSync(
  process.execPath,
  ['--test', '--experimental-test-coverage', 'dist/broker-policy.test.js'],
  { encoding: 'utf8' },
);
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
if (run.status !== 0) {
  console.error(output);
  process.exit(run.status ?? 1);
}
const line = output.split('\n').find((entry) => entry.includes('broker-policy.js |'));
const match = line?.match(/broker-policy\.js\s+\|\s+([\d.]+)/);
const pct = Number(match?.[1]);
if (!line || !Number.isFinite(pct)) {
  console.error('coverage floor: broker-policy.js row missing from coverage report');
  process.exit(1);
}
if (pct < FLOOR) {
  console.error(`coverage floor: broker-policy.js ${pct}% < ${FLOOR}%`);
  process.exit(1);
}
console.log(`coverage floor ok: broker-policy.js ${pct}% >= ${FLOOR}%`);

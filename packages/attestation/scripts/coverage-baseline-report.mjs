#!/usr/bin/env node
/**
 * Coverage floors for a2a-attestation (#1601 P2): preserves the broker-era
 * provenance.js line floor (98) after the package extraction; other modules
 * get a conservative floor that only ratchets upward.
 * Safety: local build/test only. No network, no writes outside dist.
 */
import { spawnSync } from 'node:child_process';

const FLOORS = new Map([
  ['provenance.js', 98],
  ['agent-card-signing.js', 80],
  ['finalizer-verdict-signature.js', 80],
  ['worker-subagent-evidence-assembly.js', 80],
  ['worker-subagent-redaction-gate.js', 80],
  // spawn-gate-decision has no in-package test (its coupled test stays in the
  // broker); coverage is asserted by the broker suite instead.
]);

const run = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', '--experimental-test-coverage', 'dist/**/*.test.js'],
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
  const escaped = file.replace('.', '\\.');
  const line = lines.find((entry) => new RegExp(`${escaped}\\s+\\|`).test(entry));
  const match = line?.match(new RegExp(`${escaped}\\s+\\|\\s+([\\d.]+)`));
  const pct = Number(match?.[1]);
  if (!line || !Number.isFinite(pct)) {
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

#!/usr/bin/env node
/**
 * Absence-detection gate for the #1204/#1209 runtime-hardening documentation set.
 *
 * The C6 round (#1204) changed trusted-lane docker-runner defaults (network
 * host -> bridge, read-only rootfs, non-root user) and documented them in
 * packages/docker-runner/docs/trusted-operator-hardening.md and
 * packages/broker/docs/process-local-security-limits.md — but the CHANGELOG
 * entry its spec required was skipped, and nothing failed because
 * documentation absence had no red. This gate makes the artifact set
 * mandatory: the CHANGELOG must record the trusted-default change with its
 * explicit escape hatch, and the existing security-property docs must stay
 * present and linked so later cleanups cannot silently drop them.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const CHECKS = [
  {
    id: 'changelog-trusted-default-entry',
    file: 'CHANGELOG.md',
    patterns: [
      { re: /trusted[^\n]*\bbridge\b/i, why: 'trusted-lane default network change to bridge is recorded' },
      { re: /A2A_DOCKER_RUNNER_NETWORK=host/, why: 'migration note names the explicit host opt-in' },
    ],
  },
  {
    id: 'process-local-security-limits-doc',
    file: 'packages/broker/docs/process-local-security-limits.md',
    patterns: [
      { re: /replay/i, why: 'replay-cache limits are documented' },
      { re: /rate.?limit/i, why: 'rate-limiter limits are documented' },
      { re: /process-local/i, why: 'process-local scope is stated' },
    ],
  },
  {
    id: 'known-limitations-links',
    file: 'docs/known-limitations.md',
    patterns: [
      { re: /process-local-security-limits\.md/, why: 'known-limitations links the process-local limits doc' },
    ],
  },
  {
    id: 'trusted-operator-hardening-doc',
    file: 'packages/docker-runner/docs/trusted-operator-hardening.md',
    patterns: [
      { re: /A2A_DOCKER_RUNNER_NETWORK=host/, why: 'host-network escape hatch is documented' },
      { re: /A2A_DOCKER_RUNNER_USER=root/, why: 'root-user escape hatch is documented' },
    ],
  },
];

const failures = [];
for (const check of CHECKS) {
  const filePath = path.join(root, check.file);
  if (!fs.existsSync(filePath)) {
    failures.push(`${check.id}: missing file ${check.file}`);
    continue;
  }
  const body = fs.readFileSync(filePath, 'utf8');
  for (const { re, why } of check.patterns) {
    if (!re.test(body)) failures.push(`${check.id}: ${check.file} — expected: ${why} (pattern ${re})`);
  }
}

if (failures.length) {
  console.error('runtime hardening docs gate FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`runtime hardening docs gate ok (${CHECKS.length} artifact sets verified)`);

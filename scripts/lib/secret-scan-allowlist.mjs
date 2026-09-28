// #2256 A5: exact synthetic-fixture allowlist for the gitleaks gate, keyed by
// repo-relative file AND gitleaks RuleID with a maximum count. A file-only
// allowlist accepted ANY finding in a listed file, so a real credential of a
// different kind (or an extra one) pasted into a fixture would have passed.
//
// Never allowlist on the Secret field — the scan runs with --redact, which
// rewrites every Secret to "REDACTED". Never allowlist by broad path (dist/,
// tests/, *.test.*). Line-number fingerprints are avoided on purpose: they
// break on unrelated edits and push people to widen the allowlist.

/** file -> { RuleID: maximum allowed findings } */
export const SYNTHETIC_FIXTURE_FINDINGS = new Map([
  ['packages/broker/scripts/round-coordinator-closeout-dry-run.test.mjs', { 'generic-api-key': 1 }],
  ['packages/broker/src/core/orchestration-intelligence-worker-subagent-spawn-bridge.test.ts', { 'generic-api-key': 1 }],
  ['packages/broker/src/server-live-task-admission.test.ts', { 'generic-api-key': 2 }],
  ['packages/docker-runner/src/engine-contract.test.ts', { 'generic-api-key': 2 }],
  ['packages/docker-runner/src/github-evidence.test.ts', { 'generic-api-key': 1 }],
  ['packages/docker-runner/src/scanner.test.ts', { 'generic-api-key': 3 }],
  // #2187 task-assignment entrypoint suite: the in-process 127.0.0.1 mock
  // broker needs a synthetic edge-secret constant (never a real credential).
  ['scripts/lib/task-assign-entrypoint.test.mjs', { 'generic-api-key': 1 }],
]);

function findingFile(finding) {
  return String(finding?.File ?? finding?.file ?? '').replace(/^\.\//, '');
}

function findingRule(finding) {
  return String(finding?.RuleID ?? finding?.ruleID ?? '');
}

/**
 * Split findings into allowed synthetic fixtures and disallowed findings.
 * Findings beyond the per-(file, rule) maximum are disallowed. Also returns
 * allowlist entries that matched nothing (stale, warn-only).
 */
export function partitionGitleaksFindings(findings, allowlist = SYNTHETIC_FIXTURE_FINDINGS) {
  const used = new Map();
  const allowed = [];
  const disallowed = [];
  for (const finding of findings) {
    const file = findingFile(finding);
    const rule = findingRule(finding);
    const max = allowlist.get(file)?.[rule];
    const key = `${file}\u0000${rule}`;
    const count = used.get(key) ?? 0;
    if (typeof max === 'number' && count < max) {
      used.set(key, count + 1);
      allowed.push(finding);
    } else {
      disallowed.push(finding);
    }
  }
  const stale = [];
  for (const [file, rules] of allowlist) {
    for (const rule of Object.keys(rules)) {
      if (!used.has(`${file}\u0000${rule}`)) stale.push({ file, rule });
    }
  }
  return { allowed, disallowed, stale };
}

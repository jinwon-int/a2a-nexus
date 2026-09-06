/**
 * Broker policy deployment path: drift detection + operator-driven sync
 * (a2a-nexus#2064).
 *
 * Why this exists. `contracts/a2a/broker-policy.md` §2.4 makes
 * `docs/ops/broker-policy.json` the canonical, operator-committed policy
 * document, and every repo-side check (`scripts/check-broker-policy.mjs`, the
 * release-gate inventory entry, `broker-policy.test.ts`) validates that copy.
 * Nothing linked that copy to the file a broker actually loads
 * (`A2A_BROKER_POLICY_FILE`, in practice `/var/lib/a2a-broker/broker-policy.json`).
 * Deployment was a human placing a file on a host, so the two diverged silently
 * for two months: the repo said `mode: "warn"` while one live broker had been
 * running `mode: "enforce"` since 2026-07-22. Reviews kept concluding "the
 * document is warn, so there is no live behaviour change" — which was false for
 * that broker, and nearly shipped a fail-closed `denyModes` change into a live
 * enforcing fleet.
 *
 * Two deliberate boundaries:
 *
 * 1. **The drift check never repairs.** §2.4 says policy changes land via
 *    operator commits and agents must not self-modify policy. A checker that
 *    picked a winner would be exactly that. It reports the difference and
 *    fails; deciding which side is right is an operator decision.
 * 2. **The sync path never restarts a broker.** The document is read once, at
 *    `createServer` (packages/broker/src/server.ts:412-413) and handed to the
 *    broker as a snapshot; there is no watcher and no reload route, so a
 *    replaced file has no effect until the broker restarts. Restarts are a
 *    fresh-approval action, so `sync --apply` writes the file, verifies the
 *    bytes landed, and then *tells* the operator a restart is required.
 *
 * Comparison is normalized (JSON parse + deep compare with object keys sorted,
 * array order preserved), not byte-for-byte. Rationale: the live file is
 * produced by a copy that may legitimately differ in trailing newline, indent
 * width, or key order, and a checker that fails on those trains operators to
 * ignore it — which is the failure mode that let the real `mode` drift hide.
 * Byte differences are still reported, as a non-blocking formatting note, so
 * the signal is not lost. Array order is significant because §1 matching is
 * first-match-wins on rule order.
 *
 * Safety: `inspectPolicyDeployment` is read-only. `applyPolicySync` is the only
 * writing path in this module — it writes the live policy file plus a timestamped
 * backup of whatever was there before, and never restarts, reloads, or otherwise
 * touches a running broker.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LIVE_POLICY_PATH = '/var/lib/a2a-broker/broker-policy.json';
export const DEFAULT_CANONICAL_POLICY_PATH = path.join('docs', 'ops', 'broker-policy.json');

/** Recursively sort object keys so key order is not a difference. Array order is preserved. */
export function canonicalizeValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalizeValue(value[key]);
    return out;
  }
  return value;
}

function describe(value) {
  return value === undefined ? '<absent>' : JSON.stringify(value);
}

/**
 * Deep structural diff between the canonical document and the live document.
 * Returns a flat list of `{ path, canonical, live }` entries; `path` is a
 * dotted/indexed pointer such as `mode` or `rules[1].denyModes[0]`.
 */
export function diffPolicyDocuments(canonical, live) {
  const differences = [];
  const walk = (a, b, pointer) => {
    const aIsObj = a && typeof a === 'object' && !Array.isArray(a);
    const bIsObj = b && typeof b === 'object' && !Array.isArray(b);
    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i += 1) walk(a[i], b[i], `${pointer}[${i}]`);
      return;
    }
    if (aIsObj && bIsObj) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        walk(a[key], b[key], pointer ? `${pointer}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      differences.push({ path: pointer || '<document>', canonical: a, live: b });
    }
  };
  walk(canonicalizeValue(canonical), canonicalizeValue(live), '');
  return differences;
}

function readDocument(target, readFile) {
  try {
    const text = readFile(target);
    return { path: target, text, doc: JSON.parse(text) };
  } catch (err) {
    return { path: target, error: err.code === 'ENOENT' ? 'not found' : err.message };
  }
}

/**
 * Read both documents and classify the deployment state. Pure read-only.
 *
 * Statuses:
 *   - `ok`          live matches canonical (possibly with a formatting-only note)
 *   - `drift`       live and canonical disagree semantically -> operator decision
 *   - `unreadable`  either side is missing or not JSON -> fail-closed, never assumed equal
 *   - `invalid`     the canonical document itself does not validate
 */
export function inspectPolicyDeployment({
  canonicalPath = DEFAULT_CANONICAL_POLICY_PATH,
  livePath = DEFAULT_LIVE_POLICY_PATH,
  readFile = (target) => fs.readFileSync(target, 'utf8'),
  validate,
} = {}) {
  const canonical = readDocument(canonicalPath, readFile);
  const live = readDocument(livePath, readFile);
  const base = { canonicalPath, livePath };
  if (canonical.error) {
    return { ...base, status: 'unreadable', reason: `canonical document '${canonicalPath}': ${canonical.error}` };
  }
  const violations = validate ? validate(canonical.doc) : [];
  if (violations.length > 0) {
    return { ...base, status: 'invalid', violations, reason: `canonical document '${canonicalPath}' is not a valid policy document` };
  }
  if (live.error) {
    return { ...base, status: 'unreadable', reason: `live document '${livePath}': ${live.error}`, canonicalMode: canonical.doc.mode };
  }
  const differences = diffPolicyDocuments(canonical.doc, live.doc);
  const byteEqual = canonical.text === live.text;
  return {
    ...base,
    status: differences.length > 0 ? 'drift' : 'ok',
    differences,
    byteEqual,
    formattingOnly: differences.length === 0 && !byteEqual,
    canonicalMode: canonical.doc.mode,
    liveMode: live.doc.mode,
  };
}

/** Human-readable report lines for an `inspectPolicyDeployment` result. */
export function formatDeploymentReport(result) {
  const lines = [];
  if (result.status === 'unreadable' || result.status === 'invalid') {
    lines.push(`FAIL  ${result.reason}`);
    for (const v of result.violations ?? []) lines.push(`FAIL  ${v}`);
    return lines;
  }
  if (result.status === 'ok') {
    lines.push(
      `broker policy deployment ok: ${result.livePath} matches ${result.canonicalPath} ` +
        `(mode=${result.canonicalMode})`,
    );
    if (result.formattingOnly) {
      lines.push(
        'NOTE  documents are semantically identical but not byte-identical ' +
          '(formatting/key order only; not a policy difference)',
      );
    }
    return lines;
  }
  lines.push(`FAIL  live policy document has drifted from the operator-committed canonical document`);
  lines.push(`      canonical: ${result.canonicalPath}`);
  lines.push(`      live:      ${result.livePath}`);
  for (const d of result.differences) {
    lines.push(`      ${d.path}: canonical=${describe(d.canonical)} live=${describe(d.live)}`);
  }
  if (result.differences.some((d) => d.path === 'mode')) {
    lines.push(
      `      'mode' differs: the live broker is running in '${result.liveMode}' while the committed ` +
        `document says '${result.canonicalMode}'. Under 'enforce' a denied task is rejected, not warned.`,
    );
  }
  lines.push(
    '      This check does not decide which side is correct — contracts/a2a/broker-policy.md §2.4',
  );
  lines.push(
    '      reserves policy changes for operator commits. Either commit the live value to the canonical',
  );
  lines.push(
    "      document, or redeploy the canonical document with 'check-broker-policy.mjs sync --apply'.",
  );
  return lines;
}

/** Backup filename for the live document, matching the existing `.bak-<tag>` convention on the hosts. */
export function backupPathFor(livePath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${livePath}.bak-${stamp}`;
}

/**
 * Deploy the canonical document to the live path.
 *
 * Dry-run by default: `apply` must be passed explicitly. Refuses to write when
 * the canonical document does not validate — a configured-but-invalid document
 * fails broker startup loudly (invariant 3), so pushing one would take the
 * broker down at its next restart rather than merely mis-configure it.
 *
 * Never restarts the broker. Returns `restartRequired` so the caller can print
 * the operator instruction instead.
 */
export function applyPolicySync({
  canonicalPath = DEFAULT_CANONICAL_POLICY_PATH,
  livePath = DEFAULT_LIVE_POLICY_PATH,
  apply = false,
  now = new Date(),
  fsImpl = fs,
  validate,
} = {}) {
  const readFile = (target) => fsImpl.readFileSync(target, 'utf8');
  const before = inspectPolicyDeployment({ canonicalPath, livePath, readFile, validate });
  if (before.status === 'invalid') {
    return { ...before, applied: false, refused: true, reason: `${before.reason} — refusing to deploy an invalid document` };
  }
  if (before.status === 'unreadable' && before.canonicalMode === undefined) {
    return { ...before, applied: false, refused: true };
  }
  const liveMissing = before.status === 'unreadable';
  const alreadyMatches = before.status === 'ok' && before.byteEqual;
  const backup = liveMissing ? null : backupPathFor(livePath, now);
  const plan = {
    canonicalPath,
    livePath,
    backupPath: backup,
    liveMissing,
    alreadyMatches,
    differences: before.differences ?? [],
    before,
  };
  if (!apply) {
    return { ...plan, status: 'dry-run', applied: false, restartRequired: !alreadyMatches };
  }
  if (alreadyMatches) {
    return { ...plan, status: 'unchanged', applied: false, restartRequired: false };
  }
  const canonicalText = readFile(canonicalPath);
  if (backup) fsImpl.copyFileSync(livePath, backup);
  fsImpl.writeFileSync(livePath, canonicalText);
  // Post-apply verification: re-read from disk and re-compare, so a partial or
  // permission-mangled write is caught here rather than at the next restart.
  const after = inspectPolicyDeployment({ canonicalPath, livePath, readFile, validate });
  return {
    ...plan,
    status: after.status === 'ok' ? 'applied' : 'verify-failed',
    applied: true,
    verified: after.status === 'ok',
    after,
    restartRequired: true,
  };
}

/** Operator-facing lines for an `applyPolicySync` result. */
export function formatSyncReport(result) {
  const lines = [];
  if (result.refused) {
    lines.push(`FAIL  ${result.reason}`);
    for (const v of result.violations ?? []) lines.push(`FAIL  ${v}`);
    return lines;
  }
  const diffLines = (result.differences ?? []).map(
    (d) => `      ${d.path}: canonical=${describe(d.canonical)} live=${describe(d.live)}`,
  );
  if (result.status === 'dry-run') {
    lines.push(`DRY-RUN  no file was written. Re-run with --apply to deploy.`);
    lines.push(`      canonical: ${result.canonicalPath}`);
    lines.push(`      live:      ${result.livePath}${result.liveMissing ? ' (absent — would be created)' : ''}`);
    if (result.alreadyMatches) {
      lines.push('      live document already matches the canonical document byte-for-byte; nothing to do.');
      return lines;
    }
    if (!result.liveMissing) lines.push(`      backup:    ${result.backupPath}`);
    lines.push(...(diffLines.length > 0 ? ['      would change:', ...diffLines] : ['      would rewrite formatting only (no policy difference)']));
    lines.push('      A broker restart is required afterwards; this command will not restart it.');
    return lines;
  }
  if (result.status === 'unchanged') {
    lines.push(`broker policy sync: ${result.livePath} already matches ${result.canonicalPath}; nothing written.`);
    return lines;
  }
  if (result.status === 'verify-failed') {
    lines.push(`FAIL  wrote ${result.livePath} but post-write verification did not match the canonical document`);
    lines.push(...formatDeploymentReport(result.after).map((l) => `      ${l}`));
    lines.push(`      the previous document is preserved at ${result.backupPath}`);
    return lines;
  }
  lines.push(`broker policy sync applied: ${result.canonicalPath} -> ${result.livePath} (verified)`);
  if (result.backupPath) lines.push(`      previous document backed up to ${result.backupPath}`);
  lines.push('');
  lines.push('RESTART REQUIRED — not performed by this command.');
  lines.push('      The broker reads A2A_BROKER_POLICY_FILE exactly once, at createServer');
  lines.push('      (packages/broker/src/server.ts:412-413); there is no watcher or reload route,');
  lines.push('      so the running broker is still using the previous document.');
  lines.push('      A restart is a fresh-approval action. After an approved restart, confirm the');
  lines.push('      broker came up healthy: a configured-but-invalid or unreadable policy document');
  lines.push('      fails startup loudly, so a healthy broker is the evidence that it loaded.');
  lines.push('      Then re-run: node scripts/check-broker-policy.mjs drift');
  return lines;
}

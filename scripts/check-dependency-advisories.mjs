#!/usr/bin/env node
/**
 * Dependency advisory enforcement gate (#1287, armed in #2050).
 *
 * Runs `npm audit --omit=dev --json` when possible and summarizes production
 * dependency advisories. High/critical advisories fail the gate unless every
 * one of them is covered by an explicit, dated entry in ADVISORY_ALLOWLIST.
 * Low/moderate/info advisories never fail.
 *
 * Why it is armed: auto-merge (.github/workflows/auto-merge.yml) only requires
 * the CI check run to report `conclusion == 'success'`, so a warn-only exit 0
 * let a PR carrying high/critical production advisories land unattended. The
 * gate was armed only after measuring the baseline at 0 high/critical, so no
 * open PR was turned red by arming it.
 *
 * Network/registry unavailable environments still skip with a reason instead of
 * failing closed: an offline runner is not evidence of a vulnerability, and
 * failing closed there would make the gate unfixable from inside a PR.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

/**
 * Reviewed and accepted high/critical advisories.
 *
 * Every entry MUST carry a `reason` and an `expires` date (YYYY-MM-DD). An
 * expired entry stops waiving — the gate then fails again — so an accepted risk
 * cannot be accepted forever by default. Entries are matched against either the
 * GHSA/advisory id reported by `npm audit` or the `pkg:<name>` pseudo-id, which
 * is the only handle available for advisories that carry no id in the report.
 *
 * Empty by design: the measured baseline when the gate was armed was
 * high=0 critical=0. Adding an entry is a reviewed decision, not a CI unblock.
 *
 * @type {Array<{id: string, reason: string, expires: string, package?: string, issue?: string}>}
 */
export const ADVISORY_ALLOWLIST = [];

export function summarizeAudit(doc) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  let total = 0;
  const packageFindings = [];

  const metadataCounts = doc?.metadata?.vulnerabilities;
  if (metadataCounts && typeof metadataCounts === 'object') {
    for (const severity of SEVERITIES) {
      if (Number.isInteger(metadataCounts[severity]) && metadataCounts[severity] >= 0) {
        counts[severity] = metadataCounts[severity];
      }
    }
    if (Number.isInteger(metadataCounts.total) && metadataCounts.total >= 0) total = metadataCounts.total;
  }

  const vulnerabilities = doc?.vulnerabilities;
  if (vulnerabilities && typeof vulnerabilities === 'object' && !Array.isArray(vulnerabilities)) {
    for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
      const severity = String(vulnerability?.severity ?? '').toLowerCase();
      if (SEVERITIES.includes(severity)) {
        packageFindings.push({ name, severity, viaCount: Array.isArray(vulnerability?.via) ? vulnerability.via.length : 0 });
      }
    }
    if (total === 0 && packageFindings.length > 0) {
      for (const finding of packageFindings) counts[finding.severity] += 1;
      total = packageFindings.length;
    }
  }

  return {
    total,
    counts,
    highOrCritical: counts.high + counts.critical,
    packageFindings,
  };
}

const ADVISORY_ID_PATTERN = /^(?:GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|\d+|pkg:[^\s]+)$/i;
const EXPIRES_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function advisoryIdFrom(via) {
  const url = typeof via?.url === 'string' ? via.url : '';
  const fromUrl = url.match(/GHSA-[^/\s]+/i)?.[0];
  if (fromUrl) return fromUrl.toUpperCase();
  if (typeof via?.source === 'number' || (typeof via?.source === 'string' && via.source !== '')) {
    return String(via.source);
  }
  return null;
}

/**
 * Collect the blocking (high/critical) advisories in an npm audit report.
 *
 * Each finding exposes the keys that an allowlist entry may match: the advisory
 * id when the report carries one, plus a `pkg:<name>` pseudo-id so an advisory
 * without an id is still waivable by a reviewer instead of being permanently
 * unfixable.
 */
export function collectBlockingAdvisories(doc) {
  const vulnerabilities = doc?.vulnerabilities;
  const findings = new Map();
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
    return [];
  }
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    const packageSeverity = String(vulnerability?.severity ?? '').toLowerCase();
    const viaList = Array.isArray(vulnerability?.via) ? vulnerability.via : [];
    const viaObjects = viaList.filter((via) => via && typeof via === 'object');
    const blockingVia = viaObjects.filter((via) => {
      const severity = String(via?.severity ?? '').toLowerCase();
      return BLOCKING_SEVERITIES.has(severity) || (severity === '' && BLOCKING_SEVERITIES.has(packageSeverity));
    });
    const relevant = blockingVia.length > 0 || BLOCKING_SEVERITIES.has(packageSeverity) ? blockingVia : [];
    if (relevant.length === 0 && !BLOCKING_SEVERITIES.has(packageSeverity)) continue;

    if (relevant.length === 0) {
      const key = `pkg:${name}`;
      if (!findings.has(key)) findings.set(key, { id: null, package: name, severity: packageSeverity, keys: [key], title: '' });
      continue;
    }
    for (const via of relevant) {
      const id = advisoryIdFrom(via);
      const severity = String(via?.severity ?? '').toLowerCase() || packageSeverity;
      const key = id ?? `pkg:${name}`;
      if (findings.has(key)) continue;
      findings.set(key, {
        id,
        package: typeof via?.name === 'string' && via.name !== '' ? via.name : name,
        severity,
        keys: id ? [id, `pkg:${name}`] : [`pkg:${name}`],
        title: typeof via?.title === 'string' ? via.title : '',
      });
    }
  }
  return [...findings.values()];
}

/**
 * Structurally validate the allowlist. Malformed entries fail the gate even
 * when no advisory is present, so a broken waiver is caught by the PR that adds
 * it rather than by the unrelated PR that later needs it.
 */
export function validateAllowlist(allowlist) {
  const errors = [];
  if (!Array.isArray(allowlist)) return ['allowlist must be an array'];
  for (const [index, entry] of allowlist.entries()) {
    const label = `allowlist[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: must be an object`);
      continue;
    }
    if (typeof entry.id !== 'string' || !ADVISORY_ID_PATTERN.test(entry.id)) {
      errors.push(`${label}: id must be a GHSA id, a numeric advisory source, or pkg:<name>`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      errors.push(`${label}: reason must explain why the advisory is accepted`);
    }
    if (typeof entry.expires !== 'string' || !EXPIRES_PATTERN.test(entry.expires) || Number.isNaN(Date.parse(`${entry.expires}T00:00:00Z`))) {
      errors.push(`${label}: expires must be a YYYY-MM-DD date`);
    }
  }
  return errors;
}

/**
 * Split blocking advisories into waived and unwaived sets. An allowlist entry
 * only waives while it is unexpired; expired entries are reported separately so
 * the failure names the stale waiver instead of looking like a new advisory.
 */
export function evaluateAllowlist({ findings, allowlist, now = new Date() }) {
  const waived = [];
  const unwaived = [];
  const expired = [];
  for (const finding of findings) {
    const matches = allowlist.filter((entry) => finding.keys.includes(String(entry.id).toUpperCase()) || finding.keys.includes(entry.id));
    const live = matches.filter((entry) => Date.parse(`${entry.expires}T23:59:59Z`) >= now.getTime());
    if (live.length > 0) {
      waived.push({ finding, entry: live[0] });
      continue;
    }
    if (matches.length > 0) expired.push({ finding, entry: matches[0] });
    unwaived.push(finding);
  }
  return { waived, unwaived, expired };
}

function parseArgs(argv) {
  const args = { auditJson: process.env.DEPENDENCY_ADVISORY_AUDIT_JSON || '', allowlistJson: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--audit-json') {
      args.auditJson = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i] === '--allowlist-json') {
      // Review/testing hook: substitute the compiled-in allowlist with a file.
      // It is no weaker than editing ADVISORY_ALLOWLIST directly (both are
      // diff-visible), and it lets the gate's own regression tests exercise the
      // waiver path end to end instead of only at unit level.
      args.allowlistJson = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i] === '--help') {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function loadAuditJson(path) {
  if (!path) return null;
  return { source: path, text: fs.readFileSync(path, 'utf8'), status: 0, error: '' };
}

function runNpmAudit() {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return {
    source: 'npm audit --omit=dev --json',
    text: result.stdout || result.stderr || '',
    status: result.status ?? 1,
    error: result.error?.message ?? '',
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`dependency advisories failed: ${error.message}`);
    process.exit(1);
  }
  if (args.help) {
    console.log('Usage: node scripts/check-dependency-advisories.mjs [--audit-json npm-audit.json] [--allowlist-json allowlist.json]');
    process.exit(0);
  }

  let audit;
  try {
    audit = loadAuditJson(args.auditJson) ?? runNpmAudit();
  } catch (error) {
    console.log(`dependency advisories skipped: reason=audit_json_unreadable detail=${JSON.stringify(error.message)}`);
    process.exit(0);
  }

  let doc;
  try {
    doc = JSON.parse(audit.text);
  } catch (error) {
    if (args.auditJson) {
      console.error(`dependency advisories failed: audit_json_malformed detail=${JSON.stringify(error.message)}`);
      process.exit(1);
    }
    const reason = audit.error ? `spawn_error:${audit.error}` : `non_json_audit_output_status_${audit.status}`;
    console.log(`dependency advisories skipped: reason=${reason}`);
    process.exit(0);
  }

  let allowlist = ADVISORY_ALLOWLIST;
  if (args.allowlistJson) {
    try {
      allowlist = JSON.parse(fs.readFileSync(args.allowlistJson, 'utf8'));
    } catch (error) {
      console.error(`dependency advisories failed: allowlist_unreadable detail=${JSON.stringify(error.message)}`);
      process.exit(1);
    }
  }

  const allowlistErrors = validateAllowlist(allowlist);
  if (allowlistErrors.length > 0) {
    console.error(`dependency advisories failed: allowlist_invalid detail=${JSON.stringify(allowlistErrors)}`);
    process.exit(1);
  }

  const summary = summarizeAudit(doc);
  const line = `dependency advisories summary: total=${summary.total} info=${summary.counts.info} low=${summary.counts.low} moderate=${summary.counts.moderate} high=${summary.counts.high} critical=${summary.counts.critical} source=${audit.source}`;
  console.log(line);
  if (summary.highOrCritical === 0) return;

  const findings = collectBlockingAdvisories(doc);
  if (findings.length === 0) {
    // Counts say high/critical exist but the report carries no per-advisory
    // detail, so nothing can be matched against the allowlist. Fail closed:
    // an unidentifiable blocking advisory must not pass silently.
    console.error(`dependency advisories failed: high_or_critical=${summary.highOrCritical} unidentifiable=true (no per-advisory detail in audit report)`);
    process.exit(1);
  }

  const { waived, unwaived, expired } = evaluateAllowlist({ findings, allowlist });
  for (const { finding, entry } of waived) {
    console.log(`dependency advisories waived: id=${finding.id ?? `pkg:${finding.package}`} severity=${finding.severity} expires=${entry.expires} reason=${JSON.stringify(entry.reason)}`);
  }
  for (const { finding, entry } of expired) {
    console.error(`dependency advisories allowlist expired: id=${finding.id ?? `pkg:${finding.package}`} expired=${entry.expires} (renew with review or upgrade the dependency)`);
  }
  if (unwaived.length === 0) {
    console.log(`dependency advisories ok: high_or_critical=${summary.highOrCritical} all_waived=${waived.length}`);
    return;
  }
  const listed = unwaived.map((finding) => `${finding.id ?? `pkg:${finding.package}`}(${finding.severity},${finding.package})`).join(' ');
  console.error(`dependency advisories failed: high_or_critical=${summary.highOrCritical} unwaived=${unwaived.length} advisories=${listed}`);
  console.error('Fix by upgrading the dependency, or record a reviewed waiver in ADVISORY_ALLOWLIST (scripts/check-dependency-advisories.mjs) with an id, a reason, and an expires date.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();

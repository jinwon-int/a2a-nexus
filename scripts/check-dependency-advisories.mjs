#!/usr/bin/env node
/**
 * Warn-only dependency advisory signal gate (#1287).
 *
 * Runs `npm audit --omit=dev --json` when possible, summarizes production
 * dependency advisories, and exits 0 even when high/critical advisories are
 * present. Network/registry unavailable environments skip with a reason instead
 * of failing closed; this is a signal gate, not an enforcement gate.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

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

function parseArgs(argv) {
  const args = { auditJson: process.env.DEPENDENCY_ADVISORY_AUDIT_JSON || '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--audit-json') {
      args.auditJson = argv[i + 1] ?? '';
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
    console.log('Usage: node scripts/check-dependency-advisories.mjs [--audit-json npm-audit.json]');
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

  const summary = summarizeAudit(doc);
  const line = `dependency advisories summary: total=${summary.total} info=${summary.counts.info} low=${summary.counts.low} moderate=${summary.counts.moderate} high=${summary.counts.high} critical=${summary.counts.critical} source=${audit.source}`;
  console.log(line);
  if (summary.highOrCritical > 0) {
    console.error(`dependency advisories warning: high_or_critical=${summary.highOrCritical} (warn-only; reviewed dependency update required)`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();

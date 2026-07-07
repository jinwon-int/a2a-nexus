#!/usr/bin/env node
/**
 * Injected-knowledge snapshot builder (#1373 K1-a).
 *
 * Reads the M1 lane-reliability ledger and the round-quality scorecard's
 * failure taxonomy, and emits a deterministic, asOf-pinned snapshot of
 * counts-only anonymous hint sentences (schema a2a.injected-knowledge.v1)
 * that the broker injects into `policyContext.injectedKnowledge` for tasks
 * opting in via `payload.injectKnowledge: true`.
 *
 * The FULL fail-closed anonymity gate runs here at build time (the M1 ledger
 * gate's worker/node/url rejection via forbiddenIdentifierViolation, plus
 * secret patterns) — a violating hint fails the build and never ships. The
 * broker re-runs a structural gate at load time. M2 risk hints (#1300) are a
 * documented future source; v1 sources are ledger + taxonomy only.
 *
 * Safety: reads repo JSON, writes one repo JSON. No network, no broker calls.
 *
 * Usage:
 *   node scripts/build-injected-knowledge.mjs --as-of 2026-07-07 [--out docs/ops/injected-knowledge.json]
 *   node scripts/build-injected-knowledge.mjs --check [snapshot.json]   # CI gate on a committed snapshot
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { forbiddenIdentifierViolation } from './check-lane-reliability-ledger.mjs';

export const INJECTED_KNOWLEDGE_SCHEMA = 'a2a.injected-knowledge.v1';
const DEFAULT_OUT = path.join('docs', 'ops', 'injected-knowledge.json');
const DEFAULT_LEDGER = path.join('docs', 'ops', 'lane-reliability-ledger.json');
const DEFAULT_SCORECARD = path.join('docs', 'ops', 'round-quality-scorecard.json');
/** A failure category recurring in this many most-recent entries becomes a hint. */
const TAXONOMY_STREAK_THRESHOLD = 3;

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /\/(?:home|root)\//,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
];

/** Full build-time gate: anonymity (ledger-gate pattern) + secret shapes. */
export function hintViolation(text) {
  const anonymity = forbiddenIdentifierViolation(text);
  if (anonymity) return anonymity;
  const secret = SECRET_PATTERNS.find((pattern) => pattern.test(text));
  return secret ? `text matches secret/PII pattern ${secret}` : undefined;
}

function activeLedgerEntries(ledger) {
  const superseded = new Set(
    (ledger.entries ?? []).map((entry) => entry?.supersedes).filter(Boolean),
  );
  return (ledger.entries ?? []).filter((entry) => entry && !superseded.has(entry.id));
}

/** Deterministic: same ledger + scorecard + asOf => byte-identical snapshot. */
export function buildInjectedKnowledgeSnapshot({ ledger, scorecard, asOf }) {
  const hints = [];

  for (const entry of activeLedgerEntries(ledger)) {
    const dispatched = entry.dispatchedCount ?? 0;
    if (dispatched <= 0) continue;
    const substantive = entry.substantiveCount ?? 0;
    const breakdown = entry.evidenceClassBreakdown ?? {};
    const topFailures = Object.entries(breakdown)
      .filter(([klass, count]) => klass !== 'substantive' && Number.isInteger(count) && count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([klass, count]) => `${klass} ${count}/${dispatched}`);
    const failureNote = topFailures.length > 0 ? `; top failure classes: ${topFailures.join(', ')}` : '';
    hints.push({
      taskClass: entry.taskClass,
      adapterClass: entry.adapterClass,
      text: `adapterClass=${entry.adapterClass} taskClass=${entry.taskClass} window=${entry.window}: substantive ${substantive}/${dispatched}${failureNote}`,
    });
  }

  // Failure-taxonomy streaks: a category counted in each of the N most recent
  // scorecard entries that carry a failureBreakdown becomes a recurrence hint.
  const withBreakdown = (scorecard.entries ?? []).filter(
    (entry) => entry?.failureBreakdown && typeof entry.failureBreakdown === 'object',
  );
  const recent = withBreakdown.slice(-TAXONOMY_STREAK_THRESHOLD);
  if (recent.length === TAXONOMY_STREAK_THRESHOLD) {
    const categories = Object.keys(recent[0].failureBreakdown).sort();
    for (const category of categories) {
      if (recent.every((entry) => (entry.failureBreakdown[category] ?? 0) > 0)) {
        hints.push({
          text: `failureClass ${category} recurred in the last ${TAXONOMY_STREAK_THRESHOLD} scorecard rounds with a failure breakdown; check the operators-guide judgment criteria before dispatch`,
        });
      }
    }
  }

  const snapshot = {
    schemaVersion: INJECTED_KNOWLEDGE_SCHEMA,
    asOf,
    source: 'reliability-ledger+taxonomy',
    hints,
  };

  const violations = [];
  for (const [index, hint] of hints.entries()) {
    for (const field of ['taskClass', 'adapterClass', 'text']) {
      if (hint[field] === undefined) continue;
      const violation = hintViolation(String(hint[field]));
      if (violation) violations.push(`hints[${index}].${field}: ${violation}`);
    }
  }
  return { snapshot, violations };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'as-of': { type: 'string' },
      out: { type: 'string', default: DEFAULT_OUT },
      ledger: { type: 'string', default: DEFAULT_LEDGER },
      scorecard: { type: 'string', default: DEFAULT_SCORECARD },
      check: { type: 'boolean', default: false },
    },
  });

  if (values.check) {
    const target = positionals[0] ?? DEFAULT_OUT;
    let snapshot;
    try {
      snapshot = readJson(target);
    } catch (err) {
      process.stderr.write(`cannot read snapshot '${target}': ${err.message}\n`);
      return 2;
    }
    const failures = [];
    if (snapshot?.schemaVersion !== INJECTED_KNOWLEDGE_SCHEMA) failures.push(`schemaVersion must be '${INJECTED_KNOWLEDGE_SCHEMA}'`);
    if (typeof snapshot?.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOf)) failures.push('asOf must be YYYY-MM-DD');
    if (!Array.isArray(snapshot?.hints)) failures.push('hints must be an array');
    for (const [index, hint] of (snapshot?.hints ?? []).entries()) {
      for (const field of ['taskClass', 'adapterClass', 'text']) {
        if (hint?.[field] === undefined) continue;
        const violation = hintViolation(String(hint[field]));
        if (violation) failures.push(`hints[${index}].${field}: ${violation}`);
      }
    }
    if (failures.length > 0) {
      for (const failure of failures) process.stdout.write(`FAIL  ${failure}\n`);
      process.stdout.write(`injected-knowledge gate: ${failures.length} violation(s) in ${target} (fail-closed)\n`);
      return 1;
    }
    process.stdout.write(`injected-knowledge gate ok: ${target} (asOf=${snapshot.asOf}, hints=${snapshot.hints.length})\n`);
    return 0;
  }

  if (!values['as-of'] || !/^\d{4}-\d{2}-\d{2}$/.test(values['as-of'])) {
    process.stderr.write('usage: build-injected-knowledge.mjs --as-of YYYY-MM-DD [--out file] [--ledger file] [--scorecard file] | --check [file]\n');
    return 2;
  }

  let ledger;
  let scorecard;
  try {
    ledger = readJson(values.ledger);
    scorecard = readJson(values.scorecard);
  } catch (err) {
    process.stderr.write(`cannot read inputs: ${err.message}\n`);
    return 2;
  }

  const { snapshot, violations } = buildInjectedKnowledgeSnapshot({ ledger, scorecard, asOf: values['as-of'] });
  if (violations.length > 0) {
    for (const violation of violations) process.stdout.write(`FAIL  ${violation}\n`);
    process.stdout.write(`injected-knowledge build blocked: ${violations.length} anonymity/secret violation(s) (fail-closed)\n`);
    return 1;
  }

  fs.writeFileSync(values.out, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`wrote ${values.out} (asOf=${snapshot.asOf}, hints=${snapshot.hints.length})\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

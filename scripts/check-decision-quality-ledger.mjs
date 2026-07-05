#!/usr/bin/env node
/**
 * Decision quality ledger gate (#1295 DA3).
 *
 * Validates the operator/finalizer-maintained decision outcome ledger. The gate
 * checks only schema/taxonomy; it never auto-judges whether an outcome matched
 * a verdict. That oracle remains human/finalizer-owned.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DECISION_DIALECTIC_VERDICTS = [
  'PROCEED',
  'PROCEED_WITH_GUARDRAILS',
  'WAIT',
  'ABSTAIN',
  'VETO',
];

export const OUTCOME_MATCHED_VERDICT = ['yes', 'no', 'partial', 'pending'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateConfidence(confidence, where, failures) {
  if (confidence === undefined) return;
  if (!confidence || typeof confidence !== 'object' || Array.isArray(confidence)) {
    failures.push(`${where}: confidence must be an object when present`);
    return;
  }
  for (const [key, value] of Object.entries(confidence)) {
    if (typeof value !== 'number' || value < 0 || value > 1) failures.push(`${where}: confidence.${key} must be a number between 0 and 1`);
  }
}

export function evaluateDecisionQualityLedger(doc) {
  if (!doc || !Array.isArray(doc.entries)) return ['entries must be an array'];
  const failures = [];
  const seen = new Set();
  doc.entries.forEach((entry, index) => {
    const where = `entry #${index} (${entry?.id ?? 'no id'})`;
    if (!isNonEmptyString(entry?.id)) failures.push(`${where}: id is required`);
    else if (seen.has(entry.id)) failures.push(`${where}: duplicate id`);
    else seen.add(entry.id);
    if (!isNonEmptyString(entry?.dialecticId)) failures.push(`${where}: dialecticId is required`);
    if (!isNonEmptyString(entry?.scope)) failures.push(`${where}: scope is required`);
    if (!isNonEmptyString(entry?.topic)) failures.push(`${where}: topic is required`);
    else if (entry.topic.length > 120) failures.push(`${where}: topic must be a summary of 120 characters or fewer`);
    if (!DECISION_DIALECTIC_VERDICTS.includes(entry?.verdict)) {
      failures.push(`${where}: verdict must be one of ${DECISION_DIALECTIC_VERDICTS.join(', ')}`);
    }
    if (typeof entry?.outcomeRecorded !== 'boolean') failures.push(`${where}: outcomeRecorded must be boolean`);
    if (!OUTCOME_MATCHED_VERDICT.includes(entry?.outcomeMatchedVerdict)) {
      failures.push(`${where}: outcomeMatchedVerdict must be one of ${OUTCOME_MATCHED_VERDICT.join(', ')}`);
    }
    if (!ISO_DATE.test(entry?.recordedAt ?? '')) failures.push(`${where}: recordedAt must be YYYY-MM-DD`);
    if (!Array.isArray(entry?.evidenceRefs) || entry.evidenceRefs.length === 0 || !entry.evidenceRefs.every(isNonEmptyString)) {
      failures.push(`${where}: evidenceRefs must be a non-empty string array`);
    }
    if (!isNonEmptyString(entry?.notes)) failures.push(`${where}: notes are required for finalizer/operator oracle independence`);
    validateConfidence(entry?.confidence, where, failures);
  });
  return failures;
}

export function summarizeDecisionQualityLedger(doc) {
  const summary = {
    entries: Array.isArray(doc?.entries) ? doc.entries.length : 0,
    verdicts: {},
    outcomeMatchedVerdict: {},
    outcomeRecorded: { true: 0, false: 0 },
  };
  for (const entry of doc?.entries ?? []) {
    if (entry.verdict) summary.verdicts[entry.verdict] = (summary.verdicts[entry.verdict] ?? 0) + 1;
    if (entry.outcomeMatchedVerdict) {
      summary.outcomeMatchedVerdict[entry.outcomeMatchedVerdict] = (summary.outcomeMatchedVerdict[entry.outcomeMatchedVerdict] ?? 0) + 1;
    }
    if (typeof entry.outcomeRecorded === 'boolean') summary.outcomeRecorded[String(entry.outcomeRecorded)] += 1;
  }
  return summary;
}

function main() {
  const ledgerPath = process.env.DECISION_QUALITY_LEDGER || 'docs/ops/decision-quality-ledger.json';
  const resolved = path.resolve(process.cwd(), ledgerPath);
  const doc = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const failures = evaluateDecisionQualityLedger(doc);
  if (failures.length) {
    console.error(`decision quality ledger FAILED (${failures.length} problem(s) in ${ledgerPath}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  const summary = summarizeDecisionQualityLedger(doc);
  console.log(`decision quality ledger ok (${summary.entries} entr${summary.entries === 1 ? 'y' : 'ies'}; verdicts ${JSON.stringify(summary.verdicts)}; outcomeMatchedVerdict ${JSON.stringify(summary.outcomeMatchedVerdict)}; outcomeRecorded ${JSON.stringify(summary.outcomeRecorded)})`);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) main();

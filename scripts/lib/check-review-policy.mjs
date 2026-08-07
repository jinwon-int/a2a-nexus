#!/usr/bin/env node
/**
 * Review-policy documentation gate (a2a-nexus#1507).
 *
 * Ensures GOVERNANCE.md documents an author-independent, bus-factor-resistant
 * review policy — the acceptance bullet "CODEOWNERS/review policy documents
 * author-independent review and a backup path". Absence-detection: if the
 * "## Review policy" section or any of its three required commitments is
 * removed, this turns red.
 *
 * Fully OFFLINE / source-only: reads GOVERNANCE.md only. It documents policy;
 * it does not delete branches, mutate CODEOWNERS, or change GitHub settings
 * (those remain approval-sensitive and out of scope for #1507's doc slice).
 */
import { createDocCheckContext } from './doc-check.mjs';

const GOVERNANCE = 'GOVERNANCE.md';
export const METRICS_DOC = 'docs/ops/repository-health-metrics.md';

function reviewPolicySection(text) {
  const m = text.match(/##\s+Review policy[\s\S]*?(?=\n##\s|$)/i);
  return m ? m[0] : '';
}

/**
 * Pure evaluator so tests can drive it without the filesystem.
 * @param {string|null} governanceText
 * @returns {string[]} failures (empty === clean)
 */
export function evaluateReviewPolicy(governanceText) {
  if (governanceText == null) return [`missing ${GOVERNANCE}`];
  const section = reviewPolicySection(governanceText);
  if (!section) {
    return [`${GOVERNANCE}: missing a "## Review policy" section (#1507: document author-independent review + backup path)`];
  }
  const failures = [];
  const requires = [
    {
      ok: /author-independent/i.test(section) && /(not its author|sole approver)/i.test(section),
      message: 'must document author-independent review (a PR author cannot be its sole approver / reviewer must be distinct from the author)',
    },
    {
      ok: /backup reviewer/i.test(section),
      message: 'must document a backup reviewer path for reviewer unavailability (bus-factor resistance)',
    },
    {
      ok: /review[- ]evidence/i.test(section) && /(velocity|closeout completeness)/i.test(section),
      message: 'must document that review-evidence cardinality / closeout completeness is preferred over pull-request velocity',
    },
    {
      ok: section.includes(METRICS_DOC),
      message: `must link the measurable metric definition (${METRICS_DOC}) so the preference is not left as an unmeasurable principle`,
    },
  ];
  for (const req of requires) {
    if (!req.ok) failures.push(`${GOVERNANCE} "## Review policy": ${req.message}`);
  }
  return failures;
}

function main() {
  const { readRel, fail, finish } = createDocCheckContext({ name: 'review policy' });
  const text = readRel(GOVERNANCE);
  if (text === null) fail(`missing ${GOVERNANCE}`);
  else for (const message of evaluateReviewPolicy(text)) fail(message);
  // The link alone is not enough: a dangling reference would leave the metrics
  // undefined while the section still reads as if they were defined.
  if (readRel(METRICS_DOC) === null) fail(`missing ${METRICS_DOC} (linked from ${GOVERNANCE} "## Review policy")`);
  finish(`review policy ok: ${GOVERNANCE} documents author-independent review, a backup reviewer path, review-evidence over velocity, and links ${METRICS_DOC}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

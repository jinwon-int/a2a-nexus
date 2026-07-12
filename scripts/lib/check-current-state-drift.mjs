#!/usr/bin/env node
/**
 * Current-state drift gate (a2a-nexus#1501, first slice).
 *
 * Fails when docs/current-state.md frames an issue as *active / current
 * coordination* while docs/ops/github-state-snapshot.json records that issue
 * as `closed`. This catches the class of drift where a doc keeps presenting a
 * finished coordination lane (e.g. a monorepo-flip parent) as ongoing.
 *
 * Fully OFFLINE / source-only: it reads only the two committed files. Keeping
 * the snapshot in sync with live GitHub is a separate, deferred read-only
 * periodic job (out of scope for this slice) — the snapshot is committed and
 * updated by hand for now.
 *
 * The detection is intentionally precise (no false positives): it flags only
 * the `> **Active coordination:**` header and any line that uses the word
 * "active" next to a closed issue reference. A closed issue merely *mentioned*
 * in historical prose is fine.
 */
import { createDocCheckContext } from './doc-check.mjs';

const CURRENT_STATE = 'docs/current-state.md';
const SNAPSHOT = 'docs/ops/github-state-snapshot.json';

function referencesIssue(line, num) {
  return new RegExp(`#${num}\\b`).test(line);
}

/**
 * Pure evaluator so tests can drive it without spawning.
 * @param {string|null} currentStateText
 * @param {{issues?: Array<{number:number,state:string,closedAt?:string}>}|null} snapshot
 * @returns {string[]} failure messages (empty === clean)
 */
export function evaluateCurrentStateDrift(currentStateText, snapshot) {
  if (currentStateText == null) return [`missing ${CURRENT_STATE}`];
  const closed = (snapshot?.issues ?? []).filter(
    (i) => i && i.state === 'closed' && Number.isInteger(i.number),
  );
  if (!closed.length) return [];

  const lines = currentStateText.split('\n');
  const failures = [];
  for (const issue of closed) {
    const num = issue.number;
    const closedAt = issue.closedAt ? ` (closed ${issue.closedAt})` : '';
    lines.forEach((line, idx) => {
      const lineNo = idx + 1;
      const isActiveHeader = /^\s*>?\s*\*\*Active coordination:\*\*/i.test(line);
      if (isActiveHeader && referencesIssue(line, num)) {
        failures.push(
          `${CURRENT_STATE}:${lineNo}: "Active coordination:" header names closed issue #${num}${closedAt}; point it at an open tracker and move #${num} to the historical narrative`,
        );
        return;
      }
      if (/\bactive\b/i.test(line) && referencesIssue(line, num)) {
        failures.push(
          `${CURRENT_STATE}:${lineNo}: issue #${num} is closed${closedAt} but this line frames it as active: ${line.trim().slice(0, 120)}`,
        );
      }
    });
  }
  return failures;
}

function main() {
  const { readRel, parseJson, fail, finish } = createDocCheckContext({ name: 'current-state drift' });
  const snapshot = parseJson(SNAPSHOT);
  const text = readRel(CURRENT_STATE);
  if (text === null) fail(`missing ${CURRENT_STATE}`);
  else for (const message of evaluateCurrentStateDrift(text, snapshot)) fail(message);
  finish(
    `current-state drift ok: ${CURRENT_STATE} frames no snapshot-closed issue as active coordination`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

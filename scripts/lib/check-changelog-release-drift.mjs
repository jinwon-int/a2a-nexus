#!/usr/bin/env node
/**
 * CHANGELOG release-drift gate (a2a-nexus#1501, release-state slice).
 *
 * Satisfies acceptance criterion 4: a checker fails when a release has happened
 * and public/API/contract changes have accrued, yet CHANGELOG.md's `## Unreleased`
 * section is still an empty placeholder ("No unreleased changes yet.").
 *
 * Fully OFFLINE / source-only: it reads only two committed files —
 * `CHANGELOG.md` and `docs/ops/release-state-snapshot.json`. No network, no git
 * introspection. Keeping the snapshot in sync with real release state is a
 * hand-maintained, committed step (mirrors github-state-snapshot.json for the
 * current-state-drift gate).
 *
 * Enforcement is gated by the snapshot's `enforcement.armed` flag so the
 * mechanism can land behavior-neutral before the CHANGELOG `## Unreleased`
 * backfill (drift 1c) is authored. When `armed:true`, an empty Unreleased body
 * beneath at least one released version section fails closed.
 *
 * The detection is intentionally precise (no false positives): a legitimately
 * populated Unreleased section (any non-placeholder, non-blank content) passes.
 */
import { createDocCheckContext } from './doc-check.mjs';

const CHANGELOG = 'CHANGELOG.md';
const RELEASE_STATE = 'docs/ops/release-state-snapshot.json';

// A released version heading, e.g. "## v0.1.0-alpha — 2026-07-05".
const RELEASED_HEADING = /^##\s+v?\d+\.\d+/i;
// Placeholder bodies that mean "nothing recorded yet".
const PLACEHOLDER_LINE = [
  /^no unreleased changes\b/i,
  /^_?none[.]?_?$/i,
  /^n\/?a$/i,
  /^-+$/,
  /^tbd$/i,
];

/**
 * Extract the trimmed, non-blank content lines of the `## Unreleased` section
 * (everything up to the next `## ` heading), minus known placeholders.
 * @param {string} changelogText
 * @returns {{ found: boolean, bodyLines: string[] }}
 */
export function extractUnreleasedBody(changelogText) {
  const lines = String(changelogText).split('\n');
  let inSection = false;
  const bodyLines = [];
  let found = false;
  for (const raw of lines) {
    if (/^##\s+unreleased\b/i.test(raw)) {
      inSection = true;
      found = true;
      continue;
    }
    if (inSection && /^##\s+/.test(raw)) break; // next top-level section
    if (!inSection) continue;
    const line = raw.trim();
    if (!line) continue;
    if (PLACEHOLDER_LINE.some((re) => re.test(line))) continue;
    bodyLines.push(line);
  }
  return { found, bodyLines };
}

export function hasReleasedSection(changelogText) {
  return String(changelogText)
    .split('\n')
    .some((line) => RELEASED_HEADING.test(line));
}

/**
 * Pure evaluator so tests can drive it without spawning.
 * @param {string|null} changelogText
 * @param {{latestRelease?: object, enforcement?: {armed?: boolean}}|null} releaseState
 * @returns {string[]} failure messages (empty === clean)
 */
export function evaluateChangelogReleaseDrift(changelogText, releaseState) {
  const failures = [];
  if (changelogText == null) return [`missing ${CHANGELOG}`];
  if (releaseState == null) return [`missing ${RELEASE_STATE}`];

  const armed = releaseState.enforcement?.armed === true;
  if (!armed) return failures; // mechanism landed; enforcement deferred (see snapshot $comment)

  const { found, bodyLines } = extractUnreleasedBody(changelogText);
  if (!found) {
    failures.push(`${CHANGELOG}: no "## Unreleased" section found`);
    return failures;
  }
  if (!hasReleasedSection(changelogText)) return failures; // nothing released yet — nothing to drift from

  if (bodyLines.length === 0) {
    const rel = releaseState.latestRelease?.version
      ? ` since ${releaseState.latestRelease.version}`
      : '';
    failures.push(
      `${CHANGELOG}: "## Unreleased" is an empty placeholder but public/API/contract changes have accrued${rel} (release-state-snapshot enforcement.armed=true); record the changes under "## Unreleased" or lower the arming flag with justification`,
    );
  }
  return failures;
}

function main() {
  const { readRel, parseJson, fail, finish } = createDocCheckContext({ name: 'changelog release drift' });
  const releaseState = parseJson(RELEASE_STATE);
  const text = readRel(CHANGELOG);
  if (text === null) fail(`missing ${CHANGELOG}`);
  else for (const message of evaluateChangelogReleaseDrift(text, releaseState)) fail(message);
  finish(
    `changelog release drift ok: ${CHANGELOG} "## Unreleased" is consistent with ${RELEASE_STATE} enforcement state`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

#!/usr/bin/env node
/**
 * Guard the public README surface against regressing to pre-canonical-flip
 * (split-repo / a2a-plane) "current source" framing.
 *
 * Context: an operator-approved, source-state-only canonical flip made
 * a2a-nexus/packages/* the canonical A2A implementation source
 * (fixtures/current-state/monorepo-actual-canonical-flip-execution-result.json).
 * The split repositories remain active provenance mirrors only. This check
 * keeps README.md consistent with that state so the public entry point does
 * not drift back to describing the old umbrella/split topology as current.
 *
 * Safety: source-only doc validation. No deploy, restart, provider send, DB
 * mutation, release/tag/npm/Docker publish, credential movement, or repo
 * visibility change is performed here.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

const readmePath = path.join(root, 'README.md');
let readme = '';
try {
  readme = fs.readFileSync(readmePath, 'utf8');
} catch {
  fail('missing README.md');
}

// CI badge must point at the canonical a2a-nexus repository.
expect(
  readme.includes('https://github.com/jinwon-int/a2a-nexus/actions/workflows/ci.yml/badge.svg'),
  'README CI badge must point at jinwon-int/a2a-nexus',
);
expect(
  !readme.includes('a2a-plane/actions/workflows/ci.yml/badge.svg'),
  'README CI badge must not point at the legacy a2a-plane repository',
);

// Canonical state must be stated, with split repos framed as provenance mirrors.
expect(
  /canonical implementation source/i.test(readme),
  'README must state that a2a-nexus is the canonical implementation source',
);
expect(
  /active provenance mirror/i.test(readme),
  'README must describe the former split repositories as active provenance mirrors',
);

// Stale "split repos are the current canonical source" framing must not return.
const forbiddenPhrases = [
  'current public source layout remains split',
  'split implementation repositories remain canonical',
  'split repos above remain the public implementation boundaries',
  'each implementation repository remains canonical for its own',
];
for (const phrase of forbiddenPhrases) {
  expect(
    !readme.toLowerCase().includes(phrase.toLowerCase()),
    `README must not contain stale split-canonical wording: "${phrase}"`,
  );
}

// Issue routing should send new issues to the canonical repo, not a2a-plane "first".
expect(
  !/open project-level or ambiguous issues in `a2a-plane` first/i.test(readme),
  'README issue routing must not direct new issues to a2a-plane first',
);

if (failures.length) {
  console.error(`README canonical-surface validation failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('README canonical surface ok');

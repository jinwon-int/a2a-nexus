#!/usr/bin/env node
/**
 * Validate the #515 monorepo docs, CODEOWNERS, and issue-routing packet.
 *
 * Safety: source-only fixture/doc validation. No issue transfer, repository
 * archive, visibility, release, canonical flip, live dispatch, restart,
 * credential, DB, or Terminal ACK action is performed here.
 */
import { createDocCheckContext } from './lib/doc-check.mjs';

const { expect, readRel, parseJson, finish } = createDocCheckContext({
  name: 'monorepo docs/routing validation',
});

const fixture = parseJson('fixtures/current-state/monorepo-docs-routing.json');
const pkg = parseJson('package.json');
const releaseGateInventory = parseJson('docs/ops/release-gate-step-inventory.json');

const docs = new Map([
  ['docs/migration.md', readRel('docs/migration.md')],
  ['docs/operators.md', readRel('docs/operators.md')],
  ['docs/developers.md', readRel('docs/developers.md')],
  ['docs/issue-routing.md', readRel('docs/issue-routing.md')],
  ['docs/current-state.md', readRel('docs/current-state.md')],
  ['docs/monorepo-reentry-decision.md', readRel('docs/monorepo-reentry-decision.md')],
  ['README.md', readRel('README.md')],
  ['.github/CODEOWNERS', readRel('.github/CODEOWNERS')],
]);

for (const [rel, text] of docs) {
  expect(text !== null, `missing ${rel}`);
}

if (fixture) {
  expect(fixture.schema === 'a2a.monorepo-docs-routing.v1', 'fixture: unexpected schema');
  expect(fixture.parentIssue === 'https://github.com/jinwon-int/a2a-plane/issues/511', 'fixture: parentIssue must be #511');
  expect(fixture.childIssue === 'https://github.com/jinwon-int/a2a-plane/issues/515', 'fixture: childIssue must be #515');
  expect(fixture.decision === 'draft_docs_codeowners_issue_routing_without_canonical_flip', 'fixture: decision must be docs/routing only');
  expect(fixture.canonicalUntilExplicitSignoff === 'split_repos', 'fixture: split repos must remain canonical');
  expect(fixture.canonicalFlipApproved === false, 'fixture: canonical flip must be false');
  expect(fixture.codeownersDraftOnly === true, 'fixture: CODEOWNERS must be draft-only');
  expect(fixture.finalizerAuthorityMovesToWorkers === false, 'fixture: finalizer authority must not move to workers');
  expect(fixture.closedIssuePrTransfer === false, 'fixture: closed issue/PR transfer must be false');
  expect(/independent_repository/.test(fixture.agentOlympicsBoundary || ''), 'fixture: agent-olympics boundary must be independent');

  for (const rel of fixture.docs || []) {
    expect(readRel(rel) !== null, `fixture: referenced doc missing ${rel}`);
  }
  for (const label of ['source:a2a-plane', 'source:a2a-broker', 'source:a2a-docker-runner', 'source:openclaw-plugin-a2a']) {
    expect((fixture.sourceLabels || []).includes(label), `fixture: missing source label ${label}`);
  }
  expect((fixture.forbiddenSourceLabels || []).includes('source:agent-olympics'), 'fixture: source:agent-olympics must be forbidden');
  for (const [key, value] of Object.entries(fixture.boundaries || {})) {
    expect(value === false, `fixture: boundary.${key} must be false`);
  }
}

const allDocs = Array.from(docs.values()).filter(Boolean).join('\n');
for (const phrase of [
  'canonical flip',
  'Split repos',
  'Terminal ACK',
  'package publish',
  'repo visibility',
  'CODEOWNERS',
  'finalizer authority',
  'closed issues and PRs stay in their original repos',
  'Agent Olympics',
]) {
  expect(allDocs.toLowerCase().includes(phrase.toLowerCase()), `docs: missing phrase "${phrase}"`);
}

const issueRouting = docs.get('docs/issue-routing.md') || '';
for (const label of ['source:a2a-plane', 'source:a2a-broker', 'source:a2a-docker-runner', 'source:openclaw-plugin-a2a']) {
  expect(issueRouting.includes(label), `issue routing: missing label ${label}`);
}
expect(/Do not create or use `source:agent-olympics`/.test(issueRouting), 'issue routing: must forbid source:agent-olympics');

const codeowners = docs.get('.github/CODEOWNERS') || '';
for (const pathPrefix of ['/packages/broker/', '/packages/docker-runner/', '/packages/openclaw-plugin-a2a/', '/contracts/', '/fixtures/']) {
  expect(codeowners.includes(pathPrefix), `CODEOWNERS: missing ${pathPrefix}`);
}
expect(/does not move finalizer/.test(codeowners), 'CODEOWNERS: must state finalizer authority does not move');

if (pkg) {
  expect(
    pkg.scripts?.['check:monorepo-docs-routing'] === 'node scripts/check-monorepo-docs-routing.mjs',
    'package.json: missing check:monorepo-docs-routing script'
  );
}
if (releaseGateInventory) {
  const releaseGateStep = releaseGateInventory.entries?.find((entry) => entry.name === 'monorepo-docs-routing');
  expect(Boolean(releaseGateStep), 'release gate inventory must include monorepo docs routing check');
  expect(releaseGateStep?.tier === 'public-readiness', 'monorepo docs routing must stay in the public-readiness tier');
  expect(releaseGateStep?.command === 'npm', 'monorepo docs routing release-gate command must be npm');
  expect(
    JSON.stringify(releaseGateStep?.args) === JSON.stringify(['run', 'check:monorepo-docs-routing']),
    'monorepo docs routing release-gate args must invoke check:monorepo-docs-routing',
  );
}

finish('monorepo docs/routing ok');

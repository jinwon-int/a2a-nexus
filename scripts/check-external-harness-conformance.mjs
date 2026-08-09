#!/usr/bin/env node
/**
 * External harness conformance check.
 *
 * Safety: read-only validation for public docs and fixtures. No live broker,
 * provider, terminal ACK, deploy, restart, or database access.
 */
import { createDocCheckContext } from './lib/doc-check.mjs';

const { root, failures, fail, expect, readRel, parseJson } = createDocCheckContext();

function checkNoLiveUrls(rel, text) {
  const urls = text.match(/https?:\/\/[^\s)]+/g) || [];
  const suspicious = urls.filter(
    (url) =>
      !url.startsWith('http://127.0.0.1') &&
      !url.startsWith('http://localhost') &&
      !url.startsWith('https://github.com/jinwon-int/')
  );
  expect(suspicious.length === 0, rel + ': contains live external URLs: ' + suspicious.join(', '));
}

const docPath = 'docs/external-harness-quickstart.md';
const doc = readRel(docPath);
expect(doc !== null, 'missing ' + docPath);
if (doc) {
  expect(/External Harness Quickstart/i.test(doc), 'external harness doc: missing title');
  // Was /non-OpenClaw agent harness/. That phrasing made OpenClaw the default and
  // every other harness the exception, which is backwards: the broker meets all of
  // them through the same adapter contract. Assert the guide is harness-agnostic by
  // naming more than one, instead of defining them by what they are not.
  expect(
    /any agent harness/i.test(doc),
    'external harness doc: must address harnesses generally, not as exceptions to one',
  );
  expect(
    ['Claude Code', 'Codex', 'Hermes', 'piri'].filter((name) => doc.includes(name)).length >= 3,
    'external harness doc: must name several concrete harnesses so none reads as the default',
  );
  expect(/OpenClaw is the first\/reference integration, not a required dependency/i.test(doc), 'external harness doc: must avoid OpenClaw dependency');
  expect(/Safety Boundary/i.test(doc), 'external harness doc: missing safety boundary');
  expect(/no-live/i.test(doc), 'external harness doc: missing no-live language');
  expect(/check:external-harness-conformance/i.test(doc), 'external harness doc: missing conformance command');
  expect(/fixtures\/external-harness\/no-live-conformance\.json/.test(doc), 'external harness doc: missing fixture reference');
  expect(/Terminal Brief Adapter Contract/i.test(doc), 'external harness doc: missing Terminal Brief adapter section');
  expect(/current_session_visible/.test(doc), 'external harness doc: missing current_session_visible receipt source');
  expect(/manual_operator_receipt/.test(doc), 'external harness doc: missing manual_operator_receipt receipt source');
  expect(/Provider accepted.*not.*terminal ACK/is.test(doc), 'external harness doc: must keep provider accepted non-ACK');
  expect(/final.*N\/N.*closeout input, not automatic approval/is.test(doc), 'external harness doc: must frame final count as closeout input only');
  expect(/a2a-broker#689/.test(doc), 'external harness doc: missing completion watcher issue reference');
  expect(/a2a-broker#690/.test(doc), 'external harness doc: missing final-count closeout issue reference');
  checkNoLiveUrls(docPath, doc);
}

const quickstart = readRel('docs/quickstart.md');
expect(quickstart !== null, 'missing docs/quickstart.md');
if (quickstart) {
  expect(/(?:docs\/)?external-harness-quickstart\.md/.test(quickstart), 'quickstart: must link external harness path');
}

const examplesReadme = readRel('examples/README.md');
expect(examplesReadme !== null, 'missing examples/README.md');
if (examplesReadme) {
  expect(/external-harness/.test(examplesReadme), 'examples README: must list external harness fixture');
}

const contractsReadme = readRel('contracts/a2a/README.md');
expect(contractsReadme !== null, 'missing contracts/a2a/README.md');
if (contractsReadme) {
  expect(/External harness no-live conformance/.test(contractsReadme), 'contracts README: must list external harness conformance fixture');
}

const fixturePath = 'fixtures/external-harness/no-live-conformance.json';
const fixture = parseJson(fixturePath);
if (fixture) {
  expect(fixture.schema === 'a2a.externalHarness.noLiveConformance.v1', 'fixture: invalid schema');
  expect(fixture.mode === 'no-live', 'fixture: mode must be no-live');
  expect(fixture.harness?.usesOpenClawCli === false, 'fixture: external harness must not require OpenClaw CLI');
  expect(fixture.broker?.baseUrl === 'http://127.0.0.1:8787', 'fixture: broker URL must be loopback');
  expect(fixture.broker?.production === false, 'fixture: production must be false');
  expect(fixture.worker?.id === fixture.task?.assignedWorkerId, 'fixture: assigned worker must match worker id');
  expect(fixture.task?.payload?.noLive === true, 'fixture: task payload must be noLive');
  expect(fixture.task?.payload?.replaySafe === true, 'fixture: task payload must be replaySafe');
  expect(Array.isArray(fixture.task?.expectedTerminalEvidence), 'fixture: expectedTerminalEvidence must be an array');
  expect(fixture.task.expectedTerminalEvidence.includes('Done'), 'fixture: Done evidence required');
  expect(fixture.task.expectedTerminalEvidence.includes('Block'), 'fixture: Block evidence required');
  expect(fixture.terminalBrief?.ackEligibleConfirmationSources?.includes('current_session_visible'), 'fixture: missing current_session_visible');
  expect(fixture.terminalBrief?.ackEligibleConfirmationSources?.includes('manual_operator_receipt'), 'fixture: missing manual_operator_receipt');
  expect(fixture.terminalBrief?.nonAckEvidence?.includes('provider_accepted'), 'fixture: provider_accepted must remain non-ACK');
  expect(fixture.terminalBrief?.nonAckEvidence?.includes('provider_sent'), 'fixture: provider_sent must remain non-ACK');
  expect(fixture.terminalBrief?.nonAckEvidence?.includes('spool_produced'), 'fixture: spool_produced must remain non-ACK');
  expect(fixture.terminalBrief?.finalCountExample?.label === '(3/3)', 'fixture: final count example must be (3/3)');
  expect(/not automatic irreversible action/.test(fixture.terminalBrief?.finalCountExample?.meaning || ''), 'fixture: final count must not imply automatic irreversible action');

  for (const [key, value] of Object.entries(fixture.safety || {})) {
    expect(value === false, 'fixture: safety.' + key + ' must be false');
  }
}

if (failures.length) {
  console.error('external harness conformance failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}

console.log('external harness conformance ok: docs, fixture, no-live safety, and receipt boundaries validated');

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-workerDelta-concise-brief-r9.md');
const contractPath = join(repoRoot, 'contracts', 'a2a', 'parent-terminal-brief-aggregation.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

async function contract() {
  return readFile(contractPath, 'utf8');
}

test('Team1/workerDelta R9 concise brief gate binds issue, parent, and run', async () => {
  const content = await doc();

  for (const reference of [
    'a2a-plane#289',
    'a2a-broker#560',
    'a2a-r9-concise-brief-runtime-20260513T134143Z',
    'parent-terminal-brief-aggregation.md',
  ]) {
    assert.match(content, new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Team1/workerDelta R9 concise brief gate defines parent aggregation metadata fields', async () => {
  const content = await doc();

  for (const field of [
    'parentRoundId',
    'originBrokerId',
    'parentBrokerId',
    'handoffBrokerId',
    'childBrokerId',
    'brokerOfRecord',
    'knownTotal',
    'dispatcherId',
  ]) {
    assert.match(content, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // Fail-closed conditions for missing metadata use backtick-wrapped field names
  assert.match(content, /parentRoundId.*or.*originBrokerId.*must be rejected/);
  assert.match(content, /handoffBrokerId.*must be rejected/);
});

test('Team1/workerDelta R9 concise brief gate enforces title format rules', async () => {
  const content = await doc();

  // Known-total format
  assert.match(content, /A2A Terminal Brief.*worker.*completed.*total/);
  // Unknown-total format
  assert.match(content, /A2A Terminal Brief.*worker.*completed/);

  // Example titles
  assert.match(content, /A2A Terminal Brief 완료: workerEpsilon\(1\/7\)/);
  assert.match(content, /A2A Terminal Brief 완료: workerDelta\(2\)/);

  // Max chars
  assert.match(content, /80 character/);

  // Forbidden title content
  for (const forbidden of [
    'task ids',
    'child issue URLs',
    'terminal evidence URLs',
    'terminal summary text',
    'child broker IDs',
    'handoff broker IDs',
    'provider message IDs',
    'receipt status',
    'ACK status',
    'runtime/bootstrap file name',
  ]) {
    assert.match(content, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // Unknown denominator is forbidden
  assert.match(content, /2.*\?/);
  assert.match(content, /unknown total with a denominator/);

  // Status labels
  for (const label of ['완료', '실패', '차단']) {
    assert.match(content, new RegExp(label));
  }
});

test('Team1/workerDelta R9 concise brief gate requires body/evidence separation', async () => {
  const content = await doc();

  for (const phrase of [
    'Body/evidence separation',
    'separate fields',
    'must not be concatenated',
    'title and body are separate',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // Fail-closed conditions for body/evidence separation
  assert.match(content, /Title contains terminal summary text/);
  assert.match(content, /re-renders the round title as an evidence header/);
  assert.match(content, /blank or missing title/);

  // Contract must have the separation section
  const contractContent = await contract();
  assert.match(contractContent, /Body\/evidence separation/);
});

test('Team1/workerDelta R9 concise brief gate requires parent-only notification ownership', async () => {
  const content = await doc();

  for (const phrase of [
    'Parent-only notification ownership',
    'only the parent broker',
    'child or handoff broker dispatches',
    'child/handoff brokers must not',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // Contract must have the ownership section
  const contractContent = await contract();
  assert.match(contractContent, /Parent-only notification ownership/);
});

test('Team1/workerDelta R9 concise brief gate defines no-live proof and approval-gated activation', async () => {
  const content = await doc();

  assert.match(content, /NO-GO \/ Waiting/);
  assert.match(content, /approval-gated/);

  // Pre-activation read-only verification steps
  for (const step of ['E.1a', 'E.1b', 'E.1c']) {
    assert.match(content, new RegExp(step));
  }

  // Staging activation requires operator approval
  assert.match(content, /requires operator approval/);
  assert.match(content, /staging environment/);

  // Post-activation verification
  assert.match(content, /no live provider send/);
  assert.match(content, /terminal-outbox ACK column is unchanged/);
  assert.match(content, /no production database mutation/);

  // Production activation requires separate operator approval
  assert.match(content, /separate operator approval/);

  // Disallowed actions
  for (const prohibited of [
    'deploy or restart any service',
    'mutate production databases',
    'send any provider or Telegram message',
    'change secrets',
    'rewrite history',
    'force-push',
  ]) {
    assert.match(content, new RegExp(prohibited.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(content, /Decision: `GO`|production activation is approved/i);
});

test('Team1/workerDelta R9 concise brief gate defines 7-child parent round fixture', async () => {
  const content = await doc();

  // Direct Team1 children
  assert.match(content, /A2A Terminal Brief 완료: workerDelta\(1\/3\)/);
  assert.match(content, /A2A Terminal Brief 완료: workerGamma\(2\/3\)/);
  assert.match(content, /A2A Terminal Brief 완료: workerBeta\(3\/3\)/);

  // Cross-broker Team2 projected children
  assert.match(content, /A2A Terminal Brief 완료: workerEpsilon\(1\/4\)/);
  assert.match(content, /A2A Terminal Brief 완료: brokerBeta\(2\/4\)/);
  assert.match(content, /A2A Terminal Brief 완료: workerZeta\(3\/4\)/);
  assert.match(content, /A2A Terminal Brief 완료: workerEta\(4\/4\)/);

  // Unknown-total fallback
  assert.match(content, /A2A Terminal Brief 완료: workerDelta\(2\)/);

  // Fail-closed conditions
  assert.match(content, /does not match the expected format/);
  assert.match(content, /contains a denominator/);
});

test('Team1/workerDelta R9 concise brief gate includes runtime/bootstrap hygiene', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /fail closed if any OpenClaw runtime\/bootstrap context file/);
  assert.match(content, /It must not include secrets, provider targets, chat IDs/);

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]/i);
});

test('Team1/workerDelta R9 concise brief gate remains NO-GO/Waiting and no-live', async () => {
  const content = await doc();

  assert.match(content, /NO-GO \/ Waiting/);
  assert.match(content, /Did not execute any activation step/);
  assert.match(content, /This runbook gate does not execute live activation/);

  assert.doesNotMatch(content, /Decision: `GO`|is approved and may proceed|Terminal Brief ACK completed/i);
});

test('Team1/workerDelta R9 contract update adds body/evidence separation and parent-only ownership sections', async () => {
  const contractContent = await contract();

  assert.match(contractContent, /## Body\/evidence separation/);
  assert.match(contractContent, /## Parent-only notification ownership/);
  assert.match(contractContent, /## R9 addition: 7-child parent round and activation gate/);

  // Body/evidence separation rules
  assert.match(contractContent, /title and body\/evidence must be stored, transmitted, and rendered as separate fields/);
  assert.match(contractContent, /title must not contain terminal summary text/);

  // Parent-only ownership rules (note: the contract text has "must not:" followed by a numbered list)
  assert.match(contractContent, /aggregate Terminal Brief notification is owned and administered by the parent broker only/);
  assert.match(contractContent, /Child brokers, handoff brokers, and replay handlers must not/);

  // Activation plan steps
  assert.match(contractContent, /\| A1 \|/);
  assert.match(contractContent, /\| A2 \|/);
  assert.match(contractContent, /\| A8 \|/);
});

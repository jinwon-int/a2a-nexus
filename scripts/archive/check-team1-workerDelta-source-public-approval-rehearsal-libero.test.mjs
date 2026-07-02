import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-workerDelta-source-public-approval-rehearsal-libero.md');
const packetPath = join(repoRoot, 'fixtures', 'dry-run', 'source-public-approval-rehearsal-packet.json');
const allowedDecisions = new Set(['GO_CANDIDATE', 'NO_GO', 'NEEDS_OPERATOR_APPROVAL']);

async function doc() {
  return readFile(docPath, 'utf8');
}

async function packet() {
  return JSON.parse(await readFile(packetPath, 'utf8'));
}

test('Team1 source-public approval rehearsal doc covers current run and decision outputs', async () => {
  const content = await doc();

  assert.match(content, /a2a-source-public-approval-rehearsal-20260511T014240Z/);
  assert.match(content, /a2a-plane#211/);
  assert.match(content, /a2a-plane#213/);
  assert.match(content, /`GO_CANDIDATE`/);
  assert.match(content, /`NO_GO`/);
  assert.match(content, /`NEEDS_OPERATOR_APPROVAL`/);
  assert.match(content, /Decision: `NO_GO`/);
  assert.match(content, /Source-public execution remains \*\*NO_GO\*\*/);
});

test('approval rehearsal doc requires deterministic packet and integrated evidence bundle gates', async () => {
  const content = await doc();

  assert.match(content, /stable `packetKey`/);
  assert.match(content, /Sort object keys/);
  assert.match(content, /candidate action as `rehearsalOnly: true` and `executed: false`/);
  assert.match(content, /Integrated evidence bundle gate/);
  assert.match(content, /Start-only evidence/);
  assert.match(content, /PR\/Done\/Block evidence/);
});

test('approval rehearsal doc preserves no-live Terminal Brief, replay, rollback, and approval boundaries', async () => {
  const content = await doc();

  assert.match(content, /No-live Terminal Brief rehearsal gate/);
  assert.match(content, /providerSendExecuted=false/);
  assert.match(content, /terminalAckExecuted=false/);
  assert.match(content, /not Terminal Brief ACK, read receipt, operator-visible receipt, or operator approval/);
  assert.match(content, /Replay\/no-duplicate proof gate/);
  assert.match(content, /Rollback and abort paths/);
  assert.match(content, /Operator approval: \*\*not present, not requested, not executed\*\*/);
  assert.doesNotMatch(content, /visibility change was performed|terminal ACK executed|provider send executed|approval executed/i);
});

test('approval rehearsal packet fixture is deterministic, redacted, and fail-closed', async () => {
  const data = await packet();

  assert.equal(data.kind, 'a2a.source-public-approval-rehearsal.packet');
  assert.equal(data.run, 'a2a-source-public-approval-rehearsal-20260511T014240Z');
  assert.ok(data.packetKey.includes(data.run));
  assert.equal(data.sourcePublicExecution, 'NO_GO');
  assert.equal(data.approvalExecution, 'NOT_REQUESTED_NOT_EXECUTED');
  assert.ok(allowedDecisions.has(data.decision));
  assert.deepEqual(data.allowedDecisionOutputs, [...allowedDecisions]);
  assert.ok(data.canonicalization.sortObjectKeys);
  assert.ok(data.canonicalization.volatileFieldsExcluded.includes('generatedAt'));
  assert.ok(data.gates.some((gate) => gate.id === 'integratedEvidenceBundle' && gate.status === 'NO_GO'));
  assert.ok(data.gates.some((gate) => gate.id === 'operatorApproval' && gate.status === 'NEEDS_OPERATOR_APPROVAL'));
});

test('approval rehearsal packet fixture forbids live actions and protects runtime/bootstrap hygiene', async () => {
  const data = await packet();

  for (const [name, value] of Object.entries(data.safetyInvariants)) {
    assert.equal(value, false, `${name} must remain false in rehearsal packet`);
  }

  assert.equal(data.terminalBriefRehearsal.mode, 'no-live');
  assert.equal(data.terminalBriefRehearsal.providerSendExecuted, false);
  assert.equal(data.terminalBriefRehearsal.terminalAckExecuted, false);
  assert.equal(data.terminalBriefRehearsal.githubCommentProjectionIsAck, false);

  const hygieneGate = data.gates.find((gate) => gate.id === 'runtimeBootstrapHygiene');
  assert.ok(hygieneGate);
  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.ok(hygieneGate.denyPaths.includes(denyPath), `${denyPath} must be denied`);
  }

  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /ghp_|github_pat_|Authorization:\s*Bearer|BROKER_EDGE_SECRET|OPENCLAW_CACHE_BOUNDARY|<\|/i);
});

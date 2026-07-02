import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team1-workerGamma-r25-ops-readiness-terminal-brief.md');

async function doc() {
  return readFile(docPath, 'utf8');
}

test('R25 ops-readiness doc exists and references the correct lane metadata', async () => {
  const content = await doc();

  assert.match(content, /a2a-r25-team1-ops-readiness-terminal-brief-20260515T1656Z/);
  assert.match(content, /a2a-plane#351/);
  assert.match(content, /a2a-plane#352/);
  assert.match(content, /Team1\/workerGamma/);
  assert.match(content, /brokerAlpha/);
});

test('R25 ops-readiness doc defines all five domains', async () => {
  const content = await doc();

  for (const domain of [
    'Production safety gate',
    'Rollback criteria',
    'Default-off checks',
    'Operator approval boundaries',
    'Runtime/bootstrap and artifact hygiene',
  ]) {
    assert.match(content, new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('R25 ops-readiness doc covers G1 production safety gate preconditions', async () => {
  const content = await doc();

  for (const precondition of [
    'Team2 Terminal Brief PR has passed its own review',
    'does not change the four-level receipt hierarchy',
    'does not introduce new terminal states',
    'does not require a live provider send',
    'brokerAlpha broker image/tag planned for deploy is pinned',
    'Terminal Brief feature is **default-off**',
  ]) {
    assert.match(content, new RegExp(precondition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('R25 ops-readiness doc defines G2 rollback triggers and rehearsal', async () => {
  const content = await doc();

  for (const trigger of [
    'Broker health check fails',
    'Terminal outbox rows stuck',
    'Worker handler crashes',
    'Default-off flag is discovered to be `true`',
    'Operator-initiated rollback',
  ]) {
    assert.match(content, new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /rollback.*rehearsal/i);
  assert.match(content, /no terminal-outbox ACK mutation during rollback/i);
});

test('R25 ops-readiness doc defines G3 default-off surfaces and checklist', async () => {
  const content = await doc();

  for (const surface of [
    'Broker Terminal Brief config',
    'Worker Terminal Brief notification path',
    'Plugin-level Gateway notification bridge',
    'Receipt/ACK path',
    'Cross-broker Terminal Brief relay',
  ]) {
    assert.match(content, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /terminalBriefEnabled.*false/i);
  assert.match(content, /notificationDisabled/i);
  assert.match(content, /liveProviderSend.*false/i);
  assert.match(content, /productionAckAttempted.*false/i);
  assert.match(content, /accidental enablement protection/i);
});

test('R25 ops-readiness doc defines G4 operator approval boundaries', async () => {
  const content = await doc();

  const requiredActions = [
    'Accept Team2 Terminal Brief PR',
    'Deploy Terminal Brief-enabled broker image',
    'Deploy Terminal Brief-enabled worker commit',
    'Set `terminalBriefEnabled: true`',
    'Send a live provider/Telegram canary',
    'ACK terminal-outbox rows',
    'Run rollback procedure',
  ];

  for (const action of requiredActions) {
    assert.match(content, new RegExp(action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(content, /not delegation/i);
  assert.match(content, /separate GitHub issue comment/i);
  assert.match(content, /name the exact action being approved/i);
  assert.match(content, /revoked/i);
  assert.match(content, /bounded/i);
  assert.match(content, /no-approval zone/i);
});

test('R25 ops-readiness doc includes GO/NO-GO decision matrix', async () => {
  const content = await doc();

  assert.match(content, /GO_CANDIDATE.*Needs operator review/);
  assert.match(content, /NO-GO.*Waiting/);
  assert.match(content, /BLOCK/);
  assert.match(content, /Current aggregate decision/);
});

test('R25 ops-readiness doc includes safety confirmation and validation commands', async () => {
  const content = await doc();

  assert.match(content, /Safety confirmation/);
  assert.match(content, /Validation commands/);
  assert.match(content, /check-terminal-brief-routing/);
  assert.match(content, /check-contract-fixtures/);
  assert.match(content, /Reference map/);
  assert.match(content, /Closeout boundary/);
});

test('R25 ops-readiness doc excludes runtime/bootstrap context file names from being present as content', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(content, /fail closed/);
  assert.match(content, /Guard paths in repo checkout.*absent.*all clean/);
  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|Session ID:|chat_id\s*[:=]|\/root\//i);
});

test('R25 ops-readiness doc does not claim production acceptance or live activation', async () => {
  const content = await doc();

  // The doc uses "is activated" only in the context of "before Team2 code is activated"
  // (describing what the gate checks), never claiming the lane performed activation.
  // Check that the safety confirmation explicitly states this lane did not activate.
  assert.match(content, /Does not activate Terminal Brief/i);
  assert.match(content, /did not deploy or restart/i);
  assert.match(content, /Did not perform Terminal Brief ACK/i);
  assert.doesNotMatch(content, /has been activated|has activated|we activated|this lane activated|activation was performed/i);
});

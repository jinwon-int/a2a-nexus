import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(
  repoRoot,
  'docs',
  'validation',
  'team1-workerDelta-r25-team2-terminal-brief-ops-readiness-libero.md',
);

async function doc() {
  return readFile(docPath, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertIncludesAll(content, references, flags = '') {
  for (const reference of references) {
    assert.match(content, new RegExp(escapeRegExp(reference), flags));
  }
}

test('R25 libero validation binds issue, parent, run, lane, and safe no-live scope', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#353',
    'a2a-plane#351',
    'a2a-r25-team1-ops-readiness-terminal-brief-20260515T1656Z',
    'Lane: `workerDelta` / Team1 libero validation (Team2 Terminal Brief ops-readiness matrix)',
    'repository and GitHub evidence review only',
    'no production deploy, Gateway/broker/worker restart or reload, live provider or Telegram canary',
    'production DB mutation/prune/migration',
    'manual Terminal Brief ACK/replay',
    'secret movement/rotation/value disclosure',
    'release/tag publish',
    'repo visibility change',
    'Provider accepted/message-id evidence is send-acceptance only, not read/visibility/Terminal ACK',
    'Team2 Terminal Brief implementation ownership is not duplicated',
  ]);

  for (const forbiddenClaim of [
    /R25 Team2 Terminal Brief operations-readiness.*`GO`/i,
    /production activation is approved/i,
    /operator approval executed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
    /operator-visible receipt completed/i,
    /live canary dispatched/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R25 validation matrix covers all four domains', async () => {
  const content = await doc();

  // Domain 1 — Integration assumptions
  assertIncludesAll(content, [
    'Domain 1 — Terminal Brief integration assumptions',
    'Gateway plugin routing availability',
    'openclaw_outbound_lifecycle',
    'openclaw_gateway_notifier',
    'Terminal evidence projection requires GitHub API access',
    'projectTerminalBriefGitHubEvidenceComment',
    'validateManifestBinding',
    'planTerminalBriefGitHubEvidenceWrite',
    'terminalAck: false',
    'readReceipt: false',
    'Parent-origin routing contract requires registered broker IDs',
    'four-case',
    'brokerAlpha',
    'brokerBeta',
    'initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender',
    'Terminal-outbox must support replay-idempotent projection',
    'dedupeKey',
    'replayKey',
    'Cross-broker handoff needs brokerAlpha-brokerBeta network connectivity',
    'broker-handoff-protocol.md',
    'two-broker-safety-matrix.ts',
    'Plugin Gateway notification bridge is deployable',
    'boundLength',
    'MAX_GITHUB_COMMENT_LENGTH',
  ]);

  // Domain 2 — Release blockers
  assertIncludesAll(content, [
    'Domain 2 — Release blockers',
    'Gateway plugin deployed',
    'Broker terminal-outbox store initialized',
    'Terminal Brief routing guard deployed',
    'Cross-broker registration completed',
    'Notification adapter credentials configured',
    'Runbook documents all remediation paths',
    'No-live restoration procedure documented',
  ]);

  // Domain 3 — Test evidence snapshot
  assertIncludesAll(content, [
    'Domain 3 — Test evidence snapshot',
    'terminal-brief-routing-contract.test.ts',
    'terminal-brief-evidence-projection.test.ts',
    'two-broker-safety-matrix.test.ts',
    'check-contract-fixtures.mjs',
    'check-terminal-evidence-ack-boundary.mjs',
    'public-readiness-scan.mjs',
    'PASS for unit coverage',
    'PASS for ACK boundary',
  ]);

  // Domain 4 — No-live/no-ACK approval gates
  assertIncludesAll(content, [
    'Domain 4 — No-live/no-ACK approval gates',
    'No live provider send without operator approval',
    'No terminal-outbox ACK without ACK-safe proof',
    'manual_operator_receipt',
    'current_session_visible',
    'No DB mutation for terminal evidence',
    'GitHub comments are evidence ledger entries, not ACK/approval',
    'githubComment: "evidence_ledger_only"',
    'No runtime/bootstrap context files in evidence',
    'OPENCLAW_CONTEXT_PATH_RE',
    'AGENTS.md',
    'SOUL.md',
    'Cross-broker relay window safety',
    'parentBrokerId',
    'operatorFacingTerminalBriefSender',
  ]);
});

test('R25 lane snapshot lists the validation lane and treats start-only evidence as waiting', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#353',
    'workerDelta',
    'Start evidence plus this validation document and test',
    'Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence',
    'PR, Done, or Block marker',
  ]);
});

test('R25 risk list covers all identified operations risks', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Risk list and runtime activation blockers',
    'Gateway plugin deploy gap',
    'Terminal-outbox cursor restart behavior',
    'No-live restoration not proven',
    'Cross-broker connectivity untested',
    'Runtime/bootstrap hygiene drift across branches',
  ]);
});

test('R25 runtime activation blockers include domain-specific requirements and operator separation', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Runtime activation blockers',
    'Gateway plugin with outbound lifecycle routing is deployed',
    'Broker terminal-outbox is initialized',
    'Terminal Brief routing guard is deployed',
    'cross-broker handoff path',
    'GitHub notification adapter credentials are provisioned',
    'Runbooks exist for',
    'source-only GO/NO-GO',
    'No sibling lane relies on Start-only evidence',
  ]);
});

test('R25 source-only GO/NO-GO semantics separate GO from runtime activation', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Source-only GO/NO-GO decision',
    'NO-GO / Waiting',
    '`GO` is a source-only decision',
    'does not authorize runtime activation',
    'production deploy',
    'Terminal Brief ACK',
    'cross-broker relay window opening',
    'separate explicit operator approval',
    'Source execution remains `NO_GO`',
  ]);
});

test('R25 required checks include gate integrity and bootstrap hygiene', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'terminal-brief-routing-contract.ts',
    'terminal-brief-evidence-projection.ts',
    'npm run check:message-id-ack-boundary',
    'npm run check:terminal-brief-routing',
    'npm run check',
    'check-team1-workerDelta-r25-team2-terminal-brief-ops-readiness-libero.test.mjs',
    'adds documentation/test evidence only and does not create runtime/bootstrap files',
    'No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration',
  ]);
});

test('R25 bootstrap hygiene fails closed and does not include obvious secret/session leaks', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'OpenClaw runtime/bootstrap context files',
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
    'TOOLS.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    '.openclaw/**',
    'BOOTSTRAP.md',
    'MEMORY.md',
    'memory/**',
    'offending paths',
  ]);

  assert.doesNotMatch(content, /ghp_|github_pat_|Authorization:\s*Bearer|OPENCLAW_CACHE_BOUNDARY|raw session dump/i);
});

test('R25 verification performed section lists all inspected references', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#353',
    'a2a-plane#351',
    'terminal-brief-routing-contract.ts',
    'terminal-brief-evidence-projection.ts',
    'terminal-brief-evidence-projection.test.ts',
    'parent-terminal-brief-aggregation.md',
    'terminal-brief-parent-origin-routing.json',
    'broker-handoff-protocol.md',
    'two-broker-safety-matrix.ts',
    'terminal-evidence-ack-boundary.md',
    'terminal-brief-routing-contract.test.ts',
    'two-broker-safety-matrix.test.ts',
    'docs/release-gate.md',
    'contracts/compatibility/matrix.md',
    'public-readiness-scan.mjs',
  ]);
});

test('R25 integration assumptions cover all Team2 code that assumes ops environment', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Gateway plugin routing availability',
    'Terminal evidence projection requires GitHub API access',
    'Parent-origin routing contract requires registered broker IDs',
    'Terminal-outbox must support replay-idempotent projection',
    'Cross-broker handoff needs brokerAlpha-brokerBeta network connectivity',
    'Plugin Gateway notification bridge is deployable',
  ]);
});

test('R25 test evidence snapshot covers all Team2 Terminal Brief test areas', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'terminal-brief-routing-contract.test.ts',
    'terminal-brief-evidence-projection.test.ts',
    'two-broker-safety-matrix.test.ts',
    'check-contract-fixtures.mjs',
    'check-terminal-evidence-ack-boundary.mjs',
    'public-readiness-scan.mjs',
  ]);
});

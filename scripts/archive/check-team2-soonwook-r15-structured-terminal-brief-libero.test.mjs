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
  'team2-soonwook-r15-structured-terminal-brief-libero.md',
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

test('R15 libero validation binds issue, parent, run, lane, and safe no-live scope', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-plane#312',
    'a2a-broker#623',
    'a2a-r15-allhands-structured-terminal-brief-20260514T065457Z',
    'Lane: `soonwook` / Team2 libero validation',
    'issuecomment-4448410547',
    'repository and GitHub evidence review only',
    'does not deploy, restart, reload',
    'does not deploy, restart, reload, send live provider or Telegram canaries',
  ]);

  for (const forbiddenClaim of [
    /R15 closeout is `GO`/i,
    /production activation is approved/i,
    /operator approval executed/i,
    /live provider send completed/i,
    /terminal ACK completed/i,
    /visibility change completed/i,
  ]) {
    assert.doesNotMatch(content, forbiddenClaim);
  }
});

test('R15 matrix covers all required structured Terminal Brief gates', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Canonical task payload metadata',
    '`parentRoundId`',
    '`originBrokerId`',
    '`handoffBrokerId`',
    '`parentRoundTotal`',
    '`parentRoundIndex`',
    '`childWorkerId`',
    '`taskSummary` or `taskDescription`',
    '`terminalBriefTitle`',
    'Fail-closed creation',
    'Post-dispatch snapshot verifier',
    'Within 30-60 seconds',
    'Cross-broker origin fan-in',
    'Compact renderer fallback order',
    'Runner summary precedence',
    'Plane contract fixtures',
    'GitHub assignment ingestion',
    'Provider accepted/message-id boundary',
    'requester-visible receipt',
    'operator-visible receipt',
    'terminal ACK',
    'terminal-outbox ACK',
  ]);

  assert.doesNotMatch(content, /provider accepted-send(?:\s+evidence)? is (?:a )?(?:requester-visible |operator-visible )?receipt/i);
  assert.doesNotMatch(content, /message IDs? (?:are|is) (?:a )?terminal ACK/i);
});

test('R15 lane snapshot lists all seven workers and sibling issue links', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    '1/7 | `bangtong` | [a2a-broker#624]',
    '2/7 | `sogyo` | [openclaw-plugin-a2a#311]',
    '3/7 | `nosuk` | [a2a-broker#627]',
    '4/7 | `yukson` | a2a-plane#311',
    '5/7 | `dungae` | [a2a-broker#625]',
    '6/7 | `jingun` | [a2a-docker-runner#255]',
    '7/7 | `soonwook` | a2a-plane#312',
    'Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence',
    'PR, Done, or Block marker',
  ]);
});

test('R14 PR disposition explicitly blocks #621 and classifies other open PRs', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'a2a-broker#620',
    'a2a-broker#621',
    'a2a-broker#622',
    'a2a-broker#626',
    'openclaw-plugin-a2a#310',
    'a2a-docker-runner#254',
    'a2a-plane#310',
    '`MERGE_CANDIDATE`',
    '`MERGE_BLOCKED`',
    'Do not merge unless fixed and revalidated',
    'close #621 into R15 with an explicit supersession comment',
  ]);

  assert.match(
    content,
    /\[a2a-broker#621\][\s\S]*?CI failing; `BLOCKED`[\s\S]*?`MERGE_BLOCKED`/,
  );
  assert.doesNotMatch(content, /a2a-broker#621[\s\S]{0,200}`MERGE_CANDIDATE`/);
});

test('R15 merge and closeout sequence preserves blockers and ACK separation', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'Stop the known-bad R14 path',
    'Land canonical broker creation first',
    'Land broker verifier/fan-in second',
    'Resolve GitHub ingestion separately',
    'Land plugin renderer',
    'Land runner compatibility',
    'Land plane contracts',
    'Land libero closeout',
    'Parent closeout',
    'Production activation, live canary, deploy/reload, and Terminal Brief ACK remain separate explicit-approval gates',
  ]);

  for (const phrase of [
    'canonical payload persistence',
    'fail-closed rejection/normalization of top-level-only metadata',
    'stable projection keys',
    'no duplicate parent Terminal Brief rows',
    'no historical outbox replay',
    'human summary precedence',
    'provider accepted-send non-ACK semantics',
  ]) {
    assert.match(content, new RegExp(escapeRegExp(phrase), 'i'));
  }
});

test('R15 required checks include bootstrap hygiene and no secret/runtime evidence leakage', async () => {
  const content = await doc();

  assertIncludesAll(content, [
    'npm run check:message-id-ack-boundary',
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

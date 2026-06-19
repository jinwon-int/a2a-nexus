// GO/NO-GO readiness note validation (TDD: test first, then document).
// Linked to #919 and #922 — public readiness gate closeout before promotion.
//
// Safety: read-only document validation only. No live services, secrets,
// provider sends, terminal ACK, deploy, or database access.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..');
const NOTE_PATH = join(REPO_ROOT, 'docs/public-readiness-go-nogo.md');

function readNote() {
  try {
    return readFileSync(NOTE_PATH, 'utf8');
  } catch {
    return null;
  }
}

test('GO/NO-GO readiness note exists', () => {
  const note = readNote();
  assert.ok(note !== null, 'docs/public-readiness-go-nogo.md must exist');
});

test('GO/NO-GO note declares NO-GO for visibility change', () => {
  const note = readNote();
  assert.ok(note !== null, 'note missing');
  if (!note) return;

  assert.match(note, /NO-GO|no-go|No-Go/i, 'note must contain NO-GO decision');
  assert.match(note, /visibility change|visibility|public visibility/, 'note must reference visibility change');
  assert.match(note, /not authorized|not grant|does not authorize|separate approval/i, 'note must state visibility is not authorized by this document');
});

test('GO/NO-GO note separates technical readiness from approval-gated actions', () => {
  const note = readNote();
  assert.ok(note !== null, 'note missing');
  if (!note) return;

  // Must call out at least 5 approval-gated non-actions
  const gatedTerms = [
    /deploy/i, /restart/i, /npm publish/i, /docker publish/i,
    /release/i, /tag/i, /secret movement/i, /secret rotation/i,
    /terminal ack/i, /provider send/i, /db mutation/i, /production/i,
    /force push/i, /history rewrite/i,
  ];
  const matched = gatedTerms.filter((re) => re.test(note));
  assert.ok(matched.length >= 5, `note must list at least 5 approval-gated non-actions, found ${matched.length}`);

  // Must separate technical readiness from approval
  assert.match(note, /technical readiness|technical|readiness evidence/i, 'note must mention technical readiness');
  assert.match(note, /approval|operator approval|explicit approval/i, 'note must mention approval separation');
});

test('GO/NO-GO note records external scanner evidence disposition', () => {
  const note = readNote();
  assert.ok(note !== null, 'note missing');
  if (!note) return;

  assert.match(note, /gitleaks|trufflehog|external.secret.scan|scan:external-secrets/i, 'note must reference external scanner');
  assert.match(note, /clean|0 finding|no finding|no leak/i, 'note must record clean disposition or findings count');
  assert.match(note, /redacted|REDACTED/i, 'note must mention redacted evidence');
});

test('GO/NO-GO note references relevant issues', () => {
  const note = readNote();
  assert.ok(note !== null, 'note missing');
  if (!note) return;

  assert.match(note, /#919/, 'note must reference issue #919');
  assert.match(note, /#922/, 'note must reference issue #922');
});

test('GO/NO-GO note includes runtime/bootstrap hygiene statement', () => {
  const note = readNote();
  assert.ok(note !== null, 'note missing');
  if (!note) return;

  assert.match(note, /AGENTS\.md|SOUL\.md|runtime.bootstrap|bootstrap hygiene|OpenClaw runtime/i, 'note must address runtime/bootstrap hygiene');
});

test('GO/NO-GO note confirms external harness conformance gate representation', () => {
  const note = readNote();
  assert.ok(note !== null, 'note missing');
  if (!note) return;

  assert.match(note, /external.harness.conformance|external harness/i, 'note must reference external harness conformance');
});

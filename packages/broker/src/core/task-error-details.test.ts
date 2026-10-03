import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTaskError } from "./broker-task-record-normalizers.js";
import { redactAndBoundFailureExcerpt } from "./task-error-details.js";

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const API_KEY = `sk-${"b".repeat(40)}`;

// #2256 A4 per-egress fixture: every GitHub egress point must scrub these and
// keep the 40-hex commit SHA. Token shapes are assembled at runtime so this
// file never carries a literal secret-scanner hit.
const EGRESS_SHA = "0123456789abcdef0123456789abcdef01234567";
const EGRESS_SK = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"].join("-");
const EGRESS_BEARER = "eyJhbGciOiJIUzI1NiJ9.payload.signature";
const EGRESS_ENV_VALUE = "env-secret-value-123";
const EGRESS_TOKEN_VALUE = "tok-secret-value-456";
const EGRESS_LINES = [
  `key ${EGRESS_SK}`,
  `Authorization: Bearer ${EGRESS_BEARER}`,
  `OPENAI_API_KEY=${EGRESS_ENV_VALUE}`,
  `token=${EGRESS_TOKEN_VALUE}`,
  "log at /home/alice/.ssh/id_ed25519 and /root/.openclaw/agents/main/session.json",
  `commit ${EGRESS_SHA}`,
];

function assertEgressRedacted(text: string): void {
  for (const leak of [EGRESS_SK, EGRESS_BEARER, EGRESS_ENV_VALUE, EGRESS_TOKEN_VALUE, "/home/alice", "/root/.openclaw"]) {
    assert.equal(text.includes(leak), false, `${leak} leaked: ${text}`);
  }
  assert.match(text, /<redacted-api-key>/);
  assert.match(text, /<redacted-private-path>/);
  assert.ok(text.includes(EGRESS_SHA), `commit SHA must survive: ${text}`);
}

test("failure readback excerpt is bounded and redacted", () => {
  const raw = [
    `GH_TOKEN=${GITHUB_TOKEN}`,
    ...Array.from({ length: 30 }, (_, i) => `line-${i}`),
    `OPENAI_API_KEY=${API_KEY}`,
    "/root/.openclaw/private/session.json",
    `telegram:-1001234567890 user@example.com +1 (555) 123-4567`,
  ].join("\n");

  const excerpt = redactAndBoundFailureExcerpt(raw, { maxLines: 6, maxChars: 400 });

  assert.match(excerpt, /GH_TOKEN=<redacted/);
  assert.match(excerpt, /OPENAI_API_KEY=<redacted/);
  assert.match(excerpt, /<redacted-private-path>/);
  assert.match(excerpt, /telegram:<redacted-target>/);
  assert.match(excerpt, /<redacted-email>/);
  assert.match(excerpt, /<redacted-phone>/);
  assert.doesNotMatch(excerpt, new RegExp(GITHUB_TOKEN));
  assert.doesNotMatch(excerpt, new RegExp(API_KEY));
  assert.doesNotMatch(excerpt, /\/root\/\.openclaw\/private/);
  assert.match(excerpt, /<truncated /);
});

test("task error normalization preserves only standard failure readback fields safely", () => {
  const normalized = normalizeTaskError({
    code: "handler_exit_nonzero",
    message: "handler exited",
    details: {
      stage: "HANDLER",
      excerpt: `handler failed with token=${GITHUB_TOKEN} at /home/alice/private.log`,
      exitCode: 1,
      invalidStage: "kept as regular metadata",
    },
  });

  assert.equal(normalized.details?.stage, "handler");
  assert.equal(normalized.details?.exitCode, 1);
  assert.equal(normalized.details?.invalidStage, "kept as regular metadata");
  const excerpt = String(normalized.details?.excerpt ?? "");
  assert.match(excerpt, /token=<redacted/);
  assert.match(excerpt, /<redacted-private-path>/);
  assert.doesNotMatch(excerpt, new RegExp(GITHUB_TOKEN));
  assert.doesNotMatch(excerpt, /\/home\/alice/);
});

test("unknown readback stage is dropped instead of becoming a fake category", () => {
  const normalized = normalizeTaskError({
    code: "x",
    message: "x",
    details: { stage: "not-a-stage", excerpt: "safe line" },
  });
  assert.deepEqual(normalized.details, { excerpt: "safe line" });
});

test("failure excerpt keeps head AND tail so the actual error survives (#1610)", () => {
  const lines = [
    "clone: start of run",
    ...Array.from({ length: 40 }, (_, i) => `setup-step-${i}`),
    "Error: the real failure is at the end",
    "stack: final-frame",
  ];
  const excerpt = redactAndBoundFailureExcerpt(lines.join("\n"), { maxLines: 8, maxChars: 10_000 });

  assert.match(excerpt, /clone: start of run/);
  assert.match(excerpt, /Error: the real failure is at the end/);
  assert.match(excerpt, /stack: final-frame/);
  assert.match(excerpt, /<truncated \d+ lines>/);
  assert.doesNotMatch(excerpt, /setup-step-10\b/);
});

test("failure excerpt keeps tail chars when a single line exceeds the char budget (#1610)", () => {
  const head = `prefix-${"x".repeat(300)}`;
  const tail = `tail-error-${"z".repeat(100)}`;
  const excerpt = redactAndBoundFailureExcerpt(`${head}\n${tail}`, { maxLines: 20, maxChars: 200 });

  assert.match(excerpt, /tail-error-/);
  assert.match(excerpt, /<truncated /);
});

test("failure excerpt is unchanged when within budget", () => {
  const raw = "line-a\nline-b";
  assert.equal(redactAndBoundFailureExcerpt(raw, { maxLines: 5, maxChars: 100 }), raw);
});

test("#2256 A4 failure excerpt keeps non-personal addresses, dates, versions and durations", () => {
  const raw = [
    "remote: git@github.com:owner/repo.git",
    "Co-Authored-By: Bot <noreply@anthropic.com>",
    "author 247078695+someone@users.noreply.github.com",
    "at +2026-09-28 12:34:56 build 1.4.0+20260928.1 took +123456789ms",
    "contact alice@example.org or +82 10-1234-5678",
  ].join("\n");
  const excerpt = redactAndBoundFailureExcerpt(raw, { maxLines: 10, maxChars: 2000 });
  assert.match(excerpt, /git@github\.com:owner\/repo\.git/);
  assert.match(excerpt, /noreply@anthropic\.com/);
  assert.match(excerpt, /users\.noreply\.github\.com/);
  assert.match(excerpt, /\+2026-09-28 12:34:56/);
  assert.match(excerpt, /1\.4\.0\+20260928\.1/);
  assert.match(excerpt, /\+123456789ms/);
  assert.doesNotMatch(excerpt, /alice@example\.org/);
  assert.doesNotMatch(excerpt, /10-1234-5678/);
  const bypasses = redactAndBoundFailureExcerpt(
    "call +82 10-1234-5678. or +1 415 555 0100: now x+821012345678 mail alicenoreply@gmail.com git@gmail.com alice@noreply.github.com.evil.com",
    { maxLines: 5, maxChars: 2000 },
  );
  for (const leak of ["5678", "0100", "821012345678", "alicenoreply@", "git@gmail", "alice@noreply"]) {
    assert.equal(bypasses.includes(leak), false, `${leak} leaked: ${bypasses}`);
  }
});

test("#2256 A4 failure readback egress fixture: secrets and private paths redacted, commit SHA kept", () => {
  const normalized = normalizeTaskError({
    code: "handler_exit_nonzero",
    message: "handler exited",
    details: { stage: "handler", excerpt: EGRESS_LINES.join("\n") },
  });
  assertEgressRedacted(String(normalized.details?.excerpt ?? ""));
});

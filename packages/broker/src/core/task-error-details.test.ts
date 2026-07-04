import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTaskError } from "./broker-task-record-normalizers.js";
import { redactAndBoundFailureExcerpt } from "./task-error-details.js";

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const API_KEY = `sk-${"b".repeat(40)}`;

test("failure readback excerpt is bounded and redacted", () => {
  const raw = [
    `GH_TOKEN=${GITHUB_TOKEN}`,
    `OPENAI_API_KEY=${API_KEY}`,
    "/root/.openclaw/private/session.json",
    `telegram:-1001234567890 user@example.com +1 (555) 123-4567`,
    ...Array.from({ length: 30 }, (_, i) => `line-${i}`),
  ].join("\n");

  const excerpt = redactAndBoundFailureExcerpt(raw, { maxLines: 6, maxChars: 260 });

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

import test from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "./index.js";

// Fixtures are assembled at runtime so this file never carries a literal
// token shape that secret scanners would flag.
const GITHUB_TOKEN = ["ghp", "a".repeat(36)].join("_");
const FINE_GRAINED_TOKEN = ["github", "pat", "b".repeat(30)].join("_");
const API_KEY = `sk-${"b".repeat(40)}`;
const XAI_KEY = `xai-${"c".repeat(44)}`;
const SM_KEY = `sm_${"d".repeat(44)}`;
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "f".repeat(64);

test("redactSecrets is exported from the package index", () => {
  assert.equal(typeof redactSecrets, "function");
});

test("redactSecrets scrubs tokens, API keys, auth headers and key=value secrets", () => {
  const out = redactSecrets([
    `GH_TOKEN=${GITHUB_TOKEN}`,
    `fine ${FINE_GRAINED_TOKEN}`,
    `OPENAI_API_KEY=${API_KEY}`,
    `xai ${XAI_KEY} sm ${SM_KEY}`,
    "Authorization: Bearer abc.def.ghi",
    "gh auth login --with-token sekrit-value",
    "token=plain-token-value password=hunter2",
    '{"secret": "json-secret-value", api_key: yaml-secret-value}',
  ].join("\n"));

  for (const leak of [GITHUB_TOKEN, FINE_GRAINED_TOKEN, API_KEY, XAI_KEY, SM_KEY, "abc.def.ghi", "sekrit-value", "plain-token-value", "hunter2", "json-secret-value", "yaml-secret-value"]) {
    assert.equal(out.includes(leak), false, `${leak} leaked: ${out}`);
  }
  assert.match(out, /GH_TOKEN=<redacted/);
  assert.match(out, /<redacted-github-token>/);
  assert.match(out, /OPENAI_API_KEY=<redacted/);
  assert.match(out, /<redacted-api-key>/);
  assert.match(out, /Authorization: Bearer <redacted>/);
  assert.match(out, /--with-token <redacted>/);
  assert.match(out, /token=<redacted>/);
});

test("redactSecrets keeps exact broker marker output for representative lines", () => {
  // Pinned outputs from the pre-move broker `redactSecretText` (#2256 A4):
  // the move into a2a-attestation must not change behaviour.
  assert.equal(redactSecrets(`GH_TOKEN=${GITHUB_TOKEN}`), "GH_TOKEN=<redacted>");
  assert.equal(redactSecrets(`key ${API_KEY}`), "key <redacted-api-key>");
  assert.equal(redactSecrets("see /root/.openclaw/agents/x.json now"), "see <redacted-private-path> now");
  assert.equal(redactSecrets("open file:///etc/private/cfg"), "open file:///<redacted-private-path>");
  assert.equal(redactSecrets("chat_id=-1001234567890"), "chat_id=<redacted-target>");
  assert.equal(redactSecrets("discord:#ops-room"), "discord:#<redacted-target>");
});

test("redactSecrets scrubs provider targets, personal contacts and private paths", () => {
  const out = redactSecrets([
    "/root/.openclaw/private/session.json",
    "/tmp/openclaw-agent-workspace/run-1/log.txt",
    "/home/alice/private.log /Users/bob/notes.txt",
    "telegram:-1001234567890 user@example.com +1 (555) 123-4567",
  ].join("\n"));
  assert.doesNotMatch(out, /\/root\/\.openclaw\/private/);
  assert.doesNotMatch(out, /openclaw-agent-workspace/);
  assert.doesNotMatch(out, /\/home\/alice|\/Users\/bob/);
  assert.match(out, /<redacted-private-path>/);
  assert.match(out, /telegram:<redacted-target>/);
  assert.match(out, /<redacted-email>/);
  assert.match(out, /<redacted-phone>/);
});

test("redactSecrets keeps commit SHAs, digests, non-personal addresses, dates, versions and durations", () => {
  const raw = [
    `commit ${COMMIT_SHA}`,
    `manifest_sha256: ${SHA256}`,
    "remote: git@github.com:owner/repo.git",
    "Co-Authored-By: Bot <noreply@anthropic.com>",
    "author 247078695+someone@users.noreply.github.com",
    "at +2026-09-28 12:34:56 build 1.4.0+20260928.1 took +123456789ms",
  ].join("\n");
  assert.equal(redactSecrets(raw), raw);
});

test("redactSecrets closes the #2286 email/phone bypasses", () => {
  const out = redactSecrets(
    "call +82 10-1234-5678. or +1 415 555 0100: now x+821012345678 mail alicenoreply@gmail.com git@gmail.com alice@noreply.github.com.evil.com contact alice@example.org",
  );
  for (const leak of ["5678", "0100", "821012345678", "alicenoreply@", "git@gmail", "alice@noreply", "alice@example.org"]) {
    assert.equal(out.includes(leak), false, `${leak} leaked: ${out}`);
  }
});

test("redactSecrets is idempotent on its own output", () => {
  const once = redactSecrets(`token=${GITHUB_TOKEN} Authorization: Bearer abc /home/alice/x ${COMMIT_SHA}`);
  assert.equal(redactSecrets(once), once);
});

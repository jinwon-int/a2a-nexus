import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeBrokerId,
  sanitizeBuildSource,
  sanitizeBuildToken,
  sanitizeImageDigest,
  sanitizeIsoTimestamp,
} from "./build-metadata-sanitize.js";

test("build metadata sanitize helpers preserve safe broker ids and reject unsafe ids (#798)", () => {
  assert.equal(sanitizeBrokerId(" brokeralpha-broker:v1 "), "brokeralpha-broker:v1");
  assert.equal(sanitizeBrokerId(undefined), undefined);
  assert.equal(sanitizeBrokerId("   "), undefined);
  assert.throws(
    () => sanitizeBrokerId("https://credential.example.invalid/broker"),
    /A2A_BROKER_ID must be a stable id/,
  );
});

test("build metadata sanitize helpers fallback instead of leaking unsafe build tokens (#798)", () => {
  assert.equal(
    sanitizeBuildToken(" dac061e8765dd269888db921a5b9421873caad5a ", {
      fallback: "unknown",
      unsafeFallback: "redacted",
    }),
    "dac061e8765dd269888db921a5b9421873caad5a",
  );
  assert.equal(
    sanitizeBuildToken(undefined, { fallback: "unknown", unsafeFallback: "redacted" }),
    "unknown",
  );
  assert.equal(
    sanitizeBuildToken("private.registry/team/image:tag with secret", {
      fallback: undefined,
      unsafeFallback: undefined,
    }),
    undefined,
  );
  assert.equal(
    sanitizeBuildToken("https://credential.example.invalid/unsafe", {
      fallback: "unknown",
      unsafeFallback: "redacted",
    }),
    "redacted",
  );
});

test("build metadata sanitize helpers normalize source provenance to a2a-nexus (#798)", () => {
  assert.equal(sanitizeBuildSource("github.com/jinwon-int/a2a-nexus"), "github.com/jinwon-int/a2a-nexus");
  assert.equal(sanitizeBuildSource("https://github.com/jinwon-int/a2a-nexus"), "github.com/jinwon-int/a2a-nexus");
  assert.equal(sanitizeBuildSource("github.com/jinwon-int/a2a-broker"), "github.com/jinwon-int/a2a-nexus");
  assert.equal(sanitizeBuildSource("https://credential.example.invalid/private/repo.git"), "github.com/jinwon-int/a2a-nexus");
  assert.equal(sanitizeBuildSource(undefined), "github.com/jinwon-int/a2a-nexus");
});

test("build metadata sanitize helpers accept only bounded ISO timestamps and sha256 digests (#798)", () => {
  assert.equal(sanitizeIsoTimestamp("2026-06-16T05:20:00Z"), "2026-06-16T05:20:00Z");
  assert.equal(sanitizeIsoTimestamp("2026-06-16T05:20:00.123Z"), "2026-06-16T05:20:00.123Z");
  assert.equal(sanitizeIsoTimestamp("2026-06-16 05:20:00"), undefined);
  assert.equal(sanitizeIsoTimestamp("2026-06-16T05:20:00Z-with-secret-tail"), undefined);

  const digest = `sha256:${"A".repeat(64)}`;
  assert.equal(sanitizeImageDigest(digest), `sha256:${"a".repeat(64)}`);
  assert.equal(sanitizeImageDigest("sha256:not-secret-but-invalid"), undefined);
  assert.equal(sanitizeImageDigest(undefined), undefined);
});

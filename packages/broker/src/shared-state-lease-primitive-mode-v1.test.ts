/**
 * Tests for the #1504 §4 Slice U lease-primitive integration flag parser
 * (`BROKER_SHARED_STATE_V1_LEASE`).
 *
 * Closed vocabulary: unset/empty defaults to `off` (the historical
 * process-local legacy-only task-claim path), `on` is the only enabling value,
 * and any other value must throw rather than be silently coerced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_LEASE_PRIMITIVE_MODE_V1,
  resolveSharedStateLeasePrimitiveModeV1,
} from "./shared-state-lease-primitive-mode-v1.js";

test("lease primitive mode defaults to off for unset and empty values", () => {
  assert.equal(SHARED_STATE_LEASE_PRIMITIVE_MODE_V1.envKey, "BROKER_SHARED_STATE_V1_LEASE");
  assert.equal(resolveSharedStateLeasePrimitiveModeV1(undefined), "off");
  assert.equal(resolveSharedStateLeasePrimitiveModeV1(""), "off");
  assert.equal(resolveSharedStateLeasePrimitiveModeV1("   "), "off");
});

test("lease primitive mode accepts off and on case-insensitively", () => {
  assert.equal(resolveSharedStateLeasePrimitiveModeV1("off"), "off");
  assert.equal(resolveSharedStateLeasePrimitiveModeV1("OFF"), "off");
  assert.equal(resolveSharedStateLeasePrimitiveModeV1("on"), "on");
  assert.equal(resolveSharedStateLeasePrimitiveModeV1(" ON "), "on");
});

test("lease primitive mode throws loudly on any other value", () => {
  for (const raw of ["enabled", "true", "1", "record", "on,off", "\u0000"]) {
    assert.throws(
      () => resolveSharedStateLeasePrimitiveModeV1(raw),
      (error: unknown) => error instanceof Error && error.message.includes("BROKER_SHARED_STATE_V1_LEASE"),
      `expected "${raw}" to be rejected`,
    );
  }
});

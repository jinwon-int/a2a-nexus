/**
 * Tests for the #1504 §4 Slice T rate-primitive integration flag parser
 * (`BROKER_SHARED_STATE_V1_RATE`).
 *
 * Closed vocabulary: unset/empty defaults to `off` (the historical
 * process-local `InMemoryRateLimiter` path), `on` is the only enabling value,
 * and any other value must throw rather than be silently coerced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_RATE_PRIMITIVE_MODE_V1,
  resolveSharedStateRatePrimitiveModeV1,
} from "./shared-state-rate-primitive-mode-v1.js";

test("rate primitive mode defaults to off for unset and empty values", () => {
  assert.equal(SHARED_STATE_RATE_PRIMITIVE_MODE_V1.envKey, "BROKER_SHARED_STATE_V1_RATE");
  assert.equal(resolveSharedStateRatePrimitiveModeV1(undefined), "off");
  assert.equal(resolveSharedStateRatePrimitiveModeV1(""), "off");
  assert.equal(resolveSharedStateRatePrimitiveModeV1("   "), "off");
});

test("rate primitive mode accepts off and on case-insensitively", () => {
  assert.equal(resolveSharedStateRatePrimitiveModeV1("off"), "off");
  assert.equal(resolveSharedStateRatePrimitiveModeV1("OFF"), "off");
  assert.equal(resolveSharedStateRatePrimitiveModeV1("on"), "on");
  assert.equal(resolveSharedStateRatePrimitiveModeV1(" ON "), "on");
});

test("rate primitive mode throws loudly on any other value", () => {
  for (const raw of ["enabled", "true", "1", "record", "on,off", "\u0000"]) {
    assert.throws(
      () => resolveSharedStateRatePrimitiveModeV1(raw),
      (error: unknown) => error instanceof Error && error.message.includes("BROKER_SHARED_STATE_V1_RATE"),
      `expected "${raw}" to be rejected`,
    );
  }
});

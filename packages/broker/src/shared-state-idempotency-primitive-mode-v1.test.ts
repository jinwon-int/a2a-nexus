/**
 * Tests for the #1504 §4 Slice V idempotency-primitive integration flag parser
 * (`BROKER_SHARED_STATE_V1_IDEMPOTENCY`).
 *
 * Closed vocabulary: unset/empty defaults to `off` (the historical
 * process-local legacy-only task-claim path), `on` is the only enabling value,
 * and any other value must throw rather than be silently coerced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_IDEMPOTENCY_PRIMITIVE_MODE_V1,
  resolveSharedStateIdempotencyPrimitiveModeV1,
} from "./shared-state-idempotency-primitive-mode-v1.js";

test("idempotency primitive mode defaults to off for unset and empty values", () => {
  assert.equal(SHARED_STATE_IDEMPOTENCY_PRIMITIVE_MODE_V1.envKey, "BROKER_SHARED_STATE_V1_IDEMPOTENCY");
  assert.equal(resolveSharedStateIdempotencyPrimitiveModeV1(undefined), "off");
  assert.equal(resolveSharedStateIdempotencyPrimitiveModeV1(""), "off");
  assert.equal(resolveSharedStateIdempotencyPrimitiveModeV1("   "), "off");
});

test("idempotency primitive mode accepts off and on case-insensitively", () => {
  assert.equal(resolveSharedStateIdempotencyPrimitiveModeV1("off"), "off");
  assert.equal(resolveSharedStateIdempotencyPrimitiveModeV1("OFF"), "off");
  assert.equal(resolveSharedStateIdempotencyPrimitiveModeV1("on"), "on");
  assert.equal(resolveSharedStateIdempotencyPrimitiveModeV1(" ON "), "on");
});

test("idempotency primitive mode throws loudly on any other value", () => {
  for (const raw of ["enabled", "true", "1", "record", "on,off", "\u0000"]) {
    assert.throws(
      () => resolveSharedStateIdempotencyPrimitiveModeV1(raw),
      (error: unknown) => error instanceof Error && error.message.includes("BROKER_SHARED_STATE_V1_IDEMPOTENCY"),
      `expected "${raw}" to be rejected`,
    );
  }
});

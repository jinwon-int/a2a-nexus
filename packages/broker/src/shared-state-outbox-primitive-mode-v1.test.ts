/**
 * Tests for the #1504 §4 Slice W outbox-primitive integration flag parser
 * (`BROKER_SHARED_STATE_V1_OUTBOX`).
 *
 * Closed vocabulary: unset/empty defaults to `off` (the historical in-memory
 * outbox append path), `on` is the only enabling value, and any other value
 * must throw rather than be silently coerced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_OUTBOX_PRIMITIVE_MODE_V1,
  resolveSharedStateOutboxPrimitiveModeV1,
} from "./shared-state-outbox-primitive-mode-v1.js";

test("outbox primitive mode defaults to off for unset and empty values", () => {
  assert.equal(SHARED_STATE_OUTBOX_PRIMITIVE_MODE_V1.envKey, "BROKER_SHARED_STATE_V1_OUTBOX");
  assert.equal(resolveSharedStateOutboxPrimitiveModeV1(undefined), "off");
  assert.equal(resolveSharedStateOutboxPrimitiveModeV1(""), "off");
  assert.equal(resolveSharedStateOutboxPrimitiveModeV1("   "), "off");
});

test("outbox primitive mode accepts off and on case-insensitively", () => {
  assert.equal(resolveSharedStateOutboxPrimitiveModeV1("off"), "off");
  assert.equal(resolveSharedStateOutboxPrimitiveModeV1("OFF"), "off");
  assert.equal(resolveSharedStateOutboxPrimitiveModeV1("on"), "on");
  assert.equal(resolveSharedStateOutboxPrimitiveModeV1(" ON "), "on");
});

test("outbox primitive mode throws loudly on any other value", () => {
  for (const raw of ["enabled", "true", "1", "record", "on,off", "\u0000"]) {
    assert.throws(
      () => resolveSharedStateOutboxPrimitiveModeV1(raw),
      (error: unknown) => error instanceof Error && error.message.includes("BROKER_SHARED_STATE_V1_OUTBOX"),
      `expected "${raw}" to be rejected`,
    );
  }
});

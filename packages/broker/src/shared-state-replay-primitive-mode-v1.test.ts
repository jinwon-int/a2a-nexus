/**
 * Tests for the #1504 §4 Slice S replay-primitive integration flag parser
 * (`BROKER_SHARED_STATE_V1_REPLAY`).
 *
 * Closed vocabulary: unset/empty defaults to `off` (the historical
 * process-local replay cache path), `on` is the only enabling value, and any
 * other value must throw rather than be silently coerced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_REPLAY_PRIMITIVE_MODE_V1,
  resolveSharedStateReplayPrimitiveModeV1,
} from "./shared-state-replay-primitive-mode-v1.js";

test("replay primitive mode defaults to off for unset and empty values", () => {
  assert.equal(SHARED_STATE_REPLAY_PRIMITIVE_MODE_V1.envKey, "BROKER_SHARED_STATE_V1_REPLAY");
  assert.equal(resolveSharedStateReplayPrimitiveModeV1(undefined), "off");
  assert.equal(resolveSharedStateReplayPrimitiveModeV1(""), "off");
  assert.equal(resolveSharedStateReplayPrimitiveModeV1("   "), "off");
});

test("replay primitive mode accepts off and on case-insensitively", () => {
  assert.equal(resolveSharedStateReplayPrimitiveModeV1("off"), "off");
  assert.equal(resolveSharedStateReplayPrimitiveModeV1("OFF"), "off");
  assert.equal(resolveSharedStateReplayPrimitiveModeV1("on"), "on");
  assert.equal(resolveSharedStateReplayPrimitiveModeV1(" ON "), "on");
});

test("replay primitive mode throws loudly on any other value", () => {
  for (const raw of ["enabled", "true", "1", "record", "on,off", "\u0000"]) {
    assert.throws(
      () => resolveSharedStateReplayPrimitiveModeV1(raw),
      (error: unknown) => error instanceof Error && error.message.includes("BROKER_SHARED_STATE_V1_REPLAY"),
      `expected "${raw}" to be rejected`,
    );
  }
});

/**
 * Tests for the #1504 §4 Slice ZC shadow-runtime mode flag parser
 * (`BROKER_SHADOW_STATE_V1`).
 *
 * Closed vocabulary: unset/empty defaults to `off` (the historical no-shadow
 * observations posture), `on` is the only enabling value, and any other value
 * must throw rather than be silently coerced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_SHADOW_MODE_V1,
  resolveSharedStateShadowModeV1,
} from "./shared-state-shadow-mode-v1.js";

test("shadow runtime mode defaults to off for unset and empty values", () => {
  assert.equal(SHARED_STATE_SHADOW_MODE_V1.envKey, "BROKER_SHADOW_STATE_V1");
  assert.equal(resolveSharedStateShadowModeV1(undefined), "off");
  assert.equal(resolveSharedStateShadowModeV1(""), "off");
  assert.equal(resolveSharedStateShadowModeV1("   "), "off");
});

test("shadow runtime mode accepts off and on case-insensitively", () => {
  assert.equal(resolveSharedStateShadowModeV1("off"), "off");
  assert.equal(resolveSharedStateShadowModeV1("OFF"), "off");
  assert.equal(resolveSharedStateShadowModeV1("on"), "on");
  assert.equal(resolveSharedStateShadowModeV1(" ON "), "on");
});

test("shadow runtime mode throws loudly on any other value", () => {
  for (const raw of ["enabled", "true", "1", "record", "on,off", "\u0000"]) {
    assert.throws(
      () => resolveSharedStateShadowModeV1(raw),
      (error: unknown) => error instanceof Error && error.message.includes("BROKER_SHADOW_STATE_V1"),
      `expected "${raw}" to be rejected`,
    );
  }
});

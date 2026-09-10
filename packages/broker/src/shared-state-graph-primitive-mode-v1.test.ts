/**
 * Tests for the #1504 §4 Slice X graph-primitive integration flag parser
 * (`BROKER_SHARED_STATE_V1_GRAPH`).
 *
 * Closed vocabulary: unset/empty defaults to `off` (the historical no-graph-facts
 * posture), `on` is the only enabling value, and any other value
 * must throw rather than be silently coerced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_GRAPH_PRIMITIVE_MODE_V1,
  resolveSharedStateGraphPrimitiveModeV1,
} from "./shared-state-graph-primitive-mode-v1.js";

test("graph primitive mode defaults to off for unset and empty values", () => {
  assert.equal(SHARED_STATE_GRAPH_PRIMITIVE_MODE_V1.envKey, "BROKER_SHARED_STATE_V1_GRAPH");
  assert.equal(resolveSharedStateGraphPrimitiveModeV1(undefined), "off");
  assert.equal(resolveSharedStateGraphPrimitiveModeV1(""), "off");
  assert.equal(resolveSharedStateGraphPrimitiveModeV1("   "), "off");
});

test("graph primitive mode accepts off and on case-insensitively", () => {
  assert.equal(resolveSharedStateGraphPrimitiveModeV1("off"), "off");
  assert.equal(resolveSharedStateGraphPrimitiveModeV1("OFF"), "off");
  assert.equal(resolveSharedStateGraphPrimitiveModeV1("on"), "on");
  assert.equal(resolveSharedStateGraphPrimitiveModeV1(" ON "), "on");
});

test("graph primitive mode throws loudly on any other value", () => {
  for (const raw of ["enabled", "true", "1", "record", "on,off", "\u0000"]) {
    assert.throws(
      () => resolveSharedStateGraphPrimitiveModeV1(raw),
      (error: unknown) => error instanceof Error && error.message.includes("BROKER_SHARED_STATE_V1_GRAPH"),
      `expected "${raw}" to be rejected`,
    );
  }
});

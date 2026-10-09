/**
 * Tests for the shared #1504 on/off flag parser
 * (`shared-state-on-off-flag-v1.ts`), table-driven over the seven rollout
 * flags that used to each ship their own byte-identical parser module.
 *
 * Closed vocabulary: unset/empty defaults to `off`, `on` is the only enabling
 * value, and any other value must throw — naming the env var — rather than be
 * silently coerced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_ON_OFF_FLAGS_V1,
  SHARED_STATE_ON_OFF_FLAG_MODES_V1,
  resolveSharedStateOnOffFlagV1,
} from "./shared-state-on-off-flag-v1.js";

const EXPECTED_ENV_VARS = {
  replay: "BROKER_SHARED_STATE_V1_REPLAY",
  rate: "BROKER_SHARED_STATE_V1_RATE",
  lease: "BROKER_SHARED_STATE_V1_LEASE",
  idempotency: "BROKER_SHARED_STATE_V1_IDEMPOTENCY",
  outbox: "BROKER_SHARED_STATE_V1_OUTBOX",
  graph: "BROKER_SHARED_STATE_V1_GRAPH",
  shadow: "BROKER_SHADOW_STATE_V1",
} as const;

const INVALID_VALUES = ["enabled", "true", "1", "record", "on,off", "\u0000"];

test("on/off flag table lists exactly the seven #1504 flags with their env vars", () => {
  assert.deepEqual(SHARED_STATE_ON_OFF_FLAG_MODES_V1, ["off", "on"]);
  assert.deepEqual(
    Object.keys(SHARED_STATE_ON_OFF_FLAGS_V1).sort(),
    Object.keys(EXPECTED_ENV_VARS).sort(),
  );
  for (const [key, expectedEnvVar] of Object.entries(EXPECTED_ENV_VARS)) {
    const descriptor = SHARED_STATE_ON_OFF_FLAGS_V1[key as keyof typeof SHARED_STATE_ON_OFF_FLAGS_V1];
    assert.equal(descriptor.key, key);
    assert.equal(descriptor.envVar, expectedEnvVar);
    assert.ok(descriptor.slice.includes("#1504"), `${key} descriptor must cite its #1504 slice`);
    assert.ok(Object.isFrozen(descriptor), `${key} descriptor must be frozen`);
  }
  assert.ok(Object.isFrozen(SHARED_STATE_ON_OFF_FLAGS_V1));
  const envVars = Object.values(SHARED_STATE_ON_OFF_FLAGS_V1).map((flag) => flag.envVar);
  assert.equal(new Set(envVars).size, envVars.length, "env vars must be unique");
});

for (const descriptor of Object.values(SHARED_STATE_ON_OFF_FLAGS_V1)) {
  const { key, envVar } = descriptor;

  test(`${key} flag (${envVar}) defaults to off for unset and empty values`, () => {
    assert.equal(resolveSharedStateOnOffFlagV1(envVar, undefined), "off");
    assert.equal(resolveSharedStateOnOffFlagV1(envVar, ""), "off");
    assert.equal(resolveSharedStateOnOffFlagV1(envVar, "   "), "off");
  });

  test(`${key} flag (${envVar}) accepts off and on case-insensitively`, () => {
    assert.equal(resolveSharedStateOnOffFlagV1(envVar, "off"), "off");
    assert.equal(resolveSharedStateOnOffFlagV1(envVar, "OFF"), "off");
    assert.equal(resolveSharedStateOnOffFlagV1(envVar, "on"), "on");
    assert.equal(resolveSharedStateOnOffFlagV1(envVar, " ON "), "on");
  });

  test(`${key} flag (${envVar}) throws loudly, naming the env var, on any other value`, () => {
    for (const raw of INVALID_VALUES) {
      assert.throws(
        () => resolveSharedStateOnOffFlagV1(envVar, raw),
        (error: unknown) =>
          error instanceof Error &&
          error.message === `invalid ${envVar}='${raw}' (expected off | on)`,
        `expected "${raw}" to be rejected for ${envVar}`,
      );
    }
  });
}

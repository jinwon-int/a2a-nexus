/**
 * Rate-primitive integration flag for #1504 §4 "Integrate primitives one
 * at a time behind default-off flags" (Slice T, rate second — after Slice S
 * replay).
 *
 * Same posture as `shared-state-replay-primitive-mode-v1` and
 * `core/wave-plan-dag-v2-mode.ts`: unset/empty is the safe default (`off`, the
 * historical process-local `InMemoryRateLimiter` path), `on` routes the
 * broker-edge rate-limit check through the V1 shared-state adapter's
 * `reserveRateLimitCost` via the serving fence, and any other value fails
 * loudly at startup rather than being silently coerced.
 *
 * This module only parses. The broker does not read these values anywhere
 * else; wiring lives in `server.ts`.
 */

export const SHARED_STATE_RATE_PRIMITIVE_MODE_V1 = Object.freeze({
  kind: "SharedStateRatePrimitiveModeV1",
  envKey: "BROKER_SHARED_STATE_V1_RATE",
  modes: ["off", "on"],
} as const);

export type SharedStateRatePrimitiveModeV1 =
  (typeof SHARED_STATE_RATE_PRIMITIVE_MODE_V1.modes)[number];

export function resolveSharedStateRatePrimitiveModeV1(
  raw: string | undefined,
): SharedStateRatePrimitiveModeV1 {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(
    `invalid ${SHARED_STATE_RATE_PRIMITIVE_MODE_V1.envKey}='${raw}' (expected off | on)`,
  );
}

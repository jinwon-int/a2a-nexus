/**
 * Lease-primitive integration flag for #1504 §4 "Integrate primitives one
 * at a time behind default-off flags" (Slice U, lease third — after Slice S
 * replay and Slice T rate).
 *
 * Same posture as the replay/rate primitive flags and
 * `core/wave-plan-dag-v2-mode.ts`: unset/empty is the safe default (`off`, the
 * historical legacy-only task-claim path), `on` routes the worker task-claim
 * lifecycle (claim grant, heartbeat renewal, checkpoint/terminal mutations,
 * operator requeue release) through the V1 shared-state adapter's lease
 * commands via the serving fence, and any other value fails loudly at startup
 * rather than being silently coerced.
 *
 * This module only parses. The broker does not read these values anywhere
 * else; wiring lives in `server.ts`.
 */

export const SHARED_STATE_LEASE_PRIMITIVE_MODE_V1 = Object.freeze({
  kind: "SharedStateLeasePrimitiveModeV1",
  envKey: "BROKER_SHARED_STATE_V1_LEASE",
  modes: ["off", "on"],
} as const);

export type SharedStateLeasePrimitiveModeV1 =
  (typeof SHARED_STATE_LEASE_PRIMITIVE_MODE_V1.modes)[number];

export function resolveSharedStateLeasePrimitiveModeV1(
  raw: string | undefined,
): SharedStateLeasePrimitiveModeV1 {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(
    `invalid ${SHARED_STATE_LEASE_PRIMITIVE_MODE_V1.envKey}='${raw}' (expected off | on)`,
  );
}

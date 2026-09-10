/**
 * Idempotency-primitive integration flag for #1504 §4 "Integrate primitives
 * one at a time behind default-off flags" (Slice V, idempotency fourth —
 * after Slice S replay, Slice T rate, and Slice U lease).
 *
 * Same posture as the replay/rate/lease primitive flags and
 * `core/wave-plan-dag-v2-mode.ts`: unset/empty is the safe default (`off`, the
 * historical legacy-only idempotent-create path), `on` routes the task-create
 * by caller-selected-id authority (`broker.task.create`, §5.4.1) through the
 * V1 shared-state adapter's `executeIdempotent` via the serving fence, and
 * any other value fails loudly at startup rather than being silently coerced.
 *
 * This module only parses. The broker does not read these values anywhere
 * else; wiring lives in `server.ts`.
 */

export const SHARED_STATE_IDEMPOTENCY_PRIMITIVE_MODE_V1 = Object.freeze({
  kind: "SharedStateIdempotencyPrimitiveModeV1",
  envKey: "BROKER_SHARED_STATE_V1_IDEMPOTENCY",
  modes: ["off", "on"],
} as const);

export type SharedStateIdempotencyPrimitiveModeV1 =
  (typeof SHARED_STATE_IDEMPOTENCY_PRIMITIVE_MODE_V1.modes)[number];

export function resolveSharedStateIdempotencyPrimitiveModeV1(
  raw: string | undefined,
): SharedStateIdempotencyPrimitiveModeV1 {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(
    `invalid ${SHARED_STATE_IDEMPOTENCY_PRIMITIVE_MODE_V1.envKey}='${raw}' (expected off | on)`,
  );
}

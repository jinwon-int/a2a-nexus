/**
 * Outbox-primitive integration flag for #1504 §4 "Integrate primitives one
 * at a time behind default-off flags" (Slice W, outbox fifth — after Slice S
 * replay, Slice T rate, Slice U lease, and Slice V idempotency).
 *
 * Same posture as the other primitive flags and `core/wave-plan-dag-v2-mode.ts`:
 * unset/empty is the safe default (`off`, the historical in-memory outbox
 * append path), `on` routes the task-terminal-notification append/ordering
 * authority (§5.5, `broker.terminal-outbox`) through the V1 shared-state
 * adapter's `appendOutbox` via the serving fence, and any other value fails
 * loudly at startup rather than being silently coerced.
 *
 * This module only parses. The broker does not read these values anywhere
 * else; wiring lives in `server.ts`.
 */

export const SHARED_STATE_OUTBOX_PRIMITIVE_MODE_V1 = Object.freeze({
  kind: "SharedStateOutboxPrimitiveModeV1",
  envKey: "BROKER_SHARED_STATE_V1_OUTBOX",
  modes: ["off", "on"],
} as const);

export type SharedStateOutboxPrimitiveModeV1 =
  (typeof SHARED_STATE_OUTBOX_PRIMITIVE_MODE_V1.modes)[number];

export function resolveSharedStateOutboxPrimitiveModeV1(
  raw: string | undefined,
): SharedStateOutboxPrimitiveModeV1 {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(
    `invalid ${SHARED_STATE_OUTBOX_PRIMITIVE_MODE_V1.envKey}='${raw}' (expected off | on)`,
  );
}

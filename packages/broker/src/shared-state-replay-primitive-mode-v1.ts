/**
 * Replay-primitive integration flag for #1504 §4 "Integrate primitives one
 * at a time behind default-off flags" (Slice S, replay first).
 *
 * Same posture as `core/wave-plan-dag-v2-mode.ts`: unset/empty is the safe
 * default (`off`, the historical process-local `A2AHttpSignatureReplayCache`
 * path), `on` routes the worker HTTP-signature replay check through the V1
 * shared-state adapter's `consumeReplayNonce` via the serving fence, and any
 * other value fails loudly at startup rather than being silently coerced.
 *
 * This module only parses. The broker does not read these values anywhere
 * else; wiring lives in `server.ts`.
 */

export const SHARED_STATE_REPLAY_PRIMITIVE_MODE_V1 = Object.freeze({
  kind: "SharedStateReplayPrimitiveModeV1",
  envKey: "BROKER_SHARED_STATE_V1_REPLAY",
  modes: ["off", "on"],
} as const);

export type SharedStateReplayPrimitiveModeV1 =
  (typeof SHARED_STATE_REPLAY_PRIMITIVE_MODE_V1.modes)[number];

export function resolveSharedStateReplayPrimitiveModeV1(
  raw: string | undefined,
): SharedStateReplayPrimitiveModeV1 {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(
    `invalid ${SHARED_STATE_REPLAY_PRIMITIVE_MODE_V1.envKey}='${raw}' (expected off | on)`,
  );
}

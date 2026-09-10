/**
 * Shadow-runtime mode flag for #1504 §5 Phase 6 (live shadow).
 *
 * Same posture as the primitive flags and `core/wave-plan-dag-v2-mode.ts`:
 * unset/empty is the safe default (`off`, no shadow observations are made),
 * `on` starts the read-only live-shadow runtime that mirrors replay and
 * rate-limit decisions into a SEPARATE shadow store and classifies
 * divergences — it can never drive any decision (plan.md Phase 6: "adapter
 * shadow ... cannot drive authorization, claim, ACK, send, finalization, or
 * response decisions"). Any other value fails loudly at startup.
 *
 * The shadow store file is configured separately (option
 * `shadowStateFile` / env `BROKER_SHADOW_STATE_FILE`); it must never point
 * at the serving store or the serving-fence CAS store.
 *
 * This module only parses. The broker does not read these values anywhere
 * else; wiring lives in `server.ts`.
 */

export const SHARED_STATE_SHADOW_MODE_V1 = Object.freeze({
  kind: "SharedStateShadowModeV1",
  envKey: "BROKER_SHADOW_STATE_V1",
  modes: ["off", "on"],
} as const);

export type SharedStateShadowModeV1 =
  (typeof SHARED_STATE_SHADOW_MODE_V1.modes)[number];

export function resolveSharedStateShadowModeV1(
  raw: string | undefined,
): SharedStateShadowModeV1 {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(
    `invalid ${SHARED_STATE_SHADOW_MODE_V1.envKey}='${raw}' (expected off | on)`,
  );
}

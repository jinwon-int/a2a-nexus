/**
 * Graph-primitive integration flag for #1504 §4 "Integrate primitives one
 * at a time behind default-off flags" (Slice X, graph last — after Slice S
 * replay, Slice T rate, Slice U lease, Slice V idempotency, and Slice W
 * outbox).
 *
 * Same posture as the other primitive flags and `core/wave-plan-dag-v2-mode.ts`:
 * unset/empty is the safe default (`off`, no graph source facts are produced),
 * `on` routes the §5.6 source-fact append authority for terminal task facts
 * (namespace `broker.claim-graph`) through the V1 shared-state adapter's
 * `appendGraphSource` via the serving fence, and any other value fails loudly
 * at startup rather than being silently coerced.
 *
 * This module only parses. The broker does not read these values anywhere
 * else; wiring lives in `server.ts`.
 */

export const SHARED_STATE_GRAPH_PRIMITIVE_MODE_V1 = Object.freeze({
  kind: "SharedStateGraphPrimitiveModeV1",
  envKey: "BROKER_SHARED_STATE_V1_GRAPH",
  modes: ["off", "on"],
} as const);

export type SharedStateGraphPrimitiveModeV1 =
  (typeof SHARED_STATE_GRAPH_PRIMITIVE_MODE_V1.modes)[number];

export function resolveSharedStateGraphPrimitiveModeV1(
  raw: string | undefined,
): SharedStateGraphPrimitiveModeV1 {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(
    `invalid ${SHARED_STATE_GRAPH_PRIMITIVE_MODE_V1.envKey}='${raw}' (expected off | on)`,
  );
}

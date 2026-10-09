/**
 * Shared on/off flag parser for the #1504 shared-state rollout flags.
 *
 * One closed-vocabulary parser replaces the seven byte-identical per-flag
 * modules (`shared-state-{replay,rate,lease,idempotency,outbox,graph}-
 * primitive-mode-v1.ts` and `shared-state-shadow-mode-v1.ts`). Same posture as
 * `core/wave-plan-dag-v2-mode.ts`: unset/empty is the safe default (`off`),
 * `on` is the only enabling value, and any other value fails loudly at
 * startup rather than being silently coerced. The error message names the
 * env var so operators still see which flag was misconfigured.
 *
 * This module only parses. Wiring lives in `server.ts`.
 */

export const SHARED_STATE_ON_OFF_FLAG_MODES_V1 = Object.freeze(["off", "on"] as const);

export type SharedStateOnOffFlagModeV1 =
  (typeof SHARED_STATE_ON_OFF_FLAG_MODES_V1)[number];

export interface SharedStateOnOffFlagDescriptorV1 {
  /** Stable short name of the flag (matches the `sharedState<Key>V1` option). */
  readonly key: string;
  /** Environment variable consulted when no explicit option override is set. */
  readonly envVar: string;
  /** Rollout slice the flag belongs to (#1504 §4/§5) and what `on` enables. */
  readonly slice: string;
}

/**
 * The seven #1504 rollout flags, in integration order (Slice S → X, then the
 * §5 Phase 6 shadow runtime).
 */
export const SHARED_STATE_ON_OFF_FLAGS_V1 = Object.freeze({
  replay: Object.freeze({
    key: "replay",
    envVar: "BROKER_SHARED_STATE_V1_REPLAY",
    slice:
      "#1504 §4 Slice S — replay primitive: `on` routes the worker HTTP-signature replay check through the V1 adapter's `consumeReplayNonce` via the serving fence (default: process-local `A2AHttpSignatureReplayCache`).",
  }),
  rate: Object.freeze({
    key: "rate",
    envVar: "BROKER_SHARED_STATE_V1_RATE",
    slice:
      "#1504 §4 Slice T — rate primitive: `on` routes the broker-edge rate-limit check through the V1 adapter's `reserveRateLimitCost` via the serving fence (default: process-local `InMemoryRateLimiter`).",
  }),
  lease: Object.freeze({
    key: "lease",
    envVar: "BROKER_SHARED_STATE_V1_LEASE",
    slice:
      "#1504 §4 Slice U — lease primitive: `on` fences the worker task-claim lifecycle (claim grant, heartbeat renewal, checkpoint/terminal mutations, operator requeue release) through the V1 lease commands via the serving fence (default: legacy-only task-claim path).",
  }),
  idempotency: Object.freeze({
    key: "idempotency",
    envVar: "BROKER_SHARED_STATE_V1_IDEMPOTENCY",
    slice:
      "#1504 §4 Slice V — idempotency primitive: `on` routes the task-create by caller-selected-id authority (`broker.task.create`, §5.4.1) through the V1 adapter's `executeIdempotent` via the serving fence (default: legacy-only idempotent-create path).",
  }),
  outbox: Object.freeze({
    key: "outbox",
    envVar: "BROKER_SHARED_STATE_V1_OUTBOX",
    slice:
      "#1504 §4 Slice W — outbox primitive: `on` routes the task-terminal-notification append/ordering authority (§5.5, `broker.terminal-outbox`) through the V1 adapter's `appendOutbox` via the serving fence (default: in-memory outbox append path).",
  }),
  graph: Object.freeze({
    key: "graph",
    envVar: "BROKER_SHARED_STATE_V1_GRAPH",
    slice:
      "#1504 §4 Slice X — graph primitive: `on` routes the §5.6 source-fact append authority for terminal task facts (namespace `broker.claim-graph`) through the V1 adapter's `appendGraphSource` via the serving fence (default: no graph source facts are produced).",
  }),
  shadow: Object.freeze({
    key: "shadow",
    envVar: "BROKER_SHADOW_STATE_V1",
    slice:
      "#1504 §5 Phase 6 — live-shadow runtime: `on` starts the read-only shadow runtime that mirrors replay and rate-limit decisions into a SEPARATE shadow store (`shadowStateFile` / `BROKER_SHADOW_STATE_FILE`) and classifies divergences; it can never drive any decision (default: no shadow observations).",
  }),
} as const satisfies Readonly<Record<string, SharedStateOnOffFlagDescriptorV1>>);

export type SharedStateOnOffFlagKeyV1 = keyof typeof SHARED_STATE_ON_OFF_FLAGS_V1;

/**
 * Parses a raw flag value. `flagName` is echoed in the error so the operator
 * sees which flag (env var) was misconfigured.
 */
export function resolveSharedStateOnOffFlagV1(
  flagName: string,
  raw: string | undefined,
): SharedStateOnOffFlagModeV1 {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  throw new Error(`invalid ${flagName}='${raw}' (expected off | on)`);
}

/**
 * Slice R: full secret-safe `/health` `stateContract` bound to the closed
 * observability catalog (spec section 7.4, `public-aggregate` boundary).
 *
 * The runtime assembles a catalog CANDIDATE — the full health declaration plus
 * per-domain observations — and runs it through the pure public projector.
 * That gives every published member the catalog's coarsening (exact process
 * count becomes a one|multiple band) and its recursive leak preflight for
 * free; nothing reaches `/health` unless the catalog parser accepted it.
 *
 * Honesty boundaries (unchanged from Slice M): the serving store is
 * `legacy-process`, so `contractVersion` stays null, the V1 primitive domains
 * are `not-applicable` (`primitive-not-implemented`), and the security
 * primitives are the process-local replay cache and rate limiter, whose
 * cumulative counters are real and whose reset risk is real.
 *
 * Pure module: reads no clock, store, process, or environment. All inputs are
 * observed by the caller and passed in.
 */

import {
  projectSharedStatePublicObservabilityV1,
  type SharedStatePublicObservabilityProjectionV1,
} from "./shared-state-observability-v1.js";
import { SHARED_STATE_OBSERVABILITY_V1_VALUES as OV } from "./shared-state-observability-v1-values.js";
import type { SharedStateHealthProjectionV1 } from "./shared-state-storage-contract-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as SV } from "./shared-state-storage-v1-values.js";

export type SharedStateContractOwnershipV1 = "held" | "lost";

/** One bounded replay-cache observation (#1504 §2 counters, §7.4 counts). */
export interface ReplayCacheStatsV1 {
  readonly accepted: number;
  readonly replayed: number;
}

/** Coarse rate-limit observation inputs; the projector applies the bands. */
export interface RateLimitObservationInputV1 {
  readonly windowMs: number;
  readonly limit: number;
  readonly allowed: number;
  readonly denied: number;
  /**
   * #1504 Slice T: count of reservations lost to an unavailable authoritative
   * store (the retryable `state_unavailable` rejections). The process-local
   * limiter cannot produce these, so the flag-off path stays at zero.
   */
  readonly storeErrors?: number;
}

function ageBandFromSeconds(ageSec: number): (typeof OV.ageBands)[number] {
  if (ageSec < 60) return "under-1m";
  if (ageSec < 300) return "under-5m";
  if (ageSec < 3_600) return "under-1h";
  if (ageSec < 86_400) return "under-1d";
  return "one-day-or-more";
}

function rateWindowBand(windowMs: number): (typeof OV.rateWindowBands)[number] {
  if (windowMs < 60_000) return "under-1m";
  if (windowMs < 300_000) return "1m-to-under-5m";
  if (windowMs < 3_600_000) return "5m-to-under-1h";
  return "1h-or-more";
}

function rateLimitBand(limit: number): (typeof OV.rateLimitBands)[number] {
  if (limit < 10) return "under-10";
  if (limit < 100) return "10-to-under-100";
  if (limit < 1_000) return "100-to-under-1000";
  return "1000-or-more";
}

/**
 * Coarse pressure band from the share of denied requests in the window.
 * Reporting aid only: the catalog band vocabulary has no exact-pressure claim,
 * and a deployment with no traffic reports `none` (zero is safe to report).
 */
function pressureBandFromDenials(denied: number, total: number): (typeof OV.pressureBands)[number] {
  if (total <= 0) return "none";
  const share = denied / total;
  if (share < 0.01) return "none";
  if (share < 0.05) return "low";
  if (share < 0.2) return "medium";
  return "high";
}

/**
 * The full section 7.3/7.4 health DECLARATION — every field the catalog
 * candidate's `health` member requires, filled with what this deployment can
 * honestly claim. `legacy-process` means: no V1 adapter, null contract and
 * schema versions, no adapter clock authority, and no pending migration.
 */
export function buildSharedStateHealthDeclarationV1(input: {
  readonly configuredGrade: string;
  readonly effectiveGrade: string;
  readonly gradeDefaulted: boolean;
  readonly serving: boolean;
  readonly ownership: SharedStateContractOwnershipV1;
  readonly reasonCodes: SharedStateHealthProjectionV1["reasonCodes"];
  readonly expectedProcessCount: number;
  readonly persistenceBackend: "json-file" | "sqlite";
  readonly clockSafety: (typeof SV.clockSafetyStates)[number];
  readonly processUptimeSec: number;
  readonly rateLimitDenied: number;
  readonly rateLimitTotal: number;
}): SharedStateHealthProjectionV1 {
  const epochAgeBand = ageBandFromSeconds(Math.max(0, input.processUptimeSec));
  const pressureBand = pressureBandFromDenials(input.rateLimitDenied, input.rateLimitTotal);
  // The adapter block reflects the ACTUAL serving store; the contract's own
  // compatibility rule pins each class (legacy-process: volatile, all V1
  // fields null; legacy-sqlite: durable, known schema version, no migration
  // state). Grade coherence is enforced by the declaration parser itself, so
  // an incoherent candidate fails closed instead of publishing a lie.
  const legacySqlite = input.persistenceBackend === "sqlite";
  return {
    kind: SV.kinds.health,
    specVersion: SV.versions.health,
    configuredGrade: input.configuredGrade as SharedStateHealthProjectionV1["configuredGrade"],
    effectiveGrade: input.effectiveGrade as SharedStateHealthProjectionV1["effectiveGrade"],
    gradeDefaulted: input.gradeDefaulted,
    serving: input.serving,
    reasonCodes: [...input.reasonCodes],
    adapter: {
      contractVersion: null,
      backendClass: legacySqlite ? "legacy-sqlite" : "legacy-process",
      lifecycle: "ready",
      durability: legacySqlite ? "durable" : "volatile",
      writerModel: "single",
      schemaVersion: legacySqlite ? 13 : null,
      clockAuthority: null,
      migrationState: null,
    },
    topology: {
      expectedProcessCount: input.expectedProcessCount,
      ownership: input.ownership,
    },
    clock: {
      safety: input.clockSafety,
    },
    consistency: {
      replay: SV.consistencyGuarantees.replay,
      rateLimit: SV.consistencyGuarantees.rateLimit,
      lease: SV.consistencyGuarantees.lease,
      idempotency: SV.consistencyGuarantees.idempotency,
      outbox: SV.consistencyGuarantees.outbox,
      graphSource: SV.consistencyGuarantees.graphSource,
      graphProjection: SV.consistencyGuarantees.graphProjection,
    },
    completeness: {
      graphProjection: "unavailable",
      negativeEvidenceAllowed: false,
    },
    primitives: {
      replay: {
        source: "process",
        durability: "volatile",
        continuity: "reset",
        resetRisk: true,
        epochAgeBand,
        pressureBand,
        lastResetReason: "process_start",
      },
      rateLimit: {
        source: "process",
        durability: "volatile",
        continuity: "reset",
        resetRisk: true,
        epochAgeBand,
        pressureBand,
        lastResetReason: "process_start",
      },
    },
  };
}

/**
 * Assembles the catalog candidate (declaration + observations) and projects
 * the PUBLIC aggregate. The V1 primitive domains are `not-applicable` because
 * none is implemented in the serving path; the two process-local security
 * primitives report real cumulative counters. Returns the projection result
 * verbatim — the caller decides how a failed projection surfaces (the catalog
 * parser failing means the runtime built an incoherent candidate, which is a
 * bug, not a public fact).
 */
export function buildSharedStatePublicObservabilityV1(input: {
  readonly health: SharedStateHealthProjectionV1;
  readonly clockContinuity: (typeof OV.clockContinuityStates)[number];
  readonly replay: ReplayCacheStatsV1;
  readonly rateLimit: RateLimitObservationInputV1;
}): SharedStateObservabilityResultOf {
  const candidate = {
    kind: OV.kinds.candidate,
    catalogVersion: OV.version,
    health: input.health,
    clockContinuity: input.clockContinuity,
    observations: {
      replay: {
        availability: "available",
        counts: {
          accepted: Math.max(0, Math.round(input.replay.accepted)),
          replayed: Math.max(0, Math.round(input.replay.replayed)),
          unavailable: 0,
          storeErrors: 0,
        },
      },
      rateLimit: {
        availability: "available",
        windowBand: rateWindowBand(input.rateLimit.windowMs),
        limitBand: rateLimitBand(input.rateLimit.limit),
        counts: {
          allowed: Math.max(0, Math.round(input.rateLimit.allowed)),
          denied: Math.max(0, Math.round(input.rateLimit.denied)),
          storeErrors: Math.max(0, Math.round(input.rateLimit.storeErrors ?? 0)),
        },
      },
      leaseClaim: { availability: "not-applicable", reasonCode: "primitive-not-implemented" },
      idempotency: { availability: "not-applicable", reasonCode: "primitive-not-implemented" },
      outbox: { availability: "not-applicable", reasonCode: "primitive-not-implemented" },
      claimGraphProjection: { availability: "not-applicable", reasonCode: "primitive-not-implemented" },
    },
  };
  return projectSharedStatePublicObservabilityV1(candidate) as SharedStateObservabilityResultOf;
}

type SharedStateObservabilityResultOf =
  | { readonly ok: true; readonly value: SharedStatePublicObservabilityProjectionV1 }
  | { readonly ok: false; readonly error: { readonly code: string; readonly path: readonly (string | number)[] } };

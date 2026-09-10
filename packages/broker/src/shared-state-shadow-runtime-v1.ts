/**
 * Live-shadow runtime for #1504 §5 Phase 6 (plan.md "Separately authorized
 * SQLite live shadow").
 *
 * The runtime mirrors the two security primitives the broker serves —
 * worker-signature replay nonces and broker-edge rate limits — into a
 * SEPARATE shadow store (its own SQLite file, its own adapter, never the
 * serving store or the serving-fence CAS store) and classifies the shadow's
 * decision against the live outcome:
 *
 * - `match`            — the shadow agreed with the live decision;
 * - `warmup_mismatch`  — the shadow disagreed during the warm-up bound
 *                        (the live store carries pre-shadow history the
 *                        shadow lacks: live nonces older than the shadow's
 *                        start and rate buckets in flight); bounded by the
 *                        warm-up window, after which this class can no
 *                        longer occur;
 * - `unexplained`      — any disagreement outside the warm-up bound, or a
 *                        shadow evaluation failure; the plan's blocking
 *                        class.
 *
 * The runtime is evidence-only: every method catches its own failures and
 * records them as `unexplained` observations — it can never throw into the
 * request path, never drive a decision, and never touch the serving store.
 * Counters are aggregate-only (no keys, nonces, or identities — §5.5/§5.6
 * observability rules).
 */

import { DatabaseSync } from "node:sqlite";

import {
  SharedStateSqliteAdapterV1,
} from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  parseSharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-v1-values.js";
import { digestSharedStateKeyV1 } from "./shared-state-storage-keyspace-v1.js";

export const SHARED_STATE_SHADOW_RUNTIME_V1 = Object.freeze({
  kind: "SharedStateShadowRuntimeV1",
  replayNamespace: "shadow.replay.broker-worker-signature",
  rateNamespace: "shadow.rate.broker-edge",
  outboxStreamType: "shadow",
  /** Warm-up bound: live nonces live ≤ the signature-expiry bound (~5 min); rate buckets ≤ the rate window. */
  warmupMs: 300_000,
} as const);

export interface SharedStateShadowSnapshotV1 {
  readonly startedAtUnixMs: number;
  readonly replay: {
    readonly compared: number;
    readonly matches: number;
    readonly warmupMismatches: number;
    readonly unexplained: number;
  };
  readonly rate: {
    readonly compared: number;
    readonly matches: number;
    readonly warmupMismatches: number;
    readonly unexplained: number;
  };
}

type Family = "replay" | "rate";

export class SharedStateShadowRuntimeV1 {
  readonly #adapter: SharedStateSqliteAdapterV1;
  readonly #db: DatabaseSync;
  readonly #startedAtMs: number;
  readonly #counters: Record<Family, {
    compared: number; matches: number; warmupMismatches: number; unexplained: number;
  }> = {
    replay: { compared: 0, matches: 0, warmupMismatches: 0, unexplained: 0 },
    rate: { compared: 0, matches: 0, warmupMismatches: 0, unexplained: 0 },
  };

  constructor(input: { readonly shadowFile: string; readonly startedAtMs?: number }) {
    this.#db = new DatabaseSync(input.shadowFile);
    applySharedStateSqliteSchemaV1(this.#db);
    this.#adapter = new SharedStateSqliteAdapterV1({
      db: this.#db,
      ownerToken: "shared-state-shadow-runtime",
      backwardSkewToleranceMs: "300000",
    });
    const opened = this.#adapter.open();
    if (!opened.ok) {
      const message = `shadow adapter open failed: ${opened.error?.code}`;
      this.#db.close();
      throw new Error(message);
    }
    this.#startedAtMs = input.startedAtMs ?? Date.now();
  }

  close(): void {
    const closed = this.#adapter.close();
    if (!closed.ok && closed.error?.code !== "not_ready") {
      // Closing a failed-open adapter reports not_ready; nothing to do.
    }
    this.#db.close();
  }

  /**
   * Mirrors one live replay-check outcome. `liveWasFirst` is the live
   * decision (true = the nonce was fresh); the shadow consumes the same
   * nonce in its own store and compares.
   */
  observeReplay(
    input: {
      readonly keyid: string;
      readonly nonce: string;
      readonly ttlMs: number;
      readonly liveWasFirst: boolean;
    },
    nowMs = Date.now(),
  ): void {
    this.#observe("replay", nowMs, () => {
      const keyDigest = digestSharedStateKeyV1({
        keyspaceVersion: V.versions.keyspace,
        domain: "security.replay.requester-key",
        namespace: SHARED_STATE_SHADOW_RUNTIME_V1.replayNamespace,
        components: [{ field: "requesterId", type: "utf8", value: input.keyid }],
      });
      if (!keyDigest.ok) return null;
      const nonceDigest = digestSharedStateKeyV1({
        keyspaceVersion: V.versions.keyspace,
        domain: "security.replay.nonce",
        namespace: SHARED_STATE_SHADOW_RUNTIME_V1.replayNamespace,
        components: [{ field: "nonce", type: "utf8", value: input.nonce }],
      });
      if (!nonceDigest.ok) return null;
      const command = parseSharedStateTransactionCommandV1({
        kind: V.kinds.transactionCommand,
        contractVersion: V.versions.contract,
        transactionVersion: V.versions.transaction,
        operationVersion: V.versions.operation,
        operation: V.operations[0],
        input: {
          namespace: SHARED_STATE_SHADOW_RUNTIME_V1.replayNamespace,
          keyDigest: keyDigest.value.digest,
          nonceDigest: nonceDigest.value.digest,
          ttlMs: Math.max(1, input.ttlMs),
        },
      });
      if (!command.ok) return null;
      const result = this.#adapter.transact(command.value, {
        observedAtUnixMs: String(nowMs),
      });
      if (!result.ok) return null;
      const decision = (result.value as {
        result?: { decision?: unknown };
      }).result?.decision;
      if (decision === V.operationDecisions.consumeReplayNonce[0]) return "first";
      if (decision === V.operationDecisions.consumeReplayNonce[1]) return "duplicate";
      return null;
    }, input.liveWasFirst ? "first" : "duplicate");
  }

  /**
   * Mirrors one live rate-limit outcome. `liveAllowed` is the live decision;
   * the shadow reserves the same cost in its own store and compares the
   * allowed/denied decision (§5.2: confirmed exhaustion vs unknown state —
   * remaining counts are not compared, only the decision).
   */
  observeRate(
    input: {
      readonly bucketClass: "general" | "worker";
      readonly principal: string;
      readonly limit: number;
      readonly windowMs: number;
      readonly liveAllowed: boolean;
    },
    nowMs = Date.now(),
  ): void {
    this.#observe("rate", nowMs, () => {
      const bucketKeyDigest = digestSharedStateKeyV1({
        keyspaceVersion: V.versions.keyspace,
        domain: "security.rate-limit.bucket-key",
        namespace: SHARED_STATE_SHADOW_RUNTIME_V1.rateNamespace,
        components: [
          { field: "principal", type: "utf8", value: input.principal },
          { field: "route", type: "utf8", value: input.bucketClass },
        ],
      });
      if (!bucketKeyDigest.ok) return null;
      const command = parseSharedStateTransactionCommandV1({
        kind: V.kinds.transactionCommand,
        contractVersion: V.versions.contract,
        transactionVersion: V.versions.transaction,
        operationVersion: V.versions.operation,
        operation: V.operations[1],
        input: {
          namespace: SHARED_STATE_SHADOW_RUNTIME_V1.rateNamespace,
          bucketKeyDigest: bucketKeyDigest.value.digest,
          cost: 1,
          limit: input.limit,
          windowMs: input.windowMs,
        },
      });
      if (!command.ok) return null;
      const result = this.#adapter.transact(command.value, {
        observedAtUnixMs: String(nowMs),
      });
      if (!result.ok) return null;
      const decision = (result.value as {
        result?: { decision?: unknown };
      }).result?.decision;
      if (decision === V.operationDecisions.reserveRateLimitCost[0]) return "allowed";
      if (decision === V.operationDecisions.reserveRateLimitCost[1]) return "denied";
      return null;
    }, input.liveAllowed ? "allowed" : "denied");
  }

  #observe(
    family: Family,
    nowMs: number,
    shadow: () => "first" | "duplicate" | "allowed" | "denied" | null,
    live: "first" | "duplicate" | "allowed" | "denied",
  ): void {
    const counters = this.#counters[family];
    counters.compared += 1;
    try {
      const shadowDecision = shadow();
      if (shadowDecision === null) {
        counters.unexplained += 1;
        return;
      }
      if (shadowDecision === live) {
        counters.matches += 1;
        return;
      }
      if (nowMs - this.#startedAtMs < SHARED_STATE_SHADOW_RUNTIME_V1.warmupMs) {
        // The live store carries pre-shadow history the shadow lacks
        // (nonces consumed before the shadow started, rate buckets in
        // flight). Bounded by the warm-up window; after it, this class can
        // no longer occur and any disagreement is unexplained.
        counters.warmupMismatches += 1;
        return;
      }
      counters.unexplained += 1;
    } catch {
      counters.unexplained += 1;
    }
  }

  snapshot(): SharedStateShadowSnapshotV1 {
    return {
      startedAtUnixMs: this.#startedAtMs,
      replay: { ...this.#counters.replay },
      rate: { ...this.#counters.rate },
    };
  }
}

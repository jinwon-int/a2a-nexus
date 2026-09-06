/**
 * Serving-process fence for Phase 3 Slice K, first part.
 *
 * Decision A+A1 on #1504: reuse the V1 `shared_state_ownership` CAS as the
 * broker singleton fence for both JSON-file and SQLite persistence. This
 * module applies the V1 schema to a dedicated file, opens one adapter, and
 * releases the token on drain/close. `probe()` re-reads the ownership row
 * for `/readyz`. It does not install non-serving middleware, renew a lease,
 * take over a live token, or issue V1 primitive commands.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import {
  SHARED_STATE_SQLITE_ADAPTER_V1,
  SharedStateSqliteAdapterV1,
  type SharedStateSqliteAdapterErrorCodeV1,
} from "./shared-state-sqlite-adapter-v1.js";
import {
  applySharedStateSqliteSchemaV1,
  type SharedStateSqliteSchemaErrorCodeV1,
} from "./shared-state-sqlite-schema-v1.js";

export const SHARED_STATE_SERVING_FENCE_V1 = Object.freeze({
  kind: "SharedStateServingFenceV1",
  envKey: "BROKER_SHARED_STATE_FILE",
  defaultSuffix: ".shared-state-v1.sqlite",
  isolatedTempPrefix: "a2a-serving-fence-",
  isolatedTempFileName: "shared-state-v1.sqlite",
  defaultLegacyStateFile: "/var/lib/a2a-broker/state.json",
} as const);

export const SHARED_STATE_SERVING_FENCE_ERROR_CODES_V1 = Object.freeze([
  "empty_shared_state_file",
  "schema_read_failed",
  "schema_write_failed",
  "schema_version_mismatch",
  "contract_version_mismatch",
  "schema_table_missing",
  "schema_not_applied",
  "ownership_conflict",
  "adapter_unavailable",
  "clock_profile_mismatch",
  "store_failure",
  "already_open",
] as const);

export type SharedStateServingFenceErrorCodeV1 =
  (typeof SHARED_STATE_SERVING_FENCE_ERROR_CODES_V1)[number];

export type SharedStateServingFenceResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: SharedStateServingFenceErrorCodeV1 };
    };

export interface SharedStateServingFencePathInputV1 {
  readonly sharedStateFile?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateFile: string;
}

export const SHARED_STATE_SERVING_FENCE_PROBE_REASON_CODES_V1 = Object.freeze([
  "lost_fence",
  "adapter_unavailable",
] as const);

export type SharedStateServingFenceProbeReasonCodeV1 =
  (typeof SHARED_STATE_SERVING_FENCE_PROBE_REASON_CODES_V1)[number];

export type SharedStateServingFenceProbeV1 =
  | { readonly ready: true }
  | {
    readonly ready: false;
    readonly reasonCode: SharedStateServingFenceProbeReasonCodeV1;
  };

export interface SharedStateServingFenceV1 {
  release(): void;
  probe(): SharedStateServingFenceProbeV1;
}

function fail(
  code: SharedStateServingFenceErrorCodeV1,
): SharedStateServingFenceResultV1<never> {
  return { ok: false, error: Object.freeze({ code }) };
}

function ownershipTokenFromRow(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  if (!("owner_token" in row)) return undefined;
  const token = row.owner_token;
  return typeof token === "string" ? token : undefined;
}

function isFenceErrorCode(
  code: string,
): code is SharedStateServingFenceErrorCodeV1 {
  for (const item of SHARED_STATE_SERVING_FENCE_ERROR_CODES_V1) {
    if (item === code) return true;
  }
  return false;
}

export function isolatedSharedStateServingFencePathV1(): string {
  return join(
    mkdtempSync(
      join(tmpdir(), SHARED_STATE_SERVING_FENCE_V1.isolatedTempPrefix),
    ),
    SHARED_STATE_SERVING_FENCE_V1.isolatedTempFileName,
  );
}

/**
 * Resolves the dedicated V1 fence file. A present empty string is a
 * misconfiguration, not an omitted default.
 */
export function resolveSharedStateServingFencePathV1(
  input: SharedStateServingFencePathInputV1,
): SharedStateServingFenceResultV1<string> {
  if (input.sharedStateFile !== undefined) {
    if (input.sharedStateFile === "") return fail("empty_shared_state_file");
    return { ok: true, value: input.sharedStateFile };
  }
  const env = input.env ?? process.env;
  if (Object.hasOwn(env, SHARED_STATE_SERVING_FENCE_V1.envKey)) {
    const raw = env[SHARED_STATE_SERVING_FENCE_V1.envKey];
    if (raw === undefined || raw === "") return fail("empty_shared_state_file");
    return { ok: true, value: raw };
  }
  return {
    ok: true,
    value: `${input.stateFile}${SHARED_STATE_SERVING_FENCE_V1.defaultSuffix}`,
  };
}

function mapSchemaCode(
  code: SharedStateSqliteSchemaErrorCodeV1,
): SharedStateServingFenceErrorCodeV1 {
  return isFenceErrorCode(code) ? code : "adapter_unavailable";
}

function mapAdapterCode(
  code: SharedStateSqliteAdapterErrorCodeV1,
): SharedStateServingFenceErrorCodeV1 {
  return isFenceErrorCode(code) ? code : "adapter_unavailable";
}

/**
 * Applies the V1 schema if needed and acquires exclusive ownership. The
 * caller must `release()` so a later process can acquire after a clean
 * shutdown. Crash without release leaves the token set (decision A1).
 */
export function openSharedStateServingFenceV1(input: {
  readonly filePath: string;
  readonly ownerToken?: string;
}): SharedStateServingFenceResultV1<SharedStateServingFenceV1> {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(input.filePath, { timeout: 0 });
  } catch {
    return fail("adapter_unavailable");
  }

  const applied = applySharedStateSqliteSchemaV1(db);
  if (!applied.ok) {
    db.close();
    return fail(mapSchemaCode(applied.error.code));
  }

  const ownerToken = input.ownerToken ?? randomUUID();
  const adapter = new SharedStateSqliteAdapterV1({
    db,
    ownerToken,
    backwardSkewToleranceMs: "0",
  });
  const opened = adapter.open();
  if (!opened.ok) {
    db.close();
    return fail(mapAdapterCode(opened.error.code));
  }

  let released = false;
  // The probe runs on every request the server fences, so compile its
  // statement once; lazily inside the try so a prepare failure still reads
  // as adapter_unavailable.
  let probeStatement: StatementSync | undefined;
  return {
    ok: true,
    value: Object.freeze({
      release(): void {
        if (released) return;
        released = true;
        adapter.drain();
        adapter.close();
        db.close();
      },
      probe(): SharedStateServingFenceProbeV1 {
        if (released) {
          return Object.freeze({ ready: false, reasonCode: "adapter_unavailable" });
        }
        try {
          probeStatement ??= db.prepare(
            `SELECT owner_token FROM shared_state_ownership WHERE id = ?`,
          );
          const row: unknown = probeStatement.get(SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
          const token = ownershipTokenFromRow(row);
          if (token === undefined) {
            return Object.freeze({
              ready: false,
              reasonCode: "adapter_unavailable",
            });
          }
          if (token !== ownerToken) {
            return Object.freeze({ ready: false, reasonCode: "lost_fence" });
          }
          return Object.freeze({ ready: true });
        } catch {
          return Object.freeze({
            ready: false,
            reasonCode: "adapter_unavailable",
          });
        }
      },
    }),
  };
}

export function assertSharedStateServingFenceV1(input: {
  readonly filePath: string;
}): SharedStateServingFenceV1 {
  const fence = openSharedStateServingFenceV1({ filePath: input.filePath });
  if (!fence.ok) {
    throw new Error(
      `shared-state serving fence rejected: ${fence.error.code}`,
    );
  }
  return fence.value;
}

/**
 * Broker construction entry. An injected `stateStore` is not the
 * `STATE_FILE` identity, so it gets an isolated temp fence unless the
 * operator or test set the path explicitly.
 */
export function acquireSharedStateServingFenceForBrokerV1(input: {
  readonly sharedStateFile?: string;
  readonly stateFile: string;
  readonly injectedStore: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Which `stateFile` counts as "the unconfigured default" for the
   * missing-directory isolation branch below. Defaults to the production
   * constant; injectable so tests can exercise that branch against a path that
   * is genuinely absent instead of the host's live `/var/lib/a2a-broker`, which
   * on any broker-running node is owned by another process and turns the test
   * into an unconditional `ownership_conflict` (#2051 item 5).
   */
  readonly defaultLegacyStateFile?: string;
}): SharedStateServingFenceV1 {
  const env = input.env ?? process.env;
  const explicit =
    input.sharedStateFile !== undefined
    || Object.hasOwn(env, SHARED_STATE_SERVING_FENCE_V1.envKey);
  if (!explicit && input.injectedStore) {
    return assertSharedStateServingFenceV1({
      filePath: isolatedSharedStateServingFencePathV1(),
    });
  }
  const path = resolveSharedStateServingFencePathV1({
    ...(input.sharedStateFile === undefined
      ? {}
      : { sharedStateFile: input.sharedStateFile }),
    stateFile: input.stateFile,
    env,
  });
  if (!path.ok) {
    throw new Error(
      `shared-state serving fence rejected: ${path.error.code}`,
    );
  }
  const directory = dirname(path.value);
  if (!existsSync(directory)) {
    const defaultLegacy =
      input.stateFile ===
      (input.defaultLegacyStateFile ?? SHARED_STATE_SERVING_FENCE_V1.defaultLegacyStateFile);
    if (!explicit && defaultLegacy) {
      return assertSharedStateServingFenceV1({
        filePath: isolatedSharedStateServingFencePathV1(),
      });
    }
    try {
      mkdirSync(directory, { recursive: true });
    } catch {
      throw new Error(
        "shared-state serving fence rejected: adapter_unavailable",
      );
    }
  }
  return assertSharedStateServingFenceV1({ filePath: path.value });
}

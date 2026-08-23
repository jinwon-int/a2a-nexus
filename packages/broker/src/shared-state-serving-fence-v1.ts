/**
 * Serving-process fence for Phase 3 Slice K, first part.
 *
 * Decision A+A1 on #1504: reuse the V1 `shared_state_ownership` CAS as the
 * broker singleton fence for both JSON-file and SQLite persistence. This
 * module applies the V1 schema to a dedicated file, opens one adapter, and
 * releases the token on drain/close. It does not install `/readyz`, renew a
 * lease, take over a live token, or issue V1 primitive commands.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
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

export interface SharedStateServingFenceV1 {
  release(): void;
}

function fail(
  code: SharedStateServingFenceErrorCodeV1,
): SharedStateServingFenceResultV1<never> {
  return { ok: false, error: Object.freeze({ code }) };
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
    db = new DatabaseSync(input.filePath);
  } catch {
    return fail("adapter_unavailable");
  }

  const applied = applySharedStateSqliteSchemaV1(db);
  if (!applied.ok) {
    db.close();
    return fail(mapSchemaCode(applied.error.code));
  }

  const adapter = new SharedStateSqliteAdapterV1({
    db,
    ownerToken: input.ownerToken ?? randomUUID(),
    backwardSkewToleranceMs: "0",
  });
  const opened = adapter.open();
  if (!opened.ok) {
    db.close();
    return fail(mapAdapterCode(opened.error.code));
  }

  let released = false;
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
}): SharedStateServingFenceV1 {
  const env = input.env ?? process.env;
  const explicit =
    input.sharedStateFile !== undefined
    || Object.hasOwn(env, SHARED_STATE_SERVING_FENCE_V1.envKey);
  const path = explicit || !input.injectedStore
    ? resolveSharedStateServingFencePathV1({
      ...(input.sharedStateFile === undefined
        ? {}
        : { sharedStateFile: input.sharedStateFile }),
      stateFile: input.stateFile,
      env,
    })
    : { ok: true as const, value: isolatedSharedStateServingFencePathV1() };
  if (!path.ok) {
    throw new Error(
      `shared-state serving fence rejected: ${path.error.code}`,
    );
  }
  return assertSharedStateServingFenceV1({ filePath: path.value });
}

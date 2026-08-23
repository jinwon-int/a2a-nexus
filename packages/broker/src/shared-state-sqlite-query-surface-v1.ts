/**
 * Q5 backend-neutral query normalization for the synchronous SQLite
 * dispatcher. This module does not attach the adapter to broker runtime or
 * claim that SQLite implements the full broad adapter contract.
 */
import type {
  SharedStateSqliteAdapterErrorCodeV1,
  SharedStateSqliteAdapterResultV1,
} from "./shared-state-sqlite-adapter-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateQueryResultV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
  type SharedStateQueryUnavailableReasonCodeV1,
  type SharedStateStorageAdapterV1,
} from "./shared-state-storage-contract-v1.js";

export const SHARED_STATE_SQLITE_QUERY_NORMALIZATION_V1 = Object.freeze({
  kind: "SharedStateSqliteQueryNormalizationV1",
  source: "synchronous-sqlite-query-dispatcher",
  target: "async-backend-neutral-query-surface",
  operations: V.queryOperations,
  attachedToBrokerRuntime: false,
  fullAdapterConformanceClaimed: false,
} as const);

export interface SharedStateSqliteQueryDispatcherV1 {
  query(
    request: SharedStateQueryRequestV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>;
}

export type SharedStateStorageQuerySurfaceV1 = Pick<
  SharedStateStorageAdapterV1,
  "query"
>;

function unavailableResult(
  request: SharedStateQueryRequestV1,
  reasonCode: SharedStateQueryUnavailableReasonCodeV1,
): SharedStateQueryResultV1 {
  const candidate = {
    kind: V.kinds.queryResult,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: request.operation,
    status: V.queryStatuses[1],
    achievedConsistency: null,
    reasonCode,
  };
  const parsed = parseSharedStateQueryResultV1(candidate);
  if (!parsed.ok) {
    throw new Error("closed SQLite query normalization invariant failed");
  }
  return parsed.value;
}

function normalizeLocalFailure(
  code: SharedStateSqliteAdapterErrorCodeV1,
): SharedStateQueryUnavailableReasonCodeV1 {
  return code === "ownership_lost"
    ? "lost_ownership"
    : "authority_unavailable";
}

/**
 * Exposes only the broad query member. Untyped callers must parse before this
 * seam; defensive re-validation rejects with the existing closed parser error
 * instead of inventing an operation-specific result. Once a valid operation
 * enters, every ordinary dispatcher inability resolves as a closed query
 * unavailable result.
 */
export function createSharedStateSqliteQuerySurfaceV1(
  dispatcher: SharedStateSqliteQueryDispatcherV1,
): SharedStateStorageQuerySurfaceV1 {
  return Object.freeze({
    async query(
      request: SharedStateQueryRequestV1,
    ): Promise<SharedStateQueryResultV1> {
      const parsedRequest = parseSharedStateQueryRequestV1(request);
      if (!parsedRequest.ok) {
        throw parsedRequest.error;
      }

      try {
        const local = dispatcher.query(parsedRequest.value);

        if (!local.ok) {
          return unavailableResult(
            parsedRequest.value,
            normalizeLocalFailure(local.error.code),
          );
        }

        const parsedResult = parseSharedStateQueryResultV1(local.value);
        if (
          !parsedResult.ok
          || parsedResult.value.operation !== parsedRequest.value.operation
        ) {
          return unavailableResult(
            parsedRequest.value,
            "authority_unavailable",
          );
        }
        return parsedResult.value;
      } catch {
        return unavailableResult(
          parsedRequest.value,
          "authority_unavailable",
        );
      }
    },
  });
}

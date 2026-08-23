/**
 * Slice M, first part: secret-safe `/health` `stateContract` envelope.
 *
 * Spec section 7.3 shape, cut to what this process can honestly report.
 * The V1 adapter is the serving fence only, so `backendClass` stays
 * `legacy-process` and `contractVersion` is null. Primitive reset-risk
 * bands are omitted. This module does not import the observability
 * catalog.
 */

export const SHARED_STATE_CONTRACT_HEALTH_V1 = Object.freeze({
  specVersion: 1,
  backendClass: "legacy-process",
  lifecycle: "ready",
  durability: "volatile",
  writerModel: "single",
} as const);

export type SharedStateContractOwnershipV1 = "held" | "lost";

export interface SharedStateContractHealthV1 {
  readonly specVersion: 1;
  readonly configuredGrade: string;
  readonly effectiveGrade: string;
  readonly gradeDefaulted: boolean;
  readonly serving: boolean;
  readonly reasonCodes: readonly string[];
  readonly adapter: {
    readonly contractVersion: null;
    readonly backendClass: typeof SHARED_STATE_CONTRACT_HEALTH_V1.backendClass;
    readonly lifecycle: typeof SHARED_STATE_CONTRACT_HEALTH_V1.lifecycle;
    readonly durability: typeof SHARED_STATE_CONTRACT_HEALTH_V1.durability;
    readonly writerModel: typeof SHARED_STATE_CONTRACT_HEALTH_V1.writerModel;
  };
  readonly topology: {
    readonly expectedProcessCount: number;
    readonly ownership: SharedStateContractOwnershipV1;
  };
}

export function buildSharedStateContractHealthV1(input: {
  readonly configuredGrade: string;
  readonly effectiveGrade: string;
  readonly gradeDefaulted: boolean;
  readonly expectedProcessCount: number;
  readonly serving: boolean;
  readonly ownership: SharedStateContractOwnershipV1;
  readonly reasonCodes?: readonly string[];
}): SharedStateContractHealthV1 {
  return Object.freeze({
    specVersion: SHARED_STATE_CONTRACT_HEALTH_V1.specVersion,
    configuredGrade: input.configuredGrade,
    effectiveGrade: input.effectiveGrade,
    gradeDefaulted: input.gradeDefaulted,
    serving: input.serving,
    reasonCodes: Object.freeze([...(input.reasonCodes ?? [])]),
    adapter: Object.freeze({
      contractVersion: null,
      backendClass: SHARED_STATE_CONTRACT_HEALTH_V1.backendClass,
      lifecycle: SHARED_STATE_CONTRACT_HEALTH_V1.lifecycle,
      durability: SHARED_STATE_CONTRACT_HEALTH_V1.durability,
      writerModel: SHARED_STATE_CONTRACT_HEALTH_V1.writerModel,
    }),
    topology: Object.freeze({
      expectedProcessCount: input.expectedProcessCount,
      ownership: input.ownership,
    }),
  });
}

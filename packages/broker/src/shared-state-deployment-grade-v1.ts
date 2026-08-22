/**
 * Closed parser for the planned Phase 3 deployment-grade configuration.
 *
 * Spec section 3 names `BROKER_DEPLOYMENT_GRADE` and forbids serving
 * `shared-state-ha` until an approved conforming backend exists. Section 3.1
 * forbids starting either single-process grade with an expected process count
 * greater than one. `multi-process-unsupported` is an effective grade for a
 * live ownership conflict, not a value an operator may configure.
 *
 * This module does not bind a socket, open an adapter, install `/readyz`, or
 * change broker defaults. `fromProcessEnv` is the only function that reads
 * environment variables, and only the two closed keys below.
 */

import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-v1-values.js";

export const SHARED_STATE_DEPLOYMENT_GRADE_V1 = Object.freeze({
  kind: "SharedStateDeploymentGradeDecisionV1",
  decisionVersion: 1,
  envKeys: Object.freeze({
    deploymentGrade: "BROKER_DEPLOYMENT_GRADE",
    expectedProcessCount: "BROKER_EXPECTED_PROCESS_COUNT",
  }),
  defaultConfiguredGrade: "single-process",
  defaultExpectedProcessCount: 1,
  /**
   * There is no approved conforming shared adapter in this repository.
   * `shared-state-ha` therefore fails closed at configuration time.
   */
  approvedSharedBackend: false,
} as const);

export const SHARED_STATE_DEPLOYMENT_GRADE_ERROR_CODES_V1 = Object.freeze([
  "unknown_configured_grade",
  "configured_grade_not_servable",
  "shared_backend_unavailable",
  "invalid_expected_process_count",
  "expected_process_count_unsupported",
] as const);

export type SharedStateConfiguredGradeV1 =
  (typeof V.configuredGrades)[number];
export type SharedStateEffectiveGradeV1 =
  (typeof V.effectiveGrades)[number];
export type SharedStateDeploymentGradeErrorCodeV1 =
  (typeof SHARED_STATE_DEPLOYMENT_GRADE_ERROR_CODES_V1)[number];

export interface SharedStateDeploymentGradeErrorV1 {
  readonly code: SharedStateDeploymentGradeErrorCodeV1;
  readonly path: readonly string[];
}

export type SharedStateDeploymentGradeResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SharedStateDeploymentGradeErrorV1 };

export interface SharedStateDeploymentGradeInputV1 {
  readonly deploymentGrade?: string;
  readonly expectedProcessCount?: string;
}

export interface SharedStateDeploymentGradeDecisionV1 {
  readonly kind: typeof SHARED_STATE_DEPLOYMENT_GRADE_V1.kind;
  readonly decisionVersion: typeof SHARED_STATE_DEPLOYMENT_GRADE_V1.decisionVersion;
  readonly configuredGrade: SharedStateConfiguredGradeV1;
  readonly effectiveGrade: SharedStateConfiguredGradeV1;
  readonly gradeDefaulted: boolean;
  readonly expectedProcessCount: number;
  readonly expectedProcessCountDefaulted: boolean;
  readonly approvedSharedBackend: false;
}

function fail(
  code: SharedStateDeploymentGradeErrorCodeV1,
  path: readonly string[],
): SharedStateDeploymentGradeResultV1<never> {
  return { ok: false, error: Object.freeze({ code, path }) };
}

function isConfiguredGrade(
  value: string,
): value is SharedStateConfiguredGradeV1 {
  return (V.configuredGrades as readonly string[]).includes(value);
}

function parseExpectedProcessCount(
  raw: string | undefined,
): SharedStateDeploymentGradeResultV1<{
  readonly count: number;
  readonly defaulted: boolean;
}> {
  if (raw === undefined) {
    return {
      ok: true,
      value: Object.freeze({
        count: SHARED_STATE_DEPLOYMENT_GRADE_V1.defaultExpectedProcessCount,
        defaulted: true,
      }),
    };
  }
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) {
    return fail("invalid_expected_process_count", ["expectedProcessCount"]);
  }
  const count = Number(raw);
  if (
    !Number.isSafeInteger(count)
    || count < 1
    || count > V.limits.maxExpectedProcessCount
  ) {
    return fail("invalid_expected_process_count", ["expectedProcessCount"]);
  }
  return { ok: true, value: Object.freeze({ count, defaulted: false }) };
}

/**
 * Resolves the closed grade and expected-process configuration. Success is
 * only possible for a servable single-writer grade with one expected process.
 */
export function resolveSharedStateDeploymentGradeV1(
  input: SharedStateDeploymentGradeInputV1 = {},
): SharedStateDeploymentGradeResultV1<SharedStateDeploymentGradeDecisionV1> {
  const rawGrade = input.deploymentGrade;
  let configuredGrade: SharedStateConfiguredGradeV1;
  let gradeDefaulted: boolean;
  if (rawGrade === undefined) {
    configuredGrade = SHARED_STATE_DEPLOYMENT_GRADE_V1.defaultConfiguredGrade;
    gradeDefaulted = true;
  } else if (rawGrade === "multi-process-unsupported") {
    return fail("configured_grade_not_servable", ["deploymentGrade"]);
  } else if (!isConfiguredGrade(rawGrade)) {
    return fail("unknown_configured_grade", ["deploymentGrade"]);
  } else {
    configuredGrade = rawGrade;
    gradeDefaulted = false;
  }

  if (configuredGrade === "shared-state-ha") {
    return fail("shared_backend_unavailable", ["deploymentGrade"]);
  }

  const parsedCount = parseExpectedProcessCount(input.expectedProcessCount);
  if (!parsedCount.ok) return parsedCount;
  if (parsedCount.value.count !== 1) {
    return fail("expected_process_count_unsupported", [
      "expectedProcessCount",
    ]);
  }

  return {
    ok: true,
    value: Object.freeze({
      kind: SHARED_STATE_DEPLOYMENT_GRADE_V1.kind,
      decisionVersion: SHARED_STATE_DEPLOYMENT_GRADE_V1.decisionVersion,
      configuredGrade,
      effectiveGrade: configuredGrade,
      gradeDefaulted,
      expectedProcessCount: parsedCount.value.count,
      expectedProcessCountDefaulted: parsedCount.value.defaulted,
      approvedSharedBackend:
        SHARED_STATE_DEPLOYMENT_GRADE_V1.approvedSharedBackend,
    }),
  };
}

/**
 * Reads only the two closed environment keys. Extra keys are ignored.
 * A present empty string is a misconfiguration, not an omitted default.
 */
export function resolveSharedStateDeploymentGradeFromEnvV1(
  env: NodeJS.ProcessEnv = process.env,
): SharedStateDeploymentGradeResultV1<SharedStateDeploymentGradeDecisionV1> {
  const gradeKey = SHARED_STATE_DEPLOYMENT_GRADE_V1.envKeys.deploymentGrade;
  const countKey = SHARED_STATE_DEPLOYMENT_GRADE_V1.envKeys.expectedProcessCount;
  const rawGrade = env[gradeKey];
  const rawCount = env[countKey];
  return resolveSharedStateDeploymentGradeV1({
    ...(rawGrade === undefined ? {} : { deploymentGrade: rawGrade }),
    ...(rawCount === undefined ? {} : { expectedProcessCount: rawCount }),
  });
}

/**
 * Tests for the Phase 3 deployment-grade configuration parser.
 *
 * The parser is source-only. These tests never start a broker, bind a
 * route, or open a V1 adapter.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_DEPLOYMENT_GRADE_ERROR_CODES_V1,
  SHARED_STATE_DEPLOYMENT_GRADE_V1,
  resolveSharedStateDeploymentGradeFromEnvV1,
  resolveSharedStateDeploymentGradeV1,
  type SharedStateDeploymentGradeErrorCodeV1,
} from "./shared-state-deployment-grade-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-v1-values.js";

function expectOk<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) assert.fail(result.error.code);
  return result.value;
}

function expectError(
  result: { ok: true; value: unknown } | { ok: false; error: { code: string } },
  code: SharedStateDeploymentGradeErrorCodeV1,
): void {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, code);
}

test("declares the closed grade config surface and its defaults", () => {
  assert.equal(
    SHARED_STATE_DEPLOYMENT_GRADE_V1.envKeys.deploymentGrade,
    "BROKER_DEPLOYMENT_GRADE",
  );
  assert.equal(
    SHARED_STATE_DEPLOYMENT_GRADE_V1.envKeys.expectedProcessCount,
    "BROKER_EXPECTED_PROCESS_COUNT",
  );
  assert.equal(
    SHARED_STATE_DEPLOYMENT_GRADE_V1.defaultConfiguredGrade,
    "single-process",
  );
  assert.equal(SHARED_STATE_DEPLOYMENT_GRADE_V1.defaultExpectedProcessCount, 1);
  assert.equal(SHARED_STATE_DEPLOYMENT_GRADE_V1.approvedSharedBackend, false);
  assert.deepEqual(
    [...V.configuredGrades],
    ["single-process", "single-writer-durable", "shared-state-ha"],
  );
  assert.equal(
    (V.effectiveGrades as readonly string[]).includes(
      "multi-process-unsupported",
    ),
    true,
  );
  assert.equal(
    (V.configuredGrades as readonly string[]).includes(
      "multi-process-unsupported",
    ),
    false,
  );
});

test("omitted grade and count default to a servable single process", () => {
  const decision = expectOk(resolveSharedStateDeploymentGradeV1());
  assert.equal(decision.configuredGrade, "single-process");
  assert.equal(decision.effectiveGrade, "single-process");
  assert.equal(decision.gradeDefaulted, true);
  assert.equal(decision.expectedProcessCount, 1);
  assert.equal(decision.expectedProcessCountDefaulted, true);
  assert.equal(decision.approvedSharedBackend, false);
  assert.equal(Object.isFrozen(decision), true);
});

test("an explicit single-writer grade is not marked defaulted", () => {
  const single = expectOk(
    resolveSharedStateDeploymentGradeV1({
      deploymentGrade: "single-process",
      expectedProcessCount: "1",
    }),
  );
  assert.equal(single.gradeDefaulted, false);
  assert.equal(single.expectedProcessCountDefaulted, false);

  const durable = expectOk(
    resolveSharedStateDeploymentGradeV1({
      deploymentGrade: "single-writer-durable",
    }),
  );
  assert.equal(durable.configuredGrade, "single-writer-durable");
  assert.equal(durable.effectiveGrade, "single-writer-durable");
  assert.equal(durable.gradeDefaulted, false);
  assert.equal(durable.expectedProcessCountDefaulted, true);
});

test("fails closed on each unservable or unknown configuration", () => {
  const cases: readonly {
    readonly input: {
      readonly deploymentGrade?: string;
      readonly expectedProcessCount?: string;
    };
    readonly code: SharedStateDeploymentGradeErrorCodeV1;
  }[] = [
    {
      input: { deploymentGrade: "shared-state-ha" },
      code: "shared_backend_unavailable",
    },
    {
      input: { deploymentGrade: "multi-process-unsupported" },
      code: "configured_grade_not_servable",
    },
    {
      input: { deploymentGrade: "cluster" },
      code: "unknown_configured_grade",
    },
    {
      input: { deploymentGrade: "" },
      code: "unknown_configured_grade",
    },
    {
      input: { deploymentGrade: "Single-Process" },
      code: "unknown_configured_grade",
    },
    {
      input: { expectedProcessCount: "2" },
      code: "expected_process_count_unsupported",
    },
    {
      input: {
        deploymentGrade: "single-writer-durable",
        expectedProcessCount: "2",
      },
      code: "expected_process_count_unsupported",
    },
    {
      input: { expectedProcessCount: "0" },
      code: "invalid_expected_process_count",
    },
    {
      input: { expectedProcessCount: "-1" },
      code: "invalid_expected_process_count",
    },
    {
      input: { expectedProcessCount: "01" },
      code: "invalid_expected_process_count",
    },
    {
      input: { expectedProcessCount: "1.5" },
      code: "invalid_expected_process_count",
    },
    {
      input: { expectedProcessCount: "" },
      code: "invalid_expected_process_count",
    },
    {
      input: { expectedProcessCount: "10001" },
      code: "invalid_expected_process_count",
    },
    {
      input: {
        deploymentGrade: "shared-state-ha",
        expectedProcessCount: "3",
      },
      code: "shared_backend_unavailable",
    },
  ];

  const seen = new Set<SharedStateDeploymentGradeErrorCodeV1>();
  for (const entry of cases) {
    expectError(resolveSharedStateDeploymentGradeV1(entry.input), entry.code);
    seen.add(entry.code);
  }
  assert.deepEqual(
    [...seen].sort(),
    [...SHARED_STATE_DEPLOYMENT_GRADE_ERROR_CODES_V1].sort(),
  );
});

test("fromEnv reads only the two closed keys", () => {
  const omitted = expectOk(resolveSharedStateDeploymentGradeFromEnvV1({}));
  assert.equal(omitted.gradeDefaulted, true);
  assert.equal(omitted.expectedProcessCountDefaulted, true);

  const explicit = expectOk(
    resolveSharedStateDeploymentGradeFromEnvV1({
      BROKER_DEPLOYMENT_GRADE: "single-writer-durable",
      BROKER_EXPECTED_PROCESS_COUNT: "1",
      BROKER_SQLITE_FILE: "/tmp/ignored.sqlite",
    }),
  );
  assert.equal(explicit.configuredGrade, "single-writer-durable");
  assert.equal(explicit.gradeDefaulted, false);
  assert.equal(explicit.expectedProcessCountDefaulted, false);

  expectError(
    resolveSharedStateDeploymentGradeFromEnvV1({
      BROKER_DEPLOYMENT_GRADE: "shared-state-ha",
    }),
    "shared_backend_unavailable",
  );
  expectError(
    resolveSharedStateDeploymentGradeFromEnvV1({
      BROKER_DEPLOYMENT_GRADE: "",
    }),
    "unknown_configured_grade",
  );
});

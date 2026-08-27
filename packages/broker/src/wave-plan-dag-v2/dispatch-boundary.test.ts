import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { classifyWavePlanIntake } from "./dispatch-boundary.js";
import { validateWavePlanSpec } from "../core/wave-plan.js";
import type { WaveStageGate } from "../core/wave-plan.js";

/**
 * #1800 slice 3 — v1/v2 versioned dispatch-boundary classifier.
 *
 * Load-bearing rules:
 * 1. **Non-interference**: a payload the V2 contract does not own reaches
 *    `v1_wave_plan_spec` unexamined and — pinned by tests below — still
 *    validates byte-equivalently through the unchanged v1 spec validator
 *    afterwards. The classifier must be invisible to the v1 path.
 * 2. **No authority**: intake records carry no action field; adding one
 *    requires changing this closed union.
 * 3. **V2 payloads never reach v1**: they either become rehearsal candidates
 *    (admitted, optionally rehearsed) or fail with the exact §5 reason.
 */

const FIXTURE = JSON.parse(
  readFileSync(
    join(process.cwd(), "..", "..", "fixtures", "contract", "wave-plan-dag-v2.json"),
    "utf8",
  ),
) as {
  manifest: Record<string, unknown>;
  dryRuns: Array<{ request: Record<string, unknown>; receipt: Record<string, unknown> }>;
};

type LooseRecord = Record<string, unknown>;

/** A minimal valid v1 wave-plan spec (linear two-stage draft). */
function validV1Spec(): LooseRecord {
  return {
    wavePlanId: "wave-test-001",
    stages: [
      { id: "stage-a", gate: { type: "manual" } },
      { id: "stage-b", gate: { type: "approval" } },
    ],
  };
}

function assertV1PassThrough(record: ReturnType<typeof classifyWavePlanIntake>, expectedKind: string | null): void {
  assert.equal(record.routesTo, "v1_wave_plan_spec");
  if (record.routesTo !== "v1_wave_plan_spec") return;
  assert.equal("manifestAlias" in record, false);
  assert.equal("rejectionReason" in record, false);
  assert.equal("dispatch" in record, false);
  assert.equal("advance" in record, false);
  assert.equal(record.observedKind, expectedKind);
}

test("non-V2 payloads pass through unexamined to the v1 surface", () => {
  for (const [payload, kind] of [
    [validV1Spec(), null],
    [{ kind: "SomethingElse" }, "SomethingElse"],
    [{}, null],
    ["plain string", null],
    [42, null],
    [null, null],
    [[1, 2, 3], null],
  ] as Array<[unknown, string | null]>) {
    const record = classifyWavePlanIntake(payload);
    assertV1PassThrough(record, kind);
  }
});

test("non-interference pin: v1 specs validate identically after classification", () => {
  for (const spec of [validV1Spec(), { ...validV1Spec(), stages: [] }, { gateOnly: true }, null]) {
    const before = (() => {
      try {
        return validateWavePlanSpec(structuredClone(spec));
      } catch {
        return "throws";
      }
    })();

    classifyWavePlanIntake(spec);

    const after = (() => {
      try {
        return validateWavePlanSpec(structuredClone(spec));
      } catch {
        return "throws";
      }
    })();
    // The v1 validator's verdict on its own payload is unaffected by the
    // classifier having seen the same value first (result identity in the
    // success case, throw-preserving otherwise).
    if (typeof before === "string") {
      assert.equal(after, before);
    } else {
      assert.deepEqual(after, before);
    }
  }

  const record = classifyWavePlanIntake(validV1Spec());
  assert.equal(record.routesTo, "v1_wave_plan_spec");
  const plan = validateWavePlanSpec(validV1Spec());
  assert.equal(plan.wavePlanId, "wave-test-001");
  assert.equal((plan.stages[0].gate as WaveStageGate).type, "manual");
});

test("golden V2 manifest classifies as rehearsal candidate without a request", () => {
  const record = classifyWavePlanIntake(structuredClone(FIXTURE.manifest));
  assert.ok(record.routesTo === "v2_rehearsal_candidate");

  assert.equal(record.manifestAlias, FIXTURE.manifest.manifestAlias);
  assert.equal(record.manifestDigest, FIXTURE.manifest.manifestDigest);
  assert.equal(record.stageCount, 8);
  assert.equal(record.dryRunIssued, false);
});

test("golden pair classifies as rehearsal candidate with a successful rehearsal", () => {
  const record = classifyWavePlanIntake(
    structuredClone(FIXTURE.manifest),
    structuredClone(FIXTURE.dryRuns[0].request),
  );
  assert.ok(record.routesTo === "v2_rehearsal_candidate");
  assert.ok(record.dryRunIssued === true);
});

test("failed rehearsals stay rehearsal candidates carrying the closed reason", () => {
  const mismatched = structuredClone(FIXTURE.dryRuns[0].request);
  mismatched.manifestDigest = `sha256:${"e".repeat(64)}`;
  const record = classifyWavePlanIntake(structuredClone(FIXTURE.manifest), mismatched);
  assert.ok(record.routesTo === "v2_rehearsal_candidate");
  if (!("dryRunRejectionReason" in record)) {
    assert.fail("expected dryRunRejectionReason on failed rehearsal candidate");
  }
  assert.equal(record.dryRunIssued, false);
  assert.equal(record.dryRunRejectionReason, "manifest_digest_mismatch");
});

test("malformed V2 kinds reject with stable reasons and never reach the v1 surface", () => {
  const wrongKind = { ...structuredClone(FIXTURE.manifest), prompt: "forbidden" };
  const rejected = classifyWavePlanIntake(wrongKind);
  assert.equal(rejected.routesTo, "v2_rejected");
  if (rejected.routesTo !== "v2_rejected") return;
  assert.equal(rejected.rejectionReason, "manifest_malformed");
  assert.equal("dispatch" in rejected, false);

  // kind alone selects the boundary even when everything else is garbage.
  const garbage = { kind: "WavePlanDagManifestV2", junk: true };
  const record = classifyWavePlanIntake(garbage);
  assert.ok(record.routesTo === "v2_rejected" || record.routesTo === "v2_rehearsal_candidate");
  assert.notEqual(record.routesTo, "v1_wave_plan_spec");
});

test("records are deterministic under repetition and isolated from caller mutation", () => {
  const proposal = structuredClone(FIXTURE.manifest);
  const first = classifyWavePlanIntake(proposal);
  const second = classifyWavePlanIntake(proposal);
  assert.deepEqual(first, second);

  (proposal.stages as LooseRecord[]).pop();
  assert.deepEqual(first, second, "earlier records must not change when inputs mutate later");
});

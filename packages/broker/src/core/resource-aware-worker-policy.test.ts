// ── Resource-aware worker policy tests ─────────────────────────────────────

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  workergamma_SCHEDULING_POLICY,
  mobilebeta_STYLE_POLICY,
  mobilealpha_HERMES_POLICY,
  diffResourceAwareWorkerPolicy,
  evaluateWorkerOnboarding,
  getPresetPolicy,
  ONBOARDING_KIND_METADATA_KEY,
  ONBOARDING_POLICY_METADATA_KEY,
  resourceAwareOnboardingFromMetadata,
  validateResourceAwareWorkerPolicy,
  type ResourceAwareWorkerPolicy,
} from "./resource-aware-worker-policy.js";

// ── Validation ─────────────────────────────────────────────────────────────

test("validateResourceAwareWorkerPolicy rejects empty allowedTaskTypes", () => {
  const result = validateResourceAwareWorkerPolicy({
    allowedTaskTypes: [],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: false,
    readOnly: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("non-empty array")));
});

test("validateResourceAwareWorkerPolicy rejects non-integer maxConcurrent", () => {
  const result = validateResourceAwareWorkerPolicy({
    ...mobilealpha_HERMES_POLICY,
    maxConcurrent: 1.5,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("positive integer")));
});

test("validateResourceAwareWorkerPolicy accepts valid mobilealpha/Hermes policy", () => {
  const result = validateResourceAwareWorkerPolicy(mobilealpha_HERMES_POLICY);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateResourceAwareWorkerPolicy accepts valid mobilebeta-style policy", () => {
  const result = validateResourceAwareWorkerPolicy(mobilebeta_STYLE_POLICY);
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateResourceAwareWorkerPolicy rejects contradictory readOnly + !noMutation", () => {
  const result = validateResourceAwareWorkerPolicy({
    ...mobilealpha_HERMES_POLICY,
    readOnly: true,
    noMutation: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("requires noMutation=true")));
});

test("validateResourceAwareWorkerPolicy rejects contradictory readOnly + !noLiveSend", () => {
  const result = validateResourceAwareWorkerPolicy({
    ...mobilealpha_HERMES_POLICY,
    readOnly: true,
    noLiveSend: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("requires noLiveSend=true")));
});

test("validateResourceAwareWorkerPolicy rejects noMutation with apply_local_change", () => {
  const result = validateResourceAwareWorkerPolicy({
    allowedTaskTypes: ["analyze", "apply_local_change"],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: false,
    readOnly: false,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("noMutation=true") && e.includes("apply_local_change")),
  );
});

test("validateResourceAwareWorkerPolicy rejects noLiveSend with promote_to_live", () => {
  const result = validateResourceAwareWorkerPolicy({
    allowedTaskTypes: ["analyze", "promote_to_live"],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: false,
    readOnly: false,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("noLiveSend=true") && e.includes("promote_to_live")),
  );
});

test("validateResourceAwareWorkerPolicy rejects mobileLowPower with high maxConcurrent", () => {
  const result = validateResourceAwareWorkerPolicy({
    ...mobilealpha_HERMES_POLICY,
    maxConcurrent: 5,
    mobileLowPower: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("maxConcurrent to 2")));
});

test("validateResourceAwareWorkerPolicy rejects gatewayRequired + mobileLowPower", () => {
  const result = validateResourceAwareWorkerPolicy({
    ...mobilealpha_HERMES_POLICY,
    gatewayRequired: true,
    mobileLowPower: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("contradictory")));
});

test("validateResourceAwareWorkerPolicy rejects standby with positive maxConcurrent", () => {
  const result = validateResourceAwareWorkerPolicy({
    allowedTaskTypes: ["analyze"],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: true,
    readOnly: false,
    maxConcurrent: 3,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("standby")));
});

test("validateResourceAwareWorkerPolicy warns when noLiveSend+noMutation without readOnly", () => {
  const result = validateResourceAwareWorkerPolicy({
    allowedTaskTypes: ["analyze"],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: false,
    readOnly: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("implies readOnly")));
});

test("validateResourceAwareWorkerPolicy accepts maxConcurrent=1 with mobileLowPower", () => {
  const result = validateResourceAwareWorkerPolicy({
    ...mobilealpha_HERMES_POLICY,
    maxConcurrent: 1,
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

// ── GO/NO-GO: mobilealpha/Hermes ─────────────────────────────────────────────

test("evaluateWorkerOnboarding GO for valid mobilealpha/Hermes policy", () => {
  const evaluation = evaluateWorkerOnboarding("mobilealpha-hermes", mobilealpha_HERMES_POLICY);
  assert.equal(evaluation.decision, "go");
  assert.ok(evaluation.reasons.some((r) => r.includes("passed")));
});

test("evaluateWorkerOnboarding NO-GO for mobilealpha/Hermes with gatewayRequired=true", () => {
  // Must also clear mobileLowPower to avoid validation contradiction
  const bad: ResourceAwareWorkerPolicy = {
    allowedTaskTypes: ["analyze", "validate_change"],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: true,
    mobileLowPower: false,
    standby: false,
    readOnly: true,
  };
  const evaluation = evaluateWorkerOnboarding("mobilealpha-hermes", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("gatewayRequired")));
});

test("evaluateWorkerOnboarding NO-GO for mobilealpha/Hermes with promote_to_live", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...mobilealpha_HERMES_POLICY,
    allowedTaskTypes: ["promote_to_live", "analyze"],
  };
  const evaluation = evaluateWorkerOnboarding("mobilealpha-hermes", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("promote_to_live")));
});

test("evaluateWorkerOnboarding NO-GO for mobilealpha/Hermes missing readOnly", () => {
  const bad: ResourceAwareWorkerPolicy = {
    allowedTaskTypes: ["analyze"],
    noLiveSend: false,
    noMutation: false,
    gatewayRequired: false,
    mobileLowPower: true,
    standby: false,
    readOnly: false,
  };
  const evaluation = evaluateWorkerOnboarding("mobilealpha-hermes", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("readOnly")));
});

// ── GO/NO-GO: mobilebeta-style ────────────────────────────────────────────────

test("evaluateWorkerOnboarding GO for valid mobilebeta-style policy", () => {
  const evaluation = evaluateWorkerOnboarding("mobilebeta-style", mobilebeta_STYLE_POLICY);
  assert.equal(evaluation.decision, "go");
  assert.ok(evaluation.reasons.some((r) => r.includes("passed")));
});

test("evaluateWorkerOnboarding NO-GO for mobilebeta-style with mobileLowPower=true", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...mobilebeta_STYLE_POLICY,
    mobileLowPower: true,
  };
  const evaluation = evaluateWorkerOnboarding("mobilebeta-style", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("mobileLowPower")));
});

test("evaluateWorkerOnboarding NO-GO for mobilebeta-style with readOnly=true", () => {
  // Must remove apply_local_change to avoid validation error for noMutation=true
  const bad: ResourceAwareWorkerPolicy = {
    allowedTaskTypes: ["analyze", "validate_change"],
    noLiveSend: false,
    noMutation: false,
    gatewayRequired: true,
    mobileLowPower: false,
    standby: false,
    readOnly: true,
  };
  const evaluation = evaluateWorkerOnboarding("mobilebeta-style", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("readOnly")));
});

test("evaluateWorkerOnboarding NO-GO for mobilebeta-style missing gatewayRequired", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...mobilebeta_STYLE_POLICY,
    gatewayRequired: false,
  };
  const evaluation = evaluateWorkerOnboarding("mobilebeta-style", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("gatewayRequired")));
});

// ── GO/NO-GO: Standard gateway ─────────────────────────────────────────────

test("evaluateWorkerOnboarding GO for valid standard gateway policy", () => {
  const policy: ResourceAwareWorkerPolicy = {
    allowedTaskTypes: ["propose_patch", "apply_local_change", "analyze"],
    noLiveSend: false,
    noMutation: false,
    gatewayRequired: true,
    mobileLowPower: false,
    standby: false,
    readOnly: false,
    maxConcurrent: 3,
  };
  const evaluation = evaluateWorkerOnboarding("standard-gateway", policy);
  assert.equal(evaluation.decision, "go");
});

test("evaluateWorkerOnboarding NO-GO for standard gateway missing gatewayRequired", () => {
  const policy: ResourceAwareWorkerPolicy = {
    allowedTaskTypes: ["analyze"],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: false,
    readOnly: true,
  };
  const evaluation = evaluateWorkerOnboarding("standard-gateway", policy);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("gatewayRequired")));
});

// ── GO/NO-GO: Team1 scheduling attribution (workergamma lane) ───────────────

test("evaluateWorkerOnboarding GO for valid Team1 scheduling-attribution policy", () => {
  const evaluation = evaluateWorkerOnboarding(
    "team1-scheduling-attribution",
    workergamma_SCHEDULING_POLICY,
  );
  assert.equal(evaluation.decision, "go");
  assert.ok(evaluation.reasons.some((r) => r.includes("passed")));
});

test("evaluateWorkerOnboarding NO-GO for Team1 scheduling-attribution missing readOnly", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...workergamma_SCHEDULING_POLICY,
    readOnly: false,
  };
  const evaluation = evaluateWorkerOnboarding("team1-scheduling-attribution", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("readOnly")));
});

test("evaluateWorkerOnboarding NO-GO for Team1 scheduling-attribution with mobileLowPower", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...workergamma_SCHEDULING_POLICY,
    mobileLowPower: true,
  };
  const evaluation = evaluateWorkerOnboarding("team1-scheduling-attribution", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("mobileLowPower")));
});

test("evaluateWorkerOnboarding NO-GO for Team1 scheduling-attribution with promote_to_live", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...workergamma_SCHEDULING_POLICY,
    allowedTaskTypes: ["promote_to_live"],
  };
  const evaluation = evaluateWorkerOnboarding("team1-scheduling-attribution", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("promote_to_live")));
});

test("evaluateWorkerOnboarding NO-GO for Team1 scheduling-attribution without analyze/validate_change", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...workergamma_SCHEDULING_POLICY,
    allowedTaskTypes: ["verify", "backfill"],
  };
  const evaluation = evaluateWorkerOnboarding("team1-scheduling-attribution", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("analyze")));
});

test("evaluateWorkerOnboarding NO-GO for Team1 scheduling-attribution missing noLiveSend", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...workergamma_SCHEDULING_POLICY,
    noLiveSend: false,
  };
  const evaluation = evaluateWorkerOnboarding("team1-scheduling-attribution", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("noLiveSend")));
});

test("evaluateWorkerOnboarding NO-GO for Team1 scheduling-attribution missing noMutation", () => {
  const bad: ResourceAwareWorkerPolicy = {
    ...workergamma_SCHEDULING_POLICY,
    noMutation: false,
  };
  const evaluation = evaluateWorkerOnboarding("team1-scheduling-attribution", bad);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => r.includes("noMutation")));
});

// ── GO/NO-GO: Generic terms ────────────────────────────────────────────────

test("evaluateWorkerOnboarding GO for generic terms is always go when valid", () => {
  const evaluation = evaluateWorkerOnboarding("generic-terms", {
    allowedTaskTypes: ["analyze"],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: true,
    standby: false,
    readOnly: true,
  });
  assert.equal(evaluation.decision, "go");
});

test("evaluateWorkerOnboarding NO-GO for generic terms when validation fails", () => {
  const evaluation = evaluateWorkerOnboarding("generic-terms", {
    allowedTaskTypes: [],
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: false,
    readOnly: false,
  });
  assert.equal(evaluation.decision, "no-go");
});

// ── All flag types check ───────────────────────────────────────────────────

test("all policy flags default to false semantics via validation", () => {
  const result = validateResourceAwareWorkerPolicy({
    allowedTaskTypes: ["analyze"],
    noLiveSend: false,
    noMutation: false,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: false,
    readOnly: false,
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

// ── Policy diff ────────────────────────────────────────────────────────────

test("diffResourceAwareWorkerPolicy detects matching policies", () => {
  const diffs = diffResourceAwareWorkerPolicy(mobilealpha_HERMES_POLICY, mobilealpha_HERMES_POLICY);
  assert.equal(diffs.length, 8);
  assert.ok(diffs.every((d) => d.match));
});

test("diffResourceAwareWorkerPolicy detects mismatches", () => {
  const expected = mobilealpha_HERMES_POLICY;
  const actual = { ...expected, gatewayRequired: true, readOnly: false };
  const diffs = diffResourceAwareWorkerPolicy(actual, expected);
  const mismatched = diffs.filter((d) => !d.match);
  assert.ok(mismatched.length >= 2);
  assert.ok(mismatched.some((d) => d.field === "gatewayRequired" && d.actual === true && d.expected === false));
  assert.ok(mismatched.some((d) => d.field === "readOnly" && d.actual === false && d.expected === true));
});

test("diffResourceAwareWorkerPolicy handles allowedTaskTypes order-independently", () => {
  const actual: ResourceAwareWorkerPolicy = {
    ...mobilealpha_HERMES_POLICY,
    allowedTaskTypes: ["validate_change", "analyze"],
  };
  const expected: ResourceAwareWorkerPolicy = {
    ...mobilealpha_HERMES_POLICY,
    allowedTaskTypes: ["analyze", "validate_change"],
  };
  const diffs = diffResourceAwareWorkerPolicy(actual, expected);
  const taskTypeDiff = diffs.find((d) => d.field === "allowedTaskTypes");
  assert.ok(taskTypeDiff?.match);
});

// ── Preset policies ────────────────────────────────────────────────────────

test("getPresetPolicy returns mobilealpha/Hermes preset", () => {
  const preset = getPresetPolicy("mobilealpha-hermes");
  assert.ok(preset);
  assert.deepEqual(preset, mobilealpha_HERMES_POLICY);
  assert.equal(preset?.readOnly, true);
  assert.equal(preset?.noLiveSend, true);
  assert.equal(preset?.noMutation, true);
  assert.equal(preset?.mobileLowPower, true);
  assert.equal(preset?.gatewayRequired, false);
});

test("getPresetPolicy returns mobilebeta-style preset", () => {
  const preset = getPresetPolicy("mobilebeta-style");
  assert.ok(preset);
  assert.deepEqual(preset, mobilebeta_STYLE_POLICY);
  assert.equal(preset?.gatewayRequired, true);
  assert.equal(preset?.mobileLowPower, false);
  assert.equal(preset?.readOnly, false);
  assert.ok(preset?.allowedTaskTypes.includes("propose_patch"));
});

test("getPresetPolicy returns Team1 scheduling-attribution preset", () => {
  const preset = getPresetPolicy("team1-scheduling-attribution");
  assert.ok(preset);
  assert.deepEqual(preset, workergamma_SCHEDULING_POLICY);
  assert.equal(preset?.readOnly, true);
  assert.equal(preset?.noLiveSend, true);
  assert.equal(preset?.noMutation, true);
  assert.equal(preset?.gatewayRequired, false);
  assert.equal(preset?.mobileLowPower, false);
  assert.ok(preset?.allowedTaskTypes.includes("analyze"));
  assert.ok(preset?.allowedTaskTypes.includes("validate_change"));
});

test("getPresetPolicy returns null for unknown kind", () => {
  assert.equal(getPresetPolicy("generic-terms" as never), null);
});

// ── Edge cases ─────────────────────────────────────────────────────────────

test("validateResourceAwareWorkerPolicy rejects undefined allowedTaskTypes without throwing", () => {
  const policy = {
    allowedTaskTypes: undefined,
    noLiveSend: true,
    noMutation: true,
    gatewayRequired: false,
    mobileLowPower: false,
    standby: false,
    readOnly: false,
  } as unknown as ResourceAwareWorkerPolicy;
  assert.doesNotThrow(() => {
    const result = validateResourceAwareWorkerPolicy(policy);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("non-empty array")));
  });
});

test("validateResourceAwareWorkerPolicy rejects string values where booleans expected", () => {
  const policy = {
    ...mobilealpha_HERMES_POLICY,
    noLiveSend: "true",
  } as unknown as ResourceAwareWorkerPolicy;
  const result = validateResourceAwareWorkerPolicy(policy);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("boolean")));
});

test("evaluateWorkerOnboarding returns NO-GO for invalid policy regardless of kind", () => {
  const invalid = {
    ...mobilealpha_HERMES_POLICY,
    allowedTaskTypes: [],
  };
  const ev = evaluateWorkerOnboarding("generic-terms", invalid);
  assert.equal(ev.decision, "no-go");
  assert.ok(ev.reasons.some((r) => r.includes("validation failed")));
});

test("evaluateWorkerOnboarding handles unknown kind with NO-GO", () => {
  const ev = evaluateWorkerOnboarding("generic-terms" as never, mobilealpha_HERMES_POLICY);
  assert.equal(ev.decision, "go");
});

test("#1786 onboarding wiring: parses an opt-in off registration metadata and resolves the preset", () => {
  const parsed = resourceAwareOnboardingFromMetadata({
    [ONBOARDING_KIND_METADATA_KEY]: "mobilealpha-hermes",
  });
  assert.ok(parsed);
  assert.equal(parsed.kind, "mobilealpha-hermes");
  assert.equal(parsed.policySource, "preset");
  assert.equal(evaluateWorkerOnboarding(parsed.kind, parsed.policy).decision, "go");
});

test("#1786 onboarding wiring: returns null when the worker did not opt in, so registration is unchanged", () => {
  assert.equal(resourceAwareOnboardingFromMetadata(undefined), null);
  assert.equal(resourceAwareOnboardingFromMetadata({}), null);
  assert.equal(resourceAwareOnboardingFromMetadata({ other: "value" }), null);
});

test("#1786 onboarding wiring: throws on an opt-in it cannot honour rather than skipping silently", () => {
  assert.throws(
    () => resourceAwareOnboardingFromMetadata({ [ONBOARDING_KIND_METADATA_KEY]: "not-a-kind" }),
    /unknown resourceAwareOnboardingKind/,
  );
  assert.throws(
    () =>
      resourceAwareOnboardingFromMetadata({
        [ONBOARDING_KIND_METADATA_KEY]: "mobilealpha-hermes",
        [ONBOARDING_POLICY_METADATA_KEY]: "{not json",
      }),
    /not valid JSON/,
  );
});

test("#1786 onboarding wiring: lets metadata override the preset, and a bad override evaluates no-go", () => {
  const parsed = resourceAwareOnboardingFromMetadata({
    [ONBOARDING_KIND_METADATA_KEY]: "mobilealpha-hermes",
    [ONBOARDING_POLICY_METADATA_KEY]: JSON.stringify({
      allowedTaskTypes: ["analyze"],
      noLiveSend: false,
      noMutation: true,
      gatewayRequired: false,
      mobileLowPower: true,
      readOnly: true,
    }),
  });
  assert.ok(parsed);
  assert.equal(parsed.policySource, "metadata");
  const evaluation = evaluateWorkerOnboarding(parsed.kind, parsed.policy);
  assert.equal(evaluation.decision, "no-go");
  assert.ok(evaluation.reasons.some((r) => /noLiveSend/.test(r)));
});

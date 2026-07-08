// Canonical substantive predicate for wave stage quorum (#1357 G3-c classifier
// single-source). The broker — not the caller — decides which lane evidence
// classes count toward a wave quorum gate. The taxonomy mirrors the offline
// finalizer gate's closed evidence-class list; scripts/a2ad-finalizer-gate.test.mjs
// carries the cross-boundary conformance pin so the two cannot drift.
import test from "node:test";
import assert from "node:assert/strict";

import {
  WAVE_LANE_EVIDENCE_CLASSES,
  isSubstantiveEvidenceClass,
  summarizeWaveStageEvidence,
} from "./wave-evidence.js";
import { WavePlanError } from "./wave-plan.js";

test("only 'substantive' counts toward quorum — every other known class does not", () => {
  assert.ok(WAVE_LANE_EVIDENCE_CLASSES.includes("substantive"));
  for (const evidenceClass of WAVE_LANE_EVIDENCE_CLASSES) {
    assert.equal(
      isSubstantiveEvidenceClass(evidenceClass),
      evidenceClass === "substantive",
      `predicate must count exactly 'substantive', got a different verdict for '${evidenceClass}'`,
    );
  }
});

test("unknown evidence classes are not substantive (fail-closed predicate)", () => {
  assert.equal(isSubstantiveEvidenceClass("definitely_not_a_class"), false);
  assert.equal(isSubstantiveEvidenceClass(""), false);
  assert.equal(isSubstantiveEvidenceClass("SUBSTANTIVE "), false, "no case/whitespace forgiveness — the taxonomy is exact");
});

test("summarizeWaveStageEvidence derives substantiveCount from lane evidence classes", () => {
  const summary = summarizeWaveStageEvidence([
    { evidenceClass: "substantive" },
    { evidenceClass: "wrapper_only" },
    { evidenceClass: "substantive" },
    { evidenceClass: "provider_or_model_failure" },
  ]);
  assert.deepEqual(summary, { substantiveCount: 2 });
});

test("summarizeWaveStageEvidence fails closed on unknown or missing evidence classes", () => {
  assert.throws(
    () => summarizeWaveStageEvidence([{ evidenceClass: "substantivee" }]),
    (e) => e instanceof WavePlanError && e.code === "wave_spec_invalid" && /substantivee/.test(e.message),
  );
  assert.throws(
    () => summarizeWaveStageEvidence([{}]),
    (e) => e instanceof WavePlanError && e.code === "wave_spec_invalid",
  );
});

test("summarizeWaveStageEvidence of an empty lane list is a zero count (gate stays unmet)", () => {
  assert.deepEqual(summarizeWaveStageEvidence([]), { substantiveCount: 0 });
});

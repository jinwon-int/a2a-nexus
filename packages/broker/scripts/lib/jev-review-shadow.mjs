// JEV review-evidence shadow (spec: docs/specs/jev-review-evidence-shadow/).
// C3 receipt/source-projection and C4 intake-review-sufficiency observation:
// env-gated, typed via the G1 facade contract, in-process telemetry only —
// the returned record is discarded by the caller; shadow verdicts never gate
// anything and outputs stay byte-identical to gate-off. Judgment-time inputs
// are closed banded fields only: the task body, prompt, source contents, and
// free text never enter the state string (chars outside [a-z0-9_.-] collapse
// to the "unknown" token).

import { classifyTypedWithJev, resolveJevConfig } from "./jev-classifier.mjs";

const RECEIPT_GATE_VAR = "A2A_JEV_RECEIPT_SHADOW";
const REVIEW_GATE_VAR = "A2A_JEV_REVIEW_SHADOW";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function safeToken(value, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_.-]{1,40}$/.test(text) ? text : fallback;
}

function countBand(value) {
  const n = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  if (n === 0) return "0";
  if (n <= 3) return "1-3";
  if (n <= 10) return "4-10";
  if (n <= 50) return "11-50";
  return "50+";
}

function bytesBand(value) {
  const n = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  if (n === 0) return "0";
  if (n <= 2048) return "0-2k";
  if (n <= 16384) return "2k-16k";
  if (n <= 65536) return "16k-64k";
  return "64k+";
}

function outcomeParts(outcome) {
  if (!isPlainObject(outcome)) return {};
  const result = isPlainObject(outcome.result) ? outcome.result : {};
  const output = isPlainObject(result.output) ? result.output : {};
  const error = isPlainObject(outcome.error) ? outcome.error : {};
  const details = isPlainObject(error.details) ? error.details : {};
  return { result, output, error, details };
}

function intentClass(outcome) {
  return safeToken(outcome?.lifecycle?.intent ?? outcome?.lifecycle?.mode);
}

function modeClass(outcome) {
  return safeToken(outcome?.lifecycle?.mode);
}

// C3: banded receipt inputs from the outcome's source-projection surface
// (success quality on output.sourceProjection, or the blocked error's
// details.sourceProjection). Undefined when the task carries no projection.
export function receiptShadowInputs(outcome) {
  const { output, details } = outcomeParts(outcome);
  const projection = isPlainObject(output.sourceProjection)
    ? output.sourceProjection
    : isPlainObject(details.sourceProjection)
      ? details.sourceProjection
      : undefined;
  if (!projection) return undefined;
  return {
    point: "receipt",
    intent: intentClass(outcome),
    mode: modeClass(outcome),
    projection_quality: safeToken(projection.quality),
    budget_reason: safeToken(projection.budgetReason),
    canonical_files: countBand(projection.canonicalFileCount),
    projected_files: countBand(projection.projectedFileCount),
    projected_bytes: bytesBand(projection.projectedBytes),
    warnings_count: countBand(Array.isArray(projection.warnings) ? projection.warnings.length : 0),
  };
}

// C4: banded review-sufficiency inputs from the last review validation entry
// (verdict label, note size band — never the note text). Undefined when the
// outcome carries no review validation.
export function reviewShadowInputs(outcome) {
  const { result } = outcomeParts(outcome);
  const validations = Array.isArray(result.validations) ? result.validations : [];
  const review = [...validations].reverse().find((entry) => isPlainObject(entry) && entry.kind === "review");
  if (!review) return undefined;
  return {
    point: "review",
    intent: intentClass(outcome),
    mode: modeClass(outcome),
    review_verdict: safeToken(review.verdict),
    note_size: bytesBand(typeof review.note === "string" ? Buffer.byteLength(review.note, "utf8") : 0),
  };
}

// Closed banded record -> shared judgment-time state string. Every value is
// a safe token; nothing free-form can reach the judge.
function stateString(record) {
  return Object.entries(record).map(([key, value]) => `${key}=${value}`).join(" ");
}

// Spec-drafted C3 questions (choice labels are the closed response set and
// are validated on the response, never transmitted).
export function receiptShadowQuestions() {
  return [
    {
      id: "receipt_state",
      type: "choice",
      instructions: "Given the banded source-projection record, classify the source receipt for this task's evidence needs.",
      labels: ["complete", "partial", "unreadable", "insufficient_information", "defer"],
    },
    {
      id: "p_source_sufficient",
      type: "noul",
      instructions: "Probability that the projected sources were sufficient to judge this task's evidence needs.",
    },
    {
      id: "receipt_fidelity",
      type: "score",
      instructions: "Carrier-to-projection fidelity score for this receipt.",
    },
  ];
}

// Spec-drafted C4 questions.
export function reviewShadowQuestions() {
  return [
    {
      id: "review_disposition",
      type: "choice",
      instructions: "Given the banded review record, disposition the review verdict's evidentiary support.",
      labels: ["pass", "fail", "defer"],
    },
    {
      id: "p_verdict_supported",
      type: "noul",
      instructions: "Probability that the attached evidence supports the review verdict.",
    },
    {
      id: "review_evidence_quality",
      type: "score",
      instructions: "Completeness and quality score of the review's evidence references.",
    },
  ];
}

// Shadow observation: telemetry-only typed record. `{attempted: false}` when
// the gate is off/invalid or the outcome carries no inputs for the point; a
// jev failure is `{attempted: true, ok: false, reason}` — never a throw (the
// CLI wraps the call anyway; the shadow may not affect the emitted ack).
export async function observeReceiptShadow(inputs, { env = process.env, transport } = {}) {
  const config = resolveJevConfig(env, RECEIPT_GATE_VAR);
  for (const warning of config.warnings) process.stderr.write(`${warning}\n`);
  if (!config.enabled) return { attempted: false, point: "receipt", reason: config.reason || "gate-off" };
  if (!isPlainObject(inputs)) return { attempted: false, point: "receipt", reason: "no-inputs" };
  const result = await classifyTypedWithJev({
    config,
    state: stateString(inputs),
    questions: receiptShadowQuestions(),
    transport,
  });
  return { attempted: result.attempts > 0, point: "receipt", inputs, ...result };
}

export async function observeReviewSufficiencyShadow(inputs, { env = process.env, transport } = {}) {
  const config = resolveJevConfig(env, REVIEW_GATE_VAR);
  for (const warning of config.warnings) process.stderr.write(`${warning}\n`);
  if (!config.enabled) return { attempted: false, point: "review", reason: config.reason || "gate-off" };
  if (!isPlainObject(inputs)) return { attempted: false, point: "review", reason: "no-inputs" };
  const result = await classifyTypedWithJev({
    config,
    state: stateString(inputs),
    questions: reviewShadowQuestions(),
    transport,
  });
  return { attempted: result.attempts > 0, point: "review", inputs, ...result };
}

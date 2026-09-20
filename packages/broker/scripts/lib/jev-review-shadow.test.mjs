import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  observeReceiptShadow,
  observeReviewSufficiencyShadow,
  receiptShadowInputs,
  receiptShadowQuestions,
  reviewShadowInputs,
  reviewShadowQuestions,
} from "./jev-review-shadow.mjs";

const FREE_TEXT = "TOP SECRET task body must never reach the judge";

function receiptOutcome(overrides = {}) {
  return {
    result: {
      output: {
        message: FREE_TEXT,
        ...overrides,
      },
    },
  };
}

function reviewOutcome() {
  return {
    result: {
      output: { message: FREE_TEXT },
      validations: [
        { kind: "other", verdict: "noise" },
        { kind: "review", verdict: "pass", nodeId: "worker-node", note: `${FREE_TEXT} — review note` },
      ],
    },
  };
}

function shadowEnv(keyfilePath, gateVar, overrides = {}) {
  return {
    [gateVar]: "1",
    A2A_JEV_ENDPOINT: "https://jev.example.invalid/api/classify",
    A2A_JEV_KEYFILE: keyfilePath,
    ...overrides,
  };
}

function makeKeyfile(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-review-shadow-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyfilePath = join(dir, "jev.key");
  writeFileSync(keyfilePath, "synthetic-jev-key-material");
  chmodSync(keyfilePath, 0o600);
  return keyfilePath;
}

function recordingTransport(resolver) {
  const calls = [];
  const transport = async (request) => {
    calls.push(request);
    return resolver(request, calls.length);
  };
  transport.calls = calls;
  return transport;
}

test("C3 receiptShadowInputs extracts banded fields from success or blocked projections", () => {
  const ok = receiptShadowInputs(receiptOutcome({
    sourceProjection: { quality: "ok", canonicalFileCount: 7, projectedFileCount: 7, projectedBytes: 42000, warnings: ["w1", "w2"] },
  }));
  assert.equal(ok.point, "receipt");
  assert.equal(ok.projection_quality, "ok");
  assert.equal(ok.canonical_files, "4-10");
  assert.equal(ok.projected_bytes, "16k-64k");
  assert.equal(ok.warnings_count, "1-3");
  assert.equal(ok.intent, "unknown", "no lifecycle in a bare outcome maps to the unknown token");

  const blocked = receiptShadowInputs({
    error: { details: { sourceProjection: { quality: "zero_files", budgetReason: "empty-carriers" } } },
  });
  assert.equal(blocked.projection_quality, "zero_files");
  assert.equal(blocked.budget_reason, "empty-carriers");

  assert.equal(receiptShadowInputs(receiptOutcome()), undefined, "no projection surface -> no receipt inputs");
});

test("C4 reviewShadowInputs finds the last review validation and bands the note size", () => {
  const inputs = reviewShadowInputs(reviewOutcome());
  assert.equal(inputs.point, "review");
  assert.equal(inputs.review_verdict, "pass");
  assert.match(inputs.note_size, /^(0|0-2k|2k-16k|16k-64k|64k\+)$/);
  assert.equal(reviewShadowInputs({ result: { validations: [{ kind: "other" }] } }), undefined);
});

test("C3/C4 question drafts match the spec (ids, types, closed choice labels)", () => {
  const receipt = receiptShadowQuestions();
  assert.deepEqual(receipt.map((q) => q.id), ["receipt_state", "p_source_sufficient", "receipt_fidelity"]);
  assert.deepEqual(receipt[0].labels, ["complete", "partial", "unreadable", "insufficient_information", "defer"]);
  const review = reviewShadowQuestions();
  assert.deepEqual(review.map((q) => q.id), ["review_disposition", "p_verdict_supported", "review_evidence_quality"]);
  assert.deepEqual(review[0].labels, ["pass", "fail", "defer"]);
});

test("C3 observeReceiptShadow: gate off never attempts; free text never reaches the judge", async (t) => {
  const keyfilePath = makeKeyfile(t);
  const transport = recordingTransport(() => ({
    status: 200,
    text: JSON.stringify({
      answers: {
        receipt_state: { choice: "partial", confidence: 0.7 },
        p_source_sufficient: { noul: 0.4 },
        receipt_fidelity: { score: 1.5, confidence: 0.5 },
      },
    }),
  }));
  const off = await observeReceiptShadow(
    receiptShadowInputs(receiptOutcome({ sourceProjection: { quality: "ok" } })),
    { env: { A2A_JEV_ENDPOINT: "https://jev.example.invalid", A2A_JEV_KEYFILE: keyfilePath }, transport },
  );
  assert.equal(off.attempted, false);
  assert.equal(off.reason, "gate-off");
  assert.equal(transport.calls.length, 0);

  const inputs = receiptShadowInputs(receiptOutcome({
    sourceProjection: { quality: "insufficient", canonicalFileCount: 2, projectedFileCount: 0, projectedBytes: 100 },
  }));
  const on = await observeReceiptShadow(inputs, { env: shadowEnv(keyfilePath, "A2A_JEV_RECEIPT_SHADOW"), transport });
  assert.equal(on.attempted, true);
  assert.equal(on.ok, true);
  assert.equal(on.answers.receipt_state.label, "partial");
  assert.equal(transport.calls.length, 1, "exactly one attempt, no retry");
  const state = transport.calls[0].payload.state;
  assert.match(state, /^point=receipt intent=/);
  assert.equal(state.includes(FREE_TEXT), false, "task body must never enter the state string");
  assert.equal(JSON.stringify(transport.calls[0].payload).includes(FREE_TEXT), false, "free text must never reach the payload");
});

test("C4 observeReviewSufficiencyShadow: typed observation and single attempt", async (t) => {
  const keyfilePath = makeKeyfile(t);
  const transport = recordingTransport(() => ({
    status: 200,
    text: JSON.stringify({
      answers: {
        review_disposition: { choice: "defer", confidence: 0.55 },
        p_verdict_supported: { noul: 0.62 },
        review_evidence_quality: { score: 2.0 },
      },
    }),
  }));
  const result = await observeReviewSufficiencyShadow(
    reviewShadowInputs(reviewOutcome()),
    { env: shadowEnv(keyfilePath, "A2A_JEV_REVIEW_SHADOW"), transport },
  );
  assert.equal(result.attempted, true);
  assert.equal(result.ok, true);
  assert.equal(result.answers.review_disposition.label, "defer");
  assert.equal(result.answers.p_verdict_supported.probability, 0.62);
  assert.equal(transport.calls.length, 1);
});

test("C3/C4 observers fail open: transport errors are reported, never thrown", async (t) => {
  const keyfilePath = makeKeyfile(t);
  const throwing = recordingTransport(() => { throw new Error("ECONNREFUSED"); });
  const receipt = await observeReceiptShadow(
    receiptShadowInputs(receiptOutcome({ sourceProjection: { quality: "ok" } })),
    { env: shadowEnv(keyfilePath, "A2A_JEV_RECEIPT_SHADOW"), transport: throwing },
  );
  assert.equal(receipt.attempted, true);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.reason, "transport-error");
  const review = await observeReviewSufficiencyShadow(
    reviewShadowInputs(reviewOutcome()),
    { env: shadowEnv(keyfilePath, "A2A_JEV_REVIEW_SHADOW"), transport: throwing },
  );
  assert.equal(review.attempted, true);
  assert.equal(review.ok, false);
  assert.equal(review.reason, "transport-error");
});

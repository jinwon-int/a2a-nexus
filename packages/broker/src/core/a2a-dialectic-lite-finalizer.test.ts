import assert from "node:assert/strict";
import test from "node:test";

import {
  A2A_DIALECTIC_LITE_DEFAULT_MODE,
  A2A_DIALECTIC_LITE_TRIGGER,
  A2A_DIALECTIC_STRONG_MODE,
  A2A_DIALECTIC_STRONG_TRIGGER,
  buildA2ADialecticLiteFinalizerPacket,
  renderA2ADialecticLiteFinalizerMarkdown,
} from "./a2a-dialectic-lite-finalizer.js";

const NOW = "2026-06-01T09:47:00.000Z";

test("does not let dialectic synthesis win without ordinary alternatives", () => {
  const packet = buildA2ADialecticLiteFinalizerPacket({
    generatedAt: NOW,
    runId: "round-1",
    synthesisCandidate: { workerId: "workerbeta", summary: "Adopt the dialectic synthesis." },
    selectedCandidateId: "synthesis",
    selectionRationale: ["Synthesis seems comprehensive."],
  });

  assert.equal(packet.triggerPhrase, A2A_DIALECTIC_LITE_TRIGGER);
  assert.equal(packet.roundMode, A2A_DIALECTIC_LITE_DEFAULT_MODE);
  assert.equal(packet.dialecticSynthesisIsCandidateOnly, true);
  assert.equal(packet.dialecticSynthesisAutoWinner, false);
  assert.equal(packet.state, "needs_ordinary_alternative_comparison");
  assert.match(packet.blockers.join("\n"), /add at least one ordinary alternative/);
});

test("uses ordinary A2A Lite as the default round mode", () => {
  const packet = buildA2ADialecticLiteFinalizerPacket({
    generatedAt: NOW,
    runId: "round-default-lite",
    synthesisCandidate: { workerId: "workerbeta", summary: "Keep the normal A2A round lightweight." },
    ordinaryAlternatives: [{ id: "ordinary", workerId: "workeralpha", summary: "Use direct engineering judgment only." }],
    selectedCandidateId: "ordinary",
    selectionRationale: ["The ordinary path is enough for this small decision."],
  });

  assert.equal(packet.roundMode, A2A_DIALECTIC_LITE_DEFAULT_MODE);
  assert.equal(packet.defaultRoundMode, A2A_DIALECTIC_LITE_DEFAULT_MODE);
  assert.equal(packet.strongTriggerPhrase, A2A_DIALECTIC_STRONG_TRIGGER);
});

test("records explicit strong a2ad mode only when requested", () => {
  const packet = buildA2ADialecticLiteFinalizerPacket({
    generatedAt: NOW,
    runId: "round-strong-a2ad",
    roundMode: A2A_DIALECTIC_STRONG_MODE,
    synthesisCandidate: {
      workerId: "workerbeta",
      summary: "Run a deeper thesis/antithesis/synthesis review.",
    },
    ordinaryAlternatives: [{ id: "ordinary", workerId: "workeralpha", summary: "Keep the round as light A2A." }],
    selectedCandidateId: "synthesis",
    selectionRationale: ["The decision is complex enough to justify explicit strong dialectic review."],
  });

  assert.equal(packet.roundMode, A2A_DIALECTIC_STRONG_MODE);
  assert.equal(packet.state, "ready_for_finalizer_decision");
  assert.ok(packet.strongTriggerAliases.includes(A2A_DIALECTIC_LITE_TRIGGER));
});

test("requires worker attribution for dialectic opinions", () => {
  const packet = buildA2ADialecticLiteFinalizerPacket({
    generatedAt: NOW,
    runId: "round-worker-attribution",
    thesis: "Team1 thesis without explicit worker.",
    synthesisCandidate: { summary: "Unattributed synthesis candidate." },
    ordinaryAlternatives: [{ id: "ordinary", summary: "Unattributed ordinary alternative." }],
    selectedCandidateId: "ordinary",
    selectionRationale: ["The ordinary alternative is safer."],
  });

  assert.equal(packet.workerAttributionRequired, true);
  assert.equal(packet.state, "needs_worker_attribution");
  assert.match(packet.blockers.join("\n"), /thesisWorkerId/);
  assert.match(packet.blockers.join("\n"), /candidate:synthesis\.workerId/);
  assert.match(packet.blockers.join("\n"), /candidate:ordinary\.workerId/);
});

test("allows synthesis only after comparison and rationale", () => {
  const packet = buildA2ADialecticLiteFinalizerPacket({
    generatedAt: NOW,
    runId: "round-2",
    finalizer: "brokeralpha",
    synthesisCandidate: {
      id: "synthesis",
      workerId: "workerbeta",
      summary: "Patch diagnostics and keep the round source-only.",
      evidence: ["matches current approval boundary"],
      verification: ["focused tests"],
    },
    ordinaryAlternatives: [
      {
        id: "simple-doc-only",
        workerId: "workeralpha",
        summary: "Only document the operational guidance.",
        evidence: ["lower complexity"],
        risks: ["does not create an executable guard"],
        complexity: "low",
      },
    ],
    selectedCandidateId: "synthesis",
    selectionRationale: [
      "Adds an executable guard while staying source-only.",
      "Keeps approval-sensitive actions blocked.",
    ],
  });

  assert.equal(packet.state, "ready_for_finalizer_decision");
  assert.equal(packet.selectedCandidateSource, "dialectic_synthesis");
  assert.equal(packet.checks.find((check) => check.id === "synthesis_not_default_winner")?.status, "warn");
  assert.equal(packet.safety.deployOrRestart, false);
  assert.equal(packet.grantsExecutionApproval, false);
});

test("can select an ordinary alternative over synthesis", () => {
  const packet = buildA2ADialecticLiteFinalizerPacket({
    generatedAt: NOW,
    runId: "round-3",
    synthesisCandidate: { workerId: "workerbeta", summary: "Create a larger multi-lane implementation." },
    ordinaryAlternatives: [
      {
        id: "small-source-guard",
        workerId: "workeralpha",
        summary: "Add the smallest source-only finalizer guard.",
        evidence: ["directly addresses the policy gap"],
        complexity: "low",
      },
    ],
    selectedCandidateId: "small-source-guard",
    selectionRationale: ["Simpler and easier to validate than the synthesis candidate."],
  });

  assert.equal(packet.state, "ready_for_finalizer_decision");
  assert.equal(packet.selectedCandidateSource, "ordinary_alternative");
  assert.equal(packet.checks.find((check) => check.id === "synthesis_not_default_winner")?.status, "pass");
});

test("requires rationale for any finalizer selection", () => {
  const packet = buildA2ADialecticLiteFinalizerPacket({
    generatedAt: NOW,
    runId: "round-4",
    synthesisCandidate: { workerId: "workerbeta", summary: "Synthesis candidate" },
    ordinaryAlternatives: [{ id: "ordinary", workerId: "workeralpha", summary: "Ordinary alternative" }],
    selectedCandidateId: "ordinary",
  });

  assert.equal(packet.state, "needs_selection_rationale");
  assert.match(packet.blockers.join("\n"), /best evidenced, safest, and simplest/);
});

test("renders markdown with candidate-not-winner rule", () => {
  const packet = buildA2ADialecticLiteFinalizerPacket({
    generatedAt: NOW,
    runId: "round-5",
    topic: "A2A finalizer policy",
    synthesisCandidate: { workerId: "workerbeta", summary: "Synthesis candidate" },
    ordinaryAlternatives: [{ id: "ordinary", workerId: "workeralpha", summary: "Ordinary alternative" }],
    selectedCandidateId: "ordinary",
    selectionRationale: ["The ordinary alternative is safer and simpler."],
  });
  const markdown = renderA2ADialecticLiteFinalizerMarkdown(packet);

  assert.match(markdown, /A2A Dialectic Lite finalizer guard/);
  assert.match(markdown, /Round mode: ordinary_a2a_lite/);
  assert.match(markdown, /Strong a2ad trigger: a2ad 로 진행/);
  assert.match(markdown, /candidate, not a default winner/);
  assert.match(markdown, /best evidenced, safest, simplest viable path/);
  assert.match(markdown, /does not grant execution approval/);
});

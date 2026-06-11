/**
 * Tests for worker status marker normalizer (Round 16, plugin-a2a#84).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectMarker,
  parseWorkerStatusMarker,
  toBrokerEvent,
  batchParseWorkerStatusMarkers,
  type WorkerStatusEvent,
} from "../dist/src/worker-status-marker.js";

// ── detectMarker ───────────────────────────────────────────────

describe("detectMarker", () => {
  it("detects Start", () => {
    assert.equal(detectMarker("**Start** — working on it"), "Start");
  });

  it("detects Block", () => {
    assert.equal(detectMarker("**Block** — waiting on upstream"), "Block");
  });

  it("detects PR", () => {
    assert.equal(detectMarker("**PR** — https://github.com/org/repo/pull/1"), "PR");
  });

  it("detects Done", () => {
    assert.equal(detectMarker("**Done** — completed"), "Done");
  });

  it("returns null for no marker", () => {
    assert.equal(detectMarker("Just a regular comment"), null);
  });

  it("is case-insensitive", () => {
    assert.equal(detectMarker("**start**"), "Start");
    assert.equal(detectMarker("**BLOCK**"), "Block");
  });
});

// ── Start marker ───────────────────────────────────────────────

describe("Start marker", () => {
  it("parses basic Start", () => {
    const result = parseWorkerStatusMarker("**Start**", "worker-alpha", "51") as WorkerStatusEvent;
    assert.equal(result.marker, "Start");
    assert.equal(result.workerId, "worker-alpha");
    assert.equal(result.taskId, "51");
    assert.equal(result.parseStatus, "clean");
    assert.deepEqual(result.warnings, []);
  });

  it("extracts summary text after marker", () => {
    const result = parseWorkerStatusMarker(
      "**Start** — root cause identified. Fixing visibility guard.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Start") throw new Error("wrong marker");
    assert.ok((result.payload.summary).includes("root cause"));
  });

  it("extracts issue URL from body", () => {
    const result = parseWorkerStatusMarker(
      "**Start**\nRelated: https://github.com/org/repo/issues/42",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Start") throw new Error("wrong marker");
    assert.equal(result.payload.issueUrl, "https://github.com/org/repo/issues/42");
  });
});

// ── Block marker ───────────────────────────────────────────────

describe("Block marker", () => {
  it("parses Block with reason", () => {
    const result = parseWorkerStatusMarker(
      "**Block** — blocked by upstream dependency openclaw#57447",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Block") throw new Error("wrong marker");
    assert.ok((result.payload.reason).includes("upstream dependency"));
  });

  it("extracts blockedOn reference", () => {
    const result = parseWorkerStatusMarker(
      "**Block** — blocked on upstream review",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Block") throw new Error("wrong marker");
    assert.equal(result.payload.blockedOn, "upstream review");
  });

  it("warns when no reason text", () => {
    const result = parseWorkerStatusMarker("**Block**", "worker-alpha", "51") as WorkerStatusEvent;
    if (result.marker !== "Block") throw new Error("wrong marker");
    assert.equal(result.parseStatus, "partial");
    assert.equal((result.warnings).length, 1);
    assert.equal(result.payload.reason, "unspecified blocker");
  });
});

// ── PR marker ──────────────────────────────────────────────────

describe("PR marker", () => {
  it("parses PR with URL", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — https://github.com/jinwon-int/openclaw/pull/52",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    assert.equal(result.payload.prUrl, "https://github.com/jinwon-int/openclaw/pull/52");
    assert.equal(result.parseStatus, "clean");
  });

  it("extracts branch name", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — https://github.com/jinwon-int/openclaw/pull/52\nbranch: worker-alpha/r15-visibility",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    assert.equal(result.payload.branch, "worker-alpha/r15-visibility");
  });

  it("detects Closes reference", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — https://github.com/jinwon-int/openclaw/pull/52 Closes #51",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    assert.equal(result.payload.closesIssue, true);
  });

  it("warns when no PR URL", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — will submit shortly",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    assert.ok((result.warnings).includes("PR marker has no PR URL"));
    assert.equal(result.payload.prUrl, "");
  });

  it("extracts verification summary", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — https://github.com/jinwon-int/openclaw/pull/52\nAll tests pass. No read expansion.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    assert.ok((result.payload.verificationSummary).includes("All tests pass"));
  });
});

// ── Done marker ────────────────────────────────────────────────

describe("Done marker", () => {
  it("parses successful Done", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — visibility guard separated. All tests green.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.success, true);
    assert.ok((result.payload.completionSummary).includes("visibility guard"));
  });

  it("detects failure indicators", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — build failed on CI",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.success, false);
  });

  it("extracts PR URL from Done body", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — https://github.com/jinwon-int/openclaw/pull/52 merged",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.prUrl, "https://github.com/jinwon-int/openclaw/pull/52");
    assert.equal(result.payload.success, true);
  });

  it("handles Done with no body", () => {
    const result = parseWorkerStatusMarker("**Done**", "worker-alpha", "51") as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.outcome, undefined);
  });

  it("classifies done_with_changes when PR URL is present", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — https://github.com/jinwon-int/openclaw/pull/52 merged",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.outcome, "done_with_changes");
  });

  it("classifies done_evidence_only from explicit signal", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — evidence-only, no code changes. Start comment posted.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.outcome, "done_evidence_only");
  });

  it("classifies done_evidence_only from block evidence signal", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — block evidence surfaced, no PR needed.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.outcome, "done_evidence_only");
  });

  it("classifies done_no_changes from explicit signal", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — assessment complete, no changes needed.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.outcome, "done_no_changes");
  });

  it("classifies done_no_changes from nothing to change signal", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — nothing to change, code is already compliant.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.outcome, "done_no_changes");
  });

  it("does not set outcome when no signals are present and no PR URL", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — task completed successfully.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.outcome, undefined);
  });

  it("evidence-only overrides PR URL presence", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — evidence-only, no code changes. PR: https://github.com/jinwon-int/openclaw/pull/52",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.outcome, "done_evidence_only");
    assert.equal(result.payload.prUrl, "https://github.com/jinwon-int/openclaw/pull/52");
  });
  it("sets readOnly=true for done_evidence_only outcome", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — evidence-only, no code changes. Assessment complete.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.readOnly, true);
    assert.equal(result.payload.outcome, "done_evidence_only");
  });

  it("sets readOnly=true for done_no_changes outcome", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — assessment complete, no changes needed.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.readOnly, true);
    assert.equal(result.payload.outcome, "done_no_changes");
  });

  it("readOnly is undefined for done_with_changes outcome", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — https://github.com/jinwon-int/openclaw/pull/52 merged",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.outcome, "done_with_changes");
    assert.equal(result.payload.readOnly, undefined);
  });

  it("readOnly is undefined when no outcome is classified", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — task completed.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    assert.equal(result.payload.outcome, undefined);
    assert.equal(result.payload.readOnly, undefined);
  });
});

// ── Error handling ─────────────────────────────────────────────

describe("error handling", () => {
  it("returns error for empty text", () => {
    const result = parseWorkerStatusMarker("", "worker-alpha", "51");
    assert.deepEqual(result, {
      ok: false,
      error: "text must be a non-empty string",
      rawText: "",
    });
  });

  it("returns error for no marker", () => {
    const result = parseWorkerStatusMarker("Regular text", "worker-alpha", "51");
    assert.deepEqual(result, {
      ok: false,
      error: "no recognized worker status marker found in text",
      rawText: "Regular text",
    });
  });

  it("returns error for missing workerId", () => {
    const result = parseWorkerStatusMarker("**Start**", "", "51");
    assert.deepEqual(result, {
      ok: false,
      error: "workerId must be a non-empty string",
      rawText: "**Start**",
    });
  });

  it("returns error for missing taskId", () => {
    const result = parseWorkerStatusMarker("**Start**", "worker-alpha", "");
    assert.deepEqual(result, {
      ok: false,
      error: "taskId must be a non-empty string",
      rawText: "**Start**",
    });
  });
});

// ── toBrokerEvent ──────────────────────────────────────────────

describe("toBrokerEvent", () => {
  it("converts a Start event to broker shape", () => {
    const event = parseWorkerStatusMarker(
      "**Start** — beginning work",
      "worker-alpha",
      "84",
    ) as WorkerStatusEvent;
    const broker = toBrokerEvent(event);
    assert.equal(broker.type, "worker-status");
    assert.equal(broker.marker, "Start");
    assert.equal(broker.workerId, "worker-alpha");
    assert.equal(broker.taskId, "84");
    assert.equal(broker.meta.parseStatus, "clean");
  });

  it("preserves warnings in broker event", () => {
    const event = parseWorkerStatusMarker("**PR**", "worker-alpha", "84") as WorkerStatusEvent;
    const broker = toBrokerEvent(event);
    assert.ok((broker.meta.warnings).includes("PR marker has no PR URL"));
  });
});

// ── batchParse ─────────────────────────────────────────────────

describe("batchParseWorkerStatusMarkers", () => {
  it("parses multiple valid markers", () => {
    const { events, errors } = batchParseWorkerStatusMarkers([
      { text: "**Start** — work", workerId: "worker-alpha", taskId: "84" },
      { text: "**Done** — done", workerId: "worker-alpha", taskId: "84" },
    ]);
    assert.equal((events).length, 2);
    assert.equal((errors).length, 0);
  });

  it("collects errors without failing the batch", () => {
    const { events, errors } = batchParseWorkerStatusMarkers([
      { text: "**Start** — work", workerId: "worker-alpha", taskId: "84" },
      { text: "no marker here", workerId: "worker-alpha", taskId: "84" },
      { text: "**Done**", workerId: "", taskId: "84" },
    ]);
    assert.equal((events).length, 1);
    assert.equal((errors).length, 2);
  });
});

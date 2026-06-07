/**
 * Tests for worker status marker normalizer (Round 16, plugin-a2a#84).
 */
import { describe, expect, it } from "vitest";
import {
  detectMarker,
  parseWorkerStatusMarker,
  toBrokerEvent,
  batchParseWorkerStatusMarkers,
  type WorkerStatusEvent,
} from "./worker-status-marker.js";

// ── detectMarker ───────────────────────────────────────────────

describe("detectMarker", () => {
  it("detects Start", () => {
    expect(detectMarker("**Start** — working on it")).toBe("Start");
  });

  it("detects Block", () => {
    expect(detectMarker("**Block** — waiting on upstream")).toBe("Block");
  });

  it("detects PR", () => {
    expect(detectMarker("**PR** — https://github.com/org/repo/pull/1")).toBe("PR");
  });

  it("detects Done", () => {
    expect(detectMarker("**Done** — completed")).toBe("Done");
  });

  it("returns null for no marker", () => {
    expect(detectMarker("Just a regular comment")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(detectMarker("**start**")).toBe("Start");
    expect(detectMarker("**BLOCK**")).toBe("Block");
  });
});

// ── Start marker ───────────────────────────────────────────────

describe("Start marker", () => {
  it("parses basic Start", () => {
    const result = parseWorkerStatusMarker("**Start**", "worker-alpha", "51") as WorkerStatusEvent;
    expect(result.marker).toBe("Start");
    expect(result.workerId).toBe("worker-alpha");
    expect(result.taskId).toBe("51");
    expect(result.parseStatus).toBe("clean");
    expect(result.warnings).toEqual([]);
  });

  it("extracts summary text after marker", () => {
    const result = parseWorkerStatusMarker(
      "**Start** — root cause identified. Fixing visibility guard.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Start") throw new Error("wrong marker");
    expect(result.payload.summary).toContain("root cause");
  });

  it("extracts issue URL from body", () => {
    const result = parseWorkerStatusMarker(
      "**Start**\nRelated: https://github.com/org/repo/issues/42",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Start") throw new Error("wrong marker");
    expect(result.payload.issueUrl).toBe("https://github.com/org/repo/issues/42");
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
    expect(result.payload.reason).toContain("upstream dependency");
  });

  it("extracts blockedOn reference", () => {
    const result = parseWorkerStatusMarker(
      "**Block** — blocked on upstream review",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Block") throw new Error("wrong marker");
    expect(result.payload.blockedOn).toBe("upstream review");
  });

  it("warns when no reason text", () => {
    const result = parseWorkerStatusMarker("**Block**", "worker-alpha", "51") as WorkerStatusEvent;
    if (result.marker !== "Block") throw new Error("wrong marker");
    expect(result.parseStatus).toBe("partial");
    expect(result.warnings).toHaveLength(1);
    expect(result.payload.reason).toBe("unspecified blocker");
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
    expect(result.payload.prUrl).toBe("https://github.com/jinwon-int/openclaw/pull/52");
    expect(result.parseStatus).toBe("clean");
  });

  it("extracts branch name", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — https://github.com/jinwon-int/openclaw/pull/52\nbranch: worker-alpha/r15-visibility",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    expect(result.payload.branch).toBe("worker-alpha/r15-visibility");
  });

  it("detects Closes reference", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — https://github.com/jinwon-int/openclaw/pull/52 Closes #51",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    expect(result.payload.closesIssue).toBe(true);
  });

  it("warns when no PR URL", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — will submit shortly",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    expect(result.warnings).toContain("PR marker has no PR URL");
    expect(result.payload.prUrl).toBe("");
  });

  it("extracts verification summary", () => {
    const result = parseWorkerStatusMarker(
      "**PR** — https://github.com/jinwon-int/openclaw/pull/52\nAll tests pass. No read expansion.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "PR") throw new Error("wrong marker");
    expect(result.payload.verificationSummary).toContain("All tests pass");
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
    expect(result.payload.success).toBe(true);
    expect(result.payload.completionSummary).toContain("visibility guard");
  });

  it("detects failure indicators", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — build failed on CI",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.success).toBe(false);
  });

  it("extracts PR URL from Done body", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — https://github.com/jinwon-int/openclaw/pull/52 merged",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.prUrl).toBe("https://github.com/jinwon-int/openclaw/pull/52");
    expect(result.payload.success).toBe(true);
  });

  it("handles Done with no body", () => {
    const result = parseWorkerStatusMarker("**Done**", "worker-alpha", "51") as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.success).toBe(true);
    expect(result.payload.outcome).toBeUndefined();
  });

  it("classifies done_with_changes when PR URL is present", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — https://github.com/jinwon-int/openclaw/pull/52 merged",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.success).toBe(true);
    expect(result.payload.outcome).toBe("done_with_changes");
  });

  it("classifies done_evidence_only from explicit signal", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — evidence-only, no code changes. Start comment posted.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.success).toBe(true);
    expect(result.payload.outcome).toBe("done_evidence_only");
  });

  it("classifies done_evidence_only from block evidence signal", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — block evidence surfaced, no PR needed.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.outcome).toBe("done_evidence_only");
  });

  it("classifies done_no_changes from explicit signal", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — assessment complete, no changes needed.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.success).toBe(true);
    expect(result.payload.outcome).toBe("done_no_changes");
  });

  it("classifies done_no_changes from nothing to change signal", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — nothing to change, code is already compliant.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.outcome).toBe("done_no_changes");
  });

  it("does not set outcome when no signals are present and no PR URL", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — task completed successfully.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.outcome).toBeUndefined();
  });

  it("evidence-only overrides PR URL presence", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — evidence-only, no code changes. PR: https://github.com/jinwon-int/openclaw/pull/52",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.outcome).toBe("done_evidence_only");
    expect(result.payload.prUrl).toBe("https://github.com/jinwon-int/openclaw/pull/52");
  });
  it("sets readOnly=true for done_evidence_only outcome", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — evidence-only, no code changes. Assessment complete.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.readOnly).toBe(true);
    expect(result.payload.outcome).toBe("done_evidence_only");
  });

  it("sets readOnly=true for done_no_changes outcome", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — assessment complete, no changes needed.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.readOnly).toBe(true);
    expect(result.payload.outcome).toBe("done_no_changes");
  });

  it("readOnly is undefined for done_with_changes outcome", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — https://github.com/jinwon-int/openclaw/pull/52 merged",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.outcome).toBe("done_with_changes");
    expect(result.payload.readOnly).toBeUndefined();
  });

  it("readOnly is undefined when no outcome is classified", () => {
    const result = parseWorkerStatusMarker(
      "**Done** — task completed.",
      "worker-alpha",
      "51",
    ) as WorkerStatusEvent;
    if (result.marker !== "Done") throw new Error("wrong marker");
    expect(result.payload.outcome).toBeUndefined();
    expect(result.payload.readOnly).toBeUndefined();
  });
});

// ── Error handling ─────────────────────────────────────────────

describe("error handling", () => {
  it("returns error for empty text", () => {
    const result = parseWorkerStatusMarker("", "worker-alpha", "51");
    expect(result).toEqual({
      ok: false,
      error: "text must be a non-empty string",
      rawText: "",
    });
  });

  it("returns error for no marker", () => {
    const result = parseWorkerStatusMarker("Regular text", "worker-alpha", "51");
    expect(result).toEqual({
      ok: false,
      error: "no recognized worker status marker found in text",
      rawText: "Regular text",
    });
  });

  it("returns error for missing workerId", () => {
    const result = parseWorkerStatusMarker("**Start**", "", "51");
    expect(result).toEqual({
      ok: false,
      error: "workerId must be a non-empty string",
      rawText: "**Start**",
    });
  });

  it("returns error for missing taskId", () => {
    const result = parseWorkerStatusMarker("**Start**", "worker-alpha", "");
    expect(result).toEqual({
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
    expect(broker.type).toBe("worker-status");
    expect(broker.marker).toBe("Start");
    expect(broker.workerId).toBe("worker-alpha");
    expect(broker.taskId).toBe("84");
    expect(broker.meta.parseStatus).toBe("clean");
  });

  it("preserves warnings in broker event", () => {
    const event = parseWorkerStatusMarker("**PR**", "worker-alpha", "84") as WorkerStatusEvent;
    const broker = toBrokerEvent(event);
    expect(broker.meta.warnings).toContain("PR marker has no PR URL");
  });
});

// ── batchParse ─────────────────────────────────────────────────

describe("batchParseWorkerStatusMarkers", () => {
  it("parses multiple valid markers", () => {
    const { events, errors } = batchParseWorkerStatusMarkers([
      { text: "**Start** — work", workerId: "worker-alpha", taskId: "84" },
      { text: "**Done** — done", workerId: "worker-alpha", taskId: "84" },
    ]);
    expect(events).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it("collects errors without failing the batch", () => {
    const { events, errors } = batchParseWorkerStatusMarkers([
      { text: "**Start** — work", workerId: "worker-alpha", taskId: "84" },
      { text: "no marker here", workerId: "worker-alpha", taskId: "84" },
      { text: "**Done**", workerId: "", taskId: "84" },
    ]);
    expect(events).toHaveLength(1);
    expect(errors).toHaveLength(2);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectPayloadMode,
  normalizeA2APayload,
  validatePayloadCompatibility,
  PayloadNormalizerErrorCodes,
  type NormalizedA2APayload,
} from "../dist/src/payload-normalizer.js";

// ── Fixtures ───────────────────────────────────────────────────

function makeGeneralPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionKey: "hub-session",
    request: {
      method: "a2a.task.request",
      target: {
        sessionKey: "worker-a",
        displayKey: "worker-a",
      },
      task: {
        intent: "delegate",
        instructions: "Investigate latency regression",
      },
      constraints: {
        timeoutSeconds: 60,
        priority: "normal",
      },
    },
    ...overrides,
  };
}

function makeTeamAssignmentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assignmentMode: "fanout",
    targetNodes: ["worker-a", "worker-b"],
    instructions: "Fix the bug",
    requester: {
      sessionKey: "hub-session",
      displayKey: "hub",
    },
    ...overrides,
  };
}

function makeGitHubPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    repository: {
      full_name: "org/repo",
      name: "repo",
    },
    issue: {
      number: 42,
      title: "Bug: crash on startup",
      body: "Steps to reproduce...",
    },
    sender: {
      login: "contributor",
    },
    ...overrides,
  };
}

// ── Round 12 backward compat fixtures ──────────────────────────

const R12_GENERAL_PAYLOADS: Record<string, Record<string, unknown>> = {
  "minimal task request": {
    sessionKey: "hub",
    request: {
      method: "a2a.task.request",
      target: { sessionKey: "worker", displayKey: "worker" },
      task: { intent: "delegate", instructions: "Do the thing" },
    },
  },
  "task request with all fields": {
    sessionKey: "hub",
    request: {
      method: "a2a.task.request",
      taskId: "task-123",
      correlationId: "corr-456",
      parentRunId: "run-789",
      requester: {
        sessionKey: "hub",
        displayKey: "hub-display",
        channel: "telegram",
      },
      target: { sessionKey: "worker", displayKey: "worker" },
      task: {
        intent: "delegate",
        instructions: "Do the thing",
        summary: "A task",
        input: { key: "value" },
      },
      constraints: {
        timeoutSeconds: 30,
        maxPingPongTurns: 2,
        requireFinal: true,
        allowAnnounce: false,
        priority: "high",
      },
    },
  },
  "task request with notify intent": {
    sessionKey: "hub",
    request: {
      method: "a2a.task.request",
      target: { sessionKey: "observer", displayKey: "observer" },
      task: { intent: "notify", instructions: "Status update" },
    },
  },
  "task request with ask intent": {
    sessionKey: "hub",
    request: {
      method: "a2a.task.request",
      target: { sessionKey: "expert", displayKey: "expert" },
      task: { intent: "ask", instructions: "What do you think?" },
    },
  },
};

const R12_TEAM_ASSIGNMENT_PAYLOADS: Record<string, Record<string, unknown>> = {
  "fanout": {
    assignmentMode: "fanout",
    targetNodes: ["node-a", "node-b", "node-c"],
    instructions: "Run diagnostics",
    requester: { sessionKey: "hub" },
  },
  "split": {
    assignmentMode: "split",
    targetNodes: ["worker-1", "worker-2"],
    instructions: "Process the batch",
    requester: { sessionKey: "hub" },
  },
  "review": {
    assignmentMode: "review",
    targetNodes: ["reviewer-a", "reviewer-b"],
    instructions: "Review the PR",
    summary: "PR #123 review",
    requester: { sessionKey: "hub", displayKey: "hub" },
    constraints: { timeoutSeconds: 120 },
  },
  "swarm": {
    assignmentMode: "swarm",
    targetNodes: ["bee-1", "bee-2", "bee-3"],
    instructions: "Collaborate on research",
    requester: { sessionKey: "hub" },
    lanes: ["alpha", "beta"],
    workMode: "shadow",
  },
};

// ── detectPayloadMode ──────────────────────────────────────────

describe("detectPayloadMode", () => {
  it("detects general mode from A2ATaskRequestParams shape", () => {
    assert.equal(detectPayloadMode(makeGeneralPayload()), "general");
  });

  it("detects team-assignment mode from TeamAssignmentInput shape", () => {
    assert.equal(detectPayloadMode(makeTeamAssignmentPayload()), "team-assignment");
  });

  it("detects github mode from webhook event shape", () => {
    assert.equal(detectPayloadMode(makeGitHubPayload()), "github");
  });

  it("detects github mode with only repository + action", () => {
    assert.equal(
      detectPayloadMode({ repository: { name: "repo" }, action: "push" }),
      "github",
    );
  });

  it("detects github mode with repository + sender", () => {
    assert.equal(
      detectPayloadMode({ repository: { name: "repo" }, sender: { login: "user" } }),
      "github",
    );
  });

  it("returns null for unrecognized input", () => {
    assert.equal(detectPayloadMode({ foo: "bar" }), null);
  });

  it("returns null for null input", () => {
    assert.equal(detectPayloadMode(null), null);
  });

  it("returns null for array input", () => {
    assert.equal(detectPayloadMode([1, 2, 3]), null);
  });

  it("returns null for string input", () => {
    assert.equal(detectPayloadMode("hello"), null);
  });

  it("returns null for empty object", () => {
    assert.equal(detectPayloadMode({}), null);
  });
});

// ── normalizeA2APayload: general mode ──────────────────────────

describe("normalizeA2APayload: general mode", () => {
  it("normalizes a valid general-mode payload", () => {
    const result = normalizeA2APayload(makeGeneralPayload());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.intent, "delegate");
      assert.equal(result.instructions, "Investigate latency regression");
      assert.equal(result.target.sessionKey, "worker-a");
      assert.equal(result.metadata.source, "general");
    }
  });

  it("defaults intent to delegate when missing", () => {
    const result = normalizeA2APayload({
      sessionKey: "hub",
      request: {
        target: { sessionKey: "worker", displayKey: "worker" },
        task: { instructions: "Do something" },
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.intent, "delegate");
    }
  });

  it("extracts requester from request.requester when present", () => {
    const result = normalizeA2APayload(makeGeneralPayload({
      request: {
        method: "a2a.task.request",
        target: { sessionKey: "w", displayKey: "w" },
        task: { intent: "delegate", instructions: "hi" },
        requester: { sessionKey: "req-session", displayKey: "req-display", channel: "slack" },
      },
    }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.requester.sessionKey, "req-session");
      assert.equal(result.requester.displayKey, "req-display");
      assert.equal(result.requester.channel, "slack");
    }
  });

  it("falls back to top-level sessionKey for requester", () => {
    const result = normalizeA2APayload({
      sessionKey: "fallback-key",
      request: {
        target: { sessionKey: "w", displayKey: "w" },
        task: { intent: "delegate", instructions: "hi" },
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.requester.sessionKey, "fallback-key");
    }
  });

  it("preserves constraints", () => {
    const result = normalizeA2APayload(makeGeneralPayload());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.constraints?.timeoutSeconds, 60);
      assert.equal(result.constraints?.priority, "normal");
    }
  });

  it("returns MISSING_REQUIRED_FIELD when request is missing", () => {
    const result = normalizeA2APayload({ sessionKey: "hub" }, "general");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "request");
    }
  });

  it("returns MISSING_REQUIRED_FIELD when task is missing", () => {
    const result = normalizeA2APayload({
      sessionKey: "hub",
      request: { target: { sessionKey: "w", displayKey: "w" } },
    }, "general");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "request.task");
    }
  });

  it("returns MISSING_REQUIRED_FIELD when target is missing", () => {
    const result = normalizeA2APayload({
      sessionKey: "hub",
      request: { task: { intent: "delegate", instructions: "hi" } },
    }, "general");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "request.target");
    }
  });

  it("returns MISSING_REQUIRED_FIELD when instructions is missing", () => {
    const result = normalizeA2APayload({
      sessionKey: "hub",
      request: {
        target: { sessionKey: "w", displayKey: "w" },
        task: { intent: "delegate" },
      },
    }, "general");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "request.task.instructions");
    }
  });

  it("ignores unknown optional fields without crashing", () => {
    const result = normalizeA2APayload({
      sessionKey: "hub",
      request: {
        method: "a2a.task.request",
        target: { sessionKey: "w", displayKey: "w" },
        task: { intent: "delegate", instructions: "hi" },
        unknownField: "should be ignored",
        anotherExtra: 42,
      },
      extraTopLevel: true,
    });
    assert.equal(result.ok, true);
  });
});

// ── normalizeA2APayload: team-assignment mode ──────────────────

describe("normalizeA2APayload: team-assignment mode", () => {
  it("normalizes a fanout assignment", () => {
    const result = normalizeA2APayload(makeTeamAssignmentPayload({ assignmentMode: "fanout" }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.intent, "delegate");
      assert.equal(result.target.sessionKey, "worker-a");
      assert.equal(result.metadata.source, "team-assignment");
    }
  });

  it("normalizes a split assignment targeting first node", () => {
    const result = normalizeA2APayload(makeTeamAssignmentPayload({ assignmentMode: "split" }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.target.sessionKey, "worker-a");
    }
  });

  it("normalizes a review assignment with summary and constraints", () => {
    const result = normalizeA2APayload(makeTeamAssignmentPayload({
      assignmentMode: "review",
      summary: "Review task",
      constraints: { timeoutSeconds: 120, priority: "high" },
    }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.summary, "Review task");
      assert.equal(result.constraints?.timeoutSeconds, 120);
      assert.equal(result.constraints?.priority, "high");
    }
  });

  it("normalizes a swarm assignment with lanes and workMode", () => {
    const result = normalizeA2APayload(makeTeamAssignmentPayload({
      assignmentMode: "swarm",
      lanes: ["alpha", "beta"],
      workMode: "shadow",
    }));
    assert.equal(result.ok, true);
  });

  it("returns MISSING_REQUIRED_FIELD when assignmentMode is missing", () => {
    const { assignmentMode: _, ...rest } = makeTeamAssignmentPayload();
    void _;
    const result = normalizeA2APayload(rest, "team-assignment");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "assignmentMode");
    }
  });

  it("returns MISSING_REQUIRED_FIELD when targetNodes is empty", () => {
    const result = normalizeA2APayload(
      makeTeamAssignmentPayload({ targetNodes: [] }),
      "team-assignment",
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "targetNodes");
    }
  });

  it("returns MISSING_REQUIRED_FIELD when instructions is missing", () => {
    const { instructions: _, ...rest } = makeTeamAssignmentPayload();
    void _;
    const result = normalizeA2APayload(rest, "team-assignment");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "instructions");
    }
  });

  it("returns MISSING_REQUIRED_FIELD when requester is missing", () => {
    const { requester: _, ...rest } = makeTeamAssignmentPayload();
    void _;
    const result = normalizeA2APayload(rest, "team-assignment");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "requester");
    }
  });

  it("ignores unknown optional fields without crashing", () => {
    const result = normalizeA2APayload(
      makeTeamAssignmentPayload({ bonus: "extra", metadata: { x: 1 } }),
    );
    assert.equal(result.ok, true);
  });
});

// ── normalizeA2APayload: github mode ───────────────────────────

describe("normalizeA2APayload: github mode", () => {
  it("normalizes an issue opened event", () => {
    const result = normalizeA2APayload(makeGitHubPayload());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.intent, "delegate");
      assert.match(result.instructions, /org\/repo#42/);
      assert.match(result.instructions, /Bug: crash on startup/);
      assert.equal(result.target.sessionKey, "org/repo");
      assert.equal(result.requester.sessionKey, "contributor");
      assert.equal(result.metadata.source, "github");
    }
  });

  it("normalizes a PR event", () => {
    const result = normalizeA2APayload(makeGitHubPayload({
      action: "opened",
      issue: undefined,
      pull_request: { number: 10, title: "Fix tests", body: "Details..." },
    }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.instructions, /Fix tests/);
    }
  });

  it("handles missing issue/PR gracefully", () => {
    const result = normalizeA2APayload({
      action: "push",
      repository: { full_name: "org/repo" },
      sender: { login: "bot" },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.instructions, /push.*org\/repo/);
    }
  });

  it("handles missing sender gracefully", () => {
    const result = normalizeA2APayload({
      action: "push",
      repository: { full_name: "org/repo" },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.requester.sessionKey, "unknown");
    }
  });

  it("returns MISSING_REQUIRED_FIELD when repository is missing", () => {
    const result = normalizeA2APayload({ action: "push" }, "github");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
      assert.equal(result.error.field, "repository");
    }
  });

  it("uses repo name when full_name is unavailable", () => {
    const result = normalizeA2APayload({
      action: "opened",
      repository: { name: "my-repo" },
      issue: { number: 1, title: "Test" },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.target.sessionKey, "my-repo");
    }
  });
});

// ── normalizeA2APayload: edge cases ────────────────────────────

describe("normalizeA2APayload: edge cases", () => {
  it("returns INVALID_PAYLOAD_SHAPE for non-object input", () => {
    const result = normalizeA2APayload("not an object");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.INVALID_PAYLOAD_SHAPE);
    }
  });

  it("returns UNKNOWN_PAYLOAD_MODE for unrecognizable object", () => {
    const result = normalizeA2APayload({ random: "data" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.UNKNOWN_PAYLOAD_MODE);
    }
  });

  it("allows explicit mode override", () => {
    // Force general mode on a shape that doesn't auto-detect
    const result = normalizeA2APayload({
      sessionKey: "hub",
      request: {
        target: { sessionKey: "w", displayKey: "w" },
        task: { instructions: "hi" },
      },
    }, "general");
    assert.equal(result.ok, true);
  });

  it("returns null for array input", () => {
    const result = normalizeA2APayload([1, 2, 3]);
    assert.equal(result.ok, false);
  });

  it("returns null for null input", () => {
    const result = normalizeA2APayload(null);
    assert.equal(result.ok, false);
  });
});

// ── Round 12 backward compatibility ───────────────────────────

describe("Round 12 backward compatibility: general payloads", () => {
  for (const [label, payload] of Object.entries(R12_GENERAL_PAYLOADS)) {
    it(`accepts R12 "${label}" without errors`, () => {
      const result = normalizeA2APayload(payload);
      assert.equal(result.ok, true, `Failed for "${label}": ${!result.ok ? result.error.message : ""}`);
    });

    it(`R12 "${label}" is detected as general mode`, () => {
      const mode = detectPayloadMode(payload);
      assert.equal(mode, "general");
    });

    it(`R12 "${label}" passes compatibility check`, () => {
      const compat = validatePayloadCompatibility(payload);
      assert.equal(compat.compatible, true);
      assert.equal(compat.mode, "general");
    });
  }
});

describe("Round 12 backward compatibility: team assignment payloads", () => {
  for (const [label, payload] of Object.entries(R12_TEAM_ASSIGNMENT_PAYLOADS)) {
    it(`accepts R12 "${label}" without errors`, () => {
      const result = normalizeA2APayload(payload);
      assert.equal(result.ok, true, `Failed for "${label}": ${!result.ok ? result.error.message : ""}`);
    });

    it(`R12 "${label}" is detected as team-assignment mode`, () => {
      const mode = detectPayloadMode(payload);
      assert.equal(mode, "team-assignment");
    });

    it(`R12 "${label}" passes compatibility check`, () => {
      const compat = validatePayloadCompatibility(payload);
      assert.equal(compat.compatible, true);
      assert.equal(compat.mode, "team-assignment");
    });
  }
});

// ── validatePayloadCompatibility ───────────────────────────────

describe("validatePayloadCompatibility", () => {
  it("returns compatible for valid general payload", () => {
    const result = validatePayloadCompatibility(makeGeneralPayload());
    assert.equal(result.compatible, true);
    assert.equal(result.mode, "general");
    assert.equal(result.warnings.length, 0);
  });

  it("returns compatible for valid team-assignment payload", () => {
    const result = validatePayloadCompatibility(makeTeamAssignmentPayload());
    assert.equal(result.compatible, true);
    assert.equal(result.mode, "team-assignment");
  });

  it("returns compatible for valid github payload", () => {
    const result = validatePayloadCompatibility(makeGitHubPayload());
    assert.equal(result.compatible, true);
    assert.equal(result.mode, "github");
  });

  it("returns incompatible for null", () => {
    const result = validatePayloadCompatibility(null);
    assert.equal(result.compatible, false);
    assert.equal(result.mode, null);
  });

  it("returns incompatible for unrecognized shape", () => {
    const result = validatePayloadCompatibility({ foo: 1 });
    assert.equal(result.compatible, false);
    assert.equal(result.mode, null);
  });

  it("reports warnings for unknown fields in team-assignment", () => {
    const result = validatePayloadCompatibility({
      assignmentMode: "fanout",
      targetNodes: ["a"],
      instructions: "test",
      requester: { sessionKey: "hub" },
      unknownField: "extra",
    });
    assert.equal(result.mode, "team-assignment");
    assert.ok(result.warnings.some((w) => w.includes("unknownField")));
  });

  it("reports warnings for general mode with invalid request", () => {
    // When request is not an object, detectPayloadMode returns null
    const result = validatePayloadCompatibility({
      sessionKey: "hub",
      request: "not-an-object",
    });
    assert.equal(result.mode, null);
    assert.equal(result.compatible, false);
    assert.ok(result.warnings.length > 0);
  });
});

// ── Mode-specific fixtures ─────────────────────────────────────

describe("fixtures: fanout payload across modes", () => {
  it("fanout team-assignment normalizes correctly", () => {
    const payload = makeTeamAssignmentPayload({ assignmentMode: "fanout", targetNodes: ["a", "b", "c"] });
    const result = normalizeA2APayload(payload);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.target.sessionKey, "a");
      assert.equal(result.intent, "delegate");
    }
  });

  it("fanout general-mode normalizes correctly", () => {
    const payload = makeGeneralPayload();
    const result = normalizeA2APayload(payload);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.intent, "delegate");
    }
  });
});

describe("fixtures: split payload", () => {
  it("split team-assignment targets first node", () => {
    const payload = makeTeamAssignmentPayload({
      assignmentMode: "split",
      targetNodes: ["node-1", "node-2"],
      instructions: "Split this work",
    });
    const result = normalizeA2APayload(payload);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.target.sessionKey, "node-1");
    }
  });
});

describe("fixtures: review payload", () => {
  it("review team-assignment preserves summary", () => {
    const payload = makeTeamAssignmentPayload({
      assignmentMode: "review",
      summary: "Code review for PR #99",
      constraints: { timeoutSeconds: 120 },
    });
    const result = normalizeA2APayload(payload);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.summary, "Code review for PR #99");
      assert.equal(result.constraints?.timeoutSeconds, 120);
    }
  });
});

describe("fixtures: swarm payload", () => {
  it("swarm team-assignment normalizes", () => {
    const payload = makeTeamAssignmentPayload({
      assignmentMode: "swarm",
      targetNodes: ["bee-1", "bee-2", "bee-3"],
      lanes: ["research", "implementation"],
      workMode: "collaborative",
    });
    const result = normalizeA2APayload(payload);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.target.sessionKey, "bee-1");
    }
  });

  it("swarm with extra fields does not crash", () => {
    const payload = makeTeamAssignmentPayload({
      assignmentMode: "swarm",
      targetNodes: ["a"],
      extraData: { nested: true },
      tags: ["urgent"],
    });
    const result = normalizeA2APayload(payload);
    assert.equal(result.ok, true);
  });
});

describe("normalization gaps (a2a-nexus#575 item 19)", () => {
  it("surfaces dropped extra targetNodes in team-assignment metadata", () => {
    const result = normalizeA2APayload(
      makeTeamAssignmentPayload({ targetNodes: ["worker-a", "worker-b", "worker-c"] }),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.target.sessionKey, "worker-a");
      assert.deepEqual(
        (result.metadata as Record<string, unknown>).droppedTargetNodes,
        ["worker-b", "worker-c"],
        "extra targets must be surfaced, not dropped silently",
      );
    }
  });

  it("rejects a general payload that would emit an empty requester.sessionKey", () => {
    const result = normalizeA2APayload(makeGeneralPayload({ sessionKey: "" }));
    assert.equal(result.ok, false, "empty requester.sessionKey must not be emitted");
    if (!result.ok) {
      assert.equal(result.error.code, PayloadNormalizerErrorCodes.MISSING_REQUIRED_FIELD);
    }
  });
});

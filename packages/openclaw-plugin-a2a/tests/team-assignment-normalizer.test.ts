import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTeamAssignmentRequests,
  detectSecret,
  normalizeTeamAssignment,
  TeamAssignmentErrorCodes,
  validateTeamAssignmentInput,
  type TeamAssignmentInput,
} from "../dist/src/team-assignment-normalizer.js";
import { buildTeamAssignmentRequests as gatewayBuildTeamAssignmentRequests } from "../dist/src/gateway-handlers.js";

const BASE_REQUESTER = {
  sessionKey: "hub-session",
  displayKey: "hub-display",
  channel: "telegram",
};

function baseInput(overrides: Partial<TeamAssignmentInput> = {}): TeamAssignmentInput {
  return {
    assignmentMode: "fanout",
    targetNodes: ["worker-a", "worker-b"],
    instructions: "Investigate the latency regression",
    summary: "latency triage",
    requester: { ...BASE_REQUESTER },
    ...overrides,
  };
}

function payloadHasSecrets(value: unknown): boolean {
  return detectSecret(JSON.stringify(value));
}

describe("validateTeamAssignmentInput", () => {
  it("accepts a clean fanout assignment", () => {
    const result = validateTeamAssignmentInput(baseInput());
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.data.assignmentMode, "fanout");
      assert.deepEqual(result.data.targetNodes, ["worker-a", "worker-b"]);
      assert.equal(result.data.requester.sessionKey, "hub-session");
    }
  });

  it("rejects missing assignmentMode", () => {
    const { assignmentMode: _drop, ...rest } = baseInput();
    void _drop;
    const result = validateTeamAssignmentInput(rest);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_ASSIGNMENT_MODE);
    }
  });

  it("rejects an unknown assignmentMode", () => {
    const result = validateTeamAssignmentInput({ ...baseInput(), assignmentMode: "broadcast" });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_ASSIGNMENT_MODE);
    }
  });

  it("rejects empty targetNodes", () => {
    const result = validateTeamAssignmentInput({ ...baseInput(), targetNodes: [] });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_TARGET_NODES);
    }
  });

  it("rejects targetNodes containing non-string entries", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      targetNodes: ["worker-a", 42 as unknown as string],
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_TARGET_NODES);
    }
  });

  it("rejects targetNodes with whitespace-only entries", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      targetNodes: ["worker-a", "   "],
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_TARGET_NODES);
    }
  });

  it("rejects targetNodes with duplicate entries", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      targetNodes: ["worker-a", "worker-a"],
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_TARGET_NODES);
    }
  });

  it("rejects missing instructions", () => {
    const { instructions: _drop, ...rest } = baseInput();
    void _drop;
    const result = validateTeamAssignmentInput(rest);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_INSTRUCTIONS);
    }
  });

  it("rejects whitespace-only instructions", () => {
    const result = validateTeamAssignmentInput({ ...baseInput(), instructions: "   " });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_INSTRUCTIONS);
    }
  });

  it("rejects missing requester", () => {
    const { requester: _drop, ...rest } = baseInput();
    void _drop;
    const result = validateTeamAssignmentInput(rest);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_REQUESTER);
    }
  });

  it("rejects requester missing sessionKey", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      requester: { displayKey: "hub" } as unknown as TeamAssignmentInput["requester"],
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_REQUESTER);
    }
  });

  it("rejects unknown extra fields on the input (additionalProperties: false spirit)", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      // @ts-expect-error intentionally invalid
      bonus: "should-not-be-allowed",
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE);
    }
  });

  it("rejects unknown fields on requester", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      requester: { ...BASE_REQUESTER, role: "hub" } as unknown as TeamAssignmentInput["requester"],
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_REQUESTER);
    }
  });

  it("rejects payloads containing what looks like an API key in instructions", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      instructions: "Hello team — secret api_key=<REDACTED_AWS_ACCESS_KEY_ID> for you",
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.SECRET_LEAK_DETECTED);
    }
  });

  it("rejects payloads containing GitHub-style tokens in summary", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      summary: "access_token=<REDACTED_GITHUB_TOKEN>",
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.SECRET_LEAK_DETECTED);
    }
  });

  it("rejects payloads with an Authorization: Bearer header in lanes", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      lanes: ["alpha", "Authorization: Bearer abc.def-ghi"],
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.SECRET_LEAK_DETECTED);
    }
  });

  it("preserves constraints and lanes on a valid input", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      constraints: { timeoutSeconds: 60, priority: "high", requireFinal: true },
      lanes: ["alpha", "beta"],
      workMode: "research",
    });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.deepEqual(result.data.constraints, {
        timeoutSeconds: 60,
        priority: "high",
        requireFinal: true,
      });
      assert.deepEqual(result.data.lanes, ["alpha", "beta"]);
      assert.equal(result.data.workMode, "research");
    }
  });

  it("rejects bogus constraints fields", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      constraints: { timeoutSeconds: -1 } as unknown as TeamAssignmentInput["constraints"],
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE);
    }
  });

  it("rejects unknown constraint fields", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      constraints: { surprise: true } as unknown as TeamAssignmentInput["constraints"],
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_INPUT_SHAPE);
    }
  });
});

describe("normalizeTeamAssignment", () => {
  it("fanout: produces one request per target node", () => {
    const { requests } = normalizeTeamAssignment(baseInput());
    assert.equal(requests.length, 2);
    assert.equal(requests[0].request.target.sessionKey, "worker-a");
    assert.equal(requests[1].request.target.sessionKey, "worker-b");
    for (const req of requests) {
      assert.equal(req.request.method, "a2a.task.request");
      assert.equal(req.request.task.intent, "delegate");
      assert.equal(req.sessionKey, "hub-session");
      const taskInput = req.request.task.input as Record<string, unknown> | undefined;
      assert.equal((taskInput ?? {}).assignmentMode, "fanout");
      assert.deepEqual((taskInput ?? {}).assignmentTargets, [req.request.target.sessionKey]);
    }
  });

  it("split: produces a single request listing all targets", () => {
    const { requests } = normalizeTeamAssignment(
      baseInput({ assignmentMode: "split", targetNodes: ["w1", "w2", "w3"] }),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].request.target.sessionKey, "w1");
    const taskInput = requests[0].request.task.input as Record<string, unknown>;
    assert.equal(taskInput.assignmentMode, "split");
    assert.deepEqual(taskInput.assignmentTargets, ["w1", "w2", "w3"]);
  });

  it("review: produces a single review request with all reviewers", () => {
    const { requests } = normalizeTeamAssignment(
      baseInput({ assignmentMode: "review", targetNodes: ["reviewer-1", "reviewer-2"] }),
    );
    assert.equal(requests.length, 1);
    const taskInput = requests[0].request.task.input as Record<string, unknown>;
    assert.equal(taskInput.assignmentMode, "review");
    assert.deepEqual(taskInput.assignmentTargets, ["reviewer-1", "reviewer-2"]);
  });

  it("swarm: produces a single swarm request with all participants", () => {
    const { requests } = normalizeTeamAssignment(
      baseInput({ assignmentMode: "swarm", targetNodes: ["bee-1", "bee-2", "bee-3"] }),
    );
    assert.equal(requests.length, 1);
    const taskInput = requests[0].request.task.input as Record<string, unknown>;
    assert.equal(taskInput.assignmentMode, "swarm");
    assert.deepEqual(taskInput.assignmentTargets, ["bee-1", "bee-2", "bee-3"]);
  });

  it("preserves constraints in the produced request", () => {
    const { requests } = normalizeTeamAssignment(
      baseInput({
        assignmentMode: "split",
        constraints: { timeoutSeconds: 90, maxPingPongTurns: 3, priority: "low" },
      }),
    );
    assert.deepEqual(requests[0].request.constraints, {
      timeoutSeconds: 90,
      maxPingPongTurns: 3,
      priority: "low",
    });
  });

  it("preserves lanes when provided", () => {
    const { requests } = normalizeTeamAssignment(
      baseInput({ assignmentMode: "swarm", lanes: ["alpha", "beta"] }),
    );
    const taskInput = requests[0].request.task.input as Record<string, unknown>;
    assert.deepEqual(taskInput.lanes, ["alpha", "beta"]);
  });

  it("preserves workMode when provided", () => {
    const { requests } = normalizeTeamAssignment(
      baseInput({ assignmentMode: "review", workMode: "shadow" }),
    );
    const taskInput = requests[0].request.task.input as Record<string, unknown>;
    assert.equal(taskInput.workMode, "shadow");
  });

  it("never leaks credentials or secrets in the produced payload for a clean input", () => {
    const { requests } = normalizeTeamAssignment(
      baseInput({
        assignmentMode: "fanout",
        targetNodes: ["w1", "w2"],
        lanes: ["alpha"],
        workMode: "research",
        constraints: { timeoutSeconds: 30, priority: "normal" },
      }),
    );
    for (const req of requests) {
      assert.equal(payloadHasSecrets(req), false);
    }
  });

  it("re-throws when given an invalid TeamAssignmentInput at runtime", () => {
    assert.throws(() => {
      normalizeTeamAssignment({
        ...baseInput(),
        targetNodes: [] as unknown as string[],
      });
    }, /INVALID_TARGET_NODES/);
  });
});

describe("buildTeamAssignmentRequests (normalizer-side)", () => {
  it("returns ok with requests for valid input", () => {
    const result = buildTeamAssignmentRequests(baseInput());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.requests.length, 2);
    }
  });

  it("returns a structured error for invalid input", () => {
    const result = buildTeamAssignmentRequests({ ...baseInput(), assignmentMode: "bogus" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.INVALID_ASSIGNMENT_MODE);
    }
  });
});

describe("buildTeamAssignmentRequests (gateway-handlers wrapper)", () => {
  it("maps valid input to A2ATaskRequestParams[]", () => {
    const result = gatewayBuildTeamAssignmentRequests(baseInput());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.requests.length, 2);
      assert.equal(result.requests[0].request.method, "a2a.task.request");
    }
  });

  it("maps invalid input to an a2aError-shaped INVALID_REQUEST", () => {
    const result = gatewayBuildTeamAssignmentRequests({ ...baseInput(), targetNodes: [] });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "INVALID_REQUEST");
      assert.match(result.error.message, /INVALID_TARGET_NODES/);
    }
  });
});


describe("secret scan covers broker-forwarded requester fields (a2a-nexus#575 item 13)", () => {
  it("rejects a credential smuggled through requester.displayKey", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      requester: { ...BASE_REQUESTER, displayKey: "api_key=super-secret-value" },
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.SECRET_LEAK_DETECTED);
    }
  });

  it("rejects a credential smuggled through requester.channel", () => {
    const result = validateTeamAssignmentInput({
      ...baseInput(),
      requester: { ...BASE_REQUESTER, channel: "access_token=gho_aaaaaaaaaaaaaaaaaaaaaaaaa" },
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.error.code, TeamAssignmentErrorCodes.SECRET_LEAK_DETECTED);
    }
  });
});

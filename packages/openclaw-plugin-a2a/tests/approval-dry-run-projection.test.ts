/**
 * Dry-run approval projection tests (#256).
 *
 * Parent: a2a-plane#197 (internal tracker, private)
 * Run:    a2a-source-dryrun-orchestrator-20260510T133022Z
 *
 * Exercises the dry-run approval/reject-approval packet projection without
 * any live broker calls. All outputs must be evidence (projection), never
 * approval. liveSend must always be false.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  projectApprovalDryRun,
  projectRejectApprovalDryRun,
  type ApprovalDryRunEvidence,
  type ApprovalDryRunResult,
  type ApprovalDryRunError,
} from "../dist/src/approval-dry-run-projection.js";
import type { A2ABrokerAdapterPluginRuntimeConfig } from "../dist/config.js";

// ── Config fixtures ────────────────────────────────────────────────

function configDisabled(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: false,
          config: {},
        },
      },
    },
  };
}

function configNoBaseUrl(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {},
        },
      },
    },
  };
}

function configActiveWithBaseUrl(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      allow: ["a2a-broker-adapter"],
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.internal.example.com",
            requester: {
              id: "operator-main",
              kind: "session",
              role: "hub",
            },
          },
        },
      },
    },
  };
}

function configWithRequester(): A2ABrokerAdapterPluginRuntimeConfig {
  return {
    plugins: {
      allow: ["a2a-broker-adapter"],
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            baseUrl: "https://broker.internal.example.com",
            requester: {
              id: "sogyo-operator",
              kind: "user",
              role: "operator",
              displayName: "Sogyo Operator",
            },
          },
        },
      },
    },
  };
}

// ── Param fixtures ─────────────────────────────────────────────────

function buildValidApprove(taskId = "task-sogyo-1", sessionKey = "session-approve-1") {
  return {
    sessionKey,
    approval: {
      method: "a2a.task.approve" as const,
      taskId,
      reason: "sogyo dry-run approve test",
      approvalId: "approval-abc-123",
    },
  };
}

function buildValidRejectApproval(
  taskId = "task-sogyo-2",
  sessionKey = "session-reject-1",
) {
  return {
    sessionKey,
    approval: {
      method: "a2a.task.reject_approval" as const,
      taskId,
      reason: "sogyo dry-run reject test",
      approvalId: "approval-xyz-789",
      status: "rejected" as const,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("dry-run approval projection (#256)", () => {
  // ── Approve projection ──────────────────────────────────────────

  describe("projectApprovalDryRun", () => {
    it("projects a valid approve packet as evidence (not approval)", () => {
      const params = buildValidApprove();
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, true, "must return ok=true for valid params");
      const evidence = (result as ApprovalDryRunResult).evidence;
      assert.equal(evidence.schema, "a2a.approval.dry-run.evidence");
      assert.equal(evidence.action, "approve");
      assert.equal(evidence.taskId, "task-sogyo-1");

      // Evidence ≠ approval
      assert.equal((result as ApprovalDryRunResult).isApproval, false);
      assert.equal((result as ApprovalDryRunResult).dryRun, true);
      assert.equal((result as ApprovalDryRunResult).liveSend, false);
    });

    it("projected packet shows endpoint, method, body, and headers", () => {
      const params = buildValidApprove("task-256-projection");
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, true);
      const evidence = (result as ApprovalDryRunResult).evidence;
      const packet = evidence.projectedPacket;

      assert.equal(packet.endpoint, "/tasks/task-256-projection/approve");
      assert.equal(packet.method, "POST");
      assert.equal(packet.body.actor.id, "operator-main");
      assert.equal(packet.body.actor.kind, "session");
      assert.equal(packet.body.actor.role, "hub");
      assert.equal(packet.body.reason, "sogyo dry-run approve test");
      assert.equal(packet.body.approvalId, "approval-abc-123");
      assert.ok(packet.headers["content-type"]);
      assert.ok(packet.headers["x-a2a-requester-id"]);
    });

    it("projected packet does NOT contain approvalId when omitted", () => {
      const params = {
        sessionKey: "session-no-approval-id",
        approval: {
          method: "a2a.task.approve" as const,
          taskId: "task-no-approval-id",
          reason: "approve without approvalId",
        },
      };
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl());
      assert.equal(result.ok, true);
      const evidence = (result as ApprovalDryRunResult).evidence;
      assert.equal("approvalId" in evidence.projectedPacket.body, false);
    });

    it("projected packet does NOT contain reason when omitted", () => {
      const params = {
        sessionKey: "session-no-reason",
        approval: {
          method: "a2a.task.approve" as const,
          taskId: "task-no-reason",
        },
      };
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl());
      assert.equal(result.ok, true);
      const evidence = (result as ApprovalDryRunResult).evidence;
      assert.equal("reason" in evidence.projectedPacket.body, false);
    });

    it("uses resolved requester as actor when configured", () => {
      const params = buildValidApprove("task-requester", "session-x");
      const result = projectApprovalDryRun(params, configWithRequester());

      assert.equal(result.ok, true);
      const packet = (result as ApprovalDryRunResult).evidence.projectedPacket;
      assert.equal(packet.body.actor.id, "sogyo-operator");
      assert.equal(packet.body.actor.kind, "user");
      assert.equal(packet.body.actor.role, "operator");
      // displayName from config requester is carried through when present
      // (config resolver currently extracts id/kind/role; displayName passes
      // through when resolvable from the resolved actor shape)
    });

    it("falls back to sessionKey actor when no requester configured", () => {
      const params = buildValidApprove("task-fallback", "fallback-session");
      const result = projectApprovalDryRun(params, configNoBaseUrl());

      assert.equal(result.ok, true);
      const packet = (result as ApprovalDryRunResult).evidence.projectedPacket;
      assert.equal(packet.body.actor.id, "fallback-session");
      assert.equal(packet.body.actor.kind, "session");
      assert.equal(packet.body.actor.role, "hub");
    });

    it("operator status reflects disabled plugin", () => {
      const params = buildValidApprove();
      const result = projectApprovalDryRun(params, configDisabled());

      assert.equal(result.ok, true);
      const status = (result as ApprovalDryRunResult).evidence.operatorStatus;
      assert.equal(status.pluginActive, false);
      assert.equal(status.operatorConfigured, false);
      assert.equal(status.brokerReachable, false);
      assert.ok(
        status.summary.includes("plugin disabled"),
        `summary must mention plugin disabled, got: ${status.summary}`,
      );
    });

    it("operator status reflects missing baseUrl", () => {
      const params = buildValidApprove();
      const result = projectApprovalDryRun(params, configNoBaseUrl());

      assert.equal(result.ok, true);
      const status = (result as ApprovalDryRunResult).evidence.operatorStatus;
      assert.equal(status.pluginActive, true);
      // configNoBaseUrl has enabled=true so explicitlyActivated is true
      assert.equal(status.operatorConfigured, true);
      assert.equal(status.brokerReachable, false);
      assert.ok(
        status.summary.includes("no broker baseUrl"),
        `summary must mention missing baseUrl, got: ${status.summary}`,
      );
      // operatorConfigured is true (plugin enabled) but brokerReachable is
      // false — the dry-run still works because projection never calls out
    });

    it("operator status reflects fully active config", () => {
      const params = buildValidApprove();
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, true);
      const status = (result as ApprovalDryRunResult).evidence.operatorStatus;
      assert.equal(status.pluginActive, true);
      assert.equal(status.operatorConfigured, true);
      assert.equal(status.brokerReachable, true);
      assert.ok(
        status.summary.includes("projected (not sent)"),
        `summary must confirm projected, got: ${status.summary}`,
      );
    });

    it("evidence has runId and projectedAt timestamp", () => {
      const params = buildValidApprove();
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl(), {
        runId: "sogyo-run-001",
      });

      assert.equal(result.ok, true);
      const evidence = (result as ApprovalDryRunResult).evidence;
      assert.equal(evidence.runId, "sogyo-run-001");
      assert.ok(typeof evidence.projectedAt === "number");
      assert.ok(evidence.projectedAt > 0);
    });

    it("rejects invalid approve params (missing taskId)", () => {
      const params = {
        sessionKey: "session-invalid",
        approval: {
          method: "a2a.task.approve",
          // taskId missing
          reason: "this should fail",
        },
      };
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, false);
      const error = (result as ApprovalDryRunError).error;
      assert.equal(error.code, "INVALID_REQUEST");
      assert.ok(error.message.includes("a2a.task.approve"), "error must mention method name");

      // Still dryRun, still not approval
      assert.equal((result as ApprovalDryRunError).isApproval, false);
      assert.equal((result as ApprovalDryRunError).dryRun, true);
      assert.equal((result as ApprovalDryRunError).liveSend, false);
    });

    it("rejects invalid approve params (missing sessionKey)", () => {
      const params = {
        approval: {
          method: "a2a.task.approve",
          taskId: "task-no-session",
        },
      };
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, false);
      const error = (result as ApprovalDryRunError).error;
      assert.equal(error.code, "INVALID_REQUEST");
    });

    it("rejects approve params with empty taskId", () => {
      const params = {
        sessionKey: "session-empty-task",
        approval: {
          method: "a2a.task.approve" as const,
          taskId: "",
          reason: "empty taskId",
        },
      };
      const result = projectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, false);
      const error = (result as ApprovalDryRunError).error;
      assert.equal(error.code, "INVALID_REQUEST");
    });
  });

  // ── Reject-approval projection ──────────────────────────────────

  describe("projectRejectApprovalDryRun", () => {
    it("projects a valid reject-approval packet as evidence (not approval)", () => {
      const params = buildValidRejectApproval();
      const result = projectRejectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, true);
      const evidence = (result as ApprovalDryRunResult).evidence;
      assert.equal(evidence.schema, "a2a.approval.dry-run.evidence");
      assert.equal(evidence.action, "reject_approval");
      assert.equal(evidence.taskId, "task-sogyo-2");

      // Evidence ≠ approval
      assert.equal((result as ApprovalDryRunResult).isApproval, false);
      assert.equal((result as ApprovalDryRunResult).dryRun, true);
      assert.equal((result as ApprovalDryRunResult).liveSend, false);
    });

    it("projected packet includes reject-specific endpoint and status", () => {
      const params = buildValidRejectApproval("task-256-reject");
      const result = projectRejectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, true);
      const evidence = (result as ApprovalDryRunResult).evidence;
      const packet = evidence.projectedPacket;

      assert.equal(packet.endpoint, "/tasks/task-256-reject/reject-approval");
      assert.equal(packet.method, "POST");
      assert.equal(packet.body.actor.id, "operator-main");
      assert.equal(packet.body.reason, "sogyo dry-run reject test");
      assert.equal(packet.body.approvalId, "approval-xyz-789");
      assert.equal(packet.body.status, "rejected");
    });

    it("projected packet includes status when set", () => {
      for (const status of ["rejected", "expired", "canceled"] as const) {
        const params = {
          sessionKey: "session-reject-status",
          approval: {
            method: "a2a.task.reject_approval" as const,
            taskId: `task-reject-${status}`,
            status,
          },
        };
        const result = projectRejectApprovalDryRun(params, configActiveWithBaseUrl());
        assert.equal(result.ok, true);
        const packet = (result as ApprovalDryRunResult).evidence.projectedPacket;
        assert.equal(packet.body.status, status);
      }
    });

    it("projected packet omits optional fields when not provided", () => {
      const params = {
        sessionKey: "session-minimal",
        approval: {
          method: "a2a.task.reject_approval" as const,
          taskId: "task-minimal-reject",
        },
      };
      const result = projectRejectApprovalDryRun(params, configActiveWithBaseUrl());
      assert.equal(result.ok, true);
      const packet = (result as ApprovalDryRunResult).evidence.projectedPacket;
      assert.equal("reason" in packet.body, false);
      assert.equal("approvalId" in packet.body, false);
      assert.equal("status" in packet.body, false);
    });

    it("rejects invalid reject-approval params (missing taskId)", () => {
      const params = {
        sessionKey: "session-invalid-reject",
        approval: {
          method: "a2a.task.reject_approval",
          reason: "no taskId",
        },
      };
      const result = projectRejectApprovalDryRun(params, configActiveWithBaseUrl());

      assert.equal(result.ok, false);
      const error = (result as ApprovalDryRunError).error;
      assert.equal(error.code, "INVALID_REQUEST");
      assert.ok(error.message.includes("a2a.task.reject_approval"));

      assert.equal((result as ApprovalDryRunError).isApproval, false);
      assert.equal((result as ApprovalDryRunError).dryRun, true);
      assert.equal((result as ApprovalDryRunError).liveSend, false);
    });

    it("rejects reject-approval params with empty sessionKey", () => {
      const params = {
        sessionKey: "",
        approval: {
          method: "a2a.task.reject_approval" as const,
          taskId: "task-reject-no-session",
        },
      };
      const result = projectRejectApprovalDryRun(params, configActiveWithBaseUrl());
      assert.equal(result.ok, false);
    });
  });

  // ── Evidence ≠ Approval boundary ───────────────────────────────

  describe("evidence ≠ approval boundary", () => {
    it("every successful result has isApproval=false", () => {
      const approveResult = projectApprovalDryRun(
        buildValidApprove(),
        configActiveWithBaseUrl(),
      );
      assert.equal(approveResult.ok, true);
      assert.equal((approveResult as ApprovalDryRunResult).isApproval, false);

      const rejectResult = projectRejectApprovalDryRun(
        buildValidRejectApproval(),
        configActiveWithBaseUrl(),
      );
      assert.equal(rejectResult.ok, true);
      assert.equal((rejectResult as ApprovalDryRunResult).isApproval, false);
    });

    it("every error result has isApproval=false", () => {
      const badParams = { sessionKey: "", approval: { method: "a2a.task.approve" } };
      const result = projectApprovalDryRun(badParams, configActiveWithBaseUrl());
      assert.equal(result.ok, false);
      assert.equal((result as ApprovalDryRunError).isApproval, false);
    });

    it("every result has dryRun=true and liveSend=false", () => {
      const approveResult = projectApprovalDryRun(
        buildValidApprove(),
        configActiveWithBaseUrl(),
      );
      assert.equal((approveResult as ApprovalDryRunResult).dryRun, true);
      assert.equal((approveResult as ApprovalDryRunResult).liveSend, false);

      const rejectResult = projectRejectApprovalDryRun(
        buildValidRejectApproval(),
        configActiveWithBaseUrl(),
      );
      assert.equal((rejectResult as ApprovalDryRunResult).dryRun, true);
      assert.equal((rejectResult as ApprovalDryRunResult).liveSend, false);
    });

    it("evidence packet body does not allow mutation into approval", () => {
      // Projections are structural snapshots. The evidence type explicitly
      // carries `projectedPacket` (not `approval` or `request`), and the
      // top-level result carries `isApproval: false`. Nothing in the
      // module ever calls fetch(), so no broker mutation is possible.
      const result = projectApprovalDryRun(buildValidApprove(), configActiveWithBaseUrl());
      assert.equal(result.ok, true);
      const evidence = (result as ApprovalDryRunResult).evidence;

      // projectedPacket is inside evidence, never surfaced as "approval"
      assert.ok("projectedPacket" in evidence);
      assert.equal("approval" in evidence, false);
      assert.equal("request" in evidence, false);
    });
  });

  // ── No-live-send boundary ─────────────────────────────────────

  describe("no live send boundary", () => {
    it("projectApprovalDryRun never requires a baseUrl to produce evidence", () => {
      // Even with no baseUrl, the projection works — it just reports
      // brokerReachable=false in operatorStatus. No fetch is ever attempted.
      const params = buildValidApprove();
      const result = projectApprovalDryRun(params, configNoBaseUrl());

      assert.equal(result.ok, true);
      assert.equal((result as ApprovalDryRunResult).liveSend, false);
    });

    it("projectRejectApprovalDryRun never requires a baseUrl to produce evidence", () => {
      const params = buildValidRejectApproval();
      const result = projectRejectApprovalDryRun(params, configNoBaseUrl());

      assert.equal(result.ok, true);
      assert.equal((result as ApprovalDryRunResult).liveSend, false);
    });

    it("projection never makes any broker HTTP call regardless of config", () => {
      // The module imports nothing that would establish an HTTP connection.
      // It uses resolveA2ABrokerAdapterPluginConfig (pure config read) and
      // validator functions (pure validation). No fetch(), no createClient().
      //
      // Verify by projecting against a fully-active config:
      const result = projectApprovalDryRun(
        buildValidApprove("task-no-fetch"),
        configActiveWithBaseUrl(),
      );
      assert.equal(result.ok, true);
      assert.equal((result as ApprovalDryRunResult).liveSend, false);
      assert.equal((result as ApprovalDryRunResult).dryRun, true);

      // evidence contains a projectedPacket showing what WOULD be sent,
      // but was NOT sent
      const evidence = (result as ApprovalDryRunResult).evidence;
      assert.equal(evidence.projectedPacket.endpoint.includes("/approve"), true);
    });
  });

  // ── Operator status completeness ──────────────────────────────

  describe("operator status completeness", () => {
    it("operatorStatus has all required fields", () => {
      const result = projectApprovalDryRun(buildValidApprove(), configActiveWithBaseUrl());
      assert.equal(result.ok, true);
      const status = (result as ApprovalDryRunResult).evidence.operatorStatus;

      assert.equal(typeof status.operatorConfigured, "boolean");
      assert.equal(typeof status.brokerReachable, "boolean");
      assert.equal(typeof status.pluginActive, "boolean");
      assert.equal(typeof status.summary, "string");
      assert.ok(status.summary.length > 0);
    });

    it("operatorStatus differs by config state", () => {
      const disabled = projectApprovalDryRun(buildValidApprove(), configDisabled());
      const noUrl = projectApprovalDryRun(buildValidApprove(), configNoBaseUrl());
      const active = projectApprovalDryRun(buildValidApprove(), configActiveWithBaseUrl());

      const sDisabled = (disabled as ApprovalDryRunResult).evidence.operatorStatus;
      const sNoUrl = (noUrl as ApprovalDryRunResult).evidence.operatorStatus;
      const sActive = (active as ApprovalDryRunResult).evidence.operatorStatus;

      // Each config state produces a distinct summary
      assert.notEqual(sDisabled.summary, sNoUrl.summary);
      assert.notEqual(sDisabled.summary, sActive.summary);
      assert.notEqual(sNoUrl.summary, sActive.summary);
    });
  });

  // ── Non-ACK semantics preserved ───────────────────────────────

  describe("accepted-send non-ACK semantics preserved", () => {
    it("evidence packet is never treated as ACK-eligible approval", () => {
      // The module treats everything as projection. There is no path
      // where a projection result could be confused with a real approval
      // because:
      // 1. isApproval is always false
      // 2. dryRun is always true
      // 3. liveSend is always false
      // 4. The key is "projectedPacket", not "approval" or "ack"

      const result = projectApprovalDryRun(buildValidApprove(), configActiveWithBaseUrl());
      assert.equal(result.ok, true);

      const typed = result as ApprovalDryRunResult;
      assert.equal(typed.isApproval, false);
      assert.equal(typed.dryRun, true);
      assert.equal(typed.liveSend, false);
    });

    it("reject-approval evidence likewise preserves non-ACK", () => {
      const result = projectRejectApprovalDryRun(
        buildValidRejectApproval(),
        configActiveWithBaseUrl(),
      );
      assert.equal(result.ok, true);

      const typed = result as ApprovalDryRunResult;
      assert.equal(typed.isApproval, false);
      assert.equal(typed.dryRun, true);
      assert.equal(typed.liveSend, false);
    });
  });

  // ── Round-trip: approve + reject in same harness ───────────────

  describe("round-trip: approve and reject-approval in same harness", () => {
    it("produces distinct evidence packets for approve and reject", () => {
      const approveResult = projectApprovalDryRun(
        buildValidApprove("task-roundtrip"),
        configActiveWithBaseUrl(),
      );
      const rejectResult = projectRejectApprovalDryRun(
        buildValidRejectApproval("task-roundtrip"),
        configActiveWithBaseUrl(),
      );

      assert.equal(approveResult.ok, true);
      assert.equal(rejectResult.ok, true);

      const approveEv = (approveResult as ApprovalDryRunResult).evidence;
      const rejectEv = (rejectResult as ApprovalDryRunResult).evidence;

      assert.equal(approveEv.action, "approve");
      assert.equal(rejectEv.action, "reject_approval");

      assert.ok(approveEv.projectedPacket.endpoint.includes("/approve"));
      assert.ok(rejectEv.projectedPacket.endpoint.includes("/reject-approval"));

      // Both are evidence, neither is approval
      assert.equal((approveResult as ApprovalDryRunResult).isApproval, false);
      assert.equal((rejectResult as ApprovalDryRunResult).isApproval, false);
    });

    it("both projections share the same safety invariants", () => {
      const results = [
        projectApprovalDryRun(buildValidApprove(), configActiveWithBaseUrl()),
        projectRejectApprovalDryRun(buildValidRejectApproval(), configActiveWithBaseUrl()),
        projectApprovalDryRun(buildValidApprove(), configDisabled()),
        projectRejectApprovalDryRun(buildValidRejectApproval(), configDisabled()),
        projectApprovalDryRun(buildValidApprove(), configNoBaseUrl()),
        projectRejectApprovalDryRun(buildValidRejectApproval(), configNoBaseUrl()),
      ];

      for (const result of results) {
        assert.equal(result.liveSend, false, "liveSend must always be false");
        assert.equal(result.dryRun, true, "dryRun must always be true");
        assert.equal(result.isApproval, false, "isApproval must always be false");
      }
    });
  });
});

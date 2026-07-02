import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLiberoValidationReadiness,
  LIBERO_CLOSURE_CRITERIA,
  LIBERO_FORBIDDEN_ACTIONS,
  LIBERO_NO_GO_TRAPS,
  LIBERO_REGRESSION_GATES,
  LIBERO_REQUIRED_AREAS,
  renderLiberoClosureCriteriaMarkdown,
  renderLiberoNoGoTrapsMarkdown,
  renderLiberoValidationMatrixMarkdown,
  type LiberoEvidenceInput,
} from "./libero-validation-matrix.js";

// workerdelta (synthesis-risk-libero, a2ad-1032-reused-socket-v2-20260601T2120KST):
// These tests validate the #1032 reused-socket RCA libero validation matrix
// alongside the existing #497/#294 matrices.

test("libero validation matrix covers every #497/#294 and #1032 required area", () => {
  for (const area of LIBERO_REQUIRED_AREAS) {
    assert.ok(
      LIBERO_REGRESSION_GATES.some((gate) => gate.area === area),
      `missing libero validation gate for ${area}`,
    );
  }
});

test("libero validation gates stay no-live and include explicit NO-GO conditions", () => {
  for (const gate of LIBERO_REGRESSION_GATES) {
    assert.equal(gate.noLiveOnly, true, `${gate.id} must stay no-live`);
    assert.match(gate.sourceIssue, /^#(497|294|497\/#294|1032|497\/#294\/#1032)$/);
    assert.match(gate.requiredProof, /test|matrix|canary|preflight|evidence|snapshot|diagnostics/i);
    assert.match(gate.noGoIf, /ACK|OOM|unbounded|live|mutation|secret|OpenClaw|provider|raw DB|Done|queuing|attributable|rollback|timing|schedz/i);
  }
});

test("libero closure criteria cover #497, #294, #1032, and cross-issue evidence hygiene", () => {
  assert.ok(LIBERO_CLOSURE_CRITERIA.some((item) => item.sourceIssue === "#497"));
  assert.ok(LIBERO_CLOSURE_CRITERIA.some((item) => item.sourceIssue === "#294"));
  assert.ok(LIBERO_CLOSURE_CRITERIA.some((item) => item.sourceIssue === "#497/#294"));
  assert.ok(LIBERO_CLOSURE_CRITERIA.some((item) => item.sourceIssue === "#1032"), "missing #1032 closure criteria");

  const joined = LIBERO_CLOSURE_CRITERIA.map((item) => `${item.criterion} ${item.requiredEvidence} ${item.closesWhen}`).join("\n");
  assert.match(joined, /Hot-table persistence/);
  assert.match(joined, /provider accepted\/sent never implies ACK/);
  assert.match(joined, /providerCalled=false/);
  assert.match(joined, /AGENTS\/SOUL\/USER\/TOOLS\/HEARTBEAT\/IDENTITY\/\.openclaw/);

  // #1032 reused-socket RCA criteria (workerdelta)
  assert.match(joined, /Attributable stall evidence/);
  assert.match(joined, /pre-handler queuing|queuing/);
  assert.match(joined, /cgroup CPU throttling/);
  assert.match(joined, /Deploy gate and rollback boundaries/);
});

test("libero no-go traps fail closed on receipt, OOM, cleanup, replay, evidence leaks, and reused-socket RCA", () => {
  const trapsByArea = new Map(LIBERO_NO_GO_TRAPS.map((trap) => [trap.area, trap]));

  assert.match(trapsByArea.get("receipt_semantics")?.failClosedResponse ?? "", /do not ACK/);
  assert.match(trapsByArea.get("hot_table_memory")?.trap ?? "", /NODE_OPTIONS/);
  assert.match(trapsByArea.get("terminal_outbox_hygiene")?.failClosedResponse ?? "", /separate DB cleanup\/ACK approval/);
  assert.match(trapsByArea.get("replay_canary")?.trap ?? "", /live provider send/);
  assert.match(trapsByArea.get("evidence_hygiene")?.failClosedResponse ?? "", /repo-relative offending paths/);

  // #1032 reused-socket RCA traps (workerdelta)
  // Note: trapsByArea uses area as key, so for areas with multiple traps (scheduling_attribution)
  // it returns the last registration. Use LIBERO_NO_GO_TRAPS.find for specific traps.
  const t6 = LIBERO_NO_GO_TRAPS.find((t) => t.id === "T6");
  assert.match(t6?.trap ?? "", /timing.window.*evidence|correlating/);
  const t7 = LIBERO_NO_GO_TRAPS.find((t) => t.id === "T7");
  assert.match(t7?.trap ?? "", /accept-queue depth|cgroup CPU/);
  const t9 = LIBERO_NO_GO_TRAPS.find((t) => t.id === "T9");
  assert.match(t9?.trap ?? "", /keep-alive/);
  assert.match(trapsByArea.get("connection_tracking_diagnostics")?.trap ?? "", /async I\/O|DB reads|unbounded memory/);
  const t7Response = LIBERO_NO_GO_TRAPS.find((t) => t.id === "T7");
  assert.match(t7Response?.failClosedResponse ?? "", /correlation matrix/);
});

test("libero validation fails closed until all evidence areas (including #1032) pass", () => {
  const partial: LiberoEvidenceInput[] = [
    { area: "hot_table_memory", status: "pass", evidenceUrl: "https://example.invalid/497-hot-table" },
    { area: "retention_hygiene", status: "pass", evidenceUrl: "https://example.invalid/497-retention" },
    { area: "terminal_outbox_hygiene", status: "blocked", note: "read-only outbox snapshot unavailable" },
    { area: "receipt_semantics", status: "pass", evidenceUrl: "https://example.invalid/294-receipt" },
    { area: "reused_socket_rca", status: "pass", evidenceUrl: "https://example.invalid/1032-socket-rca" },
  ];

  const result = evaluateLiberoValidationReadiness(partial);

  assert.equal(result.decision, "no-go");
  assert.deepEqual(result.blockedAreas, ["terminal_outbox_hygiene"]);
  assert.ok(result.missingAreas.includes("replay_canary"));
  assert.ok(result.missingAreas.includes("observability_readiness"));
  assert.ok(result.missingAreas.includes("evidence_hygiene"));
  assert.ok(result.missingAreas.includes("scheduling_attribution"), "missing scheduling_attribution area");
  assert.ok(result.missingAreas.includes("connection_tracking_diagnostics"), "missing connection_tracking_diagnostics area");
});

test("libero validation remains NO-GO if any forbidden live action is reported", () => {
  const passingEvidence = LIBERO_REQUIRED_AREAS.map((area) => ({ area, status: "pass" as const }));

  for (const action of LIBERO_FORBIDDEN_ACTIONS) {
    const result = evaluateLiberoValidationReadiness(passingEvidence, { [action]: true });
    assert.equal(result.decision, "no-go", `${action} must block the lane`);
    assert.deepEqual(result.forbiddenActions, [action]);
  }
});

test("libero validation goes green only with complete clean no-live evidence", () => {
  const result = evaluateLiberoValidationReadiness(
    LIBERO_REQUIRED_AREAS.map((area) => ({ area, status: "pass" })),
    {
      productionDeploy: false,
      gatewayRestart: false,
      liveProviderSend: false,
      terminalAck: false,
      dbMutation: false,
      secretChange: false,
      release: false,
      forcePush: false,
    },
  );

  assert.equal(result.decision, "go");
  assert.deepEqual(result.missingAreas, []);
  assert.deepEqual(result.blockedAreas, []);
  assert.deepEqual(result.warningAreas, []);
  assert.deepEqual(result.forbiddenActions, []);
});

test("rendered libero matrix names hot-table, terminal ACK, evidence hygiene blockers, and #1032 reused-socket RCA gates", () => {
  const markdown = renderLiberoValidationMatrixMarkdown();

  assert.match(markdown, /#497/);
  assert.match(markdown, /#294/);
  assert.match(markdown, /hot-table\/OOM risk/);
  assert.match(markdown, /Terminal outbox unacked backlog/);
  assert.match(markdown, /Provider send acceptance is never treated as operator-visible receipt/);
  assert.match(markdown, /OpenClaw runtime\/bootstrap context files/);

  // #1032 reused-socket RCA gates (workerdelta)
  assert.match(markdown, /#1032/);
  assert.match(markdown, /reused_socket_rca/);
  assert.match(markdown, /scheduling_attribution/);
  assert.match(markdown, /connection_tracking_diagnostics/);
  assert.match(markdown, /per-request timing|keep-alive reuse|socket lifecycle/);
  assert.match(markdown, /Rollback boundary/);
  assert.doesNotMatch(markdown, /token|secret value|password|file:\/\//i);
});

test("rendered closure criteria and no-go trap tables expose closeout blockers including #1032", () => {
  const criteria = renderLiberoClosureCriteriaMarkdown();
  const traps = renderLiberoNoGoTrapsMarkdown();

  assert.match(criteria, /Closure criterion/);
  assert.match(criteria, /full-history heap residency/);
  assert.match(criteria, /duplicate provider sends/);

  // #1032 closure criteria (workerdelta)
  assert.match(criteria, /pre-handler queuing|handler delay/);
  assert.match(criteria, /cgroup CPU throttling/);
  assert.match(criteria, /Attributable stall evidence/);
  assert.match(criteria, /rollback boundaries/);

  assert.match(traps, /NO-GO trap/);
  assert.match(traps, /operator-visible receipt/);
  assert.match(traps, /Fail closed before PR creation/);

  // #1032 no-go traps (workerdelta)
  assert.match(traps, /reused_socket_rca/);
  assert.match(traps, /scheduling_attribution/);
  assert.match(traps, /connection_tracking_diagnostics/);
  assert.match(traps, /keep-alive/);
  assert.match(traps, /async I\/O|DB reads|unbounded memory/);

  assert.doesNotMatch(`${criteria}\n${traps}`, /secret value|password|file:\/\//i);
});

// #1032 reused-socket RCA specific tests (workerdelta, synthesis-risk-libero)

test("libero #1032 closure criteria include reused-socket stall attribution, accept-queue separation, host-scheduling exclusion, and deploy gate boundaries", () => {
  const joined = LIBERO_CLOSURE_CRITERIA
    .filter((item) => item.sourceIssue === "#1032")
    .map((item) => `${item.id} ${item.criterion} ${item.requiredEvidence} ${item.closesWhen}`)
    .join("\n");

  assert.match(joined, /C6/);
  assert.match(joined, /Attributable stall evidence/);
  assert.match(joined, /broker-livez-stall-attribution/);
  assert.match(joined, /2%/);

  assert.match(joined, /C7/);
  assert.match(joined, /pre-handler queuing|queuing/);
  assert.match(joined, /handlerMs/);

  assert.match(joined, /C8/);
  assert.match(joined, /cgroup CPU throttling/);
  assert.match(joined, /nrThrottled/);

  assert.match(joined, /C9/);
  assert.match(joined, /Deploy gate/);
  assert.match(joined, /rollback/);
  assert.match(joined, /D1-D5/);
});

test("libero #1032 no-go traps cover incomplete RCA, accept-queue conflation, liveness-path regression, and missing keep-alive proof", () => {
  const trapsByArea = new Map(LIBERO_NO_GO_TRAPS.map((trap) => [trap.area, trap]));

  assert.ok(trapsByArea.has("reused_socket_rca"), "missing reused_socket_rca trap");
  assert.ok(trapsByArea.has("scheduling_attribution"), "missing scheduling_attribution trap");
  assert.ok(trapsByArea.has("connection_tracking_diagnostics"), "missing connection_tracking_diagnostics trap");

  // T6: incomplete RCA without timing window correlation
  const t6 = LIBERO_NO_GO_TRAPS.find((t) => t.id === "T6");
  assert.match(t6?.trap ?? "", /timing.window.*evidence|correlating/);
  assert.match(t6?.failClosedResponse ?? "", /perRequest timing/);

  // T7: attributing stalls without accept-queue exclusion (workerdelta)
  const t7 = LIBERO_NO_GO_TRAPS.find((t) => t.id === "T7");
  assert.match(t7?.trap ?? "", /handler delay/);
  assert.match(t7?.failClosedResponse ?? "", /correlation matrix/);

  // T8: liveness-path regression trap
  const t8 = LIBERO_NO_GO_TRAPS.find((t) => t.id === "T8");
  assert.match(t8?.trap ?? "", /async I\/O|DB reads|unbounded memory/);

  // T9: closing #1032 without keep-alive test proof (workerdelta)
  const t9 = LIBERO_NO_GO_TRAPS.find((t) => t.id === "T9");
  assert.match(t9?.trap ?? "", /keep-alive/);
  assert.match(t9?.failClosedResponse ?? "", /onReusedConnection increments/);
});

test("libero #1032 regression gates validate socket lifecycle, O(1) attribution, connection tracking, and rollback boundaries", () => {
  const gatesById = new Map(LIBERO_REGRESSION_GATES.filter((g) => g.sourceIssue === "#1032").map((g) => [g.id, g]));

  assert.ok(gatesById.has("L8"), "missing L8 (reused_socket_rca)");
  assert.ok(gatesById.has("L9"), "missing L9 (scheduling_attribution O(1))");
  assert.ok(gatesById.has("L10"), "missing L10 (connection_tracking_diagnostics)");
  assert.ok(gatesById.has("L11"), "missing L11 (rollback boundary)");

  for (const [, gate] of gatesById) {
    assert.equal(gate.noLiveOnly, true);
    assert.match(gate.sourceIssue, /^#1032$/);
  }

  // L8: stall attribution
  const l8 = gatesById.get("L8");
  assert.match(l8?.gate ?? "", />1s loopback/);
  assert.match(l8?.requiredProof ?? "", /socketAcceptedToHttpRequestEventMs/);

  // L9: O(1) attribution safety
  const l9 = gatesById.get("L9");
  assert.match(l9?.gate ?? "", /async I\/O|O\(N\) scans/);
  assert.match(l9?.noGoIf ?? "", /2ms no-go/);

  // L10: connection tracking correctness
  const l10 = gatesById.get("L10");
  assert.match(l10?.gate ?? "", /totalConnections|activeConnections/);
  assert.match(l10?.requiredProof ?? "", /keep-alive reuse/);

  // L11: rollback boundary
  const l11 = gatesById.get("L11");
  assert.match(l11?.gate ?? "", /Rollback boundary/);
  assert.match(l11?.requiredProof ?? "", /R[15]|R1.*R5/);
  assert.match(l11?.noGoIf ?? "", /cleanly reverted/);
});

test("libero #1032 evidence input blocks the lane if reused_socket_rca is missing", () => {
  const partial: LiberoEvidenceInput[] = [
    { area: "hot_table_memory", status: "pass" },
    { area: "retention_hygiene", status: "pass" },
    { area: "terminal_outbox_hygiene", status: "pass" },
    { area: "receipt_semantics", status: "pass" },
    { area: "replay_canary", status: "pass" },
    { area: "observability_readiness", status: "pass" },
    { area: "evidence_hygiene", status: "pass" },
    // Missing: reused_socket_rca, scheduling_attribution, connection_tracking_diagnostics
  ];

  const result = evaluateLiberoValidationReadiness(partial);

  assert.equal(result.decision, "no-go");
  assert.ok(result.missingAreas.includes("reused_socket_rca"));
  assert.ok(result.missingAreas.includes("scheduling_attribution"));
  assert.ok(result.missingAreas.includes("connection_tracking_diagnostics"));
});

test("libero #1032 evidence input passes with all #1032 areas green", () => {
  const allAreas: LiberoEvidenceInput[] = [
    { area: "hot_table_memory", status: "pass" },
    { area: "retention_hygiene", status: "pass" },
    { area: "terminal_outbox_hygiene", status: "pass" },
    { area: "receipt_semantics", status: "pass" },
    { area: "replay_canary", status: "pass" },
    { area: "observability_readiness", status: "pass" },
    { area: "evidence_hygiene", status: "pass" },
    { area: "reused_socket_rca", status: "pass", evidenceUrl: "https://example.invalid/1032-socket-rca" },
    { area: "scheduling_attribution", status: "pass", evidenceUrl: "https://example.invalid/1032-scheduling" },
    { area: "connection_tracking_diagnostics", status: "pass", evidenceUrl: "https://example.invalid/1032-connections" },
  ];

  const result = evaluateLiberoValidationReadiness(allAreas);
  assert.equal(result.decision, "go");
});

test("libero #1032 fails closed if scheduling_attribution is blocked", () => {
  const allAreas: LiberoEvidenceInput[] = [
    { area: "hot_table_memory", status: "pass" },
    { area: "retention_hygiene", status: "pass" },
    { area: "terminal_outbox_hygiene", status: "pass" },
    { area: "receipt_semantics", status: "pass" },
    { area: "replay_canary", status: "pass" },
    { area: "observability_readiness", status: "pass" },
    { area: "evidence_hygiene", status: "pass" },
    { area: "reused_socket_rca", status: "pass" },
    { area: "scheduling_attribution", status: "blocked", note: "/schedz endpoint unreachable in CI" },
    { area: "connection_tracking_diagnostics", status: "pass" },
  ];

  const result = evaluateLiberoValidationReadiness(allAreas);
  assert.equal(result.decision, "no-go");
  assert.deepEqual(result.blockedAreas, ["scheduling_attribution"]);
});

test("libero #1032 rendered gates include socket lifecycle, O(1) proof, connection counters, and rollback", () => {
  const markdown = renderLiberoValidationMatrixMarkdown();

  assert.match(markdown, /L8/);
  assert.match(markdown, /reused_socket_rca/);
  assert.match(markdown, /L9/);
  assert.match(markdown, /O\(1\)|scheduling attribution|no async/);
  assert.match(markdown, /L10/);
  assert.match(markdown, /connection_tracking_diagnostics/);
  assert.match(markdown, /L11/);
  assert.match(markdown, /rollback/);
  assert.match(markdown, /R1-R5/);
  assert.match(markdown, /onReusedConnection/);
});

test("libero #1032 validation matrix includes workerdelta attribution in all dialectic vector elements", () => {
  // workerdelta attribution: the file-level comment in libero-validation-matrix.ts contains
  // workerdelta in the thesis (connection-reuse diagnostics instrument the lifecycle),
  // antithesis (without accept-queue depth the instrumentation is incomplete),
  // and synthesis-risk (extending the matrix with #1032 gates protects liveness safety).
  assert.ok(
    LIBERO_CLOSURE_CRITERIA.filter((c) => c.sourceIssue === "#1032").length >= 4,
    "expected at least 4 #1032 closure criteria (workerdelta)",
  );
  assert.ok(
    LIBERO_NO_GO_TRAPS.filter((t) => t.id === "T6" || t.id === "T7" || t.id === "T8" || t.id === "T9").length === 4,
    "expected 4 #1032 no-go traps (workerdelta)",
  );
  assert.ok(
    LIBERO_REGRESSION_GATES.filter((g) => g.id === "L8" || g.id === "L9" || g.id === "L10" || g.id === "L11").length === 4,
    "expected 4 #1032 regression gates (workerdelta)",
  );
});

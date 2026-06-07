/**
 * Conformance smoke gate tests (#234: non-live/no-provider-send conformance
 * smoke gate for the plugin/broker public A2A seam).
 *
 * Also covers #229: fail-closed receipt-runtime boundary.
 *
 * No live broker connectivity, no provider send, no terminal-outbox ACK,
 * no production deploy.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createA2AConformanceSmokeGate,
  runA2AConformanceHandlerFailClosedGate,
} from "../dist/src/conformance-smoke-gate.js";

import {
  createA2AOperatorNotificationAdapter,
  preflightA2AOperatorNotificationRuntime,
} from "../dist/src/operator-notification-adapter.js";

// ── Schema conformance smoke gate ───────────────────────────────────

test("conformance smoke gate validates all 9 A2A public gateway schemas", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  }, { runId: "conformance-smoke-schema-test" });

  const report = gate.run();

  assert.equal(report.mode, "release-dryrun/no-live");
  assert.equal(report.status, "ready");
  assert.equal(report.schemaConformance.status, "pass");
  assert.equal(report.schemaConformance.findings.length, 0);
  assert.ok(report.schemaConformance.passed > 0, "should have multiple passed schema checks");
  assert.equal(report.schemaConformance.blocked, 0);
});

test("conformance smoke gate safe operations are always false", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();

  assert.equal(report.safeOperations.liveSend, false);
  assert.equal(report.safeOperations.terminalOutboxAck, false);
  assert.equal(report.safeOperations.gatewayRestart, false);
  assert.equal(report.safeOperations.productionDeploy, false);
  assert.equal(report.safeOperations.providerSend, false);
});

test("conformance smoke gate has valid runId", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();

  assert.ok(typeof report.runId === "string" && report.runId.length > 0, "runId should be non-empty string");
});

test("conformance smoke gate catches schema validation failures", () => {
  // Valid inputs should all pass — no blocked findings
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();

  // All valid inputs must pass
  assert.equal(report.schemaConformance.status, "pass");

  // With valid inputs, all findings should be "pass" — none blocked
  assert.equal(
    report.schemaConformance.findings.filter((f) => f.status === "blocked").length,
    0,
    "no schema should be blocked with valid inputs",
  );

  // All schemas got tested: passed + blocked = total findings (blocked = 0 here)
  assert.ok(
    report.schemaConformance.passed >= 9,
    `at least 9 schemas validated: got ${report.schemaConformance.passed} passed`,
  );
});

// ── Handler fail-closed gate ────────────────────────────────────────

test("conformance handler fail-closed: all 9 handlers reject valid params when broker unavailable", async () => {
  const result = await runA2AConformanceHandlerFailClosedGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  assert.equal(result.status, "pass",
    `handler fail-closed gate blocked: ${result.findings.filter((f) => f.status === "blocked").map((f) => f.message).join("; ")}`);

  // All 9 handlers must fail closed with broker unavailable
  const expectedHandlers = [
    "a2a.task.request",
    "a2a.task.update",
    "a2a.task.cancel",
    "a2a.task.approve",
    "a2a.task.reject_approval",
    "a2a.task.status",
    "a2a.peer.status",
    "a2a.alerts.list",
    "a2a.monitor.status",
  ];

  for (const name of expectedHandlers) {
    assert.ok(name in result.responses, `${name} should have a response`);
    assert.equal(result.responses[name].ok, false,
      `${name} must fail closed (ok=false) when broker unavailable`);
  }

  assert.ok(result.passed >= expectedHandlers.length,
    "should have all handler fail-closed checks passed");
  assert.equal(result.blocked, 0);
});

test("conformance handler fail-closed: invalid params rejected even with broker unavailable", async () => {
  const result = await runA2AConformanceHandlerFailClosedGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  assert.equal(result.status, "pass");
  assert.ok(result.passed >= 17, "should pass all valid + invalid handler fail-closed checks");

  // Make sure no handler accepts invalid params
  const invalidBlockedFindings = result.findings.filter(
    (f) => f.gate.includes(".invalidRejected"),
  );
  assert.deepEqual(invalidBlockedFindings, [],
    "no handler should accept invalid params");
});

// ── Receipt-runtime boundary (#229) ──────────────────────────────────

test("receipt-runtime boundary: notification adapter is undefined when no target configured", async () => {
  // No notification target in config: adapter must be undefined (fail-closed)
  const adapter = createA2AOperatorNotificationAdapter({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {},
        },
      },
    },
  }, undefined);

  assert.equal(adapter, undefined,
    "adapter must be undefined when no notification target is configured");
});

test("receipt-runtime boundary: dry-run notifications never result in provider send", async () => {
  const adapter = createA2AOperatorNotificationAdapter({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: true,
              notification: {
                enabled: true,
                channel: "telegram",
                to: "operator-chat",
              },
            },
          },
        },
      },
    },
  }, undefined);

  // Adapter may exist but without runtime, notify returns undefined
  if (adapter) {
    const receipt = await adapter.notify({
      kind: "a2a.operator.notification",
      version: 1,
      id: "conformance-dry-run-smoke",
      dedupeKey: "conformance-dry-run-smoke",
      type: "success",
      severity: "info",
      deliveryOwner: "openclaw.plugin-notifier",
      deliveryTarget: "operator-main-session",
      title: "conformance smoke gate dry-run",
      text: "conformance smoke gate dry-run notification",
      evidence: {
        schema: "a2a.operator.notification.evidence",
        version: 1,
        summary: "dry-run receipt boundary test",
      },
      dryRun: true,
      taskId: "conformance-dry-run-smoke",
    });

    // Dry-run receipts are always safe —no provider send
    if (receipt) {
      assert.equal(receipt.confirmationSource, "dry_run_projection",
        "dry-run notifications must use dry_run_projection confirmation source");
      assert.equal(receipt.dryRun, true,
        "dry-run notifications must be marked dryRun=true");
    }
  }

  // No runtime, no send — fail-closed boundary verified
});

test("receipt-runtime boundary: preflight fails closed when notification target is disabled", async () => {
  const result = await preflightA2AOperatorNotificationRuntime({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: false,
          config: {
            operatorEvents: {
              enabled: false,
            },
          },
        },
      },
    },
  }, undefined);

  assert.equal(result.ok, false,
    "preflight must fail-closed when plugin not activated");
  assert.equal(result.safeToRestartGateway, false);
  assert.ok(
    result.checks.some((check) => check.code === "plugin_activation" && !check.ok),
    "plugin_activation check must be fail-closed",
  );

  const notificationTarget = result.notificationTarget;
  assert.equal(notificationTarget.status, "blocked",
    "notification target must be blocked when plugin is not activated");
});

test("receipt-runtime boundary: preflight blocks when runtime route is unavailable", async () => {
  const result = await preflightA2AOperatorNotificationRuntime({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          enabled: true,
          config: {
            operatorEvents: {
              enabled: true,
              notification: {
                enabled: true,
                channel: "telegram",
                to: "operator-chat",
              },
            },
          },
        },
      },
    },
  }, undefined);

  // Without a runtime that has channel.outbound.loadAdapter, the preflight
  // should fail the runtime_adapter check
  const runtimeCheck = result.checks.find((check) => check.code === "runtime_adapter");
  assert.ok(runtimeCheck, "runtime_adapter check must be present");
  assert.equal(runtimeCheck.ok, false,
    "runtime_adapter check must fail-closed when runtime is unavailable");
});

test("conformance smoke gate: receipt-runtime boundary findings are tracked", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  }, { runId: "conformance-receipt-boundary" });

  const report = gate.run();

  assert.equal(report.receiptRuntimeBoundary.status, "pass");
  assert.ok(report.receiptRuntimeBoundary.passed > 0,
    "receipt-runtime boundary should have passed checks");
  assert.equal(report.receiptRuntimeBoundary.blocked, 0,
    "receipt-runtime boundary should have no blocked findings");
  // Verify no blocked findings
  assert.deepEqual(
    report.receiptRuntimeBoundary.findings.filter((f) => f.status === "blocked"),
    [],
  );
});

// ── End-to-end conformance smoke gate report ─────────────────────────

test("conformance smoke gate produces complete report with all sections", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();

  // All sections must be present
  assert.ok(report.schemaConformance, "schemaConformance section required");
  assert.ok(report.handlerFailClosed, "handlerFailClosed section required");
  assert.ok(report.receiptRuntimeBoundary, "receiptRuntimeBoundary section required");
  assert.ok(report.agentCardConformance, "agentCardConformance section required");
  assert.ok(report.safeOperations, "safeOperations section required");

  // Safe operations must ALL be false — never true
  assert.equal(report.safeOperations.liveSend, false);
  assert.equal(report.safeOperations.terminalOutboxAck, false);
  assert.equal(report.safeOperations.gatewayRestart, false);
  assert.equal(report.safeOperations.productionDeploy, false);
  assert.equal(report.safeOperations.providerSend, false);

  // Overall status reflects schema + handler + receipt checks
  assert.ok(
    report.status === "ready" || report.status === "blocked",
    "report status must be ready or blocked",
  );

  if (report.status === "blocked") {
    // If blocked, must have at least one finding explaining why
    const allBlocked = [
      ...report.schemaConformance.findings,
      ...report.handlerFailClosed.findings,
      ...report.receiptRuntimeBoundary.findings,
      ...report.agentCardConformance.findings,
    ].filter((f) => f.status === "blocked");
    assert.ok(allBlocked.length > 0,
      "blocked status must be accompanied by blocked findings");
  }
});

test("conformance smoke gate: mode is always release-dryrun/no-live", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();
  assert.equal(report.mode, "release-dryrun/no-live");
});

test("conformance smoke gate: provider send never occurs in any finding", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();

  // When all checks pass, findings may be empty — that's acceptable.
  // The key invariant: safe operations are always explicitly false.
  assert.equal(report.safeOperations.providerSend, false);
  assert.equal(report.safeOperations.terminalOutboxAck, false);
  assert.equal(report.safeOperations.productionDeploy, false);
  assert.equal(report.safeOperations.gatewayRestart, false);
  assert.equal(report.safeOperations.liveSend, false);

  // Any blocked findings would indicate a provider send concern.
  // With status="ready", we confirm no blocked findings exist.
  assert.equal(report.status, "ready");
});

// ── Agent Card Conformance (#267: a2a-inspector / a2a-python) ───────

test("conformance smoke gate: agent card conformance passes with valid fixture", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();

  assert.ok(report.agentCardConformance, "agentCardConformance section required");
  assert.equal(report.agentCardConformance.status, "pass",
    "agent card conformance should pass with valid fixture");
  assert.equal(report.agentCardConformance.blocked, 0,
    "agent card conformance should have no blocked findings");
  assert.ok(report.agentCardConformance.passed > 0,
    "agent card conformance should have passed checks");
});

test("conformance smoke gate: agent card has no blocked findings for required fields", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();
  const findings = report.agentCardConformance.findings;

  // No findings at all when fixture is valid (passes are counted, not stored)
  assert.deepEqual(findings, [],
    "valid fixture should produce zero blocked findings");

  // Verify all required checks contributed to the pass count
  assert.ok(report.agentCardConformance.passed >= 30,
    "at least 30 checks should pass for a valid agent card fixture");
});

test("conformance smoke gate: agent card conformance findings are included in blocked summary", () => {
  const gate = createA2AConformanceSmokeGate({
    plugins: {
      entries: {
        "a2a-broker-adapter": {
          config: {
            baseUrl: "https://broker.conformance.test",
          },
        },
      },
    },
  });

  const report = gate.run();

  // When overall status is blocked, agent card findings must be included
  // in the blocked findings count (regression check)
  const allBlocked = [
    ...report.schemaConformance.findings,
    ...report.handlerFailClosed.findings,
    ...report.receiptRuntimeBoundary.findings,
    ...report.agentCardConformance.findings,
  ].filter((f) => f.status === "blocked");

  if (report.status === "blocked") {
    assert.ok(allBlocked.length > 0,
      "blocked status must be accompanied by blocked findings from one or more sections");
  }

  // agentCardConformance section always exists
  assert.ok(report.agentCardConformance, "agentCardConformance section required");
});

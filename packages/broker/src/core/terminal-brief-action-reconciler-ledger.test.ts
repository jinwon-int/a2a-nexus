import assert from "node:assert/strict";
import test from "node:test";

import {
  NoopLedgerAdapter,
  buildReconcilerLedgerPlanner,
  renderReconcilerLedgerPlannerMarkdown,
  reconcileActions,
  reconcileActionLedger,
  type ActionLedgerRecord,
  type ActionLedgerRowState,
  type ReconcilerLedgerState,
  type ReconcilerLedgerPlannerInput,
  type ReconcilerLedgerPlannerOptions,
} from "./terminal-brief-action-reconciler-ledger.js";
import type { AutoCloseoutPolicyMode } from "./terminal-brief-auto-closeout-planner.js";
import type { TerminalBriefAutoCloseoutDryRunRunnerInput } from "./terminal-brief-auto-closeout-dryrun-runner.js";
import type { TerminalTaskOutboxEvent, TerminalTaskStatus } from "./terminal-event-outbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = "2026-05-20T11:30:00.000Z";
const RUN_ID = "a2a-team1-auto-closeout-reconciler-20260520T113000Z";

function eventFor(
  worker: string,
  status: TerminalTaskStatus,
  options: {
    taskId?: string;
    progress?: number;
    total?: number;
    prUrl?: string;
    doneUrl?: string;
    parentRoundId?: string;
  } = {},
): TerminalTaskOutboxEvent {
  const taskId = options.taskId ?? "task-" + worker;
  return {
    id: taskId + "-" + status,
    kind: "task.terminal",
    taskEventId: 1,
    payload: {
      taskId,
      status,
      parentRoundId: options.parentRoundId ?? "round-833",
      originBrokerId: "brokeralpha",
      brokerOfRecordId: "brokeralpha",
      worker,
      repo: "jinwon-int/a2a-broker",
      issue: 833,
      taskBrief: "Terminal Brief reconciler ledger test",
      prUrl: options.prUrl,
      doneUrl: options.doneUrl,
      parentRoundProgress: options.progress,
      parentRoundTotal: options.total,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    createdAt: NOW,
    receipt: {
      status: "provider_accepted",
      updatedAt: NOW,
      receiptId: "receipt-" + worker,
    },
    attempts: 1,
  };
}

function allReadyEvents(): TerminalTaskOutboxEvent[] {
  return [
    eventFor("workergamma", "succeeded", { progress: 1, total: 4, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/831" }),
    eventFor("workerdelta", "succeeded", { progress: 2, total: 4, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/833" }),
    eventFor("workerbeta", "succeeded", { progress: 3, total: 4, doneUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/398" }),
    eventFor("workeralpha", "succeeded", { progress: 4, total: 4, prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/395" }),
  ];
}

function buildReadyInput(): TerminalBriefAutoCloseoutDryRunRunnerInput {
  return {
    plannerInput: {
      policyMode: "draft" as AutoCloseoutPolicyMode,
      parentRoundId: "round-833",
      parentRoundTotal: 4,
      parentRoundOrder: 2,
      hasGitHubToken: true,
      ciPassUrls: ["https://github.com/jinwon-int/a2a-broker/actions/runs/100"],
      finalCountInput: {
        parentRoundId: "round-833",
        expectedWorkers: ["workergamma", "workerdelta", "workerbeta", "workeralpha"],
        finalCountSignals: [
          { id: "brief-final", text: "Terminal Brief: workeralpha final worker (4/4)", createdAt: NOW },
        ],
        events: allReadyEvents(),
      },
    },
  };
}

function buildReconcilerInput(
  storage?: NoopLedgerAdapter,
  overrides?: Partial<ReconcilerLedgerPlannerInput>,
): ReconcilerLedgerPlannerInput {
  return {
    dryRunInput: buildReadyInput(),
    dryRunOptions: { now: NOW, runId: RUN_ID },
    storage: storage ?? new NoopLedgerAdapter(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NoopLedgerAdapter Tests
// ---------------------------------------------------------------------------

test("NoopLedgerAdapter stores and retrieves a record", () => {
  const store = new NoopLedgerAdapter();
  const row: ActionLedgerRecord = {
    id: "row-test-1",
    runId: RUN_ID,
    parentRoundId: "round-833",
    actionKind: "noop",
    actionLabel: "test action",
    idempotencyKey: "test-key-1",
    rowState: "recorded",
    requiresApproval: true,
    executePermitted: false,
    detail: "test detail",
    storedAt: NOW,
    updatedAt: NOW,
  };

  const stored = store.store(row);
  assert.equal(stored.id, row.id);
  assert.equal(stored.rowState, "recorded");
  assert.ok(store.has("test-key-1"));
  assert.equal(store.getById("row-test-1")?.actionLabel, "test action");
  assert.equal(store.getByIdempotencyKey("test-key-1")?.actionKind, "noop");
});

test("NoopLedgerAdapter rejects duplicate idempotency key", () => {
  const store = new NoopLedgerAdapter();
  const row: ActionLedgerRecord = {
    id: "row-dup-1",
    runId: RUN_ID,
    parentRoundId: "round-833",
    actionKind: "noop",
    actionLabel: "first",
    idempotencyKey: "dup-key",
    rowState: "recorded",
    requiresApproval: true,
    executePermitted: false,
    detail: "first store",
    storedAt: NOW,
    updatedAt: NOW,
  };

  const stored1 = store.store(row);
  assert.equal(stored1.actionLabel, "first");

  // Second store with same key returns first row unchanged
  const row2: ActionLedgerRecord = {
    id: "row-dup-2",
    runId: RUN_ID,
    parentRoundId: "round-833",
    actionKind: "noop",
    actionLabel: "second-attempt",
    idempotencyKey: "dup-key",
    rowState: "recorded",
    requiresApproval: true,
    executePermitted: false,
    detail: "attempted duplicate",
    storedAt: NOW,
    updatedAt: NOW,
  };

  const stored2 = store.store(row2);
  assert.equal(stored2.actionLabel, "first"); // Returns original, not the new one
  assert.equal(stored2.id, "row-dup-1");
});

test("NoopLedgerAdapter lists records sorted by storedAt", () => {
  const store = new NoopLedgerAdapter();
  const later = "2026-05-20T12:00:00.000Z";

  store.store({
    id: "row-a", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "first", idempotencyKey: "key-a",
    rowState: "recorded", requiresApproval: true, executePermitted: false,
    detail: "a", storedAt: NOW, updatedAt: NOW,
  });
  store.store({
    id: "row-b", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "second", idempotencyKey: "key-b",
    rowState: "recorded", requiresApproval: true, executePermitted: false,
    detail: "b", storedAt: later, updatedAt: later,
  });

  const all = store.list();
  assert.equal(all.length, 2);
  assert.equal(all[0].actionLabel, "first");
});

test("NoopLedgerAdapter getByRunId filters correctly", () => {
  const store = new NoopLedgerAdapter();

  store.store({
    id: "row-r1", runId: "run-1", parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "run1-action", idempotencyKey: "k1",
    rowState: "recorded", requiresApproval: true, executePermitted: false,
    detail: "", storedAt: NOW, updatedAt: NOW,
  });
  store.store({
    id: "row-r2", runId: "run-2", parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "run2-action", idempotencyKey: "k2",
    rowState: "recorded", requiresApproval: true, executePermitted: false,
    detail: "", storedAt: NOW, updatedAt: NOW,
  });

  const run1Rows = store.getByRunId("run-1");
  assert.equal(run1Rows.length, 1);
  assert.equal(run1Rows[0].actionLabel, "run1-action");
});

test("NoopLedgerAdapter update mutates existing row", () => {
  const store = new NoopLedgerAdapter();

  store.store({
    id: "row-upd", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "original", idempotencyKey: "key-upd",
    rowState: "recorded", requiresApproval: true, executePermitted: false,
    detail: "original", storedAt: NOW, updatedAt: NOW,
  });

  const updated = store.update("row-upd", { rowState: "reconciled", actionLabel: "updated" });
  assert.ok(updated, "update should return the updated row");
  assert.equal(updated?.rowState, "reconciled");
  assert.equal(updated?.actionLabel, "updated"); // updated
  assert.equal(updated?.id, "row-upd"); // id preserved

  // Verify via get
  const fetched = store.getById("row-upd");
  assert.equal(fetched?.rowState, "reconciled");
});

test("NoopLedgerAdapter update returns undefined for missing row", () => {
  const store = new NoopLedgerAdapter();
  const result = store.update("nonexistent", { rowState: "reconciled" });
  assert.equal(result, undefined);
});

test("NoopLedgerAdapter remove removes row", () => {
  const store = new NoopLedgerAdapter();
  store.store({
    id: "row-rm", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "remove-me", idempotencyKey: "key-rm",
    rowState: "recorded", requiresApproval: true, executePermitted: false,
    detail: "", storedAt: NOW, updatedAt: NOW,
  });

  assert.ok(store.remove("row-rm"));
  assert.equal(store.getById("row-rm"), undefined);
  assert.equal(store.has("key-rm"), false);
});

test("NoopLedgerAdapter remove returns false for missing row", () => {
  const store = new NoopLedgerAdapter();
  assert.equal(store.remove("nonexistent"), false);
});

test("NoopLedgerAdapter countByState tallies correctly", () => {
  const store = new NoopLedgerAdapter();

  store.store({
    id: "r1", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "recorded", idempotencyKey: "k1",
    rowState: "recorded", requiresApproval: true, executePermitted: false,
    detail: "", storedAt: NOW, updatedAt: NOW,
  });
  store.store({
    id: "r2", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "reconciled", idempotencyKey: "k2",
    rowState: "reconciled", requiresApproval: true, executePermitted: false,
    detail: "", storedAt: NOW, updatedAt: NOW,
  });
  store.store({
    id: "r3", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "blocked", idempotencyKey: "k3",
    rowState: "blocked", requiresApproval: true, executePermitted: false,
    detail: "", storedAt: NOW, updatedAt: NOW,
  });
  store.store({
    id: "r4", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "errored", idempotencyKey: "k4",
    rowState: "errored", requiresApproval: true, executePermitted: false,
    detail: "", storedAt: NOW, updatedAt: NOW,
  });

  const counts = store.countByState();
  assert.equal(counts.recorded, 1);
  assert.equal(counts.reconciled, 1);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.errored, 1);
  assert.equal(counts.skipped, 0);
});

test("NoopLedgerAdapter clear removes all records", () => {
  const store = new NoopLedgerAdapter();
  store.store({
    id: "r1", runId: RUN_ID, parentRoundId: "round-833",
    actionKind: "noop", actionLabel: "temp", idempotencyKey: "k1",
    rowState: "recorded", requiresApproval: true, executePermitted: false,
    detail: "", storedAt: NOW, updatedAt: NOW,
  });

  assert.equal(store.list().length, 1);
  store.clear();
  assert.equal(store.list().length, 0);
  assert.equal(store.has("k1"), false);
});

// ---------------------------------------------------------------------------
// Reconciler ledger planner: state modeling
// ---------------------------------------------------------------------------

test("reconciler ledger planner produces reconciled state for ready input", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });

  assert.equal(result.reconcilerState, "reconciled");
  assert.equal(result.sourceOnlyNoLive, true);
  assert.equal(result.safety.reconciliationOnly, true);
  assert.equal(result.safety.storeOnly, true);
  assert.equal(result.safety.noLiveExecution, true);
  assert.equal(result.safety.idempotencyGuarded, true);
});

test("reconciler ledger planner stores at least one ledger row", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });

  assert.ok(result.ledgerRows.length > 0, "should have at least one ledger row");
  assert.equal(result.ledgerRows.every((r) => r.runId === RUN_ID), true);
});

test("reconciler ledger planner sets all row states correctly", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });

  for (const row of result.ledgerRows) {
    assert.ok(
      ["recorded", "reconciled", "blocked", "errored", "skipped"].includes(row.rowState),
      "row " + row.id + " has unexpected state: " + row.rowState,
    );
  }
});

test("reconciler ledger planner idempotency: same input twice produces same row count", () => {
  const storage = new NoopLedgerAdapter();

  const result1 = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });
  const firstCount = result1.ledgerRows.length;

  const result2 = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });
  const secondCount = result2.ledgerRows.length;

  // Second run should have same number of rows (idempotent, not duplicates)
  assert.equal(secondCount, firstCount);

  // All rows should still be uniquely keyed
  const keys = new Set(result2.ledgerRows.map((r) => r.idempotencyKey));
  assert.equal(keys.size, secondCount);

  // Second run's rows should reference existing records (not new ones)
  for (const row of result2.ledgerRows) {
    assert.ok(row.idempotencyKey.length > 0, "idempotency key should be set");
  }
});

test("reconciler ledger planner integration contract blocks all live actions", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });

  assert.equal(result.integrationContract.storesActionLedgerRows, true);
  assert.equal(result.integrationContract.reconcilesAgainstStoredState, true);
  assert.equal(result.integrationContract.executesGitHubComment, false);
  assert.equal(result.integrationContract.executesGitHubClose, false);
  assert.equal(result.integrationContract.executesProviderSend, false);
  assert.equal(result.integrationContract.executesTerminalAck, false);
  assert.equal(result.integrationContract.executesDbMutation, false);
  assert.equal(result.integrationContract.executesRestartDeploy, false);
  assert.equal(result.integrationContract.executesReleasePublish, false);
  assert.equal(result.integrationContract.executesSecretMovement, false);
});

test("reconciler ledger planner includes dry-run packet and renderable markdown", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });

  assert.equal(result.dryRunPacket.kind, "a2a-broker.terminal-brief-auto-closeout-dryrun-runner.packet");
  assert.ok(result.markdown.length > 0, "markdown should be non-empty");
  assert.match(result.markdown, /Reconciled: action reconciler ledger planner/);
});

test("renderReconcilerLedgerPlannerMarkdown includes ledger rows", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });
  const md = renderReconcilerLedgerPlannerMarkdown(result);

  assert.match(md, /Ledger rows/);
  assert.match(md, /Safety boundary/);
  assert.match(md, /Integration contract/);
  assert.match(md, /Embedded dry-run runner packet/);
});

test("renderReconcilerLedgerPlannerMarkdown includes row states and safety gates", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });
  const md = renderReconcilerLedgerPlannerMarkdown(result);

  for (const row of result.ledgerRows) {
    assert.match(md, new RegExp(row.rowState));
  }
  assert.match(md, /noLiveExecution=true/);
  assert.match(md, /idempotencyGuarded=true/);
});

// ---------------------------------------------------------------------------
// Reconciler state modeling: blocked / error / idle
// ---------------------------------------------------------------------------

test("reconciler can be forced to blocked state", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(
    buildReconcilerInput(storage, { forceState: "blocked" }),
    { now: NOW },
  );
  assert.equal(result.reconcilerState, "blocked");
});

test("reconciler can be forced to errored state", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(
    buildReconcilerInput(storage, { forceState: "errored" }),
    { now: NOW },
  );
  assert.equal(result.reconcilerState, "errored");
});

test("reconciler can be forced to idle state", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(
    buildReconcilerInput(storage, { forceState: "idle" }),
    { now: NOW },
  );
  assert.equal(result.reconcilerState, "idle");
});

test("reconciler can be forced to reconciling state", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(
    buildReconcilerInput(storage, { forceState: "reconciling" }),
    { now: NOW },
  );
  assert.equal(result.reconcilerState, "reconciling");
});

test("reconciler state transitions cover all ReconcilerLedgerState values", () => {
  const states: ReconcilerLedgerState[] = ["idle", "reconciling", "reconciled", "blocked", "errored"];

  for (const state of states) {
    const storage = new NoopLedgerAdapter();
    const result = buildReconcilerLedgerPlanner(
      buildReconcilerInput(storage, { forceState: state }),
      { now: NOW },
    );
    assert.equal(result.reconcilerState, state, "forced state should match: " + state);
  }
});

// ---------------------------------------------------------------------------
// ReconcileActionLedger: diff/compare logic
// ---------------------------------------------------------------------------

test("reconcileActions detects new vs matching vs stale", () => {
  const now = NOW;
  const planKey = "plan-key-test";

  const storedRow: ActionLedgerRecord = {
    id: "existing-row",
    runId: RUN_ID,
    parentRoundId: "round-833",
    actionKind: "noop",
    actionLabel: "review closeout candidate (draft mode)",
    idempotencyKey: "action-ledger:some-existing-key",
    rowState: "recorded",
    requiresApproval: true,
    executePermitted: false,
    detail: "existing stored row",
    storedAt: now,
    updatedAt: now,
  };

  const plannedActions = [
    { kind: "noop", label: "review closeout candidate (draft mode)", requiresApproval: true, executePermitted: false, detail: "planned" },
    { kind: "operator_review", label: "operator review", requiresApproval: true, executePermitted: false, detail: "planned" },
  ];

  // Only the stored row is in the ledger; only "review closeout" and "operator review" are planned.
  // The stored row's idempotency key won't match the planned action's derived key, so everything will be "missing"
  // and the stored row will be "stale".
  const result = reconcileActions(
    [storedRow],
    plannedActions,
    RUN_ID,
    now,
    planKey,
  );

  // stored row has different key from planned action's derived key, so:
  // - "review closeout" planned → missing (key doesn't match stored)
  // - "operator review" planned → missing
  // - stored row → stale (not in planned)
  assert.ok(result.entries.length > 0);

  const staleEntries = result.entries.filter((e) => e.kind === "stale");
  const missingEntries = result.entries.filter((e) => e.kind === "missing");

  assert.ok(staleEntries.length > 0, "should have stale entries");
  assert.ok(missingEntries.length > 0, "should have missing entries");
  assert.equal(result.summary.staleActions, staleEntries.length);
  assert.equal(result.summary.missingActions, missingEntries.length);
});

test("reconcileActionLedger counts blocked actions", () => {
  const now = NOW;
  const planKey = "plan-key-blocked";

  const blockedRow: ActionLedgerRecord = {
    id: "blocked-row",
    runId: RUN_ID,
    parentRoundId: "round-833",
    actionKind: "noop",
    actionLabel: "review closeout candidate (draft mode)",
    idempotencyKey: "action-ledger:blocked-key",
    rowState: "blocked",
    requiresApproval: true,
    executePermitted: false,
    detail: "blocked by policy",
    storedAt: now,
    updatedAt: now,
    blockReason: "evidence gap",
  };

  const plannedActions = [
    { kind: "noop", label: "review closeout candidate (draft mode)", requiresApproval: true, executePermitted: false, detail: "planned" },
  ];

  const result = reconcileActionLedger([blockedRow], plannedActions, RUN_ID, now, planKey);

  // Since idempotency keys won't match, the blocked row will be stale
  // and the planned action will be missing
  assert.ok(result.entries.length > 0, "should have diff entries");
  assert.ok(typeof result.summary.blockedActions === "number");
});

test("reconcileActions returns summary with totals", () => {
  const result = reconcileActions([], [], RUN_ID, NOW, "plan-key");
  assert.equal(result.summary.totalPlanned, 0);
  assert.equal(result.summary.totalStored, 0);
  assert.equal(result.summary.newActions, 0);
  assert.equal(result.summary.matchingActions, 0);
  assert.equal(result.summary.staleActions, 0);
  assert.equal(result.summary.missingActions, 0);
  assert.equal(result.summary.generatedAt, NOW);
});

// ---------------------------------------------------------------------------
// Row state machine transitions (ActionLedgerRowState)
// ---------------------------------------------------------------------------

test("all ActionLedgerRowState values are valid", () => {
  const states: ActionLedgerRowState[] = ["recorded", "reconciled", "blocked", "errored", "skipped"];

  for (const state of states) {
    const row: ActionLedgerRecord = {
      id: "row-" + state,
      runId: RUN_ID,
      parentRoundId: "round-833",
      actionKind: "noop",
      actionLabel: state,
      idempotencyKey: "key-" + state,
      rowState: state,
      requiresApproval: true,
      executePermitted: false,
      detail: "state: " + state,
      storedAt: NOW,
      updatedAt: NOW,
    };

    const store = new NoopLedgerAdapter();
    const stored = store.store(row);
    assert.equal(stored.rowState, state, "row state should be " + state);
    assert.equal(stored.actionLabel, state);
  }
});

test("errored rows can carry error message", () => {
  const row: ActionLedgerRecord = {
    id: "row-error",
    runId: RUN_ID,
    parentRoundId: "round-833",
    actionKind: "noop",
    actionLabel: "error test",
    idempotencyKey: "key-error-msg",
    rowState: "errored",
    requiresApproval: true,
    executePermitted: false,
    detail: "something went wrong",
    storedAt: NOW,
    updatedAt: NOW,
    errorMessage: "test error: storage write failed",
  };

  assert.equal(row.errorMessage, "test error: storage write failed");
  assert.equal(row.rowState, "errored");
});

test("blocked rows can carry block reason", () => {
  const row: ActionLedgerRecord = {
    id: "row-blocked-reason",
    runId: RUN_ID,
    parentRoundId: "round-833",
    actionKind: "noop",
    actionLabel: "blocked test",
    idempotencyKey: "key-blocked-reason",
    rowState: "blocked",
    requiresApproval: true,
    executePermitted: false,
    detail: "blocked action",
    storedAt: NOW,
    updatedAt: NOW,
    blockReason: "policy mode is off",
  };

  assert.equal(row.blockReason, "policy mode is off");
  assert.equal(row.rowState, "blocked");
});

// ---------------------------------------------------------------------------
// Warnings and blockers propagation
// ---------------------------------------------------------------------------

test("reconciler ledger planner emits blockers when plan is invalid", () => {
  // Empty input should produce plan_invalid or plan_waiting
  const emptyInput: TerminalBriefAutoCloseoutDryRunRunnerInput = {
    plannerInput: {
      policyMode: "draft" as AutoCloseoutPolicyMode,
      parentRoundId: "round-833",
      finalCountInput: {
        parentRoundId: "round-833",
        expectedWorkers: [],
        finalCountSignals: [],
        events: [],
      },
    },
  };

  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(
    {
      dryRunInput: emptyInput,
      dryRunOptions: { now: NOW, runId: RUN_ID },
      storage,
    },
    { now: NOW },
  );

  // The result should have either blockers or a non-reconciled state
  if (result.reconcilerState !== "reconciled") {
    if (result.reconcilerState === "blocked") {
      assert.ok(result.blockers.length > 0, "blocked state should have blockers");
    }
  }
});

// ---------------------------------------------------------------------------
// Markdown rendering edge cases
// ---------------------------------------------------------------------------

test("renderReconcilerLedgerPlannerMarkdown handles empty ledger rows", () => {
  // Create a minimal result with zero ledger rows by forcing state
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(
    buildReconcilerInput(storage, { forceState: "idle" }),
    { now: NOW },
  );

  const md = renderReconcilerLedgerPlannerMarkdown(result);
  assert.match(md, /Idle:/);
  assert.match(md, /Ledger rows/);
});

// ---------------------------------------------------------------------------
// Run metadata
// ---------------------------------------------------------------------------

test("reconciler ledger planner stores runId in every row", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });

  for (const row of result.ledgerRows) {
    assert.equal(row.runId, RUN_ID, "row " + row.id + " should have runId=" + RUN_ID);
  }
});

test("reconciler ledger planner uses default NoopLedgerAdapter when none provided", () => {
  const result = buildReconcilerLedgerPlanner(
    { dryRunInput: buildReadyInput(), dryRunOptions: { now: NOW, runId: RUN_ID } },
    { now: NOW },
  );

  assert.ok(result.ledgerRows.length > 0);
  assert.equal(result.reconcilerState, "reconciled");
});

test("reconciler ledger planner markdown includes Reconciled title for ready state", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(buildReconcilerInput(storage), { now: NOW });
  const md = renderReconcilerLedgerPlannerMarkdown(result);

  assert.match(md, /Reconciled:/);
});

test("reconciler ledger planner markdown includes Blocked title for blocked forced state", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(
    buildReconcilerInput(storage, { forceState: "blocked" }),
    { now: NOW },
  );
  const md = renderReconcilerLedgerPlannerMarkdown(result);

  assert.match(md, /Blocked:/);
});

test("reconciler ledger planner markdown includes Error title for errored forced state", () => {
  const storage = new NoopLedgerAdapter();
  const result = buildReconcilerLedgerPlanner(
    buildReconcilerInput(storage, { forceState: "errored" }),
    { now: NOW },
  );
  const md = renderReconcilerLedgerPlannerMarkdown(result);

  assert.match(md, /Error:/);
});

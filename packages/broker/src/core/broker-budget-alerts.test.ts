/**
 * Budget alerts (#2499 slice 4, docs/specs/goal-budget "Alerts and read
 * surfaces"): `budget_warn` (warning, at `warnPct`) and `budget_exhausted`
 * (critical) are AlertKinds with a `budget` subject `${budgetId}:${periodKey}`,
 * so the alert id `${kind}:${budgetId}:${periodKey}` opens once per budget
 * and period through the existing OperatorAlertDiffer. Exhausted supersedes
 * warn. The stale-reaper sweep evaluates and caches the set
 * (evaluateBudgetAlerts); the alert projection only reads the cache.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { mock } from "node:test";

import { buildAlertScan } from "../http/dashboard-response.js";
import { OperatorAlertDiffer } from "../operator-alert-differ.js";
import { createInMemoryStateStore, readSseEventsUntil, startTestServer } from "../server-test-helpers.js";
import { InMemoryA2ABroker } from "./broker.js";
import { projectAlerts, projectBudgetAlert, type Alert } from "./observability/alert-projection.js";
import { SqliteBrokerStateStore } from "./store/store.js";
import type { BudgetRecord, CreateBudgetRequest, SpendEventRecord } from "./types.js";

type Mode = "off" | "shadow" | "on";

interface Harness {
  broker: InMemoryA2ABroker;
  store: SqliteBrokerStateStore;
  sql(statement: string): void;
  reopen(mode?: Mode): void;
  close(): void;
}

function quiet<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

function harness(mode: Mode = "off"): Harness {
  const dir = mkdtempSync(join(tmpdir(), "a2a-budget-alerts-"));
  const dbFile = join(dir, "state.sqlite");
  const open = (openMode: Mode) => {
    const store = new SqliteBrokerStateStore(dbFile, { loadSource: "hot-tables" });
    const broker = quiet(() => new InMemoryA2ABroker(store, store.load(), { budgetPeriodTimeZone: "UTC", budgetEnforcementMode: openMode }));
    return { store, broker };
  };
  let current = open(mode);
  let currentMode = mode;
  return {
    get broker() {
      return current.broker;
    },
    get store() {
      return current.store;
    },
    sql(statement) {
      const db = new DatabaseSync(dbFile);
      try {
        db.exec(statement);
      } finally {
        db.close();
      }
    },
    reopen(openMode = currentMode) {
      current.store.close();
      currentMode = openMode;
      current = open(openMode);
    },
    close() {
      current.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function budget(h: Harness, request: Omit<CreateBudgetRequest, "period" | "createdBy">): void {
  h.broker.createBudget({ period: "month", createdBy: "operator-1", ...request } as CreateBudgetRequest);
}

let rowSeq = 0;
function spend(h: Harness, overrides: Partial<SpendEventRecord>): void {
  rowSeq += 1;
  h.store.saveHotEntities({
    spendEvents: [{
      taskId: `r-${rowSeq}`,
      recordedAt: new Date().toISOString(),
      periodKey: h.broker.budgetPeriodKey(),
      agentId: "worker-a",
      lane: "analyze",
      goalId: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      costKnown: false,
      ...overrides,
    }],
  });
}

function sweep(h: Harness): { evaluated: number; failed: number; changed: boolean } | undefined {
  return quiet(() => h.broker.evaluateBudgetAlerts());
}

function ids(h: Harness): string[] {
  return h.broker.getBudgetAlerts().map((alert) => alert.id);
}

function nextPeriod(periodKey: string): string {
  const [year, month] = periodKey.split("-").map(Number) as [number, number];
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

test("budget_warn opens at warnPct with a budget subject and content-free, bigint-safe metadata", () => {
  const h = harness("off");
  try {
    budget(h, { id: "b-lane", scopeType: "lane", scopeId: "analyze", limitTokens: 100, limitUsd: 10 });
    spend(h, { inputTokens: 79 });
    sweep(h);
    assert.deepEqual(ids(h), [], "below warnPct (80) there is no alert");
    spend(h, { inputTokens: 1 });
    assert.equal(sweep(h)?.changed, true);
    const period = h.broker.budgetPeriodKey();
    const [alert] = h.broker.getBudgetAlerts();
    assert.ok(alert);
    assert.equal(alert.id, `budget_warn:b-lane:${period}`);
    assert.equal(alert.kind, "budget_warn");
    assert.equal(alert.severity, "warning");
    assert.deepEqual(alert.subject, { kind: "budget", id: `b-lane:${period}` });
    assert.deepEqual(alert.metadata, {
      budgetId: "b-lane",
      scopeType: "lane",
      scopeId: "analyze",
      period: "month",
      periodKey: period,
      limits: ["tokens"],
      usdSpent: 0,
      limitUsd: 10,
      tokensSpent: 80,
      limitTokens: 100,
      warnPct: 80,
      enforce: "refuse",
      configuredMode: "off",
      effectiveMode: "off",
    });
    assert.equal(typeof JSON.stringify(alert), "string");
  } finally {
    h.close();
  }
});

test("budget_exhausted opens and the warn alert resolves (only one of the two per budget and period)", () => {
  const h = harness("off");
  try {
    budget(h, { id: "b-1", scopeType: "agent", scopeId: "worker-a", limitTokens: 100 });
    const differ = new OperatorAlertDiffer([]);
    const scan = () => projectAlerts([], { budgetAlerts: h.broker.getBudgetAlerts() }).alerts;
    spend(h, { inputTokens: 85 });
    sweep(h);
    const period = h.broker.budgetPeriodKey();
    assert.deepEqual(differ.apply(scan()).opened.map((alert) => alert.id), [`budget_warn:b-1:${period}`]);
    spend(h, { inputTokens: 15 });
    sweep(h);
    const step = differ.apply(scan());
    assert.deepEqual(step.opened.map((alert) => [alert.id, alert.severity]), [[`budget_exhausted:b-1:${period}`, "critical"]]);
    assert.deepEqual(step.resolved.map((alert) => alert.id), [`budget_warn:b-1:${period}`]);
    assert.deepEqual(ids(h), [`budget_exhausted:b-1:${period}`], "exhausted supersedes warn");
    assert.deepEqual(h.broker.getBudgetAlerts()[0]?.metadata.limits, ["tokens"]);
  } finally {
    h.close();
  }
});

test("no duplicate within a period: repeated sweeps and a restart do not re-open; detectedAt stays the first detection", () => {
  const h = harness("off");
  try {
    budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitUsd: 1 });
    spend(h, { costUsd: 2, costKnown: true });
    sweep(h);
    const differ = new OperatorAlertDiffer([]);
    const scan = () => buildAlertScan({ broker: h.broker, workerHeartbeatMissedAfterMs: 60_000 }).alerts;
    assert.equal(differ.apply(scan()).opened.length, 1);
    const firstDetectedAt = h.broker.getBudgetAlerts()[0]!.detectedAt;
    for (let index = 0; index < 3; index += 1) {
      assert.equal(sweep(h)?.changed, false);
      assert.deepEqual(differ.apply(scan()), { opened: [], resolved: [] });
    }
    assert.equal(h.broker.getBudgetAlerts()[0]!.detectedAt, firstDetectedAt);
    // Restart: the broker computes the set at startup, before the server
    // seeds its differ from the first scan, so nothing re-opens.
    h.reopen();
    const restarted = new OperatorAlertDiffer(scan());
    assert.equal(h.broker.getBudgetAlerts().length, 1, "computed at startup");
    sweep(h);
    assert.deepEqual(restarted.apply(scan()), { opened: [], resolved: [] });
  } finally {
    h.close();
  }
});

test("raising the limit resolves the alert on the next sweep (changed budgets are evaluated first)", () => {
  const h = harness("off");
  try {
    for (let index = 0; index < 5; index += 1) {
      budget(h, { id: `b-${index}`, scopeType: "lane", scopeId: `lane-${index}`, limitTokens: 10 });
      spend(h, { lane: `lane-${index}`, inputTokens: 20 });
    }
    quiet(() => h.broker.evaluateBudgetAlerts({ all: true }));
    assert.equal(ids(h).length, 5);
    const differ = new OperatorAlertDiffer(h.broker.getBudgetAlerts());
    h.broker.updateBudget("b-4", { limitTokens: 1_000, actorId: "operator-1" });
    // A bound of 1 still reaches b-4 first: it was written since its last evaluation.
    assert.equal(quiet(() => h.broker.evaluateBudgetAlerts({ limit: 1 }))?.evaluated, 1);
    const step = differ.apply(h.broker.getBudgetAlerts());
    assert.deepEqual(step.resolved.map((alert) => alert.id), [`budget_exhausted:b-4:${h.broker.budgetPeriodKey()}`]);
    assert.deepEqual(step.opened, []);
    // Clearing one limit while the other stays below warn resolves too.
    h.broker.updateBudget("b-3", { limitTokens: null, limitUsd: 5, actorId: "operator-1" });
    sweep(h);
    assert.equal(ids(h).some((id) => id.includes(":b-3:")), false);
  } finally {
    h.close();
  }
});

test("round-robin bound: at most `limit` budgets per sweep, the rest keep their previous result, the cursor wraps", () => {
  const h = harness("off");
  try {
    for (let index = 0; index < 5; index += 1) {
      budget(h, { id: `b-${index}`, scopeType: "lane", scopeId: `lane-${index}`, limitTokens: 10 });
      spend(h, { lane: `lane-${index}`, inputTokens: 20 });
    }
    // New budgets are dirty: evaluated first, two per sweep.
    const counts: number[] = [];
    for (let index = 0; index < 3; index += 1) counts.push(quiet(() => h.broker.evaluateBudgetAlerts({ limit: 2 }))!.evaluated);
    assert.deepEqual(counts, [2, 2, 2], "the third sweep: b-4 (dirty) plus one round-robin budget");
    assert.equal(ids(h).length, 5);
    // Round-robin only: the cursor (after b-0) continues with b-1, b-2; then b-3, b-4; then wraps.
    const seen: string[][] = [];
    const usage = mock.method(h.store, "readSpendScopeUsage");
    try {
      for (let index = 0; index < 3; index += 1) {
        const from = usage.mock.callCount();
        quiet(() => h.broker.evaluateBudgetAlerts({ limit: 2 }));
        seen.push(usage.mock.calls.slice(from).map((call) => (call.arguments[0] as { scopeId: string }).scopeId));
      }
    } finally {
      usage.mock.restore();
    }
    assert.deepEqual(seen, [["lane-1", "lane-2"], ["lane-3", "lane-4"], ["lane-0", "lane-1"]]);
    const reads = mock.method(h.store, "readSpendScopeUsage");
    try {
      quiet(() => h.broker.evaluateBudgetAlerts({ limit: 2 }));
      assert.equal(reads.mock.callCount(), 2, "the cursor wrapped to the start");
    } finally {
      reads.mock.restore();
    }
  } finally {
    h.close();
  }
});

test("the period roll resolves the alert (new id) and a new-period alert can open", () => {
  const h = harness("off");
  try {
    budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitTokens: 10 });
    spend(h, { inputTokens: 20 });
    sweep(h);
    const period = h.broker.budgetPeriodKey();
    const differ = new OperatorAlertDiffer(h.broker.getBudgetAlerts());
    const next = nextPeriod(period);
    const rolled = mock.method(h.broker, "budgetPeriodKey", () => next);
    try {
      assert.deepEqual(ids(h), [], "an entry from the earlier period is not served");
      assert.deepEqual(differ.apply(h.broker.getBudgetAlerts()).resolved.map((alert) => alert.id), [`budget_exhausted:b-1:${period}`]);
      sweep(h);
      assert.deepEqual(ids(h), [], "the new period has no spend");
      spend(h, { inputTokens: 9, periodKey: next });
      sweep(h);
      assert.deepEqual(differ.apply(h.broker.getBudgetAlerts()).opened.map((alert) => alert.id), [`budget_warn:b-1:${next}`]);
    } finally {
      rolled.mock.restore();
    }
  } finally {
    h.close();
  }
});

for (const mode of ["off", "shadow", "on"] as const) {
  test(`alerts are projected in mode ${mode} (visibility only) and carry the configured and effective mode`, () => {
    const h = harness(mode);
    try {
      h.sql("UPDATE broker_metadata SET value = '2000-01' WHERE key = 'spend_ledger_first_period'");
      budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitTokens: 10 });
      spend(h, { inputTokens: 20 });
      sweep(h);
      const [alert] = h.broker.getBudgetAlerts();
      assert.equal(alert?.kind, "budget_exhausted");
      assert.equal(alert?.metadata.configuredMode, mode);
      assert.equal(alert?.metadata.effectiveMode, mode);
    } finally {
      h.close();
    }
  });
}

test("on while the period is incomplete reports effective shadow; off reads no enforcement metadata", () => {
  const h = harness("on");
  try {
    budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitTokens: 10 });
    spend(h, { inputTokens: 20 });
    sweep(h);
    assert.equal(h.broker.getBudgetAlerts()[0]?.metadata.effectiveMode, "shadow");
  } finally {
    h.close();
  }
  const off = harness("off");
  try {
    budget(off, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitTokens: 10 });
    const metadata = mock.method(off.store, "readSpendLedgerMetadata");
    try {
      sweep(off);
      assert.equal(metadata.mock.callCount(), 0);
    } finally {
      metadata.mock.restore();
    }
  } finally {
    off.close();
  }
});

test("a failed read keeps the previous alert state and counts in checkFailed (source alert)", () => {
  const h = harness("off");
  try {
    budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitTokens: 10 });
    spend(h, { inputTokens: 20 });
    sweep(h);
    const before = h.broker.getBudgetAlerts();
    const failing = mock.method(h.store, "readSpendScopeUsage", () => {
      throw new Error("disk I/O error");
    });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (line: unknown) => warnings.push(String(line));
    try {
      h.broker.updateBudget("b-1", { limitTokens: 1_000, actorId: "operator-1" });
      assert.deepEqual(h.broker.evaluateBudgetAlerts(), { evaluated: 0, failed: 1, changed: false });
      assert.deepEqual(h.broker.evaluateBudgetAlerts(), { evaluated: 0, failed: 1, changed: false }, "retried on the next sweep (still dirty)");
    } finally {
      console.warn = original;
      failing.mock.restore();
    }
    assert.deepEqual(h.broker.getBudgetAlerts().map((alert) => alert.id), before.map((alert) => alert.id), "no flapping");
    assert.equal(h.broker.getBudgetCheckFailures().count, 2);
    assert.ok(warnings.some((line) => line.includes("\"broker.budget.check_failed\"") && line.includes("\"source\":\"alert\"")));
    sweep(h);
    assert.deepEqual(ids(h), [], "the next successful read applies the raised limit");
    assert.equal(h.broker.getBudgetCheckFailures().consecutive, 0);
  } finally {
    h.close();
  }
});

test("the projection does no store reads: getBudgetAlerts and the alert scan serve the cached set", () => {
  const h = harness("on");
  try {
    budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitTokens: 10 });
    spend(h, { inputTokens: 20 });
    sweep(h);
    const methods = ["readSpendScopeUsage", "readSpendLedgerMetadata", "hasCostReportingSpend", "readBudget", "listBudgets", "readSpendTotals", "listTopSpendRows"] as const;
    const spies = methods.map((name) => mock.method(h.store, name));
    try {
      assert.equal(h.broker.getBudgetAlerts().length, 1);
      const scan = buildAlertScan({ broker: h.broker, workerHeartbeatMissedAfterMs: 60_000 });
      assert.equal(scan.countsByKind.budget_exhausted, 1);
      assert.deepEqual(spies.map((spy) => spy.mock.callCount()), methods.map(() => 0));
    } finally {
      for (const spy of spies) spy.mock.restore();
    }
  } finally {
    h.close();
  }
});

test("nothing without budgets or without a spend ledger", () => {
  const h = harness("off");
  try {
    const reads = mock.method(h.store, "readSpendLedgerMetadata");
    try {
      assert.deepEqual(h.broker.evaluateBudgetAlerts(), { evaluated: 0, failed: 0, changed: false });
      assert.equal(reads.mock.callCount(), 0);
    } finally {
      reads.mock.restore();
    }
  } finally {
    h.close();
  }
  const memory = new InMemoryA2ABroker(createInMemoryStateStore(), undefined, { budgetPeriodTimeZone: "UTC" });
  assert.equal(memory.evaluateBudgetAlerts(), undefined);
  assert.deepEqual(memory.getBudgetAlerts(), []);
});

test("projectBudgetAlert: bigint token totals project as decimal strings; both limits are named when both cross", () => {
  const record: BudgetRecord = {
    id: "b-big", scopeType: "agent", scopeId: "worker-a", period: "month", limitUsd: 1, limitTokens: Number.MAX_SAFE_INTEGER,
    warnPct: 50, enforce: "pause", createdBy: "o", createdAt: "2026-11-01T00:00:00.000Z",
  };
  const tokensSpent = BigInt(Number.MAX_SAFE_INTEGER) * 2n;
  const alert = projectBudgetAlert({
    evaluation: { budget: record, periodKey: "2026-11", usdSpent: 3, tokensSpent, usdExhausted: true, tokensExhausted: true, warn: true },
    enforcement: { configuredMode: "on", effectiveMode: null },
    detectedAt: "2026-11-07T00:00:00.000Z",
  }) as Alert;
  assert.equal(alert.id, "budget_exhausted:b-big:2026-11");
  assert.equal(alert.metadata.tokensSpent, tokensSpent.toString());
  assert.deepEqual(alert.metadata.limits, ["usd", "tokens"]);
  assert.equal(alert.metadata.effectiveMode, null, "unknown when the metadata read failed");
  assert.doesNotThrow(() => JSON.stringify(alert));
  const below = projectBudgetAlert({
    evaluation: { budget: record, periodKey: "2026-11", usdSpent: 0.4, tokensSpent: 1n, usdExhausted: false, tokensExhausted: false, warn: false },
    enforcement: { configuredMode: "off", effectiveMode: "off" },
    detectedAt: "2026-11-07T00:00:00.000Z",
  });
  assert.equal(below, null);
});

test("GET /alerts and the operator SSE stream carry budget alerts; the sweep publishes opened and resolved", async () => {
  const h = harness("off");
  const server = await startTestServer({
    broker: h.broker,
    stateStore: h.store,
    enforceRequesterIdentity: false,
    budgetPeriodTimeZone: "UTC",
    rateLimitMaxRequests: 1_000,
  });
  const controller = new AbortController();
  try {
    budget(h, { id: "b-1", scopeType: "lane", scopeId: "analyze", limitTokens: 100 });
    const res = await fetch(`${server.baseUrl}/a2a/operator/events`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
    assert.equal(res.status, 200);
    const seen = readSseEventsUntil(
      res,
      (events) => events.some((event) => event.event === "operator-alert-resolved"),
      10_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    spend(h, { inputTokens: 90 });
    quiet(() => server.runtime.runStaleReaperSweep());
    const alerts = await (await fetch(`${server.baseUrl}/alerts`)).json() as { alerts: Alert[]; countsByKind: Record<string, number> };
    const period = h.broker.budgetPeriodKey();
    assert.deepEqual(alerts.alerts.filter((alert) => alert.kind.startsWith("budget_")).map((alert) => alert.id), [`budget_warn:b-1:${period}`]);
    assert.equal(alerts.countsByKind.budget_warn, 1);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const patch = await fetch(`${server.baseUrl}/budgets/b-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-a2a-requester-id": "operator-1", "x-a2a-requester-role": "operator" },
      body: JSON.stringify({ limitTokens: 10_000 }),
    });
    assert.equal(patch.status, 200);
    quiet(() => server.runtime.runStaleReaperSweep());
    const events = await seen;
    const opened = events.filter((event) => event.event === "operator-alert-opened").map((event) => (JSON.parse(event.data) as { alert: Alert }).alert);
    const resolved = events.filter((event) => event.event === "operator-alert-resolved").map((event) => (JSON.parse(event.data) as { alert: Alert }).alert);
    assert.deepEqual(opened.map((alert) => alert.id), [`budget_warn:b-1:${period}`]);
    assert.deepEqual(resolved.map((alert) => alert.id), [`budget_warn:b-1:${period}`]);
    assert.equal(opened[0]?.metadata.tokensSpent, 90);
  } finally {
    controller.abort();
    await server.close();
    h.close();
  }
});

test("server sweep hooks (#2499 slice 4 5j): one stale-reaper tick runs reconcile, restage, goal limits and the alert evaluation, in that order", async () => {
  const h = harness("off");
  const server = await startTestServer({
    broker: h.broker,
    stateStore: h.store,
    enforceRequesterIdentity: false,
    budgetPeriodTimeZone: "UTC",
  });
  try {
    const calls: string[] = [];
    const names = ["reconcileSpendLedger", "restageLostLateMeterings", "applyGoalBudgetLimits", "evaluateBudgetAlerts"] as const;
    const spies = names.map((name) => {
      const original = h.broker[name].bind(h.broker) as (...args: unknown[]) => unknown;
      return mock.method(h.broker, name, (...args: unknown[]) => {
        calls.push(name);
        return original(...args);
      });
    });
    try {
      quiet(() => server.runtime.runStaleReaperSweep());
      assert.deepEqual(calls, [...names]);
      assert.deepEqual(spies.map((spy) => spy.mock.callCount()), [1, 1, 1, 1]);
      assert.deepEqual(spies[0]!.mock.calls[0]!.arguments, [{ maxPages: 1 }]);
    } finally {
      for (const spy of spies) spy.mock.restore();
    }
  } finally {
    await server.close();
    h.close();
  }
});

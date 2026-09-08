#!/usr/bin/env node
// #2077 acceptance: 2,000-terminal-task fixture measuring the persist cost.
// Run from packages/broker after a build:  node scripts/bench-persist.mjs
// Prints per-phase timings; the PR records before/after values.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryA2ABroker } from "../dist/core/broker.js";
import {
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
} from "../dist/core/store.js";

const TOTAL = 2_000;
const dir = mkdtempSync(join(tmpdir(), "a2a-persist-bench-"));
const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
const broker = new InMemoryA2ABroker(store, store.load(), {
  taskRepository: new SqliteTaskRuntimeRepository(store),
  auditRepository: new SqliteAuditRuntimeRepository(store),
  tombstoneRepository: new SqliteTombstoneRuntimeRepository(store),
  workerRepository: new SqliteWorkerRuntimeRepository(store),
  exchangeRepository: new SqliteExchangeRuntimeRepository(store),
  exchangeMessageRepository: new SqliteExchangeMessageRuntimeRepository(store),
  proposalRepository: new SqliteProposalRuntimeRepository(store),
  artifactRepository: new SqliteArtifactRuntimeRepository(store),
  validationRepository: new SqliteValidationRuntimeRepository(store),
});

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

broker.registerWorker({
  nodeId: "bench-worker",
  role: "analyst",
  capabilities: {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["bench"],
    environments: ["research"],
  },
});

const latencies = [];
const created = [];
for (let i = 0; i < TOTAL; i += 1) {
  created.push(broker.createTask({
    id: `bench-task-${i}`,
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "bench-worker", kind: "node", role: "analyst" },
    assignedWorkerId: "bench-worker",
    message: `bench task ${i} — ${"payload ".repeat(20)}`,
  }));
  broker.claimTask(created[i].id, "bench-worker");
}

const writeStartedAtMs = Date.now();
for (let i = 0; i < TOTAL; i += 1) {
  const startedAt = performance.now();
  broker.completeTask(created[i].id, "bench-worker", {
    summary: `done ${i}`,
    note: "evidence ".repeat(40),
  });
  latencies.push(performance.now() - startedAt);
}
const writeWallMs = Date.now() - writeStartedAtMs;

// Force a full retention persist: export the canonical snapshot and save it
// the way persistState's full path does.
const fullStartedAt = performance.now();
broker.exportSnapshot();
const exportMs = performance.now() - fullStartedAt;
const saveStartedAt = performance.now();
store.save(broker.exportSnapshot(), undefined);
const saveMs = performance.now() - saveStartedAt;

console.log(JSON.stringify({
  terminalTasks: TOTAL,
  completeTask: {
    p50Ms: +percentile(latencies, 50).toFixed(3),
    p95Ms: +percentile(latencies, 95).toFixed(3),
    p99Ms: +percentile(latencies, 99).toFixed(3),
    wallMs: writeWallMs,
  },
  fullPersist: {
    exportSnapshotMs: +exportMs.toFixed(3),
    saveMs: +saveMs.toFixed(3),
  },
}, null, 2));

store.close();
rmSync(dir, { recursive: true, force: true });

#!/usr/bin/env node
// #2078 C3 acceptance: lineage endpoints at T=5,000 must cost per request
// proportional to the result size, not a full O(T) projection rebuild.
// Run from packages/broker after a build:  node scripts/bench-task-lineage.mjs
// (not registered as an npm alias — the brokerNpmScripts budget is ceilinged;
// same convention as bench-persist.mjs)
//
// Columns:
//   index  — the real JSON-RPC endpoint (operator mode → incremental index).
//   legacy — the pre-C3 shape: full listTasks + buildTaskLineageReadProjection
//            per request, then the same query (endpoint minus rpc framing).
// The PR records both.
import { InMemoryA2ABroker } from "../dist/core/broker.js";
import { emptySnapshot } from "../dist/core/store.js";
import {
  buildTaskLineageReadProjection,
  parseTaskLineageChildrenRequestV1,
  parseTaskLineageLeavesRequestV1,
  parseTaskLineageLineageRequestV1,
} from "../dist/core/task-lineage-read.js";
import { createBrokerAgentCard } from "../dist/a2a/agent-card.js";
import { executeA2AJsonRpc } from "../dist/a2a/json-rpc.js";

const TOTAL = Number(process.argv.find((arg) => arg.startsWith("--tasks="))?.split("=")[1]) || 5_000;
const ITERATIONS = Number(process.argv.find((arg) => arg.startsWith("--iterations="))?.split("=")[1]) || 300;

const agentCard = createBrokerAgentCard({
  serviceName: "task-lineage-bench-broker",
  publicBaseUrl: "https://broker.test/",
});

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function stats(samples) {
  const ms = samples.map((value) => Number(value) / 1e6);
  return {
    median: percentile(ms, 50),
    p95: percentile(ms, 95),
    mean: ms.reduce((sum, value) => sum + value, 0) / ms.length,
  };
}

function buildWideFixture() {
  // One root, 50 rounds x 99 round-stamped children with totals, a deep
  // 100-node chain, and cross references — 5,000 records total.
  const tasks = [];
  const createdAt = (index) => new Date(Date.parse("2026-07-28T00:00:00.000Z") + index * 1_000).toISOString();
  let index = 0;
  const push = (overrides) => {
    const record = {
      id: `bench-${index}`,
      intent: "analyze",
      status: "succeeded",
      requester: { id: "bench-requester", kind: "service", role: "hub" },
      target: { id: "bench-worker", kind: "node", role: "analyst" },
      targetNodeId: "bench-worker",
      assignedWorkerId: "bench-worker",
      payload: { note: `payload-${index}` },
      message: `message-${index}`,
      createdAt: createdAt(index),
      updatedAt: createdAt(index),
      ...overrides,
    };
    index += 1;
    tasks.push(record);
    return record;
  };
  push({ id: "bench-root" });
  const rounds = Math.floor((TOTAL - 101) / 99);
  for (let round = 0; round < rounds; round += 1) {
    const roundId = `bench-round-${round}`;
    const children = [];
    for (let child = 0; child < 99; child += 1) {
      children.push(push({
        parentTaskId: "bench-root",
        parentRoundId: roundId,
        parentRoundTotal: 99,
        parentRoundOrder: child + 1,
        referenceTaskIds: child % 25 === 0 ? ["bench-root"] : undefined,
      }));
    }
    children[1].referenceTaskIds = [children[0].id];
  }
  let parent = "bench-root";
  for (let depth = 0; depth < 100; depth += 1) {
    parent = push({ parentTaskId: parent }).id;
  }
  return tasks;
}

function buildDeepFixture() {
  // A single 5,000-node canonical chain — worst case for lineage walks.
  const tasks = [];
  const createdAt = (index) => new Date(Date.parse("2026-07-28T00:00:00.000Z") + index * 1_000).toISOString();
  let previous;
  for (let index = 0; index < TOTAL; index += 1) {
    previous = {
      id: `deep-${index}`,
      intent: "analyze",
      status: "succeeded",
      requester: { id: "bench-requester", kind: "service", role: "hub" },
      target: { id: "bench-worker", kind: "node", role: "analyst" },
      targetNodeId: "bench-worker",
      assignedWorkerId: "bench-worker",
      payload: {},
      message: `deep-${index}`,
      createdAt: createdAt(index),
      updatedAt: createdAt(index),
      parentTaskId: previous?.id,
    };
    tasks.push(previous);
  }
  return tasks;
}

const brokerFor = (tasks) => new InMemoryA2ABroker(undefined, { ...emptySnapshot(), tasks }, {
  // The bench measures indexing/query cost, not retention interplay — with
  // defaults, terminal-task retention prunes this old all-terminal fixture
  // down to maxTerminalTasks and the legacy listTasks() column would diverge
  // from the index (the pre-C3 path really did lose pruned rounds).
  retention: {
    terminalRetentionMs: Number.MAX_SAFE_INTEGER,
    maxTerminalTasks: Number.MAX_SAFE_INTEGER,
    maxTerminalTaskBytes: Number.MAX_SAFE_INTEGER,
  },
});

const rpcOptions = (broker) => ({
  broker,
  agentCard,
  requesterIdentity: null,
  enforceRequesterIdentity: false,
});

function rpcOnce(broker, method, params) {
  const response = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: "bench", method, params },
    rpcOptions(broker),
  );
  if (!("result" in response)) {
    throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  }
  return response.result;
}

function bench(name, samples, run) {
  run(); // warmup
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = process.hrtime.bigint();
    run();
    samples.push(process.hrtime.bigint() - started);
  }
  const { median, p95, mean } = stats(samples);
  console.log(
    `${name.padEnd(58)} median ${median.toFixed(3).padStart(9)} ms   p95 ${p95.toFixed(3).padStart(9)} ms   mean ${mean.toFixed(3).padStart(9)} ms`,
  );
}

console.log(`fixture=wide T=${TOTAL.toLocaleString("en-US")} iterations=${ITERATIONS}`);
const wideBroker = brokerFor(buildWideFixture());

const wideSamples = { indexChildren: [], legacyChildren: [], indexLineage: [], legacyLineage: [], indexLeaves: [], legacyLeaves: [], legacyRebuildOnly: [] };

bench("index  tasks/children(root, limit 200)", wideSamples.indexChildren, () => {
  rpcOnce(wideBroker, "tasks/children", { taskId: "bench-root", limit: 200 });
});
bench("legacy tasks/children(root, limit 200)", wideSamples.legacyChildren, () => {
  buildTaskLineageReadProjection(wideBroker.listTasks())
    .children(parseTaskLineageChildrenRequestV1({ taskId: "bench-root", limit: 200 }));
});
bench("index  tasks/children(bench-round-7)", wideSamples.indexRound ?? (wideSamples.indexRound = []), () => {
  rpcOnce(wideBroker, "tasks/children", { parentRoundId: "bench-round-7", limit: 200 });
});
bench("legacy tasks/children(bench-round-7)", wideSamples.legacyRound ?? (wideSamples.legacyRound = []), () => {
  buildTaskLineageReadProjection(wideBroker.listTasks())
    .children(parseTaskLineageChildrenRequestV1({ parentRoundId: "bench-round-7", limit: 200 }));
});
bench("index  tasks/lineage(mid-chain, maxDepth 32)", wideSamples.indexLineage, () => {
  rpcOnce(wideBroker, "tasks/lineage", { taskId: "bench-2500", maxDepth: 32 });
});
bench("legacy tasks/lineage(mid-chain, maxDepth 32)", wideSamples.legacyLineage, () => {
  buildTaskLineageReadProjection(wideBroker.listTasks())
    .lineage(parseTaskLineageLineageRequestV1({ taskId: "bench-2500", maxDepth: 32 }));
});
bench("index  tasks/leaves(limit 200)", wideSamples.indexLeaves, () => {
  rpcOnce(wideBroker, "tasks/leaves", { limit: 200 });
});
bench("legacy tasks/leaves(limit 200)", wideSamples.legacyLeaves, () => {
  buildTaskLineageReadProjection(wideBroker.listTasks())
    .leaves(parseTaskLineageLeavesRequestV1({ limit: 200 }));
});
bench("legacy projection rebuild only (no query)", wideSamples.legacyRebuildOnly, () => {
  buildTaskLineageReadProjection(wideBroker.listTasks());
});

console.log(`\nfixture=deep-chain T=${TOTAL.toLocaleString("en-US")} iterations=${ITERATIONS}`);
const deepBroker = brokerFor(buildDeepFixture());
const deepSamples = { indexLineage: [], legacyLineage: [] };
bench("index  tasks/lineage(tail, maxDepth 128)", deepSamples.indexLineage, () => {
  rpcOnce(deepBroker, "tasks/lineage", { taskId: `deep-${TOTAL - 1}`, maxDepth: 128 });
});
bench("legacy tasks/lineage(tail, maxDepth 128)", deepSamples.legacyLineage, () => {
  buildTaskLineageReadProjection(deepBroker.listTasks())
    .lineage(parseTaskLineageLineageRequestV1({ taskId: `deep-${TOTAL - 1}`, maxDepth: 128 }));
});

// Production runs the SQLite hot-table repository: the legacy column above
// reads the in-memory map only, so measure the same wide fixture once more
// with a repository attached — legacy pays the bounded overlay (SQL + zod per
// row) per request, while the index syncs it exactly once.
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const {
  SqliteBrokerStateStore,
  SqliteTaskRuntimeRepository,
} = await import("../dist/core/store.js");
const dir = mkdtempSync(join(tmpdir(), "a2a-lineage-bench-"));
try {
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const sqliteBroker = new InMemoryA2ABroker(
    store,
    { ...emptySnapshot(), tasks: buildWideFixture() },
    {
      taskRepository: new SqliteTaskRuntimeRepository(store),
      retention: {
        terminalRetentionMs: Number.MAX_SAFE_INTEGER,
        maxTerminalTasks: Number.MAX_SAFE_INTEGER,
        maxTerminalTaskBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  );
  console.log(`\nfixture=wide+sqlite-repository T=${TOTAL.toLocaleString("en-US")} iterations=${ITERATIONS}`);
  const sqliteSamples = { indexChildren: [], legacyChildren: [] };
  bench("index  tasks/children(root, limit 200)", sqliteSamples.indexChildren, () => {
    rpcOnce(sqliteBroker, "tasks/children", { taskId: "bench-root", limit: 200 });
  });
  bench("legacy tasks/children(root, limit 200)", sqliteSamples.legacyChildren, () => {
    buildTaskLineageReadProjection(sqliteBroker.listTasks())
      .children(parseTaskLineageChildrenRequestV1({ taskId: "bench-root", limit: 200 }));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

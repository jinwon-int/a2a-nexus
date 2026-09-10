#!/usr/bin/env node
// #1504 §2.9 bounded local performance characterization for the V1 SQLite
// adapter (inline and worker-writer modes).
//
// Run from packages/broker after a build:  node scripts/bench-shared-state-v1.mjs
//   --pin[=PATH]   write the run as the pinned baseline JSON (default
//                  docs/specs/shared-state-ha-contract/performance-characterization-v1.json;
//                  refuses to overwrite an existing pin without --force)
//   --compare[=PATH]  classify this run against the pinned baseline (reporting
//                  only — see the disclaimer; no pass threshold is invented)
//
// Characterization only: these numbers describe THIS machine and build. They
// are not production capacity, HA evidence, or an approved budget. The §2.9
// pass-threshold gate stays with the operator.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applySharedStateSqliteSchemaV1 } from "../dist/shared-state-sqlite-schema-v1.js";
import {
  SharedStateSqliteAdapterV1,
  pruneSharedStateSqliteV1,
} from "../dist/shared-state-sqlite-adapter-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateTransactionCommandV1,
} from "../dist/shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "../dist/shared-state-storage-keyspace-v1.js";
import { createSharedStateSqliteWorkerConformanceSessionV1 } from "../dist/shared-state-sqlite-worker-conformance-session-v1.js";
import { DatabaseSync } from "node:sqlite";

// ── bounded, deterministic parameters ─────────────────────────────────────

const SEED = 0xa2a2;
const WARMUP_OPS = 50;
const INLINE_SAMPLES = 2_000;
const WORKER_SAMPLES = 500;
const CONTENDED_ROUNDS = 200;
const CONTENDERS_PER_ROUND = 8;
const CLOCK_START_UNIX_MS = 1_700_000_000_000n;
const CLOCK_STEP_MS = 1n; // monotonic injected clock: +1 ms per transaction
const SKEW_TOLERANCE_MS = "300000"; // section 4.2 declared maximum
const PRUNE_PERCENTILE_BAND = 0.15; // reporting-only noise band, NOT a pass threshold

const NAMESPACE = "broker.test";
const OUTBOX_NAMESPACE = "broker.terminal-outbox";
const IDEMPOTENCY_NAMESPACE = "broker.task.create";
const PROJECTION_VERSION = "bench-projection-v1";

// ── deterministic helpers ──────────────────────────────────────────────────

/** xorshift32 — enough structure for ordering; the point is repeatability. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function digest(namespace, domain, components) {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace,
    components,
  });
  if (!built.ok) throw new Error(`digest failed: ${JSON.stringify(built.error)}`);
  return built.value.digest;
}

function cmd(operation, input) {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  if (!parsed.ok) throw new Error(`command ${operation} rejected: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

function queryReq(operation, input) {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation,
    input,
  });
  if (!parsed.ok) throw new Error(`query ${operation} rejected: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// ── command builders (shapes mirror the adapter conformance fixtures) ─────

const B = {
  replay: (nonce) =>
    cmd("consumeReplayNonce", {
      namespace: NAMESPACE,
      keyDigest: digest(NAMESPACE, "security.replay.requester-key", [
        { field: "requesterId", type: "utf8", value: "bench-requester" },
      ]),
      nonceDigest: digest(NAMESPACE, "security.replay.nonce", [
        { field: "nonce", type: "utf8", value: nonce },
      ]),
      ttlMs: 60_000,
    }),
  rate: () =>
    cmd("reserveRateLimitCost", {
      namespace: NAMESPACE,
      bucketKeyDigest: digest(NAMESPACE, "security.rate-limit.bucket-key", [
        { field: "principal", type: "utf8", value: "bench-principal" },
        { field: "route", type: "utf8", value: "bench-route" },
      ]),
      cost: 1,
      limit: 1_000_000_000,
      windowMs: 60_000,
    }),
  claim: (resourceId, owner, expectedVersion) =>
    cmd("claimLease", {
      namespace: NAMESPACE,
      resourceKeyDigest: digest(NAMESPACE, "broker.lease.resource-key", [
        { field: "resourceType", type: "utf8", value: "task" },
        { field: "resourceId", type: "utf8", value: resourceId },
      ]),
      ownerKeyDigest: digest(NAMESPACE, "broker.lease.owner-key", [
        { field: "ownerId", type: "utf8", value: owner },
      ]),
      leaseDurationMs: 60_000,
      expectedResourceVersion: expectedVersion,
    }),
  idempotent: (clientKey, payload) =>
    cmd("executeIdempotent", {
      namespace: IDEMPOTENCY_NAMESPACE,
      keyDigest: digest(IDEMPOTENCY_NAMESPACE, "broker.idempotency.key", [
        { field: "operationName", type: "utf8", value: "bench-op" },
        { field: "clientKey", type: "utf8", value: clientKey },
      ]),
      payloadFingerprint: digest(IDEMPOTENCY_NAMESPACE, "broker.idempotency.payload-fingerprint", [
        { field: "payload", type: "bytes", value: payload },
      ]),
      retentionPolicyVersion: "task-create-effects.v1",
      effect: {
        kind: "domain-mutation-with-outbox",
        domainMutationDigest: digest(IDEMPOTENCY_NAMESPACE, "broker.idempotency.domain-mutation", [
          { field: "mutationType", type: "utf8", value: "create" },
          { field: "mutationBody", type: "bytes", value: "aa" },
        ]),
        outbox: {
          streamKeyDigest: digest(IDEMPOTENCY_NAMESPACE, "broker.outbox.stream-key", [
            { field: "streamType", type: "utf8", value: "task" },
            { field: "streamId", type: "utf8", value: `bench-${clientKey}` },
          ]),
          eventKeyDigest: digest(IDEMPOTENCY_NAMESPACE, "broker.outbox.event-key", [
            { field: "eventId", type: "utf8", value: `evt-${clientKey}` },
          ]),
          payloadDigest: digest(IDEMPOTENCY_NAMESPACE, "broker.outbox.payload", [
            { field: "payload", type: "bytes", value: payload },
          ]),
          retentionPolicyVersion: "caller-owned-outbox.v1",
        },
      },
    }),
  outboxAppend: (eventId, clientKey) => {
    const components = [
      { field: "streamType", type: "utf8", value: "broker-terminal-outbox" },
      { field: "streamId", type: "utf8", value: "bench-stream" },
    ];
    return cmd("appendOutbox", {
      namespace: OUTBOX_NAMESPACE,
      eventPurpose: "task-terminal-notification",
      streamKey: { keyspaceVersion: V.versions.keyspace, components },
      streamKeyDigest: digest(OUTBOX_NAMESPACE, "broker.outbox.stream-key", components),
      orderingScope: "total-within-exact-stream-key",
      idempotencyKeyDigest: digest(OUTBOX_NAMESPACE, "broker.outbox.idempotency-key", [
        { field: "producerId", type: "utf8", value: "bench-producer" },
        { field: "clientKey", type: "utf8", value: clientKey },
      ]),
      eventKeyDigest: digest(OUTBOX_NAMESPACE, "broker.outbox.event-key", [
        { field: "eventId", type: "utf8", value: eventId },
      ]),
      payloadDigest: digest(OUTBOX_NAMESPACE, "broker.outbox.payload", [
        { field: "payload", type: "bytes", value: "a1" },
      ]),
      retentionPolicyVersion: "task-terminal-outbox-retention.v1",
      receiptPolicyVersion: "terminal-notification-receipt.v1",
      acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
    });
  },
  outboxRead: (cursor) =>
    queryReq("reconcileOutbox", {
      namespace: OUTBOX_NAMESPACE,
      streamKeyDigest: digest(OUTBOX_NAMESPACE, "broker.outbox.stream-key", [
        { field: "streamType", type: "utf8", value: "broker-terminal-outbox" },
        { field: "streamId", type: "utf8", value: "bench-stream" },
      ]),
      cursor,
      limit: 100,
      requiredConsistency: V.queryConsistency.reconcileOutbox,
    }),
  graphSource: (ordinal) =>
    cmd("appendGraphSource", {
      namespace: NAMESPACE,
      sourceStreamKeyDigest: digest(NAMESPACE, "broker.claim-graph.source-stream-key", [
        { field: "sourceType", type: "utf8", value: "bench" },
        { field: "sourceId", type: "utf8", value: "run-1" },
      ]),
      sourceFactDigest: graphFact(ordinal),
      nodeType: "Claim",
      expectedSourceSequence: String(ordinal - 1),
    }),
  graphBatch: (batchId, from, through, expectedCheckpoint) =>
    cmd("applyGraphProjectionBatch", {
      namespace: NAMESPACE,
      projectionVersion: PROJECTION_VERSION,
      batchKeyDigest: digest(NAMESPACE, "broker.claim-graph.projection-batch-key", [
        { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
        { field: "batchId", type: "utf8", value: batchId },
      ]),
      batchDigest: digest(NAMESPACE, "broker.claim-graph.projection-batch", [
        { field: "batch", type: "bytes", value: "a1" },
      ]),
      inverseDigest: digest(NAMESPACE, "broker.claim-graph.projection-inverse", [
        { field: "inverse", type: "bytes", value: "b1" },
      ]),
      sourceSequenceFrom: String(from),
      sourceSequenceThrough: String(through),
      expectedCheckpointSequence: String(expectedCheckpoint),
    }),
  graphQuery: (claimOrdinal, evidenceOrdinal) =>
    queryReq("queryGraphEvidencePath", {
      namespace: NAMESPACE,
      projectionVersion: PROJECTION_VERSION,
      claimSourceFactDigest: graphFact(claimOrdinal),
      evidenceSourceFactDigest: graphFact(evidenceOrdinal),
      maxPathEdges: 8,
      requiredConsistency: V.queryConsistency.queryGraphEvidencePath,
    }),
};

function graphFact(ordinal) {
  return digest(NAMESPACE, "broker.claim-graph.source-fact", [
    { field: "nodeType", type: "utf8", value: "Claim" },
    { field: "fact", type: "bytes", value: ordinal.toString(16).padStart(2, "0") },
  ]);
}

// ── measurement core ───────────────────────────────────────────────────────

/**
 * Times one family. `run(i)` performs one operation (awaiting promises) and
 * returns { ok, outcome } — latency is measured around the whole call. The
 * first WARMUP_OPS calls are discarded. Results land per outcome so first /
 * replay / conflict-style splits stay separate.
 */
async function measureFamily(name, count, run, warmupCount = WARMUP_OPS) {
  const latencies = new Map(); // outcome -> number[] (µs)
  let failures = 0;
  for (let i = -warmupCount; i < count; i++) {
    const warm = i < 0;
    const started = process.hrtime.bigint();
    const outcome = await run(i);
    const elapsedUs = Number(process.hrtime.bigint() - started) / 1_000;
    if (outcome === null || outcome === undefined) {
      if (!warm) failures += 1;
      continue;
    }
    if (warm) continue;
    if (!latencies.has(outcome)) latencies.set(outcome, []);
    latencies.get(outcome).push(elapsedUs);
  }
  const families = {};
  let total = 0;
  for (const [outcome, values] of latencies) {
    values.sort((a, b) => a - b);
    total += values.length;
    families[outcome] = {
      count: values.length,
      throughputOpsPerSec: Math.round(values.length / (values.reduce((a, b) => a + b, 0) / 1_000_000)),
      latencyUs: {
        p50: Math.round(percentile(values, 50) * 10) / 10,
        p95: Math.round(percentile(values, 95) * 10) / 10,
        p99: Math.round(percentile(values, 99) * 10) / 10,
      },
    };
  }
  if (failures > 0) families._errors = { count: failures };
  return { family: name, total, outcomes: families };
}

/** Inline adapter target: every transaction carries the injected clock. */
function makeInlineTarget(db) {
  const adapter = new SharedStateSqliteAdapterV1({
    db,
    ownerToken: "bench-inline-owner",
    backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
  });
  const opened = adapter.open();
  if (!opened.ok) throw new Error(`inline adapter open failed: ${opened.error?.code}`);
  let clockUnixMs = CLOCK_START_UNIX_MS;
  return {
    async transact(command) {
      clockUnixMs += CLOCK_STEP_MS;
      return adapter.transact(command, { observedAtUnixMs: clockUnixMs.toString() });
    },
    query: (request) => adapter.query(request),
    adapter,
  };
}

// ── the families ───────────────────────────────────────────────────────────

async function runInlineFamilies(db) {
  const target = makeInlineTarget(db);
  const results = {};

  results.replay_first = await measureFamily("replay_first", INLINE_SAMPLES, async (i) => {
    const r = await target.transact(B.replay(`nonce-${i}`));
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  results.rate_reservation = await measureFamily("rate_reservation", INLINE_SAMPLES, async () => {
    const r = await target.transact(B.rate());
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  results.claim_uncontended = await measureFamily("claim_uncontended", 1_000, async (i) => {
    const r = await target.transact(B.claim(`res-${i}`, `owner-${i}`, "0"));
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  let winners = 0;
  let rounds = 0;
  results.claim_contended = await measureFamily("claim_contended", CONTENDED_ROUNDS, async (round) => {
    const contenders = [];
    for (let c = 0; c < CONTENDERS_PER_ROUND; c++) {
      contenders.push({ owner: `racer-${round}-${c}`, rng: makeRng(SEED + round * 31 + c) });
    }
    // seeded contender order
    for (let c = contenders.length - 1; c > 0; c--) {
      const j = Math.floor(contenders[c].rng() * (c + 1));
      [contenders[c], contenders[j]] = [contenders[j], contenders[c]];
    }
    const outcomes = [];
    for (const { owner } of contenders) {
      const r = await target.transact(B.claim(`shared-res-${round}`, owner, "0"));
      outcomes.push(r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`);
    }
    // correctness invariant: exactly one contender wins each round — the
    // outcome multiset has one decision appearing once (the winner) and all
    // other contenders sharing a single conflict/reject decision.
    const counts = new Map();
    for (const d of outcomes) counts.set(d, (counts.get(d) ?? 0) + 1);
    const singletons = [...counts.entries()].filter(([, n]) => n === 1);
    const isCleanRound = singletons.length === 1 && counts.size === 2;
    if (isCleanRound) {
      rounds += 1;
      winners += 1;
      return "round";
    }
    return `invariant_violation:${JSON.stringify([...counts.entries()])}`;
  });

  const idemCommands = [];
  for (let i = 0; i < 1_000; i++) idemCommands.push(B.idempotent(`client-${i}`, "a1"));

  results.idem_first = await measureFamily("idem_first", idemCommands.length, async (i) => {
    const command = i >= 0 ? idemCommands[i] : B.idempotent(`warmup-first-${i}`, "ff");
    const r = await target.transact(command);
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  let replayMismatch = 0;
  const withoutDecision = (envelope) =>
    JSON.stringify(envelope, (key, value) => (key === "decision" ? undefined : value));
  results.idem_replay = await measureFamily("idem_replay", idemCommands.length, async (i) => {
    // warmup and timed iterations both run a first+replay PAIR on one command
    const command = i >= 0 ? idemCommands[i] : B.idempotent(`warmup-pair-${i}`, "ee");
    const first = await target.transact(command);
    const replay = await target.transact(command);
    // correctness invariant: the replay answers with the ORIGINAL outcome —
    // every envelope field matches except the decision name itself
    // (first "executed" vs replay "replayed").
    if (withoutDecision(first.value) !== withoutDecision(replay.value)) replayMismatch += 1;
    return replay.ok ? `replay:${replay.value.result?.decision}` : `error:${replay.error?.code}`;
  });
  if (replayMismatch > 0) results.idem_replay.outcomes._invariant_violations = { count: replayMismatch };

  results.idem_conflict = await measureFamily("idem_conflict", 500, async (i) => {
    const r = await target.transact(B.idempotent(`client-${i}`, "bb"));
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  const APPENDS = 1_000;
  const appendSequences = [];
  let appendedCount = 0;
  results.outbox_append = await measureFamily("outbox_append", APPENDS, async (i) => {
    const r = await target.transact(B.outboxAppend(`evt-${i}`, `c-${i}`));
    if (r.ok) {
      appendedCount += 1;
      const raw = r.value.result?.streamSequence;
      const seq = raw === undefined ? null : Number(raw);
      if (seq !== null && Number.isFinite(seq)) appendSequences.push(seq);
      return r.value.result?.decision ?? r.value.status;
    }
    return `error:${r.error?.code}`;
  });
  // correctness invariant: adapter-allocated sequences are strictly increasing
  if (appendSequences.length > 0) {
    const increasing = appendSequences.every((s, idx) => idx === 0 || s > appendSequences[idx - 1]);
    if (!increasing) {
      results.outbox_append.outcomes._invariant_violation = { count: 1, note: "append sequences not strictly increasing" };
    }
  }

  // outbox read: walk the whole appended stream in pages
  results.outbox_read = await measureFamily("outbox_read", 20, async () => {
    let cursor = null;
    let rows = 0;
    for (;;) {
      const r = target.query(B.outboxRead(cursor));
      if (!r.ok) return `error:${r.error?.code}`;
      const page = r.value.result;
      rows += page.events.length;
      if (!page.hasMore || page.nextCursor === null || page.events.length === 0) break;
      cursor = page.nextCursor;
    }
    // correctness invariant: the page walk observes every appended event
    return rows === appendedCount ? "walk_complete" : `invariant_violation:${rows}_of_${appendedCount}`;
  });

  // graph: 200 sources, 2 batches, then evidence-path queries
  for (let i = 1; i <= 200; i++) {
    const r = await target.transact(B.graphSource(i));
    if (!r.ok) throw new Error(`graphSource ${i} failed: ${r.error?.code}`);
  }
  results.graph_batch_apply = await measureFamily(
    "graph_batch_apply",
    2,
    async (i) => {
      const from = i * 100 + 1;
      const r = await target.transact(B.graphBatch(`bench-batch-${i}`, from, from + 99, i * 100));
      return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
    },
    0, // batches chain checkpoints; warmup would consume the sequence state
  );

  results.graph_query = await measureFamily("graph_query", 200, async (i) => {
    // warmup indices are negative; fold them into the valid fact range
    const ordinal = i >= 0 ? i + 1 : ((i % 200) + 200) % 200 + 1;
    const r = target.query(B.graphQuery(ordinal, (ordinal % 200) + 1));
    return r.ok ? `query:${r.value.decision ?? "ok"}` : `error:${r.error?.code}`;
  });

  // cleanup cost: one bounded prune over the seeded replay/rate rows
  const pruneStarted = process.hrtime.bigint();
  const prune = pruneSharedStateSqliteV1(db, {
    nowUnixMs: 0n,
    rateCostCutoffUnixMs: 0n,
  });
  const pruneUs = Number(process.hrtime.bigint() - pruneStarted) / 1_000;
  results.cleanup_prune = {
    family: "cleanup_prune",
    total: 1,
    outcomes: {
      prune: {
        count: 1,
        throughputOpsPerSec: null,
        latencyUs: { p50: Math.round(pruneUs * 10) / 10, p95: null, p99: null },
      },
      deleted: { count: (prune.nonceDeleted ?? 0) + (prune.rateCostDeleted ?? 0), throughputOpsPerSec: null, latencyUs: { p50: null, p95: null, p99: null } },
    },
  };

  return results;
}

// ── worker-writer mode ─────────────────────────────────────────────────────

async function runWorkerFamilies(dir) {
  const session = createSharedStateSqliteWorkerConformanceSessionV1({
    filePath: join(dir, "worker.sqlite"),
    ownerToken: "bench-worker-owner",
    backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
    queueCapacity: 64,
    acknowledgmentTimeoutMs: 5_000,
    drainTimeoutMs: 5_000,
  });
  const opened = await session.open();
  if (!opened.ok) throw new Error(`worker lane open failed: ${opened.error?.code}`);
  const lane = session.lane();
  // The conformance worker owns a deterministic instant QUEUE: every lane
  // transaction consumes one published instant in admission order. Publish
  // immediately before each dispatch, exactly like the conformance targets.
  let workerClockUnixMs = CLOCK_START_UNIX_MS;
  const publishInstant = () => {
    workerClockUnixMs += CLOCK_STEP_MS;
    session.channel().send("setObservedInstant", { observedAtUnixMs: workerClockUnixMs.toString() });
  };
  const results = {};

  results.replay_first = await measureFamily("replay_first", WORKER_SAMPLES, async (i) => {
    publishInstant();
    const r = await lane.transact(B.replay(`w-nonce-${i}`));
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  results.rate_reservation = await measureFamily("rate_reservation", WORKER_SAMPLES, async () => {
    publishInstant();
    const r = await lane.transact(B.rate());
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  results.claim_uncontended = await measureFamily("claim_uncontended", WORKER_SAMPLES, async (i) => {
    publishInstant();
    const r = await lane.transact(B.claim(`w-res-${i}`, `w-owner-${i}`, "0"));
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  results.idem_first = await measureFamily("idem_first", WORKER_SAMPLES, async (i) => {
    publishInstant();
    const r = await lane.transact(B.idempotent(`w-client-${i}`, "a1"));
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  let workerAppended = 0;
  results.outbox_append = await measureFamily("outbox_append", WORKER_SAMPLES, async (i) => {
    publishInstant();
    const r = await lane.transact(B.outboxAppend(`w-evt-${i}`, `w-c-${i}`));
    if (r.ok) workerAppended += 1;
    return r.ok ? (r.value.result?.decision ?? r.value.status) : `error:${r.error?.code}`;
  });

  results.outbox_read = await measureFamily("outbox_read", WORKER_SAMPLES / 200 + 3, async () => {
    let cursor = null;
    let rows = 0;
    for (;;) {
      const r = await lane.query(B.outboxRead(cursor));
      if (!r.ok) return `error:${r.error?.code}`;
      const page = r.value.result;
      rows += page.events.length;
      if (!page.hasMore || page.nextCursor === null || page.events.length === 0) break;
      cursor = page.nextCursor;
    }
    return rows === workerAppended ? "walk_complete" : `partial:${rows}_of_${workerAppended}`;
  });

  const diagnostics = lane.diagnostics();
  const closed = await session.close();
  if (!closed.ok) throw new Error(`worker lane close failed: ${closed.error?.code}`);
  // correctness invariant: the bounded FIFO lane never went ambiguous under load
  results.lane_diagnostics = {
    admittedTickets: diagnostics.admittedTickets,
    refusedAdmissions: diagnostics.refusedAdmissions,
    ambiguousWrites: diagnostics.ambiguousWrites,
    crossedResponses: diagnostics.crossedResponses,
  };
  if (diagnostics.ambiguousWrites > 0) {
    results.lane_diagnostics.invariant_violation = "ambiguousWrites > 0";
  }
  return results;
}

// ── fault gate: the deterministic fault/crash suites must pass first ──────

const FAULT_GATE_SUITES = [
  "dist/shared-state-worker-mode/shared-state-sqlite-worker-idempotency-target-v1.test.js",
  "dist/shared-state-worker-mode/shared-state-sqlite-worker-lease-target-v1.test.js",
  "dist/shared-state-worker-mode/shared-state-sqlite-worker-outbox-target-v1.test.js",
  "dist/shared-state-worker-mode/shared-state-sqlite-worker-restart-continuity-target-v1.test.js",
  "dist/shared-state-worker-mode/shared-state-sqlite-worker-partition-target-v1.test.js",
  "dist/shared-state-worker-mode/shared-state-sqlite-worker-expiry-target-v1.test.js",
];

function runFaultGate(brokerRoot) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, ["--test", ...FAULT_GATE_SUITES], {
    cwd: brokerRoot,
    encoding: "utf8",
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    suites: FAULT_GATE_SUITES.map((s) => s.replace("dist/shared-state-worker-mode/", "")),
    pass: result.status === 0,
    durationMs: Math.round(elapsedMs),
  };
}

// ── main ───────────────────────────────────────────────────────────────────

const brokerRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const repoRoot = resolve(brokerRoot, "../..");
const defaultPinPath = join(repoRoot, "docs/specs/shared-state-ha-contract/performance-characterization-v1.json");

const args = process.argv.slice(2);
// `--name` -> true, `--name=VALUE` -> "VALUE", absent -> undefined
const flag = (name) => {
  if (args.includes(`--${name}`)) return true;
  const withValue = args.find((a) => a.startsWith(`--${name}=`));
  return withValue === undefined ? undefined : withValue.slice(name.length + 3);
};
const pinFlag = flag("pin");
const compareFlag = flag("compare");
const force = args.includes("--force");

const DISCLAIMER =
  "Characterization only: describes this machine and build. Not production capacity, not HA evidence, not an approved budget. The §2.9 pass-threshold gate stays with the operator.";

async function main() {
  console.error(`fault gate: running ${FAULT_GATE_SUITES.length} fault/crash suites before any measurement…`);
  const faultGate = runFaultGate(brokerRoot);
  if (!faultGate.pass) {
    console.error("fault gate FAILED — refusing to record performance numbers.");
    process.exitCode = 1;
    return;
  }

  const machine = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim(),
    totalMemGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
  };

  const dir = mkdtempSync(join(tmpdir(), "a2a-shared-state-bench-"));
  const report = {
    kind: "SharedStatePerformanceCharacterizationV1",
    characterizationVersion: 1,
    seed: SEED,
    parameters: {
      warmupOpsDiscarded: WARMUP_OPS,
      inlineSamplesPerFamily: INLINE_SAMPLES,
      workerSamplesPerFamily: WORKER_SAMPLES,
      contendedRounds: CONTENDED_ROUNDS,
      contendersPerRound: CONTENDERS_PER_ROUND,
      injectedClock: `monotonic ${CLOCK_START_UNIX_MS} +${CLOCK_STEP_MS}ms per transaction (inline mode); worker mode clocks internally`,
      backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
    },
    disclaimer: DISCLAIMER,
    machine,
    faultGate,
    modes: {},
  };

  try {
    const inlineDbPath = join(dir, "inline.sqlite");
    const inlineDb = new DatabaseSync(inlineDbPath);
    assertOk(applySharedStateSqliteSchemaV1(inlineDb), "schema apply failed");
    const inlineBytesBefore = statSync(inlineDbPath).size;
    report.modes.inline = {
      families: await runInlineFamilies(inlineDb),
      storage: { bytesBefore: inlineBytesBefore, bytesAfter: statSync(inlineDbPath).size },
    };
    inlineDb.close();

    const workerDbPath = join(dir, "worker.sqlite");
    report.modes.worker = {
      families: await runWorkerFamilies(dir),
      storage: { bytesBefore: 0, bytesAfter: statSync(workerDbPath).size },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ── comparison against a pinned baseline (reporting only) ────────────────
  const comparePath = compareFlag === undefined ? null : compareFlag === true ? defaultPinPath : resolve(compareFlag);
  if (comparePath && existsSync(comparePath)) {
    const baseline = JSON.parse(readFileSync(comparePath, "utf8"));
    report.comparison = {
      baselineRunId: baseline.runId ?? "(unversioned pin)",
      noiseBandNote: `deltas within ±${PRUNE_PERCENTILE_BAND * 100}% are reported flat; this band is a reporting aid, NOT an approved pass threshold`,
      families: compareFamilies(baseline, report),
    };
  } else if (comparePath) {
    report.comparison = { note: `no pinned baseline at ${comparePath}; this run can pin one via --pin` };
  }

  report.runId = `bench-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${SEED.toString(16)}`;
  report.generatedAtUtc = new Date().toISOString();

  if (pinFlag) {
    const pinPath = pinFlag === true ? defaultPinPath : resolve(pinFlag);
    if (existsSync(pinPath) && !force) {
      console.error(`refusing to overwrite existing pin ${pinPath} without --force`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(pinPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.error(`pinned baseline written: ${pinPath}`);
  }

  console.log(JSON.stringify(report, null, 2));
}

function compareFamilies(baseline, current) {
  const out = {};
  for (const mode of ["inline", "worker"]) {
    const baseFamilies = baseline.modes?.[mode]?.families ?? {};
    const curFamilies = current.modes[mode].families;
    for (const [family, cur] of Object.entries(curFamilies)) {
      for (const [outcome, stats] of Object.entries(cur.outcomes ?? {})) {
        const base = baseFamilies[family]?.outcomes?.[outcome]?.latencyUs;
        if (!base?.p50 || !stats.latencyUs?.p50) continue;
        const p50Delta = (stats.latencyUs.p50 - base.p50) / base.p50;
        const p95Delta = stats.latencyUs.p95 && base.p95 ? (stats.latencyUs.p95 - base.p95) / base.p95 : null;
        out[`${mode}.${family}.${outcome}`] = {
          baselineP50Us: base.p50,
          currentP50Us: stats.latencyUs.p50,
          p50Direction: Math.abs(p50Delta) <= PRUNE_PERCENTILE_BAND ? "flat" : p50Delta > 0 ? "slower" : "faster",
          p50DeltaPct: Math.round(p50Delta * 1_000) / 10,
          ...(p95Delta !== null
            ? { p95Direction: Math.abs(p95Delta) <= PRUNE_PERCENTILE_BAND ? "flat" : p95Delta > 0 ? "slower" : "faster", p95DeltaPct: Math.round(p95Delta * 1_000) / 10 }
            : {}),
        };
      }
    }
  }
  return out;
}

function assertOk(result, message) {
  if (!result.ok) throw new Error(`${message}: ${JSON.stringify(result.error)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

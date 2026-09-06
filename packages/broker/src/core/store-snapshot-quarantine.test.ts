// Regression tests for snapshot load isolation (B1b).
//
// Invariant under test: one corrupt persisted record must not keep the broker
// from starting. The record is skipped, logged, counted, and preserved in a
// quarantine file; everything else loads.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryA2ABroker } from "./broker.js";
import {
  JsonFileBrokerStateStore,
  describeSnapshotQuarantineWarning,
  getSnapshotQuarantineStats,
  parseSnapshotPayload,
  readSnapshotQuarantineHealth,
  resetSnapshotQuarantineStats,
  serializeBrokerSnapshot,
} from "./store-snapshot-io.js";

const MAX_BYTES = 20_000_000;

function healthySnapshotObject(): Record<string, unknown> {
  const broker = new InMemoryA2ABroker();
  broker.createProposal({
    source: { id: "node-a", kind: "node", role: "operator" },
    target: { id: "node-b", kind: "node", role: "operator" },
    kind: "patch",
    summary: "good proposal",
    workspace: { nodeId: "node-b", workspaceId: "default" },
    patchText: "diff --git a b",
  });
  return JSON.parse(serializeBrokerSnapshot(broker.exportSnapshot())) as Record<string, unknown>;
}

/** A proposal row shaped like one written before request-stage validation existed. */
function poisonProposal(id: string): Record<string, unknown> {
  return {
    id,
    source: { id: "node-a" },
    target: { id: "node-b" },
    sourceNodeId: "node-a",
    targetNodeId: "node-b",
    kind: "", // rejected by proposalSchema (z.string().min(1))
    summary: "",
    workspace: { nodeId: "node-b", workspaceId: "default" },
    artifactIds: [],
    status: "submitted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("snapshot load isolation", () => {
  beforeEach(() => {
    resetSnapshotQuarantineStats();
  });

  it("skips a corrupt record instead of failing the whole load", () => {
    const snapshot = healthySnapshotObject();
    const proposals = snapshot["proposals"] as Record<string, unknown>[];
    const goodId = proposals[0]?.["id"];
    proposals.push(poisonProposal("poisoned-proposal"));

    const parsed = parseSnapshotPayload(
      JSON.stringify(snapshot),
      join(mkdtempSync(join(tmpdir(), "broker-quarantine-")), "state.json"),
      MAX_BYTES,
    );

    assert.equal(parsed.proposals.length, 1);
    assert.equal(parsed.proposals[0]?.id, goodId);
    const stats = getSnapshotQuarantineStats();
    assert.equal(stats.recordsDropped, 1);
    assert.equal(stats.loadsRecovered, 1);
    assert.equal(stats.loadsFailed, 0);
  });

  it("preserves the corrupt record in a quarantine file next to the snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-quarantine-"));
    const statePath = join(dir, "state.json");
    const snapshot = healthySnapshotObject();
    (snapshot["proposals"] as unknown[]).push(poisonProposal("poisoned-proposal"));
    writeFileSync(statePath, JSON.stringify(snapshot), "utf8");

    const store = new JsonFileBrokerStateStore(statePath);
    const loaded = store.load();
    assert.equal(loaded.proposals.length, 1);

    const quarantineFiles = readdirSync(dir).filter((name) => name.includes(".quarantine-"));
    assert.equal(quarantineFiles.length, 1);
    const quarantined = JSON.parse(readFileSync(join(dir, quarantineFiles[0]!), "utf8"));
    assert.equal(quarantined.dropped.length, 1);
    assert.equal(quarantined.dropped[0].collection, "proposals");
    assert.equal(quarantined.dropped[0].recordId, "poisoned-proposal");
    assert.ok(Array.isArray(quarantined.dropped[0].issues));
    assert.equal(quarantined.dropped[0].record.id, "poisoned-proposal");
    assert.equal(getSnapshotQuarantineStats().quarantineFilesWritten, 1);
  });

  it("lets the broker restart from a snapshot poisoned by a single record", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-quarantine-"));
    const statePath = join(dir, "state.json");
    const snapshot = healthySnapshotObject();
    (snapshot["proposals"] as unknown[]).push(poisonProposal("poisoned-proposal"));
    writeFileSync(statePath, JSON.stringify(snapshot), "utf8");

    const store = new JsonFileBrokerStateStore(statePath);
    const restarted = new InMemoryA2ABroker(store, store.load());
    assert.equal(restarted.listProposals().length, 1);
    assert.equal(restarted.listProposals()[0]?.summary, "good proposal");
  });

  it("isolates corruption per collection and keeps the healthy rows", () => {
    const snapshot = healthySnapshotObject();
    snapshot["workers"] = [
      { id: "worker-broken" }, // missing every required worker field
    ];
    (snapshot["proposals"] as unknown[]).push(poisonProposal("poisoned-proposal"));

    const parsed = parseSnapshotPayload(JSON.stringify(snapshot), "memory://multi", MAX_BYTES);
    assert.equal(parsed.proposals.length, 1);
    assert.equal(parsed.workers.length, 0);
    assert.equal(getSnapshotQuarantineStats().recordsDropped, 2);
  });

  it("still fails closed when the envelope itself is unusable", () => {
    assert.throws(
      () => parseSnapshotPayload(JSON.stringify({ version: "not-a-number" }), "memory://bad", MAX_BYTES),
      /invalid broker snapshot/,
    );
    assert.equal(getSnapshotQuarantineStats().loadsFailed, 1);
  });

  it("leaves a healthy snapshot untouched (no quarantine file, no counters)", () => {
    const parsed = parseSnapshotPayload(
      JSON.stringify(healthySnapshotObject()),
      "memory://healthy",
      MAX_BYTES,
    );
    assert.equal(parsed.proposals.length, 1);
    const stats = getSnapshotQuarantineStats();
    assert.equal(stats.recordsDropped, 0);
    assert.equal(stats.loadsRecovered, 0);
    assert.equal(stats.quarantineFilesWritten, 0);
  });
});

// #2051 item 2: the counters above existed but nothing read them, so a
// quarantine — which drops the row from live state and removes it from the file
// on the next save — was silent data loss. These cover the operator projection
// that `/health` renders.
describe("snapshot quarantine observability", () => {
  beforeEach(() => {
    resetSnapshotQuarantineStats();
  });

  it("reports not-degraded and no warning when nothing was quarantined", () => {
    const health = readSnapshotQuarantineHealth();
    assert.equal(health.degraded, false);
    assert.equal(health.recordsDropped, 0);
    assert.equal(health.lastQuarantineAt, null);
    assert.equal(health.lastQuarantineFile, null);
    assert.equal(describeSnapshotQuarantineWarning(), undefined);
  });

  it("flips to degraded with a file reference and timestamp after a recovered load", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-quarantine-health-"));
    const statePath = join(dir, "state.json");
    const snapshot = healthySnapshotObject();
    (snapshot["proposals"] as unknown[]).push(poisonProposal("poisoned-proposal"));
    writeFileSync(statePath, JSON.stringify(snapshot), "utf8");

    new JsonFileBrokerStateStore(statePath).load();

    const health = readSnapshotQuarantineHealth();
    assert.equal(health.degraded, true);
    assert.equal(health.recordsDropped, 1);
    assert.equal(health.loadsRecovered, 1);
    assert.equal(health.quarantineFilesWritten, 1);
    assert.ok(health.lastQuarantineAt, "lastQuarantineAt must be populated");
    assert.match(String(health.lastQuarantineFile), /\.quarantine-/);

    const warning = describeSnapshotQuarantineWarning();
    assert.match(String(warning), /snapshot quarantine active/);
    assert.match(String(warning), /1 record\(s\) dropped/);
    assert.match(String(warning), /absent from live state/);
  });

  it("counts an unrecoverable load as degraded too", () => {
    assert.throws(
      () => parseSnapshotPayload(JSON.stringify({ version: "nope" }), "memory://bad", MAX_BYTES),
      /invalid broker snapshot/,
    );
    const health = readSnapshotQuarantineHealth();
    assert.equal(health.degraded, true);
    assert.equal(health.loadsFailed, 1);
    assert.match(String(describeSnapshotQuarantineWarning()), /1 unrecoverable load\(s\)/);
  });
});

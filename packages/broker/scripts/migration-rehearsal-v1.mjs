#!/usr/bin/env node
// #1504 Phase 5 — local/offline migration rehearsal (plan.md Phase 5).
//
// One deterministic, self-contained run:
//   A. build a legacy SQLite fixture through the real broker core and export
//      it with the documented export-sqlite-state.mjs path;
//   B. migrate the export into a fresh V1 shared-state SQLite store, one
//      transaction per domain (idempotency, outbox, lease, graph);
//   C. verify by reopening the V1 adapter: imported state is honored
//      (idempotent replay, outbox replay without re-allocation, migrated
//      claim conflicts, per-domain count equality) — divergence ledger;
//   D. crash at every domain boundary (partial store must fail loudly) and
//      roll back to the restorable pre-cutover copy, then re-migrate green;
//   E. record the volatile-state safety window (replay/rate are not
//      migrated — a non-serving drain across the window is required).
//
// Characterization/rehearsal only: entirely local and source-only. Phases 6
// (live shadow) and 7 (cutover) remain separately authorized stages.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const brokerRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const repoRoot = resolve(brokerRoot, "../..");
const exportScript = join(brokerRoot, "scripts", "export-sqlite-state.mjs");

const schemaModule = await import(join(brokerRoot, "dist/shared-state-sqlite-schema-v1.js"));
const applySharedStateSqliteSchemaV1 = schemaModule.applySharedStateSqliteSchemaV1;
const adapterModule = await import(join(brokerRoot, "dist/shared-state-sqlite-adapter-v1.js"));
const SharedStateSqliteAdapterV1 = adapterModule.SharedStateSqliteAdapterV1;
const contractModule = await import(join(brokerRoot, "dist/shared-state-storage-contract-v1.js"));
const V = contractModule.SHARED_STATE_STORAGE_V1_VALUES;
const parseSharedStateTransactionCommandV1 = contractModule.parseSharedStateTransactionCommandV1;
const { createHash } = await import("node:crypto");

const NAMESPACE_LEASE = "broker.lease.task-claim";
const NAMESPACE_IDEM = "broker.task.create";
const NAMESPACE_OUTBOX = "broker.terminal-outbox";
const NAMESPACE_GRAPH = "broker.claim-graph";
const OUTBOX_STREAM_TYPE = "broker-terminal-outbox";
const STALE_WINDOW_MS = 90_000;

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic JSON serialization with recursively sorted object keys. */
function canonicalJsonString(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonString(v)}`).join(",")}}`;
}

function digest(domain, namespace, components) {
  const r = globalThis.__keyspaceDigest({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace,
    components,
  });
  if (!r.ok) throw new Error(`digest failed: ${domain} ${JSON.stringify(r.error)}`);
  return r.value.digest;
}

function makeLedger() {
  const entries = [];
  return {
    entries,
    note(domain, message) {
      entries.push({ domain, message });
    },
  };
}

// ── Stage A: legacy fixture through the real broker core ───────────────────

async function buildLegacyFixture(dir) {
  const { createBrokerServer } = await import(
    join(brokerRoot, "dist/server.js")
  );
  const { once } = await import("node:events");
  const stateFile = join(dir, "legacy-snap.json");
  const sqliteFile = join(dir, "legacy-state.sqlite");
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    brokerId: "brokeralpha",
    persistenceBackend: "sqlite",
    sqliteFile,
    stateFile,
    enforceRequesterIdentity: false,
    lostFenceExit: () => {},
  });
  const broker = runtime.broker;

  broker.registerWorker({
    nodeId: "workerbeta",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });

  broker.createTask({
    id: "task-a",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "workerbeta", kind: "node", role: "analyst" },
    targetNodeId: "workerbeta",
    message: "rehearsal task a",
    taskOrigin: "api",
  });
  broker.claimTask("task-a", "workerbeta");
  broker.completeTask("task-a", "workerbeta", { summary: "done a" });

  broker.createTask({
    id: "task-b",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "workerbeta", kind: "node", role: "analyst" },
    targetNodeId: "workerbeta",
    message: "rehearsal task b",
    taskOrigin: "api",
  });
  broker.claimTask("task-b", "workerbeta");
  broker.failTask("task-b", "workerbeta", { code: "boom", message: "failed b" });

  // Idempotent create hit: same id + same payload returns the existing task.
  broker.createTask({
    id: "task-a",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "workerbeta", kind: "node", role: "analyst" },
    targetNodeId: "workerbeta",
    message: "rehearsal task a",
    taskOrigin: "api",
  });

  // Operator cancel: terminal transition outside the worker path.
  broker.createTask({
    id: "task-c",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "workerbeta", kind: "node", role: "analyst" },
    targetNodeId: "workerbeta",
    message: "rehearsal task c",
    taskOrigin: "api",
  });
  broker.cancelTask("task-c", { actor: { id: "operator-a", kind: "node", role: "operator" }, reason: "rehearsal cancel" });

  // Claim-then-requeue: queued with attempt history.
  broker.createTask({
    id: "task-e",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "workerbeta", kind: "node", role: "analyst" },
    targetNodeId: "workerbeta",
    message: "rehearsal task e (requeued)",
    taskOrigin: "api",
  });
  broker.claimTask("task-e", "workerbeta");
  // The sweep with an age of zero requeues every claimed task, INCLUDING the
  // next one if it were already claimed — so it runs before the final claim.
  broker.requeueStaleTasksDetailed(0);

  // Actively claimed task at migration time.
  broker.createTask({
    id: "task-d",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "workerbeta", kind: "node", role: "analyst" },
    targetNodeId: "workerbeta",
    message: "rehearsal task d (active claim)",
    taskOrigin: "api",
  });
  broker.claimTask("task-d", "workerbeta");

  // Persist and close.
  runtime.server.close();
  runtime.server.closeAllConnections?.();
  await once(runtime.server, "close");
  await runtime.closeWorkerPersistence();

  // Export through the documented path (skips the startup clock guard like
  // recovery exports; version guards stay enforced).
  const exportFile = join(dir, "legacy-export.json");
  const run = spawnSync(
    process.execPath,
    [exportScript, "--db", sqliteFile, "--out", exportFile, "--load-source", "hot-tables"],
    { cwd: brokerRoot, encoding: "utf8" },
  );
  if (run.status !== 0 || !existsSync(exportFile)) {
    throw new Error(`legacy export failed: ${run.stderr?.slice(0, 400)}`);
  }
  const legacy = JSON.parse(readFileSync(exportFile, "utf8"));
  return { legacy, exportFile, stateFile, sqliteFile };
}

// ── Stage B: migrate legacy export → V1 store, one transaction per domain ──

function migrateLegacyToV1(legacy, v1File, { crashAfterDomain } = {}) {
  if (existsSync(v1File)) rmSync(v1File);
  const db = new DatabaseSync(v1File);
  applySharedStateSqliteSchemaV1(db);
  const tasks = legacy.tasks ?? [];
  const outbox = legacy.terminalOutbox ?? [];
  const brokerId = "brokeralpha";
  const migratedAt = Date.now();
  const domain = (name, fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* keep original */ }
      throw error;
    }
    if (crashAfterDomain === name) {
      // Simulated crash between domain boundaries: the process dies without
      // finishing the remaining domains. Close the handle like a dead process
      // would leave it.
      db.close();
      throw new Error(`simulated crash after domain ${name}`);
    }
  };

  // Domain 1: idempotency — one record + outbox link per explicit-id task.
  domain("idempotency", () => {
    for (const task of tasks) {
      if (!task.id) continue;
      const keyDigest = digest("broker.idempotency.key", NAMESPACE_IDEM, [
        { field: "operationName", type: "utf8", value: "task.create" },
        { field: "clientKey", type: "utf8", value: task.id },
      ]);
      const canonical = canonicalJsonString(task);
      const fingerprint = digest("broker.idempotency.payload-fingerprint", NAMESPACE_IDEM, [
        { field: "payload", type: "bytes", value: sha256Hex(canonical) },
      ]);
      const outcome = digest("broker.idempotency.outcome", NAMESPACE_IDEM, [
        { field: "outcomeType", type: "utf8", value: "domain-mutation-with-outbox" },
        { field: "outcomeBody", type: "bytes", value: sha256Hex(canonical) },
      ]);
      db.prepare(
        `INSERT INTO shared_state_idempotency
           (namespace, key_digest, payload_fingerprint, outcome_digest,
            retention_policy_version)
         VALUES (?, ?, ?, ?, 'task-create-effects.v1')`,
      ).run(NAMESPACE_IDEM, keyDigest, fingerprint, outcome);
      const streamKey = digest("broker.outbox.stream-key", NAMESPACE_IDEM, [
        { field: "streamType", type: "utf8", value: "task" },
        { field: "streamId", type: "utf8", value: task.id },
      ]);
      const eventKey = digest("broker.outbox.event-key", NAMESPACE_IDEM, [
        { field: "eventId", type: "utf8", value: `created:${task.id}` },
      ]);
      db.prepare(
        `INSERT INTO shared_state_idempotency_outbox_link
           (namespace, key_digest, stream_key_digest, event_key_digest,
            payload_digest, retention_policy_version)
         VALUES (?, ?, ?, ?, ?, 'task-create-effects.v1')`,
      ).run(
        NAMESPACE_IDEM,
        keyDigest,
        streamKey,
        eventKey,
        digest("broker.outbox.payload", NAMESPACE_IDEM, [
          { field: "payload", type: "bytes", value: sha256Hex(canonical) },
        ]),
      );
    }
  });

  // Domain 2: outbox — legacy terminal events in arrival order, §5.5.1
  // receipt semantics (provider sent/accepted stay pending; provider
  // acceptance is not receipt-confirmation).
  domain("outbox", () => {
    let sequence = 0;
    for (const event of outbox) {
      sequence += 1;
      const streamKey = digest("broker.outbox.stream-key", NAMESPACE_OUTBOX, [
        { field: "streamType", type: "utf8", value: OUTBOX_STREAM_TYPE },
        { field: "streamId", type: "utf8", value: brokerId },
      ]);
      const eventKey = digest("broker.outbox.event-key", NAMESPACE_OUTBOX, [
        { field: "eventId", type: "utf8", value: event.id },
      ]);
      const idemKey = digest("broker.outbox.idempotency-key", NAMESPACE_OUTBOX, [
        { field: "producerId", type: "utf8", value: OUTBOX_STREAM_TYPE },
        { field: "clientKey", type: "utf8", value: event.id },
      ]);
      const payloadDigest = digest("broker.outbox.payload", NAMESPACE_OUTBOX, [
        { field: "payload", type: "bytes", value: sha256Hex(canonicalJsonString(event.payload)) },
      ]);
      const receiptStatus = event.receipt?.status ?? "accepted";
      const receiptState =
        receiptStatus === "delivery_failed" ? "failed" : "pending";
      const ackState = event.ack?.status === "receipt_confirmed"
        ? "acknowledged"
        : "unacknowledged";
      db.prepare(
        `INSERT INTO shared_state_outbox
           (namespace, stream_key_digest, event_key_digest,
            idempotency_key_digest, payload_digest, stream_sequence,
            receipt_state, acknowledgment_state, retention_policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'task-terminal-outbox-retention.v1')`,
      ).run(
        NAMESPACE_OUTBOX,
        streamKey,
        eventKey,
        idemKey,
        payloadDigest,
        String(sequence),
        receiptState,
        ackState,
      );
    }
  });

  // Domain 3: lease — actively claimed tasks get a fresh-authority fence
  // (fencing token 1) and a fresh expiry window. A system that never had
  // fences cannot preserve tokens; the invariant that matters is that the
  // V1 authority never decreases after cutover.
  domain("lease", () => {
    for (const task of tasks) {
      if (task.status !== "claimed" && task.status !== "running") continue;
      const resourceKey = digest("broker.lease.resource-key", NAMESPACE_LEASE, [
        { field: "resourceType", type: "utf8", value: "task" },
        { field: "resourceId", type: "utf8", value: task.id },
      ]);
      const ownerKey = digest("broker.lease.owner-key", NAMESPACE_LEASE, [
        { field: "ownerId", type: "utf8", value: task.claimedBy ?? "unknown" },
      ]);
      const attemptKey = digest("broker.lease.attempt-key", NAMESPACE_LEASE, [
        { field: "resourceId", type: "utf8", value: resourceKey },
        { field: "attemptNumber", type: "uint", value: "1" },
      ]);
      db.prepare(
        `INSERT INTO shared_state_lease
           (namespace, resource_key_digest, owner_key_digest,
            attempt_key_digest, fencing_token, resource_version,
            lease_expires_at_unix_ms)
         VALUES (?, ?, ?, ?, '1', '1', ?)`,
      ).run(
        NAMESPACE_LEASE,
        resourceKey,
        ownerKey,
        attemptKey,
        String(migratedAt + STALE_WINDOW_MS),
      );
    }
  });

  // Domain 4: graph — legacy carries no graph facts; the migrated ledger is
  // empty and the count equality (0 = 0) is asserted at verification.
  domain("graph", () => {
    /* no legacy graph facts exist to migrate */
  });

  db.close();
  return {
    idempotency: tasks.filter((t) => t.id).length,
    outbox: outbox.length,
    lease: tasks.filter((t) => t.status === "claimed" || t.status === "running").length,
    graph: 0,
  };
}

// ── Stage C: verification by reopening the V1 adapter ──────────────────────

function verifyMigratedV1(v1File, expected, legacy, ledger = makeLedger()) {
  const note = ledger.note.bind(ledger);
  // Verification opens the ADAPTER directly (the fence is the runtime's
  // singleton CAS; a migration verifier legitimately reads the store it
  // just wrote under the same schema and lifecycle rules).
  const db = new DatabaseSync(v1File);
  const adapter = new SharedStateSqliteAdapterV1({
    db,
    ownerToken: "migration-rehearsal-verifier",
    backwardSkewToleranceMs: "300000",
  });
  const opened = adapter.open();
  if (!opened.ok) {
    note("open", `adapter open failed: ${opened.error?.code}`);
    db.close();
    return false;
  }
  let ok = true;

  const transact = (operation, input) => {
    const command = parseSharedStateTransactionCommandV1({
      kind: V.kinds.transactionCommand,
      contractVersion: V.versions.contract,
      transactionVersion: V.versions.transaction,
      operationVersion: V.versions.operation,
      operation,
      input,
    });
    if (!command.ok) {
      note("parse", `${operation}: ${command.error.code}`);
      return null;
    }
    const result = adapter.transact(command.value, {
      observedAtUnixMs: String(Date.now()),
    });
    if (!result.ok) {
      note("transact", `${operation}: ${result.error.code}`);
      return null;
    }
    return result.value;
  };

  try {
    // Idempotency: a migrated key with the same fingerprint replays the
    // SAME outcome digest (imported outcome honored, not re-derived).
    const taskA = (legacy.tasks ?? []).find((t) => t.id === "task-a");
    const keyDigest = digest("broker.idempotency.key", NAMESPACE_IDEM, [
      { field: "operationName", type: "utf8", value: "task.create" },
      { field: "clientKey", type: "utf8", value: "task-a" },
    ]);
    const fingerprint = digest("broker.idempotency.payload-fingerprint", NAMESPACE_IDEM, [
      { field: "payload", type: "bytes", value: sha256Hex(canonicalJsonString(taskA)) },
    ]);
    const idemResult = transact("executeIdempotent", {
      namespace: NAMESPACE_IDEM,
      keyDigest,
      payloadFingerprint: fingerprint,
      retentionPolicyVersion: "task-create-effects.v1",
      effect: {
        kind: "domain-mutation-with-outbox",
        domainMutationDigest: digest("broker.idempotency.domain-mutation", NAMESPACE_IDEM, [
          { field: "mutationType", type: "utf8", value: "task.create" },
          { field: "mutationBody", type: "bytes", value: sha256Hex(canonicalJsonString(taskA)) },
        ]),
        outbox: {
          streamKeyDigest: digest("broker.outbox.stream-key", NAMESPACE_IDEM, [
            { field: "streamType", type: "utf8", value: "task" },
            { field: "streamId", type: "utf8", value: "task-a" },
          ]),
          eventKeyDigest: digest("broker.outbox.event-key", NAMESPACE_IDEM, [
            { field: "eventId", type: "utf8", value: `created:task-a` },
          ]),
          payloadDigest: digest("broker.outbox.payload", NAMESPACE_IDEM, [
            { field: "payload", type: "bytes", value: sha256Hex(canonicalJsonString(taskA)) },
          ]),
          retentionPolicyVersion: "task-create-effects.v1",
        },
      },
    });
    const migratedOutcome = readScalar(
      v1File,
      "SELECT outcome_digest FROM shared_state_idempotency WHERE key_digest = ?",
      [keyDigest],
    );
    if (
      idemResult?.status !== V.transactionStatuses[0]
      || idemResult?.result?.decision !== V.operationDecisions.executeIdempotent[1]
      || idemResult?.result?.outcomeDigest !== migratedOutcome
    ) {
      note("idempotency", `replay probe diverged: ${JSON.stringify(idemResult ?? {})}`);
      ok = false;
    }

    // Outbox: the migrated event replays its ORIGINAL sequence and does not
    // allocate a second one.
    const outboxEvent = (legacy.terminalOutbox ?? []).find((e) => e.id);
    if (outboxEvent) {
      const streamKey = digest("broker.outbox.stream-key", NAMESPACE_OUTBOX, [
        { field: "streamType", type: "utf8", value: OUTBOX_STREAM_TYPE },
        { field: "streamId", type: "utf8", value: "brokeralpha" },
      ]);
      const eventKey = digest("broker.outbox.event-key", NAMESPACE_OUTBOX, [
        { field: "eventId", type: "utf8", value: outboxEvent.id },
      ]);
      const idemKey = digest("broker.outbox.idempotency-key", NAMESPACE_OUTBOX, [
        { field: "producerId", type: "utf8", value: OUTBOX_STREAM_TYPE },
        { field: "clientKey", type: "utf8", value: outboxEvent.id },
      ]);
      const migratedSequence = readScalar(
        v1File,
        "SELECT stream_sequence FROM shared_state_outbox WHERE event_key_digest = ?",
        [eventKey],
      );
      const appendResult = transact("appendOutbox", {
        namespace: NAMESPACE_OUTBOX,
        eventPurpose: "task-terminal-notification",
        streamKey: {
          keyspaceVersion: V.versions.keyspace,
          components: [
            { field: "streamType", type: "utf8", value: OUTBOX_STREAM_TYPE },
            { field: "streamId", type: "utf8", value: "brokeralpha" },
          ],
        },
        streamKeyDigest: streamKey,
        orderingScope: "total-within-exact-stream-key",
        idempotencyKeyDigest: idemKey,
        eventKeyDigest: eventKey,
        payloadDigest: digest("broker.outbox.payload", NAMESPACE_OUTBOX, [
          { field: "payload", type: "bytes", value: sha256Hex(canonicalJsonString(outboxEvent.payload)) },
        ]),
        retentionPolicyVersion: "task-terminal-outbox-retention.v1",
        receiptPolicyVersion: "terminal-notification-receipt.v1",
        acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
      });
      if (
        appendResult?.status !== V.transactionStatuses[0]
        || appendResult?.result?.decision !== V.operationDecisions.appendOutbox[1]
        || appendResult?.result?.streamSequence !== migratedSequence
      ) {
        note("outbox", `replay probe diverged: ${JSON.stringify(appendResult ?? {})}`);
        ok = false;
      }
    } else {
      note("outbox", "legacy export carried no terminal outbox event to probe");
      ok = false;
    }

    // Lease: a migrated active claim conflicts (the fresh fence protects it).
    const resourceKey = digest("broker.lease.resource-key", NAMESPACE_LEASE, [
      { field: "resourceType", type: "utf8", value: "task" },
      { field: "resourceId", type: "utf8", value: "task-d" },
    ]);
    const claimResult = transact("claimLease", {
      namespace: NAMESPACE_LEASE,
      resourceKeyDigest: resourceKey,
      ownerKeyDigest: digest("broker.lease.owner-key", NAMESPACE_LEASE, [
        { field: "ownerId", type: "utf8", value: "workerbeta" },
      ]),
      leaseDurationMs: 60_000,
      expectedResourceVersion: "1",
    });
    if (claimResult?.status !== V.transactionStatuses[1] && claimResult !== null) {
      // Rejected is expected (claim_conflict); committed would be a lie.
      if (claimResult.status === V.transactionStatuses[0]) {
        note("lease", "migrated active claim was claimable — migration lost the claim");
        ok = false;
      }
    }
    if (claimResult === null) ok = false;
  } finally {
    const closed = adapter.close();
    if (!closed?.ok && closed?.error?.code !== "not_ready") {
      // close() returning not_ready after a failed open is acceptable here.
    }
    db.close();
  }

  // Per-domain count equality.
  const counts = {
    idempotency: countRows(v1File, "shared_state_idempotency"),
    outbox: countRows(v1File, "shared_state_outbox"),
    lease: countRows(v1File, "shared_state_lease"),
    graph: countRows(v1File, "shared_state_graph_source"),
  };
  for (const domainName of Object.keys(expected)) {
    if (counts[domainName] !== expected[domainName]) {
      note(domainName, `count mismatch: v1=${counts[domainName]} expected=${expected[domainName]}`);
      ok = false;
    }
  }
  return { ok, ledger };
}

function readScalar(v1File, sql, params) {
  const db = new DatabaseSync(v1File, { readOnly: true });
  try {
    const row = db.prepare(sql).get(...params);
    return row ? Object.values(row)[0] : undefined;
  } finally {
    db.close();
  }
}

function countRows(v1File, table) {
  const db = new DatabaseSync(v1File, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

// ── main ───────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "a2a-migration-rehearsal-"));
const v1File = join(dir, "migrated-v1.sqlite");
const report = { stages: {}, divergences: [] };

// Wire the digest/open helpers the migrate/verify closures use.
globalThis.__keyspaceDigest = (
  await import(join(brokerRoot, "dist/shared-state-storage-keyspace-v1.js"))
).digestSharedStateKeyV1;

let pass = true;
try {
  // Stage A.
  const { legacy } = await buildLegacyFixture(dir);
  report.stages.legacyFixture = {
    tasks: (legacy.tasks ?? []).length,
    terminalOutbox: (legacy.terminalOutbox ?? []).length,
  };
  const activeClaims = (legacy.tasks ?? []).filter(
    (t) => t.status === "claimed" || t.status === "running",
  ).length;
  if (!(legacy.tasks ?? []).some((t) => t.id === "task-a")) {
    report.divergences.push({ domain: "fixture", message: "task-a missing from legacy export" });
    pass = false;
  }
  if (activeClaims < 1) {
    const message = "expected at least one actively claimed task in the fixture";
    report.divergences.push({ domain: "fixture", message });
    pass = false;
  }

  // Stage B + C: full migration and verification.
  const expected = migrateLegacyToV1(legacy, v1File);
  report.stages.migratedCounts = expected;
  const full = verifyMigratedV1(v1File, expected, legacy);
  report.stages.verifyFullMigration = full.ok;
  report.stages.verifyFullMigrationDivergences = full.ledger.entries;
  pass &&= full.ok;
  if (!full.ok) report.divergences.push(...full.ledger.entries);

  // Stage D: crash after each domain boundary. A partial store must fail
  // verification exactly when any NOT-YET-WRITTEN domain carries expected
  // rows; a crash after the last non-empty domain leaves a store that is
  // semantically identical to the complete one and legitimately verifies
  // (zero divergence by definition — there is nothing left to lose).
  const domains = ["idempotency", "outbox", "lease", "graph"];
  for (const boundary of domains) {
    let partialFile = join(dir, `partial-${boundary}.sqlite`);
    let crashed = false;
    try {
      migrateLegacyToV1(legacy, partialFile, { crashAfterDomain: boundary });
    } catch (error) {
      crashed = String(error?.message ?? error).includes("simulated crash");
    }
    if (!crashed) {
      report.divergences.push({ domain: "crash", message: `boundary ${boundary}: crash injection did not fire` });
      pass = false;
      continue;
    }
    const boundaryIndex = domains.indexOf(boundary);
    const missingRows = domains
      .slice(boundaryIndex + 1)
      .some((later) => (expected[later] ?? 0) > 0);
    const partial = verifyMigratedV1(partialFile, expected, legacy);
    report.stages[`partialAfter${boundary[0].toUpperCase()}${boundary.slice(1)}`] = partial.ok;
    if (partial.ok && missingRows) {
      report.divergences.push({
        domain: "crash",
        message: `boundary ${boundary}: a PARTIAL store verified — verification is not crash-sensitive`,
      });
      pass = false;
    }
    if (!partial.ok && !missingRows) {
      report.divergences.push({
        domain: "crash",
        message: `boundary ${boundary}: a complete-equivalent store FAILED verification`,
      });
      pass = false;
    }
    // Rollback: discard the partial store; the pre-cutover copy (the legacy
    // export) is re-migrated from scratch and must verify green.
    const rolledFile = join(dir, `rolled-${boundary}.sqlite`);
    const rolledExpected = migrateLegacyToV1(legacy, rolledFile);
    const rolled = verifyMigratedV1(rolledFile, rolledExpected, legacy);
    if (!rolled.ok) {
      note("rollback", `boundary ${boundary}: post-rollback re-migration failed verification: ${JSON.stringify(rolled.ledger.entries)}`);
      pass = false;
    }
    report.stages[`rolledAfter${boundary[0].toUpperCase()}${boundary.slice(1)}`] = rolled.ok;
    rmSync(partialFile, { force: true });
    rmSync(rolledFile, { force: true });
  }
  report.stages.crashAndRollback = { boundaries: domains.length };

  // Stage E: volatile state safety window (replay/rate are volatile and not
  // migrated) — recorded as the non-serving drain requirement.
  report.stages.volatileWindow = {
    replayNonceTtlBound: "signature expiry (request-lifetime bounded; ≤ the A2A signature validity maximum)",
    rateWindows: "RATE_LIMIT_WINDOW_SEC (default 60s) + WORKER_RATE_LIMIT_WINDOW_SEC (default = general)",
    requirement: "non-serving drain across the maximum window, per plan.md Phase 5",
  };
} catch (error) {
  report.divergences.push({ domain: "harness", message: String(error?.stack ?? error) });
  pass = false;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

report.pass = pass && report.divergences.length === 0;
report.disclaimer =
  "Phase 5 local/offline rehearsal only. Phases 6 (live shadow) and 7 (cutover) remain separately authorized stages.";

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;

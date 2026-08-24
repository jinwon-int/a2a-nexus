/**
 * TEST-ONLY read-path fails-closed proofs driven through the W1 bounded FIFO
 * worker lane.
 *
 * WHAT THIS ADDS OVER W1 THROUGH W5. Decision W6 found that both closed query
 * families already reach the adapter through the lane — W1 proves the happy
 * path of each, and W5 proves a query cannot resolve across a delayed or
 * missing durable ACK. What no worker-mode suite proved is that a query
 * *refuses* for the three reasons the inline query suites cover: a rival writer
 * holding the file's write lock, an ownership row taken out from under the
 * session, and durable state that is present but malformed. Those three depend
 * on who owns the connection, so they are mode-dependent under W6's definition
 * and their absence was a coverage gap rather than an exclusion.
 *
 * Checklist item 489 is explicitly a read-path item — "synchronous reads
 * declare/bound consistency and cannot observe an unacknowledged write as
 * committed" — which is why W6 ranked this above the other owed ports.
 *
 * WHY ADMISSION IS ASSERTED, NOT JUST THE REFUSAL. This is the trap this file
 * exists to avoid, and it is sharper than it first looks. When the lane cannot
 * admit a ticket it answers with its *own* operation-preserving `unavailable`
 * envelope carrying `achievedConsistency: null` and reason
 * `authority_unavailable` — byte-for-byte what the adapter returns when it
 * refuses malformed durable state. A test asserting only the status and the
 * reason code would therefore pass without the query ever reaching the adapter,
 * which is the immunity the inline suite gets for free by holding the adapter
 * directly.
 *
 * The obvious guard — "the adapter is still `ready` afterwards" — does NOT
 * close this. A lane refusal never touches the adapter, so the adapter is still
 * `ready` then too; the two cases are indistinguishable on lifecycle alone.
 * That was measured rather than assumed: saturating a lane produced
 * `{status: "unavailable", achievedConsistency: null, reasonCode:
 * "authority_unavailable"}` while `adapterLifecycle` reported `ready`.
 *
 * The discriminator is admission. A lane refusal increments
 * `refusedAdmissions` and never dispatches, while an answer from the adapter is
 * an admitted ticket. So every case here asserts `refusedAdmissions` stayed at
 * zero across the query, which is what makes the reason code mean the adapter
 * said it. The lifecycle assertion is kept alongside, but only for the narrower
 * claim it actually supports: the adapter declined without failing itself.
 *
 * DECISION W3 IS REUSED, NOT REBUILT. The rival writer is the second bare
 * `DatabaseSync` that already lives inside the conformance worker for Phase
 * 2.5, taken and released through `partitionEstablish`/`partitionHeal`. The
 * ownership withdrawal is the same control's `unavailable` point. Neither
 * needed a new control.
 *
 * NO MAIN-THREAD BYPASS. This target opens no `DatabaseSync` and holds no raw
 * handle. The one thing it cannot express with the existing closed controls —
 * corrupting a committed row in place rather than deleting it — is added as a
 * single `readPathCorruption` control whose input carries a closed corruption
 * name and the row's own identity digest, and no table, column, literal or
 * predicate. Nothing reads the corrupted row back: the assertion is the query's
 * refusal, and a confirming SELECT would be the generic read W0 keeps out.
 *
 * What this does NOT do: it checks neither 488 nor 489. It closes one of the
 * five items W6 listed as owed; the write-effect ports and the partition
 * adapter-state ports are still outstanding, and whether the set then satisfies
 * W0's wording is a separate judgment that has not been recorded.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1,
  SHARED_STATE_SQLITE_READ_PATH_CORRUPTIONS_V1,
} from "../shared-state-sqlite-conformance-control-v1.js";
import type { SharedStateSqliteAdapterResultV1 } from "../shared-state-sqlite-adapter-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateTransactionCommandV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
  type SharedStateTransactionCommandV1,
} from "../shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "../shared-state-storage-keyspace-v1.js";
import {
  createSharedStateSqliteWorkerConformanceSessionV1,
  type SharedStateSqliteWorkerConformanceSessionV1,
} from "../shared-state-sqlite-worker-conformance-session-v1.js";

const OUTBOX_NAMESPACE = "broker.terminal-outbox";
const GRAPH_NAMESPACE = "broker.claim-graph";
const PROJECTION_VERSION = "claim-graph-projection.v1";
const OWNER_TOKEN = "read-path-owner-a";

/**
 * `partitionEstablish` requires a usurper token even for `timeout`, which does
 * not use it. An obviously fake constant is deliberate: passing the real owner
 * token would be harmless here but would silently turn the ownership case into
 * a no-op if it were ever copied to the `unavailable` point.
 */
const UNUSED_RIVAL_TOKEN = "unused-by-the-timeout-point";
const USURPER_TOKEN = "read-path-owner-b";

// ---------------------------------------------------------------------------
// Request builders, copied in assertion content from the inline query suites.
// ---------------------------------------------------------------------------

function digest(
  namespace: string,
  domain: string,
  components: readonly Record<string, unknown>[],
): string {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace,
    components,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.value.digest;
}

function outboxStream(streamId: string): {
  readonly streamKey: Record<string, unknown>;
  readonly streamKeyDigest: string;
} {
  const components = [
    { field: "streamType", type: "utf8", value: "broker-terminal-outbox" },
    { field: "streamId", type: "utf8", value: streamId },
  ];
  return {
    streamKey: { keyspaceVersion: V.versions.keyspace, components },
    streamKeyDigest: digest(
      OUTBOX_NAMESPACE,
      "broker.outbox.stream-key",
      components,
    ),
  };
}

function outboxEventKeyDigest(index: number): string {
  return digest(OUTBOX_NAMESPACE, "broker.outbox.event-key", [
    { field: "eventId", type: "utf8", value: `e-${index}` },
  ]);
}

function appendOutboxCommand(index: number): SharedStateTransactionCommandV1 {
  const stream = outboxStream("stream-1");
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "appendOutbox",
    input: {
      namespace: OUTBOX_NAMESPACE,
      eventPurpose: "task-terminal-notification",
      streamKey: stream.streamKey,
      streamKeyDigest: stream.streamKeyDigest,
      orderingScope: "total-within-exact-stream-key",
      idempotencyKeyDigest: digest(
        OUTBOX_NAMESPACE,
        "broker.outbox.idempotency-key",
        [
          { field: "producerId", type: "utf8", value: "query-test" },
          { field: "clientKey", type: "utf8", value: `c-${index}` },
        ],
      ),
      eventKeyDigest: outboxEventKeyDigest(index),
      payloadDigest: digest(OUTBOX_NAMESPACE, "broker.outbox.payload", [
        {
          field: "payload",
          type: "bytes",
          value: index.toString(16).padStart(2, "0"),
        },
      ]),
      retentionPolicyVersion: "task-terminal-outbox-retention.v1",
      receiptPolicyVersion: "terminal-notification-receipt.v1",
      acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function outboxQueryRequest(
  streamId: string,
  cursor: string | null,
  limit: number,
): SharedStateQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "reconcileOutbox",
    input: {
      namespace: OUTBOX_NAMESPACE,
      streamKeyDigest: outboxStream(streamId).streamKeyDigest,
      cursor,
      limit,
      requiredConsistency: V.queryConsistency.reconcileOutbox,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function graphDigest(
  domain: string,
  components: readonly Record<string, unknown>[],
): string {
  return digest(GRAPH_NAMESPACE, domain, components);
}

function sourceFactDigest(index: number, nodeType: string): string {
  return graphDigest("broker.claim-graph.source-fact", [
    { field: "nodeType", type: "utf8", value: nodeType },
    {
      field: "fact",
      type: "bytes",
      value: index.toString(16).padStart(2, "0"),
    },
  ]);
}

function graphCommand(
  operation: string,
  input: Record<string, unknown>,
): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function appendSourceCommand(
  index: number,
  nodeType: string,
): SharedStateTransactionCommandV1 {
  return graphCommand("appendGraphSource", {
    namespace: GRAPH_NAMESPACE,
    sourceStreamKeyDigest: graphDigest(
      "broker.claim-graph.source-stream-key",
      [
        { field: "sourceType", type: "utf8", value: "query-test" },
        { field: "sourceId", type: "utf8", value: "graph-query" },
      ],
    ),
    sourceFactDigest: sourceFactDigest(index, nodeType),
    nodeType,
    expectedSourceSequence: String(index - 1),
  });
}

function applyBatchCommand(input: {
  readonly batchId: string;
  readonly from: number;
  readonly through: number;
  readonly expectedCheckpoint: number;
}): SharedStateTransactionCommandV1 {
  return graphCommand("applyGraphProjectionBatch", {
    namespace: GRAPH_NAMESPACE,
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: graphDigest("broker.claim-graph.projection-batch-key", [
      { field: "projectionVersion", type: "utf8", value: PROJECTION_VERSION },
      { field: "batchId", type: "utf8", value: input.batchId },
    ]),
    batchDigest: graphDigest("broker.claim-graph.projection-batch", [
      {
        field: "batch",
        type: "bytes",
        value: Buffer.from(input.batchId).toString("hex"),
      },
    ]),
    inverseDigest: graphDigest("broker.claim-graph.projection-inverse", [
      {
        field: "inverse",
        type: "bytes",
        value: Buffer.from(`inverse-${input.batchId}`).toString("hex"),
      },
    ]),
    sourceSequenceFrom: String(input.from),
    sourceSequenceThrough: String(input.through),
    expectedCheckpointSequence: String(input.expectedCheckpoint),
  });
}

function graphQueryRequest(input: {
  readonly claimSourceFactDigest: string;
  readonly evidenceSourceFactDigest: string;
}): SharedStateQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "queryGraphEvidencePath",
    input: {
      namespace: GRAPH_NAMESPACE,
      projectionVersion: PROJECTION_VERSION,
      claimSourceFactDigest: input.claimSourceFactDigest,
      evidenceSourceFactDigest: input.evidenceSourceFactDigest,
      maxPathEdges: 8,
      requiredConsistency: V.queryConsistency.queryGraphEvidencePath,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

// ---------------------------------------------------------------------------
// Assertions. `unavailable` mirrors the inline helper exactly, including the
// `achievedConsistency: null` check the inline suites fold into it.
// ---------------------------------------------------------------------------

function unavailable(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
  operation: "reconcileOutbox" | "queryGraphEvidencePath",
): string {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const value = result.value;
  assert.equal(value.operation, operation);
  assert.equal(value.status, "unavailable");
  if (value.status !== "unavailable") throw new Error("unreachable");
  assert.equal(value.achievedConsistency, null);
  return value.reasonCode;
}

function committedResult(
  result: SharedStateSqliteAdapterResultV1<{
    readonly status: string;
    readonly result: Record<string, unknown>;
  }>,
): Record<string, unknown> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "committed");
  return result.value.result;
}

async function lifecycleState(
  session: SharedStateSqliteWorkerConformanceSessionV1,
): Promise<string> {
  const reply = (await session.channel().control("adapterLifecycle")) as {
    readonly lifecycle?: { readonly state?: unknown } | null;
  } | null;
  return String(reply?.lifecycle?.state);
}

/**
 * The load-bearing guard. A refusal the lane synthesized because it could not
 * admit the ticket is indistinguishable from an adapter refusal by status,
 * reason code, consistency and even adapter lifecycle. It is distinguishable
 * here: a refused admission is counted and never dispatched.
 */
function assertAnsweredByAdapter(
  session: SharedStateSqliteWorkerConformanceSessionV1,
): void {
  assert.equal(session.lane().diagnostics().refusedAdmissions, 0);
}

interface Harness {
  readonly session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly directory: string;
}

async function openHarness(name: string): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), `shared-state-w7-${name}-`));
  const session = createSharedStateSqliteWorkerConformanceSessionV1({
    filePath: join(directory, "v1.db"),
    ownerToken: OWNER_TOKEN,
    backwardSkewToleranceMs: "0",
    queueCapacity: 8,
    acknowledgmentTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
  });
  assert.equal((await session.open()).ok, true);
  return { session, directory };
}

async function disposeHarness(harness: Harness): Promise<void> {
  // `dispose` rather than `close`: several of these cases deliberately leave
  // the file in a state where a clean drain is not owed, and W0 forbids
  // claiming ownership was released without one.
  await harness.session.dispose();
  rmSync(harness.directory, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The four ports.
// ---------------------------------------------------------------------------

test("a rival writer's lock makes an outbox query refuse with lock_timeout in worker mode", async () => {
  const harness = await openHarness("outbox-busy");
  try {
    const { session } = harness;

    // The rival is Decision W3's second bare connection, inside the worker.
    // The query below runs against an empty stream on purpose: the refusal has
    // to precede any read, exactly as inline.
    await session.channel().control("partitionEstablish", {
      faultPoint: "timeout",
      usurperToken: UNUSED_RIVAL_TOKEN,
    });

    assert.equal(
      unavailable(
        await session.lane().query(outboxQueryRequest("stream-1", null, 2)),
        "reconcileOutbox",
      ),
      "lock_timeout",
    );

    // A busy file is not a failed adapter. If this reported `failed` the lane
    // would be entitled to synthesize every later answer, and the next
    // assertion would stop meaning anything.
    assertAnsweredByAdapter(session);
    assert.equal(await lifecycleState(session), "ready");

    await session.channel().control("partitionHeal");

    // Releasing the rival restores service, which is what proves the refusal
    // was the lock and not a latched failure.
    const healed = await session.lane().query(
      outboxQueryRequest("stream-1", null, 2),
    );
    assert.equal(healed.ok, true);
    if (!healed.ok) throw new Error("unreachable");
    assert.equal(healed.value.status, "succeeded");
  } finally {
    await disposeHarness(harness);
  }
});

test("a withdrawn ownership row makes an outbox query refuse with lost_ownership in worker mode", async () => {
  const harness = await openHarness("outbox-lost");
  try {
    const { session } = harness;

    await session.channel().control("partitionEstablish", {
      faultPoint: "unavailable",
      usurperToken: USURPER_TOKEN,
    });

    assert.equal(
      unavailable(
        await session.lane().query(outboxQueryRequest("stream-1", null, 2)),
        "reconcileOutbox",
      ),
      "lost_ownership",
    );

    // Inline asserts `owner.lifecycle()?.state === "failed"`. Ownership is
    // re-verified inside the query's own transaction, so losing it must fail
    // the adapter itself and not merely the one answer.
    assertAnsweredByAdapter(session);
    assert.equal(await lifecycleState(session), "failed");
  } finally {
    await disposeHarness(harness);
  }
});

test("a rival writer's lock makes a graph query refuse with lock_timeout in worker mode", async () => {
  const harness = await openHarness("graph-busy");
  try {
    const { session } = harness;

    await session.channel().control("partitionEstablish", {
      faultPoint: "timeout",
      usurperToken: UNUSED_RIVAL_TOKEN,
    });

    const request = graphQueryRequest({
      claimSourceFactDigest: sourceFactDigest(1, "Claim"),
      evidenceSourceFactDigest: sourceFactDigest(2, "Source"),
    });

    assert.equal(
      unavailable(
        await session.lane().query(request),
        "queryGraphEvidencePath",
      ),
      "lock_timeout",
    );
    assertAnsweredByAdapter(session);
    assert.equal(await lifecycleState(session), "ready");

    await session.channel().control("partitionHeal");
  } finally {
    await disposeHarness(harness);
  }
});

test("a withdrawn ownership row makes a graph query refuse with lost_ownership in worker mode", async () => {
  const harness = await openHarness("graph-lost");
  try {
    const { session } = harness;

    await session.channel().control("partitionEstablish", {
      faultPoint: "unavailable",
      usurperToken: USURPER_TOKEN,
    });

    assert.equal(
      unavailable(
        await session.lane().query(
          graphQueryRequest({
            claimSourceFactDigest: sourceFactDigest(1, "Claim"),
            evidenceSourceFactDigest: sourceFactDigest(2, "Source"),
          }),
        ),
        "queryGraphEvidencePath",
      ),
      "lost_ownership",
    );
    assertAnsweredByAdapter(session);
    assert.equal(await lifecycleState(session), "failed");
  } finally {
    await disposeHarness(harness);
  }
});

test("a malformed graph source row makes the graph query fail closed, not answer", async () => {
  const harness = await openHarness("graph-malformed");
  try {
    const { session } = harness;
    const lane = session.lane();

    // Build a genuinely healthy projected graph first. The corruption has to be
    // the only thing wrong, or the refusal proves nothing about the read path.
    const nodeTypes = ["Claim", "Source", "Artifact"] as const;
    const digests: string[] = [];
    for (const [index, nodeType] of nodeTypes.entries()) {
      const ordinal = index + 1;
      await session
        .channel()
        .control("setObservedInstant", { observedAtUnixMs: String(1_000 + ordinal) });
      const result = committedResult(
        (await lane.transact(
          appendSourceCommand(ordinal, nodeType),
        )) as never,
      );
      assert.equal(result.sourceSequence, String(ordinal));
      digests.push(sourceFactDigest(ordinal, nodeType));
    }
    await session
      .channel()
      .control("setObservedInstant", { observedAtUnixMs: "2000" });
    committedResult(
      (await lane.transact(
        applyBatchCommand({
          batchId: "one",
          from: 1,
          through: 3,
          expectedCheckpoint: 0,
        }),
      )) as never,
    );

    // Sanity: the query answers before the corruption. Without this the
    // refusal below could be an artifact of a graph that never worked.
    const before = await lane.query(
      graphQueryRequest({
        claimSourceFactDigest: digests[0]!,
        evidenceSourceFactDigest: digests[2]!,
      }),
    );
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    assert.equal(before.value.status, "succeeded");

    await session.channel().control("readPathCorruption", {
      corruption: "graph-source-sequence-noncanonical",
      namespace: GRAPH_NAMESPACE,
      digest: digests[2]!,
    });

    assert.equal(
      unavailable(
        await lane.query(
          graphQueryRequest({
            claimSourceFactDigest: digests[0]!,
            evidenceSourceFactDigest: digests[2]!,
          }),
        ),
        "queryGraphEvidencePath",
      ),
      "authority_unavailable",
    );

    // The teeth of this file. `authority_unavailable` with
    // `achievedConsistency: null` is exactly what the lane synthesizes for a
    // ticket it could not dispatch, so the assertion above cannot on its own
    // prove the adapter was reached. A still-`ready` adapter can only mean it
    // ran, could not validate the row, and declined without failing itself.
    assertAnsweredByAdapter(session);
    assert.equal(await lifecycleState(session), "ready");
  } finally {
    await disposeHarness(harness);
  }
});

test("a malformed outbox receipt state makes the outbox query fail closed, not page", async () => {
  const harness = await openHarness("outbox-malformed");
  try {
    const { session } = harness;
    const lane = session.lane();

    for (const index of [1, 2, 3]) {
      await session
        .channel()
        .control("setObservedInstant", { observedAtUnixMs: String(1_000 + index) });
      committedResult(
        (await lane.transact(appendOutboxCommand(index))) as never,
      );
    }

    const before = await lane.query(outboxQueryRequest("stream-1", null, 1));
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    assert.equal(before.value.status, "succeeded");

    await session.channel().control("readPathCorruption", {
      corruption: "outbox-receipt-state-invented",
      namespace: OUTBOX_NAMESPACE,
      digest: outboxEventKeyDigest(3),
    });

    // `limit: 1` is load-bearing and must not be relaxed. Event 3 is the
    // corrupted row and falls outside the returned page; the refusal therefore
    // proves the whole fetched window is validated, not merely the rows handed
    // back. Raising the limit would silently prove something weaker.
    assert.equal(
      unavailable(
        await lane.query(outboxQueryRequest("stream-1", null, 1)),
        "reconcileOutbox",
      ),
      "authority_unavailable",
    );
    assertAnsweredByAdapter(session);
    assert.equal(await lifecycleState(session), "ready");
  } finally {
    await disposeHarness(harness);
  }
});

// ---------------------------------------------------------------------------
// The guards every worker-mode target carries.
// ---------------------------------------------------------------------------

test("declares the read-path control inventory and opens no main-thread handle", () => {
  for (const name of [
    "partitionEstablish",
    "partitionHeal",
    "adapterLifecycle",
    "setObservedInstant",
    "readPathCorruption",
  ]) {
    assert.equal(
      SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1.includes(name as never),
      true,
    );
  }

  assert.deepEqual(SHARED_STATE_SQLITE_READ_PATH_CORRUPTIONS_V1, [
    "graph-source-sequence-noncanonical",
    "outbox-receipt-state-invented",
  ]);

  // The no-bypass rule, asserted the way the other worker targets assert it.
  const source = openHarness.toString() + disposeHarness.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compareSharedStateOutboxOrderingV1,
  digestSharedStateKeyV1,
  evaluateSharedStateOutboxPolicyV1,
  evaluateSharedStateOutboxRetentionV1,
  evaluateSharedStateOutboxRetryBindingV1,
  parseSharedStateOutboxCatalogV1,
  parseSharedStateTransactionCommandV1,
  sharedStateOutboxCatalogV1,
  SHARED_STATE_OUTBOX_V1_VALUES as V,
  SHARED_STATE_STORAGE_V1_VALUES as STORAGE_V,
  type SharedStateOutboxCatalogV1,
  type SharedStateOutboxErrorCodeV1,
  type SharedStateOutboxPolicyEvaluationV1,
  type SharedStateOutboxRegistrationV1,
  type SharedStateOutboxResultV1,
} from "./shared-state-storage-contract-v1.js";

interface GoldenRegistration {
  registrationId: string;
  namespace: string;
  eventPurpose: string;
  retentionPolicyVersion: string;
  receiptPolicyVersion: string;
  acknowledgmentPolicyVersion: string;
  orderingScope: string;
}

interface GoldenStreamKey {
  id: string;
  namespace: string;
  components: Array<{
    field: string;
    type: "utf8";
    value: string;
  }>;
  canonicalHex: string;
  digest: string;
}

interface GoldenFixture {
  fixtureVersion: number;
  catalogVersion: string;
  keyspaceVersion: string;
  description: string;
  currentAuthorityIds: string[];
  currentProducerIds: string[];
  registrations: GoldenRegistration[];
  streamKeys: GoldenStreamKey[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/shared-state-storage/outbox-v1-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as GoldenFixture;

const observedErrorCodes = new Set<SharedStateOutboxErrorCodeV1>();
const observedReasonCodes = new Set<string>();
const observedStorageCodes = new Set<string>();

function catalogClone(): SharedStateOutboxCatalogV1 {
  return structuredClone(
    V.catalog,
  ) as unknown as SharedStateOutboxCatalogV1;
}

function expectError(
  result: SharedStateOutboxResultV1<unknown>,
  code: SharedStateOutboxErrorCodeV1,
  path?: readonly (string | number)[],
): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  observedErrorCodes.add(result.error.code);
  assert.equal(result.error.code, code);
  if (path) assert.deepEqual(result.error.path, path);
}

function digest(
  domain: string,
  namespace: string,
  character = "a",
): string {
  return `${STORAGE_V.versions.keyspace}|${domain}|${namespace}|sha256:${character.repeat(64)}`;
}

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function shortFrame(bytes: Buffer): Buffer {
  return Buffer.concat([u16(bytes.length), bytes]);
}

function independentCanonicalBytes(streamKey: GoldenStreamKey): Buffer {
  const frames = streamKey.components.map((component) => {
    const value = Buffer.from(component.value, "utf8");
    return Buffer.concat([
      shortFrame(Buffer.from(component.field, "ascii")),
      Buffer.from([1]),
      u32(value.length),
      value,
    ]);
  });
  return Buffer.concat([
    Buffer.from("4132412d53534b", "hex"),
    Buffer.from([1]),
    shortFrame(Buffer.from(V.keyspaceVersion, "ascii")),
    shortFrame(Buffer.from("broker.outbox.stream-key", "ascii")),
    shortFrame(Buffer.from(streamKey.namespace, "ascii")),
    u16(frames.length),
    ...frames,
  ]);
}

function streamKey(streamId = "synthetic-broker-alpha") {
  const value = {
    keyspaceVersion: V.keyspaceVersion,
    components: [
      {
        field: "streamType",
        type: "utf8",
        value: "broker-terminal-outbox",
      },
      {
        field: "streamId",
        type: "utf8",
        value: streamId,
      },
    ],
  } as const;
  const computed = digestSharedStateKeyV1({
    ...value,
    domain: "broker.outbox.stream-key",
    namespace: "broker.terminal-outbox",
  });
  assert.equal(computed.ok, true);
  if (!computed.ok) throw new Error("synthetic stream key is invalid");
  return {
    value,
    digest: computed.value.digest,
  };
}

function policyInput(
  registration: SharedStateOutboxRegistrationV1,
  operation: "appendOutbox" | "updateOutboxReceipt" |
    "acknowledgeOutbox" = "appendOutbox",
  streamId = "synthetic-broker-alpha",
): Record<string, unknown> {
  const key = streamKey(streamId);
  const base: Record<string, unknown> = {
    operation,
    namespace: registration.namespace,
    eventPurpose: registration.eventPurpose,
    streamKey: key.value,
    streamKeyDigest: key.digest,
    orderingScope: registration.orderingScope,
    retentionPolicyVersion: registration.retentionPolicyVersion,
    receiptPolicyVersion: registration.receiptPolicyVersion,
    acknowledgmentPolicyVersion:
      registration.acknowledgmentPolicyVersion,
  };
  if (operation === "updateOutboxReceipt") {
    if (registration.eventPurpose === "cross-broker-projection-evidence") {
      Object.assign(base, {
        receiptEvidenceKind: "projection-evidence",
        expectedReceiptState: "pending",
        newReceiptState: "pending",
      });
    } else {
      Object.assign(base, {
        receiptEvidenceKind: "operator-visible",
        expectedReceiptState: "pending",
        newReceiptState: "confirmed",
      });
    }
  }
  if (operation === "acknowledgeOutbox") {
    Object.assign(base, {
      receiptEvidenceKind: "operator-visible",
      expectedReceiptState: "confirmed",
      expectedAcknowledgmentState: "unacknowledged",
    });
  }
  return base;
}

function commandInput(
  registration: SharedStateOutboxRegistrationV1,
  operation: "appendOutbox" | "updateOutboxReceipt" |
    "acknowledgeOutbox",
): Record<string, unknown> {
  const policy = policyInput(registration, operation);
  delete policy.operation;
  const namespace = registration.namespace;
  const eventFields = {
    eventKeyDigest: digest(
      "broker.outbox.event-key",
      namespace,
      "e",
    ),
  };
  if (operation === "appendOutbox") {
    return {
      ...policy,
      idempotencyKeyDigest: digest(
      "broker.outbox.idempotency-key",
      namespace,
      "a",
      ),
      ...eventFields,
      payloadDigest: digest("broker.outbox.payload", namespace, "b"),
    };
  }
  return {
    ...policy,
    ...eventFields,
    receiptEvidenceDigest: digest(
      "broker.outbox.receipt-evidence",
      namespace,
      "c",
    ),
  };
}

function command(
  operation: "appendOutbox" | "updateOutboxReceipt" |
    "acknowledgeOutbox",
  input: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: STORAGE_V.kinds.transactionCommand,
    contractVersion: STORAGE_V.versions.contract,
    transactionVersion: STORAGE_V.versions.transaction,
    operationVersion: STORAGE_V.versions.operation,
    operation,
    input,
  };
}

function evaluate(
  registration: SharedStateOutboxRegistrationV1,
  operation: "appendOutbox" | "updateOutboxReceipt" |
    "acknowledgeOutbox" = "appendOutbox",
  streamId?: string,
): SharedStateOutboxPolicyEvaluationV1 {
  const result = evaluateSharedStateOutboxPolicyV1(
    policyInput(registration, operation, streamId),
  );
  if (!result.ok) throw new Error(result.error.code);
  assert.equal(result.ok, true);
  observedReasonCodes.add(result.value.reasonCode);
  return result.value;
}

function retentionInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    receiptState: "confirmed",
    acknowledgmentState: "acknowledged",
    providerAcceptanceObserved: false,
    consumerCheckpointSafetyProved: true,
    idempotencyRetrySourcesGone: true,
    migrationRollbackPreservationProved: true,
    separateRetentionApprovalRecorded: true,
    ...overrides,
  };
}

test("public golden fixture pins the complete closed registry and independent stream-key framing", () => {
  const catalog = sharedStateOutboxCatalogV1();
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.catalogVersion, V.version);
  assert.equal(fixture.keyspaceVersion, V.keyspaceVersion);
  assert.match(fixture.description, /Public non-secret/);
  assert.deepEqual(
    fixture.currentAuthorityIds,
    catalog.authorities.map((authority) => authority.authorityId),
  );
  assert.deepEqual(
    fixture.currentProducerIds,
    catalog.authorities.flatMap((authority) =>
      authority.producers.map((producer) => producer.producerId)
    ),
  );
  assert.deepEqual(
    fixture.registrations,
    catalog.entries.map((entry) => ({
      registrationId: entry.registrationId,
      namespace: entry.namespace,
      eventPurpose: entry.eventPurpose,
      retentionPolicyVersion: entry.retentionPolicyVersion,
      receiptPolicyVersion: entry.receiptPolicyVersion,
      acknowledgmentPolicyVersion:
        entry.acknowledgmentPolicyVersion,
      orderingScope: entry.orderingScope,
    })),
  );

  for (const vector of fixture.streamKeys) {
    const canonical = independentCanonicalBytes(vector);
    assert.equal(canonical.toString("hex"), vector.canonicalHex);
    const hash = createHash("sha256").update(canonical).digest("hex");
    assert.equal(
      vector.digest,
      `${V.keyspaceVersion}|broker.outbox.stream-key|${vector.namespace}|sha256:${hash}`,
    );
    const computed = digestSharedStateKeyV1({
      keyspaceVersion: V.keyspaceVersion,
      domain: "broker.outbox.stream-key",
      namespace: vector.namespace,
      components: vector.components,
    });
    assert.equal(computed.ok, true);
    if (computed.ok) assert.equal(computed.value.digest, vector.digest);
  }
});

test("current durable-but-partial authority and every producer are source-evidenced without a V1 claim", () => {
  const catalog = sharedStateOutboxCatalogV1();
  assert.equal(catalog.runtimeIntegration, "not-implemented");
  assert.equal(catalog.defaultStreamNamespace, null);
  assert.equal(catalog.defaultOrderingScope, null);
  assert.equal(catalog.globalOrdering, false);
  assert.equal(catalog.authorities.length, 1);
  const authority = catalog.authorities[0];
  assert.equal(authority.status, "current-durable-partial");
  assert.equal(
    authority.currentSequenceAuthority,
    "task-event-process-id-or-zero-not-stream-sequence",
  );
  assert.equal(
    authority.currentRetentionPosture,
    "sqlite-unacknowledged-protected-memory-hard-cap-partial",
  );
  assert.equal(authority.producers.length, V.eventPurposes.length);

  const repositoryRoot = new URL("../../../", import.meta.url);
  for (const source of [
    ...authority.sourceRefs,
    ...authority.producers.flatMap((producer) => producer.sourceRefs),
  ]) {
    const contents = readFileSync(
      new URL(source.path, repositoryRoot),
      "utf8",
    );
    assert.ok(
      contents.includes(source.symbol),
      `${source.path} must contain ${source.symbol}`,
    );
    assert.ok(source.proves.length > 0);
  }
});

test("registry identifiers and namespace-purpose mappings are complete and unique", () => {
  const catalog = sharedStateOutboxCatalogV1();
  assert.equal(catalog.entries.length, V.eventPurposes.length);
  assert.equal(
    new Set(catalog.entries.map((entry) => entry.registrationId)).size,
    catalog.entries.length,
  );
  assert.equal(
    new Set(catalog.entries.map((entry) =>
      `${entry.namespace}\0${entry.eventPurpose}`
    )).size,
    catalog.entries.length,
  );
  assert.deepEqual(
    catalog.entries.map((entry) => entry.eventPurpose).sort(),
    [...V.eventPurposes].sort(),
  );
  for (const entry of catalog.entries) {
    assert.equal(entry.status, "planned-adapter-stream");
    assert.equal(entry.namespace, "broker.terminal-outbox");
    assert.equal(entry.orderingScope, "total-within-exact-stream-key");
    assert.equal(
      entry.sequenceAuthority,
      "adapter-allocated-per-exact-stream-key",
    );
    assert.equal(
      entry.monotonicityRule,
      "unique-strictly-increasing-gaps-allowed",
    );
    assert.equal(entry.crossStreamOrder, "no-global-cross-stream-order");
    assert.equal(entry.callerSequencePolicy, "forbidden");
    assert.equal(
      entry.idempotencyBinding,
      "same-key-and-payload-return-original-event-id-and-sequence",
    );
    assert.equal(
      entry.retentionPosture,
      "unacknowledged-non-expiring-until-prune-proof",
    );
  }
});

test("every valid entry evaluates in each applicable Section 6.1 outbox parser", () => {
  for (const entry of sharedStateOutboxCatalogV1().entries) {
    const append = evaluate(entry);
    assert.equal(append.registration, entry);
    const parsedAppend = parseSharedStateTransactionCommandV1(
      command("appendOutbox", commandInput(entry, "appendOutbox")),
    );
    assert.equal(
      parsedAppend.ok,
      true,
      parsedAppend.ok ? entry.eventPurpose : JSON.stringify(
        parsedAppend.error,
      ),
    );

    evaluate(entry, "updateOutboxReceipt");
    const parsedReceipt = parseSharedStateTransactionCommandV1(
      command(
        "updateOutboxReceipt",
        commandInput(entry, "updateOutboxReceipt"),
      ),
    );
    assert.equal(
      parsedReceipt.ok,
      true,
      parsedReceipt.ok ? entry.eventPurpose : JSON.stringify(
        parsedReceipt.error,
      ),
    );

    if (
      entry.acknowledgmentAuthority !==
        "forbidden-projection-evidence"
    ) {
      evaluate(entry, "acknowledgeOutbox");
      assert.equal(
        parseSharedStateTransactionCommandV1(
          command(
            "acknowledgeOutbox",
            commandInput(entry, "acknowledgeOutbox"),
          ),
        ).ok,
        true,
      );
    }
  }
});

test("exact component framing and order reject case, Unicode, wildcard, unknown, and extra fields", () => {
  const entry = sharedStateOutboxCatalogV1().entries[0];
  const base = policyInput(entry);
  for (const value of [
    "Synthetic-broker-alpha",
    "synthetic-bróker-alpha",
    "synthetic-*",
  ]) {
    const invalid = structuredClone(base);
    (
      (invalid.streamKey as Record<string, unknown>)
        .components as Array<Record<string, unknown>>
    )[1].value = value;
    expectError(
      evaluateSharedStateOutboxPolicyV1(invalid),
      "invalid_stream_key_component",
      ["streamKey", "components", 1, "value"],
    );
  }

  const swapped = structuredClone(base);
  (
    (swapped.streamKey as Record<string, unknown>)
      .components as unknown[]
  ).reverse();
  expectError(
    evaluateSharedStateOutboxPolicyV1(swapped),
    "stream_key_component_mismatch",
    ["streamKey", "components", 0, "field"],
  );

  const wrongLiteral = structuredClone(base);
  (
    (wrongLiteral.streamKey as Record<string, unknown>)
      .components as Array<Record<string, unknown>>
  )[0].value = "other-outbox";
  expectError(
    evaluateSharedStateOutboxPolicyV1(wrongLiteral),
    "stream_key_component_mismatch",
    ["streamKey", "components", 0, "value"],
  );

  const extra = structuredClone(base);
  (
    (extra.streamKey as Record<string, unknown>)
      .components as Array<Record<string, unknown>>
  )[0].callerExtension = true;
  expectError(
    evaluateSharedStateOutboxPolicyV1(extra),
    "unknown_field",
    ["streamKey", "components", 0, "callerExtension"],
  );
});

test("same exact stream binds total order while cross-stream keys are isolated with no global order", () => {
  const [task, projection] = sharedStateOutboxCatalogV1().entries;
  const sameLeft = evaluate(task, "appendOutbox");
  const sameRight = evaluate(projection, "appendOutbox");
  const same = compareSharedStateOutboxOrderingV1(sameLeft, sameRight);
  observedReasonCodes.add(same.reasonCode);
  assert.deepEqual(same, {
    decision: "same-stream",
    reasonCode: "same_stream_total_order",
    orderingScope: "total-within-exact-stream-key",
  });

  const other = evaluate(
    task,
    "appendOutbox",
    "synthetic-broker-beta",
  );
  const cross = compareSharedStateOutboxOrderingV1(sameLeft, other);
  observedReasonCodes.add(cross.reasonCode);
  assert.deepEqual(cross, {
    decision: "different-streams",
    reasonCode: "cross_stream_no_order",
    orderingScope: null,
  });
  assert.equal(sharedStateOutboxCatalogV1().globalOrdering, false);
});

test("idempotent retry is bound to the original event ID and sequence; gaps remain legal", () => {
  const namespace = "broker.terminal-outbox";
  const original = {
    namespace,
    idempotencyKeyDigest: digest(
      "broker.outbox.idempotency-key",
      namespace,
      "1",
    ),
    payloadDigest: digest("broker.outbox.payload", namespace, "2"),
    eventKeyDigest: digest("broker.outbox.event-key", namespace, "3"),
    streamSequence: "7",
  };
  const evaluated = evaluateSharedStateOutboxRetryBindingV1({
    original,
    retry: { ...original },
  });
  assert.equal(evaluated.ok, true);
  if (evaluated.ok) {
    observedReasonCodes.add(evaluated.value.reasonCode);
    assert.equal(evaluated.value.eventKeyDigest, original.eventKeyDigest);
    assert.equal(evaluated.value.streamSequence, "7");
  }
  assert.equal(
    sharedStateOutboxCatalogV1().entries[0].monotonicityRule,
    "unique-strictly-increasing-gaps-allowed",
  );

  expectError(
    evaluateSharedStateOutboxRetryBindingV1({
      original,
      retry: { ...original, streamSequence: "8" },
    }),
    "idempotent_retry_conflict",
    ["retry", "streamSequence"],
  );
});

test("provider acceptance remains pending and cannot become receipt-confirmed ACK", () => {
  const task = sharedStateOutboxCatalogV1().entries[0];
  const receipt = policyInput(task, "updateOutboxReceipt");
  receipt.receiptEvidenceKind = "provider-accepted";
  receipt.newReceiptState = "pending";
  const acceptedOnly = evaluateSharedStateOutboxPolicyV1(receipt);
  assert.equal(acceptedOnly.ok, true);

  const invalidConfirmation = structuredClone(receipt);
  invalidConfirmation.newReceiptState = "confirmed";
  expectError(
    evaluateSharedStateOutboxPolicyV1(invalidConfirmation),
    "receipt_transition_mismatch",
    ["newReceiptState"],
  );

  const ack = policyInput(task, "acknowledgeOutbox");
  ack.receiptEvidenceKind = "provider-accepted";
  expectError(
    evaluateSharedStateOutboxPolicyV1(ack),
    "provider_acceptance_not_ack",
    ["receiptEvidenceKind"],
  );
});

test("unacknowledged rows never expire and prune requires every proof", () => {
  const [task, projection] = sharedStateOutboxCatalogV1().entries;
  for (const input of [
    retentionInput({
      acknowledgmentState: "unacknowledged",
      receiptState: "pending",
    }),
    retentionInput({
      acknowledgmentState: "unacknowledged",
      receiptState: "pending",
      providerAcceptanceObserved: true,
    }),
    retentionInput({ consumerCheckpointSafetyProved: false }),
  ]) {
    const result = evaluateSharedStateOutboxRetentionV1(task, input);
    assert.equal(result.ok, true);
    if (result.ok) {
      observedReasonCodes.add(result.value.reasonCode);
      assert.equal(result.value.decision, "retain");
    }
  }
  const safe = evaluateSharedStateOutboxRetentionV1(
    task,
    retentionInput(),
  );
  assert.equal(safe.ok, true);
  if (safe.ok) {
    observedReasonCodes.add(safe.value.reasonCode);
    assert.equal(safe.value.decision, "prune-eligible");
  }
  const projectionRetention = evaluateSharedStateOutboxRetentionV1(
    projection,
    retentionInput(),
  );
  assert.equal(projectionRetention.ok, true);
  if (projectionRetention.ok) {
    observedReasonCodes.add(projectionRetention.value.reasonCode);
    assert.equal(projectionRetention.value.decision, "retain");
  }
});

test("catalog parser fails closed on uniqueness, completeness, mapping, and safety errors", () => {
  expectError(parseSharedStateOutboxCatalogV1(null), "invalid_type");

  const extra = catalogClone() as unknown as Record<string, unknown>;
  extra.extension = true;
  expectError(
    parseSharedStateOutboxCatalogV1(extra),
    "unknown_field",
    ["extension"],
  );

  const invalidKind = catalogClone() as unknown as { kind: string };
  invalidKind.kind = "OtherCatalog";
  expectError(
    parseSharedStateOutboxCatalogV1(invalidKind),
    "invalid_value",
    ["kind"],
  );

  const unknownVersion = catalogClone() as unknown as {
    catalogVersion: string;
  };
  unknownVersion.catalogVersion = "a2a.shared-state.outbox/v2";
  expectError(
    parseSharedStateOutboxCatalogV1(unknownVersion),
    "unknown_catalog_version",
    ["catalogVersion"],
  );

  const duplicateAuthority = catalogClone();
  duplicateAuthority.authorities.push(
    structuredClone(duplicateAuthority.authorities[0]),
  );
  expectError(
    parseSharedStateOutboxCatalogV1(duplicateAuthority),
    "duplicate_authority",
    ["authorities", 1, "authorityId"],
  );

  const duplicateProducer = catalogClone();
  duplicateProducer.authorities[0].producers.push(
    structuredClone(duplicateProducer.authorities[0].producers[0]),
  );
  expectError(
    parseSharedStateOutboxCatalogV1(duplicateProducer),
    "duplicate_producer",
    ["authorities", 0, "producers", 3, "producerId"],
  );

  const duplicateRegistration = catalogClone();
  duplicateRegistration.entries[1].registrationId =
    duplicateRegistration.entries[0].registrationId;
  expectError(
    parseSharedStateOutboxCatalogV1(duplicateRegistration),
    "duplicate_registration",
    ["entries", 1, "registrationId"],
  );

  const unknownAuthority = catalogClone();
  unknownAuthority.entries[0].authorityId = "missing-authority";
  expectError(
    parseSharedStateOutboxCatalogV1(unknownAuthority),
    "unknown_authority",
    ["entries", 0, "authorityId"],
  );

  const unknownProducer = catalogClone();
  unknownProducer.entries[0].producerId = "missing-producer";
  expectError(
    parseSharedStateOutboxCatalogV1(unknownProducer),
    "unknown_producer",
    ["entries", 0, "producerId"],
  );

  const unmappedProducer = catalogClone();
  unmappedProducer.authorities[0].producers.push({
    ...structuredClone(unmappedProducer.authorities[0].producers[0]),
    producerId: "unmapped-producer",
  });
  expectError(
    parseSharedStateOutboxCatalogV1(unmappedProducer),
    "authority_mapping_mismatch",
    ["authorities", 0, "producers", 3, "producerId"],
  );

  const producerMismatch = catalogClone();
  producerMismatch.entries[0].eventIdAuthority =
    "cross-broker-projection-stable-id";
  expectError(
    parseSharedStateOutboxCatalogV1(producerMismatch),
    "producer_mapping_mismatch",
    ["entries", 0, "eventIdAuthority"],
  );

  const incomplete = catalogClone();
  incomplete.entries.pop();
  expectError(
    parseSharedStateOutboxCatalogV1(incomplete),
    "incomplete_registry",
    ["entries"],
  );

  const unsafe = catalogClone();
  unsafe.entries[1].prunePolicy = "receipt-confirmed-proof-gated";
  expectError(
    parseSharedStateOutboxCatalogV1(unsafe),
    "unsafe_registration",
    ["entries", 1],
  );

  const invalidNamespace = catalogClone();
  for (const entry of invalidNamespace.entries) {
    entry.namespace = "Broker.terminal-outbox";
  }
  expectError(
    parseSharedStateOutboxCatalogV1(invalidNamespace),
    "invalid_namespace",
    ["entries", 0, "namespace"],
  );
});

test("policy evaluator fails closed for every stream and policy error", () => {
  const [first, second] = sharedStateOutboxCatalogV1().entries;
  expectError(evaluateSharedStateOutboxPolicyV1(null), "invalid_type");

  const invalidOperation = policyInput(first);
  invalidOperation.operation = "sendOutbox";
  expectError(
    evaluateSharedStateOutboxPolicyV1(invalidOperation),
    "invalid_value",
    ["operation"],
  );

  for (const namespace of [
    "Broker.terminal-outbox",
    "broker.*",
    "broker.terminal-óutbox",
  ]) {
    const invalid = policyInput(first);
    invalid.namespace = namespace;
    expectError(
      evaluateSharedStateOutboxPolicyV1(invalid),
      "invalid_namespace",
      ["namespace"],
    );
  }

  const unknownNamespace = policyInput(first);
  unknownNamespace.namespace = "broker.unknown";
  expectError(
    evaluateSharedStateOutboxPolicyV1(unknownNamespace),
    "unknown_namespace",
    ["namespace"],
  );

  const unknownPurpose = policyInput(first);
  unknownPurpose.eventPurpose = "unknown-purpose";
  expectError(
    evaluateSharedStateOutboxPolicyV1(unknownPurpose),
    "unknown_event_purpose",
    ["eventPurpose"],
  );

  const invalidKey = policyInput(first);
  (invalidKey.streamKey as Record<string, unknown>).keyspaceVersion =
    "a2a.shared-state.keyspace/v2";
  expectError(
    evaluateSharedStateOutboxPolicyV1(invalidKey),
    "invalid_stream_key",
    ["streamKey", "keyspaceVersion"],
  );

  const badShape = policyInput(first);
  (
    (badShape.streamKey as Record<string, unknown>).components as unknown[]
  ).pop();
  expectError(
    evaluateSharedStateOutboxPolicyV1(badShape),
    "stream_key_shape_mismatch",
    ["streamKey", "components"],
  );

  const badType = policyInput(first);
  (
    (badType.streamKey as Record<string, unknown>)
      .components as Array<Record<string, unknown>>
  )[1].type = "bytes";
  expectError(
    evaluateSharedStateOutboxPolicyV1(badType),
    "stream_key_component_mismatch",
    ["streamKey", "components", 1, "type"],
  );

  const badComponent = policyInput(first);
  (
    (badComponent.streamKey as Record<string, unknown>)
      .components as Array<Record<string, unknown>>
  )[1].value = "UPPER";
  expectError(
    evaluateSharedStateOutboxPolicyV1(badComponent),
    "invalid_stream_key_component",
    ["streamKey", "components", 1, "value"],
  );

  const digestMismatch = policyInput(first);
  digestMismatch.streamKeyDigest = streamKey(
    "synthetic-broker-beta",
  ).digest;
  expectError(
    evaluateSharedStateOutboxPolicyV1(digestMismatch),
    "stream_key_digest_mismatch",
    ["streamKeyDigest"],
  );

  const ordering = policyInput(first);
  ordering.orderingScope = "global";
  expectError(
    evaluateSharedStateOutboxPolicyV1(ordering),
    "ordering_scope_mismatch",
    ["orderingScope"],
  );

  const sequence = policyInput(first);
  sequence.streamSequence = "1";
  expectError(
    evaluateSharedStateOutboxPolicyV1(sequence),
    "caller_sequence_forbidden",
    ["streamSequence"],
  );

  const policyCases = [
    {
      field: "retentionPolicyVersion",
      value: "Task.v1",
      code: "invalid_retention_policy_version",
    },
    {
      field: "retentionPolicyVersion",
      value: "unknown.v1",
      code: "unknown_retention_policy_version",
    },
    {
      field: "retentionPolicyVersion",
      value: second.retentionPolicyVersion,
      code: "retention_policy_mismatch",
    },
    {
      field: "receiptPolicyVersion",
      value: "Receipt.v1",
      code: "invalid_receipt_policy_version",
    },
    {
      field: "receiptPolicyVersion",
      value: "unknown.v1",
      code: "unknown_receipt_policy_version",
    },
    {
      field: "receiptPolicyVersion",
      value: second.receiptPolicyVersion,
      code: "receipt_policy_mismatch",
    },
    {
      field: "acknowledgmentPolicyVersion",
      value: "Ack.v1",
      code: "invalid_acknowledgment_policy_version",
    },
    {
      field: "acknowledgmentPolicyVersion",
      value: "unknown.v1",
      code: "unknown_acknowledgment_policy_version",
    },
    {
      field: "acknowledgmentPolicyVersion",
      value: second.acknowledgmentPolicyVersion,
      code: "acknowledgment_policy_mismatch",
    },
  ] as const;
  for (const item of policyCases) {
    const invalid = policyInput(first);
    invalid[item.field] = item.value;
    expectError(
      evaluateSharedStateOutboxPolicyV1(invalid),
      item.code,
      [item.field],
    );
  }

  const receipt = policyInput(first, "updateOutboxReceipt");
  receipt.newReceiptState = "pending";
  expectError(
    evaluateSharedStateOutboxPolicyV1(receipt),
    "receipt_transition_mismatch",
    ["newReceiptState"],
  );

  const projectionAck = policyInput(
    second,
    "acknowledgeOutbox",
  );
  expectError(
    evaluateSharedStateOutboxPolicyV1(projectionAck),
    "acknowledgment_forbidden",
    ["eventPurpose"],
  );

  const badAck = policyInput(first, "acknowledgeOutbox");
  badAck.receiptEvidenceKind = "delivery-failed";
  expectError(
    evaluateSharedStateOutboxPolicyV1(badAck),
    "acknowledgment_evidence_mismatch",
    ["receiptEvidenceKind"],
  );
});

test("retention and retry evaluators reject malformed inputs", () => {
  const entry = sharedStateOutboxCatalogV1().entries[0];
  expectError(
    evaluateSharedStateOutboxRetentionV1(entry, {
      ...retentionInput(),
      receiptState: "accepted",
    }),
    "invalid_retention_evaluation",
    ["receiptState"],
  );

  expectError(
    evaluateSharedStateOutboxRetryBindingV1({
      original: {},
      retry: {},
    }),
    "invalid_retry_binding",
    ["original", "namespace"],
  );
});

test("Section 6.1 outbox parsers return every new stable code and path", () => {
  const [first, second] = sharedStateOutboxCatalogV1().entries;
  const cases: Array<{
    operation: "appendOutbox" | "updateOutboxReceipt" |
      "acknowledgeOutbox";
    mutate(input: Record<string, unknown>): void;
    code: string;
    path: readonly (string | number)[];
  }> = [
    {
      operation: "appendOutbox",
      mutate: (input) => {
        input.namespace = "Broker.terminal-outbox";
      },
      code: "invalid_outbox_stream_namespace",
      path: ["input", "namespace"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        input.namespace = "broker.unknown";
      },
      code: "unknown_outbox_stream_namespace",
      path: ["input", "namespace"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        input.eventPurpose = "unknown";
      },
      code: "unknown_outbox_event_purpose",
      path: ["input", "eventPurpose"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        (input.streamKey as Record<string, unknown>).keyspaceVersion = "v2";
      },
      code: "invalid_outbox_stream_key",
      path: ["input", "streamKey", "keyspaceVersion"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        (
          (input.streamKey as Record<string, unknown>).components as unknown[]
        ).pop();
      },
      code: "outbox_stream_key_shape_mismatch",
      path: ["input", "streamKey", "components"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        (
          (input.streamKey as Record<string, unknown>)
            .components as Array<Record<string, unknown>>
        )[0].value = "other";
      },
      code: "outbox_stream_key_component_mismatch",
      path: ["input", "streamKey", "components", 0, "value"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        (
          (input.streamKey as Record<string, unknown>)
            .components as Array<Record<string, unknown>>
        )[1].value = "UPPER";
      },
      code: "invalid_outbox_stream_key_component",
      path: ["input", "streamKey", "components", 1, "value"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        input.streamKeyDigest = streamKey("synthetic-broker-beta").digest;
      },
      code: "outbox_stream_key_digest_mismatch",
      path: ["input", "streamKeyDigest"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        input.orderingScope = "global";
      },
      code: "outbox_ordering_scope_mismatch",
      path: ["input", "orderingScope"],
    },
    {
      operation: "appendOutbox",
      mutate: (input) => {
        input.expectedStreamSequence = "1";
      },
      code: "caller_outbox_sequence_forbidden",
      path: ["input", "expectedStreamSequence"],
    },
    ...[
      ["retentionPolicyVersion", "Task.v1",
        "invalid_outbox_retention_policy_version"],
      ["retentionPolicyVersion", "unknown.v1",
        "unknown_outbox_retention_policy_version"],
      ["retentionPolicyVersion", second.retentionPolicyVersion,
        "outbox_retention_policy_mismatch"],
      ["receiptPolicyVersion", "Receipt.v1",
        "invalid_outbox_receipt_policy_version"],
      ["receiptPolicyVersion", "unknown.v1",
        "unknown_outbox_receipt_policy_version"],
      ["receiptPolicyVersion", second.receiptPolicyVersion,
        "outbox_receipt_policy_mismatch"],
      ["acknowledgmentPolicyVersion", "Ack.v1",
        "invalid_outbox_acknowledgment_policy_version"],
      ["acknowledgmentPolicyVersion", "unknown.v1",
        "unknown_outbox_acknowledgment_policy_version"],
      ["acknowledgmentPolicyVersion", second.acknowledgmentPolicyVersion,
        "outbox_acknowledgment_policy_mismatch"],
    ].map(([field, value, code]) => ({
      operation: "appendOutbox" as const,
      mutate: (input: Record<string, unknown>) => {
        input[field] = value;
      },
      code,
      path: ["input", field] as const,
    })),
    {
      operation: "updateOutboxReceipt",
      mutate: (input) => {
        input.newReceiptState = "pending";
      },
      code: "outbox_receipt_transition_mismatch",
      path: ["input", "newReceiptState"],
    },
    {
      operation: "acknowledgeOutbox",
      mutate: (input) => {
        Object.assign(input, commandInput(second, "acknowledgeOutbox"));
      },
      code: "outbox_acknowledgment_forbidden",
      path: ["input", "eventPurpose"],
    },
    {
      operation: "acknowledgeOutbox",
      mutate: (input) => {
        input.receiptEvidenceKind = "provider-accepted";
      },
      code: "outbox_provider_acceptance_not_ack",
      path: ["input", "receiptEvidenceKind"],
    },
    {
      operation: "acknowledgeOutbox",
      mutate: (input) => {
        input.receiptEvidenceKind = "delivery-failed";
      },
      code: "outbox_acknowledgment_evidence_mismatch",
      path: ["input", "receiptEvidenceKind"],
    },
  ];

  for (const item of cases) {
    const input = commandInput(first, item.operation);
    item.mutate(input);
    const parsed = parseSharedStateTransactionCommandV1(
      command(item.operation, input),
    );
    assert.equal(parsed.ok, false, item.code);
    if (parsed.ok) continue;
    observedStorageCodes.add(parsed.error.code);
    assert.equal(parsed.error.code, item.code);
    assert.deepEqual(parsed.error.path, item.path);
  }
});

test("Section 6.1 outbox parsers reject extensions and nested caller sequences", () => {
  const entry = sharedStateOutboxCatalogV1().entries[0];
  const extended = commandInput(entry, "appendOutbox");
  extended.callerExtension = true;
  const parsedExtended = parseSharedStateTransactionCommandV1(
    command("appendOutbox", extended),
  );
  assert.equal(parsedExtended.ok, false);
  if (!parsedExtended.ok) {
    assert.equal(parsedExtended.error.code, "unknown_field");
    assert.deepEqual(parsedExtended.error.path, [
      "input",
      "callerExtension",
    ]);
  }

  const nestedSequence = commandInput(entry, "appendOutbox");
  (nestedSequence.streamKey as Record<string, unknown>).sequence = "1";
  const parsedSequence = parseSharedStateTransactionCommandV1(
    command("appendOutbox", nestedSequence),
  );
  assert.equal(parsedSequence.ok, false);
  if (!parsedSequence.ok) {
    assert.equal(
      parsedSequence.error.code,
      "caller_outbox_sequence_forbidden",
    );
    assert.deepEqual(parsedSequence.error.path, [
      "input",
      "streamKey",
      "sequence",
    ]);
  }
});

test("all new catalog errors, reason codes, and storage parser codes are exercised", () => {
  assert.deepEqual(
    [...observedErrorCodes].sort(),
    [...V.errorCodes].sort(),
  );
  assert.deepEqual(
    [...observedReasonCodes].sort(),
    [...V.evaluationReasonCodes].sort(),
  );
  const expectedStorageCodes = STORAGE_V.parserErrorCodes.filter(
    (code) => code.includes("outbox") || code ===
      "caller_outbox_sequence_forbidden",
  );
  assert.deepEqual(
    [...observedStorageCodes].sort(),
    [...expectedStorageCodes].sort(),
  );
});

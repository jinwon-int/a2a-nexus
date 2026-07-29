import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateSharedStateIdempotencyExpiryV1,
  evaluateSharedStateIdempotencyPolicyV1,
  parseSharedStateIdempotencyCatalogV1,
  sharedStateIdempotencyCatalogV1,
  SHARED_STATE_IDEMPOTENCY_V1_VALUES as V,
  type SharedStateIdempotencyCatalogV1,
  type SharedStateIdempotencyErrorCodeV1,
  type SharedStateIdempotencyResultV1,
} from "./shared-state-idempotency-v1.js";
import {
  parseSharedStateTransactionCommandV1,
  SHARED_STATE_STORAGE_V1_VALUES as STORAGE_V,
} from "./shared-state-storage-contract-v1.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/shared-state-storage/idempotency-v1-golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown;

const observedErrorCodes = new Set<SharedStateIdempotencyErrorCodeV1>();
const observedReasonCodes = new Set<string>();

function catalogClone(): SharedStateIdempotencyCatalogV1 {
  return structuredClone(fixture) as SharedStateIdempotencyCatalogV1;
}

function expectError(
  result: SharedStateIdempotencyResultV1<unknown>,
  code: SharedStateIdempotencyErrorCodeV1,
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

function command(
  operation: string,
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

function executeIdempotentCommand(
  namespace: string,
  retentionPolicyVersion: string,
  effectKind = "domain-mutation-with-outbox",
): Record<string, unknown> {
  return command("executeIdempotent", {
    namespace,
    keyDigest: digest("broker.idempotency.key", namespace, "1"),
    payloadFingerprint: digest(
      "broker.idempotency.payload-fingerprint",
      namespace,
      "2",
    ),
    retentionPolicyVersion,
    effect: {
      kind: effectKind,
      domainMutationDigest: digest(
        "broker.idempotency.domain-mutation",
        namespace,
        "3",
      ),
      outbox: {
        streamKeyDigest: digest(
          "broker.outbox.stream-key",
          namespace,
          "4",
        ),
        eventKeyDigest: digest(
          "broker.outbox.event-key",
          namespace,
          "5",
        ),
        payloadDigest: digest(
          "broker.outbox.payload",
          namespace,
          "6",
        ),
        retentionPolicyVersion: "caller-owned-outbox.v1",
      },
    },
  });
}

test("public golden catalog is the closed canonical registry", () => {
  const parsed = parseSharedStateIdempotencyCatalogV1(fixture);
  assert.equal(parsed.ok, true);
  assert.deepEqual(fixture, V.catalog);
  assert.deepEqual(sharedStateIdempotencyCatalogV1(), fixture);
  if (!parsed.ok) return;
  assert.equal(
    parsed.value.defaultRetentionPolicyVersion,
    null,
  );
  assert.equal(
    parsed.value.runtimeIntegration,
    "not-implemented",
  );
  assert.equal(
    parsed.value.extensionPolicy,
    "forbidden",
  );
});

test("registry namespaces, retention versions, authorities, and mappings are complete and unique", () => {
  const catalog = sharedStateIdempotencyCatalogV1();
  assert.equal(catalog.authorities.length, 6);
  assert.equal(catalog.entries.length, catalog.authorities.length);
  assert.equal(
    new Set(catalog.entries.map((entry) => entry.namespace)).size,
    catalog.entries.length,
  );
  assert.equal(
    new Set(
      catalog.entries.map((entry) => entry.retentionPolicyVersion),
    ).size,
    catalog.entries.length,
  );
  assert.equal(
    new Set(catalog.authorities.map((authority) => authority.authorityId))
      .size,
    catalog.authorities.length,
  );
  for (const authority of catalog.authorities) {
    const entry = catalog.entries.find(
      (candidate) => candidate.authorityId === authority.authorityId,
    );
    assert.ok(entry);
    assert.equal(entry.status, "planned-adapter-namespace");
    assert.equal(entry.namespace, authority.plannedNamespace);
  }
});

test("every current durable authority mapping is backed by the pinned public source", () => {
  const repositoryRoot = new URL("../../../", import.meta.url);
  for (const authority of sharedStateIdempotencyCatalogV1().authorities) {
    assert.equal(authority.status, "current-durable-partial");
    assert.ok(authority.sourceRefs.length > 0);
    for (const source of authority.sourceRefs) {
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
  }
});

test("every registered namespace, retention version, and effect evaluates and parses in section 6.1", () => {
  for (const entry of sharedStateIdempotencyCatalogV1().entries) {
    const evaluated = evaluateSharedStateIdempotencyPolicyV1({
      namespace: entry.namespace,
      retentionPolicyVersion: entry.retentionPolicyVersion,
      effectKind: entry.effectKind,
    });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok) continue;
    observedReasonCodes.add(evaluated.value.reasonCode);
    assert.equal(evaluated.value.decision, "registered");
    assert.equal(evaluated.value.registration, entry);

    const expiry = evaluateSharedStateIdempotencyExpiryV1(entry);
    assert.equal(expiry.ok, true);
    if (expiry.ok) {
      observedReasonCodes.add(expiry.value.reasonCode);
      assert.equal(expiry.value.decision, "non-expiring");
    }

    const parsed = parseSharedStateTransactionCommandV1(
      executeIdempotentCommand(
        entry.namespace,
        entry.retentionPolicyVersion,
        entry.effectKind,
      ),
    );
    assert.equal(parsed.ok, true, entry.namespace);
  }
});

test("policy evaluator rejects unknown, cross-paired, non-canonical, wildcard, Unicode, and extended inputs", () => {
  const [first, second] = sharedStateIdempotencyCatalogV1().entries;
  expectError(
    evaluateSharedStateIdempotencyPolicyV1({
      namespace: "broker.unknown",
      retentionPolicyVersion: first.retentionPolicyVersion,
      effectKind: first.effectKind,
    }),
    "unknown_namespace",
    ["namespace"],
  );
  expectError(
    evaluateSharedStateIdempotencyPolicyV1({
      namespace: first.namespace,
      retentionPolicyVersion: "unknown-effects.v1",
      effectKind: first.effectKind,
    }),
    "unknown_retention_policy_version",
    ["retentionPolicyVersion"],
  );
  expectError(
    evaluateSharedStateIdempotencyPolicyV1({
      namespace: first.namespace,
      retentionPolicyVersion: second.retentionPolicyVersion,
      effectKind: first.effectKind,
    }),
    "retention_policy_mismatch",
    ["retentionPolicyVersion"],
  );
  expectError(
    evaluateSharedStateIdempotencyPolicyV1({
      namespace: first.namespace,
      retentionPolicyVersion: first.retentionPolicyVersion,
      effectKind: "domain-mutation-only",
    }),
    "effect_policy_mismatch",
    ["effectKind"],
  );

  for (const invalidNamespace of [
    "Broker.task.create",
    "broker.*",
    "broker.task.é",
  ]) {
    expectError(
      evaluateSharedStateIdempotencyPolicyV1({
        namespace: invalidNamespace,
        retentionPolicyVersion: first.retentionPolicyVersion,
        effectKind: first.effectKind,
      }),
      "invalid_namespace",
      ["namespace"],
    );
  }
  expectError(
    evaluateSharedStateIdempotencyPolicyV1({
      namespace: first.namespace,
      retentionPolicyVersion: "Task-Effects.v1",
      effectKind: first.effectKind,
    }),
    "invalid_retention_policy_version",
    ["retentionPolicyVersion"],
  );
  expectError(
    evaluateSharedStateIdempotencyPolicyV1({
      namespace: first.namespace,
      retentionPolicyVersion: first.retentionPolicyVersion,
      effectKind: first.effectKind,
      callerExtension: true,
    }),
    "unknown_field",
    ["callerExtension"],
  );
});

test("catalog parser rejects duplicates, incomplete evidence mapping, and unsafe retention postures", () => {
  expectError(
    parseSharedStateIdempotencyCatalogV1(null),
    "invalid_type",
  );

  const unknownField = catalogClone() as unknown as Record<string, unknown>;
  unknownField["extension"] = true;
  expectError(
    parseSharedStateIdempotencyCatalogV1(unknownField),
    "unknown_field",
    ["extension"],
  );

  const invalidKind = catalogClone() as unknown as { kind: string };
  invalidKind.kind = "OtherCatalog";
  expectError(
    parseSharedStateIdempotencyCatalogV1(invalidKind),
    "invalid_value",
    ["kind"],
  );

  const unknownVersion = catalogClone() as unknown as {
    catalogVersion: string;
  };
  unknownVersion.catalogVersion = "a2a.shared-state.idempotency/v2";
  expectError(
    parseSharedStateIdempotencyCatalogV1(unknownVersion),
    "unknown_catalog_version",
    ["catalogVersion"],
  );

  const duplicateNamespace = catalogClone();
  duplicateNamespace.entries[1].namespace =
    duplicateNamespace.entries[0].namespace;
  expectError(
    parseSharedStateIdempotencyCatalogV1(duplicateNamespace),
    "duplicate_namespace",
    ["entries", 1, "namespace"],
  );

  const duplicateRetention = catalogClone();
  duplicateRetention.entries[1].retentionPolicyVersion =
    duplicateRetention.entries[0].retentionPolicyVersion;
  expectError(
    parseSharedStateIdempotencyCatalogV1(duplicateRetention),
    "duplicate_retention_policy_version",
    ["entries", 1, "retentionPolicyVersion"],
  );

  const duplicateAuthority = catalogClone();
  duplicateAuthority.authorities[1].authorityId =
    duplicateAuthority.authorities[0].authorityId;
  expectError(
    parseSharedStateIdempotencyCatalogV1(duplicateAuthority),
    "duplicate_authority",
    ["authorities", 1, "authorityId"],
  );

  const unknownAuthority = catalogClone();
  unknownAuthority.entries[0].authorityId = "missing-authority";
  expectError(
    parseSharedStateIdempotencyCatalogV1(unknownAuthority),
    "unknown_authority",
    ["entries", 0, "authorityId"],
  );

  const mappingMismatch = catalogClone();
  mappingMismatch.authorities[0].plannedNamespace =
    mappingMismatch.entries[1].namespace;
  expectError(
    parseSharedStateIdempotencyCatalogV1(mappingMismatch),
    "authority_mapping_mismatch",
    ["entries", 0, "namespace"],
  );

  const invalidCatalogNamespace = catalogClone();
  invalidCatalogNamespace.authorities[0].plannedNamespace = "broker.*";
  invalidCatalogNamespace.entries[0].namespace = "broker.*";
  expectError(
    parseSharedStateIdempotencyCatalogV1(invalidCatalogNamespace),
    "invalid_namespace",
    ["authorities", 0, "plannedNamespace"],
  );

  const invalidCatalogRetention = catalogClone();
  invalidCatalogRetention.entries[0].retentionPolicyVersion =
    "Task-Effects.v1";
  expectError(
    parseSharedStateIdempotencyCatalogV1(invalidCatalogRetention),
    "invalid_retention_policy_version",
    ["entries", 0, "retentionPolicyVersion"],
  );

  const unsafeExpiry = catalogClone();
  unsafeExpiry.entries[0].expiryPosture = "time-bounded";
  unsafeExpiry.entries[0].logicalExpiryBoundaryKind =
    "idempotency-explicit-retention";
  expectError(
    parseSharedStateIdempotencyCatalogV1(unsafeExpiry),
    "unsafe_expiry_policy",
    ["entries", 0, "expiryPosture"],
  );

  const unsafeDurability = catalogClone();
  unsafeDurability.entries[0].durability = "volatile";
  expectError(
    parseSharedStateIdempotencyCatalogV1(unsafeDurability),
    "unsafe_expiry_policy",
    ["entries", 0, "durability"],
  );

  const unsafeDependency = catalogClone();
  unsafeDependency.entries[0].requiredEffectDependency = "outbox";
  expectError(
    parseSharedStateIdempotencyCatalogV1(unsafeDependency),
    "unsafe_expiry_policy",
    ["entries", 0, "requiredEffectDependency"],
  );

  const unsafePrune = catalogClone();
  unsafePrune.entries[0].pruneEligibilityPreconditions =
    unsafePrune.entries[0].pruneEligibilityPreconditions.slice(1);
  expectError(
    parseSharedStateIdempotencyCatalogV1(unsafePrune),
    "unsafe_expiry_policy",
    ["entries", 0, "pruneEligibilityPreconditions"],
  );

  const boundaryMismatch = catalogClone();
  boundaryMismatch.entries[0].logicalExpiryBoundaryKind =
    "idempotency-explicit-retention";
  expectError(
    parseSharedStateIdempotencyCatalogV1(boundaryMismatch),
    "expiry_boundary_requirement_mismatch",
    ["entries", 0, "logicalExpiryBoundaryKind"],
  );
});

test("time-bounded policy is limited to reversible/non-effecting entries and requires the time-v1 logical boundary", () => {
  const catalog = catalogClone();
  const entry = catalog.entries[0];
  entry.effectClass = "reversible";
  entry.expiryPosture = "time-bounded";
  entry.logicalExpiryBoundaryKind = "idempotency-explicit-retention";
  const parsed = parseSharedStateIdempotencyCatalogV1(catalog);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const expiring = parsed.value.entries[0];

  expectError(
    evaluateSharedStateIdempotencyExpiryV1(expiring),
    "expiry_boundary_required",
    ["boundary"],
  );
  expectError(
    evaluateSharedStateIdempotencyExpiryV1(expiring, {
      timeVersion: V.timeVersion,
      kind: "lease",
      expiresAtUnixMs: "1000",
    }),
    "invalid_expiry_boundary",
    ["boundary", "kind"],
  );
  expectError(
    evaluateSharedStateIdempotencyExpiryV1(expiring, {
      timeVersion: "a2a.shared-state.time/v2",
      kind: "idempotency-explicit-retention",
      expiresAtUnixMs: "1000",
    }),
    "invalid_expiry_boundary",
    ["boundary", "timeVersion"],
  );
  const accepted = evaluateSharedStateIdempotencyExpiryV1(expiring, {
    timeVersion: V.timeVersion,
    kind: "idempotency-explicit-retention",
    expiresAtUnixMs: "1000",
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    observedReasonCodes.add(accepted.value.reasonCode);
    assert.equal(accepted.value.decision, "time-bounded");
    assert.equal(accepted.value.boundary.expiresAtUnixMs, "1000");
  }

  expectError(
    evaluateSharedStateIdempotencyExpiryV1(
      sharedStateIdempotencyCatalogV1().entries[0],
      {
        timeVersion: V.timeVersion,
        kind: "idempotency-explicit-retention",
        expiresAtUnixMs: "1000",
      },
    ),
    "expiry_boundary_forbidden",
    ["boundary"],
  );
});

test("section 6.1 executeIdempotent integration returns stable catalog codes and paths", () => {
  const [first, second] = sharedStateIdempotencyCatalogV1().entries;
  const cases = [
    {
      command: executeIdempotentCommand(
        "broker.unknown",
        first.retentionPolicyVersion,
      ),
      code: "unknown_idempotency_namespace",
      path: ["input", "namespace"],
    },
    {
      command: executeIdempotentCommand(
        first.namespace,
        "unknown-effects.v1",
      ),
      code: "unknown_idempotency_retention_policy_version",
      path: ["input", "retentionPolicyVersion"],
    },
    {
      command: executeIdempotentCommand(
        first.namespace,
        second.retentionPolicyVersion,
      ),
      code: "idempotency_retention_policy_mismatch",
      path: ["input", "retentionPolicyVersion"],
    },
    {
      command: executeIdempotentCommand(
        first.namespace,
        first.retentionPolicyVersion,
        "domain-mutation-only",
      ),
      code: "idempotency_effect_policy_mismatch",
      path: ["input", "effect", "kind"],
    },
    {
      command: executeIdempotentCommand(
        "Broker.task.create",
        first.retentionPolicyVersion,
      ),
      code: "invalid_idempotency_namespace",
      path: ["input", "namespace"],
    },
    {
      command: executeIdempotentCommand(
        "broker.*",
        first.retentionPolicyVersion,
      ),
      code: "invalid_idempotency_namespace",
      path: ["input", "namespace"],
    },
    {
      command: executeIdempotentCommand(
        "broker.task.é",
        first.retentionPolicyVersion,
      ),
      code: "invalid_idempotency_namespace",
      path: ["input", "namespace"],
    },
    {
      command: executeIdempotentCommand(
        first.namespace,
        "Task-Effects.v1",
      ),
      code: "invalid_idempotency_retention_policy_version",
      path: ["input", "retentionPolicyVersion"],
    },
  ] as const;

  for (const item of cases) {
    const parsed = parseSharedStateTransactionCommandV1(item.command);
    assert.equal(parsed.ok, false);
    if (parsed.ok) continue;
    assert.equal(parsed.error.code, item.code);
    assert.deepEqual(parsed.error.path, item.path);
  }

  const extra = executeIdempotentCommand(
    first.namespace,
    first.retentionPolicyVersion,
  );
  (extra.input as Record<string, unknown>)["callerExtension"] = true;
  const parsedExtra = parseSharedStateTransactionCommandV1(extra);
  assert.equal(parsedExtra.ok, false);
  if (!parsedExtra.ok) {
    assert.equal(parsedExtra.error.code, "unknown_field");
    assert.deepEqual(parsedExtra.error.path, ["input", "callerExtension"]);
  }
});

test("unrelated replay, rate, lease, and graph operations retain generic namespace behavior", () => {
  const namespace = "caller.unregistered";
  const inputs = {
    consumeReplayNonce: {
      namespace,
      keyDigest: digest("security.replay.requester-key", namespace, "1"),
      nonceDigest: digest("security.replay.nonce", namespace, "2"),
      ttlMs: 1000,
    },
    reserveRateLimitCost: {
      namespace,
      bucketKeyDigest: digest(
        "security.rate-limit.bucket-key",
        namespace,
        "3",
      ),
      cost: 1,
      limit: 10,
      windowMs: 1000,
    },
    claimLease: {
      namespace,
      resourceKeyDigest: digest(
        "broker.lease.resource-key",
        namespace,
        "4",
      ),
      ownerKeyDigest: digest("broker.lease.owner-key", namespace, "5"),
      leaseDurationMs: 1000,
      expectedResourceVersion: "0",
    },
    appendGraphSource: {
      namespace,
      sourceStreamKeyDigest: digest(
        "broker.claim-graph.source-stream-key",
        namespace,
        "a",
      ),
      sourceFactDigest: digest(
        "broker.claim-graph.source-fact",
        namespace,
        "b",
      ),
      nodeType: "Claim",
      expectedSourceSequence: "0",
    },
  } as const;
  for (const [operation, input] of Object.entries(inputs)) {
    assert.equal(
      parseSharedStateTransactionCommandV1(command(operation, input)).ok,
      true,
      operation,
    );
  }
});

test("every idempotency catalog error and evaluation reason code is exercised", () => {
  assert.deepEqual(
    [...observedErrorCodes].sort(),
    [...V.errorCodes].sort(),
  );
  assert.deepEqual(
    [...observedReasonCodes].sort(),
    [...V.evaluationReasonCodes].sort(),
  );
});

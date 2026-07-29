import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
} from "./shared-state-storage-v1-values.js";
import {
  canonicalizeSharedStateKeyV1,
  digestSharedStateKeyV1,
  parseSharedStateDigestV1,
  type SharedStateDigestDomainV1,
  type SharedStateKeyspaceErrorCodeV1,
  type SharedStateKeyspaceResultV1,
} from "./shared-state-storage-keyspace-v1.js";

interface GoldenComponent {
  field: string;
  type: "utf8" | "uint" | "bytes";
  value: string | number;
}

interface GoldenVector {
  id: string;
  domain: SharedStateDigestDomainV1;
  namespace: string;
  components: GoldenComponent[];
  canonicalHex: string;
  digest: string;
}

interface GoldenFixture {
  fixtureVersion: number;
  keyspaceVersion: string;
  algorithm: string;
  description: string;
  vectors: GoldenVector[];
}

const fixture = JSON.parse(
  readFileSync(
    "fixtures/shared-state-storage/keyspace-v1-golden.json",
    "utf8",
  ),
) as GoldenFixture;

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

/**
 * Intentionally independent fixture verifier. It does not call the production
 * canonicalizer and pins every framing byte locally.
 */
function independentCanonicalBytes(
  vector: Pick<
    GoldenVector,
    "domain" | "namespace" | "components"
  > & { keyspaceVersion?: string },
): Buffer {
  const typeTags = { utf8: 1, uint: 2, bytes: 3 } as const;
  const frames = vector.components.map((component) => {
    let valueBytes: Buffer;
    if (component.type === "utf8") {
      if (typeof component.value !== "string") {
        throw new TypeError("utf8 fixture component must be a string");
      }
      valueBytes = Buffer.from(component.value.normalize("NFC"), "utf8");
    } else if (component.type === "bytes") {
      if (typeof component.value !== "string") {
        throw new TypeError("bytes fixture component must be a string");
      }
      valueBytes = Buffer.from(component.value.toLowerCase(), "hex");
    } else {
      valueBytes = Buffer.from(
        BigInt(component.value).toString(16).padStart(32, "0"),
        "hex",
      );
    }
    return Buffer.concat([
      shortFrame(Buffer.from(component.field, "ascii")),
      Buffer.from([typeTags[component.type]]),
      u32(valueBytes.length),
      valueBytes,
    ]);
  });
  return Buffer.concat([
    Buffer.from("4132412d53534b", "hex"),
    Buffer.from([1]),
    shortFrame(
      Buffer.from(vector.keyspaceVersion ?? V.versions.keyspace, "ascii"),
    ),
    shortFrame(Buffer.from(vector.domain, "ascii")),
    shortFrame(Buffer.from(vector.namespace, "ascii")),
    u16(frames.length),
    ...frames,
  ]);
}

function expectError<T>(
  result: SharedStateKeyspaceResultV1<T>,
  code: SharedStateKeyspaceErrorCodeV1,
  path?: readonly (string | number)[],
): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, code);
  if (path !== undefined) assert.deepEqual(result.error.path, path);
}

function material(
  domain: SharedStateDigestDomainV1,
  components: readonly GoldenComponent[],
  namespace = "fixture.synthetic",
): unknown {
  return {
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace,
    components,
  };
}

const EXPECTED_OPERATION_DIGEST_FIELDS = {
  consumeReplayNonce: [
    "input.keyDigest",
    "input.nonceDigest",
  ],
  reserveRateLimitCost: [
    "input.bucketKeyDigest",
  ],
  claimLease: [
    "input.resourceKeyDigest",
    "input.ownerKeyDigest",
    "result.attemptKeyDigest",
  ],
  renewLease: [
    "input.resourceKeyDigest",
    "input.ownerKeyDigest",
    "input.attemptKeyDigest",
  ],
  mutateWithFence: [
    "input.resourceKeyDigest",
    "input.ownerKeyDigest",
    "input.attemptKeyDigest",
    "input.mutationDigest",
  ],
  releaseLease: [
    "input.resourceKeyDigest",
    "input.ownerKeyDigest",
    "input.attemptKeyDigest",
  ],
  executeIdempotent: [
    "input.keyDigest",
    "input.payloadFingerprint",
    "input.effect.domainMutationDigest",
    "input.effect.outbox.streamKeyDigest",
    "input.effect.outbox.eventKeyDigest",
    "input.effect.outbox.payloadDigest",
    "result.outcomeDigest",
  ],
  appendOutbox: [
    "input.streamKeyDigest",
    "input.idempotencyKeyDigest",
    "input.eventKeyDigest",
    "input.payloadDigest",
    "result.eventKeyDigest",
  ],
  updateOutboxReceipt: [
    "input.streamKeyDigest",
    "input.eventKeyDigest",
    "input.receiptEvidenceDigest",
  ],
  acknowledgeOutbox: [
    "input.streamKeyDigest",
    "input.eventKeyDigest",
    "input.receiptEvidenceDigest",
  ],
  appendGraphSource: [
    "input.sourceStreamKeyDigest",
    "input.sourceFactDigest",
  ],
  applyGraphProjectionBatch: [
    "input.batchKeyDigest",
    "input.batchDigest",
    "input.inverseDigest",
  ],
  rollbackGraphProjectionBatch: [
    "input.batchKeyDigest",
    "input.rollbackBatchKeyDigest",
    "input.inverseDigest",
  ],
} as const;

test("golden fixture independently recomputes every registered domain vector", () => {
  assert.equal(fixture.fixtureVersion, 1);
  assert.equal(fixture.keyspaceVersion, V.versions.keyspace);
  assert.equal(fixture.algorithm, "sha256");
  assert.match(fixture.description, /Public non-secret/);

  const fixtureDomains = fixture.vectors.map((vector) => vector.domain).sort();
  const registeredDomains = Object.keys(V.digestDomains).sort();
  assert.deepEqual(fixtureDomains, registeredDomains);
  assert.equal(new Set(fixtureDomains).size, fixtureDomains.length);

  for (const vector of fixture.vectors) {
    const specification = V.digestDomains[vector.domain];
    assert.deepEqual(
      vector.components.map(({ field, type }) => ({ field, type })),
      specification.components,
      vector.id,
    );
    const independent = independentCanonicalBytes(vector);
    assert.equal(independent.toString("hex"), vector.canonicalHex, vector.id);
    const independentHex = createHash("sha256")
      .update(independent)
      .digest("hex");
    assert.equal(
      vector.digest,
      `${V.versions.keyspace}|${vector.domain}|${vector.namespace}|sha256:${independentHex}`,
      vector.id,
    );

    const computed = digestSharedStateKeyV1({
      keyspaceVersion: V.versions.keyspace,
      domain: vector.domain,
      namespace: vector.namespace,
      components: vector.components,
    });
    assert.equal(computed.ok, true, vector.id);
    if (!computed.ok) continue;
    assert.equal(
      Buffer.from(computed.value.canonicalBytes).toString("hex"),
      vector.canonicalHex,
      vector.id,
    );
    assert.equal(computed.value.digest, vector.digest, vector.id);
    assert.equal(
      parseSharedStateDigestV1(vector.digest, {
        domain: vector.domain,
        namespace: vector.namespace,
      }).ok,
      true,
      vector.id,
    );

    const rawText = vector.components
      .map((component) =>
        component.type === "bytes"
          ? Buffer.from(String(component.value), "hex").toString("utf8")
          : String(component.value),
      )
      .join("|");
    assert.match(rawText.toLowerCase(), /synthetic/, vector.id);
  }
});

test("catalog covers every digest-bearing field of all 13 operations exactly once", () => {
  assert.deepEqual(Object.keys(EXPECTED_OPERATION_DIGEST_FIELDS), V.operations);
  const expected = Object.entries(EXPECTED_OPERATION_DIGEST_FIELDS)
    .flatMap(([operation, fields]) =>
      fields.map((field) => `${operation}.${field}`),
    )
    .sort();
  const registered = Object.values(V.digestDomains)
    .flatMap((specification) => specification.operationFields)
    .sort();
  assert.deepEqual(registered, expected);
  assert.equal(new Set(registered).size, registered.length);
});

test("length framing defeats delimiter ambiguity and component reordering", () => {
  const left = material("security.rate-limit.bucket-key", [
    { field: "principal", type: "utf8", value: "a|bc" },
    { field: "route", type: "utf8", value: "d" },
  ]);
  const right = material("security.rate-limit.bucket-key", [
    { field: "principal", type: "utf8", value: "a" },
    { field: "route", type: "utf8", value: "bc|d" },
  ]);
  const leftDigest = digestSharedStateKeyV1(left);
  const rightDigest = digestSharedStateKeyV1(right);
  assert.equal(leftDigest.ok, true);
  assert.equal(rightDigest.ok, true);
  if (leftDigest.ok && rightDigest.ok) {
    assert.notEqual(leftDigest.value.digest, rightDigest.value.digest);
    assert.notDeepEqual(
      leftDigest.value.canonicalBytes,
      rightDigest.value.canonicalBytes,
    );
  }

  expectError(
    canonicalizeSharedStateKeyV1(
      material("security.rate-limit.bucket-key", [
        { field: "route", type: "utf8", value: "d" },
        { field: "principal", type: "utf8", value: "a|bc" },
      ]),
    ),
    "component_order_mismatch",
    ["components", 0, "field"],
  );
});

test("Unicode-equivalent UTF-8 inputs normalize to exactly one NFC key", () => {
  const composed = digestSharedStateKeyV1(
    material("security.replay.requester-key", [
      { field: "requesterId", type: "utf8", value: "synthetic-café" },
    ]),
  );
  const decomposed = digestSharedStateKeyV1(
    material("security.replay.requester-key", [
      { field: "requesterId", type: "utf8", value: "synthetic-cafe\u0301" },
    ]),
  );
  assert.equal(composed.ok, true);
  assert.equal(decomposed.ok, true);
  if (composed.ok && decomposed.ok) {
    assert.equal(composed.value.digest, decomposed.value.digest);
    assert.deepEqual(
      composed.value.canonicalBytes,
      decomposed.value.canonicalBytes,
    );
    assert.equal(decomposed.value.components[0]?.value, "synthetic-café");
  }

  expectError(
    canonicalizeSharedStateKeyV1(
      material("security.replay.requester-key", [
        { field: "requesterId", type: "utf8", value: "\ud800" },
      ]),
    ),
    "invalid_unicode",
    ["components", 0, "value"],
  );
});

test("version, purpose domain, and namespace separation fail closed", () => {
  const payload = "53594E5448455449432D53414D452D4259544553";
  const idempotency = digestSharedStateKeyV1(
    material("broker.idempotency.payload-fingerprint", [
      { field: "payload", type: "bytes", value: payload },
    ]),
  );
  const outbox = digestSharedStateKeyV1(
    material("broker.outbox.payload", [
      { field: "payload", type: "bytes", value: payload },
    ]),
  );
  assert.equal(idempotency.ok, true);
  assert.equal(outbox.ok, true);
  if (idempotency.ok && outbox.ok) {
    assert.notEqual(idempotency.value.digest, outbox.value.digest);
    expectError(
      parseSharedStateDigestV1(idempotency.value.digest, {
        domain: "broker.outbox.payload",
      }),
      "digest_domain_mismatch",
      ["domain"],
    );
    expectError(
      parseSharedStateDigestV1(idempotency.value.digest, {
        namespace: "fixture.other",
      }),
      "digest_namespace_mismatch",
      ["namespace"],
    );
  }

  const vector = fixture.vectors[0] as GoldenVector;
  const v1Bytes = independentCanonicalBytes(vector);
  const v2Bytes = independentCanonicalBytes({
    ...vector,
    keyspaceVersion: "a2a.shared-state.keyspace/v2",
  });
  assert.notEqual(
    createHash("sha256").update(v1Bytes).digest("hex"),
    createHash("sha256").update(v2Bytes).digest("hex"),
  );
  expectError(
    canonicalizeSharedStateKeyV1({
      keyspaceVersion: "a2a.shared-state.keyspace/v2",
      domain: vector.domain,
      namespace: vector.namespace,
      components: vector.components,
    }),
    "unknown_keyspace_version",
    ["keyspaceVersion"],
  );
});

test("unknown versions, domains, fields, and component types are rejected", () => {
  const valid = {
    keyspaceVersion: V.versions.keyspace,
    domain: "security.replay.nonce",
    namespace: "fixture.synthetic",
    components: [
      { field: "nonce", type: "utf8", value: "synthetic-nonce" },
    ],
  };
  expectError(
    canonicalizeSharedStateKeyV1({ ...valid, extra: true }),
    "unknown_field",
    ["extra"],
  );
  expectError(
    canonicalizeSharedStateKeyV1({
      ...valid,
      domain: "security.replay.unknown",
    }),
    "unknown_digest_domain",
    ["domain"],
  );
  expectError(
    canonicalizeSharedStateKeyV1({
      ...valid,
      components: [
        { field: "unknownNonce", type: "utf8", value: "synthetic-nonce" },
      ],
    }),
    "unknown_component_field",
    ["components", 0, "field"],
  );
  expectError(
    canonicalizeSharedStateKeyV1({
      ...valid,
      components: [
        { field: "nonce", type: "float", value: "synthetic-nonce" },
      ],
    }),
    "unknown_component_type",
    ["components", 0, "type"],
  );
  expectError(
    canonicalizeSharedStateKeyV1({
      ...valid,
      components: [
        { field: "nonce", type: "bytes", value: "53594e544845544943" },
      ],
    }),
    "component_type_mismatch",
    ["components", 0, "type"],
  );
  expectError(
    canonicalizeSharedStateKeyV1({
      ...valid,
      components: [
        {
          field: "nonce",
          type: "utf8",
          value: "synthetic-nonce",
          extra: true,
        },
      ],
    }),
    "unknown_field",
    ["components", 0, "extra"],
  );
  expectError(
    canonicalizeSharedStateKeyV1({
      ...valid,
      components: [],
    }),
    "invalid_component_count",
    ["components"],
  );
});

test("empty, oversized, unsafe-number, and malformed-byte values fail closed", () => {
  expectError(
    canonicalizeSharedStateKeyV1(
      material(
        "security.replay.nonce",
        [{ field: "nonce", type: "utf8", value: "synthetic-nonce" }],
        "",
      ),
    ),
    "invalid_namespace",
    ["namespace"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material(
        "security.replay.nonce",
        [{ field: "nonce", type: "utf8", value: "synthetic-nonce" }],
        "a".repeat(V.limits.namespaceLength + 1),
      ),
    ),
    "invalid_namespace",
    ["namespace"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("security.replay.nonce", [
        { field: "nonce", type: "utf8", value: "" },
      ]),
    ),
    "empty_component",
    ["components", 0, "value"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("security.replay.nonce", [
        {
          field: "nonce",
          type: "utf8",
          value: "s".repeat(V.limits.maxKeyComponentBytes + 1),
        },
      ]),
    ),
    "component_too_large",
    ["components", 0, "value"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("broker.outbox.payload", [
        { field: "payload", type: "bytes", value: "" },
      ]),
    ),
    "empty_component",
    ["components", 0, "value"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("broker.outbox.payload", [
        { field: "payload", type: "bytes", value: "abc" },
      ]),
    ),
    "invalid_bytes",
    ["components", 0, "value"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("broker.outbox.payload", [
        { field: "payload", type: "bytes", value: "zz" },
      ]),
    ),
    "invalid_bytes",
    ["components", 0, "value"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("broker.outbox.payload", [
        {
          field: "payload",
          type: "bytes",
          value: "aa".repeat(V.limits.maxKeyComponentBytes + 1),
        },
      ]),
    ),
    "component_too_large",
    ["components", 0, "value"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("broker.lease.attempt-key", [
        {
          field: "resourceId",
          type: "utf8",
          value: "synthetic-resource",
        },
        {
          field: "attemptNumber",
          type: "uint",
          value: Number.MAX_SAFE_INTEGER + 1,
        },
      ]),
    ),
    "unsafe_integer",
    ["components", 1, "value"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("broker.lease.attempt-key", [
        {
          field: "resourceId",
          type: "utf8",
          value: "synthetic-resource",
        },
        { field: "attemptNumber", type: "uint", value: "01" },
      ]),
    ),
    "invalid_integer",
    ["components", 1, "value"],
  );
  expectError(
    canonicalizeSharedStateKeyV1(
      material("broker.lease.attempt-key", [
        {
          field: "resourceId",
          type: "utf8",
          value: "synthetic-resource",
        },
        {
          field: "attemptNumber",
          type: "uint",
          value: "340282366920938463463374607431768211456",
        },
      ]),
    ),
    "invalid_integer",
    ["components", 1, "value"],
  );
});

test("safe integer, decimal, and byte-case inputs canonicalize exactly", () => {
  const numberInput = digestSharedStateKeyV1(
    material("broker.lease.attempt-key", [
      { field: "resourceId", type: "utf8", value: "synthetic-resource" },
      { field: "attemptNumber", type: "uint", value: 42 },
    ]),
  );
  const decimalInput = digestSharedStateKeyV1(
    material("broker.lease.attempt-key", [
      { field: "resourceId", type: "utf8", value: "synthetic-resource" },
      { field: "attemptNumber", type: "uint", value: "42" },
    ]),
  );
  assert.equal(numberInput.ok, true);
  assert.equal(decimalInput.ok, true);
  if (numberInput.ok && decimalInput.ok) {
    assert.equal(numberInput.value.digest, decimalInput.value.digest);
    assert.equal(numberInput.value.components[1]?.value, "42");
  }
  assert.equal(
    digestSharedStateKeyV1(
      material("broker.lease.attempt-key", [
        { field: "resourceId", type: "utf8", value: "synthetic-resource" },
        {
          field: "attemptNumber",
          type: "uint",
          value: "340282366920938463463374607431768211455",
        },
      ]),
    ).ok,
    true,
  );

  const upper = digestSharedStateKeyV1(
    material("broker.outbox.payload", [
      { field: "payload", type: "bytes", value: "53594E544845544943" },
    ]),
  );
  const lower = digestSharedStateKeyV1(
    material("broker.outbox.payload", [
      { field: "payload", type: "bytes", value: "53594e544845544943" },
    ]),
  );
  assert.equal(upper.ok, true);
  assert.equal(lower.ok, true);
  if (upper.ok && lower.ok) {
    assert.equal(upper.value.digest, lower.value.digest);
    assert.equal(upper.value.components[0]?.value, "53594e544845544943");
  }
});

test("digest token parser rejects malformed, unknown, and noncanonical tokens", () => {
  const valid = fixture.vectors[0] as GoldenVector;
  expectError(parseSharedStateDigestV1("sha256:" + "0".repeat(64)), "invalid_digest");
  expectError(
    parseSharedStateDigestV1(
      valid.digest.replace(V.versions.keyspace, "a2a.shared-state.keyspace/v2"),
    ),
    "unknown_keyspace_version",
    ["keyspaceVersion"],
  );
  expectError(
    parseSharedStateDigestV1(
      valid.digest.replace(valid.domain, "security.replay.unknown"),
    ),
    "unknown_digest_domain",
    ["domain"],
  );
  expectError(
    parseSharedStateDigestV1(valid.digest.replace("fixture.synthetic", "Fixture")),
    "invalid_namespace",
    ["namespace"],
  );
  expectError(
    parseSharedStateDigestV1(valid.digest.replace(/.$/, "A")),
    "invalid_digest",
  );
});

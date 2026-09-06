/**
 * Backend-neutral key canonicalization and digest contract for
 * `a2a.shared-state.keyspace/v1`.
 *
 * This module has no broker runtime callsite. It only defines deterministic
 * canonical bytes, purpose-bound digest tokens, and fail-closed parsing.
 */

import { createHash } from "node:crypto";

import { SHARED_STATE_STORAGE_V1_VALUES as V } from "./shared-state-storage-v1-values.js";
import { isRecord } from "./core/value-guards.js";

export type SharedStateDigestDomainV1 = keyof typeof V.digestDomains;
export type SharedStateKeyComponentTypeV1 =
  (typeof V.keyComponentTypes)[number];
export type SharedStateKeyspaceErrorCodeV1 =
  (typeof V.keyspaceErrorCodes)[number];

export interface SharedStateKeyspaceErrorV1 {
  readonly code: SharedStateKeyspaceErrorCodeV1;
  readonly path: readonly (string | number)[];
}

export type SharedStateKeyspaceResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SharedStateKeyspaceErrorV1 };

export interface SharedStateKeyComponentInputV1 {
  readonly field: string;
  readonly type: SharedStateKeyComponentTypeV1;
  readonly value: string | number;
}

export interface SharedStateKeyMaterialInputV1 {
  readonly keyspaceVersion: typeof V.versions.keyspace;
  readonly domain: SharedStateDigestDomainV1;
  readonly namespace: string;
  readonly components: readonly SharedStateKeyComponentInputV1[];
}

export interface SharedStateNormalizedKeyComponentV1 {
  readonly field: string;
  readonly type: SharedStateKeyComponentTypeV1;
  /**
   * NFC text, canonical unsigned decimal, or lowercase even-length hex,
   * according to `type`.
   */
  readonly value: string;
}

export interface SharedStateCanonicalKeyV1 {
  readonly keyspaceVersion: typeof V.versions.keyspace;
  readonly domain: SharedStateDigestDomainV1;
  readonly namespace: string;
  readonly components: readonly SharedStateNormalizedKeyComponentV1[];
  readonly canonicalBytes: Uint8Array;
}

export interface SharedStateDigestV1 extends SharedStateCanonicalKeyV1 {
  readonly algorithm: typeof V.keyspace.algorithm;
  readonly digest: string;
}

export interface ParsedSharedStateDigestV1 {
  readonly keyspaceVersion: typeof V.versions.keyspace;
  readonly domain: SharedStateDigestDomainV1;
  readonly namespace: string;
  readonly algorithm: typeof V.keyspace.algorithm;
  readonly hex: string;
  readonly digest: string;
}

type RecordValue = Record<string, unknown>;

const UINT128_MAX = (1n << 128n) - 1n;
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const BYTE_HEX_PATTERN = /^(?:[0-9a-fA-F]{2})+$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/;
const TOP_LEVEL_FIELDS = [
  "keyspaceVersion",
  "domain",
  "namespace",
  "components",
] as const;
const COMPONENT_FIELDS = ["field", "type", "value"] as const;

function errorResult<T>(
  code: SharedStateKeyspaceErrorCodeV1,
  path: readonly (string | number)[] = [],
): SharedStateKeyspaceResultV1<T> {
  return {
    ok: false,
    error: Object.freeze({ code, path: Object.freeze([...path]) }),
  };
}

function firstUnknownField(
  value: RecordValue,
  allowed: readonly string[],
): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort()[0] ?? null;
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateNamespace(
  value: unknown,
  path: readonly (string | number)[],
): SharedStateKeyspaceResultV1<string> {
  if (typeof value !== "string") return errorResult("invalid_type", path);
  if (
    !NAMESPACE_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > V.limits.namespaceLength
  ) {
    return errorResult("invalid_namespace", path);
  }
  return { ok: true, value };
}

function normalizeUtf8(
  value: unknown,
  path: readonly (string | number)[],
): SharedStateKeyspaceResultV1<{ normalized: string; bytes: Uint8Array }> {
  if (typeof value !== "string") return errorResult("invalid_type", path);
  if (!hasOnlyUnicodeScalars(value)) return errorResult("invalid_unicode", path);
  const rawLength = Buffer.byteLength(value, "utf8");
  if (rawLength === 0) return errorResult("empty_component", path);
  if (rawLength > V.limits.maxKeyComponentBytes) {
    return errorResult("component_too_large", path);
  }
  const normalized = value.normalize(V.keyspace.unicodeNormalization);
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length === 0) return errorResult("empty_component", path);
  if (bytes.length > V.limits.maxKeyComponentBytes) {
    return errorResult("component_too_large", path);
  }
  return { ok: true, value: { normalized, bytes } };
}

function normalizeBytes(
  value: unknown,
  path: readonly (string | number)[],
): SharedStateKeyspaceResultV1<{ normalized: string; bytes: Uint8Array }> {
  if (typeof value !== "string") return errorResult("invalid_type", path);
  if (value.length === 0) return errorResult("empty_component", path);
  if (value.length > V.limits.maxKeyComponentBytes * 2) {
    return errorResult("component_too_large", path);
  }
  if (!BYTE_HEX_PATTERN.test(value)) return errorResult("invalid_bytes", path);
  const normalized = value.toLowerCase();
  const bytes = Buffer.from(normalized, "hex");
  if (bytes.length > V.limits.maxKeyComponentBytes) {
    return errorResult("component_too_large", path);
  }
  return { ok: true, value: { normalized, bytes } };
}

function normalizeUint(
  value: unknown,
  path: readonly (string | number)[],
): SharedStateKeyspaceResultV1<{ normalized: string; bytes: Uint8Array }> {
  let normalized: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return errorResult("unsafe_integer", path);
    if (value < 0) return errorResult("invalid_integer", path);
    normalized = String(value);
  } else if (typeof value === "string") {
    if (!DECIMAL_PATTERN.test(value)) return errorResult("invalid_integer", path);
    normalized = value;
  } else {
    return errorResult("invalid_type", path);
  }

  let integer: bigint;
  try {
    integer = BigInt(normalized);
  } catch {
    return errorResult("invalid_integer", path);
  }
  if (integer > UINT128_MAX) return errorResult("invalid_integer", path);
  const bytes = Buffer.from(integer.toString(16).padStart(32, "0"), "hex");
  return { ok: true, value: { normalized, bytes } };
}

function u16(value: number): Uint8Array {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function shortFrame(bytes: Uint8Array): Uint8Array {
  return Buffer.concat([u16(bytes.length), bytes]);
}

function componentFrame(
  field: string,
  type: SharedStateKeyComponentTypeV1,
  bytes: Uint8Array,
): Uint8Array {
  return Buffer.concat([
    shortFrame(Buffer.from(field, "ascii")),
    Buffer.from([V.keyComponentTypeTags[type]]),
    u32(bytes.length),
    bytes,
  ]);
}

export function canonicalizeSharedStateKeyV1(
  input: unknown,
): SharedStateKeyspaceResultV1<SharedStateCanonicalKeyV1> {
  if (!isRecord(input)) return errorResult("invalid_type");
  const unknownTopLevel = firstUnknownField(input, TOP_LEVEL_FIELDS);
  if (unknownTopLevel) return errorResult("unknown_field", [unknownTopLevel]);

  if (typeof input.keyspaceVersion !== "string") {
    return errorResult("invalid_type", ["keyspaceVersion"]);
  }
  if (input.keyspaceVersion !== V.versions.keyspace) {
    return errorResult("unknown_keyspace_version", ["keyspaceVersion"]);
  }
  if (typeof input.domain !== "string") {
    return errorResult("invalid_type", ["domain"]);
  }
  if (!Object.hasOwn(V.digestDomains, input.domain)) {
    return errorResult("unknown_digest_domain", ["domain"]);
  }
  const domain = input.domain as SharedStateDigestDomainV1;
  const namespace = validateNamespace(input.namespace, ["namespace"]);
  if (!namespace.ok) return namespace;
  if (!Array.isArray(input.components)) {
    return errorResult("invalid_type", ["components"]);
  }
  if (input.components.length > V.limits.maxKeyComponents) {
    return errorResult("invalid_component_count", ["components"]);
  }

  const specification = V.digestDomains[domain];
  if (input.components.length !== specification.components.length) {
    return errorResult("invalid_component_count", ["components"]);
  }

  const knownFields = new Set<string>(
    specification.components.map((component) => component.field),
  );
  const normalizedComponents: SharedStateNormalizedKeyComponentV1[] = [];
  const frames: Uint8Array[] = [];

  for (let index = 0; index < specification.components.length; index += 1) {
    const component = input.components[index];
    const expected = specification.components[index];
    const path = ["components", index] as const;
    if (!isRecord(component)) return errorResult("invalid_type", path);
    const unknownComponentField = firstUnknownField(component, COMPONENT_FIELDS);
    if (unknownComponentField) {
      return errorResult("unknown_field", [...path, unknownComponentField]);
    }
    if (typeof component.field !== "string") {
      return errorResult("invalid_type", [...path, "field"]);
    }
    if (!knownFields.has(component.field)) {
      return errorResult("unknown_component_field", [...path, "field"]);
    }
    if (component.field !== expected.field) {
      return errorResult("component_order_mismatch", [...path, "field"]);
    }
    if (typeof component.type !== "string") {
      return errorResult("invalid_type", [...path, "type"]);
    }
    if (
      !V.keyComponentTypes.includes(
        component.type as SharedStateKeyComponentTypeV1,
      )
    ) {
      return errorResult("unknown_component_type", [...path, "type"]);
    }
    if (component.type !== expected.type) {
      return errorResult("component_type_mismatch", [...path, "type"]);
    }

    const valuePath = [...path, "value"] as const;
    const normalized =
      expected.type === "utf8"
        ? normalizeUtf8(component.value, valuePath)
        : expected.type === "bytes"
          ? normalizeBytes(component.value, valuePath)
          : normalizeUint(component.value, valuePath);
    if (!normalized.ok) return normalized;
    normalizedComponents.push({
      field: expected.field,
      type: expected.type,
      value: normalized.value.normalized,
    });
    frames.push(
      componentFrame(expected.field, expected.type, normalized.value.bytes),
    );
  }

  const versionBytes = Buffer.from(V.versions.keyspace, "ascii");
  const domainBytes = Buffer.from(domain, "ascii");
  const namespaceBytes = Buffer.from(namespace.value, "ascii");
  const canonicalBytes = Buffer.concat([
    Buffer.from(V.keyspace.framingMagicHex, "hex"),
    Buffer.from([V.keyspace.framingVersion]),
    shortFrame(versionBytes),
    shortFrame(domainBytes),
    shortFrame(namespaceBytes),
    u16(frames.length),
    ...frames,
  ]);

  return {
    ok: true,
    value: {
      keyspaceVersion: V.versions.keyspace,
      domain,
      namespace: namespace.value,
      components: normalizedComponents,
      canonicalBytes,
    },
  };
}

export function digestSharedStateKeyV1(
  input: unknown,
): SharedStateKeyspaceResultV1<SharedStateDigestV1> {
  const canonical = canonicalizeSharedStateKeyV1(input);
  if (!canonical.ok) return canonical;
  const hex = createHash(V.keyspace.algorithm)
    .update(canonical.value.canonicalBytes)
    .digest("hex");
  const digest = [
    V.versions.keyspace,
    canonical.value.domain,
    canonical.value.namespace,
    `${V.keyspace.algorithm}:${hex}`,
  ].join(V.keyspace.digestSeparator);
  return {
    ok: true,
    value: {
      ...canonical.value,
      algorithm: V.keyspace.algorithm,
      digest,
    },
  };
}

export function parseSharedStateDigestV1(
  input: unknown,
  expected: {
    readonly domain?: SharedStateDigestDomainV1;
    readonly namespace?: string;
  } = {},
): SharedStateKeyspaceResultV1<ParsedSharedStateDigestV1> {
  if (typeof input !== "string") return errorResult("invalid_type");
  const parts = input.split(V.keyspace.digestSeparator);
  if (parts.length !== 4) return errorResult("invalid_digest");
  const [keyspaceVersion, rawDomain, rawNamespace, algorithmAndHex] = parts;
  if (keyspaceVersion !== V.versions.keyspace) {
    return errorResult("unknown_keyspace_version", ["keyspaceVersion"]);
  }
  if (!Object.hasOwn(V.digestDomains, rawDomain)) {
    return errorResult("unknown_digest_domain", ["domain"]);
  }
  const domain = rawDomain as SharedStateDigestDomainV1;
  const namespace = validateNamespace(rawNamespace, ["namespace"]);
  if (!namespace.ok) return namespace;
  const algorithmPrefix = `${V.keyspace.algorithm}:`;
  if (!algorithmAndHex.startsWith(algorithmPrefix)) {
    return errorResult("invalid_digest");
  }
  const hex = algorithmAndHex.slice(algorithmPrefix.length);
  if (!DIGEST_HEX_PATTERN.test(hex)) return errorResult("invalid_digest");
  if (expected.domain !== undefined && domain !== expected.domain) {
    return errorResult("digest_domain_mismatch", ["domain"]);
  }
  if (
    expected.namespace !== undefined &&
    namespace.value !== expected.namespace
  ) {
    return errorResult("digest_namespace_mismatch", ["namespace"]);
  }
  return {
    ok: true,
    value: {
      keyspaceVersion: V.versions.keyspace,
      domain,
      namespace: namespace.value,
      algorithm: V.keyspace.algorithm,
      hex,
      digest: input,
    },
  };
}

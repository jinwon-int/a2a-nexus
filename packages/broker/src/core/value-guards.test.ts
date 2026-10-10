import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { approvalNotExpired, approvedAtValid, coversAll, isRecord, stableId, stableStringify } from "./value-guards.js";

// ---------------------------------------------------------------------------
// #2047 — canonical-form pin for the shared `stableStringify`.
//
// 24 of the repo's 25 `stableStringify` copies were byte-different but
// behaviourally identical; they all seed `sha256(...)` idempotency keys and
// evidence ids that are already published. This file pins the exact observable
// behaviour of that consolidated variant, so a later "cleanup" (switching to
// `JSON.stringify` with a sort-replacer, dropping `undefined`, normalising
// array holes) fails loudly instead of silently re-keying evidence.
//
// The single non-conforming copy — `github/terminal-brief-evidence.ts` — is
// deliberately NOT consolidated; the last test here pins the fact that the two
// forms disagree, which is the reason for keeping them apart.
// ---------------------------------------------------------------------------

test("stableStringify sorts object keys by UTF-16 code unit, not numerically", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // "10" < "2" lexicographically. A numeric-aware sort would flip these.
  assert.equal(stableStringify({ "2": 5, "10": 4 }), '{"10":4,"2":5}');
  assert.equal(
    stableStringify({ "é": 1, a: 2, Z: 3 }),
    '{"Z":3,"a":2,"é":1}',
  );
});

test("stableStringify retains undefined members as the literal token", () => {
  // JSON.stringify would drop `b` entirely; this variant must not.
  assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1,"b":undefined}');
  assert.equal(stableStringify({ a: { b: undefined, c: 1 } }), '{"a":{"b":undefined,"c":1}}');
  assert.equal(stableStringify({ a: [{ b: undefined }] }), '{"a":[{"b":undefined}]}');
});

test("stableStringify emits array holes as empty slots, not null", () => {
  assert.equal(stableStringify([1, undefined, 2]), "[1,,2]");
  assert.equal(stableStringify([undefined]), "[]");
  assert.equal(stableStringify([]), "[]");
});

test("stableStringify walks structurally and never consults toJSON", () => {
  const withToJson = { toJSON: () => ({ z: 1 }) };
  assert.equal(stableStringify({ a: withToJson }), '{"a":{"toJSON":undefined}}');
  // Date has a toJSON; structurally it has no own enumerable keys.
  assert.equal(stableStringify({ d: new Date(0) }), '{"d":{}}');
});

test("stableStringify handles primitives and nesting", () => {
  assert.equal(stableStringify(null), "null");
  // Note: at the top level this leaks the raw `undefined` value through
  // JSON.stringify, despite the `: string` return type. Nested positions turn
  // it into the literal token via template interpolation (see above).
  assert.equal(stableStringify(undefined) as unknown, undefined);
  assert.equal(stableStringify("a"), '"a"');
  assert.equal(stableStringify({ a: NaN, b: Infinity }), '{"a":null,"b":null}');
  assert.equal(stableStringify({}), "{}");
  assert.equal(
    stableStringify({ z: { y: [1, { b: 2, a: 3 }] }, a: "x" }),
    '{"a":"x","z":{"y":[1,{"a":3,"b":2}]}}',
  );
});

test("stableStringify rejects cycles by exhausting the stack", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => stableStringify(cyclic), RangeError);
});

test("stableStringify seed digests are pinned", () => {
  // A representative evidence seed shaped like the ones the orchestration
  // modules hash. These digests must never move.
  const seed = stableStringify({
    label: "complexity-execution-plan-draft",
    sourceEnvelopeIdempotencyKey: "env-1",
    executionMode: "dry-run",
    safetyBlocked: false,
    action: "approve",
    envelopeCategory: "runtime",
  });
  assert.equal(
    seed,
    '{"action":"approve","envelopeCategory":"runtime","executionMode":"dry-run",' +
      '"label":"complexity-execution-plan-draft","safetyBlocked":false,' +
      '"sourceEnvelopeIdempotencyKey":"env-1"}',
  );
  assert.equal(
    createHash("sha256").update(seed).digest("hex").slice(0, 24),
    "66698ee66b95961ffbd04590",
  );
});

test("the terminal-brief-evidence variant is a different canonical form", () => {
  // Mirror of `sortForStableJson` + JSON.stringify in
  // packages/broker/src/github/terminal-brief-evidence.ts. It feeds
  // `manifestSha256`, which is already published in GitHub comment markers, so
  // it is intentionally left un-consolidated. If these ever agree, the two can
  // be merged; until then this asserts why they cannot.
  const sortForStableJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortForStableJson);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const sorted = sortForStableJson(value[key]);
      if (sorted !== undefined) out[key] = sorted;
    }
    return out;
  };
  const other = (value: unknown) => JSON.stringify(sortForStableJson(value));

  for (const probe of [
    { a: 1, b: undefined },
    { a: [{ b: undefined }] },
    [1, undefined, 2],
    { "2": 5, "10": 4 },
  ]) {
    assert.notEqual(
      stableStringify(probe),
      other(probe),
      `expected the two canonical forms to disagree on ${JSON.stringify(probe)}`,
    );
  }
});

test("isRecord narrows plain objects only", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord("a"), false);
  assert.equal(isRecord(1), false);
  assert.equal(isRecord(() => 0), false);
});

test("stableId is sha256(stableStringify) truncated to 24 hex under the prefix (#2350 A7)", () => {
  const value = { b: [1, undefined], a: "x" };
  const expected = `oi-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
  assert.equal(stableId("oi", value), expected);
  assert.match(stableId("p", value), /^p-[0-9a-f]{24}$/);
  // key order must not matter; value changes must.
  assert.equal(stableId("oi", { a: "x", b: [1, undefined] }), expected);
  assert.notEqual(stableId("oi", { a: "y", b: [1, undefined] }), expected);
  // pinned vector: moving the helper must not move any already-emitted id.
  assert.equal(stableId("oi", { a: 1 }), "oi-015abd7f5cc57a2dd94b7590");
});

test("approvedAtValid / approvalNotExpired fail closed on unparseable input (#2350 A7)", () => {
  const generatedAt = "2026-10-10T10:00:00.000Z";
  assert.equal(approvedAtValid("2026-10-10T09:59:59.000Z", generatedAt), true);
  assert.equal(approvedAtValid(generatedAt, generatedAt), true);
  assert.equal(approvedAtValid("2026-10-10T10:00:01.000Z", generatedAt), false);
  assert.equal(approvedAtValid(undefined, generatedAt), false);
  assert.equal(approvedAtValid("not-a-date", generatedAt), false);
  assert.equal(approvedAtValid("2026-10-10T09:00:00.000Z", "not-a-date"), false);

  assert.equal(approvalNotExpired(undefined, generatedAt), true);
  assert.equal(approvalNotExpired("", generatedAt), true);
  assert.equal(approvalNotExpired("2026-10-10T10:00:01.000Z", generatedAt), true);
  assert.equal(approvalNotExpired(generatedAt, generatedAt), false);
  assert.equal(approvalNotExpired("2026-10-10T09:00:00.000Z", generatedAt), false);
  assert.equal(approvalNotExpired("not-a-date", generatedAt), false);
});

test("coversAll requires every entry, trims supplied, and never covers from empty (#2350 A7)", () => {
  assert.equal(coversAll(["a", "b"], ["b", " a "]), true);
  assert.equal(coversAll(["a", "b"], ["a"]), false);
  assert.equal(coversAll(["a"], []), false);
  assert.equal(coversAll(["a"], undefined), false);
  assert.equal(coversAll([], ["x"]), true);
  assert.equal(coversAll([], []), false);
});

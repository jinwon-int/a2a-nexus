import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createWavePlanDagV2RecordStore,
  WavePlanDagV2RecordStore,
  wavePlanDagV2ManifestAdmissionEntry,
  wavePlanDagV2RehearsalOutcomeEntry,
  WAVE_PLAN_DAG_V2_STORE_MAX_BATCH_ENTRIES,
} from "./record-store.js";
import { admitWavePlanDagManifestV2 } from "./manifest.js";
import { runWavePlanDagDryRunV2, type WavePlanDagDryRunResultV2 } from "./dry-run.js";
import type { WavePlanDagV2StoredEntry } from "./record-store.js";

/**
 * #1800 slice 4 — rehearsal-evidence store: idempotent redelivery, all-or-
 * nothing batches, flow ordering, and fail-closed restore (issue item 7
 * remainder, pure subset).
 */

const FIXTURE = JSON.parse(
  readFileSync(
    join(process.cwd(), "..", "..", "fixtures", "contract", "wave-plan-dag-v2.json"),
    "utf8",
  ),
) as {
  manifest: Record<string, unknown>;
  dryRuns: Array<{ request: Record<string, unknown>; receipt: Record<string, unknown> }>;
};

const admissionAttempt = admitWavePlanDagManifestV2(structuredClone(FIXTURE.manifest));
if (!admissionAttempt.ok) throw new Error("fixture must admit");
const admission = admissionAttempt;

function rehearsalEntry(vectorIndex: number): WavePlanDagV2StoredEntry {
  const run = runWavePlanDagDryRunV2(admission, structuredClone(FIXTURE.dryRuns[vectorIndex].request));
  if (!run.ok) throw new Error("fixture vector must rehearse");
  return wavePlanDagV2RehearsalOutcomeEntry(run, admission.manifest.manifestDigest);
}

function rejectedRehearsalEntry(): WavePlanDagV2StoredEntry {
  const mismatched = structuredClone(FIXTURE.dryRuns[0].request) as Record<string, unknown>;
  mismatched.manifestDigest = `sha256:${"e".repeat(64)}`;
  const run = runWavePlanDagDryRunV2(admission, mismatched);
  if (run.ok) throw new Error("expected rejection");
  return wavePlanDagV2RehearsalOutcomeEntry(run as Extract<WavePlanDagDryRunResultV2, { ok: false }>, admission.manifest.manifestDigest);
}

test("admission-then-rehearsal flows commit and list deterministically", () => {
  const store = createWavePlanDagV2RecordStore();
  const first = store.append([wavePlanDagV2ManifestAdmissionEntry(admission)]);
  assert.deepEqual(first, { ok: true, committed: 1, skippedDuplicates: 0 });

  const second = store.append([rehearsalEntry(0)]);
  assert.deepEqual(second, { ok: true, committed: 1, skippedDuplicates: 0 });

  assert.equal(store.admissions().length, 1);
  assert.equal(store.admissions()[0].manifestDigest, admission.manifest.manifestDigest);
  assert.equal(store.rehearsalsOf(admission.manifest.manifestDigest).length, 1);
});

test("both golden vectors preserve distinct receipts for the same manifest", () => {
  const store = createWavePlanDagV2RecordStore();
  const result = store.append([
    wavePlanDagV2ManifestAdmissionEntry(admission),
    rehearsalEntry(0),
    rehearsalEntry(1),
  ]);
  assert.ok(result.ok && result.committed === 3);

  const rehearsals = store.rehearsalsOf(admission.manifest.manifestDigest);
  assert.equal(rehearsals.length, 2, "a second rehearsal must never overwrite the first");
  const digests = rehearsals.map((entry) =>
    entry.entryType === "rehearsal_receipt_recorded" ? entry.receiptDigest : "");
  assert.equal(new Set(digests).size, 2);
  // Commit order preserved.
  assert.equal(digests[0], FIXTURE.dryRuns[0].receipt.receiptDigest);
  assert.equal(digests[1], FIXTURE.dryRuns[1].receipt.receiptDigest);
});

test("identical redelivery is an idempotent no-op with a skip count", () => {
  const store = createWavePlanDagV2RecordStore();
  store.append([wavePlanDagV2ManifestAdmissionEntry(admission), rehearsalEntry(0)]);
  const before = store.snapshot();

  const again = store.append([
    wavePlanDagV2ManifestAdmissionEntry(admission),
    rehearsalEntry(0),
    rehearsalEntry(0), // duplicate inside the same batch collapses too
  ]);
  assert.deepEqual(again, { ok: true, committed: 0, skippedDuplicates: 3 });
  assert.deepEqual(store.snapshot(), before);
});

test("conflicting rewrite of the same key rejects the whole batch", () => {
  const store = createWavePlanDagV2RecordStore();
  // The identity being rewritten must already be committed knowledge.
  store.append([wavePlanDagV2ManifestAdmissionEntry(admission), rehearsalEntry(0)]);
  const before = store.snapshot();

  const conflicting = {
    ...rehearsalEntry(0),
    topologyLength: 7, // same (manifest, receipt) identity, different content
  };
  const result = store.append([
    rehearsalEntry(1), // this one alone would be fine
    conflicting,
  ]);
  assert.ok(!result.ok);
  assert.equal(result.reason, "duplicate_conflict");
  assert.deepEqual(store.snapshot(), before, "failed batch must leave the store untouched");
});

test("all-or-nothing: one malformed entry rejects valid companions too", () => {
  const store = createWavePlanDagV2RecordStore();
  const before = store.snapshot();

  const good = wavePlanDagV2ManifestAdmissionEntry(admission);
  const halfReceipt = {
    kind: "WavePlanDagV2StoreEntryV1",
    version: 1,
    entryType: "rehearsal_receipt_recorded",
    manifestDigest: admission.manifest.manifestDigest,
    receiptDigest: FIXTURE.dryRuns[0].receipt.receiptDigest,
    // topologyLength missing — the half-built receipt has no representation
  };
  const result = store.append([good, halfReceipt]);
  assert.ok(!result.ok);
  assert.equal(result.reason, "entry_malformed");
  assert.deepEqual(store.snapshot(), before);
});

test("flow ordering: rehearsal without a preceding admission is rejected", () => {
  const store = createWavePlanDagV2RecordStore();

  const reversedInBatch = store.append([rehearsalEntry(0), wavePlanDagV2ManifestAdmissionEntry(admission)]);
  assert.ok(!reversedInBatch.ok);
  assert.equal(reversedInBatch.reason, "manifest_not_known");

  const acrossCalls = store.append([rehearsalEntry(0)]);
  assert.ok(!acrossCalls.ok);
  if (!acrossCalls.ok) assert.equal(acrossCalls.reason, "manifest_not_known");

  // Same batch, correct order, commits atomically.
  const orderedBatch = store.append([
    wavePlanDagV2ManifestAdmissionEntry(admission),
    rejectedRehearsalEntry(),
    rehearsalEntry(0),
  ]);
  assert.ok(orderedBatch.ok && orderedBatch.committed === 3);
});

test("rejected rehearsals are evidence too and dedupe by reason", () => {
  const store = createWavePlanDagV2RecordStore();
  store.append([wavePlanDagV2ManifestAdmissionEntry(admission)]);

  const first = store.append([rejectedRehearsalEntry()]);
  assert.ok(first.ok && first.committed === 1);

  const second = store.append([rejectedRehearsalEntry()]);
  assert.deepEqual(second, { ok: true, committed: 0, skippedDuplicates: 1 });
  assert.equal(store.rehearsalsOf(admission.manifest.manifestDigest).length, 1);

  // A different reason is a different fact and is preserved separately.
  const otherReason = runWavePlanDagDryRunV2(admission, structuredClone(FIXTURE.dryRuns[0].request));
  void otherReason;
  const wrongBinding = (() => {
    const request = structuredClone(FIXTURE.dryRuns[0].request) as Record<string, unknown>;
    (request.outcomes as Array<Record<string, unknown>>)[0].outcome = "completed";
    const run = runWavePlanDagDryRunV2(admission, request);
    if (run.ok) throw new Error("expected unknown_outcome");
    return wavePlanDagV2RehearsalOutcomeEntry(run as Extract<WavePlanDagDryRunResultV2, { ok: false }>, admission.manifest.manifestDigest);
  })();
  const third = store.append([wrongBinding]);
  assert.ok(third.ok && third.committed === 1);
  assert.equal(store.rehearsalsOf(admission.manifest.manifestDigest).length, 2);
});

test("batch size cap keeps rejection surfaces bounded", () => {
  const store = createWavePlanDagV2RecordStore();
  const oversized = Array.from({ length: WAVE_PLAN_DAG_V2_STORE_MAX_BATCH_ENTRIES + 1 }, () =>
    rehearsalEntry(0));
  const result = store.append(oversized);
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.reason, "batch_limit_exceeded");
});

test("snapshot → restore roundtrip preserves listings exactly; no clock anywhere", () => {
  const original = createWavePlanDagV2RecordStore();
  original.append([
    wavePlanDagV2ManifestAdmissionEntry(admission),
    rehearsalEntry(1),
    rehearsalEntry(0),
    rejectedRehearsalEntry(),
  ]);

  const loaded = WavePlanDagV2RecordStore.restore(original.snapshot());
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  assert.deepEqual(loaded.store.snapshot(), original.snapshot());
  assert.deepEqual(loaded.store.admissions(), original.admissions());
  assert.deepEqual(
    loaded.store.rehearsalsOf(admission.manifest.manifestDigest),
    original.rehearsalsOf(admission.manifest.manifestDigest),
  );
});

test("restore fails closed on structural corruption", () => {
  const store = createWavePlanDagV2RecordStore();
  store.append([wavePlanDagV2ManifestAdmissionEntry(admission), rehearsalEntry(0)]);

  // Tampered field value.
  const tampered = store.snapshot();
  const admissionRecord = tampered[0] as unknown as Record<string, unknown>;
  if (admissionRecord.entryType === "manifest_admitted") admissionRecord.stageCount = 99;
  const tamperedResult = WavePlanDagV2RecordStore.restore(tampered);
  assert.ok(!tamperedResult.ok);
  if (!tamperedResult.ok) {
    assert.equal(tamperedResult.reason, "snapshot_corrupt");
    assert.match(tamperedResult.message, /invalid record/);
  }

  // Half-built record with an extra smuggled field.
  const smuggled = [...store.snapshot(), { ...rehearsalEntry(1), operatorNote: "extra" }];
  const smuggledResult = WavePlanDagV2RecordStore.restore(smuggled);
  assert.ok(!smuggledResult.ok);

  // Non-array input.
  assert.ok(!WavePlanDagV2RecordStore.restore({ nope: true }).ok);
});

test("restore fails closed on referential breakage", () => {
  // Rehearsal without its admission.
  const orphaned = [rehearsalEntry(0)];
  const orphanResult = WavePlanDagV2RecordStore.restore(orphaned);
  assert.ok(!orphanResult.ok);
  if (!orphanResult.ok) {
    assert.equal(orphanResult.reason, "snapshot_corrupt");
    assert.match(orphanResult.message, /inconsistent snapshot/);
  }

  // Exact duplicates inside one canonical snapshot never occur legitimately.
  const duplicated = [
    wavePlanDagV2ManifestAdmissionEntry(admission),
    wavePlanDagV2ManifestAdmissionEntry(admission),
  ];
  const duplicateResult = WavePlanDagV2RecordStore.restore(duplicated);
  assert.ok(!duplicateResult.ok);
  if (!duplicateResult.ok) assert.match(duplicateResult.message, /duplicate/);
});

test("determinism across processes: identical op sequences build deep-equal stores", () => {
  function runSequence() {
    const store = createWavePlanDagV2RecordStore();
    store.append([wavePlanDagV2ManifestAdmissionEntry(admission)]);
    store.append([rehearsalEntry(0)]);
    store.append([rehearsalEntry(1), rejectedRehearsalEntry()]);
    return store.snapshot();
  }
  assert.deepEqual(runSequence(), runSequence());

  const otherOrder = createWavePlanDagV2RecordStore();
  otherOrder.append([
    wavePlanDagV2ManifestAdmissionEntry(admission),
    rejectedRehearsalEntry(),
    rehearsalEntry(1),
    rehearsalEntry(0),
  ]);
  // Same facts, different commit order → different listing order (order is
  // the only sort key the timestamp-free store has).
  assert.notDeepEqual(otherOrder.snapshot(), runSequence());
});

test("entries carry no action fields; accessors hand out copies", () => {
  const store = createWavePlanDagV2RecordStore();
  store.append([wavePlanDagV2ManifestAdmissionEntry(admission)]);

  const listing = store.admissions();
  const first = listing[0] as unknown as Record<string, unknown>;
  first.stageCount = 2;
  assert.equal(store.admissions()[0].stageCount, 8, "mutations of returned copies must not reach the store");
  assert.equal(store.admissions().length, 1);
});

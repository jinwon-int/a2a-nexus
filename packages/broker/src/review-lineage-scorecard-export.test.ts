import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildReviewLineageScorecard,
  createLineage,
  intentHash,
  validateReviewLineageScorecardInput,
  type IntentContractV1,
  type ReviewLineageMode,
  type ReviewLineageRecord,
} from "a2a-review-lifecycle";

import { REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE } from "./core/store/review-lineage-observation-store.js";
import {
  exportReviewLineageScorecardInput,
  runReviewLineageScorecardExportCli,
} from "./review-lineage-scorecard-export.js";

const T0 = "2026-07-23T00:00:00Z";
const AS_OF = "2026-07-23T08:00:00Z";
const SOURCE_ROUND = "a2a-nexus-2526-export-r1";
const SECRET_GOAL = "sensitive goal that must not leave the snapshot";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const DIFF_HASH = `sha256:${"c".repeat(64)}`;

function makeRecord(lineageId: string, mode: ReviewLineageMode = "record"): ReviewLineageRecord {
  const withoutHash = {
    kind: "IntentContractV1" as const,
    lineageId,
    goal: SECRET_GOAL,
    nonGoals: ["do not expose private prompts"],
    invariants: ["advisory only"],
    acceptanceCriteria: [{ id: "AC-1", text: "secret acceptance text" }],
    declaredPaths: { allowed: ["packages/secret-path/**"] },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    createdAt: T0,
  };
  const contract: IntentContractV1 = { ...withoutHash, intentHash: intentHash(withoutHash) };
  return createLineage({ contract, mode, at: T0, diffHash: DIFF_HASH });
}

function tempDir(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-scorecard-export-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSnapshot(
  dir: string,
  rows: Array<ReviewLineageRecord | { lineageId: string; raw: string }>,
): string {
  const file = path.join(dir, "snapshot.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE} (
      lineage_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      record_version INTEGER NOT NULL CHECK (record_version > 0),
      intent_hash TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      diff_hash TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  const insert = db.prepare(
    `INSERT INTO ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE}
     (lineage_id, record_json, record_version, intent_hash, head_sha, diff_hash, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    if ("raw" in row) {
      insert.run(row.lineageId, row.raw, "x", HEAD_SHA, DIFF_HASH, T0);
    } else {
      insert.run(row.lineageId, JSON.stringify(row), row.contract.intentHash, HEAD_SHA, DIFF_HASH, row.updatedAt);
    }
  }
  db.close();
  return file;
}

test("exports record-mode lineages as a redacted envelope the scorecard accepts", (t) => {
  const dir = tempDir(t);
  const snapshot = writeSnapshot(dir, [
    makeRecord("lineage-alpha-0001"),
    makeRecord("lineage-beta-0002"),
    makeRecord("canary-2339-c2"),
    makeRecord("lineage-off-0003", "off"),
  ]);

  const { envelope, summary } = exportReviewLineageScorecardInput({
    snapshotPath: snapshot,
    sourceRoundId: SOURCE_ROUND,
    asOf: AS_OF,
  });

  assert.deepEqual(summary, {
    totalRows: 4,
    exported: 2,
    excludedByPrefix: 1,
    nonRecordMode: 1,
    maxUpdatedAt: T0,
  });
  assert.equal(envelope.samples.length, 2);
  validateReviewLineageScorecardInput(envelope);
  assert.equal(buildReviewLineageScorecard(envelope).lineageCount, 2);

  const serialized = JSON.stringify(envelope);
  for (const leaked of [
    "lineage-alpha-0001",
    "lineage-beta-0002",
    SECRET_GOAL,
    "secret acceptance text",
    "packages/secret-path",
    BASE_SHA,
    HEAD_SHA,
    "c".repeat(64),
  ]) {
    assert.equal(serialized.includes(leaked), false, `envelope leaked ${leaked}`);
  }
});

test("an explicit empty exclude prefix keeps canary lineages", (t) => {
  const dir = tempDir(t);
  const snapshot = writeSnapshot(dir, [makeRecord("lineage-alpha-0001"), makeRecord("canary-2339-c2")]);
  const { summary } = exportReviewLineageScorecardInput({
    snapshotPath: snapshot,
    sourceRoundId: SOURCE_ROUND,
    asOf: AS_OF,
    excludePrefixes: [""],
  });
  assert.equal(summary.exported, 2);
  assert.equal(summary.excludedByPrefix, 0);
});

test("refuses a snapshot with a non-empty -wal sibling unless allowLive", (t) => {
  const dir = tempDir(t);
  const snapshot = writeSnapshot(dir, [makeRecord("lineage-alpha-0001")]);
  fs.writeFileSync(`${snapshot}-wal`, "not empty");
  assert.throws(
    () => exportReviewLineageScorecardInput({ snapshotPath: snapshot, sourceRoundId: SOURCE_ROUND, asOf: AS_OF }),
    /looks like a live database/,
  );
  // An explicit operator override skips only the guard.
  assert.equal(
    exportReviewLineageScorecardInput({
      snapshotPath: snapshot,
      sourceRoundId: SOURCE_ROUND,
      asOf: AS_OF,
      allowLive: true,
    }).summary.exported,
    1,
  );
  fs.rmSync(`${snapshot}-wal`);
  fs.writeFileSync(`${snapshot}-wal`, "");
  assert.equal(
    exportReviewLineageScorecardInput({ snapshotPath: snapshot, sourceRoundId: SOURCE_ROUND, asOf: AS_OF })
      .summary.exported,
    1,
  );
});

test("does not write to the snapshot", (t) => {
  const dir = tempDir(t);
  const snapshot = writeSnapshot(dir, [makeRecord("lineage-alpha-0001")]);
  const before = fs.readFileSync(snapshot);
  exportReviewLineageScorecardInput({ snapshotPath: snapshot, sourceRoundId: SOURCE_ROUND, asOf: AS_OF });
  assert.deepEqual(fs.readFileSync(snapshot), before);
});

test("fails closed on missing table, invalid rows, no records and an early asOf", (t) => {
  const dir = tempDir(t);
  const empty = path.join(dir, "empty.sqlite");
  new DatabaseSync(empty).close();
  assert.throws(
    () => exportReviewLineageScorecardInput({ snapshotPath: empty, sourceRoundId: SOURCE_ROUND, asOf: AS_OF }),
    /has no broker_review_lineage_observation_lineages_v1 table/,
  );

  const badDir = path.join(dir, "bad");
  fs.mkdirSync(badDir);
  const bad = writeSnapshot(badDir, [{ lineageId: "lineage-secret-id", raw: "{\"kind\":\"nope\"}" }]);
  assert.throws(
    () => exportReviewLineageScorecardInput({ snapshotPath: bad, sourceRoundId: SOURCE_ROUND, asOf: AS_OF }),
    (error: Error) => /stored record #1 failed/.test(error.message) && !error.message.includes("lineage-secret-id"),
  );

  const offDir = path.join(dir, "off");
  fs.mkdirSync(offDir);
  const off = writeSnapshot(offDir, [makeRecord("lineage-off-0003", "off")]);
  assert.throws(
    () => exportReviewLineageScorecardInput({ snapshotPath: off, sourceRoundId: SOURCE_ROUND, asOf: AS_OF }),
    /no record-mode lineages/,
  );

  const okDir = path.join(dir, "ok");
  fs.mkdirSync(okDir);
  const ok = writeSnapshot(okDir, [makeRecord("lineage-alpha-0001")]);
  assert.throws(
    () => exportReviewLineageScorecardInput({
      snapshotPath: ok,
      sourceRoundId: SOURCE_ROUND,
      asOf: "2026-07-22T00:00:00Z",
    }),
  );
});

test("CLI writes a 0600 envelope once and refuses to overwrite", (t) => {
  const dir = tempDir(t);
  const snapshot = writeSnapshot(dir, [makeRecord("lineage-alpha-0001")]);
  const output = path.join(dir, "redacted.json");
  const argv = ["--snapshot", snapshot, "--source-round-id", SOURCE_ROUND, "--as-of", AS_OF, "--output", output];

  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(runReviewLineageScorecardExportCli(argv), 0);
  } finally {
    process.stdout.write = original;
  }
  assert.match(writes.join(""), /export ok \(1 exported of 1 row\(s\)/);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  validateReviewLineageScorecardInput(JSON.parse(fs.readFileSync(output, "utf8")));
  assert.throws(() => runReviewLineageScorecardExportCli(argv), /refusing overwrite/);
});

test("CLI returns 2 without required arguments", () => {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(runReviewLineageScorecardExportCli(["--snapshot", "x"]), 2);
  } finally {
    process.stderr.write = original;
  }
});

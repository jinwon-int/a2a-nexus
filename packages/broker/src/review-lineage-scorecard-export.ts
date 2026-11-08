#!/usr/bin/env node
/**
 * Offline export of a broker SQLite snapshot into the redacted
 * `a2a.review-lineage-scorecard-input.v1` envelope (#2526, #2274 procedure gap).
 *
 * `GET /review-lineages` returns read-model projections only, by design, while
 * `projectReviewLineageScorecardSample` needs full `ReviewLineageRecord`s. This
 * command closes that gap without widening the HTTP surface:
 *
 *   - opens a snapshot (a backup or copy, not the serving database) read-only;
 *   - parses each `record_json` with the same `reviewLineageRecordSchema` the
 *     observation store uses on read, so the export sees what the broker sees;
 *   - keeps full records in memory only and projects them through
 *     `buildReviewLineageScorecardInput` (the single redaction source);
 *   - writes only the envelope (mode 0600, never overwriting) after checking it
 *     carries no raw lineage id and no bare 40/64-hex token.
 *
 * No broker, GitHub or network call is made. Feed the output to
 * `node packages/review-lifecycle/dist/scorecard-cli.js`.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  buildReviewLineageScorecardInput,
  type ReviewLineageRecord,
  type ReviewLineageScorecardInputV1,
} from "a2a-review-lifecycle";

import { reviewLineageRecordSchema } from "./core/store-schemas.js";
import { REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE } from "./core/store/review-lineage-observation-store.js";

export const DEFAULT_SCORECARD_EXPORT_EXCLUDE_PREFIXES = ["canary-"] as const;

const BARE_HEX_DIGEST = /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/;

export interface ReviewLineageScorecardExportOptions {
  snapshotPath: string;
  sourceRoundId: string;
  asOf: string;
  excludePrefixes?: readonly string[];
  /** Permit a snapshot that has a non-empty `-wal` sibling (likely live). */
  allowLive?: boolean;
}

export interface ReviewLineageScorecardExportSummary {
  totalRows: number;
  exported: number;
  excludedByPrefix: number;
  nonRecordMode: number;
  maxUpdatedAt: string | null;
}

export interface ReviewLineageScorecardExportResult {
  envelope: ReviewLineageScorecardInputV1;
  summary: ReviewLineageScorecardExportSummary;
}

export class ReviewLineageScorecardExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewLineageScorecardExportError";
  }
}

function fail(message: string): never {
  throw new ReviewLineageScorecardExportError(message);
}

function assertSnapshotPath(snapshotPath: string, allowLive: boolean): string {
  const resolved = path.resolve(process.cwd(), snapshotPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fail(`snapshot not found: ${snapshotPath}`);
  }
  if (!stat.isFile()) fail(`snapshot is not a file: ${snapshotPath}`);
  const wal = `${resolved}-wal`;
  if (!allowLive && fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    fail(
      `snapshot has a non-empty -wal sibling and looks like a live database: ${snapshotPath}; `
        + "export from a backup or copy (or pass --allow-live)",
    );
  }
  return resolved;
}

function readRecords(snapshotPath: string): ReviewLineageRecord[] {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE);
    if (!table) {
      fail(`snapshot has no ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE} table`);
    }
    const rows = db.prepare(
      `SELECT record_json FROM ${REVIEW_LINEAGE_OBSERVATION_LINEAGE_TABLE} ORDER BY lineage_id ASC`,
    ).all() as Array<{ record_json: string }>;
    return rows.map((row, index) => {
      try {
        return reviewLineageRecordSchema.parse(JSON.parse(row.record_json)) as ReviewLineageRecord;
      } catch {
        // The row ordinal, not the lineage id, keeps the error free of identifiers.
        fail(`stored record #${index + 1} failed reviewLineageRecordSchema`);
      }
    });
  } finally {
    db.close();
  }
}

function assertRedacted(
  serialized: string,
  records: readonly ReviewLineageRecord[],
): void {
  for (const record of records) {
    if (serialized.includes(record.lineageId)) {
      fail("redaction check failed: envelope contains a raw lineage id");
    }
  }
  if (BARE_HEX_DIGEST.test(serialized)) {
    fail("redaction check failed: envelope contains a bare 40/64-hex token");
  }
}

export function exportReviewLineageScorecardInput(
  options: ReviewLineageScorecardExportOptions,
): ReviewLineageScorecardExportResult {
  const snapshotPath = assertSnapshotPath(options.snapshotPath, options.allowLive === true);
  const excludePrefixes = options.excludePrefixes ?? DEFAULT_SCORECARD_EXPORT_EXCLUDE_PREFIXES;
  const all = readRecords(snapshotPath);

  const excluded = (record: ReviewLineageRecord): boolean =>
    excludePrefixes.some((prefix) => prefix.length > 0 && record.lineageId.startsWith(prefix));
  const records = all.filter((record) => record.mode === "record" && !excluded(record));
  const summary: ReviewLineageScorecardExportSummary = {
    totalRows: all.length,
    exported: records.length,
    excludedByPrefix: all.filter(excluded).length,
    nonRecordMode: all.filter((record) => record.mode !== "record").length,
    maxUpdatedAt: all.reduce<string | null>(
      (max, record) => (max === null || record.updatedAt > max ? record.updatedAt : max),
      null,
    ),
  };
  if (records.length === 0) {
    fail(`no record-mode lineages to export (rows=${summary.totalRows})`);
  }

  const envelope = buildReviewLineageScorecardInput({
    records,
    asOf: options.asOf,
    sourceRoundId: options.sourceRoundId,
  });
  assertRedacted(JSON.stringify(envelope), all);
  return { envelope, summary };
}

function usage(): string {
  return [
    "Usage:",
    "  node packages/broker/dist/review-lineage-scorecard-export.js",
    "    --snapshot <backup.sqlite> --source-round-id <id> --as-of <UTC>",
    "    --output <redacted-input.json> [--exclude-prefix <p>]... [--allow-live]",
    "",
    `--exclude-prefix defaults to ${DEFAULT_SCORECARD_EXPORT_EXCLUDE_PREFIXES.join(", ")};`,
    "passing it replaces the default (pass an empty string to exclude nothing).",
    "--as-of must not precede the newest exported record's updatedAt.",
  ].join("\n");
}

export function runReviewLineageScorecardExportCli(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      snapshot: { type: "string" },
      "source-round-id": { type: "string" },
      "as-of": { type: "string" },
      output: { type: "string" },
      "exclude-prefix": { type: "string", multiple: true },
      "allow-live": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!values.snapshot || !values["source-round-id"] || !values["as-of"] || !values.output) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }

  const outputPath = path.resolve(process.cwd(), values.output);
  if (fs.existsSync(outputPath)) {
    fail(`output already exists, refusing overwrite: ${values.output}`);
  }
  const { envelope, summary } = exportReviewLineageScorecardInput({
    snapshotPath: values.snapshot,
    sourceRoundId: values["source-round-id"],
    asOf: values["as-of"],
    excludePrefixes: values["exclude-prefix"],
    allowLive: values["allow-live"] === true,
  });
  fs.writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `review-lineage scorecard export ok (${summary.exported} exported of ${summary.totalRows} row(s); `
      + `excluded by prefix ${summary.excludedByPrefix}, non-record ${summary.nonRecordMode}; `
      + `newest updatedAt ${summary.maxUpdatedAt ?? "-"})\n`,
  );
  return 0;
}

const directRun =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (directRun) {
  try {
    process.exitCode = runReviewLineageScorecardExportCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `review-lineage scorecard export FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

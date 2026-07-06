#!/usr/bin/env node
/**
 * Verifiable Analysis Report exporter (#1378 emit side).
 *
 * Contract: contracts/a2a/verifiable-analysis-report.md
 *
 * Takes a completed task record (the JSON the broker stores / returns for a
 * task) and assembles the self-contained v1 report bundle that a third party
 * can verify offline with scripts/verify-analysis-report.mjs. This closes the
 * manual gap where the finalizer hand-wrapped results into bundles during the
 * V0-c dogfood verifications.
 *
 * Fail-closed emission rules (DW3 no-partial-emission):
 * - The task must be `succeeded` and its result must carry `result.provenance`
 *   WITH a broker countersignature. A report without a verifiable provenance
 *   chain is worthless, so the exporter refuses to emit one rather than
 *   emitting an unverifiable envelope.
 * - The mandatory correctness-separation `assurance` block is stamped by the
 *   exporter; it cannot be omitted or weakened via options.
 * - Sources: signed RetrievalSnapshots are taken from --sources <file> (a JSON
 *   array) until the K2 executor (#1374) embeds them in results; omitted =
 *   empty sources (provenance-only report). The result<->source binding gap is
 *   documented in the contract (§5) and unaffected by this exporter.
 *
 * Safety: source-only assembly. Reads task JSON, writes the bundle. No
 * network, no broker mutation, no secrets (provenance carries public key ids
 * and signatures only).
 *
 * Usage:
 *   node scripts/export-analysis-report.mjs --task <task.json> [--sources <snapshots.json>] [--out <report.json>]
 * Exit 0 = bundle written; non-zero = refused (fail-closed) or bad input.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

import { REPORT_VERSION, RESULT_PROVENANCE_SCHEMA } from "./verify-analysis-report.mjs";

export const ASSURANCE = Object.freeze({
  proves: ["integrity", "process-provenance"],
  doesNotProve: ["analytical-correctness", "normative-judgment", "authorship"],
  disclaimer:
    "This report proves which worker key submitted this result through the verified pipeline and that it was not tampered with afterward. It does NOT certify that the analysis is correct, and it does not prove authorship of the work.",
});

/**
 * Assemble a v1 report bundle from a completed task record. Throws with a
 * refusal reason when the task cannot yield a verifiable report (fail-closed).
 */
export function buildReportBundle(task, { sources = [] } = {}) {
  if (!task || typeof task !== "object") throw new Error("refused: task record is not an object");
  if (task.status !== "succeeded") throw new Error(`refused: task status is '${task.status}', report requires 'succeeded'`);
  if (typeof task.id !== "string" || task.id.length === 0) throw new Error("refused: task.id missing");
  const result = task.result;
  if (!result || typeof result !== "object") throw new Error("refused: task.result missing");
  const provenance = result.provenance;
  if (!provenance || typeof provenance !== "object") {
    throw new Error("refused: result.provenance missing — an unverifiable report will not be emitted");
  }
  if (provenance.schemaVersion !== RESULT_PROVENANCE_SCHEMA) {
    throw new Error(`refused: unsupported provenance schema '${provenance.schemaVersion}'`);
  }
  if (!provenance.brokerCountersig || typeof provenance.brokerCountersig !== "object") {
    throw new Error("refused: provenance.brokerCountersig missing — report requires the broker-accepted chain");
  }
  if (!Array.isArray(sources)) throw new Error("refused: sources must be an array of signed retrieval snapshots");

  return {
    reportVersion: REPORT_VERSION,
    taskId: task.id,
    result,
    sources,
    assurance: { ...ASSURANCE, proves: [...ASSURANCE.proves], doesNotProve: [...ASSURANCE.doesNotProve] },
  };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string" },
      sources: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.task) {
    process.stderr.write("usage: export-analysis-report.mjs --task <task.json> [--sources <snapshots.json>] [--out <report.json>]\n");
    return 2;
  }
  let task;
  let sources = [];
  try {
    task = JSON.parse(fs.readFileSync(values.task, "utf8"));
    if (values.sources) sources = JSON.parse(fs.readFileSync(values.sources, "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read input: ${err.message}\n`);
    return 2;
  }

  let bundle;
  try {
    bundle = buildReportBundle(task, { sources });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }

  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  if (values.out) {
    fs.writeFileSync(values.out, serialized);
    process.stderr.write(`report bundle written: ${values.out} (verify with scripts/verify-analysis-report.mjs)\n`);
  } else {
    process.stdout.write(serialized);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

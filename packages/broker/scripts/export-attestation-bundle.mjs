#!/usr/bin/env node
/**
 * Attestation bundle exporter (#1301 M3-b).
 *
 * Format: docs/attestation-bundle.md (v0). Assembles the scattered audit
 * evidence for ONE task — DoR contract payload, validation verdicts (roles,
 * never node names), failed-lane readback, provenance distillation — into a
 * single JSON document with a recomputable integrity hash, so "can you audit
 * what the agent did" is answerable with one file per task.
 *
 * Safety invariants:
 * - Every text field rides the EXISTING broker redaction path
 *   (dist/core/task-error-details.js redactAndBoundFailureExcerpt) — no new
 *   redaction logic here by design (#1301 M3-b).
 * - Every internal node identifier reachable from the task record (claimedBy,
 *   assignedWorkerId, targetNodeId, requester/target ids, validation nodeIds,
 *   plus --scrub-ids extras) is replaced with a role token in EVERY string,
 *   including the display taskId. The raw task id stays correlatable through
 *   subject.taskIdHash. Provenance is distilled to hash + signature presence
 *   because key ids embed node names.
 * - Uncollectable fields are marked with the literal string "missing" —
 *   an audit document must distinguish empty from unknown.
 * - Read-only: reads task JSON (or an export-sqlite-state snapshot), writes
 *   the bundle. No network, no broker mutation. scripts/check-attestation-bundle.mjs
 *   is the consumer-side verifier and second PII line of defense.
 *
 * Usage:
 *   node scripts/export-attestation-bundle.mjs --task-file <task.json> [--out <bundle.json>] [--scrub-ids a,b]
 *   node scripts/export-attestation-bundle.mjs --state-json <snapshot.json> --task <id> [--out <bundle.json>]
 *   node scripts/export-attestation-bundle.mjs --state-json <snapshot.json> --round <parentRoundId> --out-dir <dir>
 *
 * Pass --keyring <keys.json> ({ keys: { keyId: pemPublicKey } }) to embed a
 * cryptographic provenance verification VERDICT (#1356 G2-d) in
 * evidence.provenance.verification — enum values only, key ids never enter
 * the bundle. Verification reuses scripts/verify-analysis-report.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

import { redactAndBoundFailureExcerpt, failureReadbackFromError } from "../dist/core/task-error-details.js";
import { canonicalizeJson } from "../../../scripts/lib/a2a-offline-verify.mjs";
import { verifyResultProvenance } from "../../../scripts/verify-analysis-report.mjs";

export const BUNDLE_VERSION = "0";
const MISSING = "missing";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collect the internal node identifiers reachable from a task record. */
function collectScrubIds(task, extra = []) {
  const producer = typeof task.claimedBy === "string" && task.claimedBy ? task.claimedBy : task.assignedWorkerId;
  const ids = new Map();
  const add = (id, token) => {
    if (typeof id !== "string" || !id.trim()) return;
    if (!ids.has(id)) ids.set(id, token);
  };
  add(producer, "<author>");
  add(task.assignedWorkerId, "<author>");
  add(task.claimedBy, "<author>");
  add(task.targetNodeId, "<node>");
  add(task.requester?.id, "<node>");
  add(task.target?.id, "<node>");
  for (const validation of validationList(task)) {
    add(validation?.nodeId, validation?.nodeId === producer ? "<author>" : "<reviewer>");
  }
  for (const id of extra) add(id, "<node>");
  // Longest-first so an id that is a prefix of another cannot leave residue.
  return [...ids.entries()].sort((a, b) => b[0].length - a[0].length);
}

function validationList(task) {
  const result = task?.result;
  if (!result || typeof result !== "object") return [];
  if (Array.isArray(result.validations)) return result.validations;
  return result.validation ? [result.validation] : [];
}

function makeSanitizer(scrubEntries) {
  const replacers = scrubEntries.map(([id, token]) => [new RegExp(escapeRegExp(id), "gi"), token]);
  return (text) => {
    let out = redactAndBoundFailureExcerpt(text);
    for (const [pattern, token] of replacers) out = out.replace(pattern, token);
    return out;
  };
}

/** Deep-copy a JSON value, passing every string leaf through the sanitizer. */
function sanitizeDeep(value, sanitize) {
  if (typeof value === "string") return sanitize(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, sanitize));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDeep(item, sanitize)]));
  }
  return value;
}

function orMissing(value, sanitize) {
  return value === undefined || value === null ? MISSING : sanitizeDeep(value, sanitize);
}

/**
 * Assemble the v0 attestation bundle for one task record. Pure and
 * deterministic; throws (fail-closed) when the record cannot anchor an audit
 * document at all.
 */
export function buildAttestationBundle(task, { scrubIds = [], keyring } = {}) {
  if (!task || typeof task !== "object") throw new Error("refused: task record is not an object");
  if (typeof task.id !== "string" || task.id.length === 0) throw new Error("refused: task.id missing");
  const sanitize = makeSanitizer(collectScrubIds(task, scrubIds));
  const producer = typeof task.claimedBy === "string" && task.claimedBy ? task.claimedBy : task.assignedWorkerId;
  const payload = task.payload && typeof task.payload === "object" ? task.payload : {};

  const validations = validationList(task).map((validation) => {
    const role = validation?.nodeId === undefined ? "unknown" : validation.nodeId === producer ? "author" : "reviewer";
    return {
      kind: typeof validation?.kind === "string" ? validation.kind : MISSING,
      verdict: typeof validation?.verdict === "string" ? validation.verdict : MISSING,
      role,
      ...(typeof validation?.note === "string" ? { note: sanitize(validation.note) } : {}),
      ...(validation?.metrics && typeof validation.metrics === "object"
        ? { metrics: sanitizeDeep(validation.metrics, sanitize) }
        : {}),
    };
  });

  const failures = [];
  for (const error of [task.error, ...(Array.isArray(task.errorHistory) ? task.errorHistory : [])]) {
    if (!error) continue;
    const readback = failureReadbackFromError(error);
    failures.push({
      ...(typeof error.code === "string" ? { code: sanitize(error.code) } : {}),
      stage: typeof readback?.stage === "string" ? readback.stage : MISSING,
      excerpt: typeof readback?.excerpt === "string" ? sanitize(readback.excerpt) : MISSING,
    });
  }

  const provenance = task.result?.provenance;
  // With a keyring, the distillation also carries a cryptographic verification
  // VERDICT (#1356 G2-d) — enum values only: the underlying check details name
  // key ids, which embed node names and must not enter the bundle (rule 4).
  const verification = keyring && provenance && typeof provenance === "object"
    ? (({ workerSig, brokerCountersig }) => ({ workerSig, brokerCountersig }))(
      verifyResultProvenance(task.result, task.id, keyring.keys ?? {}),
    )
    : undefined;
  const distilledProvenance = provenance && typeof provenance === "object"
    ? {
      resultHash: typeof provenance.resultHash === "string" ? provenance.resultHash : MISSING,
      workerSigned: Boolean(provenance.workerSig),
      brokerCountersigned: Boolean(provenance.brokerCountersig),
      ...(verification ? { verification } : {}),
    }
    : MISSING;

  const body = {
    bundleVersion: BUNDLE_VERSION,
    subject: {
      kind: "task",
      taskId: sanitize(task.id),
      taskIdHash: `sha256:${createHash("sha256").update(task.id, "utf8").digest("hex")}`,
      intent: typeof task.intent === "string" ? task.intent : MISSING,
      status: typeof task.status === "string" ? task.status : MISSING,
      completedAt: typeof task.completedAt === "string" ? task.completedAt : MISSING,
    },
    contract: {
      acceptance: orMissing(payload.acceptance, sanitize),
      declaredScope: orMissing(payload.declaredScope, sanitize),
      evidenceGate: orMissing(payload.evidenceGate, sanitize),
    },
    evidence: {
      // v0: the broker store does not retain PR-body red/green logs; the
      // marker keeps the gap explicit instead of silently absent (M3-a).
      redGreen: MISSING,
      validations,
      failures,
      provenance: distilledProvenance,
    },
  };
  const hash = createHash("sha256").update(canonicalizeJson(body), "utf8").digest("hex");
  return { ...body, integrity: { alg: "sha256-jcs", hash } };
}

/** Select task records from an export-sqlite-state snapshot (tasks array). */
export function findBundleTasks(snapshot, { taskId, roundId } = {}) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  if (taskId) return tasks.filter((task) => task?.id === taskId);
  if (roundId) return tasks.filter((task) => task?.parentRoundId === roundId);
  return [];
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "task-file": { type: "string" },
      "state-json": { type: "string" },
      task: { type: "string" },
      round: { type: "string" },
      out: { type: "string" },
      "out-dir": { type: "string" },
      "scrub-ids": { type: "string", default: "" },
      keyring: { type: "string" },
    },
  });
  const scrubIds = values["scrub-ids"].split(",").map((id) => id.trim()).filter(Boolean);
  const keyring = values.keyring ? JSON.parse(fs.readFileSync(values.keyring, "utf8")) : undefined;

  let tasks;
  if (values["task-file"]) {
    tasks = [JSON.parse(fs.readFileSync(values["task-file"], "utf8"))];
  } else if (values["state-json"] && (values.task || values.round)) {
    const snapshot = JSON.parse(fs.readFileSync(values["state-json"], "utf8"));
    tasks = findBundleTasks(snapshot, { taskId: values.task, roundId: values.round });
    if (tasks.length === 0) {
      process.stderr.write(`refused: no task matches ${values.task ? `id '${values.task}'` : `round '${values.round}'`}\n`);
      return 1;
    }
  } else {
    process.stderr.write(
      "usage: export-attestation-bundle.mjs --task-file <task.json> [--out f] | --state-json <snapshot.json> (--task <id> [--out f] | --round <parentRoundId> --out-dir <dir>) [--scrub-ids a,b] [--keyring keys.json]\n",
    );
    return 2;
  }

  for (const task of tasks) {
    const bundle = buildAttestationBundle(task, { scrubIds, keyring });
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
    if (values["out-dir"]) {
      fs.mkdirSync(values["out-dir"], { recursive: true });
      const file = path.join(values["out-dir"], `attestation-${bundle.subject.taskIdHash.slice(7, 23)}.json`);
      fs.writeFileSync(file, serialized);
      process.stderr.write(`wrote ${file}\n`);
    } else if (values.out) {
      fs.writeFileSync(values.out, serialized);
      process.stderr.write(`wrote ${values.out}\n`);
    } else {
      process.stdout.write(serialized);
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

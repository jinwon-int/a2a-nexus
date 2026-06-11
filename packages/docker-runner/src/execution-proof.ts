// ─────────────────────────────────────────────────────────────────────────────
// Execution Proof (Team1 nosuk lane, A2A R23)
// Parent: a2a-docker-runner#261
// Parent: a2a-plane#335
//
// Produces replay-safe, tamper-evident execution proofs that link task input,
// expanded commands, and container output into a deterministic chain digests.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type {
  RunnerTask,
  NormalizedRunnerTask,
  RunnerResult,
  ExecutionProof,
} from "./types.js";

// ─── Digest Helpers ─────────────────────────────────────────────────────

/**
 * Recursively serialise a JSON-compatible value with object keys sorted at
 * every depth. A plain sorted-keys array passed as the JSON.stringify replacer
 * is NOT equivalent: the replacer array acts as a recursive property
 * allow-list, so nested keys absent from the top level would be dropped and
 * the digest would not bind nested fields (repos[].url, env, policyContext).
 */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Compute a deterministic sha256 hex digest of a JSON-serialisable value.
 * Keys are sorted at every nesting depth for stability. task-templates.ts
 * re-exports this helper so both modules always use the same algorithm.
 */
export function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

/**
 * Compute the sha256 hex digest of a string (UTF-8).
 */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ─── Proof Builder ──────────────────────────────────────────────────────

/**
 * Options for building an execution proof.
 */
export interface BuildExecutionProofOptions {
  /** The normalised task (as received by the runner). */
  task: NormalizedRunnerTask;
  /** The runner result after execution completes. */
  result: RunnerResult;
  /** The expanded version of the task (post template expansion). */
  expanded?: RunnerTask;
  /** The run token for this execution. */
  runToken: string;
  /** ISO-8601 timestamp.  Omit to use current UTC time. */
  now?: string;
}

/**
 * Build an ExecutionProof from a runner task and its result.
 *
 * The proof chains three digests:
 *   inputDigest   → sha256 of the normalised task (before expansion)
 *   expandedDigest → sha256 of the expanded task (after template expansion)
 *   outputDigest  → sha256 of the redacted container stdout + stderr
 *   chainDigest   → sha256(inputDigest + expandedDigest + outputDigest)
 *
 * When no template expansion occurred, expandedDigest == inputDigest.
 */
export function buildExecutionProof(options: BuildExecutionProofOptions): ExecutionProof {
  const { task, result, expanded, runToken, now } = options;

  const inputDigest = sha256Json(task);
  const expandedDigest = expanded ? sha256Json(expanded) : inputDigest;
  const outputDigest = sha256Text((result.stdout ?? "") + (result.stderr ?? ""));
  const chainDigest = sha256Text(inputDigest + expandedDigest + outputDigest);

  const exitCode = result.exitCode ?? null;
  const ok = result.ok;

  // Determine outcome classification.
  const status = result.ok ? "completed" : result.status === "timeout" ? "timeout" : "failed";

  return {
    schemaVersion: "a2a.runner.execution-proof.v1",
    taskId: result.taskId,
    runToken,
    generatedAt: now ?? new Date().toISOString().replace("Z", ".000Z"),
    inputDigest,
    expandedDigest,
    outputDigest,
    chainDigest,
    exitCode,
    ok,
    status,
    ...(result.prUrl ? { prUrl: result.prUrl } : {}),
    ...(classifyOutcome(result) ? { outcome: classifyOutcome(result) } : {}),
    ...(classifyFailure(result) ? { failureCategory: classifyFailure(result) } : {}),
    ...(buildSummary(result) ? { summary: buildSummary(result) } : {}),
    manifestPath: "artifacts/manifest.json",
  };
}

// ─── Outcome Classification ─────────────────────────────────────────────

type ProofOutcome = NonNullable<ExecutionProof["outcome"]>;

/**
 * Classify the runner result into a proof outcome value.
 */
function classifyOutcome(result: RunnerResult): ProofOutcome | undefined {
  if (result.ok) return "done";
  if (result.status === "timeout") return "timed_out";
  if (result.status === "failed") {
    const err = result.error ?? "";
    if (/infrastructure|ENOENT|permission denied|cannot connect|daemon/i.test(err)) {
      return "failed_infrastructure";
    }
    if (/missing_evidence|no PR|no artifact/i.test(err)) {
      return "missing_evidence";
    }
    return "failed";
  }
  return undefined;
}

// ─── Failure Classification ─────────────────────────────────────────────

/**
 * Classify the failure mode for stability-gate tracking.
 */
function classifyFailure(result: RunnerResult): string | undefined {
  if (result.ok) return undefined;
  const err = result.error ?? "";
  const signal = result.signal ?? null;
  const code = result.exitCode ?? null;

  if (result.status === "timeout") return "timeout_exceeded";
  if (code === 137 || /out of memory|OOMKill/i.test(err)) return "oom";
  if (/ENOENT/.test(err)) return "engine_not_found";
  if (/pull access denied|no such image|unauthorized/i.test(err)) return "image_pull_failure";
  if (/permission denied|cannot connect.*daemon/i.test(err)) return "engine_permission";
  if (/container name.*already in use|conflict/i.test(err)) return "container_name_collision";
  if (/budget_limited/i.test(err)) return "budget_limit";
  if (/bootstrap_guard|boostrap_guard/i.test(err)) return "bootstrap_guard_blocked";
  if (signal === "SIGKILL") return "sigkill";
  if (signal === "SIGTERM") return "sigterm";
  if (code !== null && code !== 0) return `exit_${code}`;
  return "unknown";
}

// ─── Summary ────────────────────────────────────────────────────────────

/**
 * Build a bounded, redacted one-line summary from the result.
 */
function buildSummary(result: RunnerResult): string | undefined {
  if (result.prUrl) return `PR created: ${result.prUrl}`;
  if (result.error) return result.error.slice(0, 240);
  if (result.ok) return `Task ${result.taskId} completed successfully`;
  return undefined;
}

// ─── Verification ───────────────────────────────────────────────────────

/**
 * Verify the integrity of an execution proof against its constituent parts.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, reason: string }`
 * on mismatch.
 */
export function verifyExecutionProof(
  proof: ExecutionProof,
  task: NormalizedRunnerTask | undefined,
  expanded: RunnerTask | undefined,
  stdout: string,
  stderr: string,
): { valid: true } | { valid: false; reason: string } {
  if (task) {
    const inputDigest = sha256Json(task);
    if (inputDigest !== proof.inputDigest) {
      return { valid: false, reason: `inputDigest mismatch: got ${inputDigest}, expected ${proof.inputDigest}` };
    }
  }

  if (expanded) {
    const expandedDigest = sha256Json(expanded);
    if (expandedDigest !== proof.expandedDigest) {
      return { valid: false, reason: `expandedDigest mismatch: got ${expandedDigest}, expected ${proof.expandedDigest}` };
    }
  }

  const outputDigest = sha256Text(stdout + stderr);
  if (outputDigest !== proof.outputDigest) {
    return { valid: false, reason: `outputDigest mismatch: got ${outputDigest}, expected ${proof.outputDigest}` };
  }

  const chainDigest = sha256Text(proof.inputDigest + proof.expandedDigest + outputDigest);
  if (chainDigest !== proof.chainDigest) {
    return { valid: false, reason: `chainDigest mismatch: got ${chainDigest}, expected ${proof.chainDigest}` };
  }

  return { valid: true };
}

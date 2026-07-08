// Broker accept-path finalizer-verdict admission (#1383 V-c).
//
// When a task opts in (`payload.requireFinalizerVerdict === true`) and the
// broker posture is warn|enforce, completeTask requires the result to carry a
// finalizer verdict. The broker enforces — fail-closed in enforce mode, before
// any completion side-effect — the structural properties it can check
// IN-PROCESS with no cryptography:
//   1. presence + schema (a2a.finalizer.verdict.v1)
//   2. decision === "go"
//   3. subject-binding: the verdict's task-result subject hash equals the
//      provenance-anchored result hash (result.provenance.resultHash) — the
//      canonical result identity the worker signed. A verdict cannot be
//      transplanted onto a different result, and a completion that requires a
//      verdict but carries no provenance anchor cannot bind (fail-closed).
//   4. independence: the finalizer identity lives in the disjoint `finalizer:`
//      role namespace (#1429) and is not the producing worker key from
//      result.provenance.
//
// v0 BOUNDARY (documented in contracts/a2a/finalizer-verdict.md): the broker
// does NOT verify the verdict SIGNATURE — the broker runtime cannot reuse the
// offline verifier (scripts/lib) without drift, so cryptographic authenticity
// and registered-key/attester-allowlist membership stay with the repo merge
// gate (scripts/check-finalizer-verdict.mjs), which MUST be wired as a required
// check when broker enforcement is on. This hook is defense-in-depth that
// blocks missing / wrong-decision / unbound / non-independent verdicts at the
// accept moment, before side-effects, without faking the crypto it cannot do.
import { verifyFinalizerVerdictSignature, type FinalizerKeyring } from "./finalizer-verdict-signature.js";
import type { TaskRecord, TaskResult } from "./types.js";

export const FINALIZER_VERDICT_SCHEMA = "a2a.finalizer.verdict.v1";
const FINALIZER_ROLE_PREFIX = "finalizer:";
const WORKER_ROLE_PREFIX = "worker:";

export type FinalizerVerdictEnforcement = "off" | "warn" | "enforce";

export function resolveFinalizerVerdictEnforcement(raw: string | undefined): FinalizerVerdictEnforcement {
  if (raw === undefined) return "off";
  const value = raw.trim().toLowerCase();
  if (value === "off" || value === "warn" || value === "enforce") return value;
  throw new Error(`invalid A2A_FINALIZER_VERDICT_ENFORCEMENT='${raw}' (expected off | warn | enforce)`);
}

export interface FinalizerVerdictAdmissionResult {
  applies: boolean;
  ok: boolean;
  violations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural, no-crypto admission evaluation. Returns `applies:false` (and
 * ok:true) when the posture is off or the task did not opt in — the default
 * path is byte-identical to legacy completion. Otherwise returns the list of
 * violations; the caller blocks (enforce) or logs (warn).
 */
export function evaluateFinalizerVerdictAdmission({
  task,
  result,
  enforcement,
  finalizerKeyring,
}: {
  task: TaskRecord;
  result: TaskResult | undefined;
  enforcement: FinalizerVerdictEnforcement;
  /**
   * Registered finalizer keyring (#1383 V-c follow-up). When present, the
   * broker verifies the STATIC-KEY verdict signature at accept time; when
   * absent, signature authenticity is deferred to the merge gate (the option-2
   * v0 boundary). The attester (S3) path is always gate-verified.
   */
  finalizerKeyring?: FinalizerKeyring;
}): FinalizerVerdictAdmissionResult {
  const optedIn = task.payload?.["requireFinalizerVerdict"] === true;
  if (enforcement === "off" || !optedIn) {
    return { applies: false, ok: true, violations: [] };
  }

  const violations: string[] = [];
  const verdict = (result as Record<string, unknown> | undefined)?.["finalizerVerdict"];

  if (!isRecord(verdict)) {
    return { applies: true, ok: false, violations: ["finalizer_verdict_absent: task requires a finalizer verdict but result.finalizerVerdict is missing"] };
  }
  if (verdict["schemaVersion"] !== FINALIZER_VERDICT_SCHEMA) {
    violations.push(`finalizer_verdict_schema: schemaVersion must be '${FINALIZER_VERDICT_SCHEMA}'`);
  }
  if (verdict["decision"] !== "go") {
    violations.push(`finalizer_verdict_not_go: decision is '${String(verdict["decision"])}', accept requires 'go'`);
  }

  // Subject-binding — bind to the provenance-anchored result hash (the
  // canonical result identity the worker signed), NOT a re-hash of the
  // broker-normalized result. A transplanted verdict, or a completion that
  // requires a verdict but carries no provenance anchor, fails closed.
  const provenance = isRecord((result as Record<string, unknown> | undefined)?.["provenance"])
    ? ((result as Record<string, unknown>)["provenance"] as Record<string, unknown>)
    : undefined;
  const producingKey = provenance?.["workerKeyId"];
  const anchorHash = provenance?.["resultHash"];
  const subject = verdict["subject"];
  if (!isRecord(subject) || subject["kind"] !== "task-result" || typeof subject["resultHash"] !== "string") {
    violations.push("finalizer_verdict_subject_mismatch: subject must be { kind: 'task-result', resultHash } for broker accept-path binding");
  } else if (typeof anchorHash !== "string") {
    violations.push("finalizer_verdict_subject_mismatch: result carries no provenance.resultHash to bind the verdict against (a verdict-requiring completion must be provenance-anchored)");
  } else if (subject["resultHash"] !== anchorHash) {
    violations.push(`finalizer_verdict_subject_mismatch: subject.resultHash does not match the provenance-anchored result hash ${anchorHash}`);
  }

  // Independence — no crypto: the finalizer identity must live in the disjoint
  // `finalizer:` role namespace (#1429) and must not be the producing worker
  // key recorded in result.provenance. The attester (S3) path defers allowlist
  // + full independence to the merge gate; here we only require its subject be
  // present and (when the producing identity is known) distinct.
  const finalizerKeyId = verdict["finalizerKeyId"];
  const attester = verdict["attester"];

  if (typeof finalizerKeyId === "string" && finalizerKeyId) {
    if (!finalizerKeyId.startsWith(FINALIZER_ROLE_PREFIX)) {
      violations.push(`finalizer_verdict_not_independent: finalizerKeyId '${finalizerKeyId}' is not in the '${FINALIZER_ROLE_PREFIX}' role namespace (a ${finalizerKeyId.startsWith(WORKER_ROLE_PREFIX) ? "worker" : "non-finalizer"} key cannot certify)`);
    }
    if (typeof producingKey === "string" && producingKey === finalizerKeyId) {
      violations.push(`finalizer_verdict_not_independent: finalizerKeyId '${finalizerKeyId}' produced the result (self-certification)`);
    }
    // In-broker signature verification (#1383 V-c follow-up): when a finalizer
    // keyring is configured, the static-key signature is verified here, at the
    // accept moment. Without a keyring, signature authenticity stays with the
    // merge gate (documented v0 boundary).
    if (finalizerKeyring) {
      const sigResult = verifyFinalizerVerdictSignature(verdict, finalizerKeyring);
      if (!sigResult.ok) {
        violations.push(`finalizer_verdict_signature_invalid: ${sigResult.reason}`);
      }
    }
  } else if (isRecord(attester) && typeof attester["subject"] === "string" && attester["subject"]) {
    // attested path: presence ok; allowlist + cert-chain independence at the gate.
    if (typeof producingKey === "string" && producingKey === attester["subject"]) {
      violations.push(`finalizer_verdict_not_independent: attester subject '${attester["subject"]}' produced the result`);
    }
  } else {
    violations.push("finalizer_verdict_absent: verdict has neither a finalizerKeyId nor an attester.subject");
  }

  return { applies: true, ok: violations.length === 0, violations };
}

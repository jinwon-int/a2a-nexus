// Broker-owned anonymous memory injection (#1373 K1). At task creation, when
// the requester opts in via `payload.injectKnowledge: true`, the broker
// injects counts-only hint sentences from a deterministic, asOf-pinned
// snapshot (built offline from the M1 lane-reliability ledger + failure
// taxonomy by scripts/build-injected-knowledge.mjs, which runs the full
// fail-closed anonymity gate) into `policyContext.injectedKnowledge`.
//
// Safety split: the build/CI gate owns the concrete node-word rejection list;
// this runtime module re-runs a STRUCTURAL gate (schema, URL/host/worker-id
// shapes, secret patterns) on load — a configured-but-invalid snapshot fails
// startup loudly, and a hint that fails the structural gate never reaches a
// payload. Injection itself is fail-open per task: hints are aids, never
// blockers (#1373 K1-b); a skipped injection is logged as telemetry.
//
// K3 boundary (#1372): injected knowledge is WORKER-GENERATION input only.
// Finalizer/verdict inputs never include it.
import { readFileSync } from "node:fs";

export const INJECTED_KNOWLEDGE_SCHEMA = "a2a.injected-knowledge.v1";
/** Max hints injected into a single task payload — bounded operator-visible state. */
export const MAX_INJECTED_HINTS = 8;
const MAX_HINT_LENGTH = 300;
const MAX_SNAPSHOT_HINTS = 256;

/**
 * Structural anonymity/secret gate for hint text. The concrete fleet
 * node-word list lives ONLY in the repo-side build/CI gate
 * (scripts/check-lane-reliability-ledger.mjs pattern); this runtime check
 * rejects the structural shapes: URLs, host/worker/node identifiers, and
 * secret-looking tokens.
 */
const HINT_FORBIDDEN = [
  /https?:\/\//i,
  /github\.com\//i,
  /\bvps\d+\b/i,
  /\bworker-[a-z0-9_-]+\b/i,
  /\bnode-[a-z0-9_-]+\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /\/(?:home|root)\//,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
];

export interface InjectedKnowledgeHint {
  /** Anonymous task class this hint applies to (matches task intent); absent = applies to all. */
  taskClass?: string;
  /** Anonymous adapter class scope; informational for the worker. */
  adapterClass?: string;
  text: string;
}

export interface InjectedKnowledgeSnapshot {
  schemaVersion: typeof INJECTED_KNOWLEDGE_SCHEMA;
  /** Snapshot pin: same snapshot + same task => same hints (deterministic replay). */
  asOf: string;
  source: string;
  hints: InjectedKnowledgeHint[];
}

/** The payload block injected into policyContext.injectedKnowledge. */
export interface InjectedKnowledgeContext {
  source: string;
  asOf: string;
  hints: string[];
}

function gateError(source: string, message: string): Error {
  return new Error(`invalid injected-knowledge snapshot (${source}): ${message}`);
}

export function hintTextViolation(text: string): string | undefined {
  const pattern = HINT_FORBIDDEN.find((p) => p.test(text));
  return pattern ? `hint text matches forbidden pattern ${pattern}` : undefined;
}

/**
 * Fail-closed structural validation of a snapshot. Unknown top-level or hint
 * fields error (a typo must never silently drop a safety property), hint text
 * is bounded and must pass the structural anonymity/secret gate.
 */
export function validateInjectedKnowledgeSnapshot(value: unknown, source = "inline"): InjectedKnowledgeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw gateError(source, "snapshot must be a JSON object");
  }
  const doc = value as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!["schemaVersion", "asOf", "source", "hints"].includes(key)) {
      throw gateError(source, `unknown field '${key}' (fail-closed)`);
    }
  }
  if (doc.schemaVersion !== INJECTED_KNOWLEDGE_SCHEMA) {
    throw gateError(source, `schemaVersion must be '${INJECTED_KNOWLEDGE_SCHEMA}'`);
  }
  if (typeof doc.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(doc.asOf)) {
    throw gateError(source, "asOf must be a YYYY-MM-DD date (deterministic snapshot pin)");
  }
  if (typeof doc.source !== "string" || !doc.source.trim()) {
    throw gateError(source, "source must be a non-empty string");
  }
  if (hintTextViolation(doc.source)) {
    throw gateError(source, "source must be an anonymous label");
  }
  if (!Array.isArray(doc.hints) || doc.hints.length > MAX_SNAPSHOT_HINTS) {
    throw gateError(source, `hints must be an array of at most ${MAX_SNAPSHOT_HINTS}`);
  }
  for (const [index, raw] of (doc.hints as unknown[]).entries()) {
    const where = `hints[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw gateError(source, `${where} must be an object`);
    }
    const hint = raw as Record<string, unknown>;
    for (const key of Object.keys(hint)) {
      if (!["taskClass", "adapterClass", "text"].includes(key)) {
        throw gateError(source, `${where} has unknown field '${key}' (fail-closed)`);
      }
    }
    if (typeof hint.text !== "string" || !hint.text.trim() || hint.text.length > MAX_HINT_LENGTH) {
      throw gateError(source, `${where}.text must be a non-empty string of at most ${MAX_HINT_LENGTH} chars`);
    }
    const violation = hintTextViolation(hint.text);
    if (violation) {
      throw gateError(source, `${where}: ${violation} — hints must be anonymous counts-only sentences`);
    }
    for (const axis of ["taskClass", "adapterClass"] as const) {
      if (hint[axis] === undefined) continue;
      if (typeof hint[axis] !== "string" || !(hint[axis] as string).trim()) {
        throw gateError(source, `${where}.${axis} must be a non-empty string when present`);
      }
      if (hintTextViolation(hint[axis] as string)) {
        throw gateError(source, `${where}.${axis} must be an anonymous class`);
      }
    }
  }
  return doc as unknown as InjectedKnowledgeSnapshot;
}

/** Load and validate a snapshot from disk; any failure is a loud throw (startup preflight). */
export function loadInjectedKnowledgeFile(path: string): InjectedKnowledgeSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot load injected-knowledge file '${path}': ${(err as Error).message}`);
  }
  return validateInjectedKnowledgeSnapshot(parsed, path);
}

/**
 * Deterministically select the hints for a task: hints whose taskClass matches
 * the task intent plus classless hints, in snapshot order, capped at
 * MAX_INJECTED_HINTS. Returns undefined when nothing applies (no empty blocks
 * on payloads).
 */
export function selectInjectedKnowledge(
  snapshot: InjectedKnowledgeSnapshot,
  taskIntent: string,
): InjectedKnowledgeContext | undefined {
  const hints = snapshot.hints
    .filter((hint) => hint.taskClass === undefined || hint.taskClass === taskIntent)
    .slice(0, MAX_INJECTED_HINTS)
    .map((hint) => hint.text);
  if (hints.length === 0) {
    return undefined;
  }
  return { source: snapshot.source, asOf: snapshot.asOf, hints };
}

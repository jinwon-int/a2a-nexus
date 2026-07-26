// Declarative broker policy engine (#1355 G1). One document, operator-committed,
// declares what worker CLASSES may do — "agent capabilities are determined by
// the broker, not agent goodwill." The broker evaluates it at task create-time
// and claim-time; `warn` mode logs structurally, `enforce` mode denies.
//
// Contract: contracts/a2a/broker-policy.md
//
// Match axis is the ANONYMOUS worker class only ("mobile" | "vps" |
// "source-only" | "unclassified" | "*"). Any other value — in particular a
// concrete worker name — is rejected fail-closed by the validator, so the
// committed policy document can never leak fleet identity.
import { readFileSync } from "node:fs";

export const BROKER_POLICY_SCHEMA = "a2a.broker.policy.v1";
export const BROKER_POLICY_MODES = ["warn", "enforce"] as const;
export const BROKER_POLICY_DEFAULT_ACTIONS = ["allow", "deny"] as const;
/** The closed anonymous worker-class axis (mirrors the /stats/tasks classes). */
export const BROKER_POLICY_WORKER_CLASSES = ["mobile", "vps", "source-only", "unclassified"] as const;

export type BrokerPolicyMode = (typeof BROKER_POLICY_MODES)[number];

export interface BrokerPolicyRule {
  /** Unique rule id (lower-kebab), surfaced in audit events and deny errors. */
  id: string;
  /** Anonymous worker class this rule applies to, or "*" for every class. */
  workerClass: string;
  /** When present, an intent NOT in this list is denied for the class. */
  allowIntents?: string[];
  /** When present, a task whose payload.mode is in this list is denied. */
  denyModes?: string[];
  /** Route matching tasks to the existing blocked -> operator-approval state. */
  requireApproval?: boolean;
  /** Max tasks created per UTC day for this class; exceeding is denied. */
  maxTasksPerDay?: number;
  /**
   * Deny implementation-lane intents unless the claiming worker publishes a
   * verified implementation capability (#1597). Readiness itself is computed by
   * the broker and supplied as `implementationReady`; this package stays free of
   * worker/runtime types and never sees a worker identity.
   */
  requireImplementationCapability?: boolean;
}

export interface BrokerPolicyDocument {
  schemaVersion: typeof BROKER_POLICY_SCHEMA;
  mode: BrokerPolicyMode;
  /** Applied when no rule matches the task's worker class. v1 ships "allow". */
  defaultAction: (typeof BROKER_POLICY_DEFAULT_ACTIONS)[number];
  rules: BrokerPolicyRule[];
}

export type BrokerPolicyDecision =
  | { action: "allow"; ruleId?: string }
  | { action: "deny"; ruleId: string; reason: string }
  | { action: "require_approval"; ruleId: string; reason: string };

export interface BrokerPolicyEvaluationInput {
  intent: string;
  /** The task's payload.mode, when declared. */
  mode?: string;
  /** Anonymous worker class of the task's target/claiming worker. */
  workerClass: string;
  /**
   * Lazy counter for the class's tasks created in the current UTC day. Only
   * invoked when the matched rule declares maxTasksPerDay, so the O(tasks)
   * scan is not paid on the common path.
   */
  countTasksToday?: () => number;
  /**
   * True when the intent belongs to the implementation lane (propose_patch,
   * propose_params, apply_local_change). Supplied by the broker so the closed
   * intent enum stays in the broker package.
   */
  isImplementationIntent?: boolean;
  /**
   * Whether the claiming worker satisfies the implementation readiness rule.
   * Only consulted when the matched rule sets requireImplementationCapability.
   * Undefined means "not evaluated", which fails closed.
   */
  implementationReady?: boolean;
  /**
   * Secret-safe reason text explaining why readiness failed, surfaced in the
   * deny reason. Capability ids are normalized lowercase identifiers and carry
   * no worker name, hostname, or credential material.
   */
  implementationBlockers?: string;
}

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RULE_FIELDS = new Set([
  "id",
  "workerClass",
  "allowIntents",
  "denyModes",
  "requireApproval",
  "maxTasksPerDay",
  "requireImplementationCapability",
]);
const DOCUMENT_FIELDS = new Set(["schemaVersion", "mode", "defaultAction", "rules"]);

function policyError(source: string, message: string): Error {
  return new Error(`invalid broker policy document (${source}): ${message}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

/**
 * Fail-closed structural validation. Unknown fields anywhere are an error (a
 * typo like `denyIntents` must never silently no-op a safety rule), rule ids
 * must be unique, and `workerClass` must come from the closed anonymous class
 * enum (or "*") — which structurally rejects worker-name matching.
 */
export function validateBrokerPolicyDocument(value: unknown, source = "inline"): BrokerPolicyDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw policyError(source, "document must be a JSON object");
  }
  const doc = value as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!DOCUMENT_FIELDS.has(key)) {
      throw policyError(source, `unknown field '${key}' (fail-closed)`);
    }
  }
  if (doc.schemaVersion !== BROKER_POLICY_SCHEMA) {
    throw policyError(source, `schemaVersion must be '${BROKER_POLICY_SCHEMA}'`);
  }
  if (!BROKER_POLICY_MODES.includes(doc.mode as BrokerPolicyMode)) {
    throw policyError(source, `mode must be one of ${BROKER_POLICY_MODES.join(" | ")}`);
  }
  if (!BROKER_POLICY_DEFAULT_ACTIONS.includes(doc.defaultAction as "allow" | "deny")) {
    throw policyError(source, `defaultAction must be one of ${BROKER_POLICY_DEFAULT_ACTIONS.join(" | ")}`);
  }
  if (!Array.isArray(doc.rules)) {
    throw policyError(source, "rules must be an array");
  }
  const seenIds = new Set<string>();
  for (const [index, raw] of (doc.rules as unknown[]).entries()) {
    const where = `rules[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw policyError(source, `${where} must be an object`);
    }
    const rule = raw as Record<string, unknown>;
    for (const key of Object.keys(rule)) {
      if (!RULE_FIELDS.has(key)) {
        throw policyError(source, `${where} has unknown field '${key}' (fail-closed)`);
      }
    }
    if (typeof rule.id !== "string" || !RULE_ID_PATTERN.test(rule.id)) {
      throw policyError(source, `${where}.id must match ${RULE_ID_PATTERN}`);
    }
    if (seenIds.has(rule.id)) {
      throw policyError(source, `duplicate rule id '${rule.id}'`);
    }
    seenIds.add(rule.id);
    const classOk = rule.workerClass === "*" ||
      (BROKER_POLICY_WORKER_CLASSES as readonly string[]).includes(rule.workerClass as string);
    if (!classOk) {
      throw policyError(
        source,
        `${where}.workerClass '${String(rule.workerClass)}' is not an anonymous worker class ` +
          `(${BROKER_POLICY_WORKER_CLASSES.join(" | ")} | *) — worker names are rejected`,
      );
    }
    if (rule.allowIntents !== undefined && !isStringArray(rule.allowIntents)) {
      throw policyError(source, `${where}.allowIntents must be an array of non-empty strings`);
    }
    if (rule.denyModes !== undefined && !isStringArray(rule.denyModes)) {
      throw policyError(source, `${where}.denyModes must be an array of non-empty strings`);
    }
    if (rule.requireApproval !== undefined && typeof rule.requireApproval !== "boolean") {
      throw policyError(source, `${where}.requireApproval must be a boolean`);
    }
    if (rule.maxTasksPerDay !== undefined &&
        (!Number.isInteger(rule.maxTasksPerDay) || (rule.maxTasksPerDay as number) < 1)) {
      throw policyError(source, `${where}.maxTasksPerDay must be a positive integer`);
    }
    if (rule.requireImplementationCapability !== undefined &&
        typeof rule.requireImplementationCapability !== "boolean") {
      throw policyError(source, `${where}.requireImplementationCapability must be a boolean`);
    }
  }
  return doc as unknown as BrokerPolicyDocument;
}

/** Load and validate a policy document from disk; any failure is a loud throw. */
export function loadBrokerPolicyFile(path: string): BrokerPolicyDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot load broker policy file '${path}': ${(err as Error).message}`);
  }
  return validateBrokerPolicyDocument(parsed, path);
}

/**
 * Derive the anonymous worker class for a task. Single source of truth shared
 * with the /stats/tasks read path so budgets and stats count the same classes.
 */
export function deriveTaskWorkerClass(input: {
  sourceOnly?: boolean;
  payloadMode?: string;
  workerFound: boolean;
  workerMode?: string;
}): string {
  if (input.sourceOnly === true || input.payloadMode === "source-only") return "source-only";
  if (!input.workerFound) return "unclassified";
  return input.workerMode === "mobile" ? "mobile" : "vps";
}

/**
 * Evaluate a task against the policy document. Pure decision — the caller
 * owns mode semantics (warn logs, enforce denies) and audit emission.
 *
 * Matching is FIRST-MATCH-WINS on workerClass (exact class before "*" only by
 * document order — order rules deliberately). Within the matched rule, checks
 * run deny-first: denyModes, then allowIntents, then
 * requireImplementationCapability, then maxTasksPerDay, then requireApproval.
 * No matched rule falls through to defaultAction.
 */
export function evaluateTaskPolicy(
  input: BrokerPolicyEvaluationInput,
  doc: BrokerPolicyDocument,
): BrokerPolicyDecision {
  const rule = doc.rules.find((r) => r.workerClass === "*" || r.workerClass === input.workerClass);
  if (!rule) {
    return doc.defaultAction === "deny"
      ? { action: "deny", ruleId: "default", reason: `no rule matches worker class '${input.workerClass}' and defaultAction is deny` }
      : { action: "allow" };
  }
  if (rule.denyModes && input.mode !== undefined && rule.denyModes.includes(input.mode)) {
    return { action: "deny", ruleId: rule.id, reason: `mode '${input.mode}' is denied for worker class '${input.workerClass}'` };
  }
  if (rule.allowIntents && !rule.allowIntents.includes(input.intent)) {
    return { action: "deny", ruleId: rule.id, reason: `intent '${input.intent}' is not allowed for worker class '${input.workerClass}'` };
  }
  if (rule.requireImplementationCapability === true && input.isImplementationIntent === true &&
      input.implementationReady !== true) {
    const detail = input.implementationBlockers?.trim();
    return {
      action: "deny",
      ruleId: rule.id,
      reason: `intent '${input.intent}' requires a verified implementation capability for worker class ` +
        `'${input.workerClass}'${detail ? `: ${detail}` : " (readiness was not evaluated)"}`,
    };
  }
  if (rule.maxTasksPerDay !== undefined) {
    const used = input.countTasksToday ? input.countTasksToday() : 0;
    if (used >= rule.maxTasksPerDay) {
      return {
        action: "deny",
        ruleId: rule.id,
        reason: `daily task budget exhausted for worker class '${input.workerClass}' (${used}/${rule.maxTasksPerDay})`,
      };
    }
  }
  if (rule.requireApproval === true) {
    return { action: "require_approval", ruleId: rule.id, reason: `worker class '${input.workerClass}' requires operator approval` };
  }
  return { action: "allow", ruleId: rule.id };
}
